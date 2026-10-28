"""Pure helpers for the foreground shell change-evidence probe.

The probe itself (status snapshots, preimages, scripted diffs) lives in
``worktree_change_tracking``; this leaf holds its kill switch, the call-outcome
labels, cache-path filtering and the path-only notes the model sees.
"""

from __future__ import annotations

import json
import subprocess
import uuid
from typing import TYPE_CHECKING

from sidecar.ai.config import read_environment_value
from sidecar.ai.error_codes import CMP_TOOL_COMMAND_ABORTED
from sidecar.ai.tools.builtins import scripted_change_capture as scripted
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult

if TYPE_CHECKING:
    from sidecar.ai.tools.builtins.worktree_change_tracking import WorktreeSnapshot

# TR-015: foreground shell tools report ``workspace_changed`` from a status diff
# (``JENNY_ENABLE_SHELL_CHANGE_EVIDENCE=0`` disables the probe). Interpreter and
# test caches are not the model's edits.
SHELL_CHANGE_EVIDENCE_FLAG = "JENNY_ENABLE_SHELL_CHANGE_EVIDENCE"
_CACHE_PATH_SEGMENTS = frozenset({"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"})
# ``source_changed`` narrows that to saved source: index-only transitions
# (``git add``/``commit``) and untracked outputs without a source suffix (a stray
# ``cfile=none``, a repo-root ``holdout/`` data folder) are not saves. New stray
# outputs are named in the result so the model notices them (MQ-014/MQ-027).
MAX_STRAY_NOTE_ENTRIES = 5
MAX_STRAY_NOTE_CHARS = 400
_STRAY_NOTE_PREFIX = "New untracked files outside ignored folders: "


def shell_change_evidence_enabled() -> bool:
    """False when ``JENNY_ENABLE_SHELL_CHANGE_EVIDENCE=0`` disables the probe."""
    return read_environment_value(SHELL_CHANGE_EVIDENCE_FLAG, "1") != "0"


def diff_id_prefix_for(arguments: dict[str, object]) -> str:
    return scripted.diff_id_prefix(
        arguments.get("_jenny_operation_id") or arguments.get("_jenny_tool_call_id")
        or uuid.uuid4().hex[:12]
    )


def failure_outcome(error: ToolExecutionFailure) -> str:
    """``cancelled`` for a user stop (both handlers raise COMMAND_ABORTED)."""
    if error.code == CMP_TOOL_COMMAND_ABORTED:
        return "cancelled"
    if isinstance(error.__cause__, subprocess.TimeoutExpired):
        return "timed_out"
    return "failed"


def call_outcome(result: ToolHandlerResult) -> str:
    if result.metadata.get("timed_out") is True:
        return "timed_out"
    return "succeeded" if result.success else "failed"


def is_cache_path(path: str) -> bool:
    return path.endswith(".pyc") or any(
        part in _CACHE_PATH_SEGMENTS for part in path.split("/")
    )


def created_untracked(before: WorktreeSnapshot, after: WorktreeSnapshot, path: str) -> bool:
    return after.status.get(path) == "??" and before.status.get(path) != "??"


def created_untracked_entries(
    before: WorktreeSnapshot, after: WorktreeSnapshot, changed: list[str]
) -> tuple[str, ...]:
    """New untracked, non-source outputs; 2+ under one top-level folder collapse."""
    strays = [
        path for path in changed
        if created_untracked(before, after, path) and not scripted.is_source_like(path)
    ]
    by_folder: dict[str, list[str]] = {}
    for path in strays:
        top, _, rest = path.partition("/")
        by_folder.setdefault(f"{top}/" if rest else path, []).append(path)
    entries = [
        f"{key} ({len(paths)} files)" if len(paths) > 1 else paths[0]
        for key, paths in sorted(by_folder.items())
    ]
    return tuple(scripted.printable(entry) for entry in entries)


def stray_note(entries: tuple[str, ...]) -> str:
    shown = entries[:MAX_STRAY_NOTE_ENTRIES]
    hidden = len(entries) - len(shown)
    suffix = f" (+{hidden} more)" if hidden else ""
    body = ", ".join(shown)
    budget = MAX_STRAY_NOTE_CHARS - len(_STRAY_NOTE_PREFIX) - len(suffix)
    if len(body) > budget:
        body = body[: budget - 3] + "..."
    return f"{_STRAY_NOTE_PREFIX}{body}{suffix}"


def model_notes(
    before: WorktreeSnapshot,
    after: WorktreeSnapshot,
    source_paths: list[str],
    created_untracked_paths: tuple[str, ...],
) -> list[tuple[str, str]]:
    """Path-only lines: source files the call rewrote, then new stray outputs."""
    notes: list[tuple[str, str]] = []
    rewritten = [path for path in source_paths if not created_untracked(before, after, path)]
    if rewritten:
        notes.append(
            ("scripted_edit_note", scripted.scripted_edit_note(scripted.order_paths(rewritten)))
        )
    if created_untracked_paths:
        notes.append(("new_untracked_files", stray_note(created_untracked_paths)))
    return notes


def with_model_notes(output: str, notes: list[tuple[str, str]]) -> str:
    """One more line per note for the model; a JSON object result gains keys instead."""
    if not notes:
        return output
    try:
        payload = json.loads(output)
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        return json.dumps({**payload, **dict(notes)}, ensure_ascii=False, indent=2)
    lines = [output] if output else []
    return "\n".join([*lines, *(note for _key, note in notes)])


__all__ = [
    "MAX_STRAY_NOTE_CHARS",
    "MAX_STRAY_NOTE_ENTRIES",
    "SHELL_CHANGE_EVIDENCE_FLAG",
    "call_outcome",
    "created_untracked",
    "created_untracked_entries",
    "diff_id_prefix_for",
    "failure_outcome",
    "is_cache_path",
    "model_notes",
    "shell_change_evidence_enabled",
    "stray_note",
    "with_model_notes",
]
