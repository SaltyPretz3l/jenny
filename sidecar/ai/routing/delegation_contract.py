"""Shared bounds and normalization for request-scoped research delegation."""

from __future__ import annotations

from typing import Any

from sidecar.ai.config_models import is_cloud_engine_type
from sidecar.ai.error_codes import CMP_TOOL_SUBAGENT_INVALID_PROMPT
from sidecar.ai.tools.contracts import ToolExecutionFailure

MAX_CONTRACT_TEXT_LENGTH = 4000
MAX_CONTRACT_LIST_ITEMS = 20
MAX_CONTRACT_LIST_ITEM_LENGTH = 1000
# Parent-facing clip of each child's answer; lives here so the contract text
# that tells the child its budget shares the number without importing delegate_contracts.
MAX_DELEGATE_ANSWER_CHARS = 2_500
# The same clip on a cloud engine (delegate_answer_chars, row 184).
CLOUD_DELEGATE_ANSWER_CHARS = 16_000
MAX_DELEGATE_TASKS = 3
MAX_DELEGATE_OUTPUT_CHARS = 8_000  # the floor; a larger answer budget widens it


def delegate_answer_chars(config: Any) -> int:
    """How much of each helper's answer the parent reads."""
    if is_cloud_engine_type(getattr(config, "engine_type", "")):
        return CLOUD_DELEGATE_ANSWER_CHARS
    return MAX_DELEGATE_ANSWER_CHARS


# A helper's plain-text answer that starts with this settles as partial (row 184).
PARTIAL_ANSWER_PREFIX = "PARTIAL:"


def output_char_limit(answer_chars: int) -> int:
    """The local floor, or room for every task's whole answer plus its evidence."""
    if answer_chars <= MAX_DELEGATE_ANSWER_CHARS:
        return MAX_DELEGATE_OUTPUT_CHARS
    return answer_chars * MAX_DELEGATE_TASKS + 4_000


DELEGATE_MODE_READ = "read"
DELEGATE_MODE_WRITE = "write"  # row 184 W3: the child works in its own worktree


def task_mode(value: str | None, *, ordinal: int) -> str:
    """A task's ``mode``: absent is read; anything but read or write fails that task."""
    if value is None or value == DELEGATE_MODE_READ:
        return DELEGATE_MODE_READ
    if value == DELEGATE_MODE_WRITE:
        return value
    raise ToolExecutionFailure(
        code=CMP_TOOL_SUBAGENT_INVALID_PROMPT,
        message=f"task {ordinal} 'mode' must be \"read\" or \"write\"",
        retryable=False,
    )


def _positive_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        candidate = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return candidate if candidate > 0 else None


def _truncate_with_ellipsis(value: object, limit: int) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    if limit <= 1:
        return "\u2026"[:limit]
    return f"{text[: limit - 1]}\u2026"

DELEGATION_CONTRACT_FIELDS: tuple[str, ...] = (
    "goal",
    "context",
    "boundaries",
    "tasks",
    "verification",
    "return_format",
)


def bounded_text(value: Any, max_length: int = MAX_CONTRACT_TEXT_LENGTH) -> str:
    text = str(value or "").strip()
    return text[:max_length]


def _bounded_text_list(value: Any) -> list[str]:
    source = value if isinstance(value, (list, tuple)) else []
    normalized: list[str] = []
    for item in source:
        text = bounded_text(item, MAX_CONTRACT_LIST_ITEM_LENGTH)
        if not text:
            continue
        normalized.append(text)
        if len(normalized) >= MAX_CONTRACT_LIST_ITEMS:
            break
    return normalized


def normalize_delegation_contract(value: Any) -> dict[str, Any] | None:
    """Normalize a delegation-contract payload to the canonical bounded shape.

    Returns ``None`` if the required fields (goal, tasks, return_format) are
    missing or empty after bounding. Returns a dict whose keys match
    ``DELEGATION_CONTRACT_FIELDS`` ordering when the contract is valid.
    """

    source = value if isinstance(value, dict) else {}
    contract: dict[str, Any] = {
        "goal": bounded_text(source.get("goal")),
        "context": bounded_text(source.get("context")),
        "boundaries": _bounded_text_list(source.get("boundaries")),
        "tasks": _bounded_text_list(source.get("tasks")),
        "verification": _bounded_text_list(source.get("verification")),
        "return_format": bounded_text(source.get("return_format")),
    }
    if not contract["goal"] or not contract["tasks"] or not contract["return_format"]:
        return None
    return {field: contract.get(field) for field in DELEGATION_CONTRACT_FIELDS}


def build_delegation_contract_payload(  # noqa: PLR0913
    *,
    goal: str,
    context: str,
    boundaries: tuple[str, ...] | list[str],
    tasks: tuple[str, ...] | list[str],
    verification: tuple[str, ...] | list[str],
    return_format: str,
) -> dict[str, Any]:
    normalized = normalize_delegation_contract(
        {
            "goal": goal,
            "context": context,
            "boundaries": boundaries,
            "tasks": tasks,
            "verification": verification,
            "return_format": return_format,
        }
    )
    if normalized is None:
        raise ValueError("research delegation requires goal, tasks, and return_format")
    return normalized


def write_contract_payload(*, mode: str, answer_chars: int) -> dict[str, Any]:
    """Row 184 W3: the contract a writing helper works under."""
    return build_delegation_contract_payload(
        goal=(
            "Make the delegated change in your own git worktree; the parent reviews and merges it."
        ),
        context=f"mode={mode}",
        boundaries=(
            "You work in a separate git worktree of the project; your file tools see only it.",
            "Only file and git tools work here: no commands, browser, memory or helpers.",
            "You cannot ask for approval: a call that needs one is refused; report it instead.",
        ),
        tasks=(
            "Make only the delegated change, following the project's existing conventions.",
            "Discover uncertain paths with list, glob, or grep before editing; do not guess paths.",
            "Read back what you changed before you answer.",
            "Stop tool use before the final iteration and reserve it for the required answer.",
        ),
        verification=(
            "Name each file you changed and say what you could not verify.",
            "Do not claim tests pass: you cannot run them; the parent will.",
        ),
        return_format=(
            "one concise plain-text answer: what you changed and why, file by file, then what is "
            f"left. The parent sees only the first {answer_chars:,} characters. If you could not "
            f"finish, begin the answer with '{PARTIAL_ANSWER_PREFIX}' and name what is left."
        ),
    )
