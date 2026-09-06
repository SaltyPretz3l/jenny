from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing import tool_resolution
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_execution import _dispatch_tool_call, execute_tool
from sidecar.ai.tools.catalog import manifest_tool_entry
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.electron_tool_bridge import (
    ElectronToolBridgeRequest,
    execute_electron_tool,
)


class _MCPClient:
    available_tools: list[object] = []

    def execute_tool(self, *_args: object, **_kwargs: object) -> object:
        raise AssertionError("browser tools must execute through the Electron bridge")

    def tool_descriptor(self, _tool_name: str) -> None:
        return None


def _kernel(config: RuntimeConfig) -> SimpleNamespace:
    return SimpleNamespace(
        _config=config,
        _mcp_client=_MCPClient(),
        _engine=SimpleNamespace(supports_tool_calling=True),
        _active_cancel_handle=None,
    )


def _request_context(tmp_path) -> ChatRequestContext:
    return ChatRequestContext(
        request_id="req_browser",
        trace_id="trace_browser",
        session_id="session_browser",
        mode="assist",
        approvals_pre_granted=True,
        workspace_root_present=True,
    )


def test_jenny_status_requires_electron_bridge_runtime_registration(tmp_path) -> None:
    without_bridge = _kernel(
        RuntimeConfig(
            electron_tool_bridge_enabled=False,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    unavailable = tool_resolution.assemble_tool_contract(
        without_bridge,
        request_context=_request_context(tmp_path),
    )

    assert unavailable.entry("jenny_status").available is False
    assert "jenny_status" not in unavailable.available_names

    with_bridge = _kernel(
        RuntimeConfig(
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    available = tool_resolution.assemble_tool_contract(
        with_bridge,
        request_context=_request_context(tmp_path),
    )

    assert "jenny_status" in set(available.available_names)
    assert available.entry("jenny_status").descriptor.server_name == "electron_tool_bridge"


def test_ask_user_requires_electron_bridge_runtime_registration(tmp_path) -> None:
    # `ask_user` is Electron-owned with no config flag, exactly like
    # `jenny_status` and `exit_plan_mode`: the bridge is its only route to a
    # provider-visible schema, and the plan-mode prompt tells the model to call
    # it, so a resolver that omits it advertises a tool the model cannot use.
    without_bridge = _kernel(
        RuntimeConfig(
            electron_tool_bridge_enabled=False,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    unavailable = tool_resolution.assemble_tool_contract(
        without_bridge,
        request_context=_request_context(tmp_path),
    )

    assert unavailable.entry("ask_user").available is False
    assert "ask_user" not in unavailable.available_names

    with_bridge = _kernel(
        RuntimeConfig(
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    available = tool_resolution.assemble_tool_contract(
        with_bridge,
        request_context=_request_context(tmp_path),
    )

    assert "ask_user" in set(available.available_names)
    assert available.entry("ask_user").descriptor.server_name == "electron_tool_bridge"
    assert available.entry("ask_user").descriptor.tool_family == "runtime"


def test_worktree_tools_require_worktree_flag_and_electron_bridge(tmp_path) -> None:
    worktree_tool_names = {
        "worktree_list",
        "worktree_create",
        "worktree_select",
        "worktree_delete",
    }
    without_flag = _kernel(
        RuntimeConfig(
            tools_worktree_enabled=False,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    disabled = tool_resolution.assemble_tool_contract(
        without_flag,
        request_context=_request_context(tmp_path),
    )

    assert disabled.entry("worktree_list").available is False
    assert worktree_tool_names.isdisjoint(disabled.available_names)

    without_bridge = _kernel(
        RuntimeConfig(
            tools_worktree_enabled=True,
            electron_tool_bridge_enabled=False,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    unavailable = tool_resolution.assemble_tool_contract(
        without_bridge,
        request_context=_request_context(tmp_path),
    )

    assert unavailable.entry("worktree_list").available is False
    assert worktree_tool_names.isdisjoint(unavailable.available_names)

    with_bridge = _kernel(
        RuntimeConfig(
            tools_worktree_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    available = tool_resolution.assemble_tool_contract(
        with_bridge,
        request_context=_request_context(tmp_path),
    )

    assert worktree_tool_names <= set(available.available_names)
    assert available.entry("worktree_list").descriptor.server_name == "electron_tool_bridge"
    assert available.entry("worktree_create").descriptor.tool_family == "git"
    assert available.entry("worktree_select").descriptor.tool_family == "git"
    assert available.entry("worktree_delete").descriptor.tool_family == "git"


def test_automation_tools_require_automation_flag_and_electron_bridge(tmp_path) -> None:
    automation_tool_names = {"automation_list", "automation_read"}
    without_flag = _kernel(
        RuntimeConfig(
            tools_automations_enabled=False,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    disabled = tool_resolution.assemble_tool_contract(
        without_flag,
        request_context=_request_context(tmp_path),
    )

    assert disabled.entry("automation_list").available is False
    assert automation_tool_names.isdisjoint(disabled.available_names)

    without_bridge = _kernel(
        RuntimeConfig(
            tools_automations_enabled=True,
            electron_tool_bridge_enabled=False,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    unavailable = tool_resolution.assemble_tool_contract(
        without_bridge,
        request_context=_request_context(tmp_path),
    )

    assert unavailable.entry("automation_list").available is False
    assert automation_tool_names.isdisjoint(unavailable.available_names)

    with_bridge = _kernel(
        RuntimeConfig(
            tools_automations_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    available = tool_resolution.assemble_tool_contract(
        with_bridge,
        request_context=_request_context(tmp_path),
    )

    assert automation_tool_names <= set(available.available_names)
    assert available.entry("automation_list").descriptor.server_name == "electron_tool_bridge"
    assert available.entry("automation_list").descriptor.tool_family == "runtime"
    assert available.entry("automation_read").descriptor.tool_family == "runtime"


def test_workspace_present_tool_requires_flag_and_electron_bridge(tmp_path) -> None:
    workspace_present_tool_names = {"workspace_present"}
    without_flag = _kernel(
        RuntimeConfig(
            tools_workspace_present_enabled=False,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    disabled = tool_resolution.assemble_tool_contract(
        without_flag,
        request_context=_request_context(tmp_path),
    )

    assert disabled.entry("workspace_present").available is False
    assert workspace_present_tool_names.isdisjoint(disabled.available_names)

    without_bridge = _kernel(
        RuntimeConfig(
            tools_workspace_present_enabled=True,
            electron_tool_bridge_enabled=False,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    unavailable = tool_resolution.assemble_tool_contract(
        without_bridge,
        request_context=_request_context(tmp_path),
    )

    assert unavailable.entry("workspace_present").available is False
    assert workspace_present_tool_names.isdisjoint(unavailable.available_names)

    with_bridge = _kernel(
        RuntimeConfig(
            tools_workspace_present_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    available = tool_resolution.assemble_tool_contract(
        with_bridge,
        request_context=_request_context(tmp_path),
    )

    # The "workspace_present" tool schema is sourced live from
    # tool-manifest.json via manifest_tool_entry; a missing entry must fail
    # loudly here, not skip — the descriptor gate depends on it.
    assert manifest_tool_entry("workspace_present") is not None

    assert workspace_present_tool_names <= set(available.available_names)
    entry = available.entry("workspace_present")
    assert entry.descriptor.server_name == "electron_tool_bridge"
    assert entry.descriptor.tool_family == "workspace"
    assert "view" in entry.descriptor.input_schema.get("properties", {})


def test_home_tool_requires_flag_and_electron_bridge(tmp_path) -> None:
    home_tool_names = {"home"}
    without_flag = _kernel(
        RuntimeConfig(
            tools_home_enabled=False,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    disabled = tool_resolution.assemble_tool_contract(
        without_flag,
        request_context=_request_context(tmp_path),
    )

    assert disabled.entry("home").available is False
    assert home_tool_names.isdisjoint(disabled.available_names)

    without_bridge = _kernel(
        RuntimeConfig(
            tools_home_enabled=True,
            electron_tool_bridge_enabled=False,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    unavailable = tool_resolution.assemble_tool_contract(
        without_bridge,
        request_context=_request_context(tmp_path),
    )

    assert unavailable.entry("home").available is False
    assert home_tool_names.isdisjoint(unavailable.available_names)

    with_bridge = _kernel(
        RuntimeConfig(
            tools_home_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    available = tool_resolution.assemble_tool_contract(
        with_bridge,
        request_context=_request_context(tmp_path),
    )

    # Same live-manifest dependency as workspace_present above: a missing
    # manifest entry must fail loudly here, not silently skip the descriptor.
    assert manifest_tool_entry("home") is not None

    assert home_tool_names <= set(available.available_names)
    entry = available.entry("home")
    assert entry.descriptor.server_name == "electron_tool_bridge"
    assert entry.descriptor.tool_family == "home"
    assert "action" in entry.descriptor.input_schema.get("properties", {})


def test_home_tool_needs_no_workspace_root(tmp_path) -> None:
    # Home is not a workspace surface: the manifest sets
    # availability.workspace_required to an explicit false, so the tool must
    # stay available when no tools workspace root is configured.
    kernel = _kernel(
        RuntimeConfig(
            tools_home_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root="",
            mode="assist",
        )
    )
    contract = tool_resolution.assemble_tool_contract(
        kernel,
        request_context=ChatRequestContext(
            request_id="req_home",
            trace_id="trace_home",
            session_id="session_home",
            mode="assist",
            approvals_pre_granted=True,
            workspace_root_present=False,
        ),
    )

    assert "home" in set(contract.available_names)


def test_electron_tool_artifacts_round_trip_through_bridge(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(
            tools_worktree_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    contract = tool_resolution.assemble_tool_contract(
        kernel,
        request_context=_request_context(tmp_path),
    )
    sent_messages: list[dict[str, object]] = []

    def write_message(message: dict[str, object]) -> None:
        sent_messages.append(message)

    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> dict[str, object]:
            return {
                "jsonrpc": "2.0",
                "id": expected_id,
                "result": {
                    "tool_name": "worktree_list",
                    "output": "1 worktree found.",
                    "success": True,
                    "generated_artifacts": [
                        {
                            "artifact_id": "artifact_image_1",
                            "artifact_kind": "image",
                            "title": "Fixture",
                            "file_name": "fixture.png",
                            "display_path": ".jenny/artifacts/session/fixture.png",
                            "absolute_path": "C:/dev/jenny/.jenny/artifacts/session/fixture.png",
                            "mime_type": "image/png",
                            "width": 11,
                            "height": 13,
                            "editable": False,
                            "status": "available",
                            "local_trusted": True,
                            "secret_token": "do-not-leak",
                        }
                    ],
                    "metadata": {"result_kind": "worktree_list"},
                },
            }

        return read_response

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="worktree_list",
            arguments={},
            call_id="call_browser",
        ),
        request_id="req_browser",
        session_id="session_browser",
        read_snapshot_cache={},
        tool_contract=contract,
        runtime=LoopRuntime(
            request_id="req_browser",
            trace_id="trace_browser",
            session_id="session_browser",
            electron_tool_writer=write_message,
            electron_tool_reader=lambda _timeout: {},
            electron_tool_reader_factory=response_reader_factory,
        ),
    )

    assert outcome.success is True
    assert outcome.output == "1 worktree found."
    assert outcome.generated_artifacts[0]["artifact_kind"] == "image"
    assert "absolute_path" not in outcome.generated_artifacts[0]
    assert "local_trusted" not in outcome.generated_artifacts[0]
    assert "secret_token" not in outcome.generated_artifacts[0]
    assert sent_messages[0]["method"] == "tool.execute_electron"
    assert sent_messages[0]["params"]["tool_name"] == "worktree_list"
    assert sent_messages[0]["params"]["arguments"] == {}


def test_edited_plan_round_trips_from_plan_context_to_electron_payload() -> None:
    sent_messages: list[dict[str, object]] = []
    edited_plan = {"title": "Edited", "steps": ["Build"]}

    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> dict[str, object]:
            return {
                "jsonrpc": "2.0",
                "id": expected_id,
                "result": {
                    "tool_name": "exit_plan_mode",
                    "output": "ok",
                    "success": True,
                },
            }

        return read_response

    result = _dispatch_tool_call(
        kernel=SimpleNamespace(_mcp_client=_MCPClient()),
        call=ToolCallRequest(
            tool_id="exit_plan_mode",
            arguments={"title": "Original", "steps": ["Build"]},
            call_id="call_plan",
        ),
        tool_arguments={"title": "Original", "steps": ["Build"]},
        descriptor=SimpleNamespace(server_name="electron_tool_bridge"),
        request_id="req_plan",
        session_id="session_plan",
        runtime=SimpleNamespace(
            request_context=ChatRequestContext(
                request_id="req_plan",
                trace_id="trace_plan",
                session_id="session_plan",
                mode="plan",
                approvals_pre_granted=True,
                plan_mode=True,
                read_only=True,
                plan_decision="approved",
                edited_plan=edited_plan,
            ),
            trace_id="trace_plan",
            electron_tool_writer=sent_messages.append,
            electron_tool_reader=None,
            electron_tool_reader_factory=response_reader_factory,
        ),
        timeout_seconds=1.0,
        cancel_handle=None,
    )

    assert result.success is True
    assert sent_messages[0]["params"]["edited_plan"] == edited_plan


def test_side_effecting_electron_tool_execution_round_trips_to_bridge(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(
            tools_worktree_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    contract = tool_resolution.assemble_tool_contract(
        kernel,
        request_context=_request_context(tmp_path),
    )
    sent_messages: list[dict[str, object]] = []

    def write_message(message: dict[str, object]) -> None:
        sent_messages.append(message)

    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> dict[str, object]:
            return {
                "jsonrpc": "2.0",
                "id": expected_id,
                "result": {
                    "tool_name": "worktree_create",
                    "output": "Created worktree.",
                    "success": True,
                    "generated_artifacts": [],
                    "metadata": {
                        "result_kind": "worktree_create",
                        "worktree": {
                            "status": "created",
                            "name": "feature",
                        },
                    },
                },
            }

        return read_response

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="worktree_create",
            arguments={"name": "feature"},
            call_id="call_browser",
        ),
        request_id="req_browser",
        session_id="session_browser",
        read_snapshot_cache={},
        tool_contract=contract,
        runtime=LoopRuntime(
            request_id="req_browser",
            trace_id="trace_browser",
            session_id="session_browser",
            electron_tool_writer=write_message,
            electron_tool_reader=lambda _timeout: {},
            electron_tool_reader_factory=response_reader_factory,
        ),
    )

    assert outcome.success is True
    assert outcome.output == "Created worktree."
    assert sent_messages[0]["method"] == "tool.execute_electron"
    assert sent_messages[0]["params"]["tool_name"] == "worktree_create"
    assert sent_messages[0]["params"]["arguments"] == {"name": "feature"}


def test_electron_bridge_preserves_sanitized_nested_metadata(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(
            tools_worktree_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    contract = tool_resolution.assemble_tool_contract(
        kernel,
        request_context=_request_context(tmp_path),
    )

    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> dict[str, object]:
            return {
                "jsonrpc": "2.0",
                "id": expected_id,
                "result": {
                    "tool_name": "worktree_create",
                    "output": "Created worktree.",
                    "success": True,
                    "generated_artifacts": [],
                    "metadata": {
                        "result_kind": "worktree_create",
                        "worktree": {
                            "status": "created",
                            "result": {
                                "count": 2,
                                "items": [1, None, {"ok": True}],
                                "message": "Bearer abcdefghijklmnop",
                                "local_path": "C:/Users/Alice/secret.txt",
                            },
                            "messages": [{"level": "info", "message": "ready"}],
                        },
                    },
                },
            }

        return read_response

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="worktree_create",
            arguments={"name": "feature"},
            call_id="call_browser",
        ),
        request_id="req_browser",
        session_id="session_browser",
        read_snapshot_cache={},
        tool_contract=contract,
        runtime=LoopRuntime(
            request_id="req_browser",
            trace_id="trace_browser",
            session_id="session_browser",
            electron_tool_writer=lambda _message: None,
            electron_tool_reader=lambda _timeout: {},
            electron_tool_reader_factory=response_reader_factory,
        ),
    )

    assert outcome.success is True
    assert outcome.metadata["worktree"]["result"]["items"] == [1, None, {"ok": True}]
    assert outcome.metadata["worktree"]["result"]["message"] == "[redacted]"
    assert "local_path" not in outcome.metadata["worktree"]["result"]
    assert outcome.metadata["worktree"]["messages"] == [
        {"level": "info", "message": "ready"}
    ]


def test_worktree_tool_execution_round_trips_to_electron_bridge(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(
            tools_worktree_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    contract = tool_resolution.assemble_tool_contract(
        kernel,
        request_context=_request_context(tmp_path),
    )
    sent_messages: list[dict[str, object]] = []

    def write_message(message: dict[str, object]) -> None:
        sent_messages.append(message)

    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> dict[str, object]:
            return {
                "jsonrpc": "2.0",
                "id": expected_id,
                "result": {
                    "tool_name": "worktree_list",
                    "output": "1 worktree found.",
                    "success": True,
                    "generated_artifacts": [],
                    "metadata": {"result_kind": "worktree_list", "count": 1},
                },
            }

        return read_response

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="worktree_list",
            arguments={},
            call_id="call_worktree",
        ),
        request_id="req_worktree",
        session_id="session_worktree",
        read_snapshot_cache={},
        tool_contract=contract,
        runtime=LoopRuntime(
            request_id="req_worktree",
            trace_id="trace_worktree",
            session_id="session_worktree",
            electron_tool_writer=write_message,
            electron_tool_reader=lambda _timeout: {},
            electron_tool_reader_factory=response_reader_factory,
        ),
    )

    assert outcome.success is True
    assert outcome.output == "1 worktree found."
    assert sent_messages[0]["method"] == "tool.execute_electron"
    assert sent_messages[0]["params"]["tool_name"] == "worktree_list"
    assert sent_messages[0]["params"]["arguments"] == {}


def test_electron_tool_bridge_strips_path_metadata_from_malformed_electron_results() -> None:
    long_title = "T" * 25_000
    long_file_name = "f" * 25_000

    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> dict[str, object]:
            return {
                "jsonrpc": "2.0",
                "id": expected_id,
                "result": {
                    "tool_name": "worktree_list",
                    "output": "1 worktree found.",
                    "success": True,
                    "generated_artifacts": [
                        {
                            "artifact_id": "artifact_image_unsafe",
                            "artifact_kind": "image",
                            "title": long_title,
                            "file_name": long_file_name,
                            "display_path": ".jenny/artifacts/session/unsafe.png",
                            "absolute_path": "C:/Users/Alice/secret.png",
                            "local_path_hint": "C:/Users/Alice/secret.png",
                            "width": "11.8",
                            "height": "bad",
                            "editable": True,
                            "status": "S" * 25_000,
                        },
                        {
                            "artifact_id": "artifact_image_bad_display",
                            "artifact_kind": "image",
                            "title": "Bad Display",
                            "file_name": "bad-display.png",
                            "display_path": "C:/Users/Alice/bad-display.png",
                            "absolute_path": "C:/Users/Alice/bad-display.png",
                        }
                    ],
                    "metadata": {
                        "result_kind": "worktree_list",
                        "generatedArtifacts": [{"absolute_path": "C:/Users/Alice/secret.png"}],
                        "absolute_path": "C:/Users/Alice/secret.png",
                    },
                },
            }

        return read_response

    result = execute_electron_tool(ElectronToolBridgeRequest(
        tool_name="worktree_list",
        arguments={},
        request_id="req_browser",
        trace_id="trace_browser",
        session_id="session_browser",
        tool_call_id="call_browser",
        write_message=lambda _message: None,
        read_message=None,
        response_reader_factory=response_reader_factory,
        timeout_seconds=1.0,
        logger=None,
    ))

    assert result.success is True
    assert len(result.generated_artifacts) == 1
    assert len(result.generated_artifacts[0]["title"]) == 20_000
    assert len(result.generated_artifacts[0]["file_name"]) == 20_000
    assert result.generated_artifacts[0]["width"] == 11
    assert result.generated_artifacts[0]["height"] == 0
    assert result.generated_artifacts[0]["editable"] is False
    assert len(result.generated_artifacts[0]["status"]) == 20_000
    assert "absolute_path" not in result.generated_artifacts[0]
    assert "local_path_hint" not in result.generated_artifacts[0]
    assert "generatedArtifacts" not in result.metadata
    assert "absolute_path" not in result.metadata


def test_electron_tool_bridge_fails_closed_for_malformed_result() -> None:
    sent_messages: list[dict[str, object]] = []

    def write_message(message: dict[str, object]) -> None:
        sent_messages.append(message)

    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> dict[str, object]:
            return {"jsonrpc": "2.0", "id": expected_id, "result": {}}

        return read_response

    result = execute_electron_tool(ElectronToolBridgeRequest(
        tool_name="worktree_list",
        arguments={},
        request_id="req_browser",
        trace_id="trace_browser",
        session_id="session_browser",
        tool_call_id="call_browser",
        write_message=write_message,
        read_message=None,
        response_reader_factory=response_reader_factory,
        timeout_seconds=1.0,
        logger=None,
    ))

    assert result.success is False
    assert result.error_code == "CMP-TOOL-0008"
    assert "success flag" in result.output
    assert sent_messages[0]["method"] == "tool.execute_electron"


def test_electron_tool_bridge_registers_before_write_and_closes_waiter() -> None:
    registered = False
    closed = False
    expected_response: dict[str, object] = {}

    def response_reader_factory(expected_id: int, **_kwargs: object):
        nonlocal registered
        registered = True
        expected_response.update({
            "jsonrpc": "2.0",
            "id": expected_id,
            "result": {"tool_name": "worktree_list", "output": "ok", "success": True},
        })

        def read_response(_timeout_seconds: float) -> dict[str, object]:
            return expected_response

        def close() -> None:
            nonlocal closed
            closed = True
            raise RuntimeError("close failed")

        read_response.close = close  # type: ignore[attr-defined]
        return read_response

    def write_message(_message: dict[str, object]) -> None:
        assert registered is True

    result = execute_electron_tool(ElectronToolBridgeRequest(
        tool_name="worktree_list",
        arguments={},
        request_id="req_browser",
        trace_id="trace_browser",
        session_id="session_browser",
        tool_call_id="call_browser",
        write_message=write_message,
        read_message=None,
        response_reader_factory=response_reader_factory,
        timeout_seconds=1.0,
        logger=None,
    ))

    assert result.success is True
    assert closed is True


def test_electron_tool_bridge_rejects_non_dict_responses() -> None:
    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> list[object]:
            return ["not", "a", "json-rpc", expected_id]

        return read_response

    with pytest.raises(MCPError) as exc_info:
        execute_electron_tool(ElectronToolBridgeRequest(
            tool_name="worktree_list",
            arguments={},
            request_id="req_browser",
            trace_id="trace_browser",
            session_id="session_browser",
            tool_call_id="call_browser",
            write_message=lambda _message: None,
            read_message=None,
            response_reader_factory=response_reader_factory,
            timeout_seconds=1.0,
            logger=None,
        ))

    assert exc_info.value.code == CMP_TOOL_EXECUTION_FAILED
    assert "malformed response" in exc_info.value.message
    assert exc_info.value.retryable is False


def test_preview_test_tool_requires_flag_and_electron_bridge(tmp_path) -> None:
    """W8-S4: preview_test is an electron-bridge workspace tool behind its flag."""
    enabled = _kernel(
        RuntimeConfig(
            tools_preview_test_enabled=True,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    available = tool_resolution.assemble_tool_contract(
        enabled,
        request_context=_request_context(tmp_path),
    )
    assert "preview_test" in set(available.available_names)
    assert available.entry("preview_test").descriptor.server_name == "electron_tool_bridge"
    assert available.entry("preview_test").descriptor.tool_family == "workspace"
    assert available.entry("preview_test").descriptor.side_effecting is False

    without_flag = _kernel(
        RuntimeConfig(
            tools_preview_test_enabled=False,
            electron_tool_bridge_enabled=True,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    disabled = tool_resolution.assemble_tool_contract(
        without_flag,
        request_context=_request_context(tmp_path),
    )
    assert "preview_test" not in set(disabled.available_names)

    without_bridge = _kernel(
        RuntimeConfig(
            tools_preview_test_enabled=True,
            electron_tool_bridge_enabled=False,
            tools_workspace_root=str(tmp_path),
            mode="assist",
        )
    )
    unavailable = tool_resolution.assemble_tool_contract(
        without_bridge,
        request_context=_request_context(tmp_path),
    )
    assert "preview_test" not in set(unavailable.available_names)
