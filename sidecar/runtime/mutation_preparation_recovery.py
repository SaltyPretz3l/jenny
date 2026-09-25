"""Recover only abandoned preparation pins named by the canonical work owner."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.protocol import API_VERSION

_MAX_ID_CHARS = 160


def reconcile_mutation_preparations(params: Any, config: Any) -> dict[str, Any]:
    keys = {"accept_version", "schema_version", "work_id", "session_id", "turn_id",
            "source_attempt", "workspace_root", "device_id", "inode"}
    if (not isinstance(params, dict) or set(params) != keys
            or params["accept_version"] != API_VERSION
            or type(params["schema_version"]) is not int or params["schema_version"] != 1):
        raise ValueError("mutation_preparation_invalid")
    attempt = params["source_attempt"]
    if (not isinstance(attempt, dict) or set(attempt) != {
            "attempt_id", "stream_id", "incarnation", "authority_revision"}
            or any(not isinstance(value, str) or not 1 <= len(value) <= _MAX_ID_CHARS
                   for value in [*attempt.values(), params["work_id"],
                                 params["session_id"], params["turn_id"]])):
        raise ValueError("mutation_preparation_identity_invalid")
    root, state_root = params["workspace_root"], getattr(config, "electron_state_root", None)
    if (not isinstance(root, str) or not isinstance(state_root, str)
            or not Path(root).is_absolute() or not Path(state_root).is_absolute()):
        raise ValueError("mutation_preparation_owner_unavailable")
    identity = workspace_identity(root)
    if identity.device_id != params["device_id"] or identity.file_id != params["inode"]:
        raise ValueError("mutation_preparation_workspace_changed")
    store = WorkspaceMutationJournalStore(Path(state_root) / "workspace-recovery")
    interrupted = 0
    with store._lock(identity.workspace_id):
        for entry in store._scan_workspace(identity.workspace_id):
            with store._lock(identity.workspace_id, entry.change_set_id):
                loaded = store.load(identity.workspace_id, entry.change_set_id)
                if not loaded.ok or loaded.record is None:
                    raise ValueError("mutation_preparation_inventory_unavailable")
                record = loaded.record
                binding = record["extensions"].get("runtime_checkpoint")
                if (record["state"] != "in_progress" or not binding
                        or record["extensions"].get("runtime_checkpoint_phase") == "confirmed"
                        or binding["work_id"] != params["work_id"]
                        or binding["source_attempt"] != attempt
                        or record["session_id"] != params["session_id"]
                        or record["turn_id"] != params["turn_id"]):
                    continue
                if record["workspace"]["fingerprint"] != identity.fingerprint:
                    raise ValueError("mutation_preparation_workspace_changed")
                recovered = store._reconcile_record(record, Path(root))
                if not store._write_mapping_locked(recovered, Path(root)).ok:
                    raise ValueError("mutation_preparation_recovery_unconfirmed")
                interrupted += 1
    return {"schema_version": 1, "status": "reconciled", "interrupted": interrupted}
