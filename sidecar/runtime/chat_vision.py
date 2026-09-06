"""Vision chat response construction for image attachment flows."""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.context.messages import compact_semantic_messages_with_report
from sidecar.ai.context.token_budget import (
    apply_budget_check,
    check_budget,
    estimate_messages_tokens,
)
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.exceptions import EngineError
from sidecar.ai.routing.retry import QUERY_SOURCE_VISION, execute_with_provider_retry
from sidecar.protocol import CHAT_DONE_METHOD, CHAT_TOKEN_METHOD
from sidecar.runtime.chat_helpers import (
    CHAT_INVALID_PARAMS,
    _fallback_usage_payload,
    build_vision_prompt,
    engine_supports_vision,
    estimate_text_tokens,
    notification_context,
    thinking_notification,
    tokenize_with_whitespace,
)
from sidecar.runtime.chat_models import ChatRequestError, ChatResponse
from sidecar.runtime.rpc import notification

logger = logging.getLogger(__name__)

# Mirrors request_dispatch.INTERNAL_ERROR_CODE; kept local because importing
# request_dispatch from here would be circular.
_INTERNAL_ERROR_RPC_CODE = -32000

# Mirrors the standard chat path's output budget (ollama_runtime.stream
# defaults to 16384) instead of the legacy 256-token OCR cap that silently
# clipped vision answers mid-sentence.
VISION_MAX_TOKENS_DEFAULT = 16384


def _vision_max_tokens(engine: Any) -> int:
    getter = getattr(engine, "get_model_max_output_tokens", None)
    if callable(getter):
        try:
            reported = getter()
        except Exception:  # noqa: BLE001 — capability probe only.
            reported = None
        if isinstance(reported, int) and reported > 0:
            return min(reported, VISION_MAX_TOKENS_DEFAULT)
    return VISION_MAX_TOKENS_DEFAULT


def _split_latest_user_round(
    messages: list[dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    for index in range(len(messages) - 1, -1, -1):
        if messages[index].get("role") == "user":
            return list(messages[:index]), list(messages[index:])
    return list(messages), []


def _warn_budget_fallback(*, reason: str, error: Exception | None = None) -> None:
    details = {
        "event": "runtime.chat_vision.budget_fallback",
        "reason": reason,
    }
    if error is not None:
        details["error_type"] = type(error).__name__
    logger.warning(
        "Vision history budgeting unavailable; using sanitized uncapped history.",
        extra=details,
    )


def _cap_vision_history(
    messages: list[dict[str, object]],
    *,
    config: Any,
    engine: Any,
) -> list[dict[str, object]]:
    try:
        _messages, budget, tracker = apply_budget_check(messages, config, engine)
    except Exception as error:  # noqa: BLE001 - budgeting must not fail a vision turn.
        _warn_budget_fallback(reason="budget_check_failed", error=error)
        return messages

    if budget is None or tracker is None or tracker.backend is None:
        _warn_budget_fallback(reason="budget_unavailable")
        return messages

    try:
        # estimate_messages_tokens is exactly linear per message (content +
        # tool-call args + a constant overhead), so per-message costs computed
        # once decompose the total and the drop-oldest walk needs no
        # re-tokenization.
        per_message_tokens = [
            estimate_messages_tokens([message], tracker.backend) for message in messages
        ]
        remaining_tokens = sum(per_message_tokens)
        status = check_budget(remaining_tokens, budget, num_tools=0)
        if status.level != "error":
            return messages

        older_messages, latest_user_round = _split_latest_user_round(messages)
        for drop_count in range(1, len(older_messages) + 1):
            remaining_tokens -= per_message_tokens[drop_count - 1]
            status = check_budget(remaining_tokens, budget, num_tools=0)
            if status.level != "error":
                return older_messages[drop_count:] + latest_user_round
        return latest_user_round
    except Exception as error:  # noqa: BLE001 - estimation must not fail a vision turn.
        _warn_budget_fallback(reason="budget_estimation_failed", error=error)
        return messages


def build_vision_chat_response(
    *,
    request_id: str,
    trace_id: str | None,
    session_id: str | None,
    latest_user_content: str,
    messages: list[dict[str, object]],
    image_attachments: list[dict[str, object]],
    brain_container: BrainContainer,
    invalid_params_code: int,
    post_response_callback: Any | None = None,
) -> ChatResponse:
    stack = brain_container.stack
    engine = stack.engine
    if not engine_supports_vision(engine):
        raise ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=CHAT_INVALID_PARAMS,
            message="The active model does not support image attachments.",
            rpc_code=invalid_params_code,
            retryable=False,
        )

    sanitized_messages = compact_semantic_messages_with_report(messages).messages
    prompt_messages = _cap_vision_history(
        sanitized_messages,
        config=stack.config,
        engine=engine,
    )
    prompt = build_vision_prompt(prompt_messages) or latest_user_content
    raw_vision_images = [attachment.get("_vision_image") for attachment in image_attachments]
    vision_images: list[str | VisionImage] = [
        image for image in raw_vision_images if isinstance(image, VisionImage)
    ]
    if not vision_images or len(vision_images) != len(raw_vision_images):
        raise ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=CHAT_INVALID_PARAMS,
            message="Image attachments were not validated for vision inference.",
            rpc_code=invalid_params_code,
            retryable=False,
        )
    try:
        raw_result = execute_with_provider_retry(
            operation=lambda context: engine.generate_with_vision(
                prompt=prompt,
                images=vision_images,
                max_tokens=context.max_tokens,
            ),
            logger=logger,
            component="runtime.chat_vision",
            event_prefix="runtime.chat_vision.retry",
            request_source=QUERY_SOURCE_VISION,
            provider=stack.config.engine_type,
            model=stack.config.model,
            initial_max_tokens=_vision_max_tokens(engine),
            feature_flags=stack.config.feature_flags,
        )
    except NotImplementedError as error:
        raise ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=CHAT_INVALID_PARAMS,
            message=str(error),
            rpc_code=invalid_params_code,
            retryable=False,
        ) from error
    except EngineError as error:
        # Previously fell through to request_dispatch's generic
        # CHAT_STREAM_FAILED handler, hiding e.g. "Could not connect to
        # Ollama" behind "chat.send failed while preparing response".
        raise ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=error.code,
            message=error.message,
            rpc_code=_INTERNAL_ERROR_RPC_CODE,
            retryable=bool(error.retryable),
        ) from error
    except ProviderHttpError as error:
        raise ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=error.code,
            message=str(error),
            rpc_code=_INTERNAL_ERROR_RPC_CODE,
            retryable=error.retryable,
        ) from error

    response_text = str(raw_result.content or "").strip()
    finish_reason = str(raw_result.finish_reason or "").strip().lower()
    stop_reason = "max_tokens" if finish_reason == "length" else "end_turn"

    if not response_text:
        raise ChatRequestError(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            code=CHAT_INVALID_PARAMS,
            message="Vision response returned no visible assistant text.",
            rpc_code=invalid_params_code,
            retryable=False,
        )

    notifications: list[dict[str, Any]] = [
        thinking_notification(
            request_id,
            trace_id=trace_id,
            session_id=session_id,
            delta="Analyzing attached image context.",
            thinking_id=f"think_{request_id}",
        )
    ]
    notifications.extend(
        notification(
            CHAT_TOKEN_METHOD,
            {
                **notification_context(request_id, trace_id=trace_id, session_id=session_id),
                "delta": delta,
                "role": "assistant",
            },
        )
        for delta in tokenize_with_whitespace(response_text)
    )
    usage_payload = _fallback_usage_payload(
        latest_user_content=latest_user_content,
        output_tokens=estimate_text_tokens(response_text),
        provider=stack.config.engine_type,
        model=stack.config.model,
    )
    notifications.append(
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
