"""Lightweight markers for runtime-only prompt system messages.

Single source of truth for the heading prefixes that
:meth:`ContextBuilder.is_runtime_system_message` recognizes as dynamic
(per-turn) overlays inserted into ``working_messages`` outside the
cached system prompt. Adding a new runtime overlay = add its heading
constant here, then include it in the ``RUNTIME_SYSTEM_MESSAGE_HEADINGS``
tuple so the recognizer picks it up automatically.
"""

from __future__ import annotations

MEMORY_RECALL_HEADING = "## Recalled Memories"
CONTEXT_PRESSURE_ADVISORY_HEADING = "## Context Pressure Advisory"
PROMPT_EXPERIMENT_HEADING = "## Prompt Experiment"
PLAN_MODE_OVERLAY_HEADING = "## Plan Mode"
APPROVED_PLAN_OVERLAY_HEADING = "## Approved Plan"
RESTORED_TOOL_CONTRACT_HEADING = "## Restored Tool Contract"
# Repo-delta uses an XML-style tag rather than a "## " heading; the recognizer
# is a plain ``startswith(tuple)`` so any stable literal prefix works, and the
# render emits ``<repository-delta>`` as the first line with no leading space.
REPOSITORY_DELTA_HEADING = "<repository-delta>"
MODEL_IDENTITY_HEADING = "## Runtime Model Identity"
INTERRUPTED_TURN_HEADING = "## Previous Turn Interruption"
PLUGIN_RUNTIME_OVERLAY_HEADING = "## Plugin Runtime Overlay"
SESSION_ENVIRONMENT_HEADING = "## Session Environment"

RUNTIME_SYSTEM_MESSAGE_HEADINGS: tuple[str, ...] = (
    MEMORY_RECALL_HEADING,
    CONTEXT_PRESSURE_ADVISORY_HEADING,
    PROMPT_EXPERIMENT_HEADING,
    PLAN_MODE_OVERLAY_HEADING,
    APPROVED_PLAN_OVERLAY_HEADING,
    RESTORED_TOOL_CONTRACT_HEADING,
    REPOSITORY_DELTA_HEADING,
    MODEL_IDENTITY_HEADING,
    INTERRUPTED_TURN_HEADING,
    PLUGIN_RUNTIME_OVERLAY_HEADING,
    SESSION_ENVIRONMENT_HEADING,
)
