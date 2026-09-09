"""Personality helpers for system prompt composition.

One `## Personality` system message per non-minimal turn. Electron owns the
body (the `### Voice` / `### About the user` / `### Notes` sections compiled
from the personality workspace); the sidecar owns the heading, precedence
sentence, and optional reply-language instruction, sanitizes whatever Electron
sent, and is the single source for those prompt literals.
"""

from __future__ import annotations

from typing import Any

DEFAULT_ASSISTANT_NAME = "Jenny"

DEFAULT_PERSONALITY_BASE_PROMPT = (
    "You are the AI assistant in Jenny, a local-first desktop harness for coding, "
    "data visualization, and tool-based work. Be warm, direct, practical, and honest. "
    "Let personality shape tone, not task accuracy. Follow the user's current request "
    "and the runtime, workspace, and tool instructions."
)
_ASSISTANT_NAME_MAX_CHARS = 80
_ASSISTANT_NAME_ALLOWED_PUNCTUATION = set(" ._'-")

# Single source of truth for the two literals Electron mirrors when it renders
# the Settings preview (`services/personality-workspace-service.js` exports the
# same strings and a node test asserts byte identity against this file).
PERSONALITY_HEADING = "## Personality"
PERSONALITY_PRECEDENCE_TEMPLATE = (
    "Your name is {name}. You are software, not a living being: you have no body, feelings, "
    "or consciousness, and you never claim otherwise. Personality shapes tone, not facts; the "
    "current request and the runtime, workspace, and tool instructions take precedence over "
    "everything below."
)
UI_LANGUAGE_INSTRUCTION_TEMPLATE = (
    "Reply in {language} unless the user writes in another language; then match the user's "
    "language."
)


def normalize_assistant_name(value: Any) -> str:
    if isinstance(value, str):
        normalized = " ".join(value.strip().split())
        if normalized:
            from sidecar.ai.personality.sanitization import sanitize_bootstrap  # noqa: PLC0415

            sanitized = sanitize_bootstrap(
                normalized,
                source_name="assistant_identity.agent_name",
            )
            if sanitized != normalized:
                return DEFAULT_ASSISTANT_NAME
            display_name = "".join(
                char if char.isalnum() or char in _ASSISTANT_NAME_ALLOWED_PUNCTUATION else " "
                for char in sanitized
            )
            display_name = " ".join(display_name.split())
            if display_name:
                return display_name[:_ASSISTANT_NAME_MAX_CHARS]
    return DEFAULT_ASSISTANT_NAME


def normalize_personality_base_prompt(base_prompt: str) -> str:
    normalized_base = str(base_prompt or "").strip()
    return normalized_base or DEFAULT_PERSONALITY_BASE_PROMPT


def _personality_header(agent_name: Any) -> str:
    try:
        name = normalize_assistant_name(agent_name)
    except (TypeError, ValueError, AttributeError):
        name = DEFAULT_ASSISTANT_NAME
    return f"{PERSONALITY_HEADING}\n{PERSONALITY_PRECEDENCE_TEMPLATE.format(name=name)}"


def ui_language_instruction(ui_language: Any) -> str:
    from sidecar.ai.config_parsing import (  # noqa: PLC0415
        UI_LANGUAGE_NAMES,
        _normalize_ui_language,
    )

    normalized = _normalize_ui_language(ui_language)
    if normalized == "en":
        return ""
    return UI_LANGUAGE_INSTRUCTION_TEMPLATE.format(language=UI_LANGUAGE_NAMES[normalized])


def build_personality_system_message(
    agent_name: Any,
    content: Any = "",
    *,
    ui_language: Any = "en",
) -> str:
    """Render the single per-turn personality system message.

    The heading and the name/precedence line are always present, even when the
    workspace is empty, so the model always knows what it is called. A
    non-English UI language adds one instruction line. ``content`` is
    Electron-compiled, user-authored text: it is sanitized here and appended
    only when something survives.
    """
    from sidecar.ai.personality.sanitization import sanitize_bootstrap  # noqa: PLC0415

    header = _personality_header(agent_name)
    language_instruction = ui_language_instruction(ui_language)
    if language_instruction:
        header = f"{header}\n{language_instruction}"
    try:
        sanitized = sanitize_bootstrap(content, source_name="context_blocks.personality")
    except (TypeError, ValueError, AttributeError):
        sanitized = ""
    if not sanitized:
        return header
    return f"{header}\n\n{sanitized}"


def is_personality_overlay_system_message(content: Any) -> bool:
    """Recognize the v3 personality message and ONLY it.

    A bare ``startswith`` would also claim the retired v2 headings, which all
    begin ``## Personality ...`` -- so the heading must be the whole first
    line.
    """
    text = str(content or "")
    return text == PERSONALITY_HEADING or text.startswith(PERSONALITY_HEADING + "\n")


__all__ = [
    "DEFAULT_ASSISTANT_NAME",
    "DEFAULT_PERSONALITY_BASE_PROMPT",
    "PERSONALITY_HEADING",
    "PERSONALITY_PRECEDENCE_TEMPLATE",
    "UI_LANGUAGE_INSTRUCTION_TEMPLATE",
    "build_personality_system_message",
    "is_personality_overlay_system_message",
    "normalize_assistant_name",
    "normalize_personality_base_prompt",
    "ui_language_instruction",
]
