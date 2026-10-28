"""Batch 3 / C7 retention review: the chat.send touch skips its journal scan
until a set can need a write, and maintenance caps .jenny/quarantine."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

import sidecar.ai.tools.workspace_retention as retention_module
from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_retention import (
    run_recovery_maintenance,
    sweep_quarantine,
    touch_workspace_active_use,
)
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore
from tests.sidecar._platform_skips import make_dir_link
from tests.sidecar.ai.tools.test_workspace_retention import _BrainContainer, _commit_one_write

_FIRST = "00000000-0000-7000-8000-0000000000f1"
_SECOND = "00000000-0000-7000-8000-0000000000f2"


def _touch(container: _BrainContainer, seconds: int) -> None:
    touch_workspace_active_use(container, {"workspace_active_use_seconds": seconds})


def test_touch_within_the_write_quantum_does_no_journal_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    state_root = tmp_path / "state"
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    _commit_one_write(lifecycle, workspace, change_set_id=_FIRST, filename="first.txt")
    workspace_id = workspace_identity(workspace).workspace_id
    container = _BrainContainer(str(workspace), str(state_root))
    _touch(container, 1_000)  # the first touch scans and records the baseline
    scans: list[int] = []
    original = retention_module.record_active_use_seconds

    def counting(store_arg: object, root: object, seconds: int, **kwargs: object) -> tuple[str, ...]:
        scans.append(seconds)
        return original(store_arg, root, seconds, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(retention_module, "record_active_use_seconds", counting)
    monkeypatch.setattr(WorkspaceMutationJournalStore, "load", _no_load)

    for step in range(1, 30):
        _touch(container, 1_000 + step * 60)

    assert scans == []
    monkeypatch.undo()
    monkeypatch.setattr(retention_module, "record_active_use_seconds", counting)
    quantum = retention_module.ACTIVE_USE_WRITE_QUANTUM_SECONDS
    _touch(container, 1_000 + quantum)
    assert scans == [1_000 + quantum]
    assert store.load(workspace_id, _FIRST).record["retention"]["active_age_seconds"] == quantum

    # A set added inside the quantum is noticed by its directory, not the clock.
    _commit_one_write(lifecycle, workspace, change_set_id=_SECOND, filename="second.txt", turn_id="t2")
    _touch(container, 1_000 + quantum + 60)
    assert scans == [1_000 + quantum, 1_000 + quantum + 60]
    second = store.load(workspace_id, _SECOND).record
    assert second["retention"]["created_active_use_seconds"] == 1_000 + quantum + 60


def _no_load(*_args: object) -> object:
    raise AssertionError("a touch inside the write quantum read a journal")


def _stamped(prefix: str, when: datetime) -> str:
    return f"{prefix}-deleted-{when.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex}"


def test_quarantine_sweep_removes_aged_then_overflow_entries_without_following_links(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    quarantine = workspace / ".jenny" / "quarantine"
    quarantine.mkdir(parents=True)
    (workspace / ".jenny" / "omissions").mkdir()
    (workspace / ".jenny" / "omissions" / "kept.json").write_text("{}", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "precious.txt").write_text("keep\n", encoding="utf-8")
    now = datetime(2026, 10, 19, 12, 0, tzinfo=UTC)
    aged_file = _stamped("trash-old.txt", now - timedelta(days=45))
    (quarantine / aged_file).write_text("old\n", encoding="utf-8")
    aged_link = _stamped("backups-link", now - timedelta(days=40))
    make_dir_link(quarantine / aged_link, outside)
    recent = [_stamped(f"trash-recent-{index}", now - timedelta(hours=3 - index)) for index in range(3)]
    for name in recent:
        (quarantine / name).mkdir()
        (quarantine / name / "inner.txt").write_text("recent\n", encoding="utf-8")
    (quarantine / "unstamped-notes.txt").write_text("manual\n", encoding="utf-8")
    monkeypatch.setattr(retention_module, "QUARANTINE_MAX_ENTRIES", 2)

    removed = sweep_quarantine(GuardedWorkspaceStore(workspace), now=now)

    assert removed == 3  # both aged entries, then the oldest recent one past the cap
    assert sorted(path.name for path in quarantine.iterdir()) == sorted(
        [*recent[1:], "unstamped-notes.txt"]
    )
    assert (outside / "precious.txt").read_text(encoding="utf-8") == "keep\n"
    assert (workspace / ".jenny" / "omissions" / "kept.json").exists()


def test_recovery_maintenance_sweeps_the_quarantine(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    quarantine = workspace / ".jenny" / "quarantine"
    quarantine.mkdir(parents=True)
    aged = _stamped("trash-old.txt", datetime.now(UTC) - timedelta(days=60))
    (quarantine / aged).write_text("old\n", encoding="utf-8")
    fresh = _stamped("trash-new.txt", datetime.now(UTC))
    (quarantine / fresh).write_text("new\n", encoding="utf-8")

    run_recovery_maintenance(WorkspaceMutationJournalStore(tmp_path / "recovery"), workspace)

    assert [path.name for path in quarantine.iterdir()] == [fresh]
