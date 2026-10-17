"""Approval terminal cleanup through the dispatcher and durable Undo boundary."""
from __future__ import annotations

import logging
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from sidecar.ai.routing.mutation_change_set_lifecycle import (
    MutationChangeSetLifecycle,
    bind_run_context,
    finish_run_change_set,
    release_run_context,
)
from sidecar.ai.tools import workspace_mutation_live_owner as live
from sidecar.ai.tools.builtins.filesystem import write_file_tool
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_restore import preflight_undo, undo_change_set
from sidecar.protocol import API_VERSION
from sidecar.runtime import request_dispatch as rd
from sidecar.runtime.approval import ApprovalResolution
from sidecar.runtime.approval_plan_cache import ApprovalPlanCache

CHANGE_SET = "01990f9a-8c51-7ad2-a8be-41190e0e1f21"


def _paused_edit(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config = SimpleNamespace(electron_state_root=str(tmp_path / "state"),
        tools_workspace_root=str(workspace), agent_workspace_root=None, tools_enabled=True,
        feature_flags={}, max_tools_per_turn=20, cloud_max_tools_per_turn=200)
    context = SimpleNamespace(logical_turn_id="turn", execution_context=None)
    run = SimpleNamespace(request_id="request", logical_turn_id="turn", session_id="session",
        request_context=context, kernel=SimpleNamespace(_config=config), outcomes=[],
        _jenny_change_set_id=CHANGE_SET)
    store = WorkspaceMutationJournalStore(tmp_path / "state" / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    bind_run_context(run)
    write_file_tool({"file_path": "effect.txt", "file_content": "effect",
        "_jenny_session_id": "session", "_jenny_turn_id": "turn",
        "_jenny_tool_call_id": "first", "_jenny_change_set_id": CHANGE_SET},
        WorkspaceGuard(str(workspace), mutation_journal=lifecycle))
    finish_run_change_set(run, approval_paused=True, reason="approval_required")
    plan = SimpleNamespace(request_id="request", call_id="second", session_id="session",
        request_context=context, change_set_id=CHANGE_SET, outcomes=(), approval_plan_hash="hash")
    return workspace, store, config, run, plan


@pytest.mark.parametrize("status", ["denied", "timeout", "cancelled", "wait_error", "resume_error"])
def test_approval_terminal_after_edit_settles_and_allows_undo(tmp_path, monkeypatch, status):
    workspace, store, config, _run, plan = _paused_edit(tmp_path)
    path = store.live_owner_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
    response = SimpleNamespace(request_id="request", result={"status": "awaiting_approval"},
        notifications=[], approval_plan=plan, post_settlement_callback=None,
        approval_request={"tool_call_id": "second", "tool_name": "edit_file", "reason": "edit"})
    monkeypatch.setattr(rd, "_APPROVAL_PLAN_CACHE", ApprovalPlanCache())
    responses = [response]
    def build(**_kwargs):
        if not responses:
            raise RuntimeError("resume failed before binding")
        return responses.pop()
    def resolve(*_args, **_kwargs):
        if status == "wait_error":
            raise RuntimeError("approval waiter failed")
        return ApprovalResolution(approved=status == "resume_error",
                                  status="approved" if status == "resume_error" else status)
    monkeypatch.setattr(rd, "_build_chat_response", build)
    monkeypatch.setattr(rd, "request_tool_approval", resolve)
    monkeypatch.setattr("sidecar.runtime.request_dispatch_chat._credit_approval_wait",
                        lambda plan, _seconds: plan)
    monkeypatch.setattr("sidecar.runtime.request_dispatch_chat._effective_approval_wait_timeout",
        lambda *_args, **_kwargs: 30.0)
    brain = SimpleNamespace(stack=SimpleNamespace(config=config, engine=None, tool_observations=None),
        request_boundary=lambda *_args, **_kwargs: nullcontext())
    try:
        def dispatch():
            return rd.process_chat_send_request(message_id=1,
            params={"accept_version": API_VERSION, "request_id": "request", "session_id": "session"},
            initialized=True, interactive_approval=True, brain_container=brain,
            logger=logging.getLogger(__name__), write_message=lambda _message: None,
            read_message=lambda: {})
        if status == "wait_error":
            with pytest.raises(RuntimeError, match="waiter failed"):
                dispatch()
        else:
            outcome = dispatch()
            if status == "resume_error":
                assert "error" in outcome.response
            else:
                assert outcome.response["result"]["status"] == status
        with live.recovery_ownership(path) as abandoned:
            assert abandoned
        assert store.load(workspace_identity(workspace).workspace_id, CHANGE_SET).record["state"] == "interrupted"
        assert preflight_undo(store, workspace, CHANGE_SET)["conflicts"] == []
        assert undo_change_set(store, workspace, CHANGE_SET)["status"] == "committed"
        assert not (workspace / "effect.txt").exists()
    finally:
        live.release_live_owner(path, session_id="session", turn_id="turn")
        release_run_context(_run)


@pytest.mark.parametrize("failure", ["result", "exception"])
def test_finalization_failure_releases_owner_and_lazy_undo_recovers(tmp_path, monkeypatch, failure):
    from sidecar.ai.tools.workspace_mutation_journal_store import StoreResult
    workspace, store, _config, run, _plan = _paused_edit(tmp_path)
    original = MutationChangeSetLifecycle.finalize
    def fail(*_args, **_kwargs):
        if failure == "exception":
            raise OSError("failed durability")
        return StoreResult(ok=False)
    monkeypatch.setattr(MutationChangeSetLifecycle, "finalize", fail)
    if failure == "exception":
        with pytest.raises(OSError):
            finish_run_change_set(run, approval_paused=False, reason="done")
    else:
        finish_run_change_set(run, approval_paused=False, reason="done")
    path = store.live_owner_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
    with live.recovery_ownership(path) as abandoned:
        assert abandoned
    monkeypatch.setattr(MutationChangeSetLifecycle, "finalize", original)
    assert preflight_undo(store, workspace, CHANGE_SET)["conflicts"] == []
    assert undo_change_set(store, workspace, CHANGE_SET)["status"] == "committed"


def test_settlement_on_another_request_thread_releases_identity(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    workspace, store, _config, run, _plan = _paused_edit(tmp_path)
    # Retain a token from this thread while the other thread settles the run.
    bind_run_context(run)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(finish_run_change_set, run, approval_paused=False, reason="done").result()
        path = store.live_owner_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
        with live.recovery_ownership(path) as abandoned:
            assert abandoned
        assert preflight_undo(store, workspace, CHANGE_SET)["conflicts"] == []
    finally:
        release_run_context(run)


@pytest.mark.parametrize("removal", ["expired", "global", "session", "bytes"])
def test_cache_discard_settles_prior_edit(tmp_path, removal):
    from sidecar.ai.routing.mutation_run_settlement import discard_approval_mutations
    workspace, store, config, _run, plan = _paused_edit(tmp_path)
    now = [0.0]
    cache = ApprovalPlanCache(now_fn=lambda: now[0], max_entries=1 if removal == "global" else 4,
        max_session_entries=1 if removal == "session" else 4,
        max_bytes=1 if removal == "bytes" else 4, size_fn=lambda _: 1)
    cache.put(plan, ttl_seconds=60, on_discard=lambda: discard_approval_mutations(plan, config=config))
    if removal == "expired":
        now[0] = 61
        assert cache.consume("request", "second") is None
    else:
        cache.put(SimpleNamespace(request_id="other", call_id="other",
            session_id="session"), ttl_seconds=60)
    assert store.load(workspace_identity(workspace).workspace_id, CHANGE_SET).record["state"] == "interrupted"
    assert preflight_undo(store, workspace, CHANGE_SET)["conflicts"] == []


def test_expired_plan_transfers_for_checkpoint_without_discarding(tmp_path):
    workspace, store, _config, run, plan = _paused_edit(tmp_path)
    now = [0.0]
    cache = ApprovalPlanCache(now_fn=lambda: now[0])
    cache.put(plan, ttl_seconds=60, on_discard=lambda: pytest.fail("handoff discarded"))
    now[0] = 61
    assert cache.take_for_handoff("request", "second") is plan
    path = store.live_owner_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
    with live.recovery_ownership(path) as abandoned:
        assert not abandoned
    finish_run_change_set(run, approval_paused=False, reason="cancel")


def test_runtime_kernel_binding_establishes_profile_owner(tmp_path):
    workspace, store, config, run, _plan = _paused_edit(tmp_path)
    run.kernel = None
    bind_run_context(run, kernel=SimpleNamespace(_config=config))
    assert run._jenny_mutation_kernel._config is config
    finish_run_change_set(run, approval_paused=False, reason="done")
    assert store.load(workspace_identity(workspace).workspace_id, CHANGE_SET).record["state"] == "committed"


def test_timeout_extension_transfers_expired_plan_without_settlement(tmp_path):
    from sidecar.ai.routing.mutation_run_settlement import discard_approval_mutations
    workspace, store, config, run, plan = _paused_edit(tmp_path)
    now = [0.0]
    cache = ApprovalPlanCache(now_fn=lambda: now[0])
    cache.put(plan, ttl_seconds=60, on_discard=lambda: discard_approval_mutations(plan, config=config))
    now[0] = 61
    cache.put(plan, ttl_seconds=600)
    assert store.load(workspace_identity(workspace).workspace_id, CHANGE_SET).record["state"] == "in_progress"
    now[0] = 662
    assert cache.consume("request", "second") is None
    assert store.load(workspace_identity(workspace).workspace_id, CHANGE_SET).record["state"] == "interrupted"


@pytest.mark.parametrize("discard", [False, True])
def test_missing_workspace_still_releases_exact_held_owner(tmp_path, discard):
    from sidecar.ai.routing.mutation_run_settlement import discard_approval_mutations
    workspace, store, config, run, plan = _paused_edit(tmp_path)
    path = store.live_owner_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
    before = store.journal_path(path.parent.parent.name, CHANGE_SET).read_bytes()
    workspace.rename(tmp_path / "moved-workspace")
    if discard:
        discard_approval_mutations(plan, config=config)
    else:
        with pytest.raises(FileNotFoundError):
            finish_run_change_set(run, approval_paused=False, reason="done")
    with live.recovery_ownership(path) as abandoned:
        assert abandoned
    assert store.journal_path(path.parent.parent.name, CHANGE_SET).read_bytes() == before


def test_held_owner_lookup_requires_full_scope(tmp_path):
    workspace, store, _config, run, _plan = _paused_edit(tmp_path)
    path = store.live_owner_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
    try:
        assert live.held_owner_path(store.version_root, CHANGE_SET,
            session_id="session", turn_id="turn") == path
        for profile, change_set, session, turn in [
            (store.version_root.parent / "other-profile/v1", CHANGE_SET, "session", "turn"),
            (store.version_root, "other-change-set", "session", "turn"),
            (store.version_root, CHANGE_SET, "other-session", "turn"),
            (store.version_root, CHANGE_SET, "session", "other-turn"),
        ]:
            assert live.held_owner_path(profile, change_set, session_id=session, turn_id=turn) is None
    finally:
        finish_run_change_set(run, approval_paused=False, reason="done")
