"""Crash-safe staging and resume validation for workspace restore."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from sidecar.ai.tools.workspace_mutation_journal_contract import EMPTY_SHA256, PathSignature


def _validate_resume_state(  # noqa: C901, PLR0912 - ordered recovery-state validation.
    root: Path,
    record: Mapping[str, Any],
    plan: Sequence[Mapping[str, Any]],
    staging: Sequence[Mapping[str, Any]],
) -> None:
    from sidecar.ai.tools.workspace_restore import (  # noqa: PLC0415
        WorkspaceRestoreError,
        _decision_map,
        _preflight_conflicts,
        _safe_path,
        _signature,
    )

    completed = set(cast(list[str], record["restore"]["completed_inverse_step_ids"]))
    stage_by_id = {cast(str, item["inverse_step_id"]): item for item in staging}
    decision_by_id = _decision_map(record)
    superseded: set[str] = set()
    later_completed_paths: set[str] = set()
    for item in reversed(plan):
        step = cast(dict[str, Any], item["step"])
        step_id = cast(str, step["step_id"])
        if step_id not in completed:
            continue
        paths = _step_paths(step, decision_by_id.get(step_id))
        if not paths.isdisjoint(later_completed_paths):
            superseded.add(step_id)
        later_completed_paths.update(paths)
    pending: list[Mapping[str, Any]] = []
    for item in plan:
        step = cast(dict[str, Any], item["step"])
        step_id = cast(str, step["step_id"])
        if step_id in completed:
            if step_id not in superseded:
                _validate_completed_step(root, step, decision_by_id.get(step_id))
            continue
        pending.append(item)
        stage = stage_by_id.get(step_id)
        if stage is not None:
            source = _safe_path(root, cast(str, step["from_relative_path"]))
            stage_path = _safe_path(root, cast(str, stage["stage_relative_path"]))
            expected = PathSignature.from_mapping(stage["expected_signature"])
            states = (_signature(source), _signature(stage_path))
            linked = states == (expected, expected) and _same_file(source, stage_path)
            if not linked and states not in {
                (expected, PathSignature("missing", 0, EMPTY_SHA256)),
                (PathSignature("missing", 0, EMPTY_SHA256), expected),
            }:
                raise WorkspaceRestoreError(
                    "restore_state_ambiguous",
                    "Restore staging state changed and requires review.",
                )
    conflicts = _preflight_conflicts(root, pending, staging)
    conflict_ids = {cast(str, item["inverse_step_id"]) for item in conflicts}
    occupants = cast(list[dict[str, Any]], record["restore"]["protected_occupants"])
    for item in pending:
        step = cast(dict[str, Any], item["step"])
        step_id = cast(str, step["step_id"])
        decision = decision_by_id.get(step_id)
        marker = f"-{step_id.replace('.', '-')}-"
        target_relative = cast(str, step["to_relative_path"] or step["from_relative_path"])
        if (
            decision is not None
            and decision["outcome"] == "protect_then_replace"
            and any(marker in str(entry["object_id"]) for entry in occupants)
            and _signature(_safe_path(root, target_relative)).kind == "missing"
        ):
            conflict_ids.add(step_id)
    decided_ids = {
        step_id
        for step_id in decision_by_id
        if step_id not in completed
    }
    if conflict_ids != decided_ids:
        raise WorkspaceRestoreError(
            "restore_state_ambiguous",
            "Pending restore paths changed and require review.",
        )
    for step_id in decided_ids:
        decision = decision_by_id[step_id]
        if decision["outcome"] == "alternate_name":
            alternate = _safe_path(root, cast(str, decision["alternate_relative_path"]))
            if _signature(alternate).kind != "missing":
                raise WorkspaceRestoreError(
                    "restore_state_ambiguous",
                    "An alternate restore destination became occupied.",
                )


def _step_paths(
    step: Mapping[str, Any], decision: Mapping[str, Any] | None
) -> set[str]:
    paths = {
        str(step.get("from_relative_path") or ""),
        str(step.get("to_relative_path") or ""),
    }
    if decision is not None:
        paths.add(str(decision.get("alternate_relative_path") or ""))
    paths.discard("")
    return paths


def _validate_completed_step(
    root: Path, step: Mapping[str, Any], decision: Mapping[str, Any] | None
) -> None:
    from sidecar.ai.tools.workspace_restore import (  # noqa: PLC0415
        WorkspaceRestoreError,
        _safe_path,
        _signature,
    )

    if decision is not None and decision["outcome"] == "skip":
        return
    kind = cast(str, step["kind"])
    relative = cast(str, step["to_relative_path"] or step["from_relative_path"])
    if decision is not None and decision["outcome"] == "alternate_name":
        relative = cast(str, decision["alternate_relative_path"])
    actual = _signature(_safe_path(root, relative))
    if kind in {"remove_created", "remove_empty_parent"}:
        expected = PathSignature("missing", 0, EMPTY_SHA256)
    elif kind == "restore_object":
        expected = _signature(_safe_path(root, cast(str, step["from_relative_path"])))
    else:
        expected = PathSignature.from_mapping(step["expected_current_signature"])
    if actual != expected:
        raise WorkspaceRestoreError(
            "restore_state_ambiguous",
            "A completed restore step changed and requires review.",
        )


def _stage_move_sources(
    root: Path,
    record: Mapping[str, Any],
    plan: Sequence[Mapping[str, Any]],
    staging: Sequence[Mapping[str, Any]],
) -> None:
    from sidecar.ai.tools.workspace_restore import (  # noqa: PLC0415
        WorkspaceRestoreError,
        _assert_signature,
        _fsync_directory,
        _safe_path,
        _signature,
    )

    steps = {cast(str, item["step"]["step_id"]): item["step"] for item in plan}
    completed = set(cast(list[str], record["restore"]["completed_inverse_step_ids"]))
    for entry in staging:
        step_id = cast(str, entry["inverse_step_id"])
        if step_id in completed:
            continue
        step = cast(Mapping[str, Any], steps[step_id])
        source = _safe_path(root, cast(str, step["from_relative_path"]))
        stage = _safe_path(root, cast(str, entry["stage_relative_path"]))
        expected = PathSignature.from_mapping(entry["expected_signature"])
        if _signature(stage) == expected and _signature(source).kind == "missing":
            continue
        if (
            _signature(stage) == expected
            and _signature(source) == expected
            and _same_file(source, stage)
        ):
            source.unlink()
            _fsync_directory(source.parent)
            continue
        _assert_signature(source, entry["expected_signature"], "restore_state_ambiguous")
        stage.parent.mkdir(parents=True, exist_ok=True)
        if _signature(stage).kind != "missing":
            raise WorkspaceRestoreError(
                "restore_stage_collision", "Restore staging path is occupied."
            )
        if source.is_file() and not source.is_symlink():
            try:
                os.link(source, stage)
            except FileExistsError as error:
                raise WorkspaceRestoreError(
                    "restore_stage_collision", "Restore staging path is occupied."
                ) from error
            except OSError:
                os.rename(source, stage)
            else:
                source.unlink()
        else:
            os.rename(source, stage)
        _fsync_directory(stage.parent)


def _same_file(left: Path, right: Path) -> bool:
    try:
        return os.path.samefile(left, right)
    except OSError:
        return False


__all__ = ["_stage_move_sources", "_validate_completed_step", "_validate_resume_state"]
