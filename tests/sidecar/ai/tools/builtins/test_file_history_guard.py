"""Guard tests for the guarded-store-owned file-history checkpoint path."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import file_history as file_history_module
from sidecar.ai.tools.contracts import ToolExecutionFailure


def _make_junction(link: Path, target: Path) -> bool:
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.returncode == 0


def test_create_checkpoint_happy_path_is_unaffected(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    info = file_history_module.create_checkpoint(target, tmp_path)

    assert info.created is True
    assert info.display_path is not None
    snapshot_path = tmp_path / Path(info.display_path)
    assert snapshot_path.read_text(encoding="utf-8") == "hello\n"


def test_create_checkpoint_propagates_guarded_store_refusal_before_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    def _fail(*_args: object, **_kwargs: object) -> object:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message="workspace store parent changed before use",
            retryable=True,
        )

    # WIDE-044: the guarded source read is the seam now (create_checkpoint
    # reads once for content-identity dedupe and snapshots those bytes).
    monkeypatch.setattr(
        file_history_module.GuardedWorkspaceStore,
        "read_workspace_source",
        _fail,
    )

    with pytest.raises(ToolExecutionFailure) as excinfo:
        file_history_module.create_checkpoint(target, tmp_path)
    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    # Fail-closed: no snapshot and no metadata may exist. (The self-lock —
    # WIDE-044 — legitimately creates the backups dir + <hash>.lock before
    # the read, so the old "backups dir absent" assertion no longer applies.)
    backups = tmp_path / ".jenny" / "backups"
    if backups.exists():
        residue = [p.name for p in backups.iterdir() if not p.name.endswith(".lock")]
        assert residue == []


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_create_checkpoint_quarantines_junctioned_backups_dir(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    jenny = tmp_path / ".jenny"
    jenny.mkdir()

    if not _make_junction(jenny / "backups", elsewhere):
        pytest.skip("mklink /J not permitted in this environment")
    info = file_history_module.create_checkpoint(target, tmp_path)

    assert info.created is True
    assert list(elsewhere.iterdir()) == []
    assert any(
        entry.name.startswith("backups-backups")
        for entry in (jenny / "quarantine").iterdir()
    )
