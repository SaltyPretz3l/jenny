"""Request-owned binding of a settled mutation journal to a decision checkpoint."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.tools.workspace_mutation_checkpoint import checkpoint_transition, mutation_reference
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore


def _owner(config: Any, request_context: Any) -> tuple[WorkspaceMutationJournalStore, str]:
    root = getattr(getattr(request_context, "execution_context", None), "root_path", None)
    state = getattr(config, "electron_state_root", None)
    if (not isinstance(root, str) or not Path(root).is_absolute()
            or not isinstance(state, str) or not Path(state).is_absolute()):
        raise ValueError("mutation_owner_unavailable")
    return WorkspaceMutationJournalStore(Path(state) / "workspace-recovery"), root


@dataclass(frozen=True)
class FrozenMutationCheckpoint:
    store: WorkspaceMutationJournalStore
    workspace_root: str
    scope_json: str
    reference_json: str
    effects_json: str

    def reference(self) -> dict:
        return json.loads(self.reference_json)

    def transition(self, action: str, continuation: Any, decision: dict) -> None:
        binding = {"schema_version": 1, "work_id": continuation.work_id,
                   "decision_id": decision["decision_id"],
                   "source_attempt": continuation.source_attempt.to_wire(),
                   "mutation_ref": self.reference()}
        result = checkpoint_transition(self.store, self.workspace_root, action=action,
            scope=json.loads(self.scope_json), reference=self.reference(), binding=binding,
            completed_effects=json.loads(self.effects_json))
        if not result.ok:
            raise ValueError("mutation_checkpoint_transition_failed")


def prepare_mutation_checkpoint(
    plan: Any, effects: list, config: Any
) -> FrozenMutationCheckpoint | None:
    change_set_id = getattr(plan, "change_set_id", "")
    metadata_present = any("workspace_change_set" in (getattr(item, "metadata", {}) or {})
                           for item in plan.outcomes)
    if not change_set_id:
        if metadata_present:
            raise ValueError("mutation_owner_identity_missing")
        return None
    context = plan.request_context
    continuation = context.continuation_context
    store, root = _owner(config, context)
    scope = {"work_id": continuation.work_id, "turn_id": continuation.turn_id,
             "session_id": continuation.enclosing_session_id}
    identity = workspace_identity(root)
    loaded = store.load(identity.workspace_id, change_set_id)
    if (not loaded.ok and getattr(loaded.failure, "reason", None) == "journal_not_found"
            and not metadata_present
            and not any(item.tool_name in {"write_file", "edit_file", "delete_file", "move_file"}
                        for item in plan.outcomes)):
        # Approval freezing reserves an ID before any mutation creates a journal.
        # It is not an executed effect and must not be restored as authority.
        return None
    result = checkpoint_transition(store, root, action="capture", scope=scope,
        reference={"workspace_id": identity.workspace_id, "change_set_id": change_set_id},
        completed_effects=effects)
    if not result.ok or result.record is None:
        raise ValueError("mutation_checkpoint_capture_failed")
    ref = mutation_reference(result.record)
    for outcome in plan.outcomes:
        summary = (getattr(outcome, "metadata", {}) or {}).get("workspace_change_set")
        if summary is not None and (not isinstance(summary, dict)
                or summary.get("change_set_id") != change_set_id):
            raise ValueError("mutation_outcome_owner_changed")
    return FrozenMutationCheckpoint(
        store, root, json.dumps(scope), json.dumps(ref), json.dumps(effects)
    )


def claim_mutation_checkpoint(checkpoint: dict, *, config: Any, request_context: Any) -> str:
    ref = checkpoint.get("mutation_ref")
    if ref is None:
        return ""
    store, root = _owner(config, request_context)
    binding = {"schema_version": 1, "work_id": checkpoint["identity"]["work_id"],
               "decision_id": checkpoint["decision"]["decision_id"],
               "source_attempt": checkpoint["source_attempt"], "mutation_ref": ref}
    result = checkpoint_transition(store, root, action="claim", scope=checkpoint["identity"],
        reference=ref, binding=binding, completed_effects=checkpoint["completed_effect_refs"])
    if not result.ok:
        raise ValueError("mutation_checkpoint_claim_failed")
    return ref["change_set_id"]
