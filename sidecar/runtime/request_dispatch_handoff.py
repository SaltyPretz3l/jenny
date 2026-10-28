"""``handoff.generate_note`` method dispatch: a one-shot, off-transcript handoff note.

The ``/handoff`` command lets the user continue a chat in a new one. Electron
owns canonical history, so the request carries the same prepared history it
sends for ``chat.compact``; the handler writes a short five-section note from
it with ONE bounded generation on the compaction generator (the canonical
stream path, with the session's inference admission and the auxiliary worker's
cancel handle) and replies with the note. Nothing is persisted, no
notification is emitted, and the note never enters the transcript.

An optional ``focus_project: {"name": str}`` (row 73, a handoff from the primary
Jenny chat) scopes the note to that one project; a malformed one is invalid params.

Never-raises result contract (beyond the version / not-initialized /
inference_context errors, which mirror ``chat.compact``):
- ``{"status": "ok", "note": str, "transcript_truncated": bool}``
- ``{"status": "error", "reason": "no_history" | "generation_failed" | "note_invalid",
  "detail": str}`` (``detail`` optional, sanitized, at most 300 characters)

An inference admission refusal and a ``chat.cancel`` of the auxiliary request
propagate to the worker, which answers them like every inference-family method.
"""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from typing import Any, Callable

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.container import BrainContainer
from sidecar.ai.context.compaction_prompts import format_messages_block
from sidecar.ai.context.handoff_note import (
    build_handoff_note_messages,
    clip_history_for_note,
    handoff_framing_text,
    handoff_note_prompt,
    normalize_focus_project_name,
    parse_handoff_note,
)
from sidecar.ai.context.token_budget import apply_budget_check
from sidecar.ai.engines.admitted import InferenceAdmissionError
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.ai.feature_flags import FEATURE_PROMPT_CACHE, is_feature_flag_enabled
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.protocol import HANDOFF_GENERATE_NOTE_METHOD
from sidecar.runtime.diagnostics import log_event, sanitize_diagnostic_text
from sidecar.runtime.inference_admission import (
    bound_auxiliary_cancel_handle,
    build_auxiliary_inference_admission_callback,
    inference_context_from_params,
)
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

INVALID_PARAMS_CODE = -32602
NOT_INITIALIZED_CODE = -32002
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH

_ERROR_DETAIL_MAX_CHARS = 300
_NOTE_MAX_TOKENS = 1_024
# The reply budget is the smallest of the engine/user output cap, the budget's
# summary reservation and the note's own cap; below this it cannot hold a note.
_NOTE_MIN_TOKENS = 128
_LOG_COMPONENT = "runtime.request_dispatch_handoff"
_LOG_EVENT = "sidecar.runtime.handoff_note"


@dataclass(frozen=True)
class _HandoffRequestContext:
    initialized: bool
    message_id: Any
    params: dict[str, Any]
    brain_container: BrainContainer
    logger: logging.Logger
    session_id: str | None
    request_id: str
    inference_admission: Any | None
    focus_project: str | None = None


class _HandoffFailure(Exception):
    """A mapped failure carrying its wire reason and optional detail."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _emit_log_event(logger: logging.Logger, level: int, **kwargs: Any) -> None:
    # Route through request_dispatch's ``log_event`` symbol when present so a test
    # that monkeypatches the parent module's logger also captures this helper's
    # events; fall back to the directly-imported ``log_event`` otherwise. Mirrors
    # the sibling request_dispatch_* dispatchers.
    request_dispatch_module = sys.modules.get("sidecar.runtime.request_dispatch")
    log_event_fn = getattr(request_dispatch_module, "log_event", log_event)
    log_event_fn(logger, level, **kwargs)


def _outcome(initialized: bool, response: dict[str, Any] | None) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=response,
        notifications=[],
    )


def _error_result(
    context: _HandoffRequestContext, reason: str, detail: str = ""
) -> ProcessOutcome:
    payload: dict[str, Any] = {"status": "error", "reason": reason}
    if detail:
        # result_response does not sanitize; redact before the wire.
        payload["detail"] = sanitize_diagnostic_text(detail, limit=_ERROR_DETAIL_MAX_CHARS)
    return _outcome(context.initialized, result_response(context.message_id, payload))


def _history_messages(params: dict[str, Any]) -> list[dict[str, Any]]:
    raw = params.get("messages")
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, dict)]


def _focus_project(params: dict[str, Any]) -> tuple[bool, str | None]:
    """``(valid, name)`` for the optional ``focus_project`` param."""
    if "focus_project" not in params or params["focus_project"] is None:
        return True, None
    raw = params["focus_project"]
    name = normalize_focus_project_name(raw.get("name")) if isinstance(raw, dict) else None
    return name is not None, name


def process_handoff_method(  # noqa: PLR0911, PLR0913 -- uniform dispatch hook contract
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
    *,
    write_message: Callable[[dict[str, Any]], None] | None = None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None = None,
) -> ProcessOutcome | None:
    """Dispatch the ``handoff.generate_note`` JSON-RPC method.

    Returns ``None`` if ``method`` is not ``handoff.generate_note``.
    """
    if method != HANDOFF_GENERATE_NOTE_METHOD:
        return None

    version_error = validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
    )
    if version_error is not None:
        return _outcome(initialized, version_error)

    if message_id is None:
        return _outcome(initialized, None)

    if not initialized:
        return _outcome(
            initialized,
            error_response(
                message_id,
                code=NOT_INITIALIZED_CODE,
                message="Sidecar not initialized — engine unavailable.",
            ),
        )

    safe_params = params if isinstance(params, dict) else {}
    try:
        inference_context = inference_context_from_params(safe_params)
    except ValueError as error:
        return _outcome(
            initialized,
            error_response(
                message_id,
                code=INVALID_PARAMS_CODE,
                message="invalid inference_context",
                data={"detail": str(error)},
            ),
        )
    legacy_session_id = str(safe_params.get("session_id") or "").strip() or None
    legacy_request_id = str(safe_params.get("request_id") or "").strip() or None
    if inference_context is not None and (
        inference_context.session_id != legacy_session_id
        or inference_context.request_id != legacy_request_id
    ):
        return _outcome(
            initialized,
            error_response(
                message_id,
                code=INVALID_PARAMS_CODE,
                message="invalid inference_context",
                data={"detail": "inference_context must match handoff request identity"},
            ),
        )
    focus_valid, focus_project = _focus_project(safe_params)
    if not focus_valid:
        return _outcome(
            initialized,
            error_response(
                message_id,
                code=INVALID_PARAMS_CODE,
                message="invalid focus_project",
                data={"detail": "focus_project must be an object with a non-empty name"},
            ),
        )
    session_id = (
        inference_context.session_id if inference_context is not None else legacy_session_id
    )
    request_id = (
        inference_context.request_id
        if inference_context is not None
        else legacy_request_id or f"handoff_note_{session_id or 'unknown'}"
    )

    return _process_handoff_request(
        _HandoffRequestContext(
            initialized=initialized,
            message_id=message_id,
            params=safe_params,
            brain_container=brain_container,
            logger=logger,
            session_id=session_id,
            request_id=request_id,
            inference_admission=build_auxiliary_inference_admission_callback(
                context=inference_context,
                write_message=write_message,
                response_reader_factory=response_reader_factory,
            ),
            focus_project=focus_project,
        )
    )


def _process_handoff_request(context: _HandoffRequestContext) -> ProcessOutcome:
    messages = _history_messages(context.params)
    if not messages:
        return _error_result(context, "no_history")

    _emit_log_event(
        context.logger,
        logging.INFO,
        component=_LOG_COMPONENT,
        event=_LOG_EVENT,
        message="Processing handoff.generate_note request",
        status="start",
        data={
            "session_id": context.session_id,
            "message_count": len(messages),
            "focus_project": context.focus_project is not None,
        },
        request_id=context.request_id,
    )
    try:
        note, kept_count, truncated = _generate_note(context, messages)
    except _HandoffFailure as failure:
        _emit_log_event(
            context.logger,
            logging.WARNING,
            component=_LOG_COMPONENT,
            event=_LOG_EVENT,
            message="handoff.generate_note did not produce a note",
            status="failure",
            data={"session_id": context.session_id, "reason": failure.reason},
            request_id=context.request_id,
        )
        return _error_result(context, failure.reason, failure.detail)

    _emit_log_event(
        context.logger,
        logging.INFO,
        component=_LOG_COMPONENT,
        event=_LOG_EVENT,
        message="handoff.generate_note completed",
        status="success",
        data={
            "session_id": context.session_id,
            "message_count": len(messages),
            "kept_message_count": kept_count,
            "transcript_truncated": truncated,
            "note_chars": len(note),
        },
        request_id=context.request_id,
    )
    return _outcome(
        context.initialized,
        result_response(
            context.message_id,
            {"status": "ok", "note": note, "transcript_truncated": truncated},
        ),
    )


def _generate_note(
    context: _HandoffRequestContext, messages: list[dict[str, Any]]
) -> tuple[str, int, bool]:
    """Budget, clip, generate and parse; every non-propagating failure is mapped."""
    stack = context.brain_container.stack
    config = stack.config
    feature_flags = getattr(config, "feature_flags", None) or {}
    cancel_handle = bound_auxiliary_cancel_handle()
    prompt = handoff_note_prompt(context.focus_project)
    try:
        _messages, budget, tracker = apply_budget_check(
            messages, config, stack.engine, num_tools=0
        )
        if budget is None or tracker is None or tracker.backend is None:
            raise _HandoffFailure("generation_failed", "token budget unavailable")
        count_tokens = tracker.backend.count_tokens
        max_tokens = min(
            _NOTE_MAX_TOKENS,
            int(budget.summary_reservation()),
            int(
                resolve_effective_max_tokens(
                    config.max_tokens,
                    stack.engine.get_model_max_output_tokens(),
                    user_override=getattr(config, "resolved_user_max_output_tokens", None),
                )
            ),
        )
        if max_tokens < _NOTE_MIN_TOKENS:
            raise _HandoffFailure("generation_failed", "output budget too small for a note")
        room = max(
            0,
            budget.effective_context(0)
            - int(count_tokens(handoff_framing_text(prompt, context.focus_project)))
            - max_tokens,
        )
        kept, truncated = clip_history_for_note(
            messages, count_tokens=count_tokens, max_tokens=room
        )
        conversation = [row for row in kept if row.get("role") != "system"]
        if not conversation or not format_messages_block(conversation):
            if truncated and any(row.get("role") != "system" for row in messages):
                raise _HandoffFailure(
                    "generation_failed", "transcript does not fit the model context"
                )
            raise _HandoffFailure("no_history")
        generate_fn = stack.router._build_compaction_generate_fn(
            request_id=context.request_id,
            max_tokens=max_tokens,
            prompt_cache_enabled=is_feature_flag_enabled(feature_flags, FEATURE_PROMPT_CACHE),
            runtime=LoopRuntime(
                request_id=context.request_id,
                session_id=str(context.session_id or ""),
                cancel_handle=cancel_handle,
                inference_admission=context.inference_admission,
            ),
            purpose="handoff_note",
        )
        raw = generate_fn(
            build_handoff_note_messages(kept, prompt=prompt, focus_project=context.focus_project)
        )
    except (_HandoffFailure, InferenceAdmissionError):
        raise
    except Exception as error:  # never raise across the boundary
        if cancel_handle is not None and getattr(cancel_handle, "cancelled", False):
            raise
        context.logger.exception("handoff.generate_note generation failed")
        raise _HandoffFailure("generation_failed", str(error)) from error
    try:
        note = parse_handoff_note(str(raw or ""))
    except ValueError as error:
        raise _HandoffFailure("note_invalid", str(error)) from error
    return note, len(kept), truncated
