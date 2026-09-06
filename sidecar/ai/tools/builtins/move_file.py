"""Guarded all-or-nothing validation for workspace file moves."""

from __future__ import annotations

import logging
import os
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
    apply_backup_retention_best_effort,
    create_checkpoint,
    materialize_checkpoint_plan,
    plan_checkpoint,
)
from sidecar.ai.tools.builtins.file_state import attach_structured_diff_metadata
from sidecar.ai.tools.contracts import (
    ToolExecutionFailure,
    ToolHandlerResult,
    canonicalize_tool_arguments,
)
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_path_identity import (
    NodeIdentity,
    WorkspaceLeafIdentity,
    resolve_workspace_leaf,
    revalidate_workspace_leaf,
)

logger = logging.getLogger(__name__)

_JENNY_DIR = ".jenny"
_MAX_MOVES = 100
_FILE_TYPE_MASK = 0o170000
_DIRECTORY_MODE = 0o040000


# Keep this constructor local to stay under the import fan-out cap.
def _failure_result(
    *,
    message: str,
    error_code: str = CMP_TOOL_EXECUTION_FAILED,
    metadata: dict[str, object] | None = None,
) -> ToolHandlerResult:
    return ToolHandlerResult(
        output=message,
        success=False,
        error_code=error_code,
        metadata=dict(metadata or {}),
    )


@dataclass(frozen=True)
class _MovePlan:
    source: WorkspaceLeafIdentity
    destination: Path
    destination_identity: NodeIdentity | None


def move_file_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
    raw_moves, overwrite = _normalize_arguments(arguments)
    if len(raw_moves) > _MAX_MOVES:
        return _failure_result(
            message=(
                f"Move batch has {len(raw_moves)} entries; the maximum is {_MAX_MOVES}. "
                "No files were moved."
            ),
            error_code=CMP_TOOL_CAP_EXCEEDED,
            metadata=_result_metadata([], moved_count=0, overwrite=overwrite),
        )

    move_statuses = _initial_move_statuses(raw_moves)
    root = workspace.require_root()
    plans, failures = _validate_batch(
        raw_moves,
        move_statuses=move_statuses,
        workspace=workspace,
        root=root,
        overwrite=overwrite,
    )
    if any(failures):
        return _validation_failure_result(move_statuses, failures, overwrite=overwrite)
    return _execute_batch(
        plans,
        journal_arguments=arguments,
        move_statuses=move_statuses,
        workspace=workspace,
        root=root,
        overwrite=overwrite,
    )


def _normalize_arguments(arguments: dict[str, object]) -> tuple[list[object], bool]:
    normalized_arguments, _aliases = canonicalize_tool_arguments(
        tool_name="move_file",
        arguments=arguments,
    )
    overwrite = normalized_arguments.get("overwrite", False)
    if not isinstance(overwrite, bool):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'overwrite' must be a boolean",
            retryable=False,
        )

    has_moves = "moves" in normalized_arguments
    has_single_pair = (
        "source" in normalized_arguments or "destination" in normalized_arguments
    )
    if has_moves and has_single_pair:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                "tool arguments conflict: provide either 'moves' or the top-level "
                "'source' and 'destination' pair, not both"
            ),
            retryable=False,
        )
    if has_moves:
        raw_moves = normalized_arguments["moves"]
    elif has_single_pair:
        raw_moves = [
            {
                "source": normalized_arguments.get("source"),
                "destination": normalized_arguments.get("destination"),
            }
        ]
    else:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                "tool argument 'moves' must be a non-empty list, or provide "
                "top-level 'source' and 'destination' strings"
            ),
            retryable=False,
        )
    if not isinstance(raw_moves, list) or not raw_moves:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'moves' must be a non-empty list",
            retryable=False,
        )
    return raw_moves, overwrite


def _initial_move_statuses(raw_moves: list[object]) -> list[dict[str, object]]:
    move_statuses: list[dict[str, object]] = []
    for item in raw_moves:
        source = item.get("source") if isinstance(item, dict) else None
        destination = item.get("destination") if isinstance(item, dict) else None
        move_statuses.append(
            {
                "source": source if isinstance(source, str) else "<invalid>",
                "destination": destination if isinstance(destination, str) else "<invalid>",
                "status": "not_moved",
            }
        )
    return move_statuses


def _validate_batch(
    raw_moves: list[object],
    *,
    move_statuses: list[dict[str, object]],
    workspace: WorkspaceGuard,
    root: Path,
    overwrite: bool,
) -> tuple[list[_MovePlan | None], list[list[str]]]:
    plans: list[_MovePlan | None] = [None] * len(raw_moves)
    failures: list[list[str]] = [[] for _item in raw_moves]
    source_keys: list[str | None] = [None] * len(raw_moves)
    destination_keys: list[str | None] = [None] * len(raw_moves)

    for index, item in enumerate(raw_moves):
        if not isinstance(item, dict):
            failures[index].append("entry must be an object")
            continue
        plan, source_key, destination_key = _validate_entry(
            item,
            status=move_statuses[index],
            reasons=failures[index],
            workspace=workspace,
            root=root,
            overwrite=overwrite,
        )
        plans[index] = plan
        source_keys[index] = source_key
        destination_keys[index] = destination_key

    _add_duplicate_failures(source_keys, "source", failures)
    _add_duplicate_failures(destination_keys, "destination", failures)
    _add_chain_failures(source_keys, destination_keys, failures)
    return plans, failures


def _validate_entry(  # noqa: PLR0913 - explicit per-entry validation context.
    item: dict[object, object],
    *,
    status: dict[str, object],
    reasons: list[str],
    workspace: WorkspaceGuard,
    root: Path,
    overwrite: bool,
) -> tuple[_MovePlan | None, str | None, str | None]:
    source = _resolve_source(item.get("source"), workspace, root, reasons)
    destination, destination_identity, destination_parent_device = _resolve_destination(
        item.get("destination"), workspace, root, reasons
    )
    source_key = _path_key(source.leaf_path) if source is not None else None
    destination_key = _path_key(destination) if destination is not None else None

    if source is not None:
        status["source"] = source.relative_path
        _refuse_jenny_path(source.relative_path, "source", reasons)
    if destination is not None:
        destination_relative = destination.relative_to(root).as_posix()
        status["destination"] = destination_relative
        _refuse_jenny_path(destination_relative, "destination", reasons)
    if source is None or destination is None:
        return None, source_key, destination_key
    if source_key == destination_key:
        reasons.append("source and destination resolve to the same path")
    else:
        if destination_identity is not None:
            if _identity_is_directory(destination_identity):
                reasons.append(
                    f"destination {destination_relative} is a directory; "
                    "directory overwrite is not supported"
                )
            elif not overwrite:
                reasons.append("destination already exists; pass overwrite: true")
        if (
            destination_parent_device is not None
            and source.leaf_identity.device != destination_parent_device
        ):
            reasons.append(
                f"destination {destination_relative} is on a different device; "
                "cross-volume moves are not supported"
            )
        if source.is_directory and _is_inside(destination, source.leaf_path):
            reasons.append("destination is inside its own source directory")
    return (
        _MovePlan(
            source=source,
            destination=destination,
            destination_identity=destination_identity,
        ),
        source_key,
        destination_key,
    )


def _resolve_source(
    raw_source: object,
    workspace: WorkspaceGuard,
    root: Path,
    reasons: list[str],
) -> WorkspaceLeafIdentity | None:
    if not isinstance(raw_source, str) or not raw_source.strip():
        reasons.append("source must be a non-empty string")
        return None
    try:
        source = resolve_workspace_leaf(root, raw_source)
        if not source.is_link_object:
            workspace.ensure_safe_mutation_path(source.leaf_path)
        return source
    except ToolExecutionFailure as error:
        reasons.append(f"source: {error.message}")
        return None


def _resolve_destination(
    raw_destination: object,
    workspace: WorkspaceGuard,
    root: Path,
    reasons: list[str],
) -> tuple[Path | None, NodeIdentity | None, int | None]:
    if not isinstance(raw_destination, str) or not raw_destination.strip():
        reasons.append("destination must be a non-empty string")
        return None, None, None
    try:
        destination = workspace.resolve_write_path(raw_destination)
        workspace.ensure_safe_mutation_path(destination)
        return (
            destination,
            _destination_identity(destination),
            _nearest_existing_parent_device(destination.parent, root),
        )
    except ToolExecutionFailure as error:
        reasons.append(f"destination: {error.message}")
        return None, None, None


def _destination_identity(path: Path) -> NodeIdentity | None:
    try:
        return NodeIdentity.from_stat(path.lstat())
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="failed to inspect move destination",
            retryable=True,
        ) from error


def _identity_is_directory(identity: NodeIdentity) -> bool:
    return identity.mode & _FILE_TYPE_MASK == _DIRECTORY_MODE


def _nearest_existing_parent_device(parent: Path, root: Path) -> int:
    current = parent
    while True:
        try:
            return int(current.stat(follow_symlinks=False).st_dev)
        except FileNotFoundError:
            if current == root:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_IO_FAILED,
                    message="failed to inspect destination volume",
                    retryable=True,
                ) from None
            current = current.parent
        except OSError as error:
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message="failed to inspect destination volume",
                retryable=True,
            ) from error


def _refuse_jenny_path(relative_path: str, side: str, reasons: list[str]) -> None:
    normalized = relative_path.casefold()
    if normalized == _JENNY_DIR or normalized.startswith(f"{_JENNY_DIR}/"):
        reasons.append(
            f"{side} is under .jenny; the .jenny directory holds Jenny's "
            "backups and trash"
        )


def _path_key(path: Path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def _is_inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _add_duplicate_failures(
    keys: list[str | None],
    label: str,
    failures: list[list[str]],
) -> None:
    indexes_by_key: dict[str, list[int]] = {}
    for index, key in enumerate(keys):
        if key is not None:
            indexes_by_key.setdefault(key, []).append(index)
    for duplicate_indexes in indexes_by_key.values():
        if len(duplicate_indexes) <= 1:
            continue
        entries = ", ".join(str(index + 1) for index in duplicate_indexes)
        for index in duplicate_indexes:
            failures[index].append(f"duplicate {label} across entries {entries}")


def _add_chain_failures(
    source_keys: list[str | None],
    destination_keys: list[str | None],
    failures: list[list[str]],
) -> None:
    source_indexes = {
        key: index
        for index, key in enumerate(source_keys)
        if key is not None
    }
    for index, destination_key in enumerate(destination_keys):
        source_index = source_indexes.get(destination_key) if destination_key else None
        if source_index is not None and source_index != index:
            failures[index].append(
                f"destination is the source of entry {source_index + 1}; "
                "chained moves are refused"
            )


def _validation_failure_result(
    move_statuses: list[dict[str, object]],
    failures: list[list[str]],
    *,
    overwrite: bool,
) -> ToolHandlerResult:
    lines = ["Move batch validation failed; no files were moved."]
    for index, status in enumerate(move_statuses):
        if failures[index]:
            status["status"] = "invalid"
            detail = "; ".join(failures[index])
        else:
            detail = "not moved because another entry failed validation"
        lines.append(
            f"Entry {index + 1}: {status['source']} -> "
            f"{status['destination']}: {detail}"
        )
    return _failure_result(
        message="\n".join(lines),
        error_code=CMP_TOOL_INVALID_PATH,
        metadata=_result_metadata(move_statuses, moved_count=0, overwrite=overwrite),
    )


def _execute_batch(  # noqa: PLR0913 - complete batch execution context.
    plans: list[_MovePlan | None],
    *,
    journal_arguments: dict[str, object],
    move_statuses: list[dict[str, object]],
    workspace: WorkspaceGuard,
    root: Path,
    overwrite: bool,
) -> ToolHandlerResult:
    diffs: list[dict[str, object]] = []
    warnings: list[object] = []
    journal = workspace.mutation_journal
    recovery = _prepare_move_recovery(
        plans=plans,
        journal_arguments=journal_arguments,
        move_statuses=move_statuses,
        workspace=workspace,
        root=root,
        overwrite=overwrite,
        diffs=diffs,
        warnings=warnings,
    )
    if isinstance(recovery, ToolHandlerResult):
        return recovery
    prepared = recovery
    workspace_change_set: dict[str, object] | None = None
    for index, plan in enumerate(plans):
        assert plan is not None
        if prepared is not None and journal is not None and index:
            workspace_change_set = journal.begin_sequence(prepared, prepared.sequences[index])
        try:
            _execute_move(plan, workspace=workspace, root=root, overwrite=overwrite)
        except ToolExecutionFailure as error:
            move_statuses[index]["status"] = "failed"
            if prepared is not None and journal is not None:
                workspace_change_set = journal.mark_failed_sequence(
                    prepared, prepared.sequences[index]
                )
            return _execution_failure_result(
                move_statuses,
                failed_index=index,
                failure_message=error.message,
                error_code=error.code,
                overwrite=overwrite,
                diffs=diffs,
                warnings=warnings,
                workspace_change_set=workspace_change_set,
            )

        move_statuses[index]["status"] = "moved"
        if prepared is not None and journal is not None:
            workspace_change_set = journal.mark_applied_sequence(
                prepared, prepared.sequences[index]
            )
            if workspace_change_set.get("protected") is False:
                return _execution_failure_result(
                    move_statuses,
                    failed_index=index,
                    failure_message="journal settlement failed after the workspace move",
                    error_code=CMP_TOOL_IO_FAILED,
                    overwrite=overwrite,
                    diffs=diffs,
                    warnings=warnings,
                    workspace_change_set=workspace_change_set,
                )
        diff, diff_warnings = _build_move_diff(move_statuses[index], index)
        if diff is not None:
            diffs.append(diff)
        warnings.extend(diff_warnings)

    lines = [f"Moved {len(move_statuses)} workspace entries:"]
    lines.extend(
        f"{index + 1}. {status['source']} -> {status['destination']}"
        for index, status in enumerate(move_statuses)
    )
    metadata = _result_metadata(
        move_statuses,
        moved_count=len(move_statuses),
        overwrite=overwrite,
        diffs=diffs,
        workspace_change_set=workspace_change_set,
    )
    if warnings:
        metadata["warnings"] = warnings
    return ToolHandlerResult(output="\n".join(lines), success=True, metadata=metadata)


def _prepare_move_recovery(  # noqa: PLR0913 - complete recovery batch context.
    *,
    plans: list[_MovePlan | None],
    journal_arguments: dict[str, object],
    move_statuses: list[dict[str, object]],
    workspace: WorkspaceGuard,
    root: Path,
    overwrite: bool,
    diffs: list[dict[str, object]],
    warnings: list[object],
) -> Any | ToolHandlerResult:
    journal = workspace.mutation_journal
    if journal is None:
        for plan in plans:
            if plan is not None and plan.destination_identity is not None:
                create_checkpoint(plan.destination, root)
        return None
    checkpoint_plans = [
        (
            plan_checkpoint(plan.destination, root)
            if plan is not None and plan.destination_identity is not None
            else None
        )
        for plan in plans
    ]
    prepared = journal.prepare_move_batch(
        journal_arguments,
        moves=[
            (
                plan.source.leaf_path,
                plan.source.relative_path,
                plan.destination,
                plan.destination.relative_to(root).as_posix(),
                checkpoint_plans[index],
            )
            for index, plan in enumerate(plans)
            if plan is not None
        ],
    )
    for index, plan in enumerate(plans):
        checkpoint_plan = checkpoint_plans[index]
        if plan is None or checkpoint_plan is None:
            continue
        try:
            materialize_checkpoint_plan(
                plan.destination,
                root,
                checkpoint_plan,
                is_object_pinned=workspace.is_recovery_object_pinned,
                apply_retention=False,
            )
        except ToolExecutionFailure as error:
            workspace_change_set = journal.mark_failed_sequence(
                prepared, prepared.sequences[0]
            )
            return _execution_failure_result(
                move_statuses,
                failed_index=index,
                failure_message=f"recovery checkpoint failed ({error.message})",
                error_code=error.code,
                overwrite=overwrite,
                diffs=diffs,
                warnings=warnings,
                workspace_change_set=workspace_change_set,
            )
    apply_backup_retention_best_effort(
        root,
        is_object_pinned=workspace.is_recovery_object_pinned,
    )
    return prepared


def _execute_move(
    plan: _MovePlan,
    *,
    workspace: WorkspaceGuard,
    root: Path,
    overwrite: bool,
) -> None:
    revalidate_workspace_leaf(plan.source)
    current_destination_identity = _prepare_destination(
        plan,
        workspace=workspace,
        root=root,
        overwrite=overwrite,
    )
    workspace.ensure_safe_mutation_path(plan.destination)
    if _destination_identity(plan.destination) != current_destination_identity:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="move destination changed before use",
            retryable=True,
        )
    try:
        os.replace(plan.source.leaf_path, plan.destination)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"workspace move failed: {error.strerror or type(error).__name__}",
            retryable=True,
        ) from error


def _prepare_destination(
    plan: _MovePlan,
    *,
    workspace: WorkspaceGuard,
    root: Path,
    overwrite: bool,
) -> NodeIdentity | None:
    workspace.ensure_safe_mutation_path(plan.destination)
    try:
        plan.destination.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=(
                "failed to create destination parents: "
                f"{error.strerror or type(error).__name__}"
            ),
            retryable=True,
        ) from error
    workspace.ensure_safe_mutation_path(plan.destination)
    current_identity = _destination_identity(plan.destination)
    if plan.destination_identity is not None and current_identity != plan.destination_identity:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="move destination changed after batch validation",
            retryable=True,
        )
    if plan.destination_identity is None and current_identity is not None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="move destination appeared after batch validation",
            retryable=True,
        )
    if current_identity is not None and _identity_is_directory(current_identity):
        destination_relative = plan.destination.relative_to(root).as_posix()
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=(
                f"destination {destination_relative} is a directory; "
                "directory overwrite is not supported"
            ),
            retryable=False,
        )
    return current_identity


def _build_move_diff(
    status: dict[str, object],
    operation_index: int,
) -> tuple[dict[str, object] | None, list[object]]:
    diff_metadata: dict[str, object] = {}
    attach_structured_diff_metadata(
        diff_metadata,
        path=str(status["destination"]),
        old_text="",
        new_text="",
        status="renamed",
        logger=logger,
    )
    diff = diff_metadata.get("diff")
    if isinstance(diff, dict):
        diff.update(
            {
                "path": status["destination"],
                "old_path": status["source"],
                "operation_index": operation_index,
            }
        )
    warnings = diff_metadata.get("warnings")
    return diff if isinstance(diff, dict) else None, (
        warnings if isinstance(warnings, list) else []
    )


def _execution_failure_result(  # noqa: PLR0913 - complete partial-state report.
    move_statuses: list[dict[str, object]],
    *,
    failed_index: int,
    failure_message: str,
    error_code: str,
    overwrite: bool,
    diffs: list[dict[str, object]],
    warnings: list[object],
    workspace_change_set: dict[str, object] | None = None,
) -> ToolHandlerResult:
    lines = [
        f"Move batch stopped at entry {failed_index + 1}: {failure_message}",
        "Interrupted batches are not rolled back and may leave empty destination directories.",
    ]
    for index, status in enumerate(move_statuses):
        detail = str(status["status"])
        if index == failed_index:
            detail = f"failed ({failure_message})"
        lines.append(
            f"{index + 1}. {status['source']} -> {status['destination']}: {detail}"
        )
    metadata = _result_metadata(
        move_statuses,
        moved_count=sum(status["status"] == "moved" for status in move_statuses),
        overwrite=overwrite,
        diffs=diffs,
        workspace_change_set=workspace_change_set,
    )
    if warnings:
        metadata["warnings"] = warnings
    return _failure_result(
        message="\n".join(lines),
        error_code=error_code,
        metadata=metadata,
    )


def _result_metadata(
    move_statuses: list[dict[str, object]],
    *,
    moved_count: int,
    overwrite: bool,
    diffs: list[dict[str, object]] | None = None,
    workspace_change_set: dict[str, object] | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "moves": move_statuses,
        "moved_count": moved_count,
        "overwrite": overwrite,
    }
    if diffs is not None:
        metadata["diffs"] = diffs
    if workspace_change_set is not None:
        metadata["workspace_change_set"] = workspace_change_set
    return metadata
