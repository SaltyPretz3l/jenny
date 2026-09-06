from __future__ import annotations

import contextlib
from pathlib import Path

import pytest

import sidecar.ai.tools.builtins.filesystem_listing as listing_module
from sidecar.ai.tools.builtins.filesystem_listing import format_entry_size, list_dir_tool
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def test_list_dir_retains_only_alphabetically_smallest_bounded_candidates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ["zeta.txt", "beta.txt", "delta.txt", "alpha.txt", "gamma.txt"]:
        (tmp_path / name).write_text(name, encoding="utf-8")
    (tmp_path / "aardvark").mkdir()
    monkeypatch.setattr(listing_module, "MAX_LIST_ENTRIES", 3)

    output = list_dir_tool({"path": "."}, _guard(tmp_path))

    assert output.output.splitlines() == [
        "path: . (workspace-relative) entries: 3",
        "",
        "[D] aardvark",
        "[F] alpha.txt  9B",
        "[F] beta.txt  8B",
        "...[directory listing truncated]",
    ]
    assert output.metadata["truncated"] is True
    assert output.metadata["totals_known"] is True


def test_list_dir_empty_directory_output_remains_compatible(tmp_path: Path) -> None:
    result = list_dir_tool({"path": "."}, _guard(tmp_path))

    assert result.output == "path: . (workspace-relative) entries: 0\n\n(empty directory)"
    assert result.metadata["total_entries"] == 0


def test_list_dir_stops_at_scan_budget_and_marks_unknown_total(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for index in range(8):
        (tmp_path / f"file-{index}.txt").write_text("x", encoding="utf-8")
    monkeypatch.setattr(listing_module, "MAX_LIST_SCAN_ENTRIES", 3)

    result = list_dir_tool({"path": "."}, _guard(tmp_path))

    assert result.metadata == {
        "returned_count": 3,
        "total_size_bytes": 3,
        "entries_scanned": 3,
        "entries_skipped": 0,
        "truncated": True,
        "totals_known": False,
        "total_entries": None,
        "cursor": None,
    }


def test_list_dir_isolates_per_entry_is_dir_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One entry whose is_dir() raises (a broken link, a permission error, a race
    with a concurrent delete, ...) must not fail the whole listing, and the
    metadata must stay truthful about what actually made it into the output."""
    (tmp_path / "alpha.txt").write_text("a", encoding="utf-8")
    (tmp_path / "zeta.txt").write_text("z", encoding="utf-8")

    class _BrokenEntry:
        name = "broken-entry"

        def is_dir(self, follow_symlinks: bool = False) -> bool:  # noqa: FBT001, FBT002
            raise OSError("stat failed for broken-entry")

    real_scandir = listing_module.os.scandir

    def _scandir_with_one_broken_entry(path: object):
        real_entries = list(real_scandir(path))
        return contextlib.nullcontext(iter([*real_entries, _BrokenEntry()]))

    monkeypatch.setattr(listing_module.os, "scandir", _scandir_with_one_broken_entry)

    result = list_dir_tool({"path": "."}, _guard(tmp_path))

    assert result.output.splitlines() == [
        "path: . (workspace-relative) entries: 2",
        "",
        "[F] alpha.txt  1B",
        "[F] zeta.txt  1B",
        "...[directory listing truncated]",
        "...[1 entries could not be inspected and were skipped]",
    ]
    # returned_count must reflect what was actually emitted (2), not the 3 raw
    # candidates retained before the isolated is_dir() failure was skipped.
    assert result.metadata["returned_count"] == 2
    assert result.metadata["entries_skipped"] == 1
    assert result.metadata["total_size_bytes"] == 2
    assert result.metadata["entries_scanned"] == 3
    # The directory truly has 3 names in it -- that total is still known even
    # though one of them couldn't be classified as a file or directory.
    assert result.metadata["totals_known"] is True
    assert result.metadata["total_entries"] == 3
    assert result.metadata["truncated"] is True


@pytest.mark.parametrize(
    ("size_bytes", "expected"),
    [
        (0, "0B"),
        (1023, "1023B"),
        (1024, "1.0K"),
        (1536, "1.5K"),
        # One byte under 1 MiB must promote the unit, not render "1024.0K".
        (1024**2 - 1, "1.0M"),
        (128 * 1024**2 + 512 * 1024, "128.5M"),
        (1024**3, "1.0G"),
        (1024**4, "1.0T"),
    ],
)
def test_format_entry_size_uses_binary_units(size_bytes: int, expected: str) -> None:
    assert format_entry_size(size_bytes) == expected


def test_list_dir_reports_file_sizes_and_sums_listed_files(tmp_path: Path) -> None:
    (tmp_path / "alpha.txt").write_bytes(b"abc")
    (tmp_path / "beta.txt").write_bytes(b"12345")

    result = list_dir_tool({"path": "."}, _guard(tmp_path))

    assert result.output.splitlines() == [
        "path: . (workspace-relative) entries: 2",
        "",
        "[F] alpha.txt  3B",
        "[F] beta.txt  5B",
    ]
    assert result.metadata["total_size_bytes"] == 8
    assert "size_unknown_entries" not in result.metadata


def test_list_dir_does_not_add_a_size_column_to_directories(tmp_path: Path) -> None:
    (tmp_path / "nested").mkdir()

    result = list_dir_tool({"path": "."}, _guard(tmp_path))

    assert result.output.splitlines() == [
        "path: . (workspace-relative) entries: 1",
        "",
        "[D] nested",
    ]
    assert result.metadata["total_size_bytes"] == 0


def test_list_dir_keeps_file_when_stat_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "unreadable.txt").write_text("content", encoding="utf-8")

    class _StatBrokenEntry:
        def __init__(self, entry: object) -> None:
            self._entry = entry
            self.name = entry.name

        def is_dir(self, follow_symlinks: bool = False) -> bool:  # noqa: FBT001, FBT002
            return self._entry.is_dir(follow_symlinks=follow_symlinks)

        def stat(self, follow_symlinks: bool = False) -> object:  # noqa: FBT001, FBT002
            raise OSError("size unavailable")

    real_scandir = listing_module.os.scandir

    def _scandir_with_stat_failure(path: object):
        real_entries = list(real_scandir(path))
        wrapped = [_StatBrokenEntry(entry) for entry in real_entries]
        return contextlib.nullcontext(iter(wrapped))

    monkeypatch.setattr(listing_module.os, "scandir", _scandir_with_stat_failure)

    result = list_dir_tool({"path": "."}, _guard(tmp_path))

    assert "[F] unreadable.txt  ?" in result.output.splitlines()
    assert result.metadata["entries_skipped"] == 0
    assert result.metadata["total_size_bytes"] == 0
    # Without this, total_size_bytes under-reports with no signal at all.
    assert result.metadata["size_unknown_entries"] == 1
    assert result.metadata["truncated"] is False


def test_list_dir_total_size_excludes_files_omitted_by_output_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "a").write_bytes(b"x")
    (tmp_path / "b").write_bytes(b"y" * 100)
    monkeypatch.setattr(listing_module, "MAX_LIST_OUTPUT_CHARS", 9)

    result = list_dir_tool({"path": "."}, _guard(tmp_path))

    assert "[F] a  1B" in result.output.splitlines()
    assert "[F] b  100B" not in result.output.splitlines()
    assert result.metadata["total_size_bytes"] == 1
    assert result.metadata["truncation_reason"] == "output_chars"


def test_list_dir_applies_its_output_budget_before_router_truncation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for index in range(8):
        (tmp_path / f"long-file-{index}.txt").write_text("x", encoding="utf-8")
    monkeypatch.setattr(listing_module, "MAX_LIST_OUTPUT_CHARS", 45)

    result = list_dir_tool({"path": "."}, _guard(tmp_path))

    assert result.metadata["truncated"] is True
    assert result.metadata["truncation_reason"] == "output_chars"
    assert result.metadata["omitted_output_entries"] > 0
    assert result.metadata["returned_count"] == len(
        [line for line in result.output.splitlines() if line.startswith("[F]")]
    )
