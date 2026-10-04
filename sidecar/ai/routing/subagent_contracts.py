"""Compatibility data shapes and text sanitation for delegation progress."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sidecar.ai.tools.sanitization import sanitize_tool_output

SUBAGENT_BATCH_TOOL_NAME = "subagent_batch"


@dataclass(frozen=True)
class SubagentRunRequest:
    """Validated input for a ``subagent_run`` call."""

    prompt: str
    allowed_tool_families: tuple[str, ...]
    max_steps: int
    max_runtime_ms: int
    label: str = "Research subagent"


@dataclass(frozen=True)
class SubagentBatchTask:
    ordinal: int
    label: str
    request: SubagentRunRequest | None = None
    error: dict[str, Any] | None = None


@dataclass(frozen=True)
class SubagentBatchRequest:
    tasks: tuple[SubagentBatchTask, ...]
    max_total_steps: int
    max_total_runtime_ms: int


def safe_batch_text(value: Any, *, max_chars: int) -> str:
    return sanitize_tool_output(
        value,
        max_chars=max_chars,
        tool_name=SUBAGENT_BATCH_TOOL_NAME,
    ).strip()
