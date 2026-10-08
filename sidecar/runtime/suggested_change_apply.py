"""Plan Plus C4: apply Electron-consented suggested changes as one journal change set.

``workspace.apply_suggested_changes`` carries explicit root authority (path,
device id, inode) like ``workspace.confirm_runtime_checkpoint``. Every item is
preflighted before any write; a single non-ok item refuses the whole call. The
writes go through the ordinary journaled ``edit_file`` / ``write_file`` tools with
synthetic attribution so the call is one change set and one undo unit. A failed
write mid-call undoes that change set and reports ``rolled_back``.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import stat
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
from sidecar.ai.tools.builtins.edit_file import edit_file_tool
from sidecar.ai.tools.builtins.file_state import load_existing_text_state_for_mutation
from sidecar.ai.tools.builtins.filesystem import current_max_edit_file_bytes, write_file_tool
from sidecar.ai.tools.builtins.structured_diff import (
    compute_structured_diff,
    normalize_diff_input_text,
    sha256_text,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_restore import (
    WorkspaceRestoreError,
    list_change_sets,
    undo_change_set,
)
from sidecar.ai.tools.workspace_retention import run_recovery_maintenance

logger = logging.getLogger(__name__)

MAX_ITEMS = 20
MAX_ID_CHARS = 160
MAX_PATH_CHARS = 4096
_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_DECIMAL_RE = re.compile(r"^[1-9][0-9]{0,39}$")
_REQUIRED_KEYS = frozenset(
    {"schema_version", "workspace_root", "device_id", "inode", "session_id", "apply_id", "items"}
)
_ITEM_KEYS = frozenset(
    {"suggestion_id", "path", "kind", "old_string", "new_string", "expected_hash"}
)
_REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class SuggestedChangeParamsError(ValueError):
    """Malformed request params; the RPC edge answers with invalid params."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


class _Refusal(Exception):
    """Internal preflight control flow; never escapes this module."""

    def __init__(self, outcome: str, reason: str, *, base_hash: str | None = None,
                 diff: dict[str, Any] | None = None) -> None:
        super().__init__(reason)
        self.outcome = outcome
        self.reason = reason
        self.base_hash = base_hash
        self.diff = diff


@dataclass(frozen=True)
class _Item:
    suggestion_id: str
    path: str
    kind: str
    old_string: str
    new_string: str
    expected_hash: str | None


@dataclass(frozen=True)
class _Params:
    workspace_root: str
    device_id: str
    inode: str
    session_id: str
    apply_id: str
    items: tuple[_Item, ...]


@dataclass
class _FileState:
    kind: str  # "existing" | "created"
    start_hash: str | None
    text: str
    snapshot: dict[str, object] | None


@dataclass(frozen=True)
class _Plan:
    item: _Item
    target: Path
    key: str
    first_for_path: bool


def apply_suggested_changes(params: Any, config: Any) -> dict[str, object]:
    cap = current_max_edit_file_bytes()
    parsed = _parse_params(params, cap)
    store, snapshot_root = _recovery_store(config)
    root = _verified_root(parsed)
    if root is None:
        return _refuse_all(parsed.items, "workspace_root_changed")
    blocked = _workspace_block(store, root)
    if blocked is not None:
        return _refuse_all(parsed.items, blocked)
    states: dict[str, _FileState] = {}
    refusals: list[dict[str, object] | None] = []
    plans: list[_Plan] = []
    for item in parsed.items:
        try:
            plans.append(_preflight_item(item, root, states, cap))
            refusals.append(None)
        except _Refusal as refusal:
            refusals.append(_item_result(item.suggestion_id, refusal.outcome, refusal.reason,
                                         base_hash=refusal.base_hash, diff=refusal.diff))
    if any(refusal is not None for refusal in refusals):
        return _result("refused", None, [
            refusal or _item_result(item.suggestion_id, "refused", "batch_refused")
            for item, refusal in zip(parsed.items, refusals, strict=True)
        ])
    lifecycle = MutationChangeSetLifecycle(store, root)
    guard = WorkspaceGuard(str(root), pre_change_snapshot_root=snapshot_root,
                           mutation_journal=lifecycle)
    if guard.root is None or os.path.normcase(str(guard.root)) != os.path.normcase(str(root)):
        return _refuse_all(parsed.items, "workspace_root_changed")
    return _write_change_set(parsed, plans, states, guard, lifecycle)


# -- params -------------------------------------------------------------------


def _parse_params(params: Any, cap: int) -> _Params:
    if not isinstance(params, dict) or set(params) - {"accept_version"} != _REQUIRED_KEYS:
        raise SuggestedChangeParamsError("params_invalid", "params keys do not match v1")
    if type(params["schema_version"]) is not int or params["schema_version"] != 1:
        raise SuggestedChangeParamsError("schema_version_invalid", "schema_version must be 1")
    root = params["workspace_root"]
    if not isinstance(root, str) or not root.strip() or not Path(root).is_absolute():
        raise SuggestedChangeParamsError(
            "workspace_root_invalid", "workspace_root must be absolute"
        )
    device_id, inode = params["device_id"], params["inode"]
    if not all(isinstance(value, str) and _DECIMAL_RE.match(value) for value in (device_id, inode)):
        raise SuggestedChangeParamsError(
            "workspace_identity_invalid", "device_id and inode must be decimal strings"
        )
    session_id = _bounded_id(params["session_id"])
    apply_id = _bounded_id(params["apply_id"])
    if not session_id or not apply_id:
        raise SuggestedChangeParamsError("identity_invalid", "session_id and apply_id are required")
    items = _parse_items(params["items"], cap)
    return _Params(root, device_id, inode, session_id, apply_id, items)


def _parse_items(raw_items: Any, cap: int) -> tuple[_Item, ...]:
    if not isinstance(raw_items, list) or not raw_items:
        raise SuggestedChangeParamsError("items_invalid", "items must be a non-empty array")
    if len(raw_items) > MAX_ITEMS:
        raise SuggestedChangeParamsError("too_many_items", f"at most {MAX_ITEMS} items per call")
    items = tuple(_parse_item(raw, index, cap) for index, raw in enumerate(raw_items, start=1))
    if len({item.suggestion_id for item in items}) != len(items):
        raise SuggestedChangeParamsError("duplicate_suggestion_id", "suggestion ids must be unique")
    return items


def _parse_item(raw: Any, index: int, cap: int) -> _Item:
    invalid = SuggestedChangeParamsError("item_invalid", f"item {index} is malformed")
    if not isinstance(raw, dict) or set(raw) != _ITEM_KEYS:
        raise invalid
    suggestion_id = _bounded_id(raw["suggestion_id"])
    path, kind = raw["path"], raw["kind"]
    old_string, new_string = raw["old_string"], raw["new_string"]
    expected_hash = raw["expected_hash"]
    if (
        not suggestion_id
        or not isinstance(path, str) or not path.strip() or len(path) > MAX_PATH_CHARS
        or "\x00" in path
        or not isinstance(new_string, str)
    ):
        raise invalid
    if kind == "replace":
        valid = (isinstance(old_string, str) and old_string != ""
                 and isinstance(expected_hash, str) and _HASH_RE.match(expected_hash) is not None)
    elif kind == "create":
        valid = old_string in (None, "") and expected_hash is None
        old_string = ""
    else:
        valid = False
    if not valid:
        raise invalid
    for value in (old_string, new_string):
        try:
            size = len(value.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise invalid from error
        if size > cap:
            raise SuggestedChangeParamsError(
                "item_too_large", f"item {index} exceeds the {cap} byte edit cap"
            )
    return _Item(suggestion_id, path, kind, old_string, new_string, expected_hash)


def _bounded_id(value: object) -> str:
    if not isinstance(value, str) or "\x00" in value:
        return ""
    text = value.strip()
    return text if 0 < len(text) <= MAX_ID_CHARS else ""


# -- authority ------------------------------------------------------------------


def _recovery_store(config: Any) -> tuple[WorkspaceMutationJournalStore, str]:
    state_text = str(getattr(config, "electron_state_root", "") or "").strip()
    if not state_text or not Path(state_text).is_absolute():
        raise WorkspaceRestoreError(
            "recovery_root_missing", "Workspace recovery storage is unavailable."
        )
    state_root = Path(state_text)
    return (
        WorkspaceMutationJournalStore(state_root / "workspace-recovery"),
        str(state_root / "workspace-snapshots"),
    )


def _verified_root(params: _Params) -> Path | None:
    try:
        identity = workspace_identity(params.workspace_root)
        resolved = Path(params.workspace_root).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None
    if (
        os.path.normcase(os.path.normpath(params.workspace_root)) != os.path.normcase(str(resolved))
        or identity.device_id != params.device_id
        or identity.file_id != params.inode
    ):
        return None
    return resolved


def _workspace_block(store: WorkspaceMutationJournalStore, root: Path) -> str | None:
    change_sets = list_change_sets(store, root)["change_sets"]
    assert isinstance(change_sets, list)
    if any(item.get("restore_status") == "in_progress" for item in change_sets):
        return "restore_in_progress"
    if any(item.get("state") in {"prepared", "in_progress"} for item in change_sets):
        return "workspace_busy"
    return None


def _resolve_target(root: Path, raw: str) -> tuple[Path, str]:
    requested = Path(raw)
    if not requested.is_absolute() and (requested.drive or requested.root):
        raise _Refusal("refused", "path_invalid")
    candidate = requested if requested.is_absolute() else root / requested
    lexical = Path(os.path.normpath(str(candidate)))
    if not _inside(lexical, root):
        raise _Refusal("refused", "path_outside_workspace")
    try:
        real = lexical.resolve(strict=False)
    except (OSError, RuntimeError) as error:
        raise _Refusal("refused", "path_invalid") from error
    if not _inside(real, root):
        raise _Refusal("refused", "path_outside_workspace")
    current = root
    for part in lexical.relative_to(root).parts:
        current = current / part
        if (current.exists() or current.is_symlink()) and _is_link(current):
            raise _Refusal("refused", "path_link_refused")
    relative = Path(os.path.relpath(real, root)).as_posix()
    if relative in {"", "."}:
        raise _Refusal("refused", "path_invalid")
    if relative.split("/", 1)[0].casefold() == ".jenny":
        raise _Refusal("refused", "reserved_path")
    return real, relative


def _inside(path: Path, root: Path) -> bool:
    path_text = os.path.normcase(str(path))
    root_text = os.path.normcase(str(root))
    try:
        return path_text != root_text and os.path.commonpath([path_text, root_text]) == root_text
    except ValueError:
        return False


def _is_link(path: Path) -> bool:
    if path.is_symlink():
        return True
    if os.name != "nt":
        return False
    try:
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
    except OSError:
        return True
    return bool(attributes & _REPARSE_ATTRIBUTE)


# -- preflight ----------------------------------------------------------------


def _preflight_item(item: _Item, root: Path, states: dict[str, _FileState], cap: int) -> _Plan:
    target, relative = _resolve_target(root, item.path)
    key = os.path.normcase(str(target))
    if item.kind == "create":
        return _preflight_create(item, target, key, states)
    state = states.get(key)
    first = state is None
    if state is None:
        state = _load_state(target, relative, cap)
        states[key] = state
    elif state.kind == "created":
        raise _Refusal("refused", "duplicate_target")
    current_hash = sha256_text(state.text)
    old = normalize_diff_input_text(item.old_string)
    new = normalize_diff_input_text(item.new_string)
    if old == new:
        raise _Refusal("refused", "no_change")
    occurrences = state.text.count(old)
    if occurrences != 1:
        reason = "no_match" if occurrences == 0 else "ambiguous_match"
        raise _Refusal("out_of_date", reason, base_hash=current_hash)
    updated = _apply_once(state.text, old, new)
    hash_ok = item.expected_hash == current_hash or (
        not first and item.expected_hash == state.start_hash
    )
    if not hash_ok:
        diff = compute_structured_diff(relative, state.text, updated, status="modified",
                                       logger=logger)
        raise _Refusal("moved", "hash_changed", base_hash=current_hash, diff=diff)
    state.text = updated
    return _Plan(item, target, key, first)


def _preflight_create(
    item: _Item, target: Path, key: str, states: dict[str, _FileState]
) -> _Plan:
    if key in states:
        raise _Refusal("refused", "duplicate_target")
    if target.exists() or target.is_symlink():
        raise _Refusal("out_of_date", "target_exists")
    parent = target.parent
    while not parent.exists():
        parent = parent.parent
    if not parent.is_dir():
        raise _Refusal("refused", "parent_not_directory")
    states[key] = _FileState("created", None, normalize_diff_input_text(item.new_string), None)
    return _Plan(item, target, key, True)


def _load_state(target: Path, relative: str, cap: int) -> _FileState:
    if not target.exists():
        raise _Refusal("out_of_date", "file_missing")
    if not target.is_file():
        raise _Refusal("refused", "not_a_file")
    try:
        loaded = load_existing_text_state_for_mutation(
            path=target,
            relative_path=relative,
            max_bytes=cap,
            expected_snapshot_value=None,
            action="apply a suggested change",
            require_read_snapshot=False,
        )
    except ToolExecutionFailure as error:
        raise _Refusal("refused", "file_unreadable") from error
    text = normalize_diff_input_text(loaded.text)
    return _FileState("existing", sha256_text(text), text, loaded.snapshot.to_metadata())


def _apply_once(content: str, old: str, new: str) -> str:
    """Preview of edit_file's single replacement (whole-line deletes take the newline)."""
    start = content.find(old)
    end = start + len(old)
    if (
        new == ""
        and not old.endswith("\n")
        and (start == 0 or content[start - 1] == "\n")
        and content[end : end + 1] == "\n"
    ):
        end += 1
    return f"{content[:start]}{new}{content[end:]}"


# -- writes -------------------------------------------------------------------


def _write_change_set(
    params: _Params,
    plans: list[_Plan],
    states: dict[str, _FileState],
    guard: WorkspaceGuard,
    lifecycle: MutationChangeSetLifecycle,
) -> dict[str, object]:
    change_set_id = _uuid7()
    attribution = {
        "_jenny_session_id": params.session_id,
        "_jenny_turn_id": params.apply_id,
        "_jenny_change_set_id": change_set_id,
    }
    snapshots = {key: state.snapshot for key, state in states.items()}
    applied: list[dict[str, object]] = []
    failed_index: int | None = None
    for index, plan in enumerate(plans):
        result = _write_one(plan, guard, attribution, snapshots.get(plan.key))
        if result is None:
            failed_index = index
            break
        written = result.metadata.get("written_snapshot")
        snapshots[plan.key] = written if isinstance(written, dict) else None
        applied.append(_applied_result(plan, result))
    final = lifecycle.finalize(change_set_id, tool_failed=failed_index is not None)
    if not final.ok and applied:
        # The journal could not record the outcome, so neither "applied" nor a
        # rollback can be proven: say so with the change set id, never claim either.
        raise WorkspaceRestoreError(
            "suggested_change_rollback_failed",
            "Suggested changes were written but the change could not be recorded for undo.",
            details={"change_set_id": change_set_id, "status": "needs_review",
                     "cause": "finalize_failed"},
        )
    record = final.record if final.ok else None
    if failed_index is None and record is not None and record.get("state") == "committed":
        _maintain(lifecycle.store, guard.require_root())
        return _result("applied", {"change_set_id": change_set_id}, applied)
    _roll_back(lifecycle.store, guard.require_root(), change_set_id, record)
    failed_at = len(plans) if failed_index is None else failed_index
    return _result(
        "rolled_back",
        {"change_set_id": change_set_id} if record is not None else None,
        [
            _item_result(plan.item.suggestion_id, "refused",
                         "write_failed" if index == failed_at else "rolled_back")
            for index, plan in enumerate(plans)
        ],
    )


def _write_one(
    plan: _Plan,
    guard: WorkspaceGuard,
    attribution: dict[str, str],
    snapshot: dict[str, object] | None,
) -> ToolHandlerResult | None:
    item = plan.item
    arguments: dict[str, object] = {**attribution, "_jenny_tool_call_id": item.suggestion_id}
    try:
        if item.kind == "create":
            result = write_file_tool(
                {**arguments, "path": str(plan.target), "content": item.new_string}, guard
            )
        else:
            arguments.update(file_path=str(plan.target), old_string=item.old_string,
                             new_string=item.new_string)
            if snapshot is not None:
                arguments["expected_read_snapshot"] = snapshot
            result = edit_file_tool(arguments, guard)
    except Exception as error:  # noqa: BLE001 - any write failure rolls the set back.
        logger.warning(
            "suggested change write raised",
            extra={"event": "sidecar.runtime.suggested_change_apply.write_raised",
                   "error_type": type(error).__name__},
        )
        return None
    if not result.success:
        logger.warning(
            "suggested change write failed",
            extra={"event": "sidecar.runtime.suggested_change_apply.write_failed",
                   "error_code": result.metadata.get("error_code")},
        )
        return None
    return result


def _applied_result(plan: _Plan, result: ToolHandlerResult) -> dict[str, object]:
    diff = result.metadata.get("diff")
    diff = diff if isinstance(diff, dict) else None
    after_hash = diff.get("after_hash") if diff is not None else None
    if not isinstance(after_hash, str) or not _HASH_RE.match(after_hash):
        after_hash = _hash_on_disk(plan.target)
    before_hash = diff.get("before_hash") if diff is not None else None
    is_replace = plan.item.kind == "replace"
    base_hash = before_hash if is_replace and isinstance(before_hash, str) else None
    return _item_result(plan.item.suggestion_id, "applied", None,
                        after_hash=after_hash, diff=diff, base_hash=base_hash)


def _hash_on_disk(target: Path) -> str | None:
    try:
        raw = target.read_bytes()
        text = raw.decode("utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return None
    return sha256_text(normalize_diff_input_text(text))


def _roll_back(
    store: WorkspaceMutationJournalStore,
    root: Path,
    change_set_id: str,
    record: dict[str, Any] | None,
) -> None:
    state = record.get("state") if record is not None else None
    if state not in {"committed", "interrupted"}:
        return
    try:
        undo_change_set(store, root, change_set_id)
    except WorkspaceRestoreError as error:
        logger.error(
            "suggested change rollback failed",
            extra={"event": "sidecar.runtime.suggested_change_apply.rollback_failed",
                   "reason": error.reason},
        )
        raise WorkspaceRestoreError(
            "suggested_change_rollback_failed",
            "A suggested change failed to write and the earlier writes could not be undone.",
            details={"change_set_id": change_set_id, "status": "needs_review",
                     "cause": error.reason},
        ) from error


def _maintain(store: WorkspaceMutationJournalStore, root: Path) -> None:
    try:
        run_recovery_maintenance(store, root)
    except Exception as error:  # noqa: BLE001 - maintenance is best-effort.
        logger.warning("workspace_recovery_maintenance_failed",
                       extra={"reason": type(error).__name__})


# -- results ------------------------------------------------------------------


def _item_result(  # noqa: PLR0913 - the C4 result item fields.
    suggestion_id: str,
    outcome: str,
    reason: str | None,
    *,
    after_hash: str | None = None,
    diff: dict[str, Any] | None = None,
    base_hash: str | None = None,
) -> dict[str, object]:
    return {
        "suggestion_id": suggestion_id,
        "outcome": outcome,
        "reason": reason,
        "after_hash": after_hash,
        "diff": diff,
        "base_hash": base_hash,
    }


def _result(
    status: str, change_set: dict[str, str] | None, items: list[dict[str, object]]
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "status": status,
        "workspace_change_set": change_set,
        "items": items,
    }


def _refuse_all(items: tuple[_Item, ...], reason: str) -> dict[str, object]:
    return _result("refused", None, [
        _item_result(item.suggestion_id, "refused", reason) for item in items
    ])


def _uuid7() -> str:
    milliseconds = int(time.time() * 1000) & ((1 << 48) - 1)
    value = (milliseconds << 80) | (0x7 << 76) | (secrets.randbits(12) << 64)
    value |= 0x2 << 62
    value |= secrets.randbits(62)
    return str(uuid.UUID(int=value))


__all__ = ["SuggestedChangeParamsError", "apply_suggested_changes"]
