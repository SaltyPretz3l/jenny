from __future__ import annotations

import errno
import os
import socket
from pathlib import Path

import pytest

from tests.sidecar.ai.context.vcr_adapter import VCREngine

_LEGACY_SERVER_TEST_ENTRYPOINT = Path(__file__).parent / "sidecar" / "test_server.py"


def _path_was_explicitly_requested(collection_path: Path, config: pytest.Config) -> bool:
    invocation_dir = Path(config.invocation_params.dir)
    for raw_argument in config.invocation_params.args:
        argument = str(raw_argument).split("::", maxsplit=1)[0]
        if not argument or argument.startswith("-"):
            continue
        requested_path = Path(argument)
        if not requested_path.is_absolute():
            requested_path = invocation_dir / requested_path
        if requested_path.resolve() == collection_path.resolve():
            return True
    return False


def pytest_ignore_collect(collection_path: Path, config: pytest.Config) -> bool | None:
    if collection_path.resolve() != _LEGACY_SERVER_TEST_ENTRYPOINT.resolve():
        return None
    if _path_was_explicitly_requested(collection_path, config):
        return None
    return True


@pytest.fixture
def jenny_test_mode() -> str:
    return str(os.environ.get("JENNY_TEST_MODE", "")).strip().lower()


@pytest.fixture(autouse=True)
def _hermetic_operation_ledger_root(tmp_path_factory, monkeypatch):
    # The builtin MCP server subprocess resolves its durable operation-ledger
    # root at startup; without this override every test that drives a real
    # server writes receipts into the user's ~/.companion/operation-ledger and
    # scripted turns with fixed ids then REPLAY recorded outcomes across test
    # runs (10 test_server_tools failures, 2026-08-28). Per-test roots keep
    # receipts from leaking between tests and into the real machine state.
    root = tmp_path_factory.mktemp("operation-ledger")
    monkeypatch.setenv("JENNY_OPERATION_LEDGER_ROOT", str(root))


_OLLAMA_PORT = 11434
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


class LiveOllamaAccessError(AssertionError):
    """A test tried to reach a real Ollama daemon (JENNY_LIVE_OLLAMA=strict)."""


def _targets_local_ollama(address: object) -> bool:
    # (host, port) for IPv4, (host, port, flowinfo, scope_id) for IPv6.
    if not isinstance(address, tuple):
        return False
    host, port = (*address, None, None)[:2]
    return port == _OLLAMA_PORT and str(host).lower() in _LOOPBACK_HOSTS


def install_live_ollama_guard(monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    # Dogfood HB-033: `pytest tests/sidecar` on a machine where a Jenny app owned
    # 127.0.0.1:11434 sent real /api/generate calls to that daemon and loaded a
    # 4.7 GB model beside the app's chat model. Tests never reach a live Ollama:
    # the default refuses the connection (what a machine without Ollama sees),
    # JENNY_LIVE_OLLAMA=strict fails the test that tried instead, and
    # JENNY_LIVE_OLLAMA=1 lifts the guard for a deliberate live run.
    if mode in {"1", "true"}:
        return
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex

    def _refuse(address: object) -> None:
        if mode == "strict":
            raise LiveOllamaAccessError(f"test tried to reach a live Ollama at {address!r}")

    def connect(self, address, *args):
        if _targets_local_ollama(address):
            _refuse(address)
            raise ConnectionRefusedError(errno.ECONNREFUSED, "live Ollama is blocked in tests")
        return real_connect(self, address, *args)

    def connect_ex(self, address, *args):
        if _targets_local_ollama(address):
            _refuse(address)
            return errno.ECONNREFUSED
        return real_connect_ex(self, address, *args)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)


@pytest.fixture(scope="session", autouse=True)
def _no_live_ollama():
    # Session-wide, not per test: an engine warm-up thread outlives the test
    # that started it, and a per-test patch is already undone when it connects.
    with pytest.MonkeyPatch.context() as session_patch:
        install_live_ollama_guard(
            session_patch, os.environ.get("JENNY_LIVE_OLLAMA", "").strip().lower()
        )
        yield


@pytest.fixture
def vcr_generate_fn_factory():
    def _factory(fixture_name: str):
        engine = VCREngine(Path("tests/fixtures/vcr") / fixture_name)

        def generate_fn(messages: list[dict[str, str]]) -> str:
            return engine.generate(prompt="", messages=messages)

        return generate_fn

    return _factory
