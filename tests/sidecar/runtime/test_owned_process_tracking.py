"""Actual launch/settlement hooks and nested builtin configuration."""
from __future__ import annotations

import os
import sys

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.container_mcp_servers import _default_mcp_servers
from sidecar.ai.tools.builtins.owned_process import OwnedProcessService
from sidecar.runtime import owned_process_tracking as tracking


def test_owned_launch_records_once_and_settles_with_real_proof(monkeypatch, tmp_path):
    recorded, settled = [], []
    ticket = object()
    def record(pid, kind):
        recorded.append((pid, kind))
        return ticket
    monkeypatch.setattr(tracking, "record", record)
    monkeypatch.setattr(tracking, "settle", lambda value, *, confirmed: settled.append((value, confirmed)))
    service = OwnedProcessService()
    child = service.spawn([sys.executable, "-c", "print('owned')"], cwd=tmp_path,
                          process_kind="background_job")
    result = service.wait(child, timeout_seconds=10)
    assert result.stdout.strip() == "owned"
    assert recorded == [(child.process.pid, "background_job")]
    assert settled == [(ticket, True)]


def test_profile_path_and_sidecar_owner_forwarded_to_builtin(tmp_path):
    path = str(tmp_path / "owned.json")
    config = RuntimeConfig(owned_process_ledger_path=path)
    args = _default_mcp_servers(config, tmp_path)[0].args
    assert args[args.index("--owned-process-ledger-path") + 1] == path
    assert args[args.index("--owned-process-owner-pid") + 1] == str(os.getpid())


def test_windows_configuration_is_inert(monkeypatch, tmp_path):
    monkeypatch.setattr(tracking.os, "name", "nt")
    tracking.configure(str(tmp_path / "owned.json"))
    assert tracking.record(os.getpid()) is None
    assert not (tmp_path / "owned.json").exists()
