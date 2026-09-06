"""Shared assembly helpers for system-prompt snapshot tests.

Underscored module name keeps pytest from discovering this file as a test
target. Both ``test_prompt_snapshot.py`` (six pinned scenarios) and
``test_prompt_cross_mode.py`` (Phase 12B / I.B.6 parametrized table) import
the same helpers from here.

The helpers wrap :class:`ContextBuilder` against a fixture workspace under
``tests/sidecar/ai/context/fixtures/workspace/``, build the cacheable
prefix, assemble runtime overlays in the canonical insertion order, and
redact per-machine variance through :mod:`_snapshot_support`. The result
is text suitable for byte-for-byte snapshot comparison.

Snapshot drift discipline: the snapshot files under ``snapshots/`` are
load-bearing — drift means the prompt cache will silently regress. Read
``_snapshot_support.py`` for the full discipline before regenerating.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sidecar.ai.context.builder import ContextBuilder, RuntimeToolStatus
from sidecar.ai.context.prompt_cache import StructuredSystemPrompt
from sidecar.ai.context.prompt_modes import build_plan_mode_overlay
from tests.sidecar.ai.context._snapshot_support import (
    PLACEHOLDER_WORKSPACE_ROOT,
    redact,
)

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "workspace"
SNAPSHOTS_ROOT = Path(__file__).resolve().parent / "snapshots"
FIXED_SESSION_DATE = "2026-01-01"
RUNTIME_OVERLAY_SEPARATOR = "\n\n---RUNTIME-OVERLAYS---\n\n"


@dataclass(frozen=True)
class Memory:
    """Minimal duck-type for ``ContextBuilder.build_memory_recall_system_message``."""

    title: str
    lesson_text: str
    lesson_kind: str
    confidence: float


def make_context_builder() -> ContextBuilder:
    """Return a ContextBuilder pointed at the fixture workspace."""
    assert FIXTURE_ROOT.exists(), f"fixture workspace missing: {FIXTURE_ROOT}"
    return ContextBuilder(workspace_root=FIXTURE_ROOT)


def fixture_tool_statuses() -> list[RuntimeToolStatus]:
    """Stable tool-status list. Snapshots do not depend on live registry output."""
    return [
        RuntimeToolStatus(
            name="read_file",
            display_name="Read file",
            available=True,
            description="Reads workspace files for the snapshot fixture.",
            source_kind="builtin",
            tool_family="filesystem",
        ),
        RuntimeToolStatus(
            name="glob_files",
            display_name="Find files",
            available=True,
            description="Glob for paths under the workspace root.",
            source_kind="builtin",
            tool_family="filesystem",
        ),
    ]


def build_cacheable_prefix() -> str:
    builder = make_context_builder()
    structured = builder.build_system_prompt(
        runtime_system_prompt="You are Jenny, the Phase 12A snapshot subject.",
        cache_aware=True,
        session_start_date=FIXED_SESSION_DATE,
        current_date=FIXED_SESSION_DATE,
        tool_statuses=fixture_tool_statuses(),
        latest_user_content="Read README.md and summarize.",
        engine_type="local-replay",
        include_skills=False,
    )
    assert isinstance(structured, StructuredSystemPrompt)
    return structured.to_text()


def assemble(*, runtime_overlays: list[str]) -> str:
    """Assemble cacheable prefix + runtime overlays and redact per-machine variance."""
    prefix = build_cacheable_prefix()
    overlays = [overlay for overlay in runtime_overlays if overlay]
    if not overlays:
        return redact(prefix + "\n", workspace_root=FIXTURE_ROOT) + (
            f"\n# (No runtime overlays)\n# Workspace: {PLACEHOLDER_WORKSPACE_ROOT}\n"
        )
    payload = prefix + RUNTIME_OVERLAY_SEPARATOR + "\n\n".join(overlays)
    return redact(payload + "\n", workspace_root=FIXTURE_ROOT)


def memory_overlay() -> str:
    builder = make_context_builder()
    return builder.build_memory_recall_system_message(
        [
            Memory(
                title="Snapshot fixture memory",
                lesson_text="This memory is only used by the Phase 12A snapshot tests.",
                lesson_kind="memory",
                confidence=0.42,
            ),
        ],
    )


def plan_overlay() -> str:
    return build_plan_mode_overlay(plan_mode_active=True)


__all__ = [
    "FIXED_SESSION_DATE",
    "FIXTURE_ROOT",
    "Memory",
    "RUNTIME_OVERLAY_SEPARATOR",
    "SNAPSHOTS_ROOT",
    "assemble",
    "build_cacheable_prefix",
    "fixture_tool_statuses",
    "make_context_builder",
    "memory_overlay",
    "plan_overlay",
]
