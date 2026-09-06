"""Canonical sequential tool-call preflight and execution.

This module owns the request-contract checks that must run immediately before
tool dispatch and the single in-order execution path shared by live turns and
approval resumes.  Tool calls are never reordered or executed concurrently.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

from sidecar.ai.error_codes import (
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_APPROVAL_WINDOW_DROPPED,
    CMP_TOOL_COERCED_ARGS_REJECTED,
    CMP_TOOL_DISABLED,
    CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED,
)
from sidecar.ai.routing import loop_event_emit
from sidecar.ai.routing import router as _router
from sidecar.ai.tools import assembly as _tool_assembly
from sidecar.ai.tools import contracts as _tool_contracts
from sidecar.ai.tools import schema_examples as _tools_schema_examples
from sidecar.ai.tools.plan_artifact_policy import is_plan_artifact_write_eligible
from sidecar.ai.tools.policy import tool_policy_call_key
from sidecar.ai.tools.tool_actions import effective_side_effecting
from sidecar.runtime import tool_execution_support as _tool_support
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)
TOOL_NOT_EXPOSED_REASON = _tool_assembly.TOOL_NOT_EXPOSED_REASON
TOOL_SEARCH_TOOL_NAME = _tool_assembly.TOOL_SEARCH_TOOL_NAME


def _remaining_deferred_names(
    kernel: Any,
    tool_resolution_context: Any | None,
) -> frozenset[str]:
    resolver = getattr(kernel, "_remaining_deferred_names", None)
    if not callable(resolver):
        return frozenset()
    names = resolver(tool_resolution_context)
    if isinstance(names, frozenset):
        return names
    if isinstance(names, (set, list, tuple)):
        return frozenset(str(name) for name in names if name)
    return frozenset()


def _is_deferred_tool_call(
    kernel: Any,
    call: Any,
    tool_resolution_context: Any | None,
    *,
    remaining_hidden_names: frozenset[str],
) -> bool:
    if call.tool_id in remaining_hidden_names:
        return True
    checker = getattr(kernel, "_is_direct_deferred_tool_call", None)
    if not callable(checker):
        return False
    return bool(checker(call, tool_resolution_context))


# Placeholder markers invented by ``schema_examples.schema_placeholder_value``
# when it has nothing real to show: ``<string>`` for an unconstrained string and
# ``<value>`` for a type-less schema.  Only these two are matched.  The
# generator's other candidates ("value", "x", runs of "0"/"a") are ordinary
# strings a model could legitimately send, so they are deliberately NOT markers.
_PLACEHOLDER_ARGUMENT_MARKERS = frozenset({"<string>", "<value>"})


def _contains_placeholder_marker(value: object) -> bool:
    """True when ``value`` (or anything nested inside it) is a marker literal."""
    if isinstance(value, str):
        return value in _PLACEHOLDER_ARGUMENT_MARKERS
    if isinstance(value, dict):
        return any(_contains_placeholder_marker(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(_contains_placeholder_marker(item) for item in value)
    return False


def _placeholder_arguments_reason(call: Any, descriptor: Any | None) -> str | None:
    """Classify a call whose arguments are the tool-prompt example, not real data.

    The tool-use nudge and the schema repair hints both show the model a worked
    example built by ``schema_examples``; a small local model can copy it back
    verbatim as a real, structurally valid tool call.  Left alone that call
    creates a pre-mutation auto-checkpoint and then executes, so it is settled
    here, before dispatch.

    Two signals, in order of specificity:

    * ``schema_example_echo`` -- the arguments are byte-identical to the
      example this process would have generated for the tool's own schema.
      Applies to every tool, read-only ones included.
    * ``placeholder_literal`` -- any argument value is a marker literal.
      Applies ONLY to side-effecting tools and to calls with no descriptor at
      all, because a marker literal is a perfectly ordinary value to send a
      read-only search tool: ``grep_search {"pattern": "<string>", "path":
      "Info.plist"}`` is a real search over a plist/XML/Obj-C tree, and a
      blanket rule would leave it unexecutable with no escape.  The incident
      call was side-effecting, which is where the damage lives.

    The echo rule additionally requires the generated example to contain a
    marker.  A bare equality test is unsafe: several real tools have examples
    built entirely from their schema's ``enum``/``default``/``minItems``
    values, which is exactly what a legitimate call looks like -- measured on
    the live catalog, ``home {"action": "calendar_list"}``,
    ``knowledge_exec {"op": "ls"}``, ``workspace_present {"view": "preview"}``
    and ``todo_write {"todos": []}`` would all have been rejected, and for
    an enum-only tool the model could never escape the rejection.

    Returns the reason tag, or ``None`` when the call carries real arguments.
    ``descriptor`` may be ``None`` (no request contract and no MCP descriptor);
    the tool is then treated as unknown, so the literal rule applies.
    """
    arguments = dict(call.arguments or {})
    if not arguments:
        return None
    input_schema = getattr(descriptor, "input_schema", None) if descriptor is not None else None
    if isinstance(input_schema, dict):
        example = _tools_schema_examples.minimal_valid_arguments(input_schema)
        if example and arguments == example and _contains_placeholder_marker(example):
            return "schema_example_echo"
    if descriptor is not None and not effective_side_effecting(descriptor, call.arguments):
        return None
    if any(_contains_placeholder_marker(value) for value in arguments.values()):
        return "placeholder_literal"
    return None


def _blocked_outcome(
    call: Any,
    *,
    output: str,
    error_code: str,
    metadata: dict[str, object],
) -> Any:
    return _router.ToolExecutionOutcome(
        tool_name=call.tool_id,
        output=output,
        success=False,
        tool_input={str(key): value for key, value in call.arguments.items()},
        error_code=error_code,
        metadata=metadata,
        call_id=call.call_id,
    )


def _record_filtered_outcome(  # noqa: PLR0913
    *,
    kernel: Any,
    runtime: Any,
    result: Any,
    request_id: str,
    call: Any,
    outcome_index: int,
    tool_result: Any,
    outcomes: list[Any],
    working_messages: list[dict[str, object]],
    iteration_calls: list[Any],
    streamed_event_types: set[str],
) -> None:
    outcomes.append(tool_result)
    call_id = loop_event_emit.emit_tool_executing(
        runtime,
        call,
        request_id,
        outcome_index,
    )
    loop_event_emit.emit_tool_result(runtime, tool_result, call_id)
    if runtime.streaming:
        streamed_event_types.update(("tool.executing", "tool.result"))
    working_messages.append(kernel._assistant_tool_call_message(result, call))
    working_messages.append(kernel._tool_result_message(call, tool_result))
    iteration_calls.append(call)


def pre_filter_tool_calls(  # noqa: C901, PLR0912, PLR0913, PLR0915
    tool_calls: tuple[Any, ...] | list[Any],
    *,
    kernel: Any,
    runtime: Any,
    result: Any,
    request_id: str,
    tool_resolution_context: Any | None,
    outcomes: list[Any],
    working_messages: list[dict[str, object]],
    iteration_calls: list[Any],
    streamed_event_types: set[str],
    outcome_index: int,
    tool_contract: Any | None = None,
    plan_mode: bool = False,
    read_only: bool = False,
    request_disabled_tools: frozenset[str] = frozenset(),
    session_id: str | None = None,
) -> tuple[list[tuple[Any, int]], int]:
    """Settle calls blocked before dispatch and return executable calls in order.

    An assembled request ``tool_contract`` entry is authoritative when supplied.
    When the contract has no entry, fall back to the MCP client descriptor.
    """
    remaining: list[tuple[Any, int]] = []
    remaining_hidden_names = _remaining_deferred_names(kernel, tool_resolution_context)
    for call in tool_calls:
        kernel._assert_valid_tool_call(call)
        outcome_index += 1
        entry = tool_contract.entry(call.tool_id) if tool_contract is not None else None
        descriptor = entry.descriptor if entry is not None else None

        tool_result: Any | None = None
        if entry is not None and not entry.available and call.tool_id != TOOL_SEARCH_TOOL_NAME:
            if entry.reason == TOOL_NOT_EXPOSED_REASON and entry.deferred:
                tool_result = kernel._build_deferred_outcome(call)
            else:
                tool_result = _blocked_outcome(
                    call,
                    output=_tool_assembly.blocked_tool_message(call.tool_id, entry.reason),
                    error_code=_tool_assembly.blocked_tool_error_code(entry.reason),
                    metadata=_tool_assembly.blocked_tool_metadata(entry.reason),
                )

        if descriptor is None and (read_only or call.coerced):
            descriptor = kernel._mcp_client.tool_descriptor(call.tool_id)

        if (
            tool_result is None
            and read_only
            and descriptor is not None
            and effective_side_effecting(descriptor, call.arguments)
            and not is_plan_artifact_write_eligible(
                descriptor,
                call.tool_id,
                call.arguments,
                plan_mode=plan_mode,
                read_only=read_only,
            )
        ):
            log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.read_only_tool_call_rejected",
                message=(
                    "Rejected side-effecting tool call during a read-only "
                    f"request: {call.tool_id}"
                ),
                status="failure",
                data={"tool": call.tool_id, "code": CMP_MODE_TOOL_BLOCKED},
                request_id=request_id,
                session_id=session_id,
            )
            tool_result = _blocked_outcome(
                call,
                output=(
                    f"Tool '{call.tool_id}' is unavailable because this request "
                    "is read-only."
                ),
                error_code=CMP_MODE_TOOL_BLOCKED,
                metadata={"read_only_blocked": True},
            )

        if (
            tool_result is None
            and entry is None
            and tool_contract is None
            and call.tool_id in request_disabled_tools
        ):
            log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.request_disabled_tool_call_rejected",
                message=f"Rejected model tool call disabled by request preferences: {call.tool_id}",
                status="failure",
                data={"tool": call.tool_id, "code": CMP_TOOL_DISABLED},
                request_id=request_id,
                session_id=session_id,
            )
            tool_result = _blocked_outcome(
                call,
                output=f"Tool '{call.tool_id}' is disabled for this request by tool preferences.",
                error_code=CMP_TOOL_DISABLED,
                metadata={"request_preference_disabled": True},
            )

        if (
            tool_result is None
            and entry is None
            and tool_contract is None
            and call.tool_id != TOOL_SEARCH_TOOL_NAME
            and _is_deferred_tool_call(
                kernel,
                call,
                tool_resolution_context,
                remaining_hidden_names=remaining_hidden_names,
            )
        ):
            tool_result = kernel._build_deferred_outcome(call)

        if (
            tool_result is None
            and call.coerced
            and descriptor is not None
            and effective_side_effecting(descriptor, call.arguments)
        ):
            log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.coerced_args_rejected",
                message=f"Rejected side-effecting tool '{call.tool_id}' with coerced arguments",
                status="failure",
                data={"tool": call.tool_id, "code": CMP_TOOL_COERCED_ARGS_REJECTED},
                request_id=request_id,
                session_id=session_id,
            )
            tool_result = _blocked_outcome(
                call,
                output=(
                    f"Tool '{call.tool_id}' rejected: provider emitted malformed arguments "
                    "for a side-effecting tool."
                ),
                error_code=CMP_TOOL_COERCED_ARGS_REJECTED,
                metadata={
                    "coerced_arguments_rejected": True,
                    "reason": "malformed_side_effecting_arguments",
                },
            )

        if tool_result is None:
            placeholder_reason = _placeholder_arguments_reason(call, descriptor)
            if placeholder_reason is not None:
                log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.placeholder_tool_call_rejected",
                    message=(
                        "Rejected tool call whose arguments are the schema example "
                        f"placeholders: {call.tool_id}"
                    ),
                    status="failure",
                    data={
                        "tool": call.tool_id,
                        "reason": placeholder_reason,
                        "code": CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED,
                    },
                    request_id=request_id,
                    session_id=session_id,
                )
                tool_result = _blocked_outcome(
                    call,
                    output=(
                        f"Tool '{call.tool_id}' was not executed: the arguments are the "
                        "schema example placeholders, not real values. Supply real "
                        "arguments, or if no tool is needed, answer the user directly."
                    ),
                    error_code=CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED,
                    metadata={
                        "placeholder_arguments_rejected": True,
                        "reason": placeholder_reason,
                    },
                )

        if tool_result is None:
            remaining.append((call, outcome_index))
            continue

        _record_filtered_outcome(
            kernel=kernel,
            runtime=runtime,
            result=result,
            request_id=request_id,
            call=call,
            outcome_index=outcome_index,
            tool_result=tool_result,
            outcomes=outcomes,
            working_messages=working_messages,
            iteration_calls=iteration_calls,
            streamed_event_types=streamed_event_types,
        )
    return remaining, outcome_index


def execute_tool_calls_sequentially(  # noqa: PLR0913, PLR0915
    *,
    indexed_calls: list[tuple[Any, int]],
    runtime: Any,
    kernel: Any,
    result: Any,
    request_id: str,
    session_id: str | None,
    tool_resolution_context: Any | None,
    read_snapshot_cache: dict[str, Any],
    outcomes: list[Any],
    working_messages: list[dict[str, object]],
    iteration_calls: list[Any],
    streamed_event_types: set[str],
    tool_payload_ref: list[dict[str, Any]],
    tool_preferences: dict[str, tuple[str, ...]] | None = None,
    request_context: Any | None = None,
    tool_contract: Any | None = None,
    trusted_plan_artifact_write_call_ids: frozenset[str] = frozenset(),
    audit_metadata_by_call: dict[str, dict[str, object]] | None = None,
) -> None:
    """Execute calls once, in model order, preserving every completed outcome."""
    for call, outcome_index in indexed_calls:
        runtime.raise_if_interrupted()
        call_id = loop_event_emit.emit_tool_executing(
            runtime,
            call,
            request_id,
            outcome_index,
        )
        if runtime.streaming:
            streamed_event_types.add("tool.executing")

        try:
            if call.tool_id == TOOL_SEARCH_TOOL_NAME:
                tool_result = kernel._execute_tool_search(
                    call,
                    resolution_context=tool_resolution_context,
                    runtime=runtime,
                )
                tool_payload_ref[:] = kernel._build_tool_payload(
                    tool_resolution_context,
                    tool_preferences=tool_preferences,
                    request_context=request_context,
                )
                if runtime.remaining_tool_calls == 0:
                    tool_payload_ref.clear()
            else:
                trusted_execution_kwargs = {}
                if (
                    tool_policy_call_key(call)
                    in trusted_plan_artifact_write_call_ids
                ):
                    trusted_execution_kwargs["trusted_plan_artifact_write"] = True
                tool_result = kernel._execute_tool(
                    call,
                    request_id=request_id,
                    session_id=session_id,
                    read_snapshot_cache=read_snapshot_cache,
                    tool_contract=tool_contract,
                    audit_metadata=(audit_metadata_by_call or {}).get(
                        tool_policy_call_key(call)
                    ),
                    runtime=runtime,
                    **trusted_execution_kwargs,
                )
        except _tool_contracts.ToolExecutionFailure as exc:
            failure_metadata: dict[str, object] = {
                key: value for key, value in exc.to_error_data().items()
            }
            log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.tool_execution_recovered",
                message=exc.message,
                status="recovered",
                data={
                    "tool": call.tool_id,
                    "code": exc.code,
                    "error_message": exc.message,
                    "request_id": request_id,
                    "path": "sequential",
                },
                request_id=request_id,
                session_id=session_id,
            )
            failure_output = f"Tool '{call.tool_id}' failed: {exc.message}."
            if (
                getattr(
                    getattr(kernel, "_config", None),
                    "tool_result_envelope_enabled",
                    False,
                )
                is not True
            ):
                failure_output += (
                    " Review the error and retry with corrected arguments if applicable."
                )
            tool_result = _blocked_outcome(
                call,
                output=failure_output,
                error_code=exc.code,
                metadata=failure_metadata,
            )

        outcomes.append(tool_result)
        loop_event_emit.emit_tool_result(runtime, tool_result, call_id)
        if runtime.streaming:
            streamed_event_types.add("tool.result")
        # Cancellation is observed after the completed result has been paired
        # with its executing event, so a finished tool never becomes an orphan.
        runtime.raise_if_interrupted()

        kernel._update_read_snapshot_cache(
            read_snapshot_cache,
            tool_name=tool_result.tool_name,
            success=tool_result.success,
            metadata=tool_result.metadata,
        )
        working_messages.append(kernel._assistant_tool_call_message(result, call))
        working_messages.append(kernel._tool_result_message(call, tool_result))
        iteration_calls.append(call)


__all__ = [
    "execute_tool_calls_sequentially",
    "pre_filter_tool_calls",
]


APPROVAL_WINDOW_DROPPED_OUTPUT_TEMPLATE = (
    "Tool '{tool_id}' was not executed: it was not part of the approved "
    "execution window for this turn. Re-request it if it is still needed."
)


def settle_dropped_tool_calls(  # noqa: PLR0913 — mirrors the filtered-outcome recorder.
    *,
    kernel: Any,
    runtime: Any,
    result: Any,
    request_id: str,
    session_id: str | None,
    dropped_calls: Sequence[Any],
    outcomes: list[Any],
    working_messages: list[dict[str, Any]],
    iteration_calls: list[Any],
    streamed_event_types: set[str],
) -> int:
    """Give every admitted-but-unexecuted tool call an explicit terminal outcome.

    Approval resume executes only the approved window; the remaining calls in
    the frozen plan were still reserved against the turn tool budget. Settling
    them here keeps budget accounting consistent (every reserved call has a
    terminal row) instead of silently discarding them.
    """

    if not dropped_calls:
        return 0

    outcome_index = len(outcomes)
    for call in dropped_calls:
        outcome_index += 1
        _record_filtered_outcome(
            kernel=kernel,
            runtime=runtime,
            result=result,
            request_id=request_id,
            call=call,
            outcome_index=outcome_index,
            tool_result=_blocked_outcome(
                call,
                output=APPROVAL_WINDOW_DROPPED_OUTPUT_TEMPLATE.format(
                    tool_id=str(getattr(call, "tool_id", "") or "")
                ),
                error_code=CMP_TOOL_APPROVAL_WINDOW_DROPPED,
                metadata={"approval_window_dropped": True},
            ),
            outcomes=outcomes,
            working_messages=working_messages,
            iteration_calls=iteration_calls,
            streamed_event_types=streamed_event_types,
        )
    log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.approval_window_calls_dropped",
        message="Settled reserved tool calls that fell outside the approved window.",
        status="blocked",
        data={
            "dropped_count": len(dropped_calls),
            "code": CMP_TOOL_APPROVAL_WINDOW_DROPPED,
            "tools": [str(getattr(call, "tool_id", "") or "") for call in dropped_calls],
        },
        request_id=request_id,
        session_id=session_id,
    )
    return len(dropped_calls)


def prevalidate_call_arguments(
    *,
    kernel: Any,
    call: Any,
    tool_contract: Any | None,
) -> dict[str, Any] | None:
    """Schema-validate a call BEFORE the approval gate.

    Dispatch validates too, but dispatch runs AFTER the user has already
    answered the approval prompt. For an ordinary tool that only wastes a
    click; for ``exit_plan_mode`` it stranded a live turn — the user approved a
    plan and the very same arguments were then rejected, discarding the
    proposal they had just accepted. Returning the failure here lets the caller
    record a recoverable per-call outcome, carrying the same repair hints
    dispatch would have produced, without ever interrupting the user.

    Returns ``None`` when the call is valid or not ours to validate.
    ``delegate`` is exempt: its own validator normalizes aliases that the raw
    schema would reject.
    """
    if call.tool_id == "delegate":
        return None
    entry = tool_contract.entry(call.tool_id) if tool_contract is not None else None
    if entry is not None and not entry.available:
        return None
    descriptor = (
        entry.descriptor
        if entry is not None
        else kernel._mcp_client.tool_descriptor(call.tool_id)
    )
    if descriptor is None or (
        call.coerced and not effective_side_effecting(descriptor, call.arguments)
    ):
        return None
    try:
        _tool_support.validate_tool_arguments(
            tool_name=call.tool_id,
            arguments=call.arguments,
            input_schema=descriptor.input_schema,
        )
    except _tool_contracts.ToolExecutionFailure as error:
        repair_hints = _tools_schema_examples.tool_schema_repair_hints(descriptor.input_schema)
        return {
            "message": (
                f"Tool '{call.tool_id}' rejected malformed arguments: "
                f"{error.message}.{_tools_schema_examples.tool_schema_hint_text(repair_hints)}"
            ),
            "metadata": {
                "validation_error": error.message,
                "required_keys": repair_hints["required_keys"],
                "minimal_valid_arguments": repair_hints["minimal_valid_arguments"],
            },
        }
    return None
