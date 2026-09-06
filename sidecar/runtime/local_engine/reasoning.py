"""Shared local-engine reasoning helpers."""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.reasoning_parser import (
    DelimitedReasoningParser,
    ReasoningExtraction,
    extract_delimited_reasoning,
    strip_known_reasoning_blocks,
    strip_known_reasoning_markers,
)


def request_reasoning_parser_tokens(
    app_profile_behavior: dict[str, Any] | None,
) -> tuple[str, str] | None:
    behavior = app_profile_behavior if isinstance(app_profile_behavior, dict) else {}
    start_token = str(behavior.get("reasoning_parser_start") or "").strip()
    end_token = str(behavior.get("reasoning_parser_end") or "").strip()
    if not start_token or not end_token:
        return None
    return (start_token, end_token)


def create_request_reasoning_parser(
    app_profile_behavior: dict[str, Any] | None,
) -> DelimitedReasoningParser | None:
    tokens = request_reasoning_parser_tokens(app_profile_behavior)
    if tokens is None:
        return None
    start_token, end_token = tokens
    return DelimitedReasoningParser(
        start_token=start_token,
        end_token=end_token,
    )


def sanitize_visible_text(text: str) -> str:
    return strip_known_reasoning_markers(strip_known_reasoning_blocks(str(text or "")))


def sanitize_thinking_text(text: str) -> str:
    return strip_known_reasoning_markers(str(text or ""))


def reasoning_output_enabled(
    *,
    native_thinking: bool,
    app_profile_behavior: dict[str, Any] | None,
) -> bool:
    return native_thinking or request_reasoning_parser_tokens(app_profile_behavior) is not None


def log_reasoning_parser_fallback(
    *,
    logger: logging.Logger,
    context: dict[str, Any] | None,
    engine_type: str,
    model_name: str | None,
    app_profile_behavior: dict[str, Any] | None,
    parser_mode: str,
    reasoning_chars: int,
    visible_chars: int,
) -> None:
    if isinstance(context, dict) and context.get("reasoning_parser_logged") is True:
        return
    if isinstance(context, dict):
        context["reasoning_parser_logged"] = True
    behavior = app_profile_behavior if isinstance(app_profile_behavior, dict) else {}
    logger.info(
        "%s reasoning parser fallback activated.",
        engine_type,
        extra={
            "request_id": str((context or {}).get("request_id") or "").strip() or None,
            "engine": engine_type,
            "model": model_name,
            "family": str(behavior.get("family") or "").strip() or None,
            "variant": str(behavior.get("variant") or "").strip() or None,
            "parser_mode": parser_mode,
            "reasoning_chars": reasoning_chars,
            "visible_chars": visible_chars,
        },
    )


def extract_request_reasoning(
    text: str,
    *,
    app_profile_behavior: dict[str, Any] | None,
    parser_mode: str,
    logger: logging.Logger,
    context: dict[str, Any] | None,
    engine_type: str,
    model_name: str | None,
) -> ReasoningExtraction | None:
    tokens = request_reasoning_parser_tokens(app_profile_behavior)
    if tokens is None:
        return None
    start_token, end_token = tokens
    extracted = extract_delimited_reasoning(
        text,
        start_token=start_token,
        end_token=end_token,
    )
    if not extracted.used_markers:
        return None
    log_reasoning_parser_fallback(
        logger=logger,
        context=context,
        engine_type=engine_type,
        model_name=model_name,
        app_profile_behavior=app_profile_behavior,
        parser_mode=parser_mode,
        reasoning_chars=len(extracted.reasoning_text),
        visible_chars=len(extracted.visible_text),
    )
    return extracted
