"""In-place revision of a session artifact for ``create_artifact``.

Ordinary file tools refuse ``.jenny`` (reserved internal state), so a model
that finds a bug in its own artifact revises it here with ``replaces`` plus
full ``content`` or exact ``edits``. Every path stays inside the current
session's artifact folder through the guarded workspace store.
"""

from __future__ import annotations

from dataclasses import dataclass

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
)
from sidecar.ai.tools.builtins.edit_matching import normalize_newlines, render_with_newlines
from sidecar.ai.tools.builtins.file_state import build_no_match_message
from sidecar.ai.tools.builtins.filesystem import encode_utf8_text
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, StoreRef

MAX_ARTIFACT_EDITS = 20
_EDITS_SHAPE = "a non-empty list of {old_string, new_string} objects"


@dataclass(frozen=True)
class ArtifactRevision:
    encoded_content: bytes
    edit_count: int


def _invalid(message: str, code: str = CMP_TOOL_INVALID_PATH) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=code, message=message, retryable=False)


def resolve_replace_target(
    store: GuardedWorkspaceStore,
    parent: StoreRef,
    *,
    replaces: str,
) -> StoreRef:
    """Resolve ``replaces`` to an existing file directly in ``parent``.

    Accepts the display path an earlier create_artifact returned
    (``.jenny/artifacts/<session>/<file>``) or the bare file name; anything
    else, including another session's folder or a nested path, is refused."""

    normalized = replaces.strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    prefix = f"{store.display_path(parent)}/"
    name = normalized[len(prefix) :] if normalized.startswith(prefix) else normalized
    if not name or "/" in name:
        raise _invalid(
            "tool argument 'replaces' must be an artifact of this session: the path an "
            f"earlier create_artifact returned ({prefix}<file>) or that file name"
        )
    try:
        ref = store.child(parent, name)
    except ToolExecutionFailure as error:
        raise _invalid(
            f"tool argument 'replaces' is not a valid artifact name: {error.message}"
        ) from error
    entry = store.stat(ref)
    if entry is None or entry.is_directory or len(ref.parts) != len(parent.parts) + 1:
        raise _invalid(
            f"there is no artifact named '{name}' in this session; 'replaces' takes a path "
            "an earlier create_artifact call returned"
        )
    # A case-insensitive filesystem found it under another spelling: keep the
    # file's own name so the revision reports the same display path.
    if name not in {listed.name for listed in store.list_entries(parent)}:
        folded = name.casefold()
        for listed in store.list_entries(parent):
            if not listed.is_directory and listed.name.casefold() == folded:
                return listed.ref
    return ref


def parse_artifact_edits(raw: object) -> tuple[tuple[str, str], ...]:
    if not isinstance(raw, list) or not raw:
        raise _invalid(f"tool argument 'edits' must be {_EDITS_SHAPE}")
    if len(raw) > MAX_ARTIFACT_EDITS:
        raise _invalid(f"tool argument 'edits' supports at most {MAX_ARTIFACT_EDITS} items")
    edits: list[tuple[str, str]] = []
    for index, item in enumerate(raw):
        old_string = item.get("old_string") if isinstance(item, dict) else None
        new_string = item.get("new_string") if isinstance(item, dict) else None
        if not isinstance(old_string, str) or not old_string or not isinstance(new_string, str):
            raise _invalid(
                f"tool argument 'edits[{index}]' needs a non-empty string old_string and "
                "a string new_string"
            )
        edits.append((old_string, new_string))
    return tuple(edits)


def apply_artifact_edits(
    content: str, edits: tuple[tuple[str, str], ...], *, display_path: str
) -> str:
    """Apply exact single-match edits in order; any miss refuses the whole batch."""

    newline = "\r\n" if "\r\n" in content else "\n"
    text = normalize_newlines(content)
    for index, (old_string, new_string) in enumerate(edits, start=1):
        old_text = normalize_newlines(old_string)
        occurrences = text.count(old_text)
        if occurrences != 1:
            detail = (
                build_no_match_message(text, old_text, display_path)
                if occurrences == 0
                else f"Found {occurrences} matches in {display_path}. Provide more "
                "surrounding context so old_string matches exactly once."
            )
            raise _invalid(
                f"Edit {index} of {len(edits)}: {detail}\nNo changes were applied.",
                CMP_TOOL_EXECUTION_FAILED,
            )
        text = text.replace(old_text, normalize_newlines(new_string), 1)
    return render_with_newlines(text, newline)


def revise_with_edits(
    store: GuardedWorkspaceStore,
    ref: StoreRef,
    raw_edits: object,
    *,
    max_bytes: int,
) -> ArtifactRevision:
    edits = parse_artifact_edits(raw_edits)
    display_path = store.display_path(ref)
    try:
        current = store.read_bytes(ref, max_bytes=max_bytes)
    except ToolExecutionFailure as error:
        if error.code != CMP_TOOL_CAP_EXCEEDED:
            raise
        raise _invalid(
            f"{display_path} is larger than the {max_bytes // 1024} KiB edit limit; "
            "pass the full content instead of edits",
            CMP_TOOL_CAP_EXCEEDED,
        ) from error
    try:
        text = (current or b"").decode("utf-8")
    except UnicodeDecodeError as error:
        raise _invalid(
            f"{display_path} is not UTF-8 text; pass the full content instead of edits",
            CMP_TOOL_EXECUTION_FAILED,
        ) from error
    encoded = encode_utf8_text(apply_artifact_edits(text, edits, display_path=display_path))
    if len(encoded) > max_bytes:
        raise _invalid(
            f"Could not revise {display_path}: the result exceeds the "
            f"{max_bytes // 1024} KiB editable byte limit. No changes were applied.",
            CMP_TOOL_CAP_EXCEEDED,
        )
    return ArtifactRevision(encoded_content=encoded, edit_count=len(edits))
