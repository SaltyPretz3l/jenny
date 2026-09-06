from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.mcp.builtin_server import BuiltinTool, _prepare_call_arguments
from sidecar.ai.routing import mutation_change_set_lifecycle as lifecycle_module
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.mutation_change_set_lifecycle import (
    MutationChangeSetLifecycle,
    bind_run_context,
    finish_run_change_set,
    freeze_approval_tool_calls,
    inject_tool_attribution,
)
from sidecar.ai.routing.tool_execution_snapshots import freeze_effective_execution_inputs
from sidecar.ai.routing.tool_loop import run_tool_loop
from sidecar.ai.tools.builtins.file_history import create_checkpoint
from sidecar.ai.tools.builtins.filesystem import write_file_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import (
    parse_record_bytes,
    workspace_identity,
)
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_restore import preflight_undo
from sidecar.runtime.approval_plan import build_approval_plan
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle

CHANGE_SET_ID = "01990f9a-8c51-7ad2-a8be-41190e0e1f21"


def _arguments(call_id: str = "call-one") -> dict[str, object]:
    return {
        "_jenny_session_id": "session-one",
        "_jenny_turn_id": "turn-one",
        "_jenny_tool_call_id": call_id,
        "_jenny_change_set_id": CHANGE_SET_ID,
    }


def _lifecycle(
    tmp_path: Path, **store_options: object
) -> tuple[Path, WorkspaceMutationJournalStore, MutationChangeSetLifecycle]:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = WorkspaceMutationJournalStore(tmp_path / "recovery", **store_options)
    return workspace, store, MutationChangeSetLifecycle(store, workspace)


def test_one_turn_one_set_terminal_commit_and_cancellation(tmp_path: Path) -> None:
    workspace, store, lifecycle = _lifecycle(tmp_path)
    first = lifecycle.prepare_file_change(
        _arguments("call-one"),
        tool_name="write_file",
        target=workspace / "one.txt",
        relative_path="one.txt",
        new_bytes=b"one",
        checkpoint=None,
    )
    (workspace / "one.txt").write_bytes(b"one")
    lifecycle.mark_applied(first)
    second = lifecycle.prepare_file_change(
        _arguments("call-two"),
        tool_name="write_file",
        target=workspace / "two.txt",
        relative_path="two.txt",
        new_bytes=b"two",
        checkpoint=None,
    )
    (workspace / "two.txt").write_bytes(b"two")
    lifecycle.mark_applied(second)

    committed = lifecycle.finalize(CHANGE_SET_ID)

    assert committed.ok is True
    assert committed.record["state"] == "committed"
    assert committed.record["completed_sequences"] == [1, 2]

    other_id = "01990f9a-8c51-7ad2-a8be-41190e0e1f22"
    interrupted_args = {**_arguments("call-three"), "_jenny_change_set_id": other_id}
    pending = lifecycle.prepare_file_change(
        interrupted_args,
        tool_name="write_file",
        target=workspace / "pending.txt",
        relative_path="pending.txt",
        new_bytes=b"pending",
        checkpoint=None,
    )
    cancelled = lifecycle.finalize(pending.change_set_id, interrupted=True)
    assert cancelled.record["state"] == "interrupted"
    assert cancelled.record["termination_reason"] == "turn_cancelled"


def test_wall_clock_review_due_at_uses_the_store_clock(tmp_path: Path) -> None:
    observed_at = datetime(2030, 1, 2, 3, 4, 5, 678000, tzinfo=UTC)
    workspace, store, lifecycle = _lifecycle(
        tmp_path, now_provider=lambda: observed_at
    )

    lifecycle.prepare_file_change(
        _arguments(),
        tool_name="write_file",
        target=workspace / "clock.txt",
        relative_path="clock.txt",
        new_bytes=b"clock",
        checkpoint=None,
    )

    record = store.load(workspace_identity(workspace).workspace_id, CHANGE_SET_ID).record
    assert record["wall_time"]["prepared_at"] == "2030-01-02T03:04:05.678Z"
    assert record["retention"]["wall_clock_review_due_at"] == "2031-01-02T03:04:05.678Z"


def test_real_run_settlement_commits_the_open_change_set(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_root = tmp_path / "electron-state"
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    prepared = lifecycle.prepare_file_change(
        _arguments("call-terminal"),
        tool_name="write_file",
        target=workspace / "settled.txt",
        relative_path="settled.txt",
        new_bytes=b"settled",
        checkpoint=None,
    )
    (workspace / "settled.txt").write_bytes(b"settled")
    lifecycle.mark_applied(prepared)
    run = SimpleNamespace(
        request_id="turn-one",
        session_id="session-one",
        kernel=SimpleNamespace(
            _config=SimpleNamespace(
                electron_state_root=str(state_root),
                tools_workspace_root=str(workspace),
            )
        ),
        runtime=SimpleNamespace(cancel_handle=SimpleNamespace(cancelled=False)),
        outcomes=[SimpleNamespace(success=True)],
        _jenny_change_set_id=CHANGE_SET_ID,
    )
    bind_run_context(run)

    finish_run_change_set(run, approval_paused=False, reason="final_response")

    identity = workspace_identity(workspace)
    settled = store.load(identity.workspace_id, CHANGE_SET_ID)
    assert settled.ok is True
    assert settled.record["state"] == "committed"
    assert settled.record["termination_reason"] == "turn_completed"


def test_preset_run_change_set_is_reused_and_finalized_after_approval_resume(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_root = tmp_path / "electron-state"
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    prepared = lifecycle.prepare_file_change(
        _arguments("approved-call"),
        tool_name="write_file",
        target=workspace / "approved.txt",
        relative_path="approved.txt",
        new_bytes=b"approved",
        checkpoint=None,
    )
    (workspace / "approved.txt").write_bytes(b"approved")
    lifecycle.mark_applied(prepared)
    run = SimpleNamespace(
        request_id="turn-one",
        session_id="session-one",
        kernel=SimpleNamespace(
            _config=SimpleNamespace(
                electron_state_root=str(state_root),
                tools_workspace_root=str(workspace),
            )
        ),
        runtime=SimpleNamespace(cancel_handle=SimpleNamespace(cancelled=False)),
        outcomes=[SimpleNamespace(success=True)],
        _jenny_change_set_id=CHANGE_SET_ID,
    )
    bind_run_context(run)

    attribution = inject_tool_attribution(
        tool_name="write_file",
        tool_call_id="continuation-call",
        session_id="session-one",
        explicit_turn_id="turn-one",
    )
    finish_run_change_set(run, approval_paused=False, reason="final_response")

    assert attribution["_jenny_change_set_id"] == CHANGE_SET_ID
    record = store.load(workspace_identity(workspace).workspace_id, CHANGE_SET_ID).record
    assert record is not None
    assert record["state"] == "committed"


def test_supplied_change_set_for_another_session_is_ignored(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_root = tmp_path / "electron-state"
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    lifecycle.prepare_file_change(
        _arguments("foreign-call"),
        tool_name="write_file",
        target=workspace / "foreign.txt",
        relative_path="foreign.txt",
        new_bytes=b"foreign",
        checkpoint=None,
    )
    run = SimpleNamespace(
        request_id="turn-two",
        session_id="session-two",
        kernel=SimpleNamespace(
            _config=SimpleNamespace(
                electron_state_root=str(state_root),
                tools_workspace_root=str(workspace),
            )
        ),
    )
    bind_run_context(run)

    attribution = inject_tool_attribution(
        tool_name="write_file",
        tool_call_id="new-call",
        session_id="session-two",
        explicit_turn_id="turn-two",
        existing={"_jenny_change_set_id": CHANGE_SET_ID},
    )
    finish_run_change_set(run, approval_paused=True, reason="approval_required")

    assert attribution["_jenny_change_set_id"] != CHANGE_SET_ID


def test_model_attribution_cannot_hijack_another_turn_and_resume_keeps_new_set(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_root = tmp_path / "electron-state"
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    foreign = lifecycle.prepare_file_change(
        _arguments("foreign-call"),
        tool_name="write_file",
        target=workspace / "foreign.txt",
        relative_path="foreign.txt",
        new_bytes=b"foreign",
        checkpoint=None,
    )
    before = store.load(workspace_identity(workspace).workspace_id, CHANGE_SET_ID).record
    assert before is not None
    run = SimpleNamespace(
        request_id="turn-two",
        session_id="session-one",
        kernel=SimpleNamespace(
            _config=SimpleNamespace(
                electron_state_root=str(state_root),
                tools_workspace_root=str(workspace),
            )
        ),
    )
    bind_run_context(run)
    call = ToolCallRequest(
        "write_file",
        {
            "path": "resumed.txt",
            "content": "resumed",
            "_jenny_turn_id": "turn-one",
            "_jenny_change_set_id": CHANGE_SET_ID,
        },
        "approved-call",
    )
    kernel = SimpleNamespace(_mcp_client=SimpleNamespace(tool_descriptor=lambda _name: None))
    frozen = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id=run.session_id,
        read_snapshot_cache={},
        turn_id=run.request_id,
    )
    stored_call = freeze_approval_tool_calls((call,), (frozen,))[0]
    resumed_id = str(frozen.effective_tool_arguments["_jenny_change_set_id"])
    finish_run_change_set(run, approval_paused=True, reason="approval_required")
    resumed_run = SimpleNamespace(
        request_id="turn-two",
        session_id="session-one",
        kernel=run.kernel,
        _jenny_change_set_id=resumed_id,
    )
    bind_run_context(resumed_run)
    resumed = freeze_effective_execution_inputs(
        kernel,
        stored_call,
        session_id=resumed_run.session_id,
        read_snapshot_cache={},
        turn_id=resumed_run.request_id,
    )
    prepared = lifecycle.prepare_file_change(
        resumed.effective_tool_arguments,
        tool_name="write_file",
        target=workspace / "resumed.txt",
        relative_path="resumed.txt",
        new_bytes=b"resumed",
        checkpoint=None,
    )

    assert foreign.change_set_id == CHANGE_SET_ID
    assert resumed_id != CHANGE_SET_ID
    assert prepared.change_set_id == resumed_id
    assert "_jenny_turn_id" not in frozen.visible_tool_arguments
    assert "_jenny_change_set_id" not in frozen.visible_tool_arguments
    after = store.load(workspace_identity(workspace).workspace_id, CHANGE_SET_ID).record
    assert after is not None
    assert after["operations"] == before["operations"]
    assert after["tool_call_ids"] == before["tool_call_ids"]
    finish_run_change_set(resumed_run, approval_paused=True, reason="approval_required")


def test_corrupt_open_journal_is_not_replaced_during_prepare(tmp_path: Path) -> None:
    workspace, store, lifecycle = _lifecycle(tmp_path)
    lifecycle.prepare_file_change(
        _arguments("first-call"),
        tool_name="write_file",
        target=workspace / "first.txt",
        relative_path="first.txt",
        new_bytes=b"first",
        checkpoint=None,
    )
    journal_path = store.journal_path(workspace_identity(workspace).workspace_id, CHANGE_SET_ID)
    corrupt = b"{not valid journal"
    journal_path.write_bytes(corrupt)

    with pytest.raises(ToolExecutionFailure):
        lifecycle.prepare_file_change(
            _arguments("second-call"),
            tool_name="write_file",
            target=workspace / "second.txt",
            relative_path="second.txt",
            new_bytes=b"second",
            checkpoint=None,
        )

    assert journal_path.read_bytes() == corrupt
    assert not (workspace / "second.txt").exists()


def test_prepare_refuses_while_workspace_restore_is_in_progress(tmp_path: Path) -> None:
    workspace, store, lifecycle = _lifecycle(tmp_path)
    target = workspace / "first.txt"
    prepared = lifecycle.prepare_file_change(
        _arguments("first-call"),
        tool_name="write_file",
        target=target,
        relative_path="first.txt",
        new_bytes=b"first",
        checkpoint=None,
    )
    target.write_bytes(b"first")
    lifecycle.mark_applied(prepared)
    lifecycle.finalize(CHANGE_SET_ID)
    preflight_undo(store, workspace, CHANGE_SET_ID)
    identity = workspace_identity(workspace)
    record = store.load(identity.workspace_id, CHANGE_SET_ID).record
    assert record is not None
    record["restore"]["status"] = "in_progress"
    assert store.write_transition(record, workspace_root=workspace).ok
    other_id = "01990f9a-8c51-7ad2-a8be-41190e0e1f23"

    with pytest.raises(ToolExecutionFailure, match="Workspace recovery is in progress"):
        lifecycle.prepare_file_change(
            {**_arguments("second-call"), "_jenny_change_set_id": other_id},
            tool_name="write_file",
            target=workspace / "second.txt",
            relative_path="second.txt",
            new_bytes=b"second",
            checkpoint=None,
        )

    assert store.load(identity.workspace_id, other_id).record is None


def test_approval_plan_owns_turn_set_without_mutation_frozen_inputs(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_root = tmp_path / "electron-state"
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    target = workspace / "written.txt"
    prepared = lifecycle.prepare_file_change(
        _arguments("write-call"),
        tool_name="write_file",
        target=target,
        relative_path="written.txt",
        new_bytes=b"written",
        checkpoint=None,
    )
    target.write_bytes(b"written")
    lifecycle.mark_applied(prepared)
    request_context = SimpleNamespace(
        request_id="turn-one",
        trace_id="trace-one",
        session_id="session-one",
        context_blocks=(),
        reasoning_effort="",
        memory_policy=None,
    )
    frozen = freeze_effective_execution_inputs(
        SimpleNamespace(_mcp_client=SimpleNamespace(tool_descriptor=lambda _name: None)),
        ToolCallRequest("ask", {"question": "Continue?"}, "ask-call"),
        session_id="session-one",
        read_snapshot_cache={},
        turn_id="turn-one",
    )
    builder_args = {
        "approved_call_id": "ask-call",
        "request_context": request_context,
        "latest_user_content": "write then ask",
        "request_messages_hash": "messages",
        "working_messages": [{"role": "user", "content": "write then ask"}],
        "generation_result": SimpleNamespace(),
        "tool_calls": (ToolCallRequest("ask", {"question": "Continue?"}, "ask-call"),),
        "frozen_inputs": (frozen,),
        "tool_contract": SimpleNamespace(prompt_schemas=(), status_entries=()),
        "tool_resolution_context": None,
        "read_snapshot_cache": {},
        "outcomes": (),
        "usage_totals": None,
        "streamed_event_types": frozenset(),
        "system_prompt": "system",
        "prompt_cache_enabled": False,
        "cache_source_key": "",
        "remaining_iterations": 1,
        "tool_payload": [],
        "tool_statuses": (),
        "config": SimpleNamespace(
            engine_type="mock",
            model="mock",
            model_tier="",
            fallback_model="",
            temperature=0.0,
            top_p=1.0,
            stop_sequences=(),
        ),
        "engine": SimpleNamespace(),
        "resolved_max_tokens": 64,
    }
    without_id = build_approval_plan(**builder_args)
    plan = build_approval_plan(**builder_args, change_set_id=CHANGE_SET_ID)
    from sidecar.ai.routing.tool_loop import (  # noqa: PLC0415
        build_approval_plan as build_run_approval_plan,
    )

    paused_run = SimpleNamespace(
        request_id="turn-one",
        session_id="session-one",
        _jenny_change_set_id=CHANGE_SET_ID,
    )
    bind_run_context(paused_run)
    run_plan = build_run_approval_plan(**builder_args)
    finish_run_change_set(paused_run, approval_paused=True, reason="approval_required")
    assert plan.change_set_id == CHANGE_SET_ID
    assert run_plan.change_set_id == CHANGE_SET_ID
    assert plan.effective_args_fingerprint == without_id.effective_args_fingerprint
    assert plan.execution_context_fingerprint == without_id.execution_context_fingerprint
    assert plan.approval_plan_hash == without_id.approval_plan_hash
    assert all("_jenny_" not in key for key in frozen.effective_tool_arguments)
    resumed_run = SimpleNamespace(
        request_id="turn-one",
        session_id="session-one",
        kernel=SimpleNamespace(
            _config=SimpleNamespace(
                electron_state_root=str(state_root),
                tools_workspace_root=str(workspace),
            )
        ),
        runtime=SimpleNamespace(cancel_handle=SimpleNamespace(cancelled=False)),
        outcomes=[SimpleNamespace(success=True)],
        _jenny_change_set_id=plan.change_set_id,
    )
    bind_run_context(resumed_run)

    finish_run_change_set(resumed_run, approval_paused=False, reason="final_response")

    record = store.load(workspace_identity(workspace).workspace_id, CHANGE_SET_ID).record
    assert record is not None
    assert record["state"] == "committed"
    assert preflight_undo(store, workspace, CHANGE_SET_ID)["status"] == "preflight"


def test_commit_maintenance_is_best_effort_and_skips_interrupted_sets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sidecar.ai.tools import workspace_retention  # noqa: PLC0415

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_root = tmp_path / "electron-state"
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    calls: list[tuple[WorkspaceMutationJournalStore, Path]] = []
    monkeypatch.setattr(
        workspace_retention,
        "run_recovery_maintenance",
        lambda called_store, root: calls.append((called_store, Path(root))),
    )

    def _settle(change_set_id: str, call_id: str, *, cancelled: bool = False) -> None:
        target = workspace / f"{call_id}.txt"
        prepared = lifecycle.prepare_file_change(
            {**_arguments(call_id), "_jenny_change_set_id": change_set_id},
            tool_name="write_file",
            target=target,
            relative_path=target.name,
            new_bytes=call_id.encode(),
            checkpoint=None,
        )
        target.write_bytes(call_id.encode())
        lifecycle.mark_applied(prepared)
        run = SimpleNamespace(
            request_id="turn-one",
            session_id="session-one",
            kernel=SimpleNamespace(
                _config=SimpleNamespace(
                    electron_state_root=str(state_root),
                    tools_workspace_root=str(workspace),
                )
            ),
            runtime=SimpleNamespace(cancel_handle=SimpleNamespace(cancelled=cancelled)),
            outcomes=[SimpleNamespace(success=True)],
            _jenny_change_set_id=change_set_id,
        )
        bind_run_context(run)
        finish_run_change_set(run, approval_paused=False, reason="final_response")

    _settle(CHANGE_SET_ID, "committed")
    assert len(calls) == 1
    assert calls[0][0].version_root == store.version_root
    assert calls[0][1] == workspace
    _settle("01990f9a-8c51-7ad2-a8be-41190e0e1f24", "interrupted", cancelled=True)
    assert len(calls) == 1
    monkeypatch.setattr(
        workspace_retention,
        "run_recovery_maintenance",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("maintenance failed")),
    )
    _settle("01990f9a-8c51-7ad2-a8be-41190e0e1f25", "raising")


def test_interrupted_multi_operation_set_keeps_prior_backup_pinned(tmp_path: Path) -> None:
    workspace, store, lifecycle = _lifecycle(tmp_path)
    first_path = workspace / "first.txt"
    first_path.write_bytes(b"before")
    checkpoint = create_checkpoint(first_path, workspace, apply_retention=False)
    first = lifecycle.prepare_file_change(
        _arguments("first-call"),
        tool_name="write_file",
        target=first_path,
        relative_path="first.txt",
        new_bytes=b"after",
        checkpoint=checkpoint,
    )
    first_path.write_bytes(b"after")
    lifecycle.mark_applied(first)
    second_path = workspace / "second.txt"
    second = lifecycle.prepare_file_change(
        _arguments("second-call"),
        tool_name="write_file",
        target=second_path,
        relative_path="second.txt",
        new_bytes=b"expected",
        checkpoint=None,
    )
    second_path.write_bytes(b"unexpected")

    lifecycle.mark_applied(second)

    record = store.load(workspace_identity(workspace).workspace_id, CHANGE_SET_ID).record
    assert record is not None
    assert record["state"] == "interrupted"
    assert record["retention"]["protected"] is True
    assert checkpoint.object_id is not None
    assert store.is_recovery_object_pinned(checkpoint.object_id) is True


def test_approval_frozen_arguments_rejoin_the_same_change_set() -> None:
    run = SimpleNamespace(
        request_id="turn-approval",
        session_id="session-approval",
        kernel=SimpleNamespace(_config=SimpleNamespace()),
        runtime=SimpleNamespace(cancel_handle=None),
        outcomes=[],
    )
    bind_run_context(run)
    call = ToolCallRequest("write_file", {"path": "x.txt", "content": "x"}, "call-approval")
    kernel = SimpleNamespace(_mcp_client=SimpleNamespace(tool_descriptor=lambda _name: None))
    frozen = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id=run.session_id,
        read_snapshot_cache={},
    )

    stored_call = freeze_approval_tool_calls((call,), (frozen,))[0]
    finish_run_change_set(run, approval_paused=True, reason="approval_required")
    resumed_run = SimpleNamespace(
        request_id=run.request_id,
        session_id=run.session_id,
        kernel=run.kernel,
        runtime=run.runtime,
        outcomes=[],
        _jenny_change_set_id=frozen.effective_tool_arguments["_jenny_change_set_id"],
    )
    bind_run_context(resumed_run)
    resumed = freeze_effective_execution_inputs(
        kernel,
        stored_call,
        session_id=resumed_run.session_id,
        read_snapshot_cache={},
    )

    assert (
        resumed.effective_tool_arguments["_jenny_change_set_id"]
        == frozen.effective_tool_arguments["_jenny_change_set_id"]
    )
    assert resumed.effective_tool_arguments["_jenny_turn_id"] == "turn-approval"
    assert "_jenny_change_set_id" not in resumed.visible_tool_arguments
    finish_run_change_set(resumed_run, approval_paused=True, reason="approval_required")


def test_injected_transport_keys_are_stripped_before_closed_schema_validation(
    tmp_path: Path,
) -> None:
    workspace = WorkspaceGuard(str(tmp_path))
    tool = BuiltinTool(
        name="closed_tool",
        description="closed",
        side_effecting=False,
        input_schema={
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
            "additionalProperties": False,
        },
        handler=lambda _arguments, _workspace: "ok",
    )
    arguments = {"value": "ok", **_arguments()}

    validated, _operation_id, _scope = _prepare_call_arguments(tool, arguments, workspace)

    assert validated["value"] == "ok"
    assert validated["_jenny_turn_id"] == "turn-one"
    assert validated["_jenny_tool_call_id"] == "call-one"
    assert validated["_jenny_change_set_id"] == CHANGE_SET_ID


def test_shell_observation_marks_open_set_partially_undoable(tmp_path: Path) -> None:
    workspace, store, lifecycle = _lifecycle(tmp_path)
    prepared = lifecycle.prepare_file_change(
        _arguments("call-write"),
        tool_name="write_file",
        target=workspace / "typed.txt",
        relative_path="typed.txt",
        new_bytes=b"typed",
        checkpoint=None,
    )
    (workspace / "typed.txt").write_bytes(b"typed")
    lifecycle.mark_applied(prepared)

    lifecycle.observe_tool_call("run_command", _arguments("call-shell"))

    identity = workspace_identity(workspace)
    record = store.load(identity.workspace_id, CHANGE_SET_ID).record
    assert record["coverage"]["known_unjournaled_events"] == ["call-shell"]
    assert record["coverage"]["partially_undoable"] is True


def test_resume_after_crash_after_in_progress_flush_before_first_workspace_mutation(
    tmp_path: Path,
) -> None:
    class InjectedCrash(RuntimeError):
        pass

    def _crash() -> None:
        raise InjectedCrash("after_in_progress_flush_before_first_workspace_mutation")

    workspace, store, lifecycle = _lifecycle(
        tmp_path,
        after_in_progress_flush_before_first_workspace_mutation=_crash,
    )
    target = workspace / "missing-parent" / "target.txt"
    guard = WorkspaceGuard(str(workspace), mutation_journal=lifecycle)

    with pytest.raises(InjectedCrash):
        write_file_tool(
            {**_arguments("call-crash"), "path": "missing-parent/target.txt", "content": "new"},
            guard,
        )

    assert target.exists() is False
    assert target.parent.exists() is False
    identity = workspace_identity(workspace)
    journal_path = store.journal_path(identity.workspace_id, CHANGE_SET_ID)
    parsed = parse_record_bytes(journal_path.read_bytes())
    assert parsed.ok is True
    assert parsed.record["state"] == "in_progress"
    assert parsed.record["operations"][0]["status"] == "applying"
    assert parsed.record["retention"]["protected"] is True

    fresh_store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    reconciled = fresh_store.reconcile_workspace(workspace)
    assert reconciled[0].record["state"] == "interrupted"
    assert reconciled[0].record["completed_sequences"] == []
    rolled_back = fresh_store.complete_no_effect_rollback(
        identity.workspace_id,
        CHANGE_SET_ID,
        workspace_root=workspace,
    )
    assert rolled_back.record["state"] == "rolled_back"
    assert target.exists() is False
    assert target.parent.exists() is False


@pytest.mark.parametrize("error_kind", ["cancel", "provider"])
def test_exceptional_generation_exit_settles_change_set_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    error_kind: str,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_root = tmp_path / "electron-state"
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    target = workspace / "written.txt"
    prepared = lifecycle.prepare_file_change(
        {
            "_jenny_session_id": "session-one",
            "_jenny_turn_id": "turn-one",
            "_jenny_tool_call_id": "write-call",
            "_jenny_change_set_id": CHANGE_SET_ID,
        },
        tool_name="write_file",
        target=target,
        relative_path="written.txt",
        new_bytes=b"written",
        checkpoint=None,
    )
    target.write_bytes(b"written")
    lifecycle.mark_applied(prepared)
    cancel_handle = TurnCancellationHandle(request_id="turn-one")

    def _raise_generation(**_kwargs: object) -> object:
        if error_kind == "cancel":
            cancel_handle.cancel(reason="user")
            raise TerminalChatStateError(status="cancelled", message="cancelled")
        raise RuntimeError("provider failed")

    config = RuntimeConfig(
        engine_type="mock",
        model="mock",
        mode="assist",
        tools_workspace_root=str(workspace),
        electron_state_root=str(state_root),
    )
    kernel = SimpleNamespace(
        _config=config,
        _request_tool_set=lambda *_args: frozenset(),
        _generate_step=_raise_generation,
    )
    request_context = ChatRequestContext(
        request_id="turn-one",
        trace_id="trace-one",
        session_id="session-one",
        mode="assist",
        approvals_pre_granted=True,
        workspace_root_present=True,
    )
    runtime = LoopRuntime(
        request_id="turn-one",
        request_context=request_context,
        max_iterations=1,
        cancel_handle=cancel_handle,
    )
    captured_runs: list[Any] = []
    original_bind = lifecycle_module.bind_run_context

    def _capture_run(run: object) -> None:
        captured_runs.append(run)
        original_bind(run)

    monkeypatch.setattr(lifecycle_module, "bind_run_context", _capture_run)
    expected_error = TerminalChatStateError if error_kind == "cancel" else RuntimeError

    with pytest.raises(expected_error):
        run_tool_loop(
            runtime=runtime,
            kernel=kernel,
            request_context=request_context,
            working_messages=[{"role": "user", "content": "continue"}],
            tool_contract=SimpleNamespace(),
            tool_payload=[],
            tool_resolution_context=None,
            tool_preferences=None,
            mode_policy=None,
            plan_mode=False,
            read_only=False,
            approvals_pre_granted=True,
            request_id="turn-one",
            session_id="session-one",
            latest_user_content="continue",
            reasoning_effort=None,
            prompt_cache_enabled=False,
            cache_source_key="",
            system_prompt="system",
            cache_break_detector=None,
            budget_tracker=None,
            read_snapshot_cache={},
            tool_statuses=(),
            initial_thinking_text=None,
            initial_change_set_id=CHANGE_SET_ID,
        )

    record = store.load(workspace_identity(workspace).workspace_id, CHANGE_SET_ID).record
    assert record is not None
    assert record["state"] == ("interrupted" if error_kind == "cancel" else "committed")
    assert len(captured_runs) == 1
    run = captured_runs[0]
    assert run._jenny_mutation_context_token is None
    finish_run_change_set(run, approval_paused=False, reason="second_call")
