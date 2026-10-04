"""HB-017: which absolute paths a builtin tool error may show the model.

Contract (security boundary): the error text keeps (1) a path that appears
verbatim in the call's own arguments and (2) an absolute path inside the call's
bound workspace root; every other absolute path is still ``<path>``. Truncation
stays. Logs keep full redaction (see tests/sidecar/ai/routing/test_tool_error_log_redaction.py).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.mcp import builtin_server, transport_stdio
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.error_paths import error_path_keeper, redact_error_paths
from sidecar.ai.tools.workspace import WorkspaceGuard


def _failing_tool(name: str, message: str) -> builtin_server.BuiltinTool:
    def fail(_arguments, _workspace):
        raise ToolExecutionFailure(code="CMP-TEST-0017", message=message, retryable=False)

    return builtin_server.BuiltinTool(
        name=name,
        description="test",
        side_effecting=False,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        handler=fail,
    )


def _call(tool: builtin_server.BuiltinTool, workspace_root: Path, arguments: dict) -> str:
    response = builtin_server._handle_tools_call(
        f"msg-{tool.name}",
        {tool.name: tool},
        WorkspaceGuard(str(workspace_root)),
        {"name": tool.name, "arguments": arguments},
    )
    return str(response["error"]["message"])


def test_error_keeps_argument_and_workspace_paths_but_redacts_others(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    (workspace_root / "data").mkdir(parents=True)
    in_workspace = workspace_root / "data" / "ledger.csv"
    outside = tmp_path / "elsewhere" / "target.csv"
    argument_path = str(tmp_path / "does" / "not" / "exist")
    message = (
        f"path does not exist: {argument_path}; resolved {in_workspace} "
        f"through a link to {outside}"
    )

    text = _call(
        _failing_tool("hb017_mixed_paths", message),
        workspace_root,
        {"path": argument_path},
    )

    assert argument_path in text
    assert str(in_workspace) in text
    assert str(outside) not in text
    assert "elsewhere" not in text
    assert text.endswith("through a link to <path>")


def test_read_file_on_a_directory_names_the_real_path(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    folder = workspace_root / "statements"
    folder.mkdir(parents=True)

    response = builtin_server._handle_tools_call(
        "msg-read-dir",
        builtin_server._default_tools(),
        WorkspaceGuard(str(workspace_root)),
        {"name": "read_file", "arguments": {"path": str(folder)}},
    )

    message = response["error"]["message"]
    assert f"path is a directory, not a file: {folder}." in message
    assert "<path>" not in message


def test_unexpected_exception_text_keeps_the_same_rule(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    profile_path = tmp_path / "profile" / "secret.json"

    def explode(_arguments, _workspace):
        raise OSError(f"cannot open {workspace_root / 'a.txt'} via {profile_path}")

    tool = builtin_server.BuiltinTool(
        name="hb017_unexpected",
        description="test",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=explode,
    )

    text = _call(tool, workspace_root, {})

    assert str(workspace_root / "a.txt") in text
    assert str(profile_path) not in text
    assert text.endswith("via <path>")


def test_harness_argument_keys_do_not_vouch_for_a_path(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    injected = str(tmp_path / "harness" / "state")

    keep = error_path_keeper(
        arguments={"_jenny_approved_plan": {"root": injected}, "path": "notes.md"},
        workspace_root=workspace_root,
    )

    assert redact_error_paths(f"failed at {injected}", keep=keep) == "failed at <path>"


def test_dotdot_escape_from_the_workspace_is_redacted(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    escaped = f"{workspace_root}{os.sep}..{os.sep}secret.txt"

    keep = error_path_keeper(arguments={}, workspace_root=workspace_root)

    assert redact_error_paths(f"denied {escaped}", keep=keep) == "denied <path>"


@pytest.mark.parametrize(
    ("argument", "message", "expected"),
    [
        (
            r"Z:/does/not/exist",
            r"path does not exist: Z:\does\not\exist",
            r"path does not exist: Z:\does\not\exist",
        ),
        (
            r"z:\Does\Not\Exist",
            r"path does not exist: Z:\does\not\exist",
            r"path does not exist: Z:\does\not\exist",
        ),
        (
            r"Z:\does\not\exist",
            r"path does not exist: Z:\does\not\exist. Check the exact path.",
            r"path does not exist: Z:\does\not\exist. Check the exact path.",
        ),
        (
            r"Z:\other",
            r"path does not exist: Z:\does\not\exist. Check the exact path.",
            "path does not exist: <path>. Check the exact path.",
        ),
        (
            "/srv/data/in.csv",
            "cannot read /srv/Data/in.csv",
            "cannot read <path>",
        ),
    ],
)
def test_argument_match_folds_windows_case_and_separators_only(
    argument: str, message: str, expected: str
) -> None:
    keep = error_path_keeper(arguments={"cwd": argument}, workspace_root=None)

    assert redact_error_paths(message, keep=keep) == expected


def test_windows_workspace_containment_is_case_insensitive() -> None:
    keep = error_path_keeper(arguments={}, workspace_root=r"G:\Work\Recon")

    assert (
        redact_error_paths(r"missing g:\work\recon\out\report.md and G:\Work\Other\x.md", keep=keep)
        == r"missing g:\work\recon\out\report.md and <path>"
    )


def test_kept_quoted_path_with_spaces_is_not_partially_redacted() -> None:
    keep = error_path_keeper(arguments={}, workspace_root=r"G:\my ws")

    assert (
        redact_error_paths(r"failed to open 'G:\my ws\a b.txt'", keep=keep)
        == r"failed to open 'G:\my ws\a b.txt'"
    )


def test_error_truncation_still_applies_to_kept_text(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    message = f"failed to read {workspace_root / 'big.txt'}: {'x' * 2000}"

    text = _call(_failing_tool("hb017_truncation", message), workspace_root, {})

    assert text.endswith("...[truncated]")
    assert len(text) < len(message)


def test_stdio_transport_log_redacts_the_kept_path(caplog) -> None:
    kept = r"Z:\does\not\exist"
    response = {
        "error": {
            "code": -32000,
            "message": f"path does not exist: {kept}. Check the exact path.",
            "data": {"code": "CMP-TOOL-0003"},
        }
    }
    caplog.set_level(logging.WARNING, logger=transport_stdio.__name__)

    with pytest.raises(MCPError) as caught:
        transport_stdio.StdioMCPTransport._raise_for_error(
            SimpleNamespace(server_name="builtin"), response
        )

    assert kept in caught.value.message
    logged = " ".join(record.getMessage() for record in caplog.records)
    assert "mcp call failed on server=builtin" in logged
    assert kept not in logged
    assert "path does not exist: <path>. Check the exact path." in logged


# Astra B3 review: UNC paths matched neither the keeper nor the log redaction,
# and a bare path cut at a space let an in-workspace prefix vouch for a tail
# that climbs out of the workspace.
@pytest.mark.parametrize(
    "path_text",
    [r"\\server\share\secret.txt", r"\\?\UNC\server\share\secret.txt", r"\\?\C:\Users\x\secret.txt"],
)
def test_unc_and_extended_paths_are_redacted_with_and_without_a_keeper(path_text: str) -> None:
    message = f"failed: {path_text} is locked"
    keeper = error_path_keeper(arguments={}, workspace_root=r"D:\Work\bank_recon")
    for keep in (keeper, None):
        redacted = redact_error_paths(message, keep=keep)
        assert "secret.txt" not in redacted
        assert "<path>" in redacted


def test_a_bare_path_cut_at_a_space_never_vouches_for_its_tail() -> None:
    keeper = error_path_keeper(arguments={}, workspace_root=r"D:\Work\bank_recon")
    message = r"cannot open D:\Work\bank_recon\safe dir\..\..\private.txt now"
    redacted = redact_error_paths(message, keep=keeper)
    assert r"D:\Work\bank_recon\safe" not in redacted
    # An in-workspace path without a continuation is still kept.
    plain = r"cannot open D:\Work\bank_recon\data\ledger.csv now"
    assert redact_error_paths(plain, keep=keeper) == plain
