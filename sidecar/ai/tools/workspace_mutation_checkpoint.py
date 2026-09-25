"""Private checkpoint transitions through the authoritative mutation journal.

A pin preserves settled history, never execution authority. The application must
also retain and validate its canonical checkpoint before consuming this pin.
"""
from __future__ import annotations

import copy
import hashlib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping

from filelock import Timeout

from sidecar.ai.tools.workspace_mutation_journal_contract import (
    canonical_json_bytes,
    workspace_identity,
)

_MAX_COMPLETED_EFFECTS = 255
_MAX_CLAIMED_BINDINGS = 20
_PREFIX_KEYS = ("schema_version", "change_set_id", "workspace", "session_id", "turn_id",
                "actor", "tool_call_ids", "operation_count", "completed_sequences",
                "coverage", "operations")


def mutation_reference(record: Mapping[str, Any]) -> dict[str, Any]:
    """Digest immutable history; retention timestamps and the pin are excluded."""
    prefix = {key: record[key] for key in _PREFIX_KEYS}
    return {"schema_version": 1, "workspace_id": record["workspace"]["workspace_id"],
            "change_set_id": record["change_set_id"], "operation_count": record["operation_count"],
            "operations_sha256": hashlib.sha256(canonical_json_bytes(prefix)).hexdigest()}


def settled_prefix(record: Mapping[str, Any]) -> bool:
    return (record["actor"] == "sidecar_tools" and record["state"] == "in_progress"
            and record["restore"]["status"] == "not_requested"
            and record["retention"]["protected"] is True
            and record["operation_count"] > 0
            and not record["coverage"]["known_unjournaled_events"]
            and record["coverage"]["partially_undoable"] is False
            and all(op["status"] in {"applied", "skipped"} for op in record["operations"]))


def has_runtime_checkpoint(record: Mapping[str, Any], *, allow_preparing: bool = False) -> bool:
    """Called only after full journal schema and integrity validation."""
    binding = record["extensions"].get("runtime_checkpoint")
    return bool(binding and record["extensions"].get("runtime_checkpoint_phase") in (
                    {"preparing", "confirmed"} if allow_preparing else {"confirmed"})
                and settled_prefix(record)
                and binding["mutation_ref"] == mutation_reference(record))


def _completed_prefix_matches(record: Mapping[str, Any], completed: Any) -> bool:
    if (not isinstance(completed, (tuple, list))
            or not 1 <= len(completed) <= _MAX_COMPLETED_EFFECTS):
        return False
    calls: dict[str, str] = {}
    for item in completed:
        if (not isinstance(item, Mapping) or not isinstance(item.get("call_id"), str)
                or not isinstance(item.get("tool_id"), str) or item["call_id"] in calls):
            return False
        calls[item["call_id"]] = item["tool_id"]
    return (all(op["tool_call_id"] in calls and calls[op["tool_call_id"]] == op["tool_name"]
                for op in record["operations"])
            and set(record["tool_call_ids"]) == {op["tool_call_id"] for op in record["operations"]})


def _transition_record(  # noqa: PLR0913 - closed transition fields.
    record: dict[str, Any], *, action: str, scope: Mapping[str, Any],
                       reference: Mapping[str, Any], binding: Mapping[str, Any] | None,
                       completed_effects: Any) -> None:
    if (record["session_id"] != scope.get("session_id")
            or record["turn_id"] != scope.get("turn_id")):
        raise ValueError("checkpoint_scope_invalid")
    actual = mutation_reference(record)
    if action != "capture" and reference != actual:
        raise ValueError("checkpoint_prefix_changed")
    saved = record["extensions"].get("runtime_checkpoint")
    if action != "capture" and (not isinstance(binding, Mapping)
            or binding.get("mutation_ref") != actual
            or binding.get("work_id") != scope.get("work_id")):
        raise ValueError("checkpoint_binding_invalid")
    # The exact source binding is retained as a cancellation tombstone.
    if (action == "release" and saved == binding and record["state"] == "interrupted"
            and record["termination_reason"] == "turn_cancelled"):
        return
    if not settled_prefix(record) or not _completed_prefix_matches(record, completed_effects):
        raise ValueError("checkpoint_prefix_unsettled")
    if action == "capture":
        if saved is not None:
            raise ValueError("checkpoint_already_bound")
    elif action == "bind":
        _bind_checkpoint(record, saved=saved, binding=binding)
    else:
        _consume_binding(record, action=action, binding=binding)


def _bind_checkpoint(record: dict[str, Any], *, saved: Any, binding: Any) -> None:
    if saved is not None and saved != binding:
        raise ValueError("checkpoint_binding_conflict")
    consumed = record["extensions"].get("runtime_claimed_checkpoints", [])
    if len(consumed) >= _MAX_CLAIMED_BINDINGS or any(
        previous["work_id"] != binding["work_id"]
        or previous["decision_id"] == binding["decision_id"]
        or previous["source_attempt"]["stream_id"] == binding["source_attempt"]["stream_id"]
        or previous["source_attempt"]["attempt_id"] == binding["source_attempt"]["attempt_id"]
        for previous in consumed
    ):
        raise ValueError("checkpoint_binding_consumed")
    record["extensions"]["runtime_checkpoint"] = copy.deepcopy(dict(binding))
    record["extensions"].setdefault("runtime_checkpoint_phase", "preparing")


def _consume_binding(record: dict[str, Any], *, action: str, binding: Any) -> None:
    if (not settled_prefix(record)
            or record["extensions"].get("runtime_checkpoint") != binding
            or (action in {"claim", "validate"} and not has_runtime_checkpoint(record))):
        raise ValueError("checkpoint_binding_changed")
    if action == "confirm":
        record["extensions"]["runtime_checkpoint_phase"] = "confirmed"
    elif action == "claim":
        consumed = record["extensions"].setdefault("runtime_claimed_checkpoints", [])
        if len(consumed) >= _MAX_CLAIMED_BINDINGS:
            raise ValueError("checkpoint_claim_capacity")
        consumed.append(copy.deepcopy(binding))
        del record["extensions"]["runtime_checkpoint"]
        del record["extensions"]["runtime_checkpoint_phase"]
    elif action == "release":
        record["state"] = "interrupted"
        record["termination_reason"] = "turn_cancelled"
        now = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        record["wall_time"].update(updated_at=now, terminal_at=now)


def checkpoint_transition(  # noqa: PLR0913 - explicit owner identity and transition proof.
    store: Any, workspace_root: str | Path, *, action: str, scope: Mapping[str, Any],
    reference: Mapping[str, Any], binding: Mapping[str, Any] | None = None,
    completed_effects: Any = (),
) -> Any:
    """Serialize capture/bind/validate/claim/release with the existing owner locks."""
    # Local import avoids making the store's reconciliation helper cyclic.
    from sidecar.ai.tools.workspace_mutation_journal_store import _store_failure  # noqa: PLC0415
    try:
        identity = workspace_identity(workspace_root)
        workspace_id, change_set_id = reference["workspace_id"], reference["change_set_id"]
        if (identity.workspace_id != workspace_id
                or action not in {"capture", "bind", "confirm", "validate", "claim", "release"}):
            raise ValueError("checkpoint_scope_invalid")
        with store._lock(workspace_id), store._lock(workspace_id, change_set_id):
            loaded = store.load(workspace_id, change_set_id)
            if not loaded.ok or loaded.record is None:
                return loaded
            record = loaded.record
            if record["workspace"]["fingerprint"] != identity.fingerprint:
                raise ValueError("checkpoint_scope_invalid")
            _transition_record(record, action=action, scope=scope, reference=reference,
                               binding=binding, completed_effects=completed_effects)
            if action in {"capture", "validate"}:
                return loaded
            return store._write_mapping_locked(record, Path(workspace_root))
    except (OSError, ValueError, KeyError, TypeError, Timeout) as error:
        return _store_failure("journal_checkpoint_unavailable",
                              "Workspace checkpoint proof is unavailable.", (type(error).__name__,))


def checkpoint_update_forbidden(current: Mapping[str, Any], incoming: Mapping[str, Any]) -> bool:
    from sidecar.ai.tools.workspace_mutation_journal_store import (  # noqa: PLC0415 - owner cycle
        _is_retention_only_update,
    )
    prior, next_extensions = current["extensions"], incoming["extensions"]
    return (prior.get("runtime_claimed_checkpoints")
            != next_extensions.get("runtime_claimed_checkpoints")
            or prior.get("runtime_checkpoint") != next_extensions.get("runtime_checkpoint")
            or prior.get("runtime_checkpoint_phase")
            != next_extensions.get("runtime_checkpoint_phase")
            or bool(prior.get("runtime_checkpoint") and current["state"] == "in_progress"
                    and not _is_retention_only_update(current, incoming)))
