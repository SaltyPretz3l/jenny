"""Live streaming chat response construction with reasoning support."""

from __future__ import annotations

import dataclasses
import logging
import math
from collections.abc import Sequence
from typing import Any, Callable, cast

from sidecar.ai.config_models import uses_minimal_system_prompt
from sidecar.ai.container import BrainContainer
from sidecar.ai.context.history_reframe import reframe_tool_history_messages
from sidecar.ai.context.messages import (
    build_context_block_system_messages,
    compact_semantic_messages,
    compact_semantic_messages_with_budget,
    resolve_personality_rendered,
)
from sidecar.ai.context.prompt_cache import resolve_current_date
from sidecar.ai.context.runtime_message_markers import PLUGIN_RUNTIME_OVERLAY_HEADING
from sidecar.ai.context.runtime_overlays import (
    RuntimeOverlayLogContext,
    build_dynamic_system_messages,
    build_prompt_memory_recall_system_message,
)
from sidecar.ai.context.token_budget import (
    TokenBudget,
    check_budget,
    estimate_messages_tokens,
    resolve_effective_context_window,
    resolve_request_output_reservation,
    resolve_tokenizer_backend,
)
from sidecar.ai.engines.base import EngineMessage
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.error_codes import (
    CMP_CHAT_STREAM_FAILED,
    CMP_STREAM_INCOMPLETE,
    CMP_STREAM_REASONING_ONLY,
)
from sidecar.ai.feature_flags import (
    FEATURE_CANONICAL_TURN_EVENTS,
    FEATURE_CONTEXT_COMPACTION,
    FEATURE_PHASE_EVENTS,
    FEATURE_PROMPT_CACHE,
    FEATURE_TOKEN_BUDGET,
    is_chatgpt_plan_meter_enabled,
    is_feature_flag_enabled,
)
from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.ai.routing import thinking_checkpoint as checkpoint
from sidecar.ai.routing.generation_diagnostics import (
    RequestFingerprintRecord,
    record_request_fingerprint_for_store,
)
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
    FINISH_REASON_REASONING_ONLY,
    FINISH_REASON_THINKING_BUDGET,
)
from sidecar.ai.routing.turn_event_contract import build_canonical_turn_event
from sidecar.ai.routing.vision_turn import attach_vision_images, vision_token_surcharge
from sidecar.ai.thinking_guard import (
    ThinkingRepetitionGuard,
    resolve_thinking_budget_chars,
    thinking_budget_abort_enabled,
)
from sidecar.ai.tools.models import GenerationUsage
from sidecar.protocol import (
    CHAT_DONE_METHOD,
    CHAT_ERROR_METHOD,
    CHAT_PHASE_COMPLETED_METHOD,
    CHAT_PHASE_STARTED_METHOD,
    CHAT_THINKING_KIND_REASONING,
    CHAT_THINKING_KIND_STATUS,
    CHAT_TOKEN_METHOD,
    TURN_EVENT_METHOD,
)
from sidecar.runtime.chat_helpers import (
    DebouncedNotificationWriter,
    _decision_usage_payload,
    _fallback_usage_payload,
    attach_compact_threshold,
    attach_context_used_tokens,
    attach_context_window,
    engine_supports_live_reasoning_stream,
    estimate_text_tokens,
    notification_context,
    thinking_notification,
)
from sidecar.runtime.chat_models import ChatResponse
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.plan_usage_snapshot import attach_plan_usage
from sidecar.runtime.reasoning_status import (
    ReasoningStatusExtractor,
    ReasoningStatusSynthesizer,
    sanitize_visible_text,
)
from sidecar.runtime.rpc import notification
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_REASONING_ONLY,
    TERMINAL_SUBCODE_STREAM_INCOMPLETE,
    TERMINAL_SUBCODE_THINKING_BUDGET,
    TURN_STATE_RUNTIME_ERROR,
    build_turn_result,
)

logger = logging.getLogger(__name__)


def _resolve_stream_tokenizer_backend(config: Any) -> Any:
    """Config-aware tokenizer backend for the live-stream lane, or ``None``.

    Fails soft on purpose: a tokenizer that cannot be constructed must never
    fail a turn, and every consumer here treats ``None`` as "use the chars//4
    estimator", which is exactly the previous behaviour.
    """
    try:
        return resolve_tokenizer_backend(config)
    except Exception:  # noqa: BLE001
        return None


def _build_live_stream_messages(
    brain_container: BrainContainer,
    messages: list[dict[str, object]],
    learned_lessons: list[Any] | None,
    *,
    memory_policy: MemoryPolicy | None = None,
    latest_user_content: str,
    request_id: str,
    session_id: str | None,
    current_date: str | None = None,
    context_blocks: Any = (),
    skill_invocation: dict[str, str] | None = None,
    backend: Any | None = None,
    reasoning_effort: str | None = None,
    image_token_surcharge: int = 0,
) -> list[EngineMessage]:
    stack = brain_container.stack
    system_prompt = stack.context_builder.build_system_prompt(
        stack.config.system_prompt,
        learned_lessons=learned_lessons,
        include_reasoning_status_markers=engine_supports_live_reasoning_stream(
            brain_container.stack.engine
        ),
        include_skills=False,
        include_bootstrap=not uses_minimal_system_prompt(stack.config),
        workspace_manifest_enabled=getattr(stack.config, "tools_workspace_manifest_enabled", False),
        task_capsule_enabled=getattr(stack.config, "tools_task_capsule_enabled", False),
        latest_user_content=latest_user_content,
        current_date=str(current_date or "").strip() or resolve_current_date(),
    )
    feature_flags = stack.config.feature_flags or {}
    include_personality_block = not uses_minimal_system_prompt(stack.config)
    # Structural, not textual: exactly one ``## Personality`` row per
    # non-minimal turn -- the typed context block when Electron sent one,
    # otherwise the bare name line from the runtime overlay builder.
    personality_rendered = resolve_personality_rendered(stack.config, context_blocks)
    dynamic_system_messages = build_dynamic_system_messages(
        context_builder=stack.context_builder,
        config=stack.config,
        tool_statuses=None,
        personality_rendered=personality_rendered,
        skill_invocation=skill_invocation,
    )
    runtime_system_messages = [
        content
        for message in dynamic_system_messages
        if isinstance((content := message.get("content")), str)
        and content.startswith(PLUGIN_RUNTIME_OVERLAY_HEADING)
    ]
    record_request_fingerprint_for_store(
        getattr(stack, "turn_diagnostics", None),
        RequestFingerprintRecord(
            request_id=request_id,
            session_id=session_id,
            system_prompt=system_prompt,
            tool_schemas=[],
            component="runtime.chat_streaming",
            event="runtime.chat_streaming.request_fingerprint_failed",
            message="Live-stream request fingerprinting failed closed.",
        ),
    )
    memory_message = build_prompt_memory_recall_system_message(
        context_builder=stack.context_builder,
        memory_store=getattr(
            stack,
            "memory_service",
            getattr(stack, "memory_store", None),
        ),
        latest_user_content=latest_user_content,
        memory_policy=memory_policy,
        log_context=RuntimeOverlayLogContext(
            logger=logger,
            component="runtime.chat_streaming",
            event="runtime.chat_streaming.memory_prompt_recall_failed",
            request_id=request_id,
            session_id=session_id,
        ),
    )
    if memory_message:
        runtime_system_messages.append(memory_message)
    # Tool-history preparation runs BEFORE admission (both branches below) so
    # byte/token budgeting counts the representation the model will receive —
    # the same ordering the routed lane uses.
    if isinstance(messages, list):
        messages = reframe_tool_history_messages(messages, config=stack.config)
    if is_feature_flag_enabled(feature_flags, FEATURE_TOKEN_BUDGET):
        # Budget against the window the request is actually served with (the
        # configured num_ctx clamp), not the model's native window.
        context_window = resolve_effective_context_window(stack.engine, stack.config)
        max_output = stack.engine.get_model_max_output_tokens() or stack.config.max_tokens
        output_reservation = resolve_request_output_reservation(
            stack.engine,
            reasoning_effort=reasoning_effort,
            max_output_tokens=int(max_output),
        )

        # Images attach after assembly, so the window admits history against
        # the tokens they will add rather than the text-only count.
        budget = TokenBudget(
            context_window=int(context_window),
            max_output_tokens=int(max_output),
            output_reservation_tokens=output_reservation,
        ).with_reserved_tokens(image_token_surcharge)
        semantic_history = compact_semantic_messages_with_budget(
            messages,
            budget=budget,
            backend=backend,
        )
    else:
        semantic_history = compact_semantic_messages(messages)
        budget = None
    # Electron's per-turn context overlays land in the TRUSTED leading system
    # run, ahead of semantic history — and therefore ahead of any pinned
    # compaction summary, which is derived (untrusted) conversation data.
    stream_messages: list[dict[str, object]] = [
        {"role": "system", "content": str(system_prompt)},
        *dynamic_system_messages,
        *build_context_block_system_messages(
            context_blocks,
            include_personality=include_personality_block,
            agent_name=getattr(stack.config, "assistant_name", None),
        ),
        *semantic_history,
    ]
    stream_messages_with_runtime = stack.context_builder.insert_runtime_system_messages(
        stream_messages,
        runtime_system_messages,
    )
    if budget is not None:
        status = check_budget(
            estimate_messages_tokens(stream_messages_with_runtime, backend),
            budget,
            num_tools=0,
        )
        advisory = stack.context_builder.build_context_pressure_advisory(status)
        if advisory:
            runtime_system_messages.append(advisory)
            stream_messages_with_runtime = stack.context_builder.insert_runtime_system_messages(
                stream_messages_with_runtime,
                runtime_system_messages,
            )
    return cast(list[EngineMessage], stream_messages_with_runtime)


# #28: a visible streaming chunk free of every sanitizer trigger is a provable
# no-op for sanitize_visible_text, so the 4-stage regex pipeline can be skipped on
# the common plain-text token path byte-identically. ALL four stages key on one
# of these: drop_special_tokens + strip_known_reasoning_blocks match control /
# reasoning markers that begin with "<" or "[" (incl. their trailing partial
# prefixes); strip_content_markers matches the STATUS bracket "{" / U+27E8 and its
# mojibake lead bytes (U+00E2 / U+00C3, per _VISIBLE_STATUS_OPEN_VARIANTS);
# strip_visible_thought_sentinels matches a line-anchored "thought"/"analysis"
# label. A chunk containing none of these cannot match any stage, so sanitize
# returns it unchanged. This is NOT cross-chunk buffering -- each triggering chunk
# is still sanitized in isolation exactly as before, so output is byte-identical.
_SANITIZE_TRIGGER_CHARS = ("<", "[", "{", chr(0x27E8), chr(0x00E2), chr(0x00C3))


def _chunk_requires_sanitize(chunk: str) -> bool:
    for trigger in _SANITIZE_TRIGGER_CHARS:
        if trigger in chunk:
            return True
    lowered = chunk.lower()
    return "thought" in lowered or "analysis" in lowered


def build_live_streaming_chat_response(
    *,
    request_id: str,
    trace_id: str | None,
    session_id: str | None,
    latest_user_content: str,
    messages: list[dict[str, object]],
    brain_container: BrainContainer,
    reasoning_effort: str | None,
    learned_lessons: list[Any] | None,
    memory_policy: MemoryPolicy | None = None,
    max_tokens: int,
    notification_writer: Any | None = None,
    cancel_handle: TurnCancellationHandle | None = None,
    post_response_callback: Callable[[str], None] | None = None,
    iteration: int = 1,
    current_date: str | None = None,
    context_blocks: Any = (),
    skill_invocation: dict[str, str] | None = None,
    vision_images: Sequence[VisionImage] = (),
    vision_anchor_text: str = "",
) -> ChatResponse:
    stack = brain_container.stack
    engine = stack.engine
    # Built BEFORE the message assembly that budgets against it: the budget
    # check inside _build_live_stream_messages must count with the same backend
    # the ring below reports with, otherwise the advisory the model sees and the
    # figure the renderer shows are produced by two different tokenizers.
    _context_backend = _resolve_stream_tokenizer_backend(stack.config)
    image_token_surcharge = vision_token_surcharge(vision_images)
    stream_messages = _build_live_stream_messages(
        brain_container,
        messages,
        learned_lessons=learned_lessons,
        memory_policy=memory_policy,
        latest_user_content=latest_user_content,
        request_id=request_id,
        session_id=session_id,
        current_date=current_date,
        context_blocks=context_blocks,
        skill_invocation=skill_invocation,
        backend=_context_backend,
        reasoning_effort=reasoning_effort,
        image_token_surcharge=image_token_surcharge,
    )
    stream_messages = attach_vision_images(
        stream_messages,
        vision_images=vision_images,
        anchor_text=vision_anchor_text,
    )
    # Use the same estimator that feeds the decision/budget path (chat.py) so
    # the renderer's context ring shows a consistent "used" figure turn-to-turn.
    # The old content-only regex-piece sum diverged from the budget path's
    # chars//4 + per-message overhead by ~1.3-1.8x, making the ring jump as a
    # user alternated between plain-chat (this path) and tool turns.
    context_tokens_estimate = estimate_messages_tokens(
        stream_messages, _context_backend
    ) + image_token_surcharge
    turn_diagnostics = getattr(stack, "turn_diagnostics", None)
    if turn_diagnostics is not None:
        turn_diagnostics.record_request_metrics(
            request_id=request_id,
            mode="chat",
            context_tokens_estimate=context_tokens_estimate,
            message_count=len(stream_messages),
            tool_schema_count=0,
        )
    prompt_cache_enabled = is_feature_flag_enabled(
        stack.config.feature_flags or {},
        FEATURE_PROMPT_CACHE,
    )
    notifications: list[dict[str, Any]] = []
    response_parts: list[str] = []
    thinking_parts: list[str] = []
    thinking_id = f"think_{request_id}"
    phase_events_enabled = is_feature_flag_enabled(
        stack.config.feature_flags or {},
        FEATURE_PHASE_EVENTS,
    )
    canonical_turn_events_enabled = is_feature_flag_enabled(
        stack.config.feature_flags or {},
        FEATURE_CANONICAL_TURN_EVENTS,
    )
    current_phase: dict[str, Any] | None = None
    phase_index = 0
    canonical_seq = 0
    thinking_budget_chars = resolve_thinking_budget_chars(engine, max_tokens)
    context_window = resolve_effective_context_window(engine, stack.config)
    checkpoint_limit = checkpoint.max_thinking_budget_checkpoints(context_window)
    checkpoint_cycles = 0
    last_checkpoint_carry: str | None = None
    thinking_guard = ThinkingRepetitionGuard(max_chars=thinking_budget_chars)
    status_extractor = ReasoningStatusExtractor()
    status_synthesizer = ReasoningStatusSynthesizer()
    thinking_suppression_logged = False
    thinking_has_content = False
    debounced_writer: DebouncedNotificationWriter | None = None
    if callable(notification_writer):
        debounced_writer = DebouncedNotificationWriter(notification_writer)

    def emit(item: dict[str, Any]) -> None:
        if debounced_writer is not None:
            debounced_writer(item)
            return
        notifications.append(item)

    def emit_canonical(
        event_type: str,
        payload: dict[str, Any] | None = None,
        *,
        tool_call_id: str = "",
    ) -> None:
        nonlocal canonical_seq
        if not canonical_turn_events_enabled:
            return
        canonical_seq += 1
        source_payload = dict(payload or {})
        if trace_id:
            source_payload["trace_id"] = trace_id
        event = build_canonical_turn_event(
            event_type=event_type,
            turn_id=request_id,
            stream_id=request_id,
            session_id=session_id or "",
            seq=canonical_seq,
            payload=source_payload,
            tool_call_id=tool_call_id,
        )
        emit(notification(TURN_EVENT_METHOD, event.to_payload()))

    last_emitted_summary = ""

    def _maybe_attach_summary(payload: dict[str, Any]) -> None:
        nonlocal last_emitted_summary
        candidate = status_synthesizer.reason
        if candidate and candidate != last_emitted_summary:
            payload["summary"] = candidate
            last_emitted_summary = candidate

    def transition_phase(
        next_kind: str | None, *, next_thinking_id: str | None = None,
        summary: str | None = None,
    ) -> None:
        nonlocal current_phase, phase_index
        if not phase_events_enabled:
            return
        if current_phase is not None:
            completed_payload: dict[str, Any] = {
                **notification_context(request_id, trace_id=trace_id, session_id=session_id),
                "phase_id": current_phase["phase_id"],
                "phase_kind": current_phase["phase_kind"],
                "iteration": int(iteration),
            }
            if current_phase.get("thinking_id"):
                completed_payload["thinking_id"] = current_phase["thinking_id"]
            _maybe_attach_summary(completed_payload)
            emit(notification(CHAT_PHASE_COMPLETED_METHOD, completed_payload))
            emit_canonical("status_part", {"status_text": "phase_completed", **completed_payload})
            current_phase = None
        if not next_kind:
            return
        phase_index += 1
        phase_id = f"phase_{next_kind}_{request_id}_{phase_index}"
        current_phase = {
            "phase_id": phase_id,
            "phase_kind": next_kind,
            "thinking_id": next_thinking_id,
        }
        started_payload: dict[str, Any] = {
            **notification_context(request_id, trace_id=trace_id, session_id=session_id),
            "phase_id": phase_id,
            "phase_kind": next_kind,
            "iteration": int(iteration),
        }
        if next_thinking_id:
            started_payload["thinking_id"] = next_thinking_id
        if summary:
            started_payload["summary"] = summary
        else:
            _maybe_attach_summary(started_payload)
        emit(notification(CHAT_PHASE_STARTED_METHOD, started_payload))
        emit_canonical("status_part", {"status_text": "phase_started", **started_payload})

    stream_error: Exception | None = None
    stream_finish_reason: str | None = None
    stream_usage: Any = None
    try:
        if cancel_handle is not None:
            cancel_handle.raise_if_cancelled()
        stream_end = object()
        stream_kwargs: Any = {
            "prompt": latest_user_content,
            "messages": stream_messages,
            "max_tokens": max_tokens,
            "prompt_cache_enabled": prompt_cache_enabled,
            "reasoning_effort": reasoning_effort,
            "cancel_handle": cancel_handle,
        }
        stream: Any = iter(engine.stream(**stream_kwargs))
        while True:
            chunk = next(stream, stream_end)
            if chunk is stream_end:
                can_checkpoint = stream_finish_reason == FINISH_REASON_THINKING_BUDGET
                visible_text = any(part.strip() for part in response_parts)
                can_checkpoint |= stream_finish_reason == "length" and not visible_text
                reasoning_text = "".join(thinking_parts)
                carry = reasoning_text[-checkpoint.CHECKPOINT_CARRY_CHARS:]
                if (
                    can_checkpoint
                    and checkpoint.thinking_budget_continuation_enabled()
                    and checkpoint_cycles < checkpoint_limit
                    and not checkpoint.checkpoint_no_progress(last_checkpoint_carry, carry)
                ):
                    stream_messages += cast(
                        list[EngineMessage],
                        checkpoint.build_checkpoint_messages(reasoning_text, summarize=None),
                    )
                    checkpoint_cycles += 1
                    last_checkpoint_carry = carry
                    # Per-cycle carry, like the tool loop's per-iteration thinking_text:
                    # earlier cycles already sit in stream_messages as checkpoint frames.
                    thinking_parts.clear()
                    thinking_has_content = False
                    thinking_guard = ThinkingRepetitionGuard(max_chars=thinking_budget_chars)
                    thinking_id = f"think_{request_id}_cp{checkpoint_cycles}"
                    transition_phase(
                        "reasoning", next_thinking_id=thinking_id,
                        summary=checkpoint.checkpoint_phase_summary(checkpoint_cycles),
                    )
                    logger.info(
                        "Continued chat streaming after a thinking-budget checkpoint.",
                        extra={
                            "event": "runtime.chat_streaming.thinking_budget_checkpoint",
                            "request_id": request_id, "cycle": checkpoint_cycles,
                            "limit": checkpoint_limit,
                        },
                    )
                    stream_finish_reason = None
                    stream = iter(engine.stream(**stream_kwargs))
                    continue
                break
            if cancel_handle is not None:
                cancel_handle.raise_if_cancelled()
            chunk_kind = str(getattr(chunk, "kind", "content") or "content").strip().lower()
            chunk_text = str(getattr(chunk, "text", chunk) or "")
            chunk_tokens_per_second_raw = getattr(chunk, "tokens_per_second", None)
            try:
                chunk_tokens_per_second = (
                    float(chunk_tokens_per_second_raw)
                    if chunk_tokens_per_second_raw is not None
                    else None
                )
            except (TypeError, ValueError):
                chunk_tokens_per_second = None
            # CTL-011: a NaN/±Inf provider metric must never reach the wire —
            # json.dumps(allow_nan=True) would emit non-standard tokens that
            # JavaScript's JSON.parse rejects, so coerce non-finite to None here.
            if chunk_tokens_per_second is not None and not math.isfinite(chunk_tokens_per_second):
                chunk_tokens_per_second = None
            if chunk_kind == "done":
                done_reason = str(getattr(chunk, "finish_reason", "") or "").strip().lower()
                if done_reason:
                    stream_finish_reason = done_reason
                # Provider-truth usage rides the terminal done event
                # (request-scoped by construction, like finish_reason).
                done_usage = getattr(chunk, "usage", None)
                if done_usage is not None:
                    # Checkpoint cycles add up (like the tool loop's usage_totals);
                    # last_request_input_tokens stays the latest request's size.
                    if isinstance(stream_usage, GenerationUsage) and isinstance(
                        done_usage, GenerationUsage
                    ):
                        done_usage = dataclasses.replace(
                            done_usage,
                            input_tokens=stream_usage.input_tokens + done_usage.input_tokens,
                            output_tokens=stream_usage.output_tokens + done_usage.output_tokens,
                            total_tokens=stream_usage.total_tokens + done_usage.total_tokens,
                        )
                    stream_usage = done_usage
                continue
            if chunk_kind == "thinking":
                if (
                    phase_events_enabled
                    and current_phase is not None
                    and current_phase.get("phase_kind") != "reasoning"
                ):
                    thinking_has_content = False
                if chunk_text.strip() or thinking_has_content:
                    if thinking_guard.feed(chunk_text):
                        if not thinking_suppression_logged:
                            logger.info(
                                "Suppressing live thinking notifications after guard tripped.",
                                extra={
                                    "request_id": request_id,
                                    "provider": stack.config.engine_type,
                                    "model": stack.config.model,
                                    "reason": thinking_guard.stop_reason,
                                },
                            )
                            thinking_suppression_logged = True
                        if (
                            thinking_guard.tripped_on_budget()
                            and thinking_budget_abort_enabled()
                        ):
                            stream_finish_reason = FINISH_REASON_THINKING_BUDGET
                            close_stream = getattr(stream, "close", None)
                            if callable(close_stream):
                                close_stream()
                            stream = iter(())
                        continue
                    # Whitespace goes through the extractor too: a buffered partial
                    # status marker must flush ahead of it, in order.
                    cleaned, status = status_extractor.feed(chunk_text)
                    if status:
                        status_synthesizer.mark_organic()
                        emit(
                            thinking_notification(
                                request_id,
                                trace_id=trace_id,
                                session_id=session_id,
                                delta=status,
                                thinking_id=thinking_id,
                                kind=CHAT_THINKING_KIND_STATUS,
                                persist=False,
                                tokens_per_second=chunk_tokens_per_second,
                            )
                        )
                        emit_canonical(
                            "status_part",
                            {
                                "status_text": status,
                                "thinking_id": thinking_id,
                                "kind": CHAT_THINKING_KIND_STATUS,
                                "persist": False,
                                **(
                                    {"tokens_per_second": chunk_tokens_per_second}
                                    if chunk_tokens_per_second is not None
                                    else {}
                                ),
                            },
                        )
                    elif chunk_text.strip():
                        synth_status = status_synthesizer.feed(chunk_text)
                        if synth_status:
                            emit(
                                thinking_notification(
                                    request_id,
                                    trace_id=trace_id,
                                    session_id=session_id,
                                    delta=synth_status,
                                    thinking_id=thinking_id,
                                    kind=CHAT_THINKING_KIND_STATUS,
                                    persist=False,
                                    tokens_per_second=chunk_tokens_per_second,
                                )
                            )
                            emit_canonical(
                                "status_part",
                                {
                                    "status_text": synth_status,
                                    "thinking_id": thinking_id,
                                    "kind": CHAT_THINKING_KIND_STATUS,
                                    "persist": False,
                                    **(
                                        {"tokens_per_second": chunk_tokens_per_second}
                                        if chunk_tokens_per_second is not None
                                        else {}
                                    ),
                                },
                            )
                    if cleaned and (cleaned.strip() or thinking_has_content):
                        thinking_parts.append(cleaned)
                        if current_phase is None or current_phase.get("phase_kind") != "reasoning":
                            transition_phase("reasoning", next_thinking_id=thinking_id)
                        emit(
                            thinking_notification(
                                request_id,
                                trace_id=trace_id,
                                session_id=session_id,
                                delta=cleaned,
                                thinking_id=thinking_id,
                                kind=CHAT_THINKING_KIND_REASONING,
                                persist=True,
                                tokens_per_second=chunk_tokens_per_second,
                                thinking_budget_chars=thinking_budget_chars,
                            )
                        )
                        emit_canonical(
                            "reasoning_delta",
                            {
                                "delta": cleaned,
                                "thinking_id": thinking_id,
                                "kind": CHAT_THINKING_KIND_REASONING,
                                "persist": True,
                                **(
                                    {"tokens_per_second": chunk_tokens_per_second}
                                    if chunk_tokens_per_second is not None
                                    else {}
                                ),
                            },
                        )
                        thinking_has_content = True
                continue
            if not chunk_text:
                continue
            # #28: skip the sanitize regex pipeline on trigger-free chunks
            # (byte-identical no-op) so the common plain-text token path is cheap.
            if _chunk_requires_sanitize(chunk_text):
                chunk_text = sanitize_visible_text(chunk_text)
            if not chunk_text:
                continue
            if current_phase is None or current_phase.get("phase_kind") != "text":
                transition_phase("text")
            response_parts.append(chunk_text)
            emit(
                notification(
                    CHAT_TOKEN_METHOD,
                    {
                        **notification_context(
                            request_id, trace_id=trace_id, session_id=session_id
                        ),
                        "delta": chunk_text,
                        "role": "assistant",
                    },
                )
            )
            # sequence must be 1-based to match legacyTextSequence in managed runtime dedup
            emit_canonical(
                "text_delta",
                {
                    "delta": chunk_text,
                    "role": "assistant",
                    "sequence": len(response_parts),
                },
            )
    except Exception as error:  # noqa: BLE001
        stream_error = error
        logger.exception(
            "Streaming loop failed mid-stream",
            extra={
                "request_id": request_id,
                "provider": stack.config.engine_type,
                "model": stack.config.model,
                "partial_length": sum(len(part) for part in response_parts),
            },
        )

    tail_text = status_extractor.flush()
    if tail_text.strip():
        if current_phase is None or current_phase.get("phase_kind") != "reasoning":
            transition_phase("reasoning", next_thinking_id=thinking_id)
        emit(
            thinking_notification(
                request_id,
                trace_id=trace_id,
                session_id=session_id,
                delta=tail_text,
                thinking_id=thinking_id,
                kind=CHAT_THINKING_KIND_REASONING,
                persist=True,
                thinking_budget_chars=thinking_budget_chars,
            )
        )
        emit_canonical(
            "reasoning_delta",
            {
                "delta": tail_text,
                "thinking_id": thinking_id,
                "kind": CHAT_THINKING_KIND_REASONING,
                "persist": True,
            },
        )

    response_text = "".join(response_parts)
    response_parts.clear()
    transition_phase(None)
    # Prefer the provider-truth usage carried on the stream's terminal done
    # event (e.g. Ollama's prompt_eval_count/eval_count); a missing or
    # all-zero record falls through to the char-estimate payload.
    usage_payload = _decision_usage_payload(
        stream_usage,
        fallback_provider=stack.config.engine_type,
        fallback_model=stack.config.model,
    ) or _fallback_usage_payload(
        latest_user_content=latest_user_content,
        output_tokens=estimate_text_tokens(response_text),
        provider=stack.config.engine_type,
        model=stack.config.model,
    )
    usage_payload["context_tokens_estimate"] = context_tokens_estimate
    attach_context_used_tokens(
        usage_payload, context_tokens_estimate=context_tokens_estimate
    )
    attach_context_window(usage_payload, engine)
    _flags = stack.config.feature_flags or {}
    attach_plan_usage(
        usage_payload,
        engine,
        enabled=is_chatgpt_plan_meter_enabled(_flags),
    )
    # Only forward the compaction trigger when compaction can actually fire
    # (both flags on) — see the matching gate in chat_decision_render.
    if is_feature_flag_enabled(_flags, FEATURE_TOKEN_BUDGET) and is_feature_flag_enabled(
        _flags, FEATURE_CONTEXT_COMPACTION
    ):
        attach_compact_threshold(usage_payload, engine, stack.config, num_tools=0)
    stop_reason = "error" if stream_error is not None else "end_turn"
    if debounced_writer is not None:
        debounced_writer.flush()
    # The provider finish reason rides the stream's terminal "done" chunk
    # (chat_streaming consumes ``engine.stream(...)`` directly — no
    # GenerationResult flows back), so the signal is request-scoped by
    # construction; the old shared ``engine._last_finish_reason`` attribute
    # leaked reasoning-only verdicts across requests. When the provider
    # stream normalizer detected reasoning-only, surface ``chat.error``
    # instead of the empty ``chat.done`` that would otherwise leave the user
    # with a blank assistant message.
    if stream_error is None and stream_finish_reason == FINISH_REASON_REASONING_ONLY:
        emit(
            notification(
                CHAT_ERROR_METHOD,
                {
                    **notification_context(request_id, trace_id=trace_id, session_id=session_id),
                    "code": CMP_STREAM_REASONING_ONLY,
                    "message": ("Reasoning-only completion (no visible text and no tool call)"),
                    "retryable": False,
                },
            )
        )
        emit_canonical(
            "turn_failed",
            {
                "code": CMP_STREAM_REASONING_ONLY,
                "message": ("Reasoning-only completion (no visible text and no tool call)"),
                "retryable": False,
            },
        )
        return ChatResponse(
            request_id=request_id,
            result=build_turn_result(
                request_id=request_id,
                status=TURN_STATE_RUNTIME_ERROR,
                terminal_subcode=TERMINAL_SUBCODE_REASONING_ONLY,
            ),
            notifications=notifications,
            approval_request=None,
        )
    if stream_error is None and (
        stream_finish_reason in {
            FINISH_REASON_INCOMPLETE,
            FINISH_REASON_PROVIDER_ERROR,
            FINISH_REASON_THINKING_BUDGET,
        }
        or (stream_finish_reason == "length" and not response_text.strip())
    ):
        error_message = {
            FINISH_REASON_INCOMPLETE: (
                "The response was cut off before it finished — the model ran out of output "
                "tokens or the stream ended early. Partial output may appear above; retry "
                "to try again."
            ),
            FINISH_REASON_PROVIDER_ERROR: (
                "The model provider reported a stream error before the response finished. "
                "Retry to try again."
            ),
            FINISH_REASON_THINKING_BUDGET: (
                "The model spent its entire thinking budget without reaching a final answer, "
                "so the turn was stopped. Retry, or lower the reasoning effort."
            ),
            "length": (
                "The model used its entire output budget before producing an answer. "
                "Retry, or lower the reasoning effort."
            ),
        }[stream_finish_reason]
        error_payload = {
            **notification_context(
                request_id,
                trace_id=trace_id,
                session_id=session_id,
            ),
            "code": CMP_STREAM_INCOMPLETE,
            "message": error_message,
            "retryable": True,
        }
        attach_plan_usage(
            error_payload,
            engine,
            enabled=is_chatgpt_plan_meter_enabled(_flags),
        )
        emit(
            notification(
                CHAT_ERROR_METHOD,
                error_payload,
            )
        )
        emit_canonical(
            "turn_failed",
            {
                "code": CMP_STREAM_INCOMPLETE,
                "message": error_message,
                "retryable": True,
            },
        )
        return ChatResponse(
            request_id=request_id,
            result=build_turn_result(
                request_id=request_id,
                status=TURN_STATE_RUNTIME_ERROR,
                terminal_subcode=(
                    TERMINAL_SUBCODE_THINKING_BUDGET
                    if stream_finish_reason == FINISH_REASON_THINKING_BUDGET
                    else TERMINAL_SUBCODE_STREAM_INCOMPLETE
                ),
            ),
            notifications=notifications,
            approval_request=None,
        )
    if response_text:
        emit_canonical(
            "text_part_completed",
            {
                "text": response_text,
                "assistant_phase": "final_answer",
                "segment_id": f"assistant_{request_id}_seg_0",
                "segment_group_index": 0,
            },
        )
    emit(
        notification(
            CHAT_DONE_METHOD,
            {
                **notification_context(request_id, trace_id=trace_id, session_id=session_id),
                "usage": usage_payload,
                "stop_reason": stop_reason,
                "model": str(usage_payload.get("model") or stack.config.model),
                "provider": str(usage_payload.get("provider") or stack.config.engine_type),
            },
        )
    )
    # CTL-016: canonical semantics reserve turn_completed for successful
    # terminals. A failed stream emits turn_failed instead; the legacy
    # chat.done (stop_reason=error, above) is kept unchanged for the legacy
    # transport-drain contract, and the re-raise below is unchanged too.
    if stream_error is not None:
        emit_canonical(
            "turn_failed",
            {
                "code": CMP_CHAT_STREAM_FAILED,
                "message": str(stream_error) or stream_error.__class__.__name__,
                "retryable": False,
            },
        )
    else:
        emit_canonical(
            "turn_completed",
            {
                "stop_reason": stop_reason,
                "model": str(usage_payload.get("model") or stack.config.model),
                "provider": str(usage_payload.get("provider") or stack.config.engine_type),
            },
        )
    if stream_error is not None:
        raise stream_error
    return ChatResponse(
        request_id=request_id,
        result={"request_id": request_id, "status": "completed"},
        notifications=notifications,
        approval_request=None,
        post_settlement_callback=(
            (lambda: post_response_callback(response_text))
            if callable(post_response_callback)
            else None
        ),
    )
