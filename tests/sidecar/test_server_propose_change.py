"""End-to-end Propose mode through chat.send: the builtin MCP hop, injection, read-only gates."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sidecar import server
from sidecar.protocol import API_VERSION


def _initialize(workspace_root: Path) -> None:
    server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 35_1,
            "method": "initialize",
            "params": {
                "accept_version": API_VERSION,
                "config": {"tools_workspace_root": str(workspace_root)},
            },
        },
        initialized=False,
    )


def _send(content: str, **params: Any) -> Any:
    return server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 35_2,
            "method": "chat.send",
            "params": {
                "accept_version": API_VERSION,
                "request_id": "req_propose_e2e",
                "mode": "assist",
                "messages": [{"role": "user", "content": content}],
                **params,
            },
        },
        initialized=True,
    )


def _tool_result(outcome: Any) -> dict[str, Any]:
    return next(item for item in outcome.notifications if item["method"] == "tool.result")["params"]


def test_propose_change_records_a_suggestion_and_leaves_the_file(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("hello world\n", encoding="utf-8")
    _initialize(workspace_root)

    outcome = _send("/tool propose notes.txt ::: world ::: earth", propose_mode=True)

    result = _tool_result(outcome)
    assert result["success"] is True, result
    record = result["metadata"]["suggested_change"]
    assert record["path"] == "notes.txt"
    assert record["new_string"] == "earth"
    assert (workspace_root / "notes.txt").read_text(encoding="utf-8") == "hello world\n"
    assert not (workspace_root / ".jenny").exists()


def test_session_live_suggestion_reaches_the_overlap_rule(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("hello world\n", encoding="utf-8")
    _initialize(workspace_root)
    live = {"id": "sg_live", "path": "notes.txt", "kind": "replace", "old_string": "hello world"}

    outcome = _send(
        "/tool propose notes.txt ::: world ::: earth",
        propose_mode=True,
        suggested_changes_context={"schema_version": 1, "live": [live]},
    )

    result = _tool_result(outcome)
    assert result["success"] is False
    assert "sg_live" in str(result.get("output") or result)


def test_propose_change_is_unavailable_outside_propose_mode(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("hello world\n", encoding="utf-8")
    _initialize(workspace_root)

    outcome = _send("/tool propose notes.txt ::: world ::: earth")

    result = _tool_result(outcome)
    assert result["success"] is False
    assert result["metadata"].get("propose_mode_only") is True


def test_edit_file_stays_blocked_in_propose_mode(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("hello world\n", encoding="utf-8")
    _initialize(workspace_root)

    outcome = _send("/tool edit notes.txt ::: world ::: earth", propose_mode=True)

    result = _tool_result(outcome)
    assert result["success"] is False
    assert (workspace_root / "notes.txt").read_text(encoding="utf-8") == "hello world\n"
