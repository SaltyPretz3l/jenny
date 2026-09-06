"""Chat mode policy for tool access and approval behavior."""

from __future__ import annotations

from dataclasses import dataclass

MODE_CHAT = "chat"
MODE_ASSIST = "assist"
MODE_AUTONOMOUS = "autonomous"
VALID_MODES = frozenset({MODE_CHAT, MODE_ASSIST, MODE_AUTONOMOUS})


@dataclass(frozen=True)
class ModePolicy:
    mode: str
    allow_tools: bool
    allow_side_effecting_tools: bool
    require_approval_for_side_effecting: bool


def normalize_mode(value: str | None, default: str = MODE_CHAT) -> str:
    fallback = (
        default.strip().lower() if isinstance(default, str) and default.strip() else MODE_CHAT
    )
    if fallback not in VALID_MODES:
        fallback = MODE_CHAT

    if not isinstance(value, str) or not value.strip():
        return fallback

    token = value.strip().lower()
    if token in VALID_MODES:
        return token
    return fallback


def policy_for_mode(mode: str | None) -> ModePolicy:
    resolved = normalize_mode(mode)
    if resolved == MODE_CHAT:
        return ModePolicy(
            mode=resolved,
            allow_tools=False,
            allow_side_effecting_tools=False,
            require_approval_for_side_effecting=False,
        )

    # Assist and autonomous both allow tools, but side effects still flow through
    # explicit confirmation by default.
    return ModePolicy(
        mode=resolved,
        allow_tools=True,
        allow_side_effecting_tools=True,
        require_approval_for_side_effecting=True,
    )
