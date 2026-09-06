"""Finite plugin-workflow adapter over Jenny's existing chat, tool, and approval seams."""

# Imports of plugin/routing internals stay function-local so the default-off
# runtime does not load the plugin execution graph. The constructor mirrors the
# already-established chat dispatch seam and is intentionally dependency-injected.
# ruff: noqa: PLC0415, PLR0913

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.runtime.multiplexer import TurnCancellationHandle


def workflow_usage_payload(bridge: Any, output_tokens: int) -> dict[str, int]:
    """Aggregate chat.done usage from the workflow's prompt nodes; the
    zero-input character estimate remains only for promptless workflows."""
    aggregated = bridge.aggregate_prompt_usage()
    if aggregated is not None:
        return aggregated
    return {
        "input_tokens": 0,
        "output_tokens": output_tokens,
        "total_tokens": output_tokens,
    }


class PluginWorkflowBridge:
    """Bind the finite interpreter to the existing engine/tool/approval seams."""

    def __init__(
        self, *, brain_container: BrainContainer, params: dict[str, Any], request_id: str,
        trace_id: str, session_id: str, write_message: Callable[[dict[str, Any]], None],
        read_message: Callable[[], dict[str, Any]], stream_notifications: bool,
        approval_response_reader: Callable[[float], dict[str, Any]] | None,
        approval_response_waiter_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
        approval_timeout_seconds: float, cancel_handle: TurnCancellationHandle | None,
        logger: logging.Logger,
    ) -> None:
        self.brain_container = brain_container
        self.params = params
        self.request_id = request_id
        self.trace_id = trace_id
        self.session_id = session_id
        self.write_message = write_message
        self.read_message = read_message
        self.stream_notifications = stream_notifications
        self.approval_response_reader = approval_response_reader
        self.approval_response_waiter_factory = approval_response_waiter_factory
        self.approval_timeout_seconds = approval_timeout_seconds
        self.cancel_handle = cancel_handle
        self.logger = logger
        self.notifications: list[dict[str, Any]] = []
        self.canonical_seq = 0
        self.read_snapshot_cache: dict[str, dict[str, object]] = {}
        self._prompt_usage_totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        self._prompt_usage_nodes = 0

    def _accumulate_prompt_usage(self, response: Any) -> None:
        for note in getattr(response, "notifications", None) or []:
            if not isinstance(note, dict) or note.get("method") != "chat.done":
                continue
            params = note.get("params")
            usage = params.get("usage") if isinstance(params, dict) else None
            if not isinstance(usage, dict):
                continue
            self._prompt_usage_nodes += 1
            for key in self._prompt_usage_totals:
                value = usage.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    self._prompt_usage_totals[key] += value

    def aggregate_prompt_usage(self) -> dict[str, int] | None:
        """Summed chat.done usage across executed prompt nodes; None when the
        workflow ran no model prompt (the caller keeps its zero-input estimate)."""
        if self._prompt_usage_nodes == 0:
            return None
        return dict(self._prompt_usage_totals)

    def _publish(self, message: dict[str, Any]) -> None:
        if self.stream_notifications:
            self.write_message(message)
        else:
            self.notifications.append(message)

    def _emit(self, event: Any) -> None:
        from sidecar.ai.feature_flags import FEATURE_CANONICAL_TURN_EVENTS, is_feature_flag_enabled
        from sidecar.runtime.chat_serialization import _serialize_loop_event, _serialize_turn_event

        message = _serialize_loop_event(
            event, self.request_id, trace_id=self.trace_id, session_id=self.session_id,
        )
        if message is not None:
            self._publish(message)
        flags = self.brain_container.stack.config.feature_flags or {}
        if is_feature_flag_enabled(flags, FEATURE_CANONICAL_TURN_EVENTS):
            canonical = _serialize_turn_event(
                event, self.request_id, trace_id=self.trace_id,
                session_id=self.session_id, seq=self.canonical_seq + 1,
            )
            if canonical is not None:
                self.canonical_seq += 1
                self._publish(canonical)

    def emit_status(self, node_id: str, state: str) -> None:
        from sidecar.ai.routing.loop_events import ThinkingEvent

        self._emit(ThinkingEvent(
            thinking_id=f"plugin_workflow_{node_id}",
            delta=f"Workflow step {node_id}: {state}", kind="status", persist=False,
        ))

    def prompt_runner(self, prompt: str, timeout_ms: int) -> Any:
        import threading

        from sidecar.ai.plugins.workflow_interpreter import WorkflowNodeOutcome
        from sidecar.runtime.request_dispatch_chat_support import _build_chat_response

        if self.cancel_handle is not None and self.cancel_handle.cancelled:
            return WorkflowNodeOutcome(False, code="cancelled")
        node_params = dict(self.params)
        node_params.pop("plugin_command_invocation", None)
        node_params["request_id"] = "wf_" + hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:24]
        node_params["messages"] = [{"role": "user", "content": prompt}]
        node_params["mode"] = "chat"
        node_params["tool_preferences"] = {"enabled_tools": [], "disabled_tools": []}
        node_cancel = (
            self.cancel_handle.create_child(
                request_id=node_params["request_id"], trace_id=self.trace_id,
                session_id=self.session_id,
            )
            if self.cancel_handle is not None
            else TurnCancellationHandle(
                request_id=node_params["request_id"], trace_id=self.trace_id,
                session_id=self.session_id,
            )
        )
        timed_out = threading.Event()

        def cancel_for_timeout() -> None:
            timed_out.set()
            node_cancel.cancel(reason="sidecar_cancel")

        timer = threading.Timer(
            timeout_ms / 1000,
            cancel_for_timeout,
        )
        timer.daemon = True
        timer.start()
        started = time.monotonic()
        try:
            response = _build_chat_response(
                message_id=None, params=node_params, approvals_pre_granted=False,
                brain_container=self.brain_container, stream_notifications=False,
                write_message=lambda _message: None, read_message=self.read_message,
                approval_response_reader=self.approval_response_reader,
                approval_response_waiter_factory=self.approval_response_waiter_factory,
                approval_timeout_seconds=min(self.approval_timeout_seconds, timeout_ms / 1000),
                cancel_handle=node_cancel, approval_plan=None,
                canonical_session_messages=None, session_title="",
            )
        except Exception as error:  # noqa: BLE001 - interpreter consumes structured failure
            if timed_out.is_set():
                return WorkflowNodeOutcome(False, code="timeout")
            retryable = getattr(error, "retryable", False) is True
            return WorkflowNodeOutcome(
                False, code=str(getattr(error, "code", "prompt_failed")), retryable=retryable
            )
        finally:
            timer.cancel()
        # Count usage even for timed-out/empty nodes — the provider consumed it.
        self._accumulate_prompt_usage(response)
        if timed_out.is_set() or (time.monotonic() - started) * 1000 > timeout_ms:
            return WorkflowNodeOutcome(False, code="timeout")
        text = str(getattr(response, "result", {}).get("response_text") or "")
        return WorkflowNodeOutcome(bool(text), output=text, code="none" if text else "prompt_empty")

    def _workflow_binding(self, resolution: Any, node_id: str, tool_id: str) -> Any | None:
        identity = (
            resolution.command.publisher_id, resolution.command.plugin_id,
            resolution.target.contribution_id, node_id, tool_id,
        )
        return next((item for item in resolution.generation.workflow_tool_bindings if (
            item.publisher_id, item.plugin_id, item.workflow_id, item.node_id, item.tool_id,
        ) == identity), None)

    def _runtime(self, timeout_ms: int) -> Any:
        from sidecar.ai.routing.loop_runtime import LoopRuntime

        return LoopRuntime(
            emit=self._emit, request_id=self.request_id, trace_id=self.trace_id,
            session_id=self.session_id, notification_writer=self.write_message,
            electron_tool_writer=self.write_message,
            electron_tool_reader=(
                self.approval_response_reader or (lambda _timeout: self.read_message())
            ),
            electron_tool_reader_factory=self.approval_response_waiter_factory,
            wall_clock_deadline=time.monotonic() + (timeout_ms / 1000), streaming=True,
            cancel_handle=self.cancel_handle,
            observation_store=getattr(self.brain_container.stack, "tool_observations", None),
        )

    def _approval_allowed(self, approval: Any, *, timeout_ms: int) -> bool:
        if approval is None:
            return True
        from sidecar.runtime.approval import request_tool_approval

        payload = approval.to_payload()
        payload.update({
            "request_id": self.request_id, "trace_id": self.trace_id,
            "session_id": self.session_id,
        })
        reader = self.approval_response_reader or (lambda _timeout: self.read_message())
        resolution = request_tool_approval(
            payload, write_message=self.write_message, read_message=reader,
            response_reader_factory=self.approval_response_waiter_factory,
            timeout_seconds=min(self.approval_timeout_seconds, timeout_ms / 1000),
            logger=self.logger, cancel_handle=self.cancel_handle,
        )
        return resolution.approved

    def tool_runner(  # noqa: PLR0911 - explicit fail-closed dispatch stages
        self, resolution: Any, tool_id: str, arguments: dict[str, object],
        node_id: str, timeout_ms: int,
    ) -> Any:
        from sidecar.ai.plugins.runtime_apply import _tool_descriptor_digest
        from sidecar.ai.plugins.workflow_interpreter import WorkflowNodeOutcome
        from sidecar.ai.routing.loop_event_emit import emit_tool_executing, emit_tool_result
        from sidecar.ai.tools.contracts import ToolExecutionFailure
        from sidecar.ai.tools.models import ToolCallRequest
        from sidecar.runtime.chat_models import ChatRequestContext
        from sidecar.runtime.request_dispatch_chat_support import _workspace_root_configured

        binding = self._workflow_binding(resolution, node_id, tool_id)
        if binding is None:
            return WorkflowNodeOutcome(False, code="eligibility_failed")
        router = self.brain_container.stack.router
        call_id = "wf_" + hashlib.sha256(
            f"{self.request_id}:{node_id}:{tool_id}".encode("utf-8")
        ).hexdigest()[:24]
        call = ToolCallRequest(tool_id=tool_id, arguments=arguments, call_id=call_id)
        context = ChatRequestContext(
            request_id=self.request_id, trace_id=self.trace_id, session_id=self.session_id,
            mode="assist", approvals_pre_granted=False,
            workspace_root_present=_workspace_root_configured(self.brain_container.stack.config),
        )
        runtime = self._runtime(timeout_ms)

        def binding_is_current() -> bool:
            observed = _tool_descriptor_digest(tool_id)
            return observed is not None and observed == binding.descriptor_sha256

        try:
            if not binding_is_current():
                return WorkflowNodeOutcome(False, code="eligibility_failed")
            contract = router._assemble_tool_contract(request_context=context)
            filtered = router._filter_tool_calls_by_policy(
                (call,), mode="assist", mode_allows_side_effecting=False,
                resolution_context=None, tool_contract=contract,
            )
            if filtered.denied or len(filtered.allowed) != 1:
                return WorkflowNodeOutcome(False, code="denied")
            call = filtered.allowed[0]
            approval = router._approval_if_needed(
                (call,), mode="assist", mode_allows_side_effecting=False,
                require_approval=True, approvals_pre_granted=False, resolution_context=None,
                tool_contract=contract,
                policy_decisions_by_call=filtered.decisions_by_call,
            )
            if not self._approval_allowed(approval, timeout_ms=timeout_ms):
                return WorkflowNodeOutcome(False, code="denied")
            if not binding_is_current():
                return WorkflowNodeOutcome(False, code="eligibility_failed")
            emit_tool_executing(runtime, call, self.request_id, 0)
            outcome = router._execute_tool(
                call, request_id=self.request_id, session_id=self.session_id,
                read_snapshot_cache=self.read_snapshot_cache, tool_contract=contract,
                audit_metadata=filtered.audit_metadata_by_call.get(call_id), runtime=runtime,
            )
            emit_tool_result(runtime, outcome, call_id)
            router._update_read_snapshot_cache(
                self.read_snapshot_cache, tool_name=outcome.tool_name,
                success=outcome.success, metadata=dict(outcome.metadata),
            )
            return WorkflowNodeOutcome(
                outcome.success, output=outcome.output,
                code=str(outcome.error_code or ("none" if outcome.success else "tool_failed")),
                retryable=False,
            )
        except ToolExecutionFailure as error:
            self._emit_tool_failure(runtime, call, arguments, tool_id, str(error.code))
            return WorkflowNodeOutcome(False, code=str(error.code), retryable=error.retryable)
        except Exception as error:  # noqa: BLE001 - bounded interpreter failure
            code = str(getattr(error, "code", "tool_failed"))
            self._emit_tool_failure(runtime, call, arguments, tool_id, code)
            return WorkflowNodeOutcome(False, code=code, retryable=False)

    @staticmethod
    def _emit_tool_failure(
        runtime: Any, call: Any, arguments: dict[str, object], tool_id: str, code: str
    ) -> None:
        if call.call_id not in runtime.pre_dispatch_emitted_call_ids \
                and call.call_id not in runtime.emitted_tool_calls:
            return
        from sidecar.ai.routing.loop_event_emit import emit_tool_result
        from sidecar.ai.routing.router import ToolExecutionOutcome

        emit_tool_result(runtime, ToolExecutionOutcome(
            tool_name=tool_id, output="Workflow tool execution failed.",
            success=False, tool_input=arguments, error_code=code,
            call_id=call.call_id,
        ), call.call_id)
