"""A hosted worker whose file backend refuses still starts, without its workspace tools.

Runs on every OS: the Windows branch is reached by setting the facade's platform,
and the library is injected as missing. Slice 3b-4b's degrade path.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.builtin_request_scope import TRUSTED_EXECUTION_CONTEXT_KEY
from sidecar.ai.mcp.client_support import descriptor_from_payload
from sidecar.ai.routing import tool_resolution
from sidecar.ai.tools import hosted_file_io
from sidecar.ai.tools import hosted_file_io_win32_library as library
from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME
from sidecar.ai.tools.workspace import WorkspaceGuard

_MANIFEST = Path(__file__).resolve().parents[2] / "services" / "tools" / "tool-manifest.json"
_HOST = {"host_mode": "server", "host_execution_policy_version": 1}
# A fixed floor beside the manifest: unflagging one of these must fail a test.
_FILE_TOOLS = frozenset({"read_file", "write_file", "edit_file", "list_dir", "glob_files",
                         "grep_search"})


def _workspace_required() -> frozenset[str]:
    tools = json.loads(_MANIFEST.read_text(encoding="utf-8"))["tools"]
    return frozenset(
        entry["name"] for entry in tools
        if entry.get("availability", {}).get("workspace_required") is True
    )


@pytest.fixture(autouse=True)
def _clean_process_state():
    hosted_file_io.configure_hosted_file_io(None, enabled=False)
    hosted_file_io.set_hosted_win32_files(False)
    library.reset_shared_library()
    yield
    hosted_file_io.configure_hosted_file_io(None, enabled=False)
    hosted_file_io.set_hosted_win32_files(False)
    library.reset_shared_library()


def _run_main(monkeypatch, root: Path, *extra: str, policy: int = 1) -> dict[str, Any]:
    """`main()` against an empty stdin; returns what it registered and what it passed."""
    seen: dict[str, Any] = {}
    real_default_tools = builtin_server._default_tools

    def recording_default_tools(config=None, **kwargs):
        tools = real_default_tools(config, **kwargs)
        seen.update(kwargs, tools=tools, config=config)
        return tools

    events: list[str] = []
    real_configure_logging = builtin_server._configure_logging

    def recording_configure_logging(**kwargs):
        events.append("logging configured")
        return real_configure_logging(**kwargs)

    class Recorder(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            events.append(record.getMessage())

    monkeypatch.setattr(builtin_server, "_default_tools", recording_default_tools)
    monkeypatch.setattr(builtin_server, "_configure_logging", recording_configure_logging)
    monkeypatch.setattr(
        builtin_server.sys, "stdin",
        type("EmptyStdin", (), {"readline": staticmethod(lambda: "")})(),
    )
    recorder = Recorder(logging.DEBUG)
    hosted_logger = logging.getLogger("sidecar.ai.mcp.builtin_server_hosted")
    hosted_logger.addHandler(recorder)
    try:
        builtin_server.main([
            "--workspace-root", str(root), "--host-mode", "server",
            "--host-execution-policy-version", str(policy), *extra,
        ])
    finally:
        hosted_logger.removeHandler(recorder)
    seen["events"] = events
    return seen


def _reason_logged(seen: dict[str, Any], reason: str, root: Path) -> None:
    """Logged once, after the worker's logging is configured, with no path in it."""
    events = seen["events"]
    line = f"hosted_file.unavailable reason={reason}"
    assert events.count(line) == 1, events
    assert events.index("logging configured") < events.index(line)
    _assert_no_path("\n".join(events), root)


def _listed(tools: dict[str, Any], policy: int = 1) -> list[dict[str, Any]]:
    host = {**_HOST, "host_execution_policy_version": policy}
    return builtin_server._handle_tools_list(1, tools, host)["result"]["tools"]


def _offered_to_model(listed: list[dict[str, Any]], root: Path) -> set[str]:
    """The model's tool list, built by the real catalog and assembly from the worker's list."""
    kernel = SimpleNamespace(
        _config=RuntimeConfig(mode="assist", host_mode="server", host_execution_policy_version=1,
                              tools_workspace_root=str(root)),
        _mcp_client=SimpleNamespace(available_tools=[
            descriptor_from_payload(BUILTIN_MCP_SERVER_NAME, payload) for payload in listed
        ]),
        _engine=SimpleNamespace(supports_tool_calling=True, supports_inband_tool_calling=False),
    )
    schemas = tool_resolution.build_tool_payload(kernel, None)
    return {str((schema.get("function") or schema).get("name")) for schema in schemas}


def _working_set(policy: int = 1) -> set[str]:
    host = {**_HOST, "host_execution_policy_version": policy}
    tools = builtin_server._default_tools(
        dict(host), workspace_root_present=True, request_scoped_authority=True)
    return {entry["name"] for entry in _listed(tools, policy)}


def _assert_no_path(text: str, root: Path) -> None:
    for secret in (str(root), root.name, str(root).replace("\\", "/")):
        assert secret not in text


@pytest.mark.parametrize("policy", [1, 2])
def test_switch_off_on_win32_starts_without_workspace_tools_and_never_looks_for_the_library(
    monkeypatch, tmp_path: Path, policy: int,
) -> None:
    looked: list[str] = []
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "win32")
    monkeypatch.setattr(library, "library_path", lambda: looked.append("path") or tmp_path)
    monkeypatch.setattr(library, "load_library", lambda **_: looked.append("load"))
    root = tmp_path.resolve()

    seen = _run_main(monkeypatch, root, policy=policy)

    assert looked == []
    assert hosted_file_io.hosted_file_io_unavailable_reason(str(root)) == "file_access_switch_off"
    assert seen["workspace_root_present"] is False
    listed = {entry["name"] for entry in _listed(seen["tools"], policy)}
    working = _working_set(policy)
    assert working, "the working worker registers file tools, so the degrade has something to remove"
    assert listed == working - _workspace_required()
    assert not listed & (_workspace_required() | _FILE_TOOLS)
    assert _FILE_TOOLS <= working
    assert hosted_file_io.hosted_file_io_enabled() is True, "server mode never falls back to open"
    assert hosted_file_io.hosted_file_io_root() is None
    _reason_logged(seen, "file_access_switch_off", root)


def test_switch_on_and_no_library_reports_the_component_and_registers_no_file_tool(
    monkeypatch, tmp_path: Path,
) -> None:
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "win32")
    monkeypatch.setattr(library, "library_path", lambda: tmp_path / "absent" / library.LIBRARY_FILE_NAME)
    root = tmp_path.resolve()

    seen = _run_main(monkeypatch, root, "--hosted-win32-files")

    assert hosted_file_io.hosted_win32_files_enabled() is True
    assert hosted_file_io.hosted_file_io_unavailable_reason(str(root)) == (
        "file_access_component_missing")
    assert seen["workspace_root_present"] is False
    assert not {entry["name"] for entry in _listed(seen["tools"])} & _workspace_required()
    _reason_logged(seen, "file_access_component_missing", root)


def test_a_win32_configure_that_fails_after_a_clean_check_degrades_with_its_reason(
    monkeypatch, tmp_path: Path,
) -> None:
    from sidecar.ai.mcp.builtin_server_hosted import start_hosted_file_io

    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "win32")
    answers = iter([None, None])
    monkeypatch.setattr(hosted_file_io, "hosted_file_io_unavailable_reason",
                        lambda root: next(answers))
    monkeypatch.setattr(hosted_file_io, "select_backend", lambda platform: None)

    reason = start_hosted_file_io(tmp_path, server_mode=True, win32_files=True)

    assert reason == "file_access_component_missing"
    assert hosted_file_io.hosted_file_io_enabled() is True
    assert hosted_file_io.hosted_file_io_root() is None


def test_the_model_is_offered_none_of_the_workspace_tools_a_refusing_worker_left_out(
    monkeypatch, tmp_path: Path,
) -> None:
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "win32")
    root = tmp_path.resolve()
    seen = _run_main(monkeypatch, root)

    offered = _offered_to_model(_listed(seen["tools"]), root)
    working = _offered_to_model(_listed(builtin_server._default_tools(
        dict(_HOST), workspace_root_present=True, request_scoped_authority=True)), root)

    assert {"read_file", "write_file", "list_dir"} <= working, "the fixture offers file tools"
    assert not offered & (_workspace_required() | _FILE_TOOLS)


def test_a_platform_without_a_backend_degrades_the_same_way(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "plan9")
    seen = _run_main(monkeypatch, tmp_path.resolve())

    assert hosted_file_io.hosted_file_io_unavailable_reason(str(tmp_path)) == (
        "file_access_platform_unsupported")
    assert seen["workspace_root_present"] is False


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_posix_platforms_answer_no_start_reason(monkeypatch, platform: str, tmp_path: Path) -> None:
    from sidecar.ai.tools import hosted_file_io_posix

    monkeypatch.setattr(hosted_file_io, "_platform", lambda: platform)
    assert hosted_file_io_posix.unavailable_reason(tmp_path, None, None) is None
    assert hosted_file_io.hosted_file_io_unavailable_reason(str(tmp_path)) is None
    monkeypatch.setattr(hosted_file_io, "select_backend", lambda name: None)
    assert hosted_file_io.hosted_file_io_unavailable_reason(str(tmp_path)) == (
        "file_access_platform_unsupported"), "no backend is never an open answer"


def _envelope(root: Path) -> dict[str, object]:
    identity = str(root).lower() if os.name == "nt" else str(root)
    status = root.stat()
    return {
        "schema_version": 1, "authority_revision": "rev", "project_id": "project_alpha",
        "root_path": str(root), "root_id": "root_" + hashlib.sha256(identity.encode()).hexdigest()[:24],
        "root_revision": 1, "device_id": str(status.st_dev), "inode": str(status.st_ino),
        "tool_policy_snapshot": {"version": 1}, "knowledge_roots": [],
    }


def test_a_degraded_worker_runs_a_tool_that_touches_no_file_and_refuses_a_file_read(
    monkeypatch, tmp_path: Path,
) -> None:
    """Through the real tools/call path with a bound project root (item 1 of 3b-4b's review)."""
    monkeypatch.setattr(hosted_file_io, "_platform", lambda: "win32")
    root = (tmp_path / "project-secret-name").resolve()
    root.mkdir()
    (root / "secret-file.txt").write_bytes(b"contents")
    seen = _run_main(monkeypatch, root)
    assert seen["workspace_root_present"] is False

    def touches_no_file(arguments, workspace):
        return "answered"

    def reads_a_file(arguments, workspace):
        with hosted_file_io.open_regular_file(root / "secret-file.txt") as handle:
            return handle.read().decode()

    schema = {"type": "object", "properties": {}}
    tools = {
        "ask_user": builtin_server.BuiltinTool("ask_user", "", False, schema, touches_no_file),
        "read_file": builtin_server.BuiltinTool("read_file", "", False, schema, reads_a_file),
    }

    def call(message_id: int, name: str) -> dict[str, Any]:
        params = {"name": name, "arguments": {TRUSTED_EXECUTION_CONTEXT_KEY: _envelope(root)}}
        return builtin_server._handle_tools_call(message_id, tools, WorkspaceGuard(None), params,
                                                 dict(_HOST))

    answered = call(1, "ask_user")
    refused = call(2, "read_file")

    assert "error" not in answered, answered
    assert answered["result"].get("success") is True, answered
    assert "answered" in json.dumps(answered)
    text = json.dumps(refused)
    assert CMP_TOOL_INVALID_PATH in text, refused
    assert "contents" not in text
    _assert_no_path(text, root)
    _assert_no_path(text, root / "secret-file.txt")


def test_desktop_mode_asks_no_reason(monkeypatch, tmp_path: Path) -> None:
    asked: list[str] = []
    monkeypatch.setattr(hosted_file_io, "hosted_file_io_unavailable_reason", asked.append)
    monkeypatch.setattr(builtin_server.sys, "stdin",
                        type("EmptyStdin", (), {"readline": staticmethod(lambda: "")})())
    builtin_server.main(["--workspace-root", str(tmp_path)])

    assert asked == []
    assert hosted_file_io.hosted_file_io_enabled() is False
