"""The chat.send request path for the request-dispatch runtime hub.

Owns ``process_chat_send_request`` — the full chat.send orchestration: accept-version
+ semantic validation, workspace-root preflight, the
pre-approval build, the interactive approval round-trip, and the approved resume.

Import direction is strictly one-way: this module imports the non-patched helpers it
needs from ``request_dispatch_chat_support`` and is imported/re-exported by the
``request_dispatch`` hub. It never imports the hub at module level (only
function-local, late-bound as ``_rd_hub``) to avoid a circular import. Patch targets
that tests set on the ``sidecar.runtime.request_dispatch`` module object
(``build_chat_send_response``, ``request_tool_approval``, ``_build_chat_response``,
``_chat_unexpected_failure_outcome``, ``is_feature_flag_enabled``, ``policy_for_mode``,
``log_event``, ``_APPROVAL_PLAN_CACHE``) are resolved late
through ``_rd_hub`` so the monkeypatch surface stays intact.
"""

from __future__ import annotations

import logging
from copy import copy
from dataclasses import replace
from functools import wraps
from time import monotonic, perf_counter
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import (
    CMP_CFG_WORKSPACE_MISSING,
    CMP_CHAT_INVALID_PARAMS,
    CMP_CHAT_STREAM_FAILED,
    CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT,
    CMP_PROTO_VERSION_MISMATCH,
    CMP_RESOURCE_EXCEEDED,
)
from sidecar.ai.feature_flags import (
    FEATURE_CANONICAL_TURN_EVENTS,
    FEATURE_PHASE_EVENTS,
)
from sidecar.ai.routing.iteration_limits import effective_max_tools_per_turn
from sidecar.ai.routing.loop_events import (
    ApprovalRequestedEvent,
    ApprovalResolvedEvent,
    PhaseCompletedEvent,
    PhaseStartedEvent,
)
from sidecar.ai.routing.plan_mode_transition import context_with_plan_decision
from sidecar.ai.tools.workspace_retention import touch_workspace_active_use
from sidecar.protocol import CHAT_SEND_METHOD
from sidecar.runtime.approval import ApprovalResolution
from sidecar.runtime.approval_plan import ApprovalPlanCacheCapacityError
from sidecar.runtime.chat import (
    ChatRequestError,
    chat_error_notification,
    request_id_from_params,
    session_id_from_params,
    trace_id_from_params,
)
from sidecar.runtime.chat_helpers import emit_approval_rejection
from sidecar.runtime.chat_tool_observations import (
    chat_result_with_tool_observations,
)
from sidecar.runtime.diagnostics import diagnostics_context
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.outcomes import ProcessOutcome, chat_error_outcome
from sidecar.runtime.request_dispatch_chat_support import (
    _approval_terminal_log_fields,
    _build_plugin_workflow_response,
    _emit_canonical_notification,
    _emit_phase_notification,
    _normalize_approval_resolution,
    _post_approval_retryable_terminal_outcome,
    _request_tool_preference_set,
    _validate_chat_send_semantics,
    _workspace_required_tool_names,
    _workspace_root_configured,
)
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version
from sidecar.runtime.turn_retry import InnerRetryableTurnError
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
    TERMINAL_SUBCODE_TIMEOUT_APPROVAL,
    TURN_STATE_CANCELLED,
    TURN_STATE_DENIED,
    TURN_STATE_PREEMPTED,
    TURN_STATE_RUNTIME_ERROR,
    TURN_STATE_TIMEOUT,
    build_turn_result,
)


def _context_with_plan_approval(context: Any, resolution: ApprovalResolution) -> Any:
    return replace(
        context_with_plan_decision(context, resolution.decision, resolution.feedback),
        edited_plan=resolution.edited_plan,
    )


INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
CHAT_STREAM_FAILED = CMP_CHAT_STREAM_FAILED
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH
# Default-arg value for ``approval_timeout_seconds`` below. Defined here (not routed
# through ``_rd_hub``) because a parameter default is evaluated at import time and
# cannot use the function-local hub import; it mirrors the hub's own literal (and
# server.py's independent copy) and is never a monkeypatch target, so binding it at
# module load is byte-identical.
TOOL_APPROVAL_TIMEOUT_SECONDS = 600.0
MAX_REASON_CODE_LENGTH = 64


def _effective_approval_wait_timeout(
    approval_plan: Any,
    *,
    configured_timeout_seconds: float,
) -> float:
    """Return the human-interaction window, independent of model work time."""

    del approval_plan
    return max(0.0, float(configured_timeout_seconds))


def _credit_approval_wait(plan: Any, wait_seconds: float) -> Any:
    """Return *plan* with one approval round credited back to its deadline."""

    deadline = getattr(plan, "wall_clock_deadline", None)
    if deadline is None:
        return plan
    try:
        credited_deadline = float(deadline) + max(0.0, float(wait_seconds))
    except (TypeError, ValueError, OverflowError):
        return plan
    try:
        return replace(plan, wall_clock_deadline=credited_deadline)
    except TypeError:
        try:
            copied_plan = copy(plan)
            copied_plan.wall_clock_deadline = credited_deadline
        except (AttributeError, TypeError):
            return plan
        return copied_plan


def _with_stack_generation_lease(func: Callable[..., ProcessOutcome]) -> Callable[..., ProcessOutcome]:
    @wraps(func)
    def wrapped(*args: Any, **kwargs: Any) -> ProcessOutcome:
        brain_container = kwargs.get("brain_container")
        lease = getattr(brain_container, "stack_lease", None)
        if not callable(lease):
            return func(*args, **kwargs)
        with lease():
            return func(*args, **kwargs)

    return wrapped


def _with_plugin_runtime_admission(
    func: Callable[..., ProcessOutcome],
) -> Callable[..., ProcessOutcome]:
    @wraps(func)
    def wrapped(*args: Any, **kwargs: Any) -> ProcessOutcome:
        brain_container = kwargs.get("brain_container")
        params = kwargs.get("params")
        initialized = kwargs.get("initialized", False)
        message_id = kwargs.get("message_id")
        admission = kwargs.pop("plugin_runtime_admission", None)
        if admission is None:
            raw_authority = (
                params.get("plugin_runtime_authority") if isinstance(params, dict) else None
            )
            admit_runtime = getattr(brain_container, "admit_plugin_runtime", None)
            if not callable(admit_runtime):
                return func(*args, **kwargs)
            try:
                admission = admit_runtime(raw_authority)
            except Exception as error:  # noqa: BLE001 - normalized cross-boundary refusal
                code = str(getattr(error, "code", CMP_CHAT_INVALID_PARAMS))
                reason = str(getattr(error, "reason_code", "plugin_authority_invalid"))
                safe_reason = (
                    reason
                    if reason.replace("_", "").isalnum()
                    and len(reason) <= MAX_REASON_CODE_LENGTH
                    else "plugin_authority_invalid"
                )
                return ProcessOutcome(
                    initialized=bool(initialized),
                    shutdown_requested=False,
                    response=error_response(
                        message_id,
                        code=INVALID_PARAMS_CODE,
                        message="chat.send plugin runtime authority rejected",
                        data={
                            "code": code,
                            "reason": safe_reason,
                            "retryable": getattr(error, "retryable", False) is True,
                        },
                    ),
                    notifications=[],
                )
        try:
            with admission.bind():
                raw_invocation = params.get("plugin_command_invocation") if isinstance(params, dict) else None
                if raw_invocation is not None:
                    try:
                        registry_factory = getattr(brain_container, "_plugin_registry", None)
                        if not callable(registry_factory):
                            raise RuntimeError("plugin registry unavailable")
                        registry = registry_factory()
                        kwargs["plugin_command_resolution"] = registry.resolve_command(raw_invocation)
                    except Exception as error:  # noqa: BLE001 - normalized command authority refusal
                        code = str(getattr(error, "code", CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT))
                        reason = str(getattr(error, "reason_code", "plugin_command_authority_mismatch"))
                        safe_reason = reason if reason.replace("_", "").isalnum() and len(reason) <= MAX_REASON_CODE_LENGTH else "plugin_command_authority_mismatch"
                        return ProcessOutcome(
                            initialized=bool(initialized), shutdown_requested=False,
                            response=error_response(message_id, code=INVALID_PARAMS_CODE,
                                message="chat.send plugin command invocation rejected",
                                data={"code": code, "reason": safe_reason, "retryable": False}),
                            notifications=[],
                        )
                return func(*args, **kwargs)
        finally:
            admission.release()

    return wrapped


@_with_plugin_runtime_admission
@_with_stack_generation_lease
def process_chat_send_request(
    *,
    message_id: Any,
    params: Any,
    initialized: bool,
    interactive_approval: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
    write_message: Callable[[dict[str, Any]], None],
    read_message: Callable[[], dict[str, Any]],
    approval_response_reader: Callable[[float], dict[str, Any]] | None = None,
    approval_response_waiter_factory: Callable[
        [int, TurnCancellationHandle | None],
        Callable[[float], dict[str, Any]],
    ]
    | None = None,
    approval_timeout_seconds: float = TOOL_APPROVAL_TIMEOUT_SECONDS,
    stream_notifications: bool = False,
    cancel_handle: TurnCancellationHandle | None = None,
    plugin_command_resolution: Any | None = None,
) -> ProcessOutcome:
    import sidecar.runtime.request_dispatch as _rd_hub

    request_id = request_id_from_params(params, message_id)
    trace_id = trace_id_from_params(params, message_id)
    session_id = session_id_from_params(params)
    # WO-26: best-effort, additive -- advances workspace-recovery active-use
    # retention accounting from the optional `workspace_active_use_seconds`
    # field. No-ops entirely when the field, workspace root, or recovery root
    # is absent; never raises into the chat.send response.
    touch_workspace_active_use(brain_container, params)
    started_at = perf_counter()
    phase_events_enabled = _rd_hub.is_feature_flag_enabled(
        getattr(brain_container.stack.config, "feature_flags", {}) or {},
        FEATURE_PHASE_EVENTS,
    )
    canonical_turn_events_enabled = _rd_hub.is_feature_flag_enabled(
        getattr(brain_container.stack.config, "feature_flags", {}) or {},
        FEATURE_CANONICAL_TURN_EVENTS,
    )
    canonical_seq_state = {"seq": 0}

    if plugin_command_resolution is not None and plugin_command_resolution.target.kind == "prompt":
        from sidecar.ai.plugins.workflow_interpreter import render_prompt_command

        rendered = render_prompt_command(plugin_command_resolution)
        params = dict(params)
        messages = [dict(item) for item in params.get("messages", [])]
        if messages and messages[-1].get("role") == "user":
            messages[-1]["content"] = rendered
        else:
            messages.append({"role": "user", "content": rendered})
        params["messages"] = messages

    version_error = validate_accept_version(
        method=CHAT_SEND_METHOD,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
    )
    if version_error is not None:
        mismatch_error = ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=PROTOCOL_VERSION_MISMATCH,
            message="chat.send accept_version is incompatible with sidecar api_version",
            rpc_code=INVALID_PARAMS_CODE,
            retryable=False,
        )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=version_error,
            notifications=[chat_error_notification(mismatch_error)],
        )

    semantic_error = _validate_chat_send_semantics(params=params, message_id=message_id)
    if semantic_error is not None:
        return chat_error_outcome(
            initialized=initialized,
            message_id=message_id,
            error=semantic_error,
            error_response=error_response,
            chat_error_notification=chat_error_notification,
        )

    # Preflight for tools_workspace_root.
    #
    # Tools that require a workspace root are ALREADY dropped from the model's tool
    # list when no root is configured (sidecar/ai/tools/assembly.py), so a turn with
    # tools enabled but no root degrades gracefully on its own — the model answers
    # without those tools. We therefore do NOT hard-fail the common case (default
    # config, no root yet); a fresh "Skip setup" first message must still get an
    # answer, not a config error. The only case worth failing fast is when the
    # request EXPLICITLY narrowed tooling (tool_preferences.enabled_tools) to a set
    # that is entirely workspace-requiring: degrading would then leave the model none
    # of the tools the user asked for, so a clear "set a workspace root" card (the
    # CMP-CFG setup recovery class) beats a silently tool-less answer.
    mode = str(params.get("mode") or "").strip().lower()
    policy = _rd_hub.policy_for_mode(mode)
    config = brain_container.stack.config
    tools_enabled = getattr(config, "tools_enabled", True)
    if isinstance(tools_enabled, str):
        tools_enabled = tools_enabled.strip().lower() in {"true", "1", "yes"}
    else:
        tools_enabled = bool(tools_enabled)

    if policy.allow_tools and tools_enabled and not _workspace_root_configured(config):
        tool_preferences = params.get("tool_preferences")
        requested_tools = _request_tool_preference_set(tool_preferences, "enabled_tools")
        # Only the explicit-allowlist case can hard-fail, so the hard-fail check itself
        # short-circuits (and skips the catalog build) on the common degrade path where
        # no tools were named.
        if requested_tools and requested_tools <= _workspace_required_tool_names(
            config=config, mode=mode
        ):
            workspace_error = ChatRequestError(
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                code=CMP_CFG_WORKSPACE_MISSING,
                message=(
                    "Every enabled tool requires a workspace root, but none is "
                    "configured. Set a workspace root in Settings, then try again."
                ),
                rpc_code=INVALID_PARAMS_CODE,
                retryable=False,
            )
            return chat_error_outcome(
                initialized=initialized,
                message_id=message_id,
                error=workspace_error,
                error_response=error_response,
                chat_error_notification=chat_error_notification,
            )

        # Legibility signal for the graceful degrade (NOT an error). The contract
        # assembly silently drops every workspace-requiring tool from the model's list
        # (sidecar/ai/tools/assembly.py -> WORKSPACE_REQUIRED_REASON), so file/terminal
        # tools just do nothing this turn with no trace of why. Name the dropped tools
        # — mode policy, config flags, and the request's enabled/disabled prefs applied,
        # i.e. exactly what the assembly drops — and emit a structured, informational
        # telemetry event so an automation driver or a user reading the Activity Log can
        # tell WHY. Building the catalog here is cheap (the tool manifest is cached) and
        # only runs while no root is configured. The paired user-facing remediation is
        # the composer workspace-degrade signal (set a workspace root in Settings); this
        # is the diagnostic record, so there is deliberately no extra inline notice and
        # no CMP code.
        dropped_workspace_tools = _workspace_required_tool_names(
            config=config, mode=mode, tool_preferences=tool_preferences
        )
        if dropped_workspace_tools:
            _rd_hub.log_event(
                logger,
                logging.WARNING,
                component="runtime.request_dispatch",
                event="sidecar.runtime.tools.workspace_degraded",
                message=(
                    "Workspace-requiring tools dropped this turn because no workspace "
                    "root is configured; answering without them."
                ),
                status="degraded",
                trace_id=trace_id,
                request_id=request_id,
                session_id=session_id,
                data={
                    "dropped_count": len(dropped_workspace_tools),
                    "dropped_tools": sorted(dropped_workspace_tools),
                    "reason": "no workspace root configured",
                },
            )

    if message_id is None:
        _rd_hub.log_event(
            logger,
            logging.WARNING,
            component="runtime.request_dispatch",
            event="sidecar.runtime.chat_send.ignored",
            message="chat.send ignored because id is missing",
            status="invalid",
            data={"interactive_approval": interactive_approval},
            trace_id=trace_id,
            request_id=request_id,
            session_id=session_id,
        )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=None,
            notifications=[],
        )

    if cancel_handle is not None and cancel_handle.cancelled:
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                build_turn_result(
                    request_id=request_id,
                    status=TURN_STATE_CANCELLED,
                    terminal_subcode=getattr(cancel_handle, "reason", None),
                ),
            ),
            notifications=[],
        )

    with (
        diagnostics_context(trace_id=trace_id, request_id=request_id, session_id=session_id),
        brain_container.request_boundary(
            "chat.send",
            request_id=request_id,
            session_id=session_id,
        ),
    ):
        _rd_hub.log_event(
            logger,
            logging.INFO,
            component="runtime.request_dispatch",
            event="sidecar.runtime.chat_send.start",
            message="Processing chat.send request",
            status="start",
            data={"interactive_approval": interactive_approval},
        )
        try:
            if plugin_command_resolution is not None and plugin_command_resolution.target.kind == "workflow":
                chat_response = _build_plugin_workflow_response(
                    resolution=plugin_command_resolution, brain_container=brain_container,
                    params=params, request_id=request_id, trace_id=trace_id,
                    session_id=session_id or "", write_message=write_message,
                    read_message=read_message, stream_notifications=stream_notifications,
                    approval_response_reader=approval_response_reader,
                    approval_response_waiter_factory=approval_response_waiter_factory,
                    approval_timeout_seconds=approval_timeout_seconds,
                    cancel_handle=cancel_handle, logger=logger,
                )
            else:
                chat_response = _rd_hub._build_chat_response(
                    message_id=message_id,
                    params=params,
                    # INVARIANT (W4.2, 2026-06-10): when interactive approval is on,
                    # the FIRST pass always runs with approvals_pre_granted=False —
                    # side-effecting tools detour through ApprovalPlanCache and the
                    # approval/resume round-trip (approvals_pre_granted=True only on
                    # the approved resume below); read-only tools run inline as
                    # approvalState 'auto'. This is the intended approval
                    # architecture, not a missed enablement.
                    approvals_pre_granted=not interactive_approval,
                    brain_container=brain_container,
                    stream_notifications=stream_notifications,
                    write_message=write_message,
                    read_message=read_message,
                    canonical_seq_state=canonical_seq_state,
                    approval_response_reader=approval_response_reader,
                    approval_response_waiter_factory=approval_response_waiter_factory,
                    approval_timeout_seconds=approval_timeout_seconds,
                    cancel_handle=cancel_handle,
                    approval_plan=None,
                    canonical_session_messages=(
                        params.get("canonical_session_messages") if isinstance(params, dict) else None
                    ),
                    session_title=(
                        str(params.get("session_title") or "").strip()
                        if isinstance(params, dict)
                        else ""
                    ),
                )
        except ChatRequestError as error:
            return chat_error_outcome(
                initialized=initialized,
                message_id=message_id,
                error=error,
                error_response=error_response,
                chat_error_notification=chat_error_notification,
            )
        except Exception:  # noqa: BLE001
            return _rd_hub._chat_unexpected_failure_outcome(
                initialized=initialized,
                message_id=message_id,
                params=params,
                message="chat.send failed while preparing response",
                logger=logger,
            )

        # A turn can need MORE than one approval: the resumed leg may reach a
        # second tool that also requires one. This was an `if`, so the second
        # request was built, attached to the response, and then dropped on the
        # floor -- chat_resume.py returns status "awaiting_approval" for exactly
        # that case, and the dispatcher had already fallen past this block. The
        # turn then ended carrying a status nobody consumes. Looping keeps the
        # approval protocol where it already works instead of teaching Electron
        # a second way to be asked.
        #
        # Bounded by the turn's own tool budget rather than an invented
        # constant: one approval can only ever precede one tool call, so a turn
        # cannot legitimately need more approval rounds than it is allowed tool
        # calls. Exhausting the bound falls out of the loop into the existing
        # terminal, which reports the pending-approval stop honestly.
        approval_round = 0
        max_approval_rounds = max(
            effective_max_tools_per_turn(brain_container.stack.config), 1
        )
        while (
            interactive_approval
            and chat_response.approval_request is not None
            and approval_round < max_approval_rounds
        ):
            approval_round += 1
            approval_plan = chat_response.approval_plan
            approval_wait_timeout = _effective_approval_wait_timeout(
                approval_plan,
                configured_timeout_seconds=approval_timeout_seconds,
            )
            call_id = str(chat_response.approval_request.get("tool_call_id") or "").strip()
            approval_tool_name = (
                str(chat_response.approval_request.get("tool_name") or "").strip() or None
            )
            approval_summary = str(chat_response.approval_request.get("reason") or "").strip()
            approval_phase_id = f"phase_approval_wait_{request_id}_{call_id or 'pending'}"
            if approval_plan is not None and call_id and approval_wait_timeout > 0:
                try:
                    _rd_hub._APPROVAL_PLAN_CACHE.put(
                        approval_plan,
                        ttl_seconds=approval_wait_timeout,
                    )
                except ApprovalPlanCacheCapacityError as cache_error:
                    _rd_hub.log_event(
                        logger,
                        logging.ERROR,
                        component="runtime.request_dispatch",
                        event="runtime.approval_plan_cache.capacity_rejected",
                        message="Approval plan exceeded the bounded in-memory cache.",
                        status="rejected",
                        data={
                            "size_bytes": cache_error.size_bytes,
                            "limit_bytes": cache_error.limit_bytes,
                        },
                        request_id=request_id,
                        session_id=session_id,
                    )
                    chat_error = ChatRequestError(
                        request_id=request_id,
                        trace_id=trace_id,
                        session_id=session_id,
                        code=CMP_RESOURCE_EXCEEDED,
                        message="Approval context exceeded the sidecar memory limit.",
                        rpc_code=INTERNAL_ERROR_CODE,
                        retryable=False,
                    )
                    return chat_error_outcome(
                        initialized=initialized,
                        message_id=message_id,
                        error=chat_error,
                        error_response=error_response,
                        chat_error_notification=chat_error_notification,
                    )
            read_approval_response = approval_response_reader or (lambda _timeout: read_message())
            _emit_phase_notification(
                enabled=phase_events_enabled,
                writer=write_message,
                event=PhaseStartedEvent(
                    phase_id=approval_phase_id,
                    phase_kind="approval_wait",
                    iteration=approval_round - 1,
                    tool_call_id=call_id or None,
                    tool_name=approval_tool_name,
                    summary=approval_summary or "Waiting for approval",
                ),
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                canonical_enabled=canonical_turn_events_enabled,
                canonical_seq_state=canonical_seq_state,
            )
            _emit_canonical_notification(
                enabled=canonical_turn_events_enabled,
                writer=write_message,
                event=ApprovalRequestedEvent(
                    call_id=call_id,
                    tool_name=approval_tool_name,
                    summary=approval_summary or "Waiting for approval",
                    approval_plan_hash=(
                        str(getattr(approval_plan, "approval_plan_hash", "") or "").strip()
                        if approval_plan is not None
                        else None
                    ),
                ),
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                canonical_seq_state=canonical_seq_state,
            )
            approval_wait_started_at = monotonic()
            try:
                raw_approval_resolution = _rd_hub.request_tool_approval(
                    chat_response.approval_request,
                    write_message=write_message,
                    read_message=read_approval_response,
                    response_reader_factory=approval_response_waiter_factory,
                    timeout_seconds=approval_wait_timeout,
                    logger=logger,
                    cancel_handle=cancel_handle,
                )
            finally:
                approval_wait_seconds = max(0.0, monotonic() - approval_wait_started_at)
            approval_resolution = _normalize_approval_resolution(raw_approval_resolution)
            if (
                approval_tool_name != "exit_plan_mode"
                and approval_resolution.decision in {"approved_auto", "rejected"}
            ):
                approval_resolution = ApprovalResolution(
                    approved=False,
                    status="malformed",
                )
            _emit_phase_notification(
                enabled=phase_events_enabled,
                writer=write_message,
                event=PhaseCompletedEvent(
                    phase_id=approval_phase_id,
                    phase_kind="approval_wait",
                    iteration=approval_round - 1,
                    tool_call_id=call_id or None,
                    tool_name=approval_tool_name,
                    summary="Approval resolved",
                ),
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                canonical_enabled=canonical_turn_events_enabled,
                canonical_seq_state=canonical_seq_state,
            )
            _emit_canonical_notification(
                enabled=canonical_turn_events_enabled,
                writer=write_message,
                event=ApprovalResolvedEvent(
                    call_id=call_id,
                    approved=approval_resolution.approved,
                    status=approval_resolution.status,
                    tool_name=approval_tool_name,
                    approval_plan_hash=(
                        str(getattr(approval_plan, "approval_plan_hash", "") or "").strip()
                        if approval_plan is not None
                        else None
                    ),
                ),
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
                canonical_seq_state=canonical_seq_state,
            )
            if not approval_resolution.approved:
                terminal_status = TURN_STATE_DENIED
                terminal_subcode: str | None = TERMINAL_SUBCODE_DENIED_USER_EXPLICIT
                if approval_resolution.status == TURN_STATE_TIMEOUT:
                    terminal_status = TURN_STATE_TIMEOUT
                    terminal_subcode = TERMINAL_SUBCODE_TIMEOUT_APPROVAL
                elif approval_resolution.status == TURN_STATE_CANCELLED:
                    terminal_status = TURN_STATE_CANCELLED
                    terminal_subcode = None
                elif approval_resolution.status == TURN_STATE_PREEMPTED:
                    terminal_status = TURN_STATE_PREEMPTED
                    terminal_subcode = None
                elif approval_resolution.status == TURN_STATE_RUNTIME_ERROR:
                    terminal_status = TURN_STATE_RUNTIME_ERROR
                    terminal_subcode = None
                if call_id:
                    _rd_hub._APPROVAL_PLAN_CACHE.evict(request_id, call_id)
                log_event_name, log_message = _approval_terminal_log_fields(terminal_status)
                _rd_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="runtime.request_dispatch",
                    event=log_event_name,
                    message=log_message,
                    status=terminal_status,
                    duration_ms=(perf_counter() - started_at) * 1000.0,
                    data={
                        **({"terminal_subcode": terminal_subcode} if terminal_subcode else {}),
                    },
                )
                rejection_notifications: list[dict[str, Any]] = []
                if terminal_status == TURN_STATE_DENIED:
                    rejection_notifications.append(
                        emit_approval_rejection(
                            runtime=None,
                            request_id=chat_response.request_id,
                            trace_id=trace_id,
                            session_id=session_id,
                            tool_name=approval_tool_name or call_id or "tool",
                            tool_call_id=call_id or None,
                            observation_store=getattr(
                                brain_container.stack, "tool_observations", None
                            ),
                        )
                    )
                turn_result = build_turn_result(
                    request_id=chat_response.request_id,
                    status=terminal_status,
                    terminal_subcode=terminal_subcode,
                )
                # Phase 6 Q19: ship the just-recorded
                # ``KIND_USER_APPROVAL_REJECTED`` row alongside the denied
                # turn result so the Electron promotion bridge can emit
                # ``approval.gap_resolved`` on the canonical
                # ``approval_resolved`` event.
                turn_result = chat_result_with_tool_observations(
                    turn_result,
                    brain_container.stack,
                    request_id=chat_response.request_id,
                )
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=result_response(message_id, turn_result),
                    notifications=rejection_notifications,
                )

            try:
                cached_plan = _rd_hub._APPROVAL_PLAN_CACHE.consume(request_id, call_id) if call_id else None
                if cached_plan is None:
                    raise ChatRequestError(
                        request_id=request_id,
                        trace_id=trace_id,
                        session_id=session_id,
                        code=CHAT_STREAM_FAILED,
                        message="Approval plan cache miss after approval (sidecar_crash_pre_approval).",
                        rpc_code=INTERNAL_ERROR_CODE,
                        retryable=False,
                    )
                cached_plan = _credit_approval_wait(cached_plan, approval_wait_seconds)
                if approval_tool_name == "exit_plan_mode":
                    cached_plan = replace(
                        cached_plan,
                        request_context=_context_with_plan_approval(
                            cached_plan.request_context, approval_resolution
                        ),
                    )
                chat_response = _rd_hub._build_chat_response(
                    message_id=message_id,
                    params=params,
                    approvals_pre_granted=True,
                    brain_container=brain_container,
                    stream_notifications=stream_notifications,
                    write_message=write_message,
                    read_message=read_message,
                    canonical_seq_state=canonical_seq_state,
                    approval_response_reader=approval_response_reader,
                    approval_response_waiter_factory=approval_response_waiter_factory,
                    approval_timeout_seconds=approval_timeout_seconds,
                    cancel_handle=cancel_handle,
                    approval_plan=cached_plan,
                    canonical_session_messages=(
                        params.get("canonical_session_messages")
                        if isinstance(params, dict)
                        else None
                    ),
                    session_title=(
                        str(params.get("session_title") or "").strip()
                        if isinstance(params, dict)
                        else ""
                    ),
                )
            except ChatRequestError as error:
                return chat_error_outcome(
                    initialized=initialized,
                    message_id=message_id,
                    error=error,
                    error_response=error_response,
                    chat_error_notification=chat_error_notification,
                )
            except InnerRetryableTurnError as error:
                terminal_outcome = _post_approval_retryable_terminal_outcome(
                    initialized=initialized,
                    message_id=message_id,
                    request_id=request_id,
                    error=error,
                )
                if terminal_outcome is not None:
                    return terminal_outcome
                return _rd_hub._chat_unexpected_failure_outcome(
                    initialized=initialized,
                    message_id=message_id,
                    params=params,
                    message="chat.send failed after tool approval",
                    logger=logger,
                )
            except Exception:  # noqa: BLE001
                return _rd_hub._chat_unexpected_failure_outcome(
                    initialized=initialized,
                    message_id=message_id,
                    params=params,
                    message="chat.send failed after tool approval",
                    logger=logger,
                )

        tool_notification_count = sum(
            1
            for item in chat_response.notifications
            if item.get("method") in {"tool.executing", "tool.result"}
        )
        _rd_hub.log_event(
            logger,
            logging.INFO,
            component="runtime.request_dispatch",
            event="sidecar.runtime.chat_send.complete",
            message="chat.send request completed",
            status=str(chat_response.result.get("status", "completed")),
            duration_ms=(perf_counter() - started_at) * 1000.0,
            data={
                "notification_count": len(chat_response.notifications),
                "tool_notification_count": tool_notification_count,
                "approval_requested": chat_response.approval_request is not None,
            },
        )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(message_id, chat_response.result),
            notifications=chat_response.notifications,
            post_settlement_callback=chat_response.post_settlement_callback,
        )
