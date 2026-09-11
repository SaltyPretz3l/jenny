from __future__ import annotations

import ctypes
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.config import MCPServerConfig, RuntimeConfig
from sidecar.ai.config_parsing import _parse_mcp_servers
from sidecar.ai.container_mcp_servers import _default_mcp_servers
from sidecar.ai.mcp import process_containment
from sidecar.ai.tools.builtins.python_runtime import job_object


@pytest.mark.parametrize("host_mode,policy,expected", [
    ("desktop", None, None), ("server", None, 512), ("server", 1, 512),
    ("desktop", 1, 512), ("desktop", 999, 512),
])
def test_only_native_desktop_omits_inherited_memory_limit(tmp_path: Path, host_mode, policy, expected):
    config = RuntimeConfig(host_mode=host_mode, desktop_execution_policy_version=policy)
    builtin = _default_mcp_servers(config, tmp_path)[0]
    assert builtin.memory_limit_mb == expected
    assert builtin.max_processes == 16
    assert builtin.cooperative_cancel is True


@pytest.mark.parametrize("requested", [None, 0, -1, "none"])
def test_external_mcp_cannot_disable_memory_limit(requested):
    servers = _parse_mcp_servers([{"name": "external", "transport": "stdio", "command": "python",
                                   "memory_limit_mb": requested}], sse_enabled=False)
    assert servers[0].memory_limit_mb is not None
    assert servers[0].memory_limit_mb >= 64
    assert MCPServerConfig(name="external", transport="stdio").memory_limit_mb == 512


@pytest.mark.parametrize("memory_limit_mb", [None, 512])
def test_posix_retains_other_limits_without_lowering_native_address_space(monkeypatch, memory_limit_mb):
    calls = []
    resource = SimpleNamespace(RLIMIT_AS=1, RLIMIT_NOFILE=2, RLIMIT_CORE=3)
    monkeypatch.setattr(process_containment, "_resource", resource)
    monkeypatch.setattr(process_containment, "_set_resource_limit",
                        lambda _resource, key, value: calls.append((key, value)))
    monkeypatch.setattr(process_containment.os, "setsid", lambda: None, raising=False)
    process_containment._posix_preexec_fn(memory_limit_mb=memory_limit_mb, max_open_files=256)()
    assert (2, 256) in calls
    assert (3, 0) in calls
    assert ((1, 512 * 1024 * 1024) in calls) is (memory_limit_mb is not None)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows job accounting")
@pytest.mark.parametrize("memory_limit_mb", [None, 128])
def test_real_windows_job_preserves_process_limit_and_kill_on_close(memory_limit_mb):
    query = job_object.kernel32.QueryInformationJobObject
    query.argtypes = (ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p)
    query.restype = ctypes.c_int
    with job_object.JobObject(memory_limit_mb=memory_limit_mb, max_processes=16) as job:
        info = job_object.JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        assert query(job._handle, 9, ctypes.byref(info), ctypes.sizeof(info), None)
        flags = info.BasicLimitInformation.LimitFlags
        assert flags & job_object.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        assert flags & job_object.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        assert info.BasicLimitInformation.ActiveProcessLimit == 16
        expected_memory = (memory_limit_mb or 0) * 1024 * 1024
        assert info.JobMemoryLimit == info.ProcessMemoryLimit == expected_memory
        assert bool(flags & job_object.JOB_OBJECT_LIMIT_JOB_MEMORY) is (memory_limit_mb is not None)
        assert bool(flags & job_object.JOB_OBJECT_LIMIT_PROCESS_MEMORY) is (memory_limit_mb is not None)
