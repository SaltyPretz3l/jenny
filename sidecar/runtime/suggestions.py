"""Generate contextual prompt suggestions for the empty-chat splash page.

Uses the configured engine to produce short, personalized conversation
starters based on companion mode, time of day, approved memories, and
recent session history.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List

from sidecar.ai.container import BrainContainer
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.feature_flags import FEATURE_PROMPT_CACHE, is_feature_flag_enabled
from sidecar.ai.routing.retry import (
    QUERY_SOURCE_BACKGROUND_CLASSIFIER,
    execute_with_provider_retry,
)
from sidecar.runtime.diagnostics import log_event

_MAX_TOKENS = 300
_TEMPERATURE = 0.85
_MIN_PROMPT_LENGTH = 5
_MAX_PROMPT_LENGTH = 80
_MIN_VALID_PROMPTS = 2
_MAX_VALID_PROMPTS = 4

_SYSTEM_PROMPT = (
    "You are generating conversation starter chips for a companion AI's "
    "empty-chat splash page. Return a JSON array of exactly 4 short "
    "conversation starters (5-15 words each). Each should feel natural, "
    "warm, and contextual — like something a thoughtful companion would "
    "suggest based on the user's current situation. Do not include "
    "numbering, quotation marks around the array items, or explanation. "
    "Return ONLY a valid JSON array of strings."
)


def _build_user_message(context: Dict[str, Any]) -> str:
    """Build the user-facing context message for the engine."""
    parts: list[str] = []

    time_of_day = str(context.get("time_of_day", "")).strip()
    if time_of_day:
        parts.append(f"Time of day: {time_of_day}")

    companion_mode = str(context.get("companion_mode", "")).strip()
    if companion_mode:
        parts.append(f"Companion mode: {companion_mode}")

    framing_hint = str(context.get("framing_hint", "")).strip()
    if framing_hint:
        parts.append(f"Mode framing: {framing_hint}")

    briefing_summary = str(context.get("briefing_summary", "")).strip()
    if briefing_summary:
        parts.append(f"Today's briefing: {briefing_summary}")

    memory_titles = context.get("recent_memory_titles")
    if isinstance(memory_titles, list) and memory_titles:
        safe_titles = [str(t).strip() for t in memory_titles[:3] if str(t).strip()]
        if safe_titles:
            parts.append(f"Recent memories: {', '.join(safe_titles)}")

    session_titles = context.get("recent_session_titles")
    if isinstance(session_titles, list) and session_titles:
        safe_titles = [str(t).strip() for t in session_titles[:3] if str(t).strip()]
        if safe_titles:
            parts.append(f"Recent chats: {', '.join(safe_titles)}")

    personality_name = str(context.get("personality_name", "")).strip()
    if personality_name:
        parts.append(f"Assistant name: {personality_name}")

    return "\n".join(parts) if parts else "Generate 4 general conversation starters."


def _strip_code_fences(text: str) -> str:
    """Remove markdown code fences wrapping JSON."""
    stripped = text.strip()
    stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
    stripped = re.sub(r"\s*```$", "", stripped)
    return stripped.strip()


def _parse_and_validate(raw: str) -> List[str]:
    """Parse the engine response and validate the prompt list."""
    cleaned = _strip_code_fences(raw)
    parsed = json.loads(cleaned)

    if not isinstance(parsed, list):
        return []

    valid: list[str] = []
    for item in parsed:
        if not isinstance(item, str):
            continue
        prompt = item.strip()
        if _MIN_PROMPT_LENGTH <= len(prompt) <= _MAX_PROMPT_LENGTH:
            valid.append(prompt)

    return valid[:_MAX_VALID_PROMPTS] if len(valid) >= _MIN_VALID_PROMPTS else []


def generate_suggestions(
    brain_container: BrainContainer,
    context: Dict[str, Any],
    logger: logging.Logger,
) -> List[str]:
    """Generate contextual prompt suggestions using the configured engine.

    Returns a list of 2-4 short prompt strings, or an empty list on failure.
    Never raises — all errors are caught and logged.
    """
    if brain_container.stack is None:
        log_event(
            logger,
            logging.WARNING,
            component="runtime.suggestions",
            event="suggestions.generate_skipped",
            message="Skipped suggestion generation — no brain stack available",
        )
        return []

    user_message = _build_user_message(context)
    prompt_cache_enabled = is_feature_flag_enabled(
        brain_container.stack.config.feature_flags or {},
        FEATURE_PROMPT_CACHE,
    )

    try:
        raw = execute_with_provider_retry(
            operation=lambda context: brain_container.stack.engine.generate(
                prompt=user_message,
                max_tokens=context.max_tokens,
                temperature=_TEMPERATURE,
                # Background chip generation must never think: on a
                # thinking-capable model the engine inflates num_predict by
                # its thinking headroom (16k on large-context models), and a
                # single-slot Ollama then decodes reasoning for MINUTES while
                # the user's real chat request starves behind it. "low" sends
                # an explicit think:false.
                reasoning_effort="low",
                prompt_cache_enabled=prompt_cache_enabled,
                system=_SYSTEM_PROMPT,
                response_format=ResponseFormat(type="json_object"),
            ),
            logger=logger,
            component="runtime.suggestions",
            event_prefix="runtime.suggestions.retry",
            request_source=QUERY_SOURCE_BACKGROUND_CLASSIFIER,
            provider=brain_container.stack.config.engine_type,
            model=brain_container.stack.config.model,
            initial_max_tokens=_MAX_TOKENS,
            feature_flags=brain_container.stack.config.feature_flags,
        )
    except Exception:
        log_event(
            logger,
            logging.WARNING,
            component="runtime.suggestions",
            event="suggestions.generate_failed",
            message="Engine call failed during suggestion generation",
        )
        return []

    try:
        return _parse_and_validate(raw)
    except (json.JSONDecodeError, ValueError, TypeError):
        log_event(
            logger,
            logging.WARNING,
            component="runtime.suggestions",
            event="suggestions.parse_failed",
            message="Failed to parse engine response as valid suggestion list",
            data={"raw_length": len(raw) if raw else 0},
        )
        return []
