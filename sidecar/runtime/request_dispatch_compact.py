"""Manual ``chat.compact`` method dispatch helper extracted from request_dispatch.py.

Handles the ``chat.compact`` JSON-RPC request/response method: a user-initiated
"compact now" trigger that runs the SAME ``compact_context()`` the auto path in
``chat_decision.py`` uses — no forked compaction logic. Electron owns canonical
history, so the request carries the session's message list in params; the
handler compacts it, replies with a structured result, and re-emits the
EXISTING ``context.compacted`` notification on success.

Fail-closed contract (never raises across the sidecar boundary):
- ``compaction_manual`` flag off  -> ``{"status": "error", "reason": "feature_disabled"}``
- circuit breaker open            -> ``{"status": "error", "reason": "circuit_breaker_open"}``
- no messages to compact          -> ``{"status": "error", "reason": "no_active_turn"}``
- compaction raised / insufficient -> ``{"status": "error", "reason": "compaction_failed"}``

The manual circuit breaker is a module-level singleton shared across requests
and resets after its five-minute cooldown. The auto path instead uses its
per-session breaker registry and lifecycle.
"""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from typing import Any

from sidecar.ai.config import resolve_effective_max_tokens
from sidecar.ai.container import BrainContainer
from sidecar.ai.context.compaction import (
    CompactionCircuitBreaker,
    CompactionResult,
    compact_context,
)
from sidecar.ai.context.compaction_prompts import resolve_compaction_prompt
from sidecar.ai.context.token_budget import (
    apply_budget_check,
    check_budget,
    estimate_messages_tokens,
)
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.ai.feature_flags import (
    FEATURE_COMPACTION_MANUAL,
    FEATURE_PROMPT_CACHE,
    is_feature_flag_enabled,
)
from sidecar.protocol import CHAT_COMPACT_METHOD, CONTEXT_COMPACTED_METHOD
from sidecar.runtime.chat_helpers import notification_context
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import (
    error_response,
    notification,
    result_response,
    validate_accept_version,
)

INVALID_PARAMS_CODE = -32602
NOT_INITIALIZED_CODE = -32002
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH

_ERROR_DETAIL_MAX_CHARS = 300

# Shared across manual compact requests so consecutive manual failures trip the
# breaker; monkeypatched in tests.
_MANUAL_COMPACTION_BREAKER = CompactionCircuitBreaker()


@dataclass(frozen=True)
class _CompactRequestContext:
    initialized: bool
    message_id: Any
    params: dict[str, Any]
    brain_container: BrainContainer
    logger: logging.Logger
    session_id: str | None
    request_id: str


def _emit_log_event(logger: logging.Logger, level: int, **kwargs: Any) -> None:
    # Route through request_dispatch's ``log_event`` symbol when present so a test
    # that monkeypatches the parent module's logger also captures this helper's
    # events; fall back to the directly-imported ``log_event`` otherwise. Mirrors
    # the sibling request_dispatch_* dispatchers.
    request_dispatch_module = sys.modules.get("sidecar.runtime.request_dispatch")
    log_event_fn = getattr(request_dispatch_module, "log_event", log_event)
    log_event_fn(logger, level, **kwargs)


def _outcome(
    initialized: bool,
    response: dict[str, Any] | None,
    notifications: list[dict[str, Any]] | None = None,
) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=response,
        notifications=notifications or [],
    )


def _error_result(
    initialized: bool,
    message_id: Any,
    reason: str,
    **extra: Any,
) -> ProcessOutcome:
    return _outcome(
        initialized,
        result_response(message_id, {"status": "error", "reason": reason, **extra}),
    )


def _compactable_messages(params: dict[str, Any]) -> list[dict[str, Any]]:
    raw = params.get("messages")
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, dict)]


def process_compact_method(  # noqa: PLR0913 -- uniform request-dispatch hook contract
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    """Dispatch the manual ``chat.compact`` JSON-RPC method.

    Returns ``None`` if ``method`` is not ``chat.compact``.
    """
    if method != CHAT_COMPACT_METHOD:
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
    session_id = str(safe_params.get("session_id") or "").strip() or None
    request_id = (
        str(safe_params.get("request_id") or "").strip()
        or f"manual_compact_{session_id or 'unknown'}"
    )

    return _process_compact_request(
        _CompactRequestContext(
            initialized=initialized,
            message_id=message_id,
            params=safe_params,
            brain_container=brain_container,
            logger=logger,
            session_id=session_id,
            request_id=request_id,
        )
    )


def _process_compact_request(context: _CompactRequestContext) -> ProcessOutcome:
    initialized = context.initialized
    message_id = context.message_id
    safe_params = context.params
    brain_container = context.brain_container
    logger = context.logger
    session_id = context.session_id
    request_id = context.request_id

    stack = brain_container.stack
    config = stack.config
    feature_flags = getattr(config, "feature_flags", None) or {}

    # R5: gate at the sidecar dispatch layer too, not just the renderer button.
    if not is_feature_flag_enabled(feature_flags, FEATURE_COMPACTION_MANUAL):
        return _error_result(initialized, message_id, "feature_disabled")

    # "no_active_turn" is the wire reason for "nothing to compact": empty,
    # missing, or all-non-dict message lists all funnel here. The renderer
    # surfaces it as a benign "nothing to compact" note.
    messages = _compactable_messages(safe_params)
    if not messages:
        return _error_result(initialized, message_id, "no_active_turn")

    # Single evaluation: seconds_until_reset() auto-closes an elapsed window
    # via its internal is_open() and returns > 0 iff the breaker is open, so
    # the guard and the reported retry window can never disagree.
    retry_after_seconds = _MANUAL_COMPACTION_BREAKER.seconds_until_reset()
    if retry_after_seconds > 0:
        return _error_result(
            initialized,
            message_id,
            "circuit_breaker_open",
            retry_after_seconds=round(retry_after_seconds, 1),
        )

    _emit_log_event(
        logger,
        logging.INFO,
        component="runtime.request_dispatch_compact",
        event="sidecar.runtime.chat_compact",
        message="Processing manual chat.compact request",
        status="start",
        data={"session_id": session_id, "message_count": len(messages)},
        request_id=request_id,
    )

    compaction_result = _run_manual_compaction(context, messages, feature_flags)
    if isinstance(compaction_result, ProcessOutcome):
        return compaction_result

    _emit_log_event(
        logger,
        logging.INFO,
        component="runtime.request_dispatch_compact",
        event="sidecar.runtime.chat_compact",
        message="Manual chat.compact completed",
        status="success",
        data={
            "strategy": compaction_result.strategy,
            "tokens_before": compaction_result.tokens_before,
            "tokens_after": compaction_result.tokens_after,
        },
        request_id=request_id,
    )

    notifications: list[dict[str, Any]] = []
    if compaction_result.compacted:
        # Reuse the EXISTING context.compacted notification — same payload shape
        # the auto path produces via ContextCompactedEvent serialization. Guarded
        # so the never-raises contract covers emission too: a raise here (e.g.
        # a method constant dropping off ALLOWED_NOTIFICATION_METHODS) must
        # degrade to result-without-notification, not kill the main loop.
        try:
            notifications.append(
                notification(
                    CONTEXT_COMPACTED_METHOD,
                    {
                        **notification_context(request_id, trace_id=None, session_id=session_id),
                        "strategy": compaction_result.strategy,
                        "tokens_before": compaction_result.tokens_before,
                        "tokens_after": compaction_result.tokens_after,
                    },
                )
            )
        except Exception:  # noqa: BLE001 — never raise across the boundary
            logger.exception("manual chat.compact notification emission failed")
            notifications = []

    return _outcome(
        initialized,
        result_response(
            message_id,
            {
                "status": "ok",
                "compacted": compaction_result.compacted,
                "strategy": compaction_result.strategy,
                "tokens_before": compaction_result.tokens_before,
                "tokens_after": compaction_result.tokens_after,
                # JCA-003: the compacted replacement history. Electron owns
                # canonical history, so the result must carry the messages or
                # the pass is spent and discarded. Omitted when nothing was
                # compacted (strategy "none") — there is nothing to persist.
                **(
                    {"messages": list(compaction_result.messages)}
                    if compaction_result.compacted
                    else {}
                ),
            },
        ),
        notifications,
    )


def _run_manual_compaction(
    context: _CompactRequestContext,
    messages: list[dict[str, Any]],
    feature_flags: Any,
) -> CompactionResult | ProcessOutcome:
    """Run compaction and map every failure to the dispatcher result contract."""
    stack = context.brain_container.stack
    config = stack.config
    try:
        _messages, budget, tracker = apply_budget_check(
            messages,
            config,
            stack.engine,
            num_tools=0,
        )
        if budget is None or tracker is None or tracker.backend is None:
            return _error_result(
                context.initialized,
                context.message_id,
                "compaction_failed",
                detail="token budget unavailable",
            )
        generate_fn = stack.router._build_compaction_generate_fn(
            request_id=context.request_id,
            max_tokens=min(
                budget.reserved_for_summary,
                resolve_effective_max_tokens(
                    config.max_tokens,
                    stack.engine.get_model_max_output_tokens(),
                    user_override=getattr(config, "resolved_user_max_output_tokens", None),
                ),
            ),
            prompt_cache_enabled=is_feature_flag_enabled(
                feature_flags,
                FEATURE_PROMPT_CACHE,
            ),
        )
        # Manual requests carry no live system preamble, so tokens_after runs
        # slightly lower than an automatic compaction of the same turn. The
        # compacted replacement messages are returned in the result (JCA-003):
        # Electron persists them as a session-owned compaction snapshot and
        # substitutes them for the summarized prefix on future chat.send calls.
        result = compact_context(
            messages,
            budget,
            generate_fn=generate_fn,
            num_tools=0,
            base_prompt=resolve_compaction_prompt(config),
            circuit_breaker=_MANUAL_COMPACTION_BREAKER,
            force=True,
        )
        if result.error is None and result.compacted:
            post_compaction_tokens = estimate_messages_tokens(result.messages, tracker.backend)
            post_compaction_status = check_budget(
                post_compaction_tokens,
                budget,
                num_tools=0,
            )
            if post_compaction_status.level == "error":
                return _error_result(
                    context.initialized,
                    context.message_id,
                    "compaction_failed",
                    detail=(
                        f"post-compaction token count {post_compaction_tokens} vs "
                        f"budget error threshold {budget.error_threshold(0)}"
                    ),
                )
    except Exception as error:  # noqa: BLE001 -- never raise across the boundary
        context.logger.exception("manual chat.compact failed")
        return _error_result(
            context.initialized,
            context.message_id,
            "compaction_failed",
            detail=str(error)[:_ERROR_DETAIL_MAX_CHARS],
        )

    if result.error is not None:
        return _error_result(
            context.initialized,
            context.message_id,
            "compaction_failed",
            detail=str(result.error)[:_ERROR_DETAIL_MAX_CHARS],
        )
    return result
