"""WIDE-044 lifecycle tests for the file-history checkpoint store.

Covers: self-locking (re-entrant with caller-held locks, exclusive across
threads), content-identity dedupe (a same-size timestamp-preserving edit MUST
back up; a content-identical touch must not), relative/versioned metadata
that survives a root relocation, eviction that reconciles metadata (no
orphaned ``last_snapshot`` pointers), and count/age/byte retention quotas
each tripped separately with an injectable clock.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import file_history as file_history_module
from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, WorkspaceStoreKind
from tests._concurrency import join_all_or_fail

_NS_PER_DAY = 24 * 60 * 60 * 1_000_000_000


def _backups_dir(root: Path) -> Path:
    return root / ".jenny" / "backups"


def _snapshot_path(root: Path, info: file_history_module.CheckpointInfo) -> Path:
    assert info.display_path is not None
    return root / Path(info.display_path)


def _metadata_for(root: Path, target: Path) -> dict:
    paths = file_history_module.checkpoint_paths_for(target, root)
    raw = (_backups_dir(root) / f"{paths.file_hash}.json").read_text(encoding="utf-8")
    return json.loads(raw)


# ── self-locking ─────────────────────────────────────────────────────────────


def test_create_checkpoint_is_reentrant_under_a_caller_held_lock(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    # Would deadlock until the 1s timeout (and then fail) if the self-lock
    # did not recognize the caller-held lock through the per-thread registry.
    with file_history_module.checkpoint_lock_for(target, tmp_path, timeout_seconds=1.0):
        info = file_history_module.create_checkpoint(target, tmp_path)

    assert info.created is True
    assert info.version == 1


def test_create_store_checkpoint_is_reentrant_under_store_lock(tmp_path: Path) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    artifact_ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, "report.md")
    store.write_bytes_atomic(artifact_ref, b"body\n")
    relative = ".jenny/artifacts/report.md"

    with file_history_module.checkpoint_store_lock_for(relative, store, timeout_seconds=1.0):
        info = file_history_module.create_store_checkpoint(artifact_ref, relative, store)

    assert info.created is True


def test_concurrent_checkpoints_produce_distinct_versions_and_sane_metadata(
    tmp_path: Path,
) -> None:
    target = tmp_path / "hot.txt"
    target.write_text("seed\n", encoding="utf-8")

    thread_count = 4
    rounds = 3
    barrier = threading.Barrier(thread_count)
    created_versions: list[int] = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def worker(worker_id: int) -> None:
        try:
            barrier.wait(timeout=10)
            for round_index in range(rounds):
                # Serialize the source mutation with its checkpoint, matching
                # the production write/edit paths. The checkpoint call then
                # exercises the lock's per-thread re-entrant path.
                with file_history_module.checkpoint_lock_for(
                    target, tmp_path, timeout_seconds=10.0
                ):
                    target.write_text(
                        f"content-{worker_id}-{round_index}\n", encoding="utf-8"
                    )
                    info = file_history_module.create_checkpoint(target, tmp_path)
                if info.created:
                    with lock:
                        created_versions.append(info.version)
        except BaseException as error:  # noqa: BLE001 - surfaced via the assert below.
            with lock:
                errors.append(error)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(thread_count)]
    for thread in threads:
        thread.start()
    # A blocked writer would leave errors empty and created_versions short,
    # which the assertions below cannot distinguish from a clean short run.
    join_all_or_fail(threads, timeout=30, what="checkpoint writers")

    assert errors == []
    assert created_versions, "at least one checkpoint must have been created"
    assert len(created_versions) == len(set(created_versions)), (
        "versions must be distinct — interleaved writers may never share a version"
    )
    # Metadata is intact, format-2, and points at an EXISTING snapshot.
    metadata = _metadata_for(tmp_path, target)
    assert metadata["format"] == 2
    assert metadata["latest_version"] == max(created_versions)
    snapshot_name = metadata["last_snapshot"]["snapshot_name"]
    assert (_backups_dir(tmp_path) / snapshot_name).is_file()
    # Every created version left a real snapshot behind.
    paths = file_history_module.checkpoint_paths_for(target, tmp_path)
    for version in created_versions:
        assert (_backups_dir(tmp_path) / f"{paths.file_hash}@v{version}.bak").is_file()


# ── content-identity dedupe ──────────────────────────────────────────────────


def test_same_size_timestamp_preserving_edit_still_produces_a_backup(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("aaaa\n", encoding="utf-8")
    first = file_history_module.create_checkpoint(target, tmp_path)
    assert first.created is True

    stat_before = target.stat()
    target.write_text("bbbb\n", encoding="utf-8")  # same size, new content
    os.utime(target, ns=(stat_before.st_atime_ns, stat_before.st_mtime_ns))
    assert target.stat().st_mtime_ns == stat_before.st_mtime_ns
    assert target.stat().st_size == stat_before.st_size

    second = file_history_module.create_checkpoint(target, tmp_path)

    assert second.created is True, (
        "content changed — mtime/size identity must never suppress this backup"
    )
    assert second.version == 2


def test_content_identical_touch_is_deduped_even_with_a_new_mtime(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")
    first = file_history_module.create_checkpoint(target, tmp_path)
    assert first.created is True

    # Same bytes, different timestamp: content identity says "unchanged".
    os.utime(target, ns=(time.time_ns(), time.time_ns()))
    second = file_history_module.create_checkpoint(target, tmp_path)

    assert second.created is False
    backups = list(_backups_dir(tmp_path).glob("*@v*.bak"))
    assert len(backups) == 1


def test_corrupt_matching_backup_is_not_reused_by_checkpoint_dedupe(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_bytes(b"hello\n")
    first = file_history_module.create_checkpoint(target, tmp_path)
    assert first.created is True
    snapshot = _snapshot_path(tmp_path, first)
    snapshot.write_bytes(b"x")

    second = file_history_module.create_checkpoint(target, tmp_path)

    assert second.created is True
    assert second.version == 2
    assert _snapshot_path(tmp_path, second).read_bytes() == b"hello\n"


def test_artifact_checkpoint_retention_preserves_pinned_recovery_object(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(file_history_module, "MAX_BACKUP_SNAPSHOTS", 1)
    pinned_source = tmp_path / "pinned.txt"
    pinned_source.write_text("pinned\n", encoding="utf-8")
    pinned = file_history_module.create_checkpoint(
        pinned_source,
        tmp_path,
        apply_retention=False,
    )
    pinned_path = _snapshot_path(tmp_path, pinned)
    old = time.time() - 60
    os.utime(pinned_path, (old, old))
    assert pinned.object_id is not None
    journal = SimpleNamespace(
        is_recovery_object_pinned=lambda object_id: object_id == pinned.object_id
    )
    guard = WorkspaceGuard(str(tmp_path), mutation_journal=journal)
    relative = ".jenny/artifacts/session-one/report.md"
    artifact = tmp_path / relative
    artifact.parent.mkdir(parents=True)
    artifact.write_text("before\n", encoding="utf-8")
    read = filesystem_module.read_file_tool({"path": relative}, guard)
    assert read.success is True

    result = filesystem_module.write_file_tool(
        {
            "path": relative,
            "content": "after\n",
            "expected_read_snapshot": read.metadata["read_snapshot"],
        },
        guard,
    )

    assert result.success is True
    assert pinned_path.exists()


# ── metadata format ──────────────────────────────────────────────────────────


def test_metadata_persists_relative_versioned_names_and_no_absolute_paths(
    tmp_path: Path,
) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text("print('hi')\n", encoding="utf-8")
    info = file_history_module.create_checkpoint(target, tmp_path)
    assert info.created is True

    metadata = _metadata_for(tmp_path, target)
    last = metadata["last_snapshot"]
    assert last["snapshot_name"].endswith("@v1.bak")
    assert "/" not in last["snapshot_name"] and "\\" not in last["snapshot_name"]
    assert "absolute_path" not in last
    assert "display_path" not in last
    serialized = json.dumps(metadata)
    assert str(tmp_path).replace("\\", "\\\\") not in serialized
    assert last["content_token"].split(":")[0] == str(target.stat().st_size)


def test_relocated_workspace_root_still_resolves_history(tmp_path: Path) -> None:
    original_root = tmp_path / "root-a"
    original_root.mkdir()
    target = original_root / "notes.txt"
    target.write_text("stable\n", encoding="utf-8")
    first = file_history_module.create_checkpoint(target, original_root)
    assert first.created is True

    relocated_root = tmp_path / "root-b"
    shutil.copytree(original_root, relocated_root)

    # Unchanged content at the NEW root: relative metadata must resolve the
    # snapshot and dedupe — absolute-path metadata would fail this.
    info = file_history_module.create_checkpoint(relocated_root / "notes.txt", relocated_root)
    assert info.created is False


# ── eviction reconcile + retention quotas ────────────────────────────────────


class _AllEligibleAgeSource:
    def is_age_eligible(self, entry_name: str, created_at_ns: int) -> bool:
        del entry_name, created_at_ns
        return True


def test_eviction_reconciles_metadata_so_no_orphan_pointers_remain(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(file_history_module, "MAX_BACKUP_SNAPSHOTS", 2)
    files = []
    for index in range(4):
        path = tmp_path / f"f{index}.txt"
        path.write_text(f"content {index}\n", encoding="utf-8")
        files.append(path)

    infos = []
    for index, path in enumerate(files):
        info = file_history_module.create_checkpoint(path, tmp_path)
        assert info.created is True
        # Strictly ordered, recent mtimes so ONLY the count quota trips.
        now = time.time()
        snapshot_path = _snapshot_path(tmp_path, info)
        os.utime(snapshot_path, (now - 40 + index * 10, now - 40 + index * 10))
        infos.append(info)
    file_history_module._apply_backup_retention(
        GuardedWorkspaceStore(tmp_path),
        active_use_age_source=_AllEligibleAgeSource(),
    )

    remaining = {p.name for p in _backups_dir(tmp_path).glob("*@v*.bak")}
    assert len(remaining) == 2, "count quota holds"
    # Every surviving metadata entry must point at an EXISTING snapshot (or
    # have had its last_snapshot trimmed) — no orphans.
    for metadata_path in _backups_dir(tmp_path).glob("*.json"):
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        last = metadata.get("last_snapshot")
        if last is None:
            continue
        assert last["snapshot_name"] in remaining, (
            f"{metadata_path.name} points at an evicted snapshot"
        )
    # An evicted file's next checkpoint starts fresh (no bogus skip).
    refreshed = file_history_module.create_checkpoint(files[0], tmp_path)
    assert refreshed.created is True


def test_count_quota_evicts_eligible_snapshots_above_100(tmp_path: Path) -> None:
    # >100 snapshots across files against the REAL default cap.
    for index in range(105):
        path = tmp_path / f"file-{index:03d}.txt"
        path.write_text(f"payload {index}\n", encoding="utf-8")
        info = file_history_module.create_checkpoint(
            path, tmp_path, apply_retention=False
        )
        assert info.created is True

    file_history_module._apply_backup_retention(
        GuardedWorkspaceStore(tmp_path),
        active_use_age_source=_AllEligibleAgeSource(),
    )

    backups = list(_backups_dir(tmp_path).glob("*@v*.bak"))
    assert len(backups) == file_history_module.MAX_BACKUP_SNAPSHOTS


def test_wall_clock_age_alone_never_evicts_backups(tmp_path: Path) -> None:
    for index in range(3):
        path = tmp_path / f"aged-{index}.txt"
        path.write_text(f"old {index}\n", encoding="utf-8")
        assert file_history_module.create_checkpoint(path, tmp_path).created is True
    snapshots = sorted(_backups_dir(tmp_path).glob("*@v*.bak"))
    assert len(snapshots) == 3

    injected_now = time.time_ns() + 60 * _NS_PER_DAY
    file_history_module._apply_backup_retention(
        GuardedWorkspaceStore(tmp_path), now_ns=injected_now
    )

    remaining = list(_backups_dir(tmp_path).glob("*@v*.bak"))
    assert len(remaining) == 3, "wall time alone never makes backups eligible"


class _FakeActiveUseAgeSource:
    """Minimal ``ActiveUseAgeSource`` double (WO-26)."""

    def __init__(self, eligible_names: set[str]) -> None:
        self._eligible_names = eligible_names

    def is_age_eligible(self, entry_name: str, created_at_ns: int) -> bool:
        del created_at_ns
        return entry_name in self._eligible_names


def test_active_use_eligibility_evicts_only_under_quota_pressure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """WO-26: age is driven entirely by the injected source, never mtime,
    whenever one is supplied. All three snapshots here are WALL-clock-fresh
    (mtimes seconds old, nowhere near ``MAX_BACKUP_AGE_DAYS``); eviction here
    can only be explained by the injected source."""
    infos = []
    for index in range(3):
        path = tmp_path / f"active-{index}.txt"
        path.write_text(f"content {index}", encoding="utf-8")
        info = file_history_module.create_checkpoint(path, tmp_path)
        assert info.created is True
        now = time.time()
        os.utime(_snapshot_path(tmp_path, info), (now - 40 + index * 10, now - 40 + index * 10))
        infos.append(info)
    oldest_name, middle_name, newest_name = (Path(info.display_path).name for info in infos)

    source = _FakeActiveUseAgeSource(eligible_names={oldest_name, middle_name})
    monkeypatch.setattr(file_history_module, "MAX_BACKUP_SNAPSHOTS", 1)
    file_history_module._apply_backup_retention(
        GuardedWorkspaceStore(tmp_path), active_use_age_source=source
    )

    remaining = {p.name for p in _backups_dir(tmp_path).glob("*@v*.bak")}
    assert remaining == {newest_name}, (
        "both source-eligible snapshots evicted despite being wall-clock-fresh; "
        "the newest is never even asked (structurally protected)"
    )


def test_byte_quota_trips_separately(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(file_history_module, "MAX_BACKUP_TOTAL_BYTES", 3_000)
    infos = []
    for index in range(4):
        path = tmp_path / f"big-{index}.txt"
        path.write_text("x" * 1_000, encoding="utf-8")
        info = file_history_module.create_checkpoint(path, tmp_path)
        assert info.created is True
        now = time.time()
        snapshot_path = _snapshot_path(tmp_path, info)
        os.utime(snapshot_path, (now - 40 + index * 10, now - 40 + index * 10))
        infos.append(info)
    file_history_module._apply_backup_retention(
        GuardedWorkspaceStore(tmp_path),
        active_use_age_source=_AllEligibleAgeSource(),
    )

    remaining = sorted(p.name for p in _backups_dir(tmp_path).glob("*@v*.bak"))
    assert len(remaining) == 3, "oldest evicted until the aggregate fits the byte quota"
    assert _snapshot_path(tmp_path, infos[0]).exists() is False, (
        "the oldest snapshot was the eviction"
    )


def test_retention_never_evicts_the_newest_snapshot(tmp_path: Path) -> None:
    path = tmp_path / "solo.txt"
    path.write_text("x" * 1_000, encoding="utf-8")
    info = file_history_module.create_checkpoint(path, tmp_path)
    assert info.created is True

    # Every quota is violated for this one snapshot; it must still survive.
    injected_now = time.time_ns() + (file_history_module.MAX_BACKUP_AGE_DAYS + 10) * _NS_PER_DAY
    store = GuardedWorkspaceStore(tmp_path)
    file_history_module._apply_backup_retention(
        store,
        now_ns=injected_now,
        active_use_age_source=_AllEligibleAgeSource(),
    )

    assert _snapshot_path(tmp_path, info).exists() is True


# ── restore roundtrip ────────────────────────────────────────────────────────


def test_restore_from_backup_roundtrip(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    original = "the original content\n"
    target.write_text(original, encoding="utf-8")
    info = file_history_module.create_checkpoint(target, tmp_path)
    assert info.created is True

    target.write_text("clobbered\n", encoding="utf-8")

    # Restore through the guarded store using ONLY persisted metadata (the
    # relative snapshot_name), the way a restore surface would.
    store = GuardedWorkspaceStore(tmp_path)
    metadata = _metadata_for(tmp_path, target)
    snapshot_ref = store.resolve(
        WorkspaceStoreKind.BACKUPS, metadata["last_snapshot"]["snapshot_name"]
    )
    snapshot_bytes = store.read_bytes(snapshot_ref, max_bytes=1024 * 1024)
    target.write_bytes(snapshot_bytes)

    assert target.read_text(encoding="utf-8") == original
