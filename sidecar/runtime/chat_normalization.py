"""Input normalization for chat.send request parameters."""

from __future__ import annotations

import json
import logging
from datetime import date
from typing import Any

from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.vision_attachments import normalize_vision_attachments  # noqa: F401

logger = logging.getLogger(__name__)

_VALID_REASONING_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})
_REASONING_EFFORT_ALIASES = {
    "med": "medium",
    "extra-high": "xhigh",
    "extra_high": "xhigh",
    "extra high": "xhigh",
}
_SESSION_START_DATE_ISO_ERROR = "chat.send params.session_start_date must be an ISO date string"
_MEMORY_POLICY_KEYS = frozenset({"enabled", "include_response_style"})
_APPROVED_PLAN_KEYS = frozenset({"plan_id", "title", "summary", "steps", "notes", "verification"})


def normalize_messages(messages: Any) -> list[dict[str, object]]:
    if not isinstance(messages, list):
        raise ValueError("chat.send params.messages must be a list")
    normalized: list[dict[str, object]] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise ValueError(f"chat.send params.messages[{index}] must be an object")
        normalized.append(dict(message))
    return normalized


def plan_mode_from_params(params: Any) -> bool:
    if not isinstance(params, dict):
        return False
    if "plan_mode" not in params:
        return False
    value = params.get("plan_mode")
    if not isinstance(value, bool):
        raise ValueError("chat.send params.plan_mode must be a boolean when provided")
    return value


def approved_plan_from_params(params: Any) -> dict[str, Any] | None:
    if not isinstance(params, dict) or "approved_plan" not in params:
        return None
    value = params.get("approved_plan")
    if value is None:
        return None
    if not isinstance(value, dict) or set(map(str, value)) - _APPROVED_PLAN_KEYS:
        raise ValueError("chat.send params.approved_plan must be a supported plan object")
    title = value.get("title")
    steps = value.get("steps")
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 120:
        raise ValueError("chat.send params.approved_plan.title must be 1-120 characters")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 20:
        raise ValueError("chat.send params.approved_plan.steps must contain 1-20 strings")
    normalized_steps: list[str] = []
    for index, step in enumerate(steps):
        if not isinstance(step, str) or not step.strip() or len(step.strip()) > 300:
            raise ValueError(
                f"chat.send params.approved_plan.steps[{index}] must be 1-300 characters"
            )
        normalized_steps.append(step.strip())
    def optional_text(key: str, limit: int) -> str:
        candidate = value.get(key)
        if candidate is None:
            return ""
        if not isinstance(candidate, str) or len(candidate.strip()) > limit:
            raise ValueError(
                f"chat.send params.approved_plan.{key} must be at most {limit} characters"
            )
        return candidate.strip()

    normalized: dict[str, Any] = {
        "plan_id": optional_text("plan_id", 80),
        "title": title.strip(),
        "summary": optional_text("summary", 800),
        "steps": normalized_steps,
        "notes": optional_text("notes", 4000),
        "verification": optional_text("verification", 400),
    }
    encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 8192:
        raise ValueError("chat.send params.approved_plan exceeds the size limit")
    return normalized


def memory_policy_from_params(params: Any) -> MemoryPolicy | None:
    """Normalize the additive memory policy; omission preserves legacy behavior."""

    if not isinstance(params, dict) or "memory_policy" not in params:
        return None
    value = params.get("memory_policy")
    if not isinstance(value, dict):
        raise ValueError("chat.send params.memory_policy must be an object")
    unknown = {str(key) for key in value} - _MEMORY_POLICY_KEYS
    if unknown:
        raise ValueError("chat.send params.memory_policy contains unsupported fields")
    enabled = value.get("enabled", True)
    include_response_style = value.get("include_response_style", True)
    if not isinstance(enabled, bool):
        raise ValueError("chat.send params.memory_policy.enabled must be a boolean")
    if not isinstance(include_response_style, bool):
        raise ValueError("chat.send params.memory_policy.include_response_style must be a boolean")
    return MemoryPolicy(
        enabled=enabled,
        include_response_style=include_response_style,
    )


def reasoning_effort_from_params(params: Any) -> str | None:
    if not isinstance(params, dict):
        return None
    if "reasoning_effort" not in params or params.get("reasoning_effort") is None:
        return None
    raw_value = params.get("reasoning_effort")
    if not isinstance(raw_value, str):
        raise ValueError("chat.send params.reasoning_effort must be a string when provided")
    token = raw_value.strip().lower()
    if not token or token == "default":
        return None
    normalized = _REASONING_EFFORT_ALIASES.get(token, token)
    if normalized not in _VALID_REASONING_EFFORTS:
        allowed = ", ".join(["default", *sorted(_VALID_REASONING_EFFORTS)])
        raise ValueError(f"chat.send params.reasoning_effort must be one of: {allowed}")
    return normalized


def session_start_date_from_params(params: Any) -> str | None:
    if not isinstance(params, dict):
        return None
    if "session_start_date" not in params or params.get("session_start_date") is None:
        return None
    raw_value = params.get("session_start_date")
    if not isinstance(raw_value, str):
        raise ValueError(_SESSION_START_DATE_ISO_ERROR)
    token = raw_value.strip()
    if not token:
        return None
    if len(token) != 10:
        raise ValueError(_SESSION_START_DATE_ISO_ERROR)
    if token[4] != "-" or token[7] != "-":
        raise ValueError(_SESSION_START_DATE_ISO_ERROR)
    year, month, day = token[:4], token[5:7], token[8:10]
    if not (year.isdigit() and month.isdigit() and day.isdigit()):
        raise ValueError(_SESSION_START_DATE_ISO_ERROR)
    try:
        date.fromisoformat(token)
    except ValueError as error:
        raise ValueError("chat.send params.session_start_date must be a valid ISO date") from error
    return token


def normalize_interactive_response(params: Any) -> dict[str, Any] | None:
    if not isinstance(params, dict):
        return None
    value = params.get("interactive_response")
    if not isinstance(value, dict):
        return None
    batch_id = str(value.get("batch_id") or "").strip()
    if not batch_id:
        return None
    return dict(value)


def normalize_tool_preferences(value: Any) -> dict[str, tuple[str, ...]] | None:
    if not isinstance(value, dict):
        return None
    enabled_raw = value.get("enabled_tools")
    disabled_raw = value.get("disabled_tools")
    disabled_families_raw = value.get("disabled_tool_families")
    enabled: set[str] = set()
    disabled: set[str] = set()
    disabled_families: set[str] = set()
    if isinstance(enabled_raw, list):
        for item in enabled_raw:
            token = str(item or "").strip()
            if token:
                enabled.add(token)
    if isinstance(disabled_raw, list):
        for item in disabled_raw:
            token = str(item or "").strip()
            if token:
                disabled.add(token)
    if isinstance(disabled_families_raw, list):
        for item in disabled_families_raw:
            token = str(item or "").strip()
            if token:
                disabled_families.add(token)
    enabled -= disabled
    if not enabled and not disabled and not disabled_families:
        return None
    return {
        "enabled_tools": tuple(sorted(enabled)),
        "disabled_tools": tuple(sorted(disabled)),
        "disabled_tool_families": tuple(sorted(disabled_families)),
    }


_TOOL_PREFERENCE_KEYS = frozenset({"enabled_tools", "disabled_tools", "disabled_tool_families"})


def tool_preferences_require_sub_agent_fail_closed(value: Any) -> bool:
    """Preserve malformed or explicitly empty authority lost by normalization."""

    if value is None:
        return False
    if not isinstance(value, dict) or any(str(key) not in _TOOL_PREFERENCE_KEYS for key in value):
        return True
    has_token = False
    for raw_items in value.values():
        if not isinstance(raw_items, list):
            return True
        for item in raw_items:
            if not isinstance(item, str) or not item.strip():
                return True
            has_token = True
    return not has_token


# ── Typed trusted-context channel (chat.send params.context_blocks) ──────────
#
# Electron assembles per-turn context overlays (the open file / @-mentions,
# git status, the personality workspace, codebase grounding,
# linked-session recall) and used to splice them into ``params.messages`` as
# ``role: "system"`` rows. Request history is UNTRUSTED, so the semantic
# admission gate (sidecar/ai/context/messages.py) correctly dropped every one of
# them and all six overlays were inert before inference. They now arrive on this
# separate typed channel instead: a frozen ``kind`` allowlist, one block per
# kind, bounded per-block and in aggregate. The history filter is unchanged and
# still rejects forged system rows. The retired ``research`` kind is accepted
# only far enough to emit a specific compatibility diagnostic, then dropped.
CONTEXT_BLOCK_KINDS = frozenset(
    {
        "active_file",
        "git",
        "personality",
        "codebase",
        "linked_session",
    }
)
MAX_CONTEXT_BLOCKS = 5
# Generous by design: Electron already trims these blocks to the model's
# MEASURED effective window (context-budget-trimmer.js), so these ceilings are a
# transport-integrity backstop against a runaway block, not a context policy. A
# tight bound here would silently clip legitimate overlays on wide-window models
# (a 272K window leaves room for far more than 256 KiB of blocks).
MAX_CONTEXT_BLOCK_BYTES = 512 * 1024
MAX_CONTEXT_BLOCKS_TOTAL_BYTES = 2 * 1024 * 1024


def _log_context_block_drop(reason: str, *, index: int, kind: str = "") -> None:
    log_event(
        logger,
        logging.WARNING,
        component="runtime.chat_normalization",
        event="runtime.chat_normalization.context_block_rejected",
        message="Dropped a chat.send context block that failed admission.",
        status="degraded",
        data={"reason": reason, "index": index, "kind": kind},
    )


def _truncate_to_bytes(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    # errors="ignore" drops a split trailing multi-byte sequence rather than
    # emitting a replacement char, so the result is always <= max_bytes.
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def normalize_context_blocks(value: Any) -> list[dict[str, str]]:
    """Validate and bound the typed trusted-context channel.

    Fail-soft per entry (drop + structured log) so a future Electron kind can
    never brick chat, but fail-hard on the container shape: a non-list
    ``context_blocks`` is a caller bug, not a degraded overlay.
    """
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("chat.send params.context_blocks must be a list")

    normalized: list[dict[str, str]] = []
    seen_kinds: set[str] = set()
    total_bytes = 0
    for index, entry in enumerate(value):
        if not isinstance(entry, dict):
            _log_context_block_drop("not_an_object", index=index)
            continue
        kind = str(entry.get("kind") or "").strip()
        if kind == "research":
            _log_context_block_drop("retired_kind", index=index, kind=kind)
            continue
        if kind not in CONTEXT_BLOCK_KINDS:
            _log_context_block_drop("unknown_kind", index=index, kind=kind)
            continue
        if kind in seen_kinds:
            # First-wins: a repeated kind is either a caller bug or an attempt
            # to multiply one overlay's weight past the aggregate bound.
            _log_context_block_drop("duplicate_kind", index=index, kind=kind)
            continue
        raw_content = entry.get("content")
        if not isinstance(raw_content, str) or not raw_content.strip():
            _log_context_block_drop("empty_content", index=index, kind=kind)
            continue
        if len(normalized) >= MAX_CONTEXT_BLOCKS:
            _log_context_block_drop("max_blocks_exceeded", index=index, kind=kind)
            continue
        content = _truncate_to_bytes(raw_content.strip(), MAX_CONTEXT_BLOCK_BYTES)
        if content != raw_content.strip():
            _log_context_block_drop("block_bytes_truncated", index=index, kind=kind)
        block_bytes = len(content.encode("utf-8"))
        if total_bytes + block_bytes > MAX_CONTEXT_BLOCKS_TOTAL_BYTES:
            _log_context_block_drop("total_bytes_exceeded", index=index, kind=kind)
            continue
        total_bytes += block_bytes
        seen_kinds.add(kind)
        normalized.append({"kind": kind, "content": content})
    return normalized


def normalize_debug_options(value: Any) -> dict[str, bool] | None:
    if not isinstance(value, dict):
        return None
    normalized = {
        "disable_thinking": value.get("disable_thinking") is True,
        "lean_context": value.get("lean_context") is True,
        "plain_chat_mode": value.get("plain_chat_mode") is True,
    }
    return normalized if any(normalized.values()) else None
