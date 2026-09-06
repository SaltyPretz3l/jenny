from __future__ import annotations

import subprocess
import sys

import pytest

from sidecar import server
from sidecar.ai.tools.builtins.filesystem import read_file_tool
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.protocol import API_VERSION


def _git_available() -> bool:
    return (
        subprocess.run(
            ["git", "--version"],
            capture_output=True,
            text=True,
            check=False,
        ).returncode
        == 0
    )


def test_process_message_chat_send_tool_execution_streams_tool_events(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("hello tools", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 17,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 18,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_tool_read",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool read notes.txt"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    methods = [item["method"] for item in outcome.notifications]
    assert "tool.executing" in methods
    assert "tool.result" in methods
    assert methods[-1] == "chat.done"


def test_process_message_chat_send_rejects_request_disabled_tool_call_without_chat_error(
    tmp_path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("hello tools", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 17_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 18_1,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_tool_read_disabled",
            "mode": "assist",
            "tool_preferences": {
                "disabled_tools": ["read_file"],
            },
            "messages": [{"role": "user", "content": "/tool read notes.txt"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    methods = [item["method"] for item in outcome.notifications]
    assert "chat.error" not in methods
    assert "tool.executing" in methods
    assert "tool.result" in methods
    assert methods[-1] == "chat.done"
    tool_result = next(
        item
        for item in outcome.notifications
        if item["method"] == "tool.result" and item["params"]["tool_name"] == "read_file"
    )
    assert tool_result["params"]["success"] is False
    assert tool_result["params"]["error_code"] == "CMP-TOOL-0002"
    assert tool_result["params"]["metadata"]["request_preference_disabled"] is True


def test_process_message_chat_send_rejects_non_boolean_plan_mode(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 17_2,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 18_2,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_bad_plan_mode",
            "mode": "assist",
            "plan_mode": "true",
            "messages": [{"role": "user", "content": "Plan the change"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"
    assert "plan_mode must be a boolean" in outcome.notifications[0]["params"]["message"]


def test_process_message_chat_send_rejects_null_plan_mode(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 17_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 18_3,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_null_plan_mode",
            "mode": "assist",
            "plan_mode": None,
            "messages": [{"role": "user", "content": "Plan the change"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"
    assert "plan_mode must be a boolean" in outcome.notifications[0]["params"]["message"]


def test_process_message_chat_send_rejects_plan_mode_side_effecting_tool_call_without_chat_error(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 18_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)
    engine = server._BRAIN_CONTAINER.stack.engine
    calls = {"count": 0}

    def _generate_with_tools(**_kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            return GenerationResult(
                content="Writing file.",
                tool_calls=(
                    ToolCallRequest(
                        tool_id="write_file",
                        arguments={"path": "notes.md", "content": "approved"},
                    ),
                ),
                finish_reason="tool_calls",
            )
        return GenerationResult(content="Done.", finish_reason="stop")

    monkeypatch.setattr(engine, "generate_with_tools", _generate_with_tools)

    message = {
        "jsonrpc": "2.0",
        "id": 18_4,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_plan_mode_write_block",
            "mode": "assist",
            "plan_mode": True,
            "messages": [{"role": "user", "content": "Write notes.md"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    methods = [item["method"] for item in outcome.notifications]
    assert "chat.error" not in methods
    assert "tool.executing" in methods
    assert "tool.result" in methods
    assert methods[-1] == "chat.done"
    tool_result = next(
        item
        for item in outcome.notifications
        if item["method"] == "tool.result" and item["params"]["tool_name"] == "write_file"
    )
    assert tool_result["params"]["success"] is False
    assert tool_result["params"]["error_code"] == "CMP-MODE-0002"
    assert tool_result["params"]["metadata"]["read_only_blocked"] is True


def test_process_message_chat_send_blocks_when_only_workspace_tools_requested() -> None:
    # The default no-root case degrades silently (the tool-contract assembly drops
    # workspace-requiring tools from the model's list), but a request that EXPLICITLY
    # narrows tooling to a set that is entirely workspace-requiring must still fail
    # fast with the CMP-CFG-0001 setup error — degrading would leave the model none
    # of the tools the caller asked for, so a "set a workspace root" card is clearer.
    initialize = {
        "jsonrpc": "2.0",
        "id": 19,
        "method": "initialize",
        "params": {"accept_version": API_VERSION, "config": {"tools_workspace_root": None}},
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 20,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_tool_root_missing",
            "mode": "assist",
            "tool_preferences": {"enabled_tools": ["read_file", "list_dir"]},
            "messages": [{"role": "user", "content": "read my notes"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-CFG-0001"
    methods = [item["method"] for item in outcome.notifications]
    assert methods[0] == "chat.error"
    assert outcome.notifications[0]["params"]["code"] == "CMP-CFG-0001"
    assert "tool.executing" not in methods
    assert "tool.result" not in methods


def test_process_message_chat_send_degrades_when_workspace_not_set() -> None:
    # A default request with tools enabled but no workspace root (e.g. a fresh
    # "Skip setup" first message) must NOT hard-fail — workspace-requiring tools are
    # simply absent from the model's tool list and the turn answers normally.
    initialize = {
        "jsonrpc": "2.0",
        "id": 21,
        "method": "initialize",
        "params": {"accept_version": API_VERSION, "config": {"tools_workspace_root": None}},
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 22,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_tool_root_missing_degrade",
            "mode": "assist",
            "messages": [{"role": "user", "content": "How do I get started?"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    methods = [item["method"] for item in outcome.notifications]
    codes = [
        item["params"].get("code")
        for item in outcome.notifications
        if isinstance(item.get("params"), dict)
    ]
    assert "chat.error" not in methods, "a missing workspace root must not hard-fail the turn"
    assert "CMP-CFG-0001" not in codes
    assert methods[-1] == "chat.done"


def test_process_message_chat_send_rejects_traversal_escape(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    outside_file = tmp_path / "outside.txt"
    outside_file.write_text("secret", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 21,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 22,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_tool_escape",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool read ../outside.txt"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    # Turn-survival: the escape is still blocked (the secret never leaks) but
    # the block is a failed tool result the model sees, not a dead turn.
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is False
    assert tool_result["params"]["error_code"] == "CMP-TOOL-0003"
    assert "secret" not in str(tool_result["params"]["output"])
    assert outcome.notifications[-1]["method"] == "chat.done"


def test_process_message_chat_send_rejects_symlink_escape(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (outside_dir / "secret.txt").write_text("secret", encoding="utf-8")

    symlink_path = workspace_root / "escape_link"
    try:
        symlink_path.symlink_to(outside_dir, target_is_directory=True)
    except (NotImplementedError, OSError):
        if (
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(symlink_path), str(outside_dir)],
                capture_output=True,
                text=True,
                check=False,
            ).returncode
            != 0
        ):
            pytest.skip("symlink/junction creation unavailable in this environment")

    initialize = {
        "jsonrpc": "2.0",
        "id": 23,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 24,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_tool_symlink_escape",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool read escape_link/secret.txt"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    # Turn-survival: symlink escapes stay blocked (nothing outside the
    # workspace is read) while the turn completes with a failed tool result.
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is False
    assert tool_result["params"]["error_code"] == "CMP-TOOL-0003"
    assert "secret" not in str(tool_result["params"]["output"])
    assert outcome.notifications[-1]["method"] == "chat.done"


def test_run_chat_send_with_optional_approval_executes_after_approval(
    tmp_path, monkeypatch
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 25,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "tools_workspace_root": str(workspace_root),
                "tools_confirm_side_effects": True,
                "tools_shell_enabled": True,
            },
        },
    }
    server.process_message(initialize, initialized=False)

    written_messages: list[dict[str, object]] = []

    def fake_write_message(payload: dict[str, object]) -> None:
        written_messages.append(payload)

    def fake_read_message() -> dict[str, object]:
        approval = next(
            msg for msg in written_messages if msg.get("method") == "tool.request_approval"
        )
        return {"jsonrpc": "2.0", "id": approval["id"], "result": {"approved": True}}

    monkeypatch.setattr(server, "write_message", fake_write_message)
    monkeypatch.setattr(server, "read_message", fake_read_message)

    message = {
        "jsonrpc": "2.0",
        "id": 26,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_tool_write",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool write notes.md ::: approved"}],
        },
    }

    outcome = server._run_chat_send_with_optional_approval(message)  # noqa: SLF001

    assert any(msg["method"] == "tool.request_approval" for msg in written_messages)
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    # Tool results may appear in outcome.notifications (non-streaming) or
    # in written_messages (streamed inline via notification_writer).
    all_methods = [item["method"] for item in outcome.notifications]
    all_methods.extend(msg.get("method", "") for msg in written_messages)
    assert "tool.result" in all_methods
    assert (workspace_root / "notes.md").read_text(encoding="utf-8") == "approved"


def test_process_message_chat_send_blocks_tool_calls_in_chat_mode(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 27,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 28,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_chat_mode_block",
            "mode": "chat",
            "messages": [{"role": "user", "content": "/tool list ."}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    # Turn-survival: chat mode still refuses the tool (nothing executes) but
    # the refusal is a failed tool result plus a normal completion.
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    methods = [item["method"] for item in outcome.notifications]
    assert "chat.error" not in methods
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is False
    assert tool_result["params"]["error_code"] == "CMP-MODE-0002"
    assert outcome.notifications[-1]["method"] == "chat.done"


def test_process_message_chat_send_sanitizes_tool_output(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "secrets.txt").write_text("token: sk-abcdefghijklmnop", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 29,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 30,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_sanitize",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool read secrets.txt"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    output = str(tool_result["params"]["output"])
    assert "[REDACTED]" in output
    assert "sk-abcdefghijklmnop" not in output


def test_run_chat_send_with_optional_approval_executes_shell_tool_after_approval(
    tmp_path, monkeypatch
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 31,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "tools_workspace_root": str(workspace_root),
                "tools_confirm_side_effects": True,
                "tools_shell_enabled": True,
            },
        },
    }
    server.process_message(initialize, initialized=False)

    written_messages: list[dict[str, object]] = []

    def fake_write_message(payload: dict[str, object]) -> None:
        written_messages.append(payload)

    def fake_read_message() -> dict[str, object]:
        approval = next(
            msg for msg in written_messages if msg.get("method") == "tool.request_approval"
        )
        return {"jsonrpc": "2.0", "id": approval["id"], "result": {"approved": True}}

    monkeypatch.setattr(server, "write_message", fake_write_message)
    monkeypatch.setattr(server, "read_message", fake_read_message)

    message = {
        "jsonrpc": "2.0",
        "id": 32,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_tool_shell",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool shell python --version"}],
        },
    }

    outcome = server._run_chat_send_with_optional_approval(message)  # noqa: SLF001

    assert any(msg["method"] == "tool.request_approval" for msg in written_messages)
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    # Tool result may be in outcome.notifications or streamed via written_messages
    all_items = list(outcome.notifications) + [
        msg for msg in written_messages if msg.get("method") == "tool.result"
    ]
    tool_result = next(item for item in all_items if item.get("method") == "tool.result")
    tool_output = str(tool_result["params"]["output"])
    assert '"ok": true' in tool_output.lower()
    assert '"exit_code": 0' in tool_output.lower()


def test_process_message_chat_send_blocks_shell_tool_by_default(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 32_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "tools_workspace_root": str(workspace_root),
                "tools_confirm_side_effects": False,
            },
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 32_2,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_shell_disabled",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool shell python --version"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    # Turn-survival: the shell stays disabled (the command never runs) but the
    # refusal is a failed tool result plus a normal completion.
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    methods = [item["method"] for item in outcome.notifications]
    assert "chat.error" not in methods
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is False
    assert tool_result["params"]["error_code"] == "CMP-TOOL-0002"
    assert outcome.notifications[-1]["method"] == "chat.done"


@pytest.mark.skipif(
    sys.platform != "win32",
    reason="drives a real 'cmd /c exit 3' through the shell tool; cmd only exists on Windows",
)
def test_process_message_chat_send_reports_non_zero_shell_exit_as_failed_result(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 32_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "tools_workspace_root": str(workspace_root),
                "tools_confirm_side_effects": False,
                "tools_shell_enabled": True,
            },
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 32_4,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_shell_nonzero",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool shell cmd /c exit 3"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is False
    tool_output = str(tool_result["params"]["output"]).lower()
    assert '"ok": false' in tool_output
    assert '"exit_code": 3' in tool_output
    assert outcome.notifications[-1]["method"] == "chat.done"


def test_process_message_chat_send_supports_quoted_paths_for_write_and_read(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 32_5,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "tools_workspace_root": str(workspace_root),
                "tools_confirm_side_effects": False,
            },
        },
    }
    server.process_message(initialize, initialized=False)

    write_message = {
        "jsonrpc": "2.0",
        "id": 32_6,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_write_quoted",
            "mode": "assist",
            "messages": [
                {
                    "role": "user",
                    "content": '/tool write "folder with spaces/notes file.txt" ::: quoted path write content',
                }
            ],
        },
    }

    write_outcome = server.process_message(write_message, initialized=True)

    assert write_outcome.response is not None
    assert write_outcome.response["result"]["status"] == "completed"
    expected_path = workspace_root / "folder with spaces" / "notes file.txt"
    assert expected_path.read_text(encoding="utf-8") == "quoted path write content"

    read_message = {
        "jsonrpc": "2.0",
        "id": 32_7,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_read_quoted",
            "mode": "assist",
            "messages": [
                {"role": "user", "content": '/tool read "folder with spaces/notes file.txt"'}
            ],
        },
    }

    read_outcome = server.process_message(read_message, initialized=True)
    assert read_outcome.response is not None
    read_tool_result = next(
        item for item in read_outcome.notifications if item["method"] == "tool.result"
    )
    assert "quoted path write content" in str(read_tool_result["params"]["output"])


def test_process_message_chat_send_runs_edit_tool_and_emits_checkpoint_metadata(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("hello world\n", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 32_7_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 32_7_2,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_edit_tool",
            "mode": "assist",
            "canonical_session_messages": _canonical_read_messages(workspace_root, "notes.txt"),
            "messages": [
                {
                    "role": "user",
                    "content": "/tool edit notes.txt ::: world ::: earth",
                }
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is True
    assert tool_result["params"]["metadata"]["checkpoint_created"] is True
    assert tool_result["params"]["metadata"]["checkpoint_display_path"].startswith(
        ".jenny/backups/"
    )
    assert (workspace_root / "notes.txt").read_text(encoding="utf-8") == "hello earth\n"


def test_process_message_chat_send_reports_edit_ambiguity_as_failed_tool_result(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("aaa bbb aaa\n", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 32_7_3,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 32_7_4,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_edit_ambiguous",
            "mode": "assist",
            "canonical_session_messages": _canonical_read_messages(workspace_root, "notes.txt"),
            "messages": [
                {
                    "role": "user",
                    "content": "/tool edit notes.txt ::: aaa ::: ccc",
                }
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is False
    assert tool_result["params"]["error_code"] == "CMP-TOOL-0008"
    assert tool_result["params"]["metadata"]["occurrences"] == 2


def test_process_message_chat_send_auto_injects_snapshot_for_existing_write(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("before\n", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 32_7_5,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 32_7_6,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_write_existing",
            "mode": "assist",
            "canonical_session_messages": _canonical_read_messages(workspace_root, "notes.txt"),
            "messages": [
                {
                    "role": "user",
                    "content": "/tool write notes.txt ::: after",
                }
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is True
    assert tool_result["params"]["metadata"]["checkpoint_created"] is True
    assert (workspace_root / "notes.txt").read_text(encoding="utf-8") == "after"


def test_process_message_chat_send_auto_injects_snapshot_for_full_coverage_paginated_read(
    tmp_path,
) -> None:
    # Small models habitually read with offset/limit. A window that covers the whole
    # file must authorize a later overwrite exactly like an unpaginated read — this is
    # the end-to-end repro of the gpt-oss/gemma poem.md failure.
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "poem.md").write_text("before\n", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 33_10,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    canonical = _canonical_read_messages(
        workspace_root, "poem.md", read_args={"offset": 0, "limit": 2000}
    )
    assert canonical[0]["tool_result"]["metadata"]["read_snapshot"]["scope"] == "full"

    message = {
        "jsonrpc": "2.0",
        "id": 33_11,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_write_after_paginated_read",
            "mode": "assist",
            "canonical_session_messages": canonical,
            "messages": [
                {
                    "role": "user",
                    "content": "/tool write poem.md ::: after",
                }
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is True
    assert (workspace_root / "poem.md").read_text(encoding="utf-8") == "after"


def test_process_message_chat_send_applies_edit_without_snapshot_via_content_anchor(
    tmp_path,
) -> None:
    # Relaxed contract (Wave-R R3, commit 4a92556): edit_file's read snapshot
    # is optional. A never-read turn no longer hard-fails with
    # CMP_TOOL_READ_SNAPSHOT_REQUIRED -- it falls back to a content-anchored
    # apply, since old_string's unique match is itself a stale-write guard.
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("hello world\n", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 32_7_7,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 32_7_8,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_edit_missing_snapshot",
            "mode": "assist",
            "messages": [
                {
                    "role": "user",
                    "content": "/tool edit notes.txt ::: world ::: earth",
                }
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is True
    # Fallback path is observable: the strong snapshot guarantee was NOT
    # exercised, so the content-anchored match is what protected the write.
    assert tool_result["params"]["metadata"]["read_snapshot_validated"] is False
    assert (workspace_root / "notes.txt").read_text(encoding="utf-8") == "hello earth\n"


def test_process_message_chat_send_supports_quoted_git_cwd(tmp_path) -> None:
    if not _git_available():
        pytest.skip("git is unavailable in this environment")

    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    git_repo = workspace_root / "repo with spaces"
    git_repo.mkdir()
    subprocess.run(["git", "init"], cwd=git_repo, capture_output=True, text=True, check=True)

    initialize = {
        "jsonrpc": "2.0",
        "id": 32_8,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 32_9,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_git_status_quoted",
            "mode": "assist",
            "messages": [{"role": "user", "content": '/tool git status "repo with spaces"'}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    output = str(tool_result["params"]["output"]).lower()
    assert "on branch" in output or output.startswith("## ")


def test_run_chat_send_with_optional_approval_denies_when_approval_times_out(
    tmp_path, monkeypatch
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 32_10,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "tools_workspace_root": str(workspace_root),
                "tools_confirm_side_effects": True,
            },
        },
    }
    server.process_message(initialize, initialized=False)

    written_messages: list[dict[str, object]] = []

    def fake_write_message(payload: dict[str, object]) -> None:
        written_messages.append(payload)

    monkeypatch.setattr(server, "write_message", fake_write_message)

    message = {
        "jsonrpc": "2.0",
        "id": 32_11,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_tool_approval_timeout",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool write notes.md ::: timeout"}],
        },
    }

    outcome = server._run_chat_send_with_optional_approval(  # noqa: SLF001
        message,
        approval_response_reader=lambda _timeout: (_ for _ in ()).throw(TimeoutError("timeout")),
    )

    assert any(msg["method"] == "tool.request_approval" for msg in written_messages)
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "timeout"
    assert outcome.response["result"]["terminal_subcode"] == "approval"
    assert outcome.notifications == []


def test_process_message_chat_send_runs_git_status_tool(tmp_path) -> None:
    if not _git_available():
        pytest.skip("git is unavailable in this environment")

    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    subprocess.run(["git", "init"], cwd=workspace_root, capture_output=True, text=True, check=True)

    initialize = {
        "jsonrpc": "2.0",
        "id": 33,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 34,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_git_status",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool git status"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    output = str(tool_result["params"]["output"]).lower()
    assert "on branch" in output or output.startswith("## ")


def _canonical_read_messages(
    workspace_root, relative_path: str, *, read_args: dict[str, object] | None = None
) -> list[dict[str, object]]:
    call_args: dict[str, object] = {"path": relative_path, **(read_args or {})}
    result = read_file_tool(call_args, WorkspaceGuard(str(workspace_root)))
    snapshot = result.metadata["read_snapshot"]
    return [
        {
            "id": f"tool_result_read_{relative_path}",
            "role": "tool",
            "kind": "tool_result",
            "content": f"Read {relative_path}",
            "tool_result": {
                "call_id": f"call_read_{relative_path}",
                "tool_name": "read_file",
                "output_text": result.output,
                "summary": f"Read {relative_path}",
                "is_error": False,
                "metadata": {
                    "path": relative_path,
                    "read_snapshot": snapshot,
                },
            },
        },
    ]


def test_process_message_chat_send_runs_git_diff_tool(tmp_path) -> None:
    if not _git_available():
        pytest.skip("git is unavailable in this environment")

    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    subprocess.run(["git", "init"], cwd=workspace_root, capture_output=True, text=True, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Jenny Test"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
        check=True,
    )
    tracked_file = workspace_root / "notes.txt"
    tracked_file.write_text("hello\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", "notes.txt"], cwd=workspace_root, capture_output=True, text=True, check=True
    )
    subprocess.run(
        ["git", "commit", "-m", "initial"],
        cwd=workspace_root,
        capture_output=True,
        text=True,
        check=True,
    )
    tracked_file.write_text("hello world\n", encoding="utf-8")

    initialize = {
        "jsonrpc": "2.0",
        "id": 34_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"tools_workspace_root": str(workspace_root)},
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 34_2,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_git_diff",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool git diff"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    output = str(tool_result["params"]["output"])
    assert "diff --git" in output
    assert "--- a/notes.txt" in output
    assert "+++ b/notes.txt" in output


def test_process_message_chat_send_blocks_dangerous_shell_pattern(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    initialize = {
        "jsonrpc": "2.0",
        "id": 35,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "tools_workspace_root": str(workspace_root),
                "tools_confirm_side_effects": False,
                "tools_shell_enabled": True,
            },
        },
    }
    server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 36,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_blocked_shell",
            "mode": "assist",
            "messages": [{"role": "user", "content": "/tool shell rm -rf /"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    # Turn-survival: the destructive command is still blocked by the security
    # classifier (it never executes) while the turn completes with a failed
    # tool result the model can react to.
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    tool_result = next(item for item in outcome.notifications if item["method"] == "tool.result")
    assert tool_result["params"]["success"] is False
    assert tool_result["params"]["error_code"] == "CMP-TOOL-0007"
    assert outcome.notifications[-1]["method"] == "chat.done"
