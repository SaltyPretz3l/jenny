from __future__ import annotations

import json

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_COERCED_ARGS_REJECTED,
    CMP_TOOL_READ_SNAPSHOT_REQUIRED,
)
from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.builtins import web as web_module
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard


def test_default_tools_include_search_tools_by_default() -> None:
    tools = builtin_server._default_tools()  # noqa: SLF001

    assert "glob_files" in tools
    assert "grep_search" in tools
    assert "edit_file" in tools
    assert "git_diff" in tools
    assert "git_show" in tools
    assert "workspace_change_baseline" in tools
    assert "workspace_change_delta" in tools
    assert "headings" in tools["read_file"].input_schema["properties"]
    assert "offset" in tools["read_file"].input_schema["properties"]
    assert "limit" in tools["read_file"].input_schema["properties"]
    assert "pages" not in tools["read_file"].input_schema["properties"]
    assert "expected_read_snapshot" in tools["write_file"].input_schema["properties"]
    assert "expected_read_snapshot" in tools["edit_file"].input_schema["properties"]
    assert "normalize_bom" in tools["write_file"].input_schema["properties"]


def test_default_tools_can_disable_search_tools() -> None:
    tools = builtin_server._default_tools(  # noqa: SLF001
        glob_enabled=False,
        grep_enabled=False,
        edit_enabled=False,
    )

    assert "glob_files" not in tools
    assert "grep_search" not in tools
    assert "edit_file" not in tools


def test_default_tools_gate_workspace_manifest_tool() -> None:
    disabled = builtin_server._default_tools(workspace_manifest_enabled=False)  # noqa: SLF001
    enabled = builtin_server._default_tools(workspace_manifest_enabled=True)  # noqa: SLF001

    assert "workspace_manifest_read" not in disabled
    assert "workspace_manifest_read" in enabled
    assert enabled["workspace_manifest_read"].input_schema["properties"] == {}


def test_default_tools_do_not_expose_retired_expand_tool() -> None:
    disabled = builtin_server._default_tools(distill_enabled=False)  # noqa: SLF001
    enabled = builtin_server._default_tools(  # noqa: SLF001
        distill_enabled=True,
        shell_enabled=True,
    )

    assert "expand" not in disabled
    assert "expand" not in enabled
    assert "run_command" in enabled


def test_default_tools_gate_knowledge_tools(tmp_path) -> None:
    root = tmp_path / "corpus"
    root.mkdir()
    (root / "doc.md").write_text("needle\n", encoding="utf-8")
    disabled = builtin_server._default_tools(knowledge_enabled=False)  # noqa: SLF001
    enabled = builtin_server._default_tools(  # noqa: SLF001
        knowledge_enabled=True,
        knowledge_roots=(str(root),),
    )

    assert "knowledge_search" not in disabled
    assert "knowledge_view" not in disabled
    assert "knowledge_exec" not in disabled
    assert "knowledge_search" in enabled
    assert "knowledge_view" in enabled
    assert "knowledge_exec" in enabled
    # The bound handler must actually see the configured roots.
    result = enabled["knowledge_search"].handler({"pattern": "needle"}, WorkspaceGuard(None))
    payload = json.loads(result.output)
    assert "corpus/doc.md" in str(payload["result"])


def test_builtin_server_main_parses_knowledge_args(tmp_path, monkeypatch) -> None:
    root_a = tmp_path / "alpha"
    root_b = tmp_path / "beta"
    root_a.mkdir()
    root_b.mkdir()
    captured: dict[str, object] = {}

    def fake_default_tools(**kwargs):
        captured.update(kwargs)
        return {}

    monkeypatch.setattr(builtin_server, "_default_tools", fake_default_tools)
    monkeypatch.setattr(builtin_server.sys, "stdin", type("EmptyStdin", (), {
        "readline": staticmethod(lambda: ""),
    })())

    builtin_server.main(
        [
            "--workspace-root",
            str(tmp_path),
            "--knowledge-enabled",
            "1",
            "--knowledge-root",
            str(root_a),
            "--knowledge-root",
            str(root_b),
        ]
    )

    assert captured["knowledge_enabled"] is True
    assert captured["knowledge_roots"] == (str(root_a), str(root_b))


def test_default_tools_gate_lsp_tools() -> None:
    disabled = builtin_server._default_tools(lsp_enabled=False)  # noqa: SLF001
    enabled = builtin_server._default_tools(lsp_enabled=True)  # noqa: SLF001

    assert "lsp" not in disabled
    assert "lsp" in enabled
    assert "path" in enabled["lsp"].input_schema["properties"]
    assert "line" in enabled["lsp"].input_schema["properties"]
    assert "include_declaration" in enabled["lsp"].input_schema["properties"]
    assert enabled["lsp"].side_effecting is False


def test_default_tools_can_expose_pdf_pages_when_image_read_enabled() -> None:
    tools = builtin_server._default_tools(image_read_enabled=True)  # noqa: SLF001

    assert "pages" in tools["read_file"].input_schema["properties"]


def test_default_tools_apply_full_web_configuration() -> None:
    tools = builtin_server._default_tools(  # noqa: SLF001
        web_enabled=True,
        web_rate_limit_per_min=7,
        web_max_fetch_bytes=4097,
        web_allow_private_addresses=True,
        web_search_provider="bing",
    )

    assert "web_search" in tools
    assert "fetch_url" in tools
    assert web_module._rate_limiter._limit == 7  # noqa: SLF001
    assert web_module._max_fetch_bytes == 4097  # noqa: SLF001
    assert web_module._allow_private_addresses is True  # noqa: SLF001
    assert web_module._search_provider == "bing"  # noqa: SLF001


def test_safe_json_dumps_replaces_lone_surrogates() -> None:
    serialized = builtin_server._safe_json_dumps({"text": "bad\udc8fvalue"})  # noqa: SLF001

    assert "\udc8f" not in serialized
    assert json.loads(serialized) == {"text": "bad\ufffdvalue"}


def test_tools_call_serializes_tool_handler_result_output_alias(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    tools = {
        "echo": builtin_server.BuiltinTool(
            name="echo",
            description="Echo aliased output",
            side_effecting=False,
            input_schema={"type": "object", "properties": {}},
            handler=lambda _arguments, _workspace: ToolHandlerResult(
                output="Aliased tool output",
                metadata={"kind": "alias"},
            ),
        )
    }

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "msg-1",
        tools,
        WorkspaceGuard(str(workspace_root)),
        {"name": "echo", "arguments": {}},
    )

    assert response["result"]["content"][0]["text"] == "Aliased tool output"
    metadata = response["result"]["metadata"]
    assert metadata["kind"] == "alias"
    assert str(metadata["mcp_operation_id"]).startswith("op_")
    assert str(metadata["mcp_generation_id"]).startswith("gen_")


def test_tools_call_rejects_malformed_grep_arguments(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("Needle\n", encoding="utf-8")

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "msg-2",
        builtin_server._default_tools(),  # noqa: SLF001
        WorkspaceGuard(str(workspace_root)),
        {
            "name": "grep_search",
            "arguments": {"pattern": "needle", "ignore_case": "false"},
        },
    )

    assert response["error"]["data"]["code"] == CMP_TOOL_COERCED_ARGS_REJECTED
    assert "malformed arguments" in response["error"]["message"]


def test_tools_call_write_file_requires_snapshot_for_existing_file(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "notes.txt").write_text("before\n", encoding="utf-8")

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "msg-write-existing",
        builtin_server._default_tools(),  # noqa: SLF001
        WorkspaceGuard(str(workspace_root)),
        {
            "name": "write_file",
            "arguments": {"path": "notes.txt", "content": "after\n"},
        },
    )

    assert response["result"]["success"] is False
    assert response["result"]["error_code"] == CMP_TOOL_READ_SNAPSHOT_REQUIRED


def test_tools_call_write_file_accepts_matching_snapshot_for_existing_file(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "notes.txt"
    target.write_text("before\n", encoding="utf-8")
    workspace = WorkspaceGuard(str(workspace_root))
    read_result = builtin_server._default_tools()["read_file"].handler(
        {"path": "notes.txt"}, workspace
    )  # noqa: SLF001
    assert isinstance(read_result, ToolHandlerResult)

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "msg-write-existing-ok",
        builtin_server._default_tools(),  # noqa: SLF001
        workspace,
        {
            "name": "write_file",
            "arguments": {
                "path": "notes.txt",
                "content": "after\n",
                "expected_read_snapshot": read_result.metadata["read_snapshot"],
            },
        },
    )

    assert response["result"]["success"] is True
    assert target.read_text(encoding="utf-8") == "after\n"


def test_tools_call_auto_injects_snapshot_from_prior_direct_mcp_read(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "notes.txt"
    target.write_text("before\n", encoding="utf-8")
    workspace = WorkspaceGuard(str(workspace_root))
    tools = builtin_server._default_tools()  # noqa: SLF001

    read_response = builtin_server._handle_tools_call(  # noqa: SLF001
        "msg-read-lease",
        tools,
        workspace,
        {"name": "read_file", "arguments": {"path": "notes.txt"}},
    )
    write_response = builtin_server._handle_tools_call(  # noqa: SLF001
        "msg-write-lease",
        tools,
        workspace,
        {
            "name": "write_file",
            "arguments": {"path": "notes.txt", "content": "after\n"},
        },
    )

    metadata = read_response["result"]["metadata"]
    assert str(metadata["snapshot_id"]).startswith("snap_")
    assert metadata["write_eligible"] is True
    assert write_response["result"]["success"] is True
    assert target.read_text(encoding="utf-8") == "after\n"


def test_tools_call_edit_file_applies_without_snapshot_via_content_anchor(tmp_path) -> None:
    """End-to-end through the builtin MCP dispatch (the path the local daily
    models use): a snapshot-free edit now succeeds via the content-anchored
    fallback instead of erroring on the read-snapshot requirement."""
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "notes.txt"
    target.write_text("hello world\n", encoding="utf-8")

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "msg-edit-existing",
        builtin_server._default_tools(),  # noqa: SLF001
        WorkspaceGuard(str(workspace_root)),
        {
            "name": "edit_file",
            "arguments": {
                "file_path": "notes.txt",
                "old_string": "world",
                "new_string": "earth",
            },
        },
    )

    assert response["result"]["success"] is True
    assert target.read_text(encoding="utf-8") == "hello earth\n"
    assert response["result"]["metadata"]["read_snapshot_validated"] is False


@pytest.mark.parametrize("tool_name", ["write_file", "edit_file"])
def test_mutation_tools_refuse_reserved_jenny_state(tmp_path, tool_name) -> None:
    workspace_root = tmp_path / "workspace"
    target_dir = workspace_root / ".jenny"
    target_dir.mkdir(parents=True)
    (target_dir / "state.txt").write_text("old\n", encoding="utf-8")
    arguments = {
        "write_file": {"path": ".jenny/state.txt", "content": "new\n"},
        "edit_file": {
            "file_path": ".jenny/state.txt",
            "old_string": "old",
            "new_string": "new",
        },
    }[tool_name]

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        f"msg-{tool_name}",
        builtin_server._default_tools(),  # noqa: SLF001
        WorkspaceGuard(str(workspace_root)),
        {"name": tool_name, "arguments": arguments},
    )

    assert (target_dir / "state.txt").read_text(encoding="utf-8") == "old\n"
    if "result" in response:
        assert response["result"]["success"] is False
    else:
        assert response["error"]


def test_tools_call_edit_file_accepts_matching_snapshot_for_existing_file(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "notes.txt"
    target.write_text("hello world\n", encoding="utf-8")
    workspace = WorkspaceGuard(str(workspace_root))
    read_result = builtin_server._default_tools()["read_file"].handler(
        {"path": "notes.txt"}, workspace
    )  # noqa: SLF001
    assert isinstance(read_result, ToolHandlerResult)

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "msg-edit-existing-ok",
        builtin_server._default_tools(),  # noqa: SLF001
        workspace,
        {
            "name": "edit_file",
            "arguments": {
                "file_path": "notes.txt",
                "old_string": "world",
                "new_string": "earth",
                "expected_read_snapshot": read_result.metadata["read_snapshot"],
            },
        },
    )

    assert response["result"]["success"] is True
    assert target.read_text(encoding="utf-8") == "hello earth\n"
