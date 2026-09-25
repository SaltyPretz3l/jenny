"""Closed application-only cancellation of a checkpoint-bound mutation journal."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from sidecar.ai.tools.workspace_mutation_checkpoint import checkpoint_transition
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.runtime.continuation_codec import encode_continuation_checkpoint


def release_mutation_checkpoint(
    params: Any, config: Any, *, confirm_published: bool = False,
) -> dict[str, Any]:
    if (not isinstance(params, dict) or set(params) != {"accept_version", "schema_version",
            "checkpoint", "workspace_root", "device_id", "inode"}
            or type(params["schema_version"]) is not int or params["schema_version"] != 1):
        raise ValueError("mutation_release_invalid")
    checkpoint = params["checkpoint"]
    encode_continuation_checkpoint(checkpoint)
    if checkpoint["kind"] != "before_decision_wait" or "mutation_ref" not in checkpoint:
        raise ValueError("mutation_release_invalid")
    root = params["workspace_root"]
    if not isinstance(root, str) or not Path(root).is_absolute():
        raise ValueError("mutation_release_workspace_invalid")
    identity = workspace_identity(root)
    if identity.device_id != params["device_id"] or identity.file_id != params["inode"]:
        raise ValueError("mutation_release_workspace_changed")
    state_root = getattr(config, "electron_state_root", "")
    if not isinstance(state_root, str) or not state_root or not Path(state_root).is_absolute():
        raise ValueError("mutation_release_owner_unavailable")
    binding = {"schema_version": 1, "work_id": checkpoint["identity"]["work_id"],
               "decision_id": checkpoint["decision"]["decision_id"],
               "source_attempt": checkpoint["source_attempt"],
               "mutation_ref": checkpoint["mutation_ref"]}
    store = WorkspaceMutationJournalStore(Path(state_root) / "workspace-recovery")
    result = checkpoint_transition(store,
        root, action="confirm" if confirm_published else "release", scope=checkpoint["identity"],
        reference=checkpoint["mutation_ref"],
        binding=binding, completed_effects=checkpoint["completed_effect_refs"])
    if not result.ok:
        raise ValueError("mutation_release_unproven")
    return {"schema_version": 1, "status": "confirmed" if confirm_published else "released",
            "binding": binding}
