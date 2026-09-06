"""WO-26 tests: retention measured in ACTIVE app use, plus a wall-clock cap.

Everything here uses an injectable "active-use seconds" value passed directly
to the functions under test -- never wall-clock sleeps or real timestamps for
the active-use dimension. A test that only advances wall time and expects
eviction would be wrong for this feature; see
``docs/plans/WORKSPACE_MUTATION_JOURNAL.md`` section 7.
"""

from __future__ import annotations

import json
import os
from argparse import Namespace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

import sidecar.ai.tools.workspace_retention as retention_module
from sidecar.ai.mcp import builtin_server
from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
from sidecar.ai.tools.builtins import file_history as file_history_module
from sidecar.ai.tools.builtins import trash_maintenance as trash_module
from sidecar.ai.tools.builtins.file_history import create_checkpoint
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_mutation_journal_store import (
    ACTIVE_RETENTION_SECONDS,
    QuotaLimits,
    WorkspaceMutationJournalStore,
)
from sidecar.ai.tools.workspace_retention import (
    ActiveUseAgeTracker,
    acknowledge_recovery_review,
    list_recovery_review,
    record_active_use_seconds,
    run_recovery_maintenance,
    touch_workspace_active_use,
)
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, WorkspaceStoreKind
from sidecar.protocol import (
    WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD,
    WORKSPACE_LIST_RECOVERY_REVIEW_METHOD,
)
from sidecar.runtime.server_auxiliary_workers import AUXILIARY_FAMILY_BY_METHOD

_THIRTY_ONE_DAYS = 31 * 24 * 60 * 60


def _lifecycle(
    tmp_path: Path, name: str = "recovery", **store_options: object
) -> tuple[Path, WorkspaceMutationJournalStore, MutationChangeSetLifecycle]:
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    store = WorkspaceMutationJournalStore(tmp_path / name, **store_options)
    return workspace, store, MutationChangeSetLifecycle(store, workspace)


def _commit_one_write(
    lifecycle: MutationChangeSetLifecycle,
    workspace: Path,
    *,
    change_set_id: str,
    filename: str,
    turn_id: str = "turn",
) -> None:
    arguments = {
        "_jenny_session_id": "session",
        "_jenny_turn_id": turn_id,
        "_jenny_tool_call_id": f"call-{filename}",
        "_jenny_change_set_id": change_set_id,
    }
    target = workspace / filename
    prepared = lifecycle.prepare_file_change(
        arguments,
        tool_name="write_file",
        target=target,
        relative_path=filename,
        new_bytes=b"body",
        checkpoint=None,
    )
    target.write_bytes(b"body")
    lifecycle.mark_applied(prepared)
    result = lifecycle.finalize(change_set_id)
    assert result.ok is True
    assert result.record["state"] == "committed"


# ── record_active_use_seconds: journal active-use accounting ───────────────


def test_zero_active_seconds_never_advances_age_no_matter_how_many_touches(
    tmp_path: Path,
) -> None:
    """Contract #1 (journal half): many "wall-clock days" with 0 active
    seconds must never make a set age-eligible."""
    observed = {"now": datetime(2030, 1, 1, tzinfo=UTC)}
    workspace, store, lifecycle = _lifecycle(
        tmp_path, now_provider=lambda: observed["now"]
    )
    _commit_one_write(lifecycle, workspace, change_set_id="0" * 8 + "-0000-7000-8000-000000000001", filename="a.txt")

    identity_workspace_id = store.version_root.glob("*")
    workspace_id = next(identity_workspace_id).name

    record_active_use_seconds(store, workspace, 0)
    observed["now"] += timedelta(days=60)
    record_active_use_seconds(store, workspace, 0)

    loaded = store.load(workspace_id, "00000000-0000-7000-8000-000000000001")
    assert loaded.ok is True
    assert loaded.record["retention"]["active_age_seconds"] == 0
    assert loaded.record["retention"]["created_active_use_seconds"] == 0


def test_active_seconds_establish_baseline_then_reach_eligibility_and_stop_writing(
    tmp_path: Path,
) -> None:
    """Contract #2 (journal half): 31 active-use days makes a set eligible,
    driven entirely by the injected active-seconds value."""
    workspace, store, lifecycle = _lifecycle(tmp_path)
    change_set_id = "00000000-0000-7000-8000-000000000002"
    _commit_one_write(lifecycle, workspace, change_set_id=change_set_id, filename="b.txt")
    workspace_id = next(store.version_root.glob("*")).name

    # First touch: workspace has already accumulated 100 active seconds
    # elsewhere; THIS set's baseline is established at that value, not 0.
    touched = record_active_use_seconds(store, workspace, 100)
    assert touched == (change_set_id,)
    loaded = store.load(workspace_id, change_set_id)
    assert loaded.record["retention"]["created_active_use_seconds"] == 100
    assert loaded.record["retention"]["active_age_seconds"] == 0

    # Advance to 31 active-use days past the baseline.
    touched = record_active_use_seconds(store, workspace, 100 + _THIRTY_ONE_DAYS)
    assert touched == (change_set_id,)
    loaded = store.load(workspace_id, change_set_id)
    assert loaded.record["retention"]["active_age_seconds"] >= ACTIVE_RETENTION_SECONDS

    # Once eligible, further touches are a no-op (no wasted durable writes).
    touched = record_active_use_seconds(store, workspace, 100 + _THIRTY_ONE_DAYS * 2)
    assert touched == ()


def test_active_use_seconds_never_roll_backward(tmp_path: Path) -> None:
    workspace, store, lifecycle = _lifecycle(tmp_path)
    change_set_id = "00000000-0000-7000-8000-000000000003"
    _commit_one_write(lifecycle, workspace, change_set_id=change_set_id, filename="c.txt")
    workspace_id = next(store.version_root.glob("*")).name

    record_active_use_seconds(store, workspace, 5_000)
    touched = record_active_use_seconds(store, workspace, 10)  # a stale/duplicate turn
    assert touched == ()
    loaded = store.load(workspace_id, change_set_id)
    assert loaded.record["retention"]["last_accessed_active_use_seconds"] == 5_000


# ── active-use eligibility drives real eviction, oldest-first, newest pinned ─


def test_active_use_eligible_set_evicted_oldest_first_newest_committed_survives(
    tmp_path: Path,
) -> None:
    """Contract #2 + #3 together, using the real store's reservation path."""
    observed = {"now": datetime(2030, 1, 1, tzinfo=UTC)}
    workspace, store, lifecycle = _lifecycle(
        tmp_path,
        quotas=QuotaLimits(max_change_sets=200),
        now_provider=lambda: observed["now"],
    )
    older_id = "00000000-0000-7000-8000-0000000000a1"
    newer_id = "00000000-0000-7000-8000-0000000000a2"
    _commit_one_write(lifecycle, workspace, change_set_id=older_id, filename="older.txt", turn_id="t1")
    _commit_one_write(lifecycle, workspace, change_set_id=newer_id, filename="newer.txt", turn_id="t2")
    workspace_id = next(store.version_root.glob("*")).name

    # First touch establishes each set's baseline at 1 (nonzero, so it is
    # distinguishable from the untouched 0/0 default); the second touch
    # advances both to 31 active-use days past that baseline. The newer set
    # is ALSO eligible by age here, but survives purely because it is pinned
    # as the newest committed set (proven independently by the byte-quota
    # test below, which pins it via a tiny quota with no age involved).
    record_active_use_seconds(store, workspace, 1)
    observed["now"] += timedelta(days=10)
    record_active_use_seconds(store, workspace, 1 + _THIRTY_ONE_DAYS)

    tight_store = WorkspaceMutationJournalStore(
        store.version_root.parent,
        quotas=QuotaLimits(max_change_sets=2),
        now_provider=lambda: observed["now"],
    )
    third_id = "00000000-0000-7000-8000-0000000000a3"
    third_lifecycle = MutationChangeSetLifecycle(tight_store, workspace)
    _commit_one_write(third_lifecycle, workspace, change_set_id=third_id, filename="third.txt", turn_id="t3")

    remaining_ids = {
        child.name for child in (tight_store.version_root / workspace_id).iterdir() if child.is_dir()
    }
    assert older_id not in remaining_ids, "the oldest age-eligible set is evicted first"
    assert newer_id in remaining_ids, "newest committed set is never evicted"
    assert third_id in remaining_ids


def test_newest_committed_alone_over_byte_quota_fails_closed_not_evicted(tmp_path: Path) -> None:
    """Contract #3: the newest committed set is never evicted even when IT
    ALONE exceeds a byte quota -- the mutation fails closed instead."""
    workspace, store, lifecycle = _lifecycle(tmp_path)
    target = workspace / "solo.txt"
    target.write_bytes(b"before")
    checkpoint = create_checkpoint(target, workspace, apply_retention=False)
    change_set_id = "00000000-0000-7000-8000-0000000000b1"
    arguments = {
        "_jenny_session_id": "s",
        "_jenny_turn_id": "t",
        "_jenny_tool_call_id": "call-solo",
        "_jenny_change_set_id": change_set_id,
    }
    prepared = lifecycle.prepare_file_change(
        arguments,
        tool_name="write_file",
        target=target,
        relative_path="solo.txt",
        new_bytes=b"after",
        checkpoint=checkpoint,
    )
    target.write_bytes(b"after")
    lifecycle.mark_applied(prepared)
    assert lifecycle.finalize(change_set_id).ok is True

    tight_store = WorkspaceMutationJournalStore(
        store.version_root.parent, quotas=QuotaLimits(max_recovery_object_bytes=1)
    )
    forcing = MutationChangeSetLifecycle(tight_store, workspace)
    forcing_target = workspace / "forcing.txt"
    with pytest.raises(ToolExecutionFailure) as failure:
        forcing.prepare_file_change(
            {
                "_jenny_session_id": "s",
                "_jenny_turn_id": "next",
                "_jenny_tool_call_id": "call-next",
                "_jenny_change_set_id": "00000000-0000-7000-8000-0000000000b2",
            },
            tool_name="write_file",
            target=forcing_target,
            relative_path="forcing.txt",
            new_bytes=b"new",
            checkpoint=None,
        )
    assert failure.value.code == "CMP-TOOL-0006"
    assert failure.value.message == "Workspace recovery quota cannot be reserved safely."
    assert len(failure.value.message) < 256
    workspace_id = next(store.version_root.glob("*")).name
    loaded = tight_store.load(workspace_id, change_set_id)
    assert loaded.ok is True
    assert loaded.record["retention"]["pinned_as_newest_committed"] is True
    assert forcing_target.exists() is False


# ── wall-clock review: list / acknowledge ───────────────────────────────────


def test_wall_clock_review_lists_due_sets_and_acknowledge_enables_later_eviction(
    tmp_path: Path,
) -> None:
    assert AUXILIARY_FAMILY_BY_METHOD[WORKSPACE_LIST_RECOVERY_REVIEW_METHOD] == "workspace_recovery"
    assert AUXILIARY_FAMILY_BY_METHOD[WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD] == "workspace_recovery"
    workspace, store, lifecycle = _lifecycle(tmp_path)
    change_set_id = "00000000-0000-7000-8000-0000000000c1"
    _commit_one_write(lifecycle, workspace, change_set_id=change_set_id, filename="old-review.txt")
    workspace_id = next(store.version_root.glob("*")).name

    loaded = store.load(workspace_id, change_set_id)
    record = dict(loaded.record)
    record["retention"] = dict(record["retention"])
    due_at = datetime.fromisoformat(
        record["retention"]["wall_clock_review_due_at"].replace("Z", "+00:00")
    )

    assert list_recovery_review(
        store, workspace, now=due_at - timedelta(seconds=1)
    )["due_for_review"] == []
    review = list_recovery_review(store, workspace, now=due_at)
    assert review["workspace_id"] == workspace_id
    ids = [item["change_set_id"] for item in review["due_for_review"]]
    assert change_set_id in ids

    middle_id = "00000000-0000-7000-8000-0000000000c2"
    _commit_one_write(lifecycle, workspace, change_set_id=middle_id, filename="middle.txt")
    demoted = store.load(workspace_id, change_set_id)
    assert demoted.record["retention"]["pinned_as_newest_committed"] is False

    tight_store = WorkspaceMutationJournalStore(
        store.version_root.parent,
        quotas=QuotaLimits(max_change_sets=2),
        now_provider=lambda: due_at + timedelta(seconds=1),
    )
    forcing_lifecycle = MutationChangeSetLifecycle(tight_store, workspace)
    forcing_id = "00000000-0000-7000-8000-0000000000c3"
    with pytest.raises(ToolExecutionFailure):
        _commit_one_write(
            forcing_lifecycle,
            workspace,
            change_set_id=forcing_id,
            filename="forcing.txt",
        )
    assert tight_store.load(workspace_id, change_set_id).ok is True

    ack = acknowledge_recovery_review(
        tight_store, workspace, change_set_id, now=due_at + timedelta(seconds=1)
    )
    assert ack["change_set_id"] == change_set_id
    assert ack["wall_clock_review_presented_at"] is not None
    review_after = list_recovery_review(
        tight_store, workspace, now=due_at + timedelta(seconds=1)
    )
    assert change_set_id not in [item["change_set_id"] for item in review_after["due_for_review"]]

    _commit_one_write(forcing_lifecycle, workspace, change_set_id=forcing_id, filename="forcing.txt")

    remaining_ids = {
        child.name for child in (tight_store.version_root / workspace_id).iterdir() if child.is_dir()
    }
    assert change_set_id not in remaining_ids, "wall-clock-reviewed, unpinned set may now be evicted"
    assert middle_id in remaining_ids
    assert forcing_id in remaining_ids


# ── ActiveUseAgeTracker: trash/backup active-clock seam ─────────────────────


def test_active_use_age_tracker_baselines_on_first_observation_then_becomes_eligible() -> None:
    tracker = ActiveUseAgeTracker(current_active_use_seconds=1_000)
    # First observation: establishes the baseline, never eligible on sight.
    assert tracker.is_age_eligible("entry-a", created_at_ns=0) is False
    assert tracker.baselines["entry-a"] == 1_000

    # 0 wall-clock-days-worth of extra "active use": still not eligible.
    tracker.current_active_use_seconds = 1_000
    assert tracker.is_age_eligible("entry-a", created_at_ns=0) is False

    # 31 active-use days later (per this injected clock, not real time).
    tracker.current_active_use_seconds = 1_000 + _THIRTY_ONE_DAYS
    assert tracker.is_age_eligible("entry-a", created_at_ns=0) is True


# ── trash/backup retention plugged into the active-use tracker ─────────────


def test_trash_retention_with_active_use_tracker_ignores_wall_clock_entirely(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = GuardedWorkspaceStore(tmp_path)

    def _stamp(seconds_ago: int) -> str:
        return (datetime.now(UTC) - timedelta(seconds=seconds_ago)).strftime("%Y%m%dT%H%M%S_%f")

    # Two entries: the "newest entry is never evicted" rule (pre-existing,
    # unrelated to WO-26) means a single-entry trash can never demonstrate
    # eviction at all, so a second (newer) entry stays present throughout.
    old_stamp = _stamp(400 * 24 * 60 * 60)  # over a year old by wall clock
    new_stamp = _stamp(1)
    store.write_bytes_atomic(store.resolve(WorkspaceStoreKind.TRASH, (old_stamp, "content.txt")), b"x" * 10)
    store.write_bytes_atomic(store.resolve(WorkspaceStoreKind.TRASH, (new_stamp, "content.txt")), b"y" * 10)

    tracker = ActiveUseAgeTracker(current_active_use_seconds=1)
    # First pass: establishes each entry's active-use baseline; contract #1 --
    # 0 additional active seconds elapsed, so nothing is evicted yet even
    # though `old_stamp` is over a year old by WALL clock.
    trash_module.apply_trash_retention(store, active_use_age_source=tracker)
    remaining = {entry.name for entry in trash_module.list_trash_entries(store)}
    assert remaining == {old_stamp, new_stamp}

    # Advance the SAME tracker's clock (simulating active use accruing) past
    # the threshold; a second pass now evicts only the eligible OLDER entry,
    # never the newest.
    tracker.current_active_use_seconds = 1 + _THIRTY_ONE_DAYS
    monkeypatch.setattr(trash_module, "MAX_TRASH_ENTRIES", 1)
    trash_module.apply_trash_retention(store, active_use_age_source=tracker)
    remaining_after = {entry.name for entry in trash_module.list_trash_entries(store)}
    assert remaining_after == {new_stamp}


def test_backup_retention_with_active_use_tracker_ignores_wall_clock_entirely(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("v1", encoding="utf-8")
    info_one = file_history_module.create_checkpoint(target, tmp_path)
    assert info_one.created is True
    target.write_text("v2 different length", encoding="utf-8")
    info_two = file_history_module.create_checkpoint(target, tmp_path, apply_retention=False)
    assert info_two.created is True

    store = GuardedWorkspaceStore(tmp_path)
    zero_use_tracker = ActiveUseAgeTracker(current_active_use_seconds=0)
    file_history_module._apply_backup_retention(  # noqa: SLF001 - exercising the injection seam directly
        store, active_use_age_source=zero_use_tracker
    )
    names_before = {
        entry.name
        for entry in store.list_entries(store.resolve(WorkspaceStoreKind.BACKUPS))
        if "@v" in entry.name and entry.name.endswith(".bak")
    }
    assert len(names_before) == 2, "0 active seconds never ages a snapshot out"

    advanced_tracker = ActiveUseAgeTracker(
        current_active_use_seconds=_THIRTY_ONE_DAYS, baselines=dict(zero_use_tracker.baselines)
    )
    monkeypatch.setattr(file_history_module, "MAX_BACKUP_SNAPSHOTS", 1)
    file_history_module._apply_backup_retention(  # noqa: SLF001
        store, active_use_age_source=advanced_tracker
    )
    names_after = {
        entry.name
        for entry in store.list_entries(store.resolve(WorkspaceStoreKind.BACKUPS))
        if "@v" in entry.name and entry.name.endswith(".bak")
    }
    assert len(names_after) == 1, "the newest snapshot is never evicted even once eligible"


def test_protected_journal_references_survive_trash_and_backup_purge(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace, store, lifecycle = _lifecycle(tmp_path)
    guarded = GuardedWorkspaceStore(workspace)
    now = datetime(2030, 1, 1, tzinfo=UTC)
    monkeypatch.setattr(trash_module, "MAX_TRASH_ENTRIES", 2)
    monkeypatch.setattr(file_history_module, "MAX_BACKUP_SNAPSHOTS", 2)
    backups = []
    for index, name in enumerate(("unreferenced.txt", "protected.txt", "newest.txt")):
        target = workspace / name
        target.write_text(name, encoding="utf-8")
        info = create_checkpoint(target, workspace, apply_retention=False)
        path = workspace / str(info.display_path)
        os.utime(path, (index + 1, index + 1))
        backups.append((target, info, path))
    stamps = [
        (now - timedelta(seconds=seconds)).strftime("%Y%m%dT%H%M%S_%f")
        for seconds in (300, 200, 100)
    ]
    for stamp in stamps:
        guarded.write_bytes_atomic(
            guarded.resolve(WorkspaceStoreKind.TRASH, (stamp, "trash.txt")), b"x"
        )
    change_set_id = "00000000-0000-7000-8000-0000000000f1"
    args = {
        "_jenny_session_id": "s", "_jenny_turn_id": "t",
        "_jenny_tool_call_id": "backup-call", "_jenny_change_set_id": change_set_id,
    }
    target, checkpoint, _path = backups[1]
    prepared = lifecycle.prepare_file_change(
        args, tool_name="write_file", target=target, relative_path=target.name,
        new_bytes=b"changed", checkpoint=checkpoint,
    )
    target.write_bytes(b"changed")
    lifecycle.mark_applied(prepared)
    trash_target = workspace / "trash-source.txt"
    trash_target.write_bytes(b"x")
    args["_jenny_tool_call_id"] = "trash-call"
    prepared = lifecycle.prepare_delete(
        args, target=trash_target, relative_path=trash_target.name,
        trash_relative_path=f".jenny/trash/{stamps[1]}/trash.txt",
    )
    trash_target.unlink()
    lifecycle.mark_applied(prepared)
    assert lifecycle.finalize(change_set_id).ok is True
    retention_module._record_current_active_use(guarded, 0)  # noqa: SLF001
    run_recovery_maintenance(store, workspace)
    retention_module._record_current_active_use(guarded, _THIRTY_ONE_DAYS)  # noqa: SLF001
    run_recovery_maintenance(store, workspace)
    assert backups[0][2].exists() is False
    assert backups[1][2].exists() is True
    assert backups[2][2].exists() is True
    remaining_trash = {entry.name for entry in trash_module.list_trash_entries(guarded)}
    assert remaining_trash == {stamps[1], stamps[2]}


# ── continuous maintenance: startup + on every journal commit ──────────────


def test_on_commit_hook_fires_exactly_once_after_a_real_commit(tmp_path: Path) -> None:
    """Contract #7: maintenance runs after a journal commit, not merely on the
    next delete/write call -- proven via the store's own on_commit seam."""
    calls: list[tuple[str, str]] = []
    workspace, store, lifecycle = _lifecycle(tmp_path, on_commit=lambda w, c: calls.append((w, c)))
    change_set_id = "00000000-0000-7000-8000-0000000000d1"

    _commit_one_write(lifecycle, workspace, change_set_id=change_set_id, filename="hook.txt")

    assert len(calls) == 1
    assert calls[0][1] == change_set_id
    record_active_use_seconds(store, workspace, 10)
    assert len(calls) == 1, "retention metadata writes never replay commit hooks"
    workspace_id = next(store.version_root.glob("*")).name
    loaded = store.load(workspace_id, change_set_id)
    assert loaded.record["retention"]["pinned_as_newest_committed"] is True


def test_builtin_guard_runs_startup_maintenance_and_commit_maintenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    recovery = tmp_path / "recovery" / "v1"
    calls: list[str] = []
    monkeypatch.setattr(
        retention_module,
        "run_recovery_maintenance",
        lambda _store, _root: calls.append("maintenance"),
    )
    guard = builtin_server._build_workspace_guard(  # noqa: SLF001
        Namespace(
            workspace_root=str(workspace),
            pre_change_snapshot_root=None,
            workspace_recovery_root=str(recovery),
        )
    )
    assert calls == ["maintenance"]
    _commit_one_write(
        guard.mutation_journal,
        workspace,
        change_set_id="00000000-0000-7000-8000-0000000000d2",
        filename="startup-hook.txt",
    )
    assert calls == ["maintenance", "maintenance"]


def test_iter_change_set_ids_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(retention_module, "MAX_TOUCHED_CHANGE_SETS", 3)
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    workspace_id = "ws_" + "a" * 32
    workspace_dir = store.version_root / workspace_id
    workspace_dir.mkdir(parents=True)
    for index in range(10):
        (workspace_dir / f"dir-{index}").mkdir()

    ids = retention_module._iter_change_set_ids(store, workspace_id)  # noqa: SLF001
    assert len(ids) == 3


# ── chat.send wiring: touch_workspace_active_use ────────────────────────────


class _Config:
    def __init__(self, workspace_root: str, state_root: str) -> None:
        self.tools_workspace_root = workspace_root
        self.electron_state_root = state_root


class _Stack:
    def __init__(self, config: _Config) -> None:
        self.config = config


class _BrainContainer:
    def __init__(self, workspace_root: str, state_root: str) -> None:
        self.stack = _Stack(_Config(workspace_root, state_root))


def test_touch_workspace_active_use_noop_when_field_or_roots_missing(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    container = _BrainContainer(str(workspace), str(tmp_path / "state"))

    touch_workspace_active_use(container, "not-a-dict")  # never raises
    touch_workspace_active_use(container, {})  # field absent
    touch_workspace_active_use(container, {"workspace_active_use_seconds": -1})  # negative
    touch_workspace_active_use(container, {"workspace_active_use_seconds": True})  # bool, not int
    touch_workspace_active_use(container, {"workspace_active_use_seconds": 1.5})

    no_root_container = _BrainContainer("", "")
    touch_workspace_active_use(no_root_container, {"workspace_active_use_seconds": 5})

    # None of the above should have created a recovery store on disk.
    assert not (tmp_path / "state" / "workspace-recovery").exists()


def test_touch_workspace_active_use_updates_journal_and_ledger(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_root = tmp_path / "state"
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    change_set_id = "00000000-0000-7000-8000-0000000000e1"
    _commit_one_write(lifecycle, workspace, change_set_id=change_set_id, filename="turn.txt")
    workspace_id = next(store.version_root.glob("*")).name

    container = _BrainContainer(str(workspace), str(state_root))
    touch_workspace_active_use(container, {"workspace_active_use_seconds": 42})

    loaded = store.load(workspace_id, change_set_id)
    assert loaded.record["retention"]["created_active_use_seconds"] == 42

    guarded = GuardedWorkspaceStore(workspace)
    ledger_ref = guarded.resolve(WorkspaceStoreKind.BACKUPS, ".retention-active-use.json")
    raw = guarded.read_bytes(ledger_ref, max_bytes=4096, missing_ok=False)
    ledger = json.loads(raw.decode("utf-8"))
    assert ledger["current_active_use_seconds"] == 42
