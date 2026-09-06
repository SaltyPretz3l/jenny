from __future__ import annotations

import os
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


@pytest.fixture
def vcr_generate_fn_factory():
    def _factory(fixture_name: str):
        engine = VCREngine(Path("tests/fixtures/vcr") / fixture_name)

        def generate_fn(messages: list[dict[str, str]]) -> str:
            return engine.generate(prompt="", messages=messages)

        return generate_fn

    return _factory
