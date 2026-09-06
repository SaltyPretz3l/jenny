from __future__ import annotations

import os
from pathlib import Path

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore


def _fail_operation(monkeypatch: pytest.MonkeyPatch, operation: str, fail_at: int) -> None:
    calls = 0
    if operation == "mkdir":
        original = Path.mkdir

        def injected(path: Path, *args, **kwargs) -> None:
            nonlocal calls
            calls += 1
            if calls == fail_at:
                raise OSError("injected mkdir failure")
            original(path, *args, **kwargs)

        monkeypatch.setattr(Path, "mkdir", injected)
        return

    original = os.replace

    def injected(source, destination) -> None:
        nonlocal calls
        calls += 1
        if calls == fail_at:
            raise OSError("injected replace failure")
        original(source, destination)

    monkeypatch.setattr(os, "replace", injected)


@pytest.mark.parametrize(
    ("failure_stage", "operation", "fail_at"),
    (
        ("pending_mkdir", "mkdir", 1),
        ("quarantine_mkdir", "mkdir", 2),
        ("source_move", "replace", 1),
        ("final_move", "replace", 2),
    ),
)
def test_top_level_layout_failure_restores_original_object(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_stage: str,
    operation: str,
    fail_at: int,
) -> None:
    jenny = tmp_path / ".jenny"
    jenny.write_bytes(b"unsafe original")
    store = GuardedWorkspaceStore(tmp_path)
    _fail_operation(monkeypatch, operation, fail_at)

    with pytest.raises(ToolExecutionFailure):
        store._ensure_jenny_root(create=True)  # noqa: SLF001

    assert jenny.is_file(), failure_stage
    assert jenny.read_bytes() == b"unsafe original"
    assert list(tmp_path.glob(".jenny-quarantine-*.pending")) == []


@pytest.mark.parametrize(
    ("failure_stage", "operation", "fail_at"),
    (
        ("pending_mkdir", "mkdir", 1),
        ("staging_mkdir", "mkdir", 2),
        ("source_move", "replace", 1),
        ("final_move", "replace", 2),
    ),
)
def test_quarantine_layout_failure_restores_original_object(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_stage: str,
    operation: str,
    fail_at: int,
) -> None:
    jenny = tmp_path / ".jenny"
    quarantine = jenny / "quarantine"
    jenny.mkdir()
    quarantine.write_bytes(b"unsafe original")
    store = GuardedWorkspaceStore(tmp_path)
    _fail_operation(monkeypatch, operation, fail_at)

    with pytest.raises(ToolExecutionFailure):
        store._ensure_quarantine_dir()  # noqa: SLF001

    assert quarantine.is_file(), failure_stage
    assert quarantine.read_bytes() == b"unsafe original"
    assert list(jenny.glob(".quarantine-*.pending")) == []


def test_top_level_stranded_pending_is_reconciled_before_fresh_store_creation(
    tmp_path: Path,
) -> None:
    pending = tmp_path / ".jenny-quarantine-stranded.pending"
    pending.write_bytes(b"unsafe original")
    store = GuardedWorkspaceStore(tmp_path)

    store._ensure_jenny_root(create=True)  # noqa: SLF001

    assert not pending.exists()
    quarantined = list((tmp_path / ".jenny" / "quarantine").iterdir())
    assert len(quarantined) == 1
    assert quarantined[0].read_bytes() == b"unsafe original"


def test_quarantine_stranded_pending_is_reconciled_before_fresh_directory_creation(
    tmp_path: Path,
) -> None:
    jenny = tmp_path / ".jenny"
    jenny.mkdir()
    pending = jenny / ".quarantine-stranded.pending"
    pending.write_bytes(b"unsafe original")
    store = GuardedWorkspaceStore(tmp_path)

    quarantine = store._ensure_quarantine_dir()  # noqa: SLF001

    assert not pending.exists()
    quarantined = list(quarantine.iterdir())
    assert len(quarantined) == 1
    assert quarantined[0].read_bytes() == b"unsafe original"
