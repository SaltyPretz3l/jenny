"""Tests never reach a real Ollama daemon (dogfood HB-033).

The autouse guard in ``tests/conftest.py`` refuses loopback connections to the
Ollama port, so a suite run beside a live Jenny app cannot load a model into
that app's daemon.
"""

from __future__ import annotations

import errno
import socket
import urllib.error
import urllib.request

import pytest

from tests.conftest import LiveOllamaAccessError, install_live_ollama_guard


@pytest.fixture
def default_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pin the default mode so these hold under JENNY_LIVE_OLLAMA=strict or =1.
    install_live_ollama_guard(monkeypatch, "")


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
def test_loopback_ollama_port_is_refused_without_touching_the_network(
    host: str, default_guard: None
) -> None:
    with pytest.raises(OSError) as excinfo:
        socket.create_connection((host, 11434), timeout=0.2)
    assert excinfo.value.errno == errno.ECONNREFUSED

    with pytest.raises(urllib.error.URLError):
        urllib.request.urlopen(f"http://{host}:11434/api/tags", timeout=0.2)


def test_connect_ex_reports_refused(default_guard: None) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        assert sock.connect_ex(("127.0.0.1", 11434)) == errno.ECONNREFUSED


def test_other_loopback_ports_are_untouched() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        with socket.create_connection(server.getsockname(), timeout=2):
            pass


def test_strict_mode_fails_the_test_that_tried(monkeypatch: pytest.MonkeyPatch) -> None:
    install_live_ollama_guard(monkeypatch, "strict")
    with pytest.raises(LiveOllamaAccessError):
        socket.create_connection(("127.0.0.1", 11434), timeout=0.2)


def test_guard_outlives_the_test_that_started_a_thread() -> None:
    # The session fixture, not a per-test patch, owns the guard: an engine
    # warm-up thread still running after its test ended must stay blocked.
    from tests import conftest

    session_fixture = conftest._no_live_ollama
    marker = getattr(session_fixture, "_fixture_function_marker", None) or getattr(
        session_fixture, "_pytestfixturefunction", None
    )
    assert marker is not None and marker.scope == "session" and marker.autouse is True
