"""Headless approval-path e2e over the real replay engine + tool loop.

The owner "oneshot" demo in test form: a scripted side-effecting
``write_file`` call runs end-to-end with zero approval round-trips when the
blanket auto-approve rule is present in the tool-policy snapshot, and still
requests approval when it is absent or paranoid safety mode is on. A second
scenario pins read-snapshot continuity across an approval resume. The engine
is the real ``ReplayEngine`` and the loop/policy/approval machinery is all
real; only the tool transport is a stub MCP client (production routes builtins
over a stdio MCP subprocess), and it performs actual file I/O so the side
effect stays observable. No GPU, no GUI.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import (
    RuntimeConfig,
    ToolPolicyRule,
    ToolPolicyRuleMatch,
    ToolPolicySnapshot,
)
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.engines.replay import ReplayEngine
from sidecar.ai.mcp.models import MCPToolDescriptor, MCPToolResult
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.builtins.artifacts import create_artifact_tool
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.chat import resume_chat_send_response_from_approval_plan

_WRITE_CONTENT = "hello from replay"


class _FileMCPClient:
    """Stub transport for ``read_file`` and ``write_file`` descriptors.

    ``execute_tool`` really writes the file into the workspace so the tests
    can assert the side effect happened (blanket ON) or did not (approval
    pending / paranoid).
    """

    def __init__(self, workspace: Path) -> None:
        self._workspace = workspace
        self.last_write_arguments: dict[str, Any] | None = None
        self._write_descriptor = MCPToolDescriptor(
            name="write_file",
            description="Write UTF-8 content to a file.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
            side_effecting=True,
            server_name="tools",
            tool_family="filesystem",
        )
        self._read_descriptor = MCPToolDescriptor(
            name="read_file",
            description="Read UTF-8 content from a file.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            side_effecting=False,
            server_name="tools",
            tool_family="filesystem",
        )

    @property
    def available_tools(self) -> list[MCPToolDescriptor]:
        return [self._read_descriptor, self._write_descriptor]

    def tool_descriptor(self, tool_name: str) -> MCPToolDescriptor | None:
        normalized = str(tool_name or "").strip()
        if normalized == "read_file":
            return self._read_descriptor
        if normalized == "write_file":
            return self._write_descriptor
        return None

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: object = None,
    ) -> MCPToolResult:
        _ = (timeout_seconds, cancel_handle)
        target = self._workspace / str(arguments["path"])
        if tool_name == "read_file":
            raw = target.read_bytes()
            stat = target.stat()
            snapshot = {
                "path": str(arguments["path"]),
                "scope": "full",
                "size_bytes": len(raw),
                "mtime_ns": stat.st_mtime_ns,
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
            return MCPToolResult(
                tool_name=tool_name,
                output=raw.decode("utf-8"),
                success=True,
                metadata={
                    "path": str(arguments["path"]),
                    "read_snapshot": snapshot,
                },
            )
        assert tool_name == "write_file"
        self.last_write_arguments = dict(arguments)
        target.write_text(str(arguments["content"]), encoding="utf-8")
        return MCPToolResult(
            tool_name=tool_name,
            output=json.dumps({"ok": True, "path": str(arguments["path"])}),
            success=True,
        )


class _ArtifactMCPClient(_FileMCPClient):
    def __init__(self, workspace: Path) -> None:
        super().__init__(workspace)
        self.execute_count = 0
        self.last_artifact_arguments: dict[str, Any] | None = None
        self._artifact_descriptor = MCPToolDescriptor(
            name="create_artifact",
            description="Create a session-scoped scratch artifact.",
            input_schema={
                "type": "object",
                "properties": {
                    "artifact_kind": {"type": "string"},
                    "title": {"type": "string"},
                    "content": {"type": "string"},
                    "file_name": {"type": "string"},
                    "language": {"type": "string"},
                    "extension": {"type": "string"},
                },
                "required": ["artifact_kind", "title", "content"],
            },
            side_effecting=True,
            server_name="tools",
            source_kind="builtin",
            tool_family="artifact",
        )

    @property
    def available_tools(self) -> list[MCPToolDescriptor]:
        return [self._read_descriptor, self._artifact_descriptor]

    def tool_descriptor(self, tool_name: str) -> MCPToolDescriptor | None:
        if tool_name == "create_artifact":
            return self._artifact_descriptor
        return super().tool_descriptor(tool_name)

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: object = None,
    ) -> MCPToolResult:
        _ = timeout_seconds, cancel_handle
        if tool_name == "read_file":
            return super().execute_tool(tool_name, arguments)
        assert tool_name == "create_artifact"
        self.execute_count += 1
        self.last_artifact_arguments = dict(arguments)
        result = create_artifact_tool(arguments, WorkspaceGuard(str(self._workspace)))
        return MCPToolResult(
            tool_name=tool_name,
            output=result.output,
            success=result.success,
            generated_artifacts=result.generated_artifacts,
            error_code=result.error_code,
            metadata=result.metadata,
        )


def _blanket_snapshot() -> ToolPolicySnapshot:
    return ToolPolicySnapshot(
        rules=(
            ToolPolicyRule(
                id="blanket_auto_approve",
                decision="auto",
                reason="Blanket auto-approve enabled by owner",
                match=ToolPolicyRuleMatch(),
            ),
        ),
    )


def _write_file_script(tmp_path: Path) -> str:
    script = {
        "version": 1,
        "delay_ms": 0,
        "calls": [
            {
                "text": "Writing the file now.",
                "tool_calls": [
                    {
                        "tool_id": "write_file",
                        "arguments": {"path": "notes.md", "content": _WRITE_CONTENT},
                    }
                ],
            },
            {"text": "All done - notes.md is saved."},
        ],
    }
    script_path = tmp_path / "write-file-script.json"
    script_path.write_text(json.dumps(script), encoding="utf-8")
    return str(script_path)


def _read_then_write_file_script(tmp_path: Path) -> str:
    script = {
        "version": 1,
        "delay_ms": 0,
        "calls": [
            {
                "text": "Reading before updating the file.",
                "tool_calls": [
                    {
                        "tool_id": "read_file",
                        "arguments": {"path": "notes.md"},
                    }
                ],
            },
            {
                "text": "Updating the file after reading it.",
                "tool_calls": [
                    {
                        "tool_id": "write_file",
                        "arguments": {"path": "notes.md", "content": _WRITE_CONTENT},
                    }
                ],
            },
            {"text": "All done - notes.md is updated."},
        ],
    }
    script_path = tmp_path / "read-write-file-script.json"
    script_path.write_text(json.dumps(script), encoding="utf-8")
    return str(script_path)


def _create_artifact_script(tmp_path: Path) -> str:
    script = {
        "version": 1,
        "delay_ms": 0,
        "calls": [
            {
                "text": "Reading the plan context.",
                "tool_calls": [
                    {
                        "tool_id": "read_file",
                        "arguments": {"path": "plan-context.txt"},
                    }
                ],
            },
            {
                "text": "Creating the plan artifact.",
                "tool_calls": [
                    {
                        "tool_id": "create_artifact",
                        "arguments": {
                            "artifact_kind": "document",
                            "title": "Approval Plan",
                            "content": "# Approved plan\n",
                            "file_name": "approval-plan.md",
                            "language": "markdown",
                            "extension": ".md",
                        },
                    }
                ],
            },
            {"text": "The plan artifact is ready."},
        ],
    }
    script_path = tmp_path / "create-artifact-script.json"
    script_path.write_text(json.dumps(script), encoding="utf-8")
    return str(script_path)


def _multi_call_artifact_script(tmp_path: Path) -> str:
    script = {
        "version": 1,
        "delay_ms": 0,
        "calls": [
            {
                "text": "Reading context and creating the plan artifact.",
                "tool_calls": [
                    {
                        "tool_id": "read_file",
                        "arguments": {"path": "plan-context.txt"},
                    },
                    {
                        "tool_id": "create_artifact",
                        "arguments": {
                            "artifact_kind": "document",
                            "title": "Multi-call Plan",
                            "content": "# Multi-call plan\n",
                            "file_name": "multi-call-plan.md",
                            "language": "markdown",
                            "extension": ".md",
                        },
                    },
                ],
            },
            {"text": "The read result was received."},
            {"text": "The multi-call plan artifact is ready."},
        ],
    }
    script_path = tmp_path / "multi-call-artifact-script.json"
    script_path.write_text(json.dumps(script), encoding="utf-8")
    return str(script_path)


def _unsafe_artifact_script(
    tmp_path: Path,
    *,
    language: str,
    extension: str,
    content: str,
) -> str:
    script = {
        "version": 1,
        "delay_ms": 0,
        "calls": [
            {
                "text": "Attempting an executable artifact.",
                "tool_calls": [
                    {
                        "tool_id": "create_artifact",
                        "arguments": {
                            "artifact_kind": "document",
                            "title": "Unsafe payload",
                            "content": content,
                            "file_name": f"payload{extension}",
                            "language": language,
                            "extension": extension,
                        },
                    }
                ],
            },
            {"text": "Done."},
        ],
    }
    script_path = tmp_path / f"unsafe-{language}-artifact-script.json"
    script_path.write_text(json.dumps(script), encoding="utf-8")
    return str(script_path)


def _build_replay_router(
    tmp_path: Path,
    *,
    snapshot: ToolPolicySnapshot | None,
    safety_mode: str = "normal",
    script_path: str | None = None,
) -> ChatRouter:
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    config = RuntimeConfig(
        engine_type="replay",
        model="replay-default",
        mode="assist",
        safety_mode=safety_mode,
        tools_workspace_root=str(workspace),
        tools_confirm_side_effects=True,
        tool_policy_snapshot=snapshot,
    )
    engine = ReplayEngine(script_path=script_path or _write_file_script(tmp_path), delay_ms=0)
    engine.load_model("replay-default")
    return ChatRouter(
        config=config,
        engine=engine,
        mcp_client=_FileMCPClient(workspace),  # type: ignore[arg-type]
        context_builder=ContextBuilder(None),
    )


def _build_artifact_router(
    tmp_path: Path,
    *,
    script_path: str | None = None,
    snapshot: ToolPolicySnapshot | None = None,
    safety_mode: str = "paranoid",
) -> ChatRouter:
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    (workspace / "plan-context.txt").write_text("plan context", encoding="utf-8")
    if snapshot is None:
        snapshot = ToolPolicySnapshot(
            rules=(
                ToolPolicyRule(
                    id="ask-plan-artifact",
                    decision="ask",
                    reason="Review plan artifact writes",
                    match=ToolPolicyRuleMatch(tool_id="create_artifact"),
                ),
            ),
        )
    config = RuntimeConfig(
        engine_type="replay",
        model="replay-default",
        mode="assist",
        safety_mode=safety_mode,
        tools_workspace_root=str(workspace),
        tools_confirm_side_effects=True,
        tool_policy_snapshot=snapshot,
    )
    engine = ReplayEngine(
        script_path=script_path or _create_artifact_script(tmp_path),
        delay_ms=0,
    )
    engine.load_model("replay-default")
    return ChatRouter(
        config=config,
        engine=engine,
        mcp_client=_ArtifactMCPClient(workspace),  # type: ignore[arg-type]
        context_builder=ContextBuilder(None),
    )


def _run_oneshot(router: ChatRouter, request_id: str) -> Any:
    # approvals_pre_granted=False is the real first-send posture: Electron only
    # flips it per-call after an approval round-trip, so this is exactly the
    # state in which the blanket rule must remove the prompt.
    prompt = "Create notes.md with a short greeting."
    return router.build_chat_decision(
        request_id=request_id,
        messages=[{"role": "user", "content": prompt}],
        latest_user_content=prompt,
        mode="assist",
        approvals_pre_granted=False,
    )


def test_blanket_auto_approve_oneshots_side_effecting_write(tmp_path) -> None:
    router = _build_replay_router(tmp_path, snapshot=_blanket_snapshot())

    decision = _run_oneshot(router, "req_replay_blanket_on")

    assert decision.approval_request is None
    written = tmp_path / "workspace" / "notes.md"
    assert written.read_text(encoding="utf-8") == _WRITE_CONTENT
    write_outcomes = [
        outcome for outcome in decision.tool_results if outcome.tool_name == "write_file"
    ]
    assert len(write_outcomes) == 1
    assert write_outcomes[0].success is True
    assert "notes.md is saved" in decision.response_text


def test_without_blanket_rule_side_effecting_write_requests_approval(tmp_path) -> None:
    router = _build_replay_router(tmp_path, snapshot=ToolPolicySnapshot.empty())

    decision = _run_oneshot(router, "req_replay_blanket_off")

    assert decision.approval_request is not None
    assert decision.approval_request.tool_name == "write_file"
    assert not (tmp_path / "workspace" / "notes.md").exists()


def test_paranoid_safety_mode_still_prompts_despite_blanket(tmp_path) -> None:
    router = _build_replay_router(
        tmp_path,
        snapshot=_blanket_snapshot(),
        safety_mode="paranoid",
    )

    decision = _run_oneshot(router, "req_replay_blanket_paranoid")

    assert decision.approval_request is not None
    assert decision.approval_request.tool_name == "write_file"
    assert not (tmp_path / "workspace" / "notes.md").exists()


def test_same_turn_read_snapshot_survives_approval_resume(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "notes.md"
    target.write_text("before approval", encoding="utf-8")
    router = _build_replay_router(
        tmp_path,
        snapshot=ToolPolicySnapshot.empty(),
        script_path=_read_then_write_file_script(tmp_path),
    )
    prompt = "Read notes.md, then update it with a short greeting."
    messages = [{"role": "user", "content": prompt}]

    decision = router.build_chat_decision(
        request_id="req_replay_read_write_approval",
        messages=messages,
        latest_user_content=prompt,
        mode="assist",
        approvals_pre_granted=False,
    )

    assert decision.approval_request is not None
    assert decision.approval_plan is not None
    assert [outcome.tool_name for outcome in decision.approval_plan.outcomes] == ["read_file"]
    assert [outcome.tool_name for outcome in decision.approval_plan.outcomes] == ["read_file"]
    frozen_write = decision.approval_plan.frozen_input_for_call(
        str(decision.approval_plan.approved_call_id)
    )
    assert frozen_write is not None
    assert "expected_read_snapshot" in frozen_write.effective_tool_arguments
    assert target.read_text(encoding="utf-8") == "before approval"
    client = router._mcp_client
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=router._config,
            engine=router._engine,
            router=router,
            tool_observations=None,
        ),
        subprocess_manager=None,
    )

    response = resume_chat_send_response_from_approval_plan(
        decision.approval_plan,
        brain_container=brain_container,
        live_params={"messages": messages},
        canonical_session_messages=[],
    )

    assert response.result["status"] == "completed"
    assert target.read_text(encoding="utf-8") == _WRITE_CONTENT
    assert isinstance(client, _FileMCPClient)
    assert client.last_write_arguments is not None
    assert client.last_write_arguments["expected_read_snapshot"] == (
        decision.approval_plan.read_snapshot_cache["notes.md"]
    )


def test_plan_artifact_approval_survives_live_mode_toggle_and_writes_once(tmp_path) -> None:
    router = _build_artifact_router(tmp_path, safety_mode="normal")
    prompt = "Create an inert Markdown plan artifact."
    messages = [{"role": "user", "content": prompt}]

    decision = router.build_chat_decision(
        request_id="req-plan-artifact-approval",
        session_id="session-plan-artifact",
        messages=messages,
        latest_user_content=prompt,
        mode="assist",
        plan_mode=True,
        approvals_pre_granted=False,
    )

    assert decision.approval_request is not None
    assert decision.approval_plan is not None
    artifact_root = tmp_path / "workspace" / ".jenny" / "artifacts"
    assert not artifact_root.exists()
    client = router._mcp_client
    assert isinstance(client, _ArtifactMCPClient)
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=router._config,
            engine=router._engine,
            router=router,
            tool_observations=None,
        ),
        subprocess_manager=None,
    )

    response = resume_chat_send_response_from_approval_plan(
        decision.approval_plan,
        brain_container=brain_container,
        live_params={"messages": messages, "plan_mode": False, "read_only": False},
        canonical_session_messages=[],
    )

    assert response.result["status"] == "completed"
    assert client.execute_count == 1
    written = list(artifact_root.rglob("approval-plan*.md"))
    assert len(written) == 1
    assert written[0].read_text(encoding="utf-8") == "# Approved plan\n"
    assert client.last_artifact_arguments is not None
    assert "_jenny_plan_artifact_write" not in client.last_artifact_arguments
    assert "_jenny_plan_artifact_write" not in json.dumps(response.notifications)


def test_multi_call_plan_resumes_artifact_without_plan_drift(tmp_path) -> None:
    router = _build_artifact_router(
        tmp_path,
        script_path=_multi_call_artifact_script(tmp_path),
        safety_mode="normal",
    )
    prompt = "Read the context and create an inert Markdown plan artifact."
    messages = [{"role": "user", "content": prompt}]

    decision = router.build_chat_decision(
        request_id="req-multi-call-plan-artifact",
        session_id="session-multi-call-plan-artifact",
        messages=messages,
        latest_user_content=prompt,
        mode="assist",
        plan_mode=True,
        approvals_pre_granted=False,
    )

    assert decision.approval_request is not None
    assert decision.approval_plan is not None
    assert [call.tool_id for call in decision.approval_plan.tool_calls] == [
        "read_file",
        "create_artifact",
    ]
    artifact_input = next(
        frozen
        for frozen in decision.approval_plan.frozen_inputs
        if frozen.tool_name == "create_artifact"
    )
    assert artifact_input.effective_tool_arguments["_jenny_plan_artifact_write"] is True
    client = router._mcp_client
    assert isinstance(client, _ArtifactMCPClient)
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=router._config,
            engine=router._engine,
            router=router,
            tool_observations=None,
        ),
        subprocess_manager=None,
    )

    response = resume_chat_send_response_from_approval_plan(
        decision.approval_plan,
        brain_container=brain_container,
        live_params={"messages": messages, "plan_mode": False, "read_only": False},
        canonical_session_messages=[],
    )

    assert response.result["status"] == "completed"
    assert response.result.get("terminal_subcode") != "plan_drift"
    assert client.execute_count == 1
    artifact_root = tmp_path / "workspace" / ".jenny" / "artifacts"
    assert len(list(artifact_root.rglob("multi-call-plan*.md"))) == 1


@pytest.mark.parametrize(
    ("language", "extension", "content"),
    [
        ("html", ".html", "<script>globalThis.pwned = true</script>"),
        ("svg", ".svg", '<svg onload="globalThis.pwned=true"><script>pwned()</script></svg>'),
    ],
)
def test_plan_mode_script_bearing_documents_never_reach_artifact_writer(
    tmp_path,
    language: str,
    extension: str,
    content: str,
) -> None:
    router = _build_artifact_router(
        tmp_path,
        script_path=_unsafe_artifact_script(
            tmp_path,
            language=language,
            extension=extension,
            content=content,
        ),
        snapshot=ToolPolicySnapshot.empty(),
        safety_mode="normal",
    )
    prompt = "Create the requested artifact."

    router.build_chat_decision(
        request_id=f"req-unsafe-{language}",
        session_id=f"session-unsafe-{language}",
        messages=[{"role": "user", "content": prompt}],
        latest_user_content=prompt,
        mode="assist",
        plan_mode=True,
        approvals_pre_granted=False,
    )

    client = router._mcp_client
    assert isinstance(client, _ArtifactMCPClient)
    assert client.execute_count == 0
    assert not (tmp_path / "workspace" / ".jenny" / "artifacts").exists()
