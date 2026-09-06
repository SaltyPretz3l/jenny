"""Orchestration-path coverage for ``sidecar.ai.routing.tool_execution.execute_tool``.

The sibling ``test_tool_execution_security.py`` covers the policy/approval gate
(``approval_if_needed``); this file covers the *dispatch* orchestration that the
security tests never reach: the happy path, failure classification (MCPError vs.
generic exception), synthetic-tool routing (inspect_harness / monitor /
delegate), the blocked-contract-entry short circuit, cancellation, and the
runtime wall-clock timeout helper.

Test-only. Models the stub-router/runtime pattern on
``test_monitor_tool_execution.py`` and a recording executor + observation store
so the per-transition audit events can be asserted directly.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.routing import tool_execution as _tool_execution_module
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.resource_pressure import PressureBackoffDecision
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_retry import (
    collect_validation_errors,
    evaluate_reflexive_retry,
)
from sidecar.ai.routing.tool_execution import (
    _coerce_tool_failure_code,
    _tool_timeout_for_runtime,
    assert_valid_tool_call,
    execute_tool,
    execute_tool_search,
)
from sidecar.ai.routing.tool_observation import (
    KIND_TOOL_EXECUTION_FAILED,
    KIND_TOOL_EXECUTION_OBSERVED,
    KIND_TOOL_EXECUTION_STARTED,
    ToolObservationStore,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.tool_execution_support import CMP_LOOP_TOOL_INPUT_VALIDATION, MCPError

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

REQUEST_ID = "req-orch-1"
SESSION_ID = "sess-orch-1"


@pytest.fixture(autouse=True)
def _no_resource_pressure(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pin the host-load seam: these tests assert exact audit-event sequences,
    # and genuine system pressure during a heavy CI wave injects a
    # tool_pressure_backoff audit + sleep that has nothing to do with the
    # dispatch orchestration under test.
    monkeypatch.setattr(
        _tool_execution_module,
        "build_tool_pressure_backoff_decision",
        lambda **_kwargs: PressureBackoffDecision(
            should_backoff=False,
            delay_seconds=0.0,
            severity="none",
            warnings=(),
            snapshot={},
        ),
    )


class _Contract:
    """Tool contract that exposes a single descriptor, optionally blocked."""

    def __init__(self, descriptor: object, *, available: bool = True, reason: str = "") -> None:
        self._descriptor = descriptor
        self._available = available
        self._reason = reason

    def entry(self, tool_name: str) -> object | None:
        if tool_name != getattr(self._descriptor, "name", ""):
            return None
        return SimpleNamespace(
            available=self._available,
            descriptor=self._descriptor,
            reason=self._reason,
        )


def _descriptor(
    name: str,
    *,
    side_effecting: bool = False,
    server_name: str = "tools",
) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        side_effecting=side_effecting,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="mcp",
        tool_family="filesystem",
        server_name=server_name,
    )


class _RecordingMCPClient:
    """Records execute_tool dispatch and returns a canned result or raises."""

    def __init__(
        self,
        descriptor: SimpleNamespace,
        *,
        result: Any | None = None,
        raises: BaseException | None = None,
    ) -> None:
        self._descriptor = descriptor
        self._result = result
        self._raises = raises
        self.calls: list[tuple[str, dict[str, Any], float | None, Any]] = []

    def tool_descriptor(self, tool_name: str) -> SimpleNamespace | None:
        if tool_name != self._descriptor.name:
            return None
        return self._descriptor

    def execute_tool(
        self,
        tool_id: str,
        tool_arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> Any:
        self.calls.append((tool_id, dict(tool_arguments), timeout_seconds, cancel_handle))
        if self._raises is not None:
            raise self._raises
        return self._result


def _kernel(
    mcp_client: _RecordingMCPClient,
    *,
    config: RuntimeConfig | None = None,
    monitor_manager: Any = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        _config=config or RuntimeConfig(),
        _mcp_client=mcp_client,
        _monitor_manager=monitor_manager,
    )


def _runtime() -> tuple[LoopRuntime, ToolObservationStore]:
    store = ToolObservationStore()
    store.ensure_turn(request_id=REQUEST_ID)
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        trace_id="trace-orch-1",
        session_id=SESSION_ID,
        observation_store=store,
    )
    return runtime, store


def _audit_kinds(store: ToolObservationStore) -> list[str]:
    return [event.kind for event in store.recent_events(request_id=REQUEST_ID, limit=50)]


def _audit_last_error_code(store: ToolObservationStore) -> str | None:
    """Return the error_code of the last recorded audit event."""
    events = store.recent_events(request_id=REQUEST_ID, limit=50)
    if not events:
        return None
    return events[-1].error_code


def _mcp_result(tool_name: str = "read_file", *, success: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        tool_name=tool_name,
        output="file body",
        success=success,
        content_type="text/plain",
        ui_payload=None,
        generated_artifacts=(),
        error_code=None if success else "cmp.tool.bad",
        metadata={"path": "README.md"},
    )


# ---------------------------------------------------------------------------
# Happy path + audit trail
# ---------------------------------------------------------------------------


def test_execute_tool_success_dispatches_and_audits_observed() -> None:
    descriptor = _descriptor("read_file")
    client = _RecordingMCPClient(descriptor, result=_mcp_result(success=True))
    kernel = _kernel(client)
    runtime, store = _runtime()

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}, call_id="c1"),
        request_id=REQUEST_ID,
        session_id=SESSION_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        audit_metadata={"audit_key": "audit_val"},
        runtime=runtime,
    )

    assert outcome.success is True
    assert outcome.tool_name == "read_file"
    assert outcome.output == "file body"
    # audit_metadata merged on top of the MCP result metadata
    assert outcome.metadata["audit_key"] == "audit_val"
    assert outcome.metadata["path"] == "README.md"
    # one dispatch with the configured 120s timeout (no wall-clock deadline)
    assert len(client.calls) == 1
    assert client.calls[0][0] == "read_file"
    assert client.calls[0][2] == 120.0
    assert client.calls[0][3] is runtime.cancel_handle
    assert _audit_kinds(store) == [KIND_TOOL_EXECUTION_STARTED, KIND_TOOL_EXECUTION_OBSERVED]


def test_execute_tool_injects_authoritative_read_only_only_into_mermaid_dispatch() -> None:
    descriptor = _descriptor("mermaid_generate")
    client = _RecordingMCPClient(
        descriptor,
        result=_mcp_result(tool_name="mermaid_generate", success=True),
    )
    kernel = _kernel(client)
    runtime, _store = _runtime()
    runtime.request_context = SimpleNamespace(read_only=True)
    arguments = {"prompt": "graph TD\nA --> B", "diagram_type": "flowchart"}

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id="mermaid_generate", arguments=arguments, call_id="c-mermaid"),
        request_id=REQUEST_ID,
        session_id=SESSION_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    assert client.calls[0][1]["_jenny_read_only"] is True
    assert client.calls[0][1]["_jenny_session_id"] == SESSION_ID
    assert outcome.tool_input == arguments
    assert "_jenny_read_only" not in outcome.tool_input


def test_execute_tool_reuses_frozen_plan_capability_before_mermaid_dispatch() -> None:
    descriptor = _descriptor("mermaid_generate")
    descriptor.availability = SimpleNamespace(plan_mode_artifact_write=True)
    client = _RecordingMCPClient(
        descriptor,
        result=_mcp_result(tool_name="mermaid_generate", success=True),
    )
    kernel = _kernel(client)
    runtime, _store = _runtime()
    runtime.request_context = SimpleNamespace(plan_mode=False, read_only=True)
    arguments = {"prompt": "flowchart TD\nA --> B"}

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id="mermaid_generate", arguments=arguments, call_id="c-plan"),
        request_id=REQUEST_ID,
        session_id=SESSION_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        trusted_plan_artifact_write=True,
        runtime=runtime,
    )

    dispatched = client.calls[0][1]
    assert dispatched["_jenny_read_only"] is False
    assert "_jenny_plan_artifact_write" not in dispatched
    assert "_jenny_plan_artifact_write" not in outcome.tool_input


@pytest.mark.parametrize("tool_name", ["todo_read", "todo_write"])
def test_execute_tool_injects_approved_plan_only_into_todo_read_dispatch(
    tool_name: str,
) -> None:
    descriptor = _descriptor(tool_name)
    client = _RecordingMCPClient(descriptor, result=_mcp_result(tool_name=tool_name))
    kernel = _kernel(client)
    runtime, _store = _runtime()
    approved_plan = {"title": "Plan", "steps": ["A"], "summary": "Summary"}
    runtime.request_context = SimpleNamespace(approved_plan=approved_plan)

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id=tool_name, arguments={}, call_id=f"c-{tool_name}"),
        request_id=REQUEST_ID,
        session_id=SESSION_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    dispatched_arguments = client.calls[0][1]
    if tool_name == "todo_read":
        assert dispatched_arguments["_jenny_approved_plan"] == approved_plan
    else:
        assert "_jenny_approved_plan" not in dispatched_arguments
    assert "_jenny_approved_plan" not in outcome.tool_input


def test_execute_tool_unsuccessful_result_audits_failed_without_raising() -> None:
    descriptor = _descriptor("read_file")
    client = _RecordingMCPClient(descriptor, result=_mcp_result(success=False))
    kernel = _kernel(client)
    runtime, store = _runtime()

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}, call_id="c1"),
        request_id=REQUEST_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    assert outcome.success is False
    assert outcome.error_code == "cmp.tool.bad"
    assert _audit_kinds(store) == [KIND_TOOL_EXECUTION_STARTED, KIND_TOOL_EXECUTION_FAILED]


def test_execute_tool_success_without_runtime_skips_audit() -> None:
    descriptor = _descriptor("read_file")
    client = _RecordingMCPClient(descriptor, result=_mcp_result(success=True))
    kernel = _kernel(client)

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}, call_id="c1"),
        request_id=REQUEST_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=None,
    )

    assert outcome.success is True
    assert len(client.calls) == 1
    # No runtime -> the configured timeout is used verbatim.
    assert client.calls[0][2] == 120.0


# ---------------------------------------------------------------------------
# Failure classification
# ---------------------------------------------------------------------------


def test_execute_tool_mcp_error_preserves_valid_structured_code() -> None:
    descriptor = _descriptor("read_file")
    # A genuine structured CMP code is preserved verbatim (CMP-MCP-* already
    # classifies as a tool failure in the renderer). retryable=False distinguishes
    # genuine pass-through (source propagates error.retryable) from a hardcode —
    # a True stub cannot catch a hardcode.
    client = _RecordingMCPClient(
        descriptor,
        raises=MCPError(code="CMP-MCP-0004", message="upstream exploded", retryable=False),
    )
    kernel = _kernel(client)
    runtime, store = _runtime()

    with pytest.raises(ToolExecutionFailure) as excinfo:
        execute_tool(
            kernel,
            ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="c1"),
            request_id=REQUEST_ID,
            read_snapshot_cache={},
            tool_contract=_Contract(descriptor),
            runtime=runtime,
        )

    # The MCPError-specific branch preserves the original structured code (not the
    # generic CMP_TOOL_EXECUTION_FAILED code used by the bare-Exception branch).
    assert excinfo.value.code == "CMP-MCP-0004"
    # retryable is passed through from the MCPError, not hardcoded.
    assert excinfo.value.retryable is False
    assert "upstream exploded" in excinfo.value.message
    kinds = _audit_kinds(store)
    assert kinds[0] == KIND_TOOL_EXECUTION_STARTED
    assert kinds[-1] == KIND_TOOL_EXECUTION_FAILED
    assert _audit_last_error_code(store) == "CMP-MCP-0004"


@pytest.mark.parametrize(
    "raw_code",
    [
        "cmp.mcp.boom",
        "weird_runtime_error",
        "",
        "CMP-mixed-0001",
        "CMP-AI-0002",  # wrong-domain CMP family (not tool-recoverable)
        "CMP-FOO-0001",  # well-formed but unknown family
    ],
)
def test_execute_tool_mcp_error_uncoded_defaults_to_tool_subcode(raw_code: str) -> None:
    # An MCPError carrying a blank, non-structured, or wrong-domain code (as a
    # runtime MCP server or the Electron bridge can pass through verbatim) must
    # NOT reach the chat error path with a code outside the tool-recoverable
    # families — it is normalised to CMP-TOOL-0008 so the renderer classifies it
    # as a recoverable tool failure, not a generic "Turn failed".
    descriptor = _descriptor("read_file")
    client = _RecordingMCPClient(
        descriptor,
        raises=MCPError(code=raw_code, message="upstream exploded", retryable=True),
    )
    kernel = _kernel(client)
    runtime, store = _runtime()

    with pytest.raises(ToolExecutionFailure) as excinfo:
        execute_tool(
            kernel,
            ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="c1"),
            request_id=REQUEST_ID,
            read_snapshot_cache={},
            tool_contract=_Contract(descriptor),
            runtime=runtime,
        )

    assert excinfo.value.code == CMP_TOOL_EXECUTION_FAILED
    assert excinfo.value.code.startswith("CMP-TOOL-")
    # retryable still passes through from the MCPError untouched.
    assert excinfo.value.retryable is True
    # The audited error_code is the coerced subcode, not the raw passthrough.
    assert _audit_last_error_code(store) == CMP_TOOL_EXECUTION_FAILED


def test_execute_tool_generic_exception_carries_tool_subcode() -> None:
    # Direct guard on the ITEM-2 contract: an unhandled bare Exception from a tool
    # yields a failure whose code starts with "CMP-TOOL-".
    descriptor = _descriptor("read_file")
    client = _RecordingMCPClient(descriptor, raises=Exception("bare boom"))
    kernel = _kernel(client)
    runtime, _store = _runtime()

    with pytest.raises(ToolExecutionFailure) as excinfo:
        execute_tool(
            kernel,
            ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="c1"),
            request_id=REQUEST_ID,
            read_snapshot_cache={},
            tool_contract=_Contract(descriptor),
            runtime=runtime,
        )

    assert excinfo.value.code.startswith("CMP-TOOL-")
    assert excinfo.value.code == CMP_TOOL_EXECUTION_FAILED


@pytest.mark.parametrize(
    ("raw_code", "expected"),
    [
        # Tool-recoverable families are preserved for their diagnostics.
        ("CMP-MCP-0004", "CMP-MCP-0004"),
        ("CMP-TOOL-0008", "CMP-TOOL-0008"),
        ("CMP-WEB-0004", "CMP-WEB-0004"),
        ("CMP-TSRCH-0001", "CMP-TSRCH-0001"),
        ("  CMP-TOOL-0008  ", "CMP-TOOL-0008"),
        # Wrong-domain / malformed / blank codes default to the tool subcode so
        # the renderer never classifies a tool failure as 'unknown'.
        ("CMP-AI-0002", CMP_TOOL_EXECUTION_FAILED),
        ("CMP-FOO-0001", CMP_TOOL_EXECUTION_FAILED),
        ("CMP-", CMP_TOOL_EXECUTION_FAILED),
        ("cmp.mcp.boom", CMP_TOOL_EXECUTION_FAILED),
        ("CMP-mixed-Case", CMP_TOOL_EXECUTION_FAILED),
        ("not-a-cmp-code", CMP_TOOL_EXECUTION_FAILED),
        ("", CMP_TOOL_EXECUTION_FAILED),
        (None, CMP_TOOL_EXECUTION_FAILED),
    ],
)
def test_coerce_tool_failure_code(raw_code: object, expected: str) -> None:
    assert _coerce_tool_failure_code(raw_code) == expected


def test_execute_tool_generic_exception_is_wrapped_and_marked_retryable() -> None:
    descriptor = _descriptor("read_file")
    client = _RecordingMCPClient(descriptor, raises=RuntimeError("kaboom"))
    kernel = _kernel(client)
    runtime, store = _runtime()

    with pytest.raises(ToolExecutionFailure) as excinfo:
        execute_tool(
            kernel,
            ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="c1"),
            request_id=REQUEST_ID,
            read_snapshot_cache={},
            tool_contract=_Contract(descriptor),
            runtime=runtime,
        )

    # Generic exceptions are wrapped with the CMP_TOOL_EXECUTION_FAILED code and
    # marked retryable, and the original message is surfaced.
    assert excinfo.value.retryable is True
    assert "kaboom" in excinfo.value.message
    assert excinfo.value.code == CMP_TOOL_EXECUTION_FAILED
    assert _audit_kinds(store)[-1] == KIND_TOOL_EXECUTION_FAILED
    assert _audit_last_error_code(store) == CMP_TOOL_EXECUTION_FAILED


def test_execute_tool_propagates_terminal_chat_state_error_unwrapped() -> None:
    terminal = TerminalChatStateError(status="timeout", message="budget gone")
    descriptor = _descriptor("read_file")
    client = _RecordingMCPClient(descriptor, raises=terminal)
    kernel = _kernel(client)
    runtime, _store = _runtime()

    # The (TerminalChatStateError, ToolExecutionFailure) branch re-raises as-is.
    with pytest.raises(TerminalChatStateError) as excinfo:
        execute_tool(
            kernel,
            ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="c1"),
            request_id=REQUEST_ID,
            read_snapshot_cache={},
            tool_contract=_Contract(descriptor),
            runtime=runtime,
        )

    assert excinfo.value is terminal


# ---------------------------------------------------------------------------
# Blocked contract entry short circuit
# ---------------------------------------------------------------------------


def test_execute_tool_blocked_contract_entry_returns_blocked_outcome() -> None:
    descriptor = _descriptor("write_file", side_effecting=True)
    client = _RecordingMCPClient(descriptor, result=_mcp_result())
    kernel = _kernel(client)

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id="write_file", arguments={"path": "x"}, call_id="c1"),
        request_id=REQUEST_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor, available=False, reason="plan_mode"),
        runtime=None,
    )

    assert outcome.success is False
    assert outcome.tool_name == "write_file"
    # The dispatch is short-circuited before reaching the MCP client.
    assert client.calls == []


# ---------------------------------------------------------------------------
# Synthetic tool routing: monitor (manager-unavailable branch)
# ---------------------------------------------------------------------------


def test_execute_tool_monitor_without_manager_raises_tool_failure() -> None:
    descriptor = _descriptor("monitor", side_effecting=True)
    client = _RecordingMCPClient(descriptor, result=_mcp_result())
    kernel = _kernel(client, monitor_manager=None)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        execute_tool(
            kernel,
            ToolCallRequest(
                tool_id="monitor",
                arguments={"command": "echo hi", "description": "watch"},
                call_id="c1",
            ),
            request_id=REQUEST_ID,
            read_snapshot_cache={},
            tool_contract=_Contract(descriptor),
            runtime=None,
        )

    assert "monitor runtime is unavailable" in excinfo.value.message
    assert excinfo.value.retryable is True


# ---------------------------------------------------------------------------
# Synthetic tool routing: delegate facade
# ---------------------------------------------------------------------------


def test_execute_tool_delegate_routes_to_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    descriptor = _descriptor("delegate", side_effecting=True)
    client = _RecordingMCPClient(descriptor, result=_mcp_result())
    kernel = _kernel(client)
    runtime, _store = _runtime()
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_execution.execute_delegate_tool",
        lambda **_kwargs: ToolExecutionOutcome(
            tool_name="delegate",
            output='{"status":"failed","execution":"single","results":[]}',
            success=False,
            error_code=CMP_TOOL_EXECUTION_FAILED,
        ),
    )

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="delegate",
            arguments={"tasks": ["investigate"]},
            call_id="c1",
        ),
        request_id=REQUEST_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    assert outcome.success is False
    assert outcome.error_code == CMP_TOOL_EXECUTION_FAILED
    assert outcome.tool_name == "delegate"
    assert client.calls == []


def test_execute_tool_delegate_alias_reaches_helper_before_descriptor_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    descriptor = _descriptor("delegate", side_effecting=True)
    client = _RecordingMCPClient(descriptor, result=_mcp_result())
    kernel = _kernel(client)
    runtime, _store = _runtime()
    captured: list[dict[str, object]] = []

    def fake_delegate(**kwargs: Any) -> ToolExecutionOutcome:
        captured.append(dict(kwargs["arguments"]))
        return ToolExecutionOutcome(
            tool_name="delegate",
            output='{"status":"completed","execution":"single","results":[]}',
            success=True,
        )

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_execution.execute_delegate_tool",
        fake_delegate,
    )

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="delegate",
            arguments={"task": "investigate"},
            call_id="c1",
        ),
        request_id=REQUEST_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    assert outcome.success is True
    assert captured == [{"task": "investigate"}]
    assert client.calls == []


def test_execute_tool_delegate_invalid_top_level_uses_existing_repair_contract() -> None:
    descriptor = _descriptor("delegate", side_effecting=False)
    client = _RecordingMCPClient(descriptor, result=_mcp_result())
    kernel = _kernel(client)
    runtime, _store = _runtime()

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="delegate",
            arguments={"tasks": ["investigate"], "max_steps": 2},
            call_id="c1",
        ),
        request_id=REQUEST_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    assert outcome.success is False
    assert outcome.error_code == CMP_LOOP_TOOL_INPUT_VALIDATION
    assert "Canonical form" in outcome.metadata["validation_error"]
    assert outcome.metadata["minimal_valid_arguments"] == {
        "tasks": ["Inspect the repository"]
    }
    assert client.calls == []


def test_delegate_validation_contract_allows_exactly_one_corrective_retry() -> None:
    outcome = ToolExecutionOutcome(
        tool_name="delegate",
        output="rejected",
        success=False,
        error_code=CMP_LOOP_TOOL_INPUT_VALIDATION,
        metadata={"validation_error": "Canonical form: {\"tasks\":[\"inspect\"]}"},
    )
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    try:
        errors = collect_validation_errors((outcome,))
        first = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=False,
            surviving_calls=(),
            validation_errors=errors,
            known_tool_names=frozenset({"delegate"}),
            tool_schemas={"delegate": {"type": "object"}},
            already_retried=False,
            native_tools_active=True,
        )
        second = evaluate_reflexive_retry(
            inband_tool_call_parse_failed=False,
            surviving_calls=(),
            validation_errors=errors,
            known_tool_names=frozenset({"delegate"}),
            tool_schemas={"delegate": {"type": "object"}},
            already_retried=True,
            native_tools_active=True,
        )
    finally:
        configure_tool_call_healing(None)

    assert first.should_retry is True
    assert second.should_retry is False


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------


def test_execute_tool_raises_when_cancel_handle_already_cancelled() -> None:
    descriptor = _descriptor("read_file")
    client = _RecordingMCPClient(descriptor, result=_mcp_result())
    handle = TurnCancellationHandle(request_id=REQUEST_ID)
    handle.cancel()
    kernel = _kernel(client)
    runtime, _store = _runtime()
    runtime.cancel_handle = handle

    with pytest.raises(TerminalChatStateError):
        execute_tool(
            kernel,
            ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="c1"),
            request_id=REQUEST_ID,
            read_snapshot_cache={},
            tool_contract=_Contract(descriptor),
            runtime=runtime,
        )

    # Cancelled before any dispatch happens.
    assert client.calls == []


def test_execute_tool_cancelled_during_dispatch_reports_the_committed_result() -> None:
    """A tool that already committed its effect reports its REAL success.

    This test previously pinned the defect: ``execute_tool`` observed
    interruption AFTER a successful dispatch had returned, discarded the
    already-materialized result, and raised ``TerminalChatStateError``. The
    live tool phase turned that into ``success=False`` +
    ``CMP-LOOP-0013`` + "tool execution interrupted. Retry if needed." -- so a
    ``write_file`` / ``apply_patch`` / ``run_command`` whose effect was already
    on disk was reported to the model, the transcript, and ``turn_events`` as a
    failed, retry-invited interruption.

    Cancellation is NOT weakened by reporting the truth here: the pre-dispatch
    guard still refuses to start a tool on a cancelled turn (see
    ``test_execute_tool_raises_when_cancel_handle_already_cancelled``), and the
    sole caller -- ``execute_tool_calls_sequentially`` in tool_call_execution.py
    -- re-checks interruption AFTER appending the outcome and emitting
    ``tool.result``, so the turn still terminates promptly.
    """
    descriptor = _descriptor("read_file")
    handle = TurnCancellationHandle(request_id=REQUEST_ID)

    class _CancellingClient(_RecordingMCPClient):
        def execute_tool(self, *args: Any, **kwargs: Any) -> Any:  # type: ignore[override]
            # Commits the effect, THEN the turn is cancelled -- the exact race
            # the deadline path hits deterministically.
            result = super().execute_tool(*args, **kwargs)
            handle.cancel()
            return result

    client = _CancellingClient(descriptor, result=_mcp_result())
    kernel = _kernel(client)
    runtime, _store = _runtime()
    runtime.cancel_handle = handle

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="c1"),
        request_id=REQUEST_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    # The dispatch ran exactly once and its committed result survives.
    assert len(client.calls) == 1
    assert outcome.success is True
    assert outcome.output == "file body"
    # The turn is still cancelled; the caller observes it after recording this.
    assert handle.cancelled is True


# ---------------------------------------------------------------------------
# tool_search cancellation + tool-call validation
# ---------------------------------------------------------------------------


def test_execute_tool_search_raises_when_cancel_handle_cancelled() -> None:
    handle = TurnCancellationHandle(request_id=REQUEST_ID)
    handle.cancel()
    runtime = LoopRuntime(request_id=REQUEST_ID, cancel_handle=handle)

    with pytest.raises(TerminalChatStateError):
        execute_tool_search(
            SimpleNamespace(),
            ToolCallRequest(tool_id="tool_search", arguments={"query": "x"}, call_id="c1"),
            resolution_context=None,
            runtime=runtime,
        )


def test_assert_valid_tool_call_rejects_blank_tool_id() -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        assert_valid_tool_call(ToolCallRequest(tool_id="   ", arguments={}, call_id="c1"))
    assert "without a tool_id" in excinfo.value.message
    assert excinfo.value.retryable is False


# ---------------------------------------------------------------------------
# Wall-clock timeout helper
# ---------------------------------------------------------------------------


def test_tool_timeout_for_runtime_returns_configured_when_runtime_is_none() -> None:
    kernel = SimpleNamespace(
        _config=RuntimeConfig(tools_execution_timeout_seconds=42.0),
    )
    assert _tool_timeout_for_runtime(kernel, None) == 42.0


def test_run_command_requested_timeout_extends_outer_transport_deadline() -> None:
    kernel = SimpleNamespace(
        _config=RuntimeConfig(tools_execution_timeout_seconds=120.0),
    )
    call = ToolCallRequest(
        tool_id="run_command",
        arguments={"command": "long build", "timeout_seconds": 600},
    )

    assert _tool_timeout_for_runtime(kernel, None, call) == 605.0


def test_tool_timeout_for_runtime_follows_the_cloud_loop_profile() -> None:
    local_kernel = SimpleNamespace(_config=RuntimeConfig(engine_type="ollama"))
    cloud_kernel = SimpleNamespace(_config=RuntimeConfig(engine_type="chatgpt"))
    rolled_back = SimpleNamespace(
        _config=RuntimeConfig(
            engine_type="chatgpt",
            feature_flags={"cloud_loop_profile": False},
        ),
    )

    assert _tool_timeout_for_runtime(local_kernel, None) == 120.0
    assert _tool_timeout_for_runtime(cloud_kernel, None) == 1_800.0
    assert _tool_timeout_for_runtime(rolled_back, None) == 120.0


def test_tool_timeout_for_runtime_clamps_to_remaining_budget() -> None:
    kernel = SimpleNamespace(_config=RuntimeConfig(tools_execution_timeout_seconds=120.0))
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        wall_clock_deadline=time.monotonic() + 5.0,
    )
    timeout = _tool_timeout_for_runtime(kernel, runtime)
    assert timeout is not None
    assert 0.0 < timeout <= 5.0


def test_ask_user_timeout_uses_remaining_budget_not_generic_tool_timeout() -> None:
    kernel = SimpleNamespace(_config=RuntimeConfig(tools_execution_timeout_seconds=120.0))
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        wall_clock_deadline=300.0,
        clock=lambda: 0.0,
    )

    ask_user_timeout = _tool_timeout_for_runtime(
        kernel,
        runtime,
        ToolCallRequest(tool_id="ask_user", arguments={}),
    )
    ordinary_timeout = _tool_timeout_for_runtime(
        kernel,
        runtime,
        ToolCallRequest(tool_id="jenny_status", arguments={}),
    )

    assert ask_user_timeout == 300.0
    assert ordinary_timeout == 120.0


def test_tool_timeout_for_runtime_raises_when_budget_exhausted() -> None:
    kernel = SimpleNamespace(_config=RuntimeConfig(tools_execution_timeout_seconds=120.0))
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        wall_clock_deadline=time.monotonic() - 1.0,
    )
    with pytest.raises(TerminalChatStateError):
        _tool_timeout_for_runtime(kernel, runtime)
