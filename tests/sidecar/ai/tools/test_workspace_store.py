"""Focused contract tests for the operation-owning guarded workspace store."""

from __future__ import annotations

import os
import subprocess
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED, CMP_TOOL_IO_FAILED
from sidecar.ai.tools import workspace_store as store_module
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_path_identity import resolve_workspace_leaf
from sidecar.ai.tools.workspace_store import (
    GuardedWorkspaceStore,
    StoreRef,
    WorkspaceStoreKind,
)


def _make_junction(link: Path, target: Path) -> bool:
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.returncode == 0


def test_store_refs_are_typed_opaque_and_reject_traversal(tmp_path: Path) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, "session/result.md")

    assert ref == StoreRef(WorkspaceStoreKind.ARTIFACTS, ("session", "result.md"))
    assert not isinstance(ref, Path)
    with pytest.raises(ToolExecutionFailure):
        store.resolve(WorkspaceStoreKind.ARTIFACTS, "../escape.txt")
    with pytest.raises(ToolExecutionFailure):
        store.exists(StoreRef(WorkspaceStoreKind.ARTIFACTS, ("../escape.txt",)))


def test_store_refuses_a_root_that_is_jennys_own_state_directory(tmp_path: Path) -> None:
    # An observed misconfiguration: toolsWorkspaceRoot persisted as Jenny's
    # own `.jenny` state dir. Every consumer then appends its own
    # `.jenny/...` suffix, materializing a doubled `.jenny/.jenny/` tree.
    state_dir_root = tmp_path / ".jenny"
    state_dir_root.mkdir()

    with pytest.raises(ToolExecutionFailure) as excinfo:
        GuardedWorkspaceStore(state_dir_root)
    assert excinfo.value.retryable is False

    # Case-insensitive (Windows filesystem identity).
    upper_state_dir_root = tmp_path / "UPPER"
    upper_state_dir_root.mkdir()
    jenny_upper = upper_state_dir_root / ".JENNY"
    jenny_upper.mkdir()
    with pytest.raises(ToolExecutionFailure):
        GuardedWorkspaceStore(jenny_upper)


def test_jenny_dir_trailing_re_strips_trailing_dots_and_spaces() -> None:
    # Direct unit coverage of the comparison regex (Fix 1 mirror of
    # services/workspace-root-identity.js's normalizeSegmentForJennyCompare):
    # Path.resolve(strict=True) already normalizes trailing dots/spaces away
    # on a real Windows filesystem before GuardedWorkspaceStore ever sees the
    # name, so this is the only place that can prove the stripping logic
    # itself is correct rather than incidentally masked by OS resolution.
    def normalize(segment: str) -> str:
        return store_module._JENNY_DIR_TRAILING_RE.sub("", segment).lower()  # noqa: SLF001

    assert normalize(".jenny.") == ".jenny"
    assert normalize(".JENNY...") == ".jenny"
    assert normalize(".jenny ") == ".jenny"
    assert normalize(".jenny.x") == ".jenny.x"
    assert normalize(".jennyx.") == ".jennyx"


@pytest.mark.skipif(
    os.name != "nt",
    reason="trailing dots and spaces alias existing path segments only on Windows",
)
def test_store_refuses_a_trailing_dot_or_space_jenny_state_dir_root(tmp_path: Path) -> None:
    # End-to-end demonstration: a real `.jenny` directory referenced through a
    # trailing-dot/space alias is still refused. On Windows this already
    # holds even without the Fix 1 mirror (resolve(strict=True) normalizes
    # the alias to the real on-disk name first) -- the regression proof for
    # the guard logic itself lives in the unit test above.
    state_dir_root = tmp_path / ".jenny"
    state_dir_root.mkdir()

    for alias in (".jenny.", ".jenny...", ".jenny "):
        with pytest.raises(ToolExecutionFailure) as excinfo:
            GuardedWorkspaceStore(tmp_path / alias)
        assert excinfo.value.retryable is False


def test_store_accepts_a_root_merely_named_like_jenny_state_dir(tmp_path: Path) -> None:
    # Only an exact final ".jenny" path segment is rejected; a real directory
    # that merely starts with ".jenny" is a normal (if unusual) workspace
    # root and must not be swept up by the guard.
    lookalike_root = tmp_path / ".jenny-archive"
    lookalike_root.mkdir()

    store = GuardedWorkspaceStore(lookalike_root)
    ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, "result.txt")
    assert store.exists(ref) is False


def test_file_lock_accepts_mutable_metadata_changes_on_the_same_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.BACKUPS, "locks/session.lock")

    @contextmanager
    def mutate_lock_metadata(path: Path, *, timeout_seconds: float):
        del timeout_seconds
        path.write_bytes(b"locked")
        yield

    monkeypatch.setattr(store_module, "acquire_file_lock", mutate_lock_metadata)

    with store.file_lock(ref, timeout_seconds=1.0):
        lock_path = tmp_path / ".jenny" / "backups" / "locks" / "session.lock"
        assert lock_path.read_bytes() == b"locked"


def test_file_lock_accepts_contender_metadata_change_before_acquire(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.BACKUPS, "locks/session.lock")
    lock_path = tmp_path / ".jenny" / "backups" / "locks" / "session.lock"

    with store.file_lock(ref, timeout_seconds=1.0):
        pass

    def mutate_lock_metadata(_ref: StoreRef) -> None:
        lock_path.write_bytes(b"contender")

    monkeypatch.setattr(store, "_before_operation", mutate_lock_metadata)

    with store.file_lock(ref, timeout_seconds=1.0):
        assert lock_path.is_file()


@pytest.mark.parametrize(
    "name",
    ["C:escape.txt", "result. ", "NUL", "bad*name", "x" * 181, "é" * 100],
)
def test_store_refs_reject_cross_platform_unsafe_components(
    tmp_path: Path,
    name: str,
) -> None:
    store = GuardedWorkspaceStore(tmp_path)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        store.resolve(WorkspaceStoreKind.ARTIFACTS, name)

    assert excinfo.value.retryable is False


def test_atomic_read_write_enforce_explicit_byte_bounds(tmp_path: Path) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, "session/result.bin")

    with pytest.raises(ToolExecutionFailure) as write_error:
        store.write_bytes_atomic(ref, b"abcd", max_bytes=3)
    assert write_error.value.code == CMP_TOOL_CAP_EXCEEDED
    assert not (tmp_path / ".jenny").exists()

    receipt = store.write_bytes_atomic(ref, b"abcd", max_bytes=4)

    assert receipt.display_path == ".jenny/artifacts/session/result.bin"
    assert not isinstance(receipt, Path)
    with pytest.raises(ToolExecutionFailure) as read_error:
        store.read_bytes(ref, max_bytes=3)
    assert read_error.value.code == CMP_TOOL_CAP_EXCEEDED
    assert store.read_bytes(ref, max_bytes=4) == b"abcd"

    for malformed_limit in (True, 4.0, "4"):
        with pytest.raises(ToolExecutionFailure) as malformed_error:
            store.read_bytes(ref, max_bytes=malformed_limit)  # type: ignore[arg-type]
        assert malformed_error.value.code == CMP_TOOL_CAP_EXCEEDED


def test_atomic_write_cleans_temp_file_when_fsync_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, "session/result.txt")

    def fail_fsync(_fd: int) -> None:
        raise OSError("simulated fsync failure")

    monkeypatch.setattr(store_module.os, "fsync", fail_fsync)

    with pytest.raises(ToolExecutionFailure):
        store.write_text_atomic(ref, "content")

    parent = tmp_path / ".jenny" / "artifacts" / "session"
    assert not list(parent.glob(".result.txt.*.tmp"))
    assert not (parent / "result.txt").exists()


def test_atomic_write_resolves_destination_once_per_prepare(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    real_ensure = store_module.ensure_safe_internal_destination

    def counted_ensure(root: Path, target: Path) -> Path:
        nonlocal calls
        calls += 1
        return real_ensure(root, target)

    monkeypatch.setattr(
        store_module,
        "ensure_safe_internal_destination",
        counted_ensure,
    )
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, "session/result.txt")

    store.write_text_atomic(ref, "content")

    assert calls == 1


def test_unique_write_reports_unsupported_hard_link_without_leaving_temp(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    parent = store.resolve(WorkspaceStoreKind.ARTIFACTS, "session")

    def refuse_link(*_args: object, **_kwargs: object) -> None:
        raise OSError("hard links unavailable")

    monkeypatch.setattr(store_module.os, "link", refuse_link)

    with pytest.raises(ToolExecutionFailure, match="requires hard-link support"):
        store.write_unique_bytes(
            parent,
            file_stem="result",
            file_extension=".txt",
            content=b"content",
        )

    destination_parent = tmp_path / ".jenny" / "artifacts" / "session"
    assert not (destination_parent / "result.txt").exists()
    assert not list(destination_parent.glob(".result.txt.*.tmp"))


def test_sqlite_open_refuses_late_leaf_alias_before_connect(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    outside = tmp_path / "outside.db"
    outside.write_bytes(b"")
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.OMISSIONS, "state.db")
    leaf = tmp_path / ".jenny" / "omissions" / "state.db"
    connect_called = False
    real_connect = store_module.sqlite3.connect

    def swap_leaf(_ref: StoreRef) -> None:
        leaf.unlink()
        try:
            os.link(outside, leaf)
        except OSError:
            pytest.skip("hard-link creation unavailable in this environment")

    def writing_connect(*args: object, **kwargs: object):
        nonlocal connect_called
        connect_called = True
        connection = real_connect(*args, **kwargs)
        connection.execute("CREATE TABLE planted(value TEXT)")
        connection.commit()
        return connection

    monkeypatch.setattr(store, "_before_operation", swap_leaf)
    monkeypatch.setattr(store_module.sqlite3, "connect", writing_connect)

    with pytest.raises(ToolExecutionFailure):
        store.open_sqlite(ref)

    assert connect_called is False
    assert outside.read_bytes() == b""


def test_store_root_lock_is_not_evicted_while_a_store_is_live(tmp_path: Path) -> None:
    first = GuardedWorkspaceStore(tmp_path)
    for index in range(24):
        other_root = tmp_path / f"other-{index}"
        other_root.mkdir()
        GuardedWorkspaceStore(other_root)

    second = GuardedWorkspaceStore(tmp_path)

    assert first._lock is second._lock  # noqa: SLF001


def test_store_cache_identity_changes_when_the_workspace_object_changes(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    first = GuardedWorkspaceStore(root)
    root.replace(tmp_path / "workspace-old")
    root.mkdir()

    second = GuardedWorkspaceStore(root)

    assert first.cache_key != second.cache_key


def test_list_stops_scanning_at_the_requested_bound(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent_path = tmp_path / ".jenny" / "artifacts"
    parent_path.mkdir(parents=True)
    for index in range(10):
        (parent_path / f"{index}.txt").write_text(str(index), encoding="utf-8")
    real_scandir = os.scandir
    yielded = 0

    class CountingScandir:
        def __init__(self, path: Path) -> None:
            self._iterator = real_scandir(path)

        def __enter__(self) -> CountingScandir:
            return self

        def __exit__(self, *_args: object) -> None:
            self._iterator.close()

        def __iter__(self) -> CountingScandir:
            return self

        def __next__(self) -> os.DirEntry[str]:
            nonlocal yielded
            value = next(self._iterator)
            yielded += 1
            return value

    def counted_scandir(path: str | os.PathLike[str]) -> object:
        if Path(path) == parent_path:
            return CountingScandir(parent_path)
        return real_scandir(path)

    monkeypatch.setattr(store_module.os, "scandir", counted_scandir)
    store = GuardedWorkspaceStore(tmp_path)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        store.list_entries(
            store.resolve(WorkspaceStoreKind.ARTIFACTS),
            max_entries=1,
        )

    assert excinfo.value.code == CMP_TOOL_CAP_EXCEEDED
    assert yielded == 2


def test_checkpoint_source_read_refuses_the_link_identity_branch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.txt"
    source.write_text("source", encoding="utf-8")
    store = GuardedWorkspaceStore(tmp_path)
    real_resolve = store_module.resolve_workspace_leaf

    def marked_as_link(root: Path, requested: str):
        return replace(real_resolve(root, requested), is_link_object=True)

    monkeypatch.setattr(store_module, "resolve_workspace_leaf", marked_as_link)

    with pytest.raises(ToolExecutionFailure):
        store.read_workspace_source(source)

    assert source.read_text(encoding="utf-8") == "source"


def test_move_workspace_leaf_refuses_a_late_leaf_swap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.txt"
    displaced = tmp_path / "source-original.txt"
    replacement = tmp_path / "replacement.txt"
    source.write_text("original", encoding="utf-8")
    replacement.write_text("replacement", encoding="utf-8")
    identity = resolve_workspace_leaf(tmp_path, "source.txt")
    store = GuardedWorkspaceStore(tmp_path)
    destination = store.resolve(WorkspaceStoreKind.TRASH, "stamp/source.txt")

    def swap_leaf(_ref: StoreRef) -> None:
        source.replace(displaced)
        replacement.replace(source)

    monkeypatch.setattr(store, "_before_operation", swap_leaf)

    with pytest.raises(ToolExecutionFailure):
        store.move_workspace_leaf_atomic(identity, destination)

    assert source.read_text(encoding="utf-8") == "replacement"
    assert displaced.read_text(encoding="utf-8") == "original"
    assert not store.exists(destination)


def test_link_detection_branch_quarantines_leaf_without_following(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    leaf = tmp_path / ".jenny" / "tool-results" / "0123456789ab" / "status.json"
    leaf.parent.mkdir(parents=True)
    leaf.write_text("outside-shaped bytes", encoding="utf-8")
    real_is_link_object = store_module.is_link_object

    def mark_leaf_as_link(path: Path) -> bool:
        return path == leaf or real_is_link_object(path)

    monkeypatch.setattr(store_module, "is_link_object", mark_leaf_as_link)
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(
        WorkspaceStoreKind.TOOL_RESULTS,
        "0123456789ab/status.json",
    )

    assert store.read_bytes(ref, max_bytes=1024, missing_ok=True) is None
    assert not leaf.exists()
    quarantined = list((tmp_path / ".jenny" / "quarantine").iterdir())
    assert len(quarantined) == 1
    assert quarantined[0].read_text(encoding="utf-8") == "outside-shaped bytes"


def test_top_level_jenny_link_branch_is_deterministically_quarantined(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    jenny = tmp_path / ".jenny"
    unsafe = jenny / "artifacts" / "old.txt"
    unsafe.parent.mkdir(parents=True)
    unsafe.write_text("outside-shaped bytes", encoding="utf-8")
    unsafe_identity = store_module._node_identity(jenny)  # noqa: SLF001
    real_is_link_object = store_module.is_link_object

    def mark_original_jenny(path: Path) -> bool:
        if path == jenny:
            try:
                return store_module._node_identity(path).same_object(unsafe_identity)  # noqa: SLF001
            except ToolExecutionFailure:
                return False
        return real_is_link_object(path)

    monkeypatch.setattr(store_module, "is_link_object", mark_original_jenny)
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, "session/result.txt")

    store.write_text_atomic(ref, "inside")

    assert store.read_bytes(ref, max_bytes=16) == b"inside"
    quarantined = list((jenny / "quarantine").iterdir())
    assert len(quarantined) == 1
    assert (quarantined[0] / "artifacts" / "old.txt").read_text(encoding="utf-8") == (
        "outside-shaped bytes"
    )


def test_quarantine_link_branch_is_deterministically_repaired(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    quarantine = tmp_path / ".jenny" / "quarantine"
    quarantine.mkdir(parents=True)
    (quarantine / "keep.txt").write_text("outside-shaped bytes", encoding="utf-8")
    unsafe_identity = store_module._node_identity(quarantine)  # noqa: SLF001
    real_is_link_object = store_module.is_link_object

    def mark_original_quarantine(path: Path) -> bool:
        if path == quarantine:
            try:
                return store_module._node_identity(path).same_object(unsafe_identity)  # noqa: SLF001
            except ToolExecutionFailure:
                return False
        return real_is_link_object(path)

    monkeypatch.setattr(store_module, "is_link_object", mark_original_quarantine)
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.QUARANTINE, "probe.txt")

    store.write_text_atomic(ref, "inside")

    assert store.read_bytes(ref, max_bytes=16) == b"inside"
    repaired = [entry for entry in quarantine.iterdir() if entry.name != "probe.txt"]
    assert len(repaired) == 1
    assert (repaired[0] / "keep.txt").read_text(encoding="utf-8") == (
        "outside-shaped bytes"
    )


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
@pytest.mark.parametrize(
    "kind",
    [
        WorkspaceStoreKind.ARTIFACTS,
        WorkspaceStoreKind.BACKUPS,
        WorkspaceStoreKind.OMISSIONS,
        WorkspaceStoreKind.TOOL_RESULTS,
        WorkspaceStoreKind.TRASH,
    ],
)
def test_each_store_kind_quarantines_junction_root(
    tmp_path: Path,
    kind: WorkspaceStoreKind,
) -> None:
    outside = tmp_path / f"outside-{kind.value}"
    outside.mkdir()
    sentinel = outside / "keep.txt"
    sentinel.write_text("outside", encoding="utf-8")
    jenny = tmp_path / ".jenny"
    jenny.mkdir(exist_ok=True)
    junction = jenny / kind.value
    if not _make_junction(junction, outside):
        pytest.skip("mklink /J not permitted in this environment")
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(kind, "safe/result.txt")

    receipt = store.write_text_atomic(ref, "inside")

    assert Path(receipt.absolute_path).read_text(encoding="utf-8") == "inside"
    assert sentinel.read_text(encoding="utf-8") == "outside"
    assert list(outside.iterdir()) == [sentinel]
    quarantined = [
        entry for entry in (jenny / "quarantine").iterdir() if kind.value in entry.name
    ]
    assert len(quarantined) == 1
    os.rmdir(quarantined[0])


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_quarantine_kind_repairs_its_own_junction_root(tmp_path: Path) -> None:
    outside = tmp_path / "outside-quarantine"
    outside.mkdir()
    sentinel = outside / "keep.txt"
    sentinel.write_text("outside", encoding="utf-8")
    jenny = tmp_path / ".jenny"
    jenny.mkdir()
    junction = jenny / "quarantine"
    if not _make_junction(junction, outside):
        pytest.skip("mklink /J not permitted in this environment")
    store = GuardedWorkspaceStore(tmp_path)
    probe = store.resolve(WorkspaceStoreKind.QUARANTINE, "probe.txt")

    store.write_text_atomic(probe, "inside")

    assert store.read_bytes(probe, max_bytes=16) == b"inside"
    assert sentinel.read_text(encoding="utf-8") == "outside"
    assert list(outside.iterdir()) == [sentinel]
    quarantined = [entry for entry in (jenny / "quarantine").iterdir() if entry != junction]
    unsafe_layouts = [entry for entry in quarantined if store_module.is_link_object(entry)]
    assert len(unsafe_layouts) == 1
    os.rmdir(unsafe_layouts[0])


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_atomic_write_refuses_late_parent_junction_swap(tmp_path: Path, monkeypatch) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    parent = tmp_path / ".jenny" / "artifacts" / "session"
    moved_parent = tmp_path / ".jenny" / "artifacts" / "session-original"
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, "session/result.txt")
    outside_temp: Path | None = None

    def swap_parent(_ref: StoreRef) -> None:
        nonlocal outside_temp
        os.replace(parent, moved_parent)
        if not _make_junction(parent, outside):
            pytest.skip("mklink /J not permitted in this environment")
        temp_name = next(moved_parent.glob(".result.txt.*.tmp")).name
        outside_temp = outside / temp_name
        outside_temp.write_text("outside sentinel", encoding="utf-8")

    monkeypatch.setattr(store, "_before_operation", swap_parent)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        store.write_text_atomic(ref, "inside")

    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert outside_temp is not None
    assert outside_temp.read_text(encoding="utf-8") == "outside sentinel"
    assert not (outside / "result.txt").exists()
    os.rmdir(parent)


def test_recursive_delete_bound_quarantines_without_counting_success(tmp_path: Path) -> None:
    root = tmp_path / ".jenny" / "tool-results" / "old-job"
    root.mkdir(parents=True)
    (root / "one.txt").write_text("1", encoding="utf-8")
    (root / "two.txt").write_text("2", encoding="utf-8")
    store = GuardedWorkspaceStore(tmp_path)
    ref = store.resolve(WorkspaceStoreKind.TOOL_RESULTS, "old-job")

    outcome = store.delete(ref, recursive=True, max_entries=1)

    assert outcome.removed is False
    assert outcome.quarantined is True
    assert outcome.entries_removed == 0
    assert not root.exists()
    assert list((tmp_path / ".jenny" / "quarantine").iterdir())
