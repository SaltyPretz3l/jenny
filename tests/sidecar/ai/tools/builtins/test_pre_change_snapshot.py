from __future__ import annotations

import os
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import pre_change_snapshot, structured_diff


def _snapshot_path(root: Path, hash_value: str) -> Path:
    return root / f"{hash_value.removeprefix('sha256:')}.snap"


def test_capture_hash_matches_structured_diff_before_hash(tmp_path: Path) -> None:
    content = "first\r\nsecond\rthird\n"

    result = pre_change_snapshot.capture(str(tmp_path), "notes.txt", content)
    diff = structured_diff.compute_structured_diff(
        "notes.txt",
        content,
        "changed\n",
        status="modified",
    )

    assert result["stored"] is True
    assert diff is not None
    assert result["hash"] == diff["before_hash"]
    assert _snapshot_path(tmp_path, str(result["hash"])).read_text(encoding="utf-8") == (
        "first\nsecond\nthird\n"
    )


def test_capture_dedupes_existing_snapshot(tmp_path: Path) -> None:
    first = pre_change_snapshot.capture(str(tmp_path), "first.txt", "same\r\n")
    second = pre_change_snapshot.capture(str(tmp_path), "second.txt", "same\n")

    assert first["deduped"] is False
    assert second == {"stored": True, "hash": first["hash"], "deduped": True}
    assert len(list(tmp_path.glob("*.snap"))) == 1


def test_capture_rejects_too_large_text(tmp_path: Path) -> None:
    result = pre_change_snapshot.capture(
        str(tmp_path),
        "large.txt",
        "x" * (pre_change_snapshot.MAX_SNAPSHOT_BYTES + 1),
    )

    assert result["stored"] is False
    assert result["reason"] == "too_large"
    assert str(result["hash"]).startswith("sha256:")
    assert not list(tmp_path.glob("*.snap"))


@pytest.mark.parametrize("root", [None, "", "   "])
def test_capture_reports_unconfigured(root: str | None) -> None:
    assert pre_change_snapshot.capture(root, "notes.txt", "text") == {
        "stored": False,
        "reason": "unconfigured",
        "hash": "",
    }


def test_capture_rejects_non_text(tmp_path: Path) -> None:
    assert pre_change_snapshot.capture(str(tmp_path), "notes.txt", b"bytes") == {
        "stored": False,
        "reason": "not_text",
        "hash": "",
    }


def test_capture_returns_error_when_root_is_not_a_directory(tmp_path: Path) -> None:
    root = tmp_path / "root-file"
    root.write_text("occupied", encoding="utf-8")

    result = pre_change_snapshot.capture(str(root), "notes.txt", "text")

    assert result["stored"] is False
    assert result["reason"] == "error"
    assert str(result["hash"]).startswith("sha256:")


def test_capture_evicts_oldest_snapshot_by_count(tmp_path: Path) -> None:
    tmp_path.mkdir(exist_ok=True)
    for index in range(pre_change_snapshot.MAX_ENTRIES):
        path = tmp_path / f"{index:064x}.snap"
        path.write_text(str(index), encoding="utf-8")
        os.utime(path, (index + 1, index + 1))

    result = pre_change_snapshot.capture(str(tmp_path), "new.txt", "new snapshot")

    assert result["stored"] is True
    assert len(list(tmp_path.glob("*.snap"))) == pre_change_snapshot.MAX_ENTRIES
    assert not (tmp_path / f"{0:064x}.snap").exists()
    assert _snapshot_path(tmp_path, str(result["hash"])).exists()
