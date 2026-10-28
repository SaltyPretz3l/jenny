"""Pipeline for ``command.execute_proposal``: gate, approve, run, settle.

Mirrors the model tool loop's single-call path (prevalidate, policy filter,
approval gate with the blocking ``tool.request_approval`` round trip, pre-filter,
restore point, ``execute_tool_calls_sequentially``) around exactly one call whose
arguments are the proposal's exact input. No model is invoked and no generation
state is created.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import (
    CMP_LOOP_TOOL_INPUT_VALIDATION,
    CMP_LOOP_TOOL_INTERRUPTED,
    CMP_TOOL_POLICY_DENIED,
)
from sidecar.ai.execution_policy import desktop_policy_is_enforced
from sidecar.ai.feature_flags import (
    FEATURE_CANONICAL_TURN_EVENTS,
    FEATURE_PHASE_EVENTS,
    is_feature_flag_enabled,
)
from sidecar.ai.mode_policy import policy_for_mode
from sidecar.ai.routing import tool_call_execution as _tce
from sidecar.ai.routing.auto_checkpoint import prepare_resume_restore_point
from sidecar.ai.routing.loop_event_emit import (
    build_interrupted_tool_outcome,
    emit_interrupted_results_for_pending_calls,
    emit_tool_executing,
    emit_tool_result,
)
from sidecar.ai.routing.loop_events import ToolCallCompletedEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.mutation_change_set_lifecycle import (
    bind_run_context,
    finish_run_change_set,
)
from sidecar.ai.routing.tool_observation import KIND_USER_APPROVAL_REQUESTED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime import command_proposal_outcome as oc
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.chat_serialization import _serialize_loop_event, _serialize_turn_event
from sidecar.runtime.command_proposal_approval import ApprovalVerdict, request_one_off_approval
from sidecar.runtime.command_proposal_request import CommandProposalRequest, refusal_error
from sidecar.runtime.command_proposal_terminal import TerminalBuilders
from sidecar.runtime.ipc_payloads import IpcPayloadExternalizer
from sidecar.runtime.operation_admission import build_operation_admission_callback
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.request_dispatch_chat import UNATTENDED_PAUSE_APPROVAL_TIMEOUT_SECONDS
from sidecar.runtime.request_dispatch_chat_support import (
    _emit_canonical_notification,
    _emit_phase_notification,
)

_TOOL = "run_command"
_BRIDGE = "electron_tool_bridge"


def _agrees_with_backend(
    kernel: Any, config: Any, tool_contract: Any, request: CommandProposalRequest
) -> bool:
    """Native needs the builtin descriptor and this host's shell; Docker the Electron bridge."""
    from sidecar.ai.tools.builtins.shell import _shell_name

    entry = tool_contract.entry(_TOOL)
    descriptor = (
        entry.descriptor if entry is not None else kernel._mcp_client.tool_descriptor(_TOOL)
    )
    bridge = descriptor is not None and getattr(descriptor, "server_name", "") == _BRIDGE
    if request.backend == "docker":
        return bridge and desktop_policy_is_enforced(config)
    return not bridge and request.shell == _shell_name()


class _ExactRun(TerminalBuilders):  # noqa: PLR0902 - one run's identity, emitters and settlement facts.
    def __init__(  # noqa: PLR0913
        self,
        *,
        request: CommandProposalRequest,
        message_id: Any,
        brain_container: BrainContainer,
        logger: logging.Logger,
        write_frame: Callable[[dict[str, Any]], None],
        waiter_factory: Any,
        cancel_handle: Any,
        approval_timeout_seconds: float,
    ) -> None:
        self.request, self.message_id, self.logger = request, message_id, logger
        self.write_frame, self.waiter_factory = write_frame, waiter_factory
        self.cancel_handle, self.approval_timeout = cancel_handle, approval_timeout_seconds
        self.stack = brain_container.stack
        self.kernel = self.stack.router
        flags = getattr(self.stack.config, "feature_flags", None) or {}
        self.phase_enabled = is_feature_flag_enabled(flags, FEATURE_PHASE_EVENTS)
        self.canonical_enabled = is_feature_flag_enabled(flags, FEATURE_CANONICAL_TURN_EVENTS)
        self.seq = {"seq": 0}
        self.probe = oc.CleanupProbe()
        self.terminal: list[dict[str, Any]] = []
        self.outcomes: list[Any] = []
        self._audit_by_call: dict[str, Any] = {}
        self.working: list[dict[str, object]] = []
        self.iteration_calls: list[Any] = []
        self.streamed: set[str] = set()
        self.stub = SimpleNamespace(
            tool_calls=(
                ToolCallRequest(_TOOL, request.tool_arguments(), call_id=request.tool_call_id),
            ),
            content="",
        )
        self.call = self.stub.tool_calls[0]
        self.mode_policy = policy_for_mode("assist")
        self.context = ChatRequestContext(
            request_id=request.request_id,
            trace_id=request.trace_id,
            session_id=request.session_id,
            mode="assist",
            approvals_pre_granted=False,
            logical_turn_id=request.turn_id,
            continuation_context=request.continuation_context,
            execution_context=request.execution_context,
            plan_mode=False,
            read_only=False,
            approval_mode=request.approval_mode,
            agent_id=f"main@{request.request_id}",
            workspace_root_present=request.execution_context.workspace_root_present,
        )
        self.runtime = self._build_runtime()

    # -- construction -------------------------------------------------------------
    def _build_runtime(self) -> LoopRuntime:
        from sidecar.runtime.continuation_checkpoint import build_continuation_checkpoint_callback

        request, stack = self.request, self.stack
        payload_externalizer = IpcPayloadExternalizer.from_config(stack.config)
        runtime_holder: list[LoopRuntime] = []

        def _emit(event: Any) -> None:
            msg = _serialize_loop_event(
                event,
                request.request_id,
                trace_id=request.trace_id,
                session_id=request.session_id,
                payload_externalizer=payload_externalizer,
            )
            if msg is not None:
                self.write_frame(msg)
            if self.canonical_enabled:
                next_seq = int(self.seq["seq"]) + 1
                canonical = _serialize_turn_event(
                    event,
                    request.request_id,
                    trace_id=request.trace_id,
                    session_id=request.session_id,
                    seq=next_seq,
                    turn_id=runtime_holder[0].logical_turn_id or request.request_id,
                )
                if canonical is not None:
                    self.seq["seq"] = next_seq
                    self.write_frame(canonical)

        admission = build_operation_admission_callback(
            request_id=request.request_id,
            session_id=request.session_id,
            execution_context=request.execution_context,
            write_message=self.write_frame,
            response_reader_factory=self.waiter_factory,
            cancel_handle=self.cancel_handle,
            continuation_enabled=request.continuation_context is not None,
        )
        runtime = LoopRuntime(
            emit=_emit,
            request_id=request.request_id,
            logical_turn_id=request.turn_id,
            trace_id=request.trace_id or "",
            session_id=request.session_id,
            notification_writer=self.write_frame,
            electron_tool_writer=self.write_frame,
            electron_tool_reader_factory=self.waiter_factory,
            operation_admission=oc.probed_admission(admission, self.probe),
            continuation_checkpoint=build_continuation_checkpoint_callback(
                context=request.continuation_context,
                write_message=self.write_frame,
                response_reader_factory=self.waiter_factory,
                cancel_handle=self.cancel_handle,
            ),
            max_iterations=1,
            streaming=True,
            cancel_handle=self.cancel_handle,
            observation_store=getattr(stack, "tool_observations", None),
            request_context=self.context,
            phase_events_enabled=self.phase_enabled,
        )
        runtime_holder.append(runtime)
        return runtime

    # -- pipeline -----------------------------------------------------------------------
    def _record_failed(self, *, code: str, output: str, metadata: dict[str, Any]) -> None:
        """Pair a pre-dispatch refusal with its tool row, as the loop's recorders do."""
        from sidecar.ai.routing.router import ToolExecutionOutcome

        outcome = ToolExecutionOutcome(
            tool_name=_TOOL,
            output=output,
            success=False,
            tool_input=dict(self.call.arguments),
            error_code=code,
            metadata=metadata,
            call_id=self.call.call_id,
        )
        self.outcomes.append(outcome)
        call_id = emit_tool_executing(self.runtime, self.call, self.request.request_id, 1)
        emit_tool_result(self.runtime, outcome, call_id)

    def _refused(self, *, code: str, output: str, metadata: dict[str, Any]) -> ProcessOutcome:
        self._record_failed(
            code=code, output=output, metadata={**metadata, "pre_dispatch_blocked": True}
        )
        return self.completed(oc.denied_outcome())

    def _ask_approval(self, approval: Any) -> ApprovalVerdict:
        r = self.request
        self.runtime.audit(
            KIND_USER_APPROVAL_REQUESTED,
            tool_call_id=r.tool_call_id,
            summary="user_approval_requested",
        )
        self.runtime.raise_if_cancelled()

        def phase(event: Any) -> None:
            _emit_phase_notification(
                enabled=self.phase_enabled,
                writer=self.write_frame,
                event=event,
                request_id=r.request_id,
                trace_id=r.trace_id,
                session_id=r.session_id,
                canonical_enabled=self.canonical_enabled,
                canonical_seq_state=self.seq,
            )

        def canonical(event: Any) -> None:
            _emit_canonical_notification(
                enabled=self.canonical_enabled,
                writer=self.write_frame,
                event=event,
                request_id=r.request_id,
                trace_id=r.trace_id,
                session_id=r.session_id,
                canonical_seq_state=self.seq,
            )

        return request_one_off_approval(
            approval,
            request_id=r.request_id,
            trace_id=r.trace_id,
            session_id=r.session_id,
            tool_call_id=r.tool_call_id,
            write_frame=self.write_frame,
            emit_phase=phase,
            emit_canonical=canonical,
            response_reader_factory=self.waiter_factory,
            cancel_handle=self.cancel_handle,
            timeout_seconds=self.approval_timeout,
            unattended_timeout_seconds=UNATTENDED_PAUSE_APPROVAL_TIMEOUT_SECONDS,
            logger=self.logger,
        )

    def _gate(
        self, tool_contract: Any
    ) -> tuple[ProcessOutcome | None, Any, ApprovalVerdict | None]:
        """Prevalidate, filter by policy, ask when it asks: (stop, call, verdict)."""
        kernel, mp, call = self.kernel, self.mode_policy, self.call
        disabled = kernel._request_tool_set(None, "disabled_tools")
        pre = _tce.prevalidate_call_arguments(kernel=kernel, call=call, tool_contract=tool_contract)
        if pre is not None:
            return (
                self._refused(
                    code=pre.get("error_code", CMP_LOOP_TOOL_INPUT_VALIDATION),
                    output=pre["message"],
                    metadata=dict(pre.get("metadata") or {}),
                ),
                call,
                None,
            )
        policy = kernel._filter_tool_calls_by_policy(
            (call,),
            mode=mp.mode,
            mode_allows_side_effecting=mp.allow_side_effecting_tools,
            resolution_context=None,
            tool_contract=tool_contract,
            plan_mode=False,
            read_only=False,
            request_disabled_tools=disabled,
            policy_snapshot=getattr(self.request.execution_context, "tool_policy_snapshot", None),
        )
        if policy.denied:
            denied = policy.denied[0]
            return (
                self._refused(
                    code=str(getattr(denied, "error_code", "") or CMP_TOOL_POLICY_DENIED),
                    output=f"Tool '{_TOOL}' was not executed: {denied.decision.reason}",
                    metadata={**dict(denied.metadata), "policy_denied": True},
                ),
                call,
                None,
            )
        if len(policy.allowed) != 1 or policy.allowed[0].arguments != call.arguments:
            return (
                self._refused(
                    code=CMP_TOOL_POLICY_DENIED,
                    output=f"Tool '{_TOOL}' was not executed: arguments changed.",
                    metadata={},
                ),
                call,
                None,
            )
        call = policy.allowed[0]
        try:
            approval = kernel._approval_if_needed(
                (call,),
                mode=mp.mode,
                mode_allows_side_effecting=mp.allow_side_effecting_tools,
                require_approval=mp.require_approval_for_side_effecting,
                approvals_pre_granted=False,
                resolution_context=None,
                tool_contract=tool_contract,
                plan_mode=False,
                read_only=False,
                request_disabled_tools=disabled,
                policy_decisions_by_call=policy.decisions_by_call,
                approval_mode=self.request.approval_mode,
                execution_context=self.request.execution_context,
            )
        except ToolExecutionFailure as exc:
            return (
                self._refused(
                    code=exc.code,
                    metadata={},
                    output=f"Tool '{_TOOL}' was not executed: {exc.message}.",
                ),
                call,
                None,
            )
        self._audit_by_call = policy.audit_metadata_by_call
        if approval is None:
            return None, call, None
        verdict = self._ask_approval(approval)
        return (self.approval_stopped(verdict) if not verdict.approved else None), call, verdict

    def execute(self) -> ProcessOutcome:
        r = self.request
        tool_contract = self.kernel._assemble_tool_contract(
            request_context=self.context, resolution_context=None
        )
        if not _agrees_with_backend(self.kernel, self.stack.config, tool_contract, r):
            raise refusal_error(r.request_id, r.trace_id, r.session_id, "backend_or_shell_mismatch")
        self.runtime.emit(
            ToolCallCompletedEvent(
                call_id=r.tool_call_id,
                tool_name=_TOOL,
                arguments=dict(self.call.arguments),
                sequence=0,
            )
        )
        try:
            stop, call, verdict = self._gate(tool_contract)
            if stop is not None:
                return stop
            remaining, _index = _tce.pre_filter_tool_calls(
                (call,),
                kernel=self.kernel,
                runtime=self.runtime,
                result=self.stub,
                request_id=r.request_id,
                tool_resolution_context=None,
                outcomes=self.outcomes,
                working_messages=self.working,
                iteration_calls=self.iteration_calls,
                streamed_event_types=self.streamed,
                outcome_index=0,
                tool_contract=tool_contract,
                plan_mode=False,
                read_only=False,
                request_disabled_tools=self.kernel._request_tool_set(None, "disabled_tools"),
                session_id=r.session_id,
            )
        except TerminalChatStateError as error:  # cancelled before anything was dispatched
            return self.cancelled(error, oc.CommandOutcome(oc.STATUS_CANCELLED, None, None))
        if not remaining:
            return self.completed(oc.denied_outcome())
        return self._dispatch(remaining, tool_contract, approved=verdict is not None)

    def _dispatch(
        self, remaining: list[tuple[Any, int]], tool_contract: Any, *, approved: bool
    ) -> ProcessOutcome:
        r = self.request
        prepare_resume_restore_point(
            self.runtime,
            remaining,
            kernel=self.kernel,
            request_id=r.request_id,
            session_id=r.session_id,
            outcomes=self.outcomes,
        )
        bind_run_context(self.runtime, kernel=self.kernel)
        try:
            boundary = _tce.execute_tool_calls_sequentially(
                indexed_calls=remaining,
                runtime=self.runtime,
                kernel=self.kernel,
                result=self.stub,
                request_id=r.request_id,
                session_id=r.session_id,
                tool_resolution_context=None,
                tool_contract=tool_contract,
                read_snapshot_cache={},
                outcomes=self.outcomes,
                working_messages=self.working,
                iteration_calls=self.iteration_calls,
                streamed_event_types=self.streamed,
                tool_payload_ref=[],
                tool_preferences=None,
                request_context=self.context,
                audit_metadata_by_call=self._audit_by_call,
                approvals_pre_granted=approved,
                scan_approval_mode=r.approval_mode,
            )
            if boundary is not None:  # run_command never raises one: fail closed as unknown
                raise RuntimeError("unexpected_turn_boundary")
        except TerminalChatStateError as error:
            return self.cancelled(error, self._classify_interrupted())
        except Exception:  # noqa: BLE001 - after dispatch began the outcome is unknown.
            self.logger.exception("command proposal execution failed")
            started = self._dispatch_started()
            self._pair_open_rows()
            if not started:
                raise
            return self.unknown()
        finally:
            finish_run_change_set(self.runtime, approval_paused=False, reason="command_proposal")
        return self.completed(
            oc.classify_outcome(
                self.outcomes[-1], expected_exit_codes=r.expected_exit_codes, probe=self.probe
            )
        )

    def _dispatch_started(self) -> bool:
        return self.request.tool_call_id in self.runtime.emitted_tool_calls

    def _pair_open_rows(self) -> None:
        emit_interrupted_results_for_pending_calls(
            runtime=self.runtime,
            outcomes=self.outcomes,
            streamed_event_types=self.streamed,
            outcome_factory=build_interrupted_tool_outcome,
        )

    def _classify_interrupted(self) -> oc.CommandOutcome:
        """Cancellation or deadline: report only what cleanup evidence proves."""
        real = [
            item
            for item in self.outcomes
            if item.call_id == self.request.tool_call_id
            and item.error_code != CMP_LOOP_TOOL_INTERRUPTED
        ]
        if real:
            outcome = oc.classify_outcome(
                real[-1], expected_exit_codes=self.request.expected_exit_codes, probe=self.probe
            )
        elif not self._dispatch_started():
            outcome = oc.CommandOutcome(oc.STATUS_CANCELLED, None, None)
        elif self.probe.cleanup == "confirmed":
            outcome = oc.CommandOutcome(oc.STATUS_CANCELLED, None, "confirmed")
        else:
            outcome = oc.unknown_outcome()
        self._pair_open_rows()
        return outcome


def run_exact_command(**kwargs: Any) -> ProcessOutcome:
    """Run the one exact call; ``ChatRequestError`` means refused before any effect."""
    return _ExactRun(**kwargs).execute()


__all__ = ["run_exact_command"]
