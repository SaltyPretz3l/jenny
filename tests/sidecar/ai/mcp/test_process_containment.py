from __future__ import annotations

import signal
from types import SimpleNamespace

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp import process_containment as module
from sidecar.ai.mcp.process_containment import MCPProcessContainment


@pytest.mark.parametrize("exited", [False, True])
def test_group_cleanup_escalates_after_parent_exit(monkeypatch: pytest.MonkeyPatch, exited: bool) -> None:
    containment = MCPProcessContainment(MCPServerConfig(name="test", transport="stdio", command="python"))
    process = SimpleNamespace(pid=12345, poll=lambda: 0 if exited else None, wait=lambda **kwargs: 0)
    monkeypatch.setattr(signal, "SIGKILL", 9, raising=False)
    signals = []
    alive = True
    def killpg(pid: int, sig: int) -> None:
        nonlocal alive
        assert pid == process.pid
        if sig == 0:
            if not alive:
                raise ProcessLookupError()
            return
        signals.append(sig)
        if sig == getattr(signal, "SIGKILL", signal.SIGTERM):
            alive = False
    monkeypatch.setattr(module, "_is_posix", lambda: True)
    monkeypatch.setattr(module, "_is_windows", lambda: False)
    monkeypatch.setattr(module.os, "killpg", killpg, raising=False)
    monkeypatch.setattr(module, "_PROCESS_EXIT_TIMEOUT_SECONDS", 0.01)
    containment.after_spawn(process)
    containment.terminate(process)
    assert signals == [signal.SIGTERM, getattr(signal, "SIGKILL", signal.SIGTERM)]
