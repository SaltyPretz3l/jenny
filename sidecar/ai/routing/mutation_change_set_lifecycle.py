"""Turn-scoped lifecycle for durable typed workspace mutation change sets."""

from __future__ import annotations

import copy
import hashlib
import logging
import secrets
import time
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_mutation_journal_contract import (
    EMPTY_SHA256,
    PathSignature,
    signature_for_path,
    workspace_identity,
)
from sidecar.ai.tools.workspace_mutation_journal_store import (
    StoreResult,
    WorkspaceMutationJournalStore,
)

TYPED_MUTATION_TOOLS = frozenset({"write_file", "edit_file", "delete_file", "move_file"})
ATTRIBUTION_KEYS = ("_jenny_turn_id", "_jenny_tool_call_id", "_jenny_change_set_id")
_WARNING = "Shell mutations are not journaled. Explorer rename is not journaled until WO-27 item 2."
_EMPTY_DIRECTORY_SHA256 = hashlib.sha256(b"jenny-directory-signature-v1\0").hexdigest()
_SHA256_HEX_LENGTH = 64
_MAX_COVERAGE_EVENTS = 10_000
_MAX_ID_CHARS = 160

logger = logging.getLogger(__name__)


@dataclass
class _RunAttribution:
    run: Any
    turn_id: str
    session_id: str
    change_set_id: str = ""


@dataclass(frozen=True)
class PreparedMutation:
    change_set_id: str
    workspace_id: str
    sequences: tuple[int, ...]


_CURRENT_RUN: ContextVar[_RunAttribution | None] = ContextVar(
    "workspace_mutation_change_set_run", default=None
)


def bind_run_context(run: Any) -> None:
    """Bind request identity before approval freezing or tool dispatch."""

    session_id = str(getattr(run, "session_id", "") or "").strip()
    turn_id = str(getattr(run, "request_id", "") or "").strip()
    context = _RunAttribution(
        run=run,
        turn_id=turn_id,
        session_id=session_id,
        change_set_id=_bounded_id(getattr(run, "_jenny_change_set_id", "")),
    )
    token = _CURRENT_RUN.set(context)
    run._jenny_mutation_context_token = token


def current_run_change_set_id() -> str:
    context = _CURRENT_RUN.get()
    return _bounded_id(getattr(context.run, "_jenny_change_set_id", "")) if context else ""


def inject_tool_attribution(  # noqa: C901, PLR0912 - ordered trust and context fallbacks.
    *,
    tool_name: str,
    tool_call_id: str,
    session_id: str | None,
    explicit_turn_id: str | None = None,
    existing: Mapping[str, object] | None = None,
) -> dict[str, str]:
    """Return private attribution without exposing it to public tool schemas."""

    if tool_name not in TYPED_MUTATION_TOOLS and tool_name != "run_command":
        return {}
    supplied = existing or {}
    supplied_change_set = _bounded_id(supplied.get("_jenny_change_set_id"))
    context = _CURRENT_RUN.get()
    normalized_session = str(session_id or "").strip()
    turn_id = str(explicit_turn_id or "").strip()
    if not turn_id and context is not None and context.session_id == normalized_session:
        turn_id = context.turn_id
    if supplied_change_set:
        if context is None or context.session_id != normalized_session:
            supplied_change_set = ""
        else:
            config = getattr(getattr(context.run, "kernel", None), "_config", None)
            state_root = str(getattr(config, "electron_state_root", "") or "").strip()
            workspace_root = str(getattr(config, "tools_workspace_root", "") or "").strip()
            attribution: Mapping[str, object] = {}
            if state_root and workspace_root:
                identity = workspace_identity(workspace_root)
                loaded = WorkspaceMutationJournalStore.from_version_root(
                    Path(state_root) / "workspace-recovery" / "v1"
                ).load(identity.workspace_id, supplied_change_set)
                attribution = loaded.record if loaded.ok and loaded.record is not None else {}
            if (
                attribution.get("session_id") != normalized_session
                or attribution.get("turn_id") != turn_id
            ):
                supplied_change_set = ""
    change_set_id = supplied_change_set
    if not change_set_id and context is not None and context.session_id == normalized_session:
        change_set_id = context.change_set_id
    if tool_name in TYPED_MUTATION_TOOLS and not change_set_id:
        change_set_id = _uuid7()
    if context is not None and context.session_id == normalized_session:
        if change_set_id:
            context.change_set_id = change_set_id
            context.run._jenny_change_set_id = change_set_id
        if turn_id:
            context.turn_id = turn_id
    if not normalized_session or not turn_id or not tool_call_id:
        return {}
    result = {
        "_jenny_turn_id": turn_id,
        "_jenny_tool_call_id": tool_call_id,
    }
    if change_set_id:
        result["_jenny_change_set_id"] = change_set_id
    return result


def freeze_approval_tool_calls(
    tool_calls: Sequence[Any], frozen_inputs: Sequence[Any]
) -> tuple[Any, ...]:
    """Copy private change-set attribution into the process-local approval plan."""

    frozen_by_id = {str(item.call_id): item for item in frozen_inputs}
    result: list[Any] = []
    for call in tool_calls:
        frozen = frozen_by_id.get(str(getattr(call, "call_id", "") or ""))
        arguments = dict(getattr(call, "arguments", {}) or {})
        if frozen is not None:
            for key in ATTRIBUTION_KEYS:
                value = frozen.effective_tool_arguments.get(key)
                if isinstance(value, str) and value:
                    arguments[key] = value
        try:
            result.append(replace(call, arguments=arguments))
        except TypeError:
            result.append(call)
    return tuple(result)


def finish_run_change_set(run: Any, *, approval_paused: bool, reason: str) -> None:
    """Settle a durable set only when the top-level turn truly settles."""

    token = getattr(run, "_jenny_mutation_context_token", None)
    if not isinstance(token, Token):
        return
    try:
        if approval_paused:
            return
        change_set_id = str(getattr(run, "_jenny_change_set_id", "") or "").strip()
        config = getattr(getattr(run, "kernel", None), "_config", None)
        state_root = str(getattr(config, "electron_state_root", "") or "").strip()
        workspace_root = str(getattr(config, "tools_workspace_root", "") or "").strip()
        if not change_set_id or not state_root or not workspace_root:
            return
        lifecycle = MutationChangeSetLifecycle(
            WorkspaceMutationJournalStore.from_version_root(
                Path(state_root) / "workspace-recovery" / "v1"
            ),
            workspace_root,
        )
        runtime = getattr(run, "runtime", None)
        cancelled = bool(getattr(getattr(runtime, "cancel_handle", None), "cancelled", False))
        interrupted = cancelled or "interrupt" in reason or "cancel" in reason
        tool_failed = any(not bool(getattr(item, "success", True)) for item in run.outcomes)
        result = lifecycle.finalize(
            change_set_id,
            interrupted=interrupted,
            tool_failed=tool_failed,
        )
        if result.record is not None and result.record["state"] == "committed":
            try:
                from sidecar.ai.tools.workspace_retention import (  # noqa: PLC0415
                    run_recovery_maintenance,
                )

                run_recovery_maintenance(lifecycle.store, workspace_root)
            except Exception as error:  # noqa: BLE001 - maintenance is best-effort.
                logger.warning(
                    "workspace_recovery_maintenance_failed",
                    extra={"reason": type(error).__name__},
                )
    finally:
        try:
            _CURRENT_RUN.reset(token)
        finally:
            run._jenny_mutation_context_token = None


class MutationChangeSetLifecycle:
    """Prepare, advance, reconcile, and settle one turn-wide mutation set."""

    def __init__(
        self,
        store: WorkspaceMutationJournalStore,
        workspace_root: str | Path,
    ) -> None:
        self.store = store
        self.workspace_root = Path(workspace_root)
        self._pending_uncovered: dict[tuple[str, str], list[str]] = {}

    def observe_tool_call(self, tool_name: str, arguments: Mapping[str, object]) -> None:
        if tool_name != "run_command":
            return
        attribution = self._attribution(arguments, require_change_set=False)
        if attribution is None:
            return
        session_id, turn_id, tool_call_id, change_set_id = attribution
        key = (session_id, turn_id)
        if not change_set_id:
            pending = self._pending_uncovered.setdefault(key, [])
            if tool_call_id not in pending:
                pending.append(tool_call_id)
            return
        loaded = self._load_by_id(change_set_id)
        if loaded is None:
            pending = self._pending_uncovered.setdefault(key, [])
            if tool_call_id not in pending:
                pending.append(tool_call_id)
            return
        self._persist_uncovered(loaded, tool_call_id)

    def prepare_file_change(  # noqa: PLR0913 - explicit mutation preflight fields.
        self,
        arguments: Mapping[str, object],
        *,
        tool_name: str,
        target: Path,
        relative_path: str,
        new_bytes: bytes,
        checkpoint: object | None,
    ) -> PreparedMutation:
        pre = self._signature(target)
        post = _bytes_signature(new_bytes)
        if pre.kind == "missing":
            operation = _create_operation(
                tool_name, relative_path, pre, post, target, self.workspace_root
            )
        else:
            recovery = _checkpoint_recovery(checkpoint, role="overwritten_destination")
            if recovery is None:
                raise _journal_failure("A durable pre-change checkpoint was not available.")
            operation = _modify_operation(tool_name, relative_path, pre, post, recovery)
        return self._prepare(arguments, [operation])

    def prepare_delete(
        self,
        arguments: Mapping[str, object],
        *,
        target: Path,
        relative_path: str,
        trash_relative_path: str,
    ) -> PreparedMutation:
        pre = self._signature(target)
        recovery = {
            "object_id": f"trash:{trash_relative_path}",
            "store_kind": "trash",
            "workspace_relative_path": trash_relative_path,
            "role": "deleted_source",
            "signature": pre.as_dict(),
        }
        return self._prepare(arguments, [_delete_operation(relative_path, pre, recovery)])

    def prepare_move_batch(
        self,
        arguments: Mapping[str, object],
        *,
        moves: Sequence[tuple[Path, str, Path, str, object | None]],
    ) -> PreparedMutation:
        operations: list[dict[str, Any]] = []
        for source, source_relative, destination, destination_relative, checkpoint in moves:
            source_pre = self._signature(source)
            destination_pre = self._signature(destination)
            recovery = _checkpoint_recovery(checkpoint, role="overwritten_destination")
            if destination_pre.kind != "missing" and recovery is None:
                raise _journal_failure("An overwritten destination checkpoint was not available.")
            operations.append(
                _move_operation(
                    source_relative,
                    destination_relative,
                    source_pre,
                    destination_pre,
                    destination,
                    self.workspace_root,
                    recovery,
                )
            )
        return self._prepare(arguments, operations)

    def begin_sequence(self, prepared: PreparedMutation, sequence: int) -> dict[str, object]:
        record = self._required_record(prepared)
        operation = _operation_for_sequence(record, sequence)
        operation["status"] = "applying"
        record["state"] = "in_progress"
        _touch(record, mutation_started=True)
        return self._write_required(record)

    def mark_applied_sequence(self, prepared: PreparedMutation, sequence: int) -> dict[str, object]:
        record = self._required_record(prepared)
        operation = _operation_for_sequence(record, sequence)
        if not _operation_matches(operation, "post_signature", self.workspace_root):
            operation["status"] = "unknown"
            record["state"] = "interrupted"
        else:
            operation["status"] = "applied"
        _sync_completed(record)
        _touch(record)
        return self._write_post_mutation(record, prepared.sequences)

    def mark_applied(self, prepared: PreparedMutation) -> dict[str, object]:
        return self.mark_applied_sequence(prepared, prepared.sequences[0])

    def mark_failed_sequence(self, prepared: PreparedMutation, sequence: int) -> dict[str, object]:
        record = self._required_record(prepared)
        operation = _operation_for_sequence(record, sequence)
        if _operation_matches(operation, "pre_signature", self.workspace_root):
            operation["status"] = "skipped"
        elif _operation_matches(operation, "post_signature", self.workspace_root):
            operation["status"] = "applied"
        else:
            operation["status"] = "unknown"
            record["state"] = "interrupted"
        _sync_completed(record)
        _touch(record)
        return self._write_post_mutation(record, prepared.sequences)

    def finalize(
        self,
        change_set_id: str,
        *,
        interrupted: bool = False,
        tool_failed: bool = False,
    ) -> StoreResult:
        record = self._load_by_id(change_set_id)
        if record is None or record["state"] not in {"prepared", "in_progress"}:
            return StoreResult(ok=True, record=record)
        operations = cast(list[dict[str, Any]], record["operations"])
        ambiguous = False
        for operation in operations:
            if operation["status"] in {"planned", "applying"}:
                if _operation_matches(operation, "post_signature", self.workspace_root):
                    operation["status"] = "applied"
                elif _operation_matches(operation, "pre_signature", self.workspace_root):
                    operation["status"] = "planned" if interrupted else "skipped"
                else:
                    operation["status"] = "unknown"
                    ambiguous = True
        _sync_completed(record)
        has_effect = bool(record["completed_sequences"])
        if interrupted or ambiguous:
            record["state"] = "interrupted"
            record["termination_reason"] = "turn_cancelled" if interrupted else "tool_failed"
        elif has_effect:
            record["state"] = "committed"
            record["termination_reason"] = "tool_failed" if tool_failed else "turn_completed"
        else:
            record["state"] = "rolled_back"
            record["termination_reason"] = "tool_failed" if tool_failed else "turn_completed"
            cast(dict[str, Any], record["retention"])["protected"] = False
        _touch(record, terminal=True)
        return self.store.write_transition(record, workspace_root=self.workspace_root)

    def is_recovery_object_pinned(self, object_id: str) -> bool:
        return self.store.is_recovery_object_pinned(object_id)

    def is_trash_entry_pinned(self, entry_name: str) -> bool:
        prefix = f"trash:.jenny/trash/{entry_name}/"
        exact = f"trash:.jenny/trash/{entry_name}"
        return any(
            object_id == exact or object_id.startswith(prefix)
            for object_id in self.store.pinned_recovery_object_ids()
        )

    def _prepare(
        self,
        arguments: Mapping[str, object],
        operations: list[dict[str, Any]],
    ) -> PreparedMutation:
        attribution = self._attribution(arguments, require_change_set=True)
        if attribution is None:
            raise _journal_failure("Mutation attribution was missing.")
        session_id, turn_id, tool_call_id, requested_id = attribution
        identity = workspace_identity(self.workspace_root)
        if any(
            item.record["restore"]["status"] == "in_progress"
            for item in self.store._scan_workspace(identity.workspace_id)
        ):
            raise _journal_failure("Workspace recovery is in progress; retry after it completes.")
        record = self._load_by_id(requested_id)
        if record is None:
            open_result = self.store.find_open_change_set(
                self.workspace_root, session_id=session_id, turn_id=turn_id
            )
            record = open_result.record if open_result.ok else None
        if record is None:
            record = _new_record(
                identity.as_dict(),
                requested_id,
                session_id,
                turn_id,
                tool_call_id,
                observed_at=self.store.now_provider(),
            )
            is_new = True
        else:
            is_new = False
            requested_id = cast(str, record["change_set_id"])
            if record["state"] not in {"prepared", "in_progress"}:
                raise _journal_failure("The mutation change set is already terminal.")
            if tool_call_id not in record["tool_call_ids"]:
                cast(list[str], record["tool_call_ids"]).append(tool_call_id)
        pending = self._pending_uncovered.pop((session_id, turn_id), [])
        for call_id in pending:
            _add_uncovered(record, call_id)
        base = len(cast(list[object], record["operations"]))
        for offset, operation in enumerate(operations, start=1):
            operation["sequence"] = base + offset
            operation["tool_call_id"] = tool_call_id
            for step_index, step in enumerate(operation["inverse_steps"], start=1):
                step["step_id"] = f"{base + offset}.{step_index}"
        cast(list[dict[str, Any]], record["operations"]).extend(operations)
        record["operation_count"] = len(cast(list[object], record["operations"]))
        _sync_retention(record)
        _touch(record)
        if is_new:
            self._write_required(record)
        else:
            record["state"] = "in_progress"
            self._write_required(record)
        sequences = tuple(range(base + 1, base + len(operations) + 1))
        prepared = PreparedMutation(requested_id, identity.workspace_id, sequences)
        self.begin_sequence(prepared, sequences[0])
        return prepared

    def _attribution(
        self, arguments: Mapping[str, object], *, require_change_set: bool
    ) -> tuple[str, str, str, str] | None:
        values = tuple(
            _bounded_id(arguments.get(key))
            for key in (
                "_jenny_session_id",
                "_jenny_turn_id",
                "_jenny_tool_call_id",
                "_jenny_change_set_id",
            )
        )
        session_id, turn_id, tool_call_id, change_set_id = values
        if not session_id or not turn_id or not tool_call_id:
            return None
        if require_change_set and not change_set_id:
            return None
        return session_id, turn_id, tool_call_id, change_set_id

    def _signature(self, path: Path) -> PathSignature:
        result = signature_for_path(path)
        if not result.ok or result.signature is None:
            raise _journal_failure("A complete workspace signature could not be produced.")
        return result.signature

    def _load_by_id(self, change_set_id: str) -> dict[str, Any] | None:
        if not change_set_id:
            return None
        identity = workspace_identity(self.workspace_root)
        loaded = self.store.load(identity.workspace_id, change_set_id)
        if loaded.ok and loaded.record is not None:
            return copy.deepcopy(loaded.record)
        if loaded.failure is not None and loaded.failure.reason == "journal_not_found":
            return None
        message = loaded.failure.message if loaded.failure else "Workspace journal load failed."
        raise _journal_failure(message)

    def _required_record(self, prepared: PreparedMutation) -> dict[str, Any]:
        loaded = self.store.load(prepared.workspace_id, prepared.change_set_id)
        if not loaded.ok or loaded.record is None:
            raise _journal_failure("The durable mutation change set could not be reloaded.")
        return copy.deepcopy(loaded.record)

    def _write_required(self, record: Mapping[str, Any]) -> dict[str, object]:
        result = self.store.write_transition(record, workspace_root=self.workspace_root)
        if not result.ok or result.record is None:
            message = (
                result.failure.message if result.failure else "Workspace journal write failed."
            )
            raise _journal_failure(message)
        return public_summary(result.record)

    def _write_post_mutation(
        self, record: Mapping[str, Any], sequences: Sequence[int]
    ) -> dict[str, object]:
        result = self.store.write_transition(record, workspace_root=self.workspace_root)
        if result.ok and result.record is not None:
            return public_summary(result.record, sequences)
        fallback = public_summary(record, sequences)
        fallback.update(
            {
                "state": "interrupted",
                "protected": False,
                "partially_undoable": True,
                "warning": (
                    "The workspace changed, but final journal settlement failed; "
                    "manual review is required."
                ),
            }
        )
        return fallback

    def _persist_uncovered(self, record: dict[str, Any], tool_call_id: str) -> None:
        _add_uncovered(record, tool_call_id)
        _touch(record)
        self.store.write_transition(record, workspace_root=self.workspace_root)


def public_summary(record: Mapping[str, Any], sequences: Sequence[int] = ()) -> dict[str, object]:
    coverage = cast(Mapping[str, Any], record["coverage"])
    retention = cast(Mapping[str, Any], record["retention"])
    return {
        "schema_version": 1,
        "change_set_id": str(record["change_set_id"]),
        "state": str(record["state"]),
        "operation_sequences": [int(item) for item in sequences][:100],
        "protected": bool(retention["protected"]),
        "partially_undoable": bool(coverage["partially_undoable"]),
        "warning": str(coverage["warning"])[:512],
    }


def _new_record(  # noqa: PLR0913 - journal identity plus the store-owned clock.
    identity: Mapping[str, object],
    change_set_id: str,
    session_id: str,
    turn_id: str,
    tool_call_id: str,
    *,
    observed_at: datetime,
) -> dict[str, Any]:
    observed_utc = (
        observed_at.replace(tzinfo=UTC)
        if observed_at.tzinfo is None
        else observed_at.astimezone(UTC)
    )
    now = _format_utc(observed_utc)
    due = (
        (observed_utc + timedelta(days=365))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    return {
        "schema_version": 1,
        "change_set_id": change_set_id,
        "state": "prepared",
        "workspace": dict(identity),
        "session_id": session_id,
        "turn_id": turn_id,
        "actor": "sidecar_tools",
        "tool_call_ids": [tool_call_id],
        "wall_time": {
            "prepared_at": now,
            "mutation_started_at": None,
            "updated_at": now,
            "terminal_at": None,
            "elapsed_ms": 0,
        },
        "termination_reason": None,
        "operation_count": 0,
        "completed_sequences": [],
        "coverage": {
            "level": "typed_tools_only",
            "included_tools": ["write_file", "edit_file", "delete_file", "move_file"],
            "excluded_mutation_classes": ["run_command", "explorer_rename"],
            "known_unjournaled_events": [],
            "partially_undoable": False,
            "warning": _WARNING,
        },
        "retention": {
            "protected": True,
            "reserved_bytes": 0,
            "reserved_entries": 0,
            "referenced_object_ids": [],
            "created_active_use_seconds": 0,
            "last_accessed_active_use_seconds": 0,
            "active_age_seconds": 0,
            "wall_clock_review_due_at": due,
            "wall_clock_review_presented_at": None,
            "pinned_as_newest_committed": False,
        },
        "restore": {
            "status": "not_requested",
            "requested_at": None,
            "updated_at": None,
            "completed_at": None,
            "completed_inverse_step_ids": [],
            "decisions": [],
            "staging_entries": [],
            "protected_occupants": [],
            "partial_result": None,
        },
        "operations": [],
        "integrity": {
            "canonicalization": "jenny_canonical_json_v1",
            "payload_byte_length": 0,
            "payload_sha256": "0" * 64,
        },
        "extensions": {},
    }


def _create_operation(  # noqa: PLR0913 - complete durable operation shape.
    tool_name: str,
    relative_path: str,
    pre: PathSignature,
    post: PathSignature,
    target: Path,
    root: Path,
) -> dict[str, Any]:
    parents = _missing_parent_paths(target, root)
    inverse = [_inverse("0.1", "remove_created", relative_path, None, None, post)]
    inverse.extend(_parent_inverse_steps(parents, start=2))
    return _operation(
        tool_name, "create", None, _endpoint(relative_path, pre, post), parents, [], inverse
    )


def _modify_operation(
    tool_name: str,
    relative_path: str,
    pre: PathSignature,
    post: PathSignature,
    recovery: dict[str, Any],
) -> dict[str, Any]:
    inverse = [
        _inverse(
            "0.1",
            "restore_object",
            recovery["workspace_relative_path"],
            relative_path,
            recovery["object_id"],
            post,
        )
    ]
    return _operation(
        tool_name, "modify", None, _endpoint(relative_path, pre, post), [], [recovery], inverse
    )


def _delete_operation(
    relative_path: str, pre: PathSignature, recovery: dict[str, Any]
) -> dict[str, Any]:
    inverse = [
        _inverse(
            "0.1",
            "restore_object",
            recovery["workspace_relative_path"],
            relative_path,
            recovery["object_id"],
            _missing_signature(),
        )
    ]
    return _operation(
        "delete_file",
        "delete",
        _endpoint(relative_path, pre, _missing_signature()),
        None,
        [],
        [recovery],
        inverse,
    )


def _move_operation(  # noqa: PLR0913 - complete source/destination preflight.
    source_relative: str,
    destination_relative: str,
    source_pre: PathSignature,
    destination_pre: PathSignature,
    destination: Path,
    root: Path,
    recovery: dict[str, Any] | None,
) -> dict[str, Any]:
    parents = _missing_parent_paths(destination, root)
    inverse = [
        _inverse("0.1", "move_back", destination_relative, source_relative, None, source_pre)
    ]
    recoveries = [recovery] if recovery is not None else []
    next_index = 2
    if recovery is not None:
        inverse.append(
            _inverse(
                "0.2",
                "restore_object",
                recovery["workspace_relative_path"],
                destination_relative,
                recovery["object_id"],
                _missing_signature(),
            )
        )
        next_index = 3
    inverse.extend(_parent_inverse_steps(parents, start=next_index))
    return _operation(
        "move_file",
        "move",
        _endpoint(source_relative, source_pre, _missing_signature()),
        _endpoint(destination_relative, destination_pre, source_pre),
        parents,
        recoveries,
        inverse,
    )


def _operation(  # noqa: PLR0913 - schema fields remain explicit at construction.
    tool_name: str,
    kind: str,
    source: dict[str, Any] | None,
    destination: dict[str, Any] | None,
    parents: list[str],
    recovery: list[dict[str, Any]],
    inverse: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "sequence": 0,
        "status": "planned",
        "kind": kind,
        "tool_name": tool_name,
        "tool_call_id": "pending",
        "observed_at": _utc_now(),
        "source": source,
        "destination": destination,
        "created_parent_paths": parents,
        "recovery_objects": recovery,
        "inverse_steps": inverse,
        "metadata_preservation": {
            "content_bytes": "preserved",
            "mtime": "best_effort",
            "ctime": "not_preserved",
            "owner": "not_preserved",
            "mode": "best_effort",
            "acls": "not_preserved",
            "extended_attributes": "not_preserved",
            "alternate_data_streams": "not_preserved",
        },
        "restore_outcome": None,
        "diagnostic_code": None,
    }


def _endpoint(path: str, pre: PathSignature, post: PathSignature) -> dict[str, Any]:
    return {
        "relative_path": path,
        "pre_signature": pre.as_dict(),
        "post_signature": post.as_dict(),
    }


def _inverse(  # noqa: PLR0913 - schema fields remain explicit at construction.
    step_id: str,
    kind: str,
    source: str,
    destination: str | None,
    recovery_id: str | None,
    expected: PathSignature,
) -> dict[str, Any]:
    return {
        "step_id": step_id,
        "kind": kind,
        "from_relative_path": source,
        "to_relative_path": destination,
        "recovery_object_id": recovery_id,
        "expected_current_signature": expected.as_dict(),
    }


def _parent_inverse_steps(parents: Sequence[str], *, start: int) -> list[dict[str, Any]]:
    empty = PathSignature("directory", 0, _EMPTY_DIRECTORY_SHA256)
    return [
        _inverse(f"0.{index}", "remove_empty_parent", parent, None, None, empty)
        for index, parent in enumerate(reversed(parents), start=start)
    ]


def _missing_parent_paths(target: Path, root: Path) -> list[str]:
    missing: list[Path] = []
    current = target.parent
    while current != root and not current.exists():
        missing.append(current)
        current = current.parent
    return [path.relative_to(root).as_posix() for path in reversed(missing)]


def _checkpoint_recovery(checkpoint: object | None, *, role: str) -> dict[str, Any] | None:
    object_id = str(getattr(checkpoint, "object_id", "") or "")
    path = str(getattr(checkpoint, "workspace_relative_path", "") or "")
    size = getattr(checkpoint, "byte_size", None)
    digest = str(getattr(checkpoint, "sha256", "") or "")
    if (
        not object_id
        or not path
        or not isinstance(size, int)
        or len(digest) != _SHA256_HEX_LENGTH
    ):
        return None
    return {
        "object_id": object_id,
        "store_kind": "backup",
        "workspace_relative_path": path,
        "role": role,
        "signature": {"kind": "file", "byte_size": size, "sha256": digest},
    }


def _operation_for_sequence(record: Mapping[str, Any], sequence: int) -> dict[str, Any]:
    for operation in cast(list[dict[str, Any]], record["operations"]):
        if operation["sequence"] == sequence:
            return operation
    raise _journal_failure("Mutation sequence was not present in the durable change set.")


def _operation_matches(operation: Mapping[str, Any], key: str, root: Path) -> bool:
    for endpoint_name in ("source", "destination"):
        endpoint = operation[endpoint_name]
        if endpoint is None:
            continue
        endpoint = cast(Mapping[str, Any], endpoint)
        target = root.joinpath(*str(endpoint["relative_path"]).split("/"))
        actual = signature_for_path(target)
        expected = PathSignature.from_mapping(cast(Mapping[str, object], endpoint[key]))
        if not actual.ok or actual.signature != expected:
            return False
    return True


def _sync_completed(record: dict[str, Any]) -> None:
    record["completed_sequences"] = sorted(
        operation["sequence"]
        for operation in cast(list[dict[str, Any]], record["operations"])
        if operation["status"] == "applied"
    )


def _sync_retention(record: dict[str, Any]) -> None:
    objects: dict[str, dict[str, Any]] = {}
    for operation in cast(list[dict[str, Any]], record["operations"]):
        for recovery in cast(list[dict[str, Any]], operation["recovery_objects"]):
            objects[cast(str, recovery["object_id"])] = recovery
    retention = cast(dict[str, Any], record["retention"])
    retention["referenced_object_ids"] = sorted(objects)
    retention["reserved_entries"] = len(objects)
    retention["reserved_bytes"] = sum(
        cast(int, item["signature"]["byte_size"]) for item in objects.values()
    )


def _add_uncovered(record: dict[str, Any], tool_call_id: str) -> None:
    coverage = cast(dict[str, Any], record["coverage"])
    events = cast(list[str], coverage["known_unjournaled_events"])
    if tool_call_id not in events and len(events) < _MAX_COVERAGE_EVENTS:
        events.append(tool_call_id)
    coverage["partially_undoable"] = True


def _touch(
    record: dict[str, Any], *, mutation_started: bool = False, terminal: bool = False
) -> None:
    now = _utc_now()
    wall = cast(dict[str, Any], record["wall_time"])
    if mutation_started and wall["mutation_started_at"] is None:
        wall["mutation_started_at"] = now
    wall["updated_at"] = now
    if terminal:
        wall["terminal_at"] = now
    prepared = datetime.fromisoformat(str(wall["prepared_at"]).replace("Z", "+00:00"))
    wall["elapsed_ms"] = max(int((datetime.now(UTC) - prepared).total_seconds() * 1000), 0)


def _bytes_signature(data: bytes) -> PathSignature:
    return PathSignature("file", len(data), hashlib.sha256(data).hexdigest())


def _missing_signature() -> PathSignature:
    return PathSignature("missing", 0, EMPTY_SHA256)


def _uuid7() -> str:
    milliseconds = int(time.time() * 1000) & ((1 << 48) - 1)
    value = (milliseconds << 80) | (0x7 << 76) | (secrets.randbits(12) << 64)
    value |= 0x2 << 62
    value |= secrets.randbits(62)
    return str(uuid.UUID(int=value))


def _bounded_id(value: object) -> str:
    text = str(value or "").strip()
    return (
        text[:_MAX_ID_CHARS]
        if 0 < len(text) <= _MAX_ID_CHARS and "\x00" not in text
        else ""
    )


def _utc_now() -> str:
    return _format_utc(datetime.now(UTC))


def _format_utc(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _journal_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message=message, retryable=True)


__all__ = [
    "ATTRIBUTION_KEYS",
    "MutationChangeSetLifecycle",
    "PreparedMutation",
    "TYPED_MUTATION_TOOLS",
    "bind_run_context",
    "finish_run_change_set",
    "freeze_approval_tool_calls",
    "inject_tool_attribution",
    "public_summary",
]
