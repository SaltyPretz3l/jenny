"""Request-scoped plan-mode prompt overlay."""

from __future__ import annotations

import json
import sys
from functools import lru_cache
from pathlib import Path

from sidecar.ai.context.runtime_message_markers import (
    APPROVED_PLAN_OVERLAY_HEADING,
    PLAN_MODE_OVERLAY_HEADING,
)


def _contract_path() -> Path:
    bundled_root = getattr(sys, "_MEIPASS", None)
    if bundled_root:
        return Path(bundled_root) / "services" / "tools" / "plan-mode-contract.json"
    return Path(__file__).resolve().parents[3] / "services" / "tools" / "plan-mode-contract.json"


@lru_cache(maxsize=1)
def _contract() -> dict[str, object]:
    return json.loads(_contract_path().read_text(encoding="utf-8"))


PLAN_MODE_GUIDANCE = str(_contract()["plan_mode_prompt"])
APPROVED_PLAN_GUIDANCE = str(_contract()["approved_plan_prompt"])


def build_plan_mode_overlay(*, plan_mode_active: bool) -> str:
    if not plan_mode_active:
        return ""
    return f"{PLAN_MODE_OVERLAY_HEADING}\n{PLAN_MODE_GUIDANCE}"


def append_plan_mode_runtime_overlay(
    runtime_system_messages: list[str],
    *,
    plan_mode_active: bool,
) -> None:
    overlay = build_plan_mode_overlay(plan_mode_active=plan_mode_active)
    if overlay:
        runtime_system_messages.append(overlay)


def build_approved_plan_overlay(plan: dict[str, object] | None = None) -> str:
    lines = [APPROVED_PLAN_OVERLAY_HEADING, APPROVED_PLAN_GUIDANCE]
    if isinstance(plan, dict):
        title = str(plan.get("title") or "").strip()
        steps = plan.get("steps")
        if title and isinstance(steps, list) and steps:
            lines.extend(["", f"Approved plan: {title}"])
            summary = str(plan.get("summary") or "").strip()
            if summary:
                lines.append(summary)
            for index, step in enumerate(steps[:20], start=1):
                lines.append(f"{index}. {str(step).strip()[:300]}")
            notes = str(plan.get("notes") or "").strip()
            if notes:
                lines.extend(["", notes[:4000]])
            verification = str(plan.get("verification") or "").strip()
            if verification:
                lines.extend(["", f"Verification: {verification[:400]}"])
    return "\n".join(lines)[:8000]


def append_approved_plan_runtime_overlay(
    runtime_system_messages: list[str],
    *,
    approved_plan: dict[str, object] | None,
) -> None:
    if approved_plan:
        runtime_system_messages.append(build_approved_plan_overlay(approved_plan))


__all__ = [
    "PLAN_MODE_GUIDANCE",
    "APPROVED_PLAN_GUIDANCE",
    "append_plan_mode_runtime_overlay",
    "append_approved_plan_runtime_overlay",
    "build_approved_plan_overlay",
    "build_plan_mode_overlay",
]
