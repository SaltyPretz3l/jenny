from __future__ import annotations

import copy

import pytest

from sidecar.ai.tools.workspace_mutation_checkpoint import (
    checkpoint_transition,
    has_runtime_checkpoint,
    mutation_reference,
)
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from tests.sidecar.ai.tools.test_workspace_mutation_journal import _create_record


@pytest.fixture
def pinned(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    record = _create_record(workspace, 1, state="in_progress", operation_status="applied")
    assert store.write_transition(record, workspace_root=workspace).ok
    reference = mutation_reference(record)
    binding = {"schema_version": 1, "work_id": "work_1", "decision_id": "decision_1",
               "source_attempt": {"attempt_id": "attempt_1", "stream_id": "stream_1",
                                  "incarnation": "incarnation_1", "authority_revision": "authority_1"},
               "mutation_ref": reference}
    scope = {"session_id": record["session_id"], "turn_id": record["turn_id"], "work_id": "work_1"}
    effects = [{"call_id": "call_1", "tool_id": "write_file"}]
    def transition(action, **patch):
        return checkpoint_transition(store, workspace, action=action,
            **{**dict(scope=scope, reference=reference, binding=binding, completed_effects=effects), **patch})
    return store, workspace, record, reference, binding, transition


def test_pin_survives_restart_and_claim_restores_ordinary_crash_recovery(pinned):
    store, workspace, record, reference, _binding, transition = pinned
    assert transition("capture").ok
    assert transition("bind").ok
    assert transition("confirm").ok
    assert transition("bind").ok
    assert transition("confirm").ok
    restarted = WorkspaceMutationJournalStore.from_version_root(store.version_root)
    restored = restarted.reconcile_workspace(workspace)
    assert len(restored) == 1 and restored[0].ok
    assert has_runtime_checkpoint(restored[0].record)
    assert mutation_reference(restored[0].record) == reference
    assert transition("validate").ok
    assert transition("claim").ok
    assert not transition("claim").ok
    assert not transition("validate").ok
    recovered = restarted.reconcile_workspace(workspace)
    assert recovered[0].record["state"] == "interrupted"
    assert record["operations"][0]["status"] == "applied"


def test_retention_is_mutable_but_effects_and_pin_are_not(pinned):
    store, workspace, _record, reference, _binding, transition = pinned
    assert transition("bind").ok
    assert transition("confirm").ok
    saved = store.load(reference["workspace_id"], reference["change_set_id"]).record
    retained = copy.deepcopy(saved)
    retained["retention"]["last_accessed_active_use_seconds"] += 4
    assert store.write_transition(retained, workspace_root=workspace, retention_only=True).ok
    assert transition("validate").ok
    for patch in ("effect", "state", "binding", "protection"):
        changed = copy.deepcopy(retained)
        if patch == "effect":
            changed["operations"][0]["diagnostic_code"] = "changed"
        elif patch == "state":
            changed["state"] = "interrupted"
        elif patch == "binding":
            changed["extensions"] = {}
        else:
            changed["retention"]["protected"] = False
        assert not store.write_transition(changed, workspace_root=workspace).ok


def test_release_is_idempotent_and_prevents_any_future_claim(pinned):
    store, _workspace, _record, reference, binding, transition = pinned
    assert transition("bind").ok
    assert transition("confirm").ok
    assert transition("release").ok
    assert transition("release").ok
    assert not transition("claim").ok
    assert not transition("validate").ok
    assert not transition("release", binding={**binding, "decision_id": "foreign"}).ok
    record = store.load(reference["workspace_id"], reference["change_set_id"]).record
    assert record["state"] == "interrupted"
    assert record["retention"]["protected"] is True
    assert record["operations"][0]["status"] == "applied"


@pytest.mark.parametrize("field", ["session_id", "turn_id", "work_id"])
def test_foreign_scope_cannot_bind_or_claim(pinned, field):
    _store, _workspace, record, _reference, _binding, transition = pinned
    scope = {"session_id": record["session_id"], "turn_id": record["turn_id"], "work_id": "work_1"}
    assert transition("bind").ok
    assert transition("confirm").ok
    scope[field] = "foreign"
    assert not transition("validate", scope=scope).ok
    assert not transition("claim", scope=scope).ok


@pytest.mark.parametrize("status", ["planned", "applying", "unknown", "conflict"])
def test_uncertain_operations_cannot_be_pinned(pinned, status):
    store, workspace, record, _reference, _binding, transition = pinned
    record["operations"][0]["status"] = status
    record["completed_sequences"] = []
    assert store.write_transition(record, workspace_root=workspace).ok
    assert not transition("capture").ok


def test_skipped_effect_is_preserved_even_when_tool_failed(pinned):
    store, workspace, record, _reference, binding, transition = pinned
    record["operations"][0]["status"] = "skipped"
    record["completed_sequences"] = []
    assert store.write_transition(record, workspace_root=workspace).ok
    ref = mutation_reference(record)
    assert transition("bind", reference=ref, binding={**binding, "mutation_ref": ref},
                      completed_effects=[{"call_id": "call_1", "tool_id": "write_file", "success": False}]).ok


def test_canonical_call_coverage_and_exact_ref_are_required(pinned):
    _store, _workspace, _record, reference, _binding, transition = pinned
    for effects in ([], [{"call_id": "foreign", "tool_id": "write_file"}],
                    [{"call_id": "call_1", "tool_id": "edit_file"}],
                    [{"call_id": "call_1", "tool_id": "write_file"}] * 2):
        assert not transition("capture", completed_effects=effects).ok
    assert not transition("bind", reference={**reference, "operations_sha256": "a" * 64}).ok


def test_corrupt_owner_never_proves_a_checkpoint(pinned):
    store, _workspace, _record, reference, _binding, transition = pinned
    assert transition("bind").ok
    assert transition("confirm").ok
    target = store.journal_path(reference["workspace_id"], reference["change_set_id"])
    target.write_text("{}")
    assert not transition("validate").ok
    assert not transition("release").ok


def test_claimed_bindings_cannot_be_resurrected_even_after_newer_claims(pinned):
    store, workspace, _record, reference, binding, transition = pinned
    assert transition("bind").ok
    assert transition("confirm").ok
    assert transition("claim").ok
    assert not transition("bind").ok
    fresh = {**binding, "decision_id": "decision_2", "source_attempt": {
        **binding["source_attempt"], "stream_id": "stream_2", "attempt_id": "attempt_2"}}
    assert transition("capture").ok
    assert transition("bind", binding=fresh).ok
    assert transition("confirm", binding=fresh).ok
    assert transition("claim", binding=fresh).ok
    assert not transition("bind").ok
    assert not transition("bind", binding=fresh).ok
    stale = store.load(reference["workspace_id"], reference["change_set_id"]).record
    del stale["extensions"]["runtime_claimed_checkpoints"]
    assert not store.write_transition(stale, workspace_root=workspace).ok


def test_unconfirmed_pin_waits_for_application_publication_reconciliation(pinned):
    store, workspace, _record, reference, _binding, transition = pinned
    assert transition("bind").ok
    assert not transition("claim").ok
    assert not transition("validate").ok
    recovered = store.reconcile_workspace(workspace)
    assert recovered[0].ok
    assert recovered[0].record["state"] == "in_progress"
    assert recovered[0].record["extensions"]["runtime_checkpoint_phase"] == "preparing"
    assert recovered[0].record["retention"]["protected"] is True
    assert transition("confirm").ok
    assert recovered[0].record["extensions"]["runtime_checkpoint"]["mutation_ref"] == reference


@pytest.mark.parametrize("confirmed", [False, True])
def test_application_reconciliation_targets_only_abandoned_preparation(pinned, confirmed):
    from types import SimpleNamespace

    from sidecar.runtime.mutation_preparation_recovery import reconcile_mutation_preparations
    store, workspace, record, reference, binding, transition = pinned
    # This fixture's store root is arbitrary; derive the normal profile owner.
    profile = workspace.parent / "profile"
    owner = WorkspaceMutationJournalStore(profile / "workspace-recovery")
    assert owner.write_transition(record, workspace_root=workspace).ok
    scope = {"work_id": binding["work_id"], "session_id": record["session_id"],
             "turn_id": record["turn_id"]}
    for action in (["bind", "confirm"] if confirmed else ["bind"]):
        assert checkpoint_transition(owner, workspace, action=action, scope=scope,
            reference=reference, binding=binding,
            completed_effects=[{"call_id": "call_1", "tool_id": "write_file"}]).ok
    params = {"schema_version": 1, "accept_version": "2026-10-15", **scope,
              "source_attempt": binding["source_attempt"], "workspace_root": str(workspace),
              "device_id": record["workspace"]["device_id"], "inode": record["workspace"]["file_id"]}
    config = SimpleNamespace(electron_state_root=str(profile), tools_workspace_root=None)
    from sidecar.ai.tools import workspace_mutation_live_owner as live
    path = owner.live_owner_path(reference["workspace_id"], reference["change_set_id"])
    before = owner.journal_path(reference["workspace_id"], reference["change_set_id"]).read_bytes()
    live.acquire_live_owner(path, session_id=record["session_id"], turn_id=record["turn_id"])
    try:
        assert reconcile_mutation_preparations(params, config)["interrupted"] == 0
        assert owner.journal_path(reference["workspace_id"], reference["change_set_id"]).read_bytes() == before
    finally:
        live.release_live_owner(path, session_id=record["session_id"], turn_id=record["turn_id"])
    foreign = {**params, "source_attempt": {**binding["source_attempt"], "attempt_id": "other"}}
    assert reconcile_mutation_preparations(foreign, config)["interrupted"] == 0
    assert reconcile_mutation_preparations(params, config)["interrupted"] == int(not confirmed)
    saved = owner.load(reference["workspace_id"], reference["change_set_id"]).record
    assert saved["state"] == ("in_progress" if confirmed else "interrupted")
    assert saved["extensions"]["runtime_checkpoint"] == binding
    assert saved["retention"]["protected"] is True


@pytest.mark.parametrize("confirmed", [False, True])
def test_discard_never_writes_a_runtime_checkpoint(pinned, confirmed, monkeypatch):
    from types import SimpleNamespace

    from sidecar.ai.routing.mutation_run_settlement import discard_approval_mutations
    from sidecar.ai.tools import workspace_mutation_live_owner as live
    store, workspace, record, ref, _binding, transition = pinned
    assert transition("bind").ok
    if confirmed:
        assert transition("confirm").ok
    path = store.live_owner_path(ref["workspace_id"], ref["change_set_id"])
    live.acquire_live_owner(path, session_id=record["session_id"], turn_id=record["turn_id"])
    monkeypatch.setattr("sidecar.ai.routing.mutation_run_settlement.run_journal_owner",
                        lambda _run: (store, str(workspace)))
    plan = SimpleNamespace(change_set_id=ref["change_set_id"], session_id=record["session_id"],
        request_id=record["turn_id"], request_context=None, outcomes=[])
    before = store.journal_path(ref["workspace_id"], ref["change_set_id"]).read_bytes()
    try:
        discard_approval_mutations(plan, config=None)
        assert store.journal_path(ref["workspace_id"], ref["change_set_id"]).read_bytes() == before
        with live.recovery_ownership(path) as abandoned:
            assert not abandoned
    finally:
        live.release_live_owner(path, session_id=record["session_id"], turn_id=record["turn_id"])


def test_runtime_prepare_confirm_claim_uses_same_owner(pinned, monkeypatch):
    from types import SimpleNamespace

    from sidecar.ai.tools import workspace_mutation_live_owner as live
    from sidecar.runtime import mutation_continuation as continuation
    store, workspace, record, ref, binding, _transition = pinned
    monkeypatch.setattr(continuation, "_owner", lambda *_: (store, str(workspace)))
    context = SimpleNamespace(continuation_context=SimpleNamespace(work_id=binding["work_id"],
        turn_id=record["turn_id"], enclosing_session_id=record["session_id"]))
    plan = SimpleNamespace(change_set_id=ref["change_set_id"], request_context=context, outcomes=[])
    effects = [{"call_id": "call_1", "tool_id": "write_file"}]
    path = store.live_owner_path(ref["workspace_id"], ref["change_set_id"])
    live.acquire_live_owner(path, session_id=record["session_id"], turn_id=record["turn_id"])
    frozen = continuation.prepare_mutation_checkpoint(plan, effects, config=None)
    attempt = SimpleNamespace(to_wire=lambda: binding["source_attempt"])
    owner = SimpleNamespace(work_id=binding["work_id"], source_attempt=attempt)
    decision = {"decision_id": binding["decision_id"]}
    frozen.transition("bind", owner, decision)
    frozen.transition("confirm", owner, decision)
    with live.recovery_ownership(path) as abandoned:
        assert abandoned
    checkpoint = {"identity": {"work_id": binding["work_id"], "session_id": record["session_id"],
        "turn_id": record["turn_id"]}, "decision": decision, "source_attempt": binding["source_attempt"],
        "mutation_ref": frozen.reference(), "completed_effect_refs": effects}
    assert continuation.claim_mutation_checkpoint(checkpoint, config=None, request_context=context) == ref["change_set_id"]
    with live.recovery_ownership(path) as abandoned:
        assert not abandoned
    live.release_live_owner(path, session_id=record["session_id"], turn_id=record["turn_id"])


def test_claim_contention_is_bounded_typed_and_path_free(pinned, monkeypatch):
    import time
    from types import SimpleNamespace

    from filelock import FileLock, Timeout

    from sidecar.ai.tools import workspace_mutation_live_owner as live
    from sidecar.ai.tools.contracts import ToolExecutionFailure
    from sidecar.runtime import mutation_continuation as continuation
    store, workspace, record, ref, binding, transition = pinned
    assert transition("bind").ok and transition("confirm").ok
    monkeypatch.setattr(continuation, "_owner", lambda *_: (store, str(workspace)))
    path = store.live_owner_path(ref["workspace_id"], ref["change_set_id"])
    checkpoint = {"identity": {"work_id": binding["work_id"], "session_id": record["session_id"],
        "turn_id": record["turn_id"]}, "decision": {"decision_id": binding["decision_id"]},
        "source_attempt": binding["source_attempt"], "mutation_ref": ref,
        "completed_effect_refs": [{"call_id": "call_1", "tool_id": "write_file"}]}
    before = store.journal_path(ref["workspace_id"], ref["change_set_id"]).read_bytes()
    with FileLock(str(path)):
        with pytest.raises(Timeout):
            live.acquire_live_owner(path, session_id=record["session_id"], turn_id=record["turn_id"])
        started = time.monotonic()
        with pytest.raises(ToolExecutionFailure) as caught:
            continuation.claim_mutation_checkpoint(checkpoint, config=None, request_context=SimpleNamespace())
        assert time.monotonic() - started >= 0.9
        assert str(path) not in str(caught.value)
        assert caught.value.message == "mutation_checkpoint_claim_failed"
        assert caught.value.to_error_data()["effects"] == "none"
        assert store.journal_path(ref["workspace_id"], ref["change_set_id"]).read_bytes() == before
