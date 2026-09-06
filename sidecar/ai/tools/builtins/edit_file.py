"""Incremental text editing tool with workspace-local checkpointing."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.builtins.file_history import (
    CheckpointInfo,
    checkpoint_lock_for,
    create_checkpoint,
    materialize_checkpoint_plan,
    plan_checkpoint,
)
from sidecar.ai.tools.builtins.file_state import (
    attach_structured_diff_metadata,
    build_no_match_message,
    encode_text_for_existing_file,
    load_existing_text_state_for_mutation,
)
from sidecar.ai.tools.builtins.filesystem import (
    build_write_metadata,
    current_max_edit_file_bytes,
    failure_result,
    workspace_relative_path,
    write_bytes_atomic,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

MAX_EDITS_PER_CALL = 20
EditSpec = tuple[str, str, bool]


@dataclass(frozen=True)
class _FoldContext:
    relative_path: str
    newline_style: str
    max_final_bytes: int
    name_failures: bool


def edit_file_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
    file_path = arguments.get("file_path")
    expected_read_snapshot = arguments.get("expected_read_snapshot")
    normalize_bom = arguments.get("normalize_bom") is True

    if not isinstance(file_path, str) or not file_path.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'file_path' must be a non-empty string",
            retryable=False,
        )
    edits, is_batch = _validated_edits(arguments)

    resolved = workspace.resolve_read_path(file_path)
    if not resolved.is_file():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"path must point to a file: {file_path}",
            retryable=False,
        )

    root = workspace.require_root()
    relative_path = workspace_relative_path(resolved, root)
    normalized_relative = relative_path.replace("\\", "/")
    if normalized_relative == ".jenny" or normalized_relative.startswith(".jenny/"):
        return failure_result(
            message="Ordinary file tools cannot edit reserved .jenny internal state.",
            error_code=CMP_TOOL_INVALID_PATH,
            metadata={"path": normalized_relative},
        )
    try:
        with checkpoint_lock_for(resolved, root, timeout_seconds=15.0):
            return _edit_locked(
                resolved=resolved,
                edits=edits,
                is_batch=is_batch,
                workspace_root=root,
                workspace=workspace,
                expected_read_snapshot=expected_read_snapshot,
                normalize_bom=normalize_bom,
                journal_arguments=arguments,
            )
    except ToolExecutionFailure as error:
        if error.code != CMP_TOOL_IO_FAILED:
            raise
        log_event(
            logger,
            logging.ERROR,
            component="ai.tools.edit_file",
            event="ai.tools.edit_file.lock_failed",
            message=f"Edit lock/checkpoint failed for {file_path.strip()}",
            status="failure",
            data={"path": file_path.strip(), "code": error.code},
        )
        return failure_result(
            message=f"Could not safely edit {file_path.strip()}: {error.message}",
            error_code=error.code,
            metadata={"path": workspace_relative_path(resolved, workspace.root)},
        )


def _validated_edits(arguments: dict[str, object]) -> tuple[tuple[EditSpec, ...], bool]:
    if "edits" not in arguments:
        old_string = arguments.get("old_string")
        new_string = arguments.get("new_string")
        if not isinstance(old_string, str) or not old_string:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="tool argument 'old_string' must be a non-empty string",
                retryable=False,
            )
        if not isinstance(new_string, str):
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="tool argument 'new_string' must be a string",
                retryable=False,
            )
        return ((old_string, new_string, arguments.get("replace_all") is True),), False

    if "old_string" in arguments or "new_string" in arguments:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'edits' cannot be combined with top-level old_string/new_string",
            retryable=False,
        )
    raw_edits = arguments.get("edits")
    if not isinstance(raw_edits, list) or not raw_edits:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'edits' must be a non-empty list",
            retryable=False,
        )
    if len(raw_edits) > MAX_EDITS_PER_CALL:
        raise ToolExecutionFailure(
            code=CMP_TOOL_CAP_EXCEEDED,
            message=f"tool argument 'edits' supports at most {MAX_EDITS_PER_CALL} items",
            retryable=False,
        )

    validated: list[EditSpec] = []
    for index, item in enumerate(raw_edits, start=1):
        if not isinstance(item, dict):
            raise _invalid_edit_item(index, "must be an object")
        old_string = item.get("old_string")
        new_string = item.get("new_string")
        replace_all = item.get("replace_all", False)
        if not isinstance(old_string, str) or not old_string:
            raise _invalid_edit_item(index, "old_string must be a non-empty string")
        if not isinstance(new_string, str):
            raise _invalid_edit_item(index, "new_string must be a string")
        if not isinstance(replace_all, bool):
            raise _invalid_edit_item(index, "replace_all must be a boolean")
        validated.append((old_string, new_string, replace_all))
    return tuple(validated), True


def _invalid_edit_item(index: int, message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_INVALID_PATH,
        message=f"edit {index} {message}",
        retryable=False,
    )


def _edit_locked(  # noqa: PLR0913
    *,
    resolved: Path,
    edits: tuple[EditSpec, ...],
    is_batch: bool,
    workspace_root: Path,
    workspace: WorkspaceGuard,
    expected_read_snapshot: object,
    normalize_bom: bool,
    journal_arguments: dict[str, object],
) -> ToolHandlerResult:
    if not is_batch and edits[0][0] == edits[0][1]:
        return failure_result(
            message="old_string and new_string are identical. No changes were applied.",
            error_code=CMP_TOOL_EXECUTION_FAILED,
            metadata={"path": workspace_relative_path(resolved, workspace.root)},
        )

    relative_path = workspace_relative_path(resolved, workspace.root)
    try:
        workspace.ensure_safe_mutation_path(resolved)
    except ToolExecutionFailure as error:
        return failure_result(
            message=f"Could not edit {relative_path}: {error.message}",
            error_code=error.code,
            metadata={"path": relative_path},
        )
    try:
        existing_state = load_existing_text_state_for_mutation(
            path=resolved,
            relative_path=relative_path,
            max_bytes=current_max_edit_file_bytes(),
            expected_snapshot_value=expected_read_snapshot,
            action="editing",
            # edit_file's unique-``old_string`` match is itself a stale-write
            # guard, so the read snapshot is optional here: when one is present
            # it still runs the strong equality check, and when it is missing
            # (never read, or invalidated after a write) the content-anchored
            # match below carries the edit instead of hard-failing. write_file
            # and apply_patch keep the snapshot mandatory (no content anchor).
            require_read_snapshot=False,
        )
    except ToolExecutionFailure as error:
        return failure_result(
            message=f"Could not edit {relative_path}: {error.message}",
            error_code=error.code,
            metadata={"path": relative_path},
        )

    newline_style = _dominant_newline(existing_state.text)
    normalized_content = _normalize_newlines(existing_state.text)
    max_final_bytes = current_max_edit_file_bytes()
    folded = _fold_edits(
        edits,
        content=normalized_content,
        context=_FoldContext(
            relative_path=relative_path,
            newline_style=newline_style,
            max_final_bytes=max_final_bytes,
            name_failures=is_batch,
        ),
    )
    if isinstance(folded, ToolHandlerResult):
        return folded
    updated_content, total_replacements, applied_replace_all = folded

    rendered_content = _render_with_newlines(updated_content, newline_style)
    try:
        encoded = encode_text_for_existing_file(
            rendered_content,
            max_bytes=max_final_bytes,
            subject=f"edit_file final content for {relative_path}",
            preserve_utf8_bom=existing_state.has_utf8_bom and not normalize_bom,
            normalize_bom=normalize_bom,
        )
    except ToolExecutionFailure as error:
        return failure_result(
            message=f"Could not edit {relative_path}: {error.message}",
            error_code=error.code,
            metadata={"path": relative_path},
        )
    journal = workspace.mutation_journal
    recovery = _prepare_edit_recovery(
        journal=journal,
        journal_arguments=journal_arguments,
        workspace=workspace,
        workspace_root=workspace_root,
        target=resolved,
        relative_path=relative_path,
        encoded=encoded,
    )
    if isinstance(recovery, ToolHandlerResult):
        return recovery
    checkpoint, prepared = recovery
    try:
        write_bytes_atomic(resolved, encoded, workspace=workspace)
    except ToolExecutionFailure as error:
        failure_metadata: dict[str, object] = {"path": relative_path}
        if prepared is not None and journal is not None:
            failure_metadata["workspace_change_set"] = journal.mark_failed_sequence(
                prepared, prepared.sequences[0]
            )
        return failure_result(
            message=f"Failed to write edited file: {error.message}",
            error_code=error.code,
            metadata=failure_metadata,
        )

    metadata = build_write_metadata(
        path=relative_path,
        bytes_written=len(encoded),
        checkpoint=checkpoint,
    )
    metadata.update(
        {
            "replacements": total_replacements,
            "replace_all": applied_replace_all,
            "read_snapshot_validated": existing_state.snapshot_validated,
        }
    )
    if prepared is not None and journal is not None:
        metadata["workspace_change_set"] = journal.mark_applied(prepared)
    if is_batch:
        metadata["edits_applied"] = len(edits)
    if not existing_state.snapshot_validated:
        # Applied without a read snapshot: the unique-target match is the only
        # stale-write guard on this path. Record it so the guarantee that
        # protected the write is auditable.
        log_event(
            logger,
            logging.INFO,
            component="ai.tools.edit_file",
            event="ai.tools.edit_file.content_anchored_apply",
            message=f"Applied content-anchored edit without read snapshot for {relative_path}",
            status="degraded",
            data={
                "path": relative_path,
                "replacements": total_replacements,
                "replace_all": applied_replace_all,
            },
        )
    attach_structured_diff_metadata(
        metadata,
        path=relative_path,
        old_text=existing_state.text,
        new_text=rendered_content,
        status="modified",
        logger=logger,
        pre_change_snapshot_root=workspace.pre_change_snapshot_root,
    )
    return ToolHandlerResult(
        output=f"The file {relative_path} has been updated.",
        success=True,
        metadata=metadata,
    )


def _checkpoint_failure_result(
    journal: Any,
    prepared: Any,
    relative_path: str,
    error: ToolExecutionFailure,
) -> ToolHandlerResult:
    summary = journal.mark_failed_sequence(prepared, prepared.sequences[0])
    return failure_result(
        message=f"Failed to create recovery checkpoint: {error.message}",
        error_code=error.code,
        metadata={"path": relative_path, "workspace_change_set": summary},
    )


def _prepare_edit_recovery(  # noqa: PLR0913 - explicit recovery context.
    *,
    journal: Any,
    journal_arguments: dict[str, object],
    workspace: WorkspaceGuard,
    workspace_root: Path,
    target: Path,
    relative_path: str,
    encoded: bytes,
) -> tuple[CheckpointInfo, Any] | ToolHandlerResult:
    if journal is None:
        return create_checkpoint(target, workspace_root), None
    planned = plan_checkpoint(target, workspace_root)
    prepared = journal.prepare_file_change(
        journal_arguments,
        tool_name="edit_file",
        target=target,
        relative_path=relative_path,
        new_bytes=encoded,
        checkpoint=planned,
    )
    try:
        checkpoint = materialize_checkpoint_plan(
            target,
            workspace_root,
            planned,
            is_object_pinned=workspace.is_recovery_object_pinned,
        )
    except ToolExecutionFailure as error:
        return _checkpoint_failure_result(journal, prepared, relative_path, error)
    return checkpoint, prepared


def _fold_edits(
    edits: tuple[EditSpec, ...],
    *,
    content: str,
    context: _FoldContext,
) -> tuple[str, int, bool] | ToolHandlerResult:
    total_replacements = 0
    applied_replace_all = False
    for index, (old_string, new_string, replace_all) in enumerate(edits, start=1):
        normalized_old = _normalize_newlines(old_string)
        normalized_new = _normalize_newlines(new_string)
        failure_prefix = f"Edit {index}: " if context.name_failures else ""
        if old_string == new_string:
            return failure_result(
                message=(
                    f"{failure_prefix}old_string and new_string are identical. "
                    "No changes were applied."
                ),
                error_code=CMP_TOOL_EXECUTION_FAILED,
                metadata={"path": context.relative_path},
            )
        occurrences = content.count(normalized_old)
        if occurrences == 0:
            return failure_result(
                message=(
                    f"{failure_prefix}"
                    f"{build_no_match_message(content, normalized_old, context.relative_path)}"
                ),
                error_code=CMP_TOOL_EXECUTION_FAILED,
                metadata={"path": context.relative_path},
            )
        if occurrences > 1 and not replace_all:
            return failure_result(
                message=(
                    f"{failure_prefix}Found {occurrences} matches in {context.relative_path}. "
                    "Provide more surrounding context or set replace_all to true."
                ),
                error_code=CMP_TOOL_EXECUTION_FAILED,
                metadata={"path": context.relative_path, "occurrences": occurrences},
            )

        replacement_count = occurrences if replace_all else 1
        projected_chars = _projected_rendered_chars(
            content,
            normalized_old,
            normalized_new,
            replacement_count=replacement_count,
            newline_style=context.newline_style,
        )
        if projected_chars > context.max_final_bytes:
            return failure_result(
                message=(
                    f"{failure_prefix}Could not edit {context.relative_path}: "
                    "final content exceeds byte limit"
                ),
                error_code=CMP_TOOL_CAP_EXCEEDED,
                metadata={"path": context.relative_path},
            )
        content = _apply_edit(
            content,
            normalized_old,
            normalized_new,
            replace_all=replace_all,
        )
        total_replacements += replacement_count
        applied_replace_all = applied_replace_all or replace_all
    return content, total_replacements, applied_replace_all


def _projected_rendered_chars(
    content: str,
    old_string: str,
    new_string: str,
    *,
    replacement_count: int,
    newline_style: str,
) -> int:
    projected_chars = len(content) + replacement_count * (len(new_string) - len(old_string))
    # Rendered CRLF content adds one byte per normalized newline.
    newline_overhead = len(newline_style) - 1
    if newline_overhead > 0:
        current_newlines = content.count("\n")
        old_newlines = old_string.count("\n")
        new_newlines = new_string.count("\n")
        projected_newlines = current_newlines + replacement_count * (new_newlines - old_newlines)
        projected_chars += max(projected_newlines, 0) * newline_overhead
    return projected_chars


def _normalize_newlines(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _apply_edit(
    content: str,
    old_string: str,
    new_string: str,
    *,
    replace_all: bool,
) -> str:
    if new_string != "":
        if replace_all:
            return content.replace(old_string, new_string)
        return content.replace(old_string, new_string, 1)

    spans: list[tuple[int, int]] = []
    search_from = 0
    while True:
        start = content.find(old_string, search_from)
        if start == -1:
            break
        end = start + len(old_string)
        if (
            not old_string.endswith("\n")
            and (start == 0 or content[start - 1] == "\n")
            and content[end : end + 1] == "\n"
        ):
            end += 1
        spans.append((start, end))
        if not replace_all:
            break
        search_from = start + len(old_string)

    updated = content
    for start, end in reversed(spans):
        updated = f"{updated[:start]}{new_string}{updated[end:]}"
    return updated


def _dominant_newline(value: str) -> str:
    crlf = value.count("\r\n")
    stripped = value.replace("\r\n", "")
    lf = stripped.count("\n")
    cr = stripped.count("\r")
    counts = [("\r\n", crlf), ("\n", lf), ("\r", cr)]
    counts.sort(key=lambda item: item[1], reverse=True)
    return counts[0][0] if counts[0][1] > 0 else "\n"


def _render_with_newlines(value: str, newline_style: str) -> str:
    if newline_style == "\n":
        return value
    return value.replace("\n", newline_style)
