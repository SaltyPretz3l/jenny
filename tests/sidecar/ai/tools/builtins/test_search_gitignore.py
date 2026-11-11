"""grep_search and glob_files respect .gitignore through git's own inventory.

Also covers comma-list patterns and the include_glob walk anchor, which must
never change which files match.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.tools import workspace_manifest_policy as policy_module
from sidecar.ai.tools.builtins import glob_files as glob_module
from sidecar.ai.tools.builtins import grep_search as grep_module
from sidecar.ai.tools.builtins import grep_search_file as walk_module
from sidecar.ai.tools.builtins.grep_search_file import (
    BraceExpansionLimitError,
    expand_brace_patterns,
    iter_candidate_files,
    literal_anchor_directories,
    matches_relative_glob,
)
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar._platform_skips import make_dir_link

requires_git = pytest.mark.skipif(shutil.which("git") is None, reason="needs the git executable")


@pytest.fixture(autouse=True)
def _reset_grep_config() -> Iterator[None]:
    grep_module.configure_grep_search(None)
    yield
    grep_module.configure_grep_search(None)


def _write(path: Path, text: str = "needle\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _populate(root: Path) -> None:
    _write(root / ".gitignore", "build/\n*.log\n")
    _write(root / "README.md")
    _write(root / "src" / "app.py")
    _write(root / "src" / "app.js")
    _write(root / "src" / "debug.log")
    _write(root / "notes.log")
    _write(root / "untracked.txt")
    _write(root / "build" / "out.js", "needle\nonly_in_build\n")
    _write(root / "build" / "nested" / "deep.py")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    if shutil.which("git") is None:
        pytest.skip("needs the git executable")
    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    _populate(root)
    subprocess.run(["git", "add", ".gitignore", "README.md", "src/app.py"], cwd=root, check=True)
    return root


@pytest.fixture
def plain_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # A tmp folder can sit inside a repository (private basetemps do): pin it.
    monkeypatch.setattr(policy_module, "_git_marker_present", lambda _root: False)
    root = tmp_path / "plain"
    root.mkdir()
    _populate(root)
    return root


def _grep(root: Path, **arguments: object) -> grep_module.ToolHandlerResult:
    return grep_module.grep_search_tool(
        {"pattern": "needle", **arguments}, WorkspaceGuard(str(root))
    )


# --- gitignore -------------------------------------------------------------


def test_grep_skips_gitignored_files_and_directories(repo: Path) -> None:
    result = _grep(repo)

    for expected in ("README.md:1", "src/app.py:1", "src/app.js:1", "untracked.txt:1"):
        assert expected in result.output
    for ignored in ("build/", "notes.log", "debug.log"):
        assert ignored not in result.output
    assert result.metadata["ignored_directories_skipped"] == 1


def test_grep_explicit_path_into_an_ignored_directory_searches_it(repo: Path) -> None:
    result = _grep(repo, path="build")

    assert "build/out.js:1:needle" in result.output
    assert "build/nested/deep.py:1:needle" in result.output
    assert result.metadata["ignored_directories_skipped"] == 0


def test_grep_zero_matches_names_the_skipped_ignored_directories(repo: Path) -> None:
    result = grep_module.grep_search_tool({"pattern": "only_in_build"}, WorkspaceGuard(str(repo)))

    assert "No matches found" in result.output
    assert "Skipped 1 gitignored director" in result.output
    assert "pass a path inside one to search it" in result.output


def test_grep_with_matches_and_no_truncation_omits_the_skip_hint(repo: Path) -> None:
    result = _grep(repo)

    assert "gitignored" not in result.output


def test_non_git_folder_is_searched_as_before(plain_dir: Path) -> None:
    result = _grep(plain_dir)

    assert "build/out.js:1:needle" in result.output
    assert "notes.log:1:needle" in result.output
    assert result.metadata["ignored_directories_skipped"] == 0


@requires_git
def test_inventory_degradation_falls_back_to_the_filesystem_walk(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        policy_module,
        "_run_git_inventory_command",
        lambda _root, **_kwargs: (None, policy_module.INVENTORY_REASON_TIME_BUDGET),
    )

    result = _grep(repo)

    assert "build/out.js:1:needle" in result.output
    assert result.metadata["ignored_directories_skipped"] == 0


@requires_git
def test_inventory_crash_never_fails_the_tool(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(_root: Path, **_kwargs: object) -> object:
        raise RuntimeError("inventory exploded")

    monkeypatch.setattr(policy_module, "_run_git_inventory_command", explode)

    result = _grep(repo)

    assert result.success
    assert "build/out.js:1:needle" in result.output


@requires_git
def test_search_root_subdirectory_maps_inventory_paths(repo: Path) -> None:
    _write(repo / "src" / "inner" / "keep.py")
    _write(repo / "src" / "inner" / "drop.log")

    result = _grep(repo, path="src")

    assert "src/inner/keep.py:1" in result.output
    assert "src/app.py:1" in result.output
    assert "drop.log" not in result.output
    assert "debug.log" not in result.output


def test_glob_files_skips_gitignored_paths(repo: Path) -> None:
    guard = WorkspaceGuard(str(repo))

    result = glob_module.glob_files_tool({"pattern": "**/*.js"}, guard)

    assert "src/app.js" in result.output
    assert "build/out.js" not in result.output
    assert result.metadata["ignored_directories_skipped"] == 1

    explicit = glob_module.glob_files_tool({"pattern": "**/*.js", "path": "build"}, guard)
    assert "build/out.js" in explicit.output


def test_glob_files_zero_matches_names_the_skipped_ignored_directories(repo: Path) -> None:
    result = glob_module.glob_files_tool({"pattern": "**/deep.py"}, WorkspaceGuard(str(repo)))

    assert "No files matched" in result.output
    assert "Skipped 1 gitignored director" in result.output


def test_glob_files_in_a_plain_folder_is_unfiltered(plain_dir: Path) -> None:
    result = glob_module.glob_files_tool({"pattern": "**/*.log"}, WorkspaceGuard(str(plain_dir)))

    assert "notes.log" in result.output
    assert "src/debug.log" in result.output


# --- comma lists -----------------------------------------------------------


def test_comma_list_expands_like_braces() -> None:
    assert set(expand_brace_patterns("package.json, main.js")) == {"package.json", "main.js"}
    assert set(expand_brace_patterns("a.js, b.js, c.js")) == {"a.js", "b.js", "c.js"}
    assert set(expand_brace_patterns("{a,b}.js, src/*.py")) == {"a.js", "b.js", "src/*.py"}
    assert expand_brace_patterns("[a,b].txt") == ("[a,b].txt",)
    assert expand_brace_patterns("a.js,") == ("a.js",)


def test_comma_list_respects_the_expansion_bound() -> None:
    with pytest.raises(BraceExpansionLimitError):
        expand_brace_patterns(", ".join(f"f{index}.js" for index in range(40)))


def test_grep_include_glob_comma_list_matches_every_alternative(plain_dir: Path) -> None:
    result = _grep(plain_dir, include_glob="README.md, src/app.py")

    assert "README.md:1" in result.output
    assert "src/app.py:1" in result.output
    assert "untracked.txt" not in result.output
    assert result.metadata["file_count"] == 2


def test_glob_files_comma_list_matches_every_alternative(plain_dir: Path) -> None:
    guard = WorkspaceGuard(str(plain_dir))

    result = glob_module.glob_files_tool({"pattern": "README.md, src/*.py"}, guard)

    assert "README.md" in result.output
    assert "src/app.py" in result.output
    assert "app.js" not in result.output


# --- include_glob anchor ---------------------------------------------------


def test_literal_anchor_directories() -> None:
    assert literal_anchor_directories(("src/**/*.py",)) == ("src",)
    assert literal_anchor_directories(("src/a/*.py", "src/**/*.py")) == ("src",)
    assert literal_anchor_directories(("lib/x.txt", "src/main.js")) == ("lib", "src")
    assert literal_anchor_directories(("main.js",)) is None
    assert literal_anchor_directories(("src/main.js", "main.js")) is None
    assert literal_anchor_directories(("**/main.js",)) is None
    assert literal_anchor_directories(("src/../x/*.py",)) is None


_ANCHOR_FIXTURE = (
    "main.js",
    "src/main.js",
    "src/a.py",
    "src/a/b.py",
    "src/a/deep/c.py",
    "src/b/d.py",
    "lib/x.txt",
    "lib/sub/y.txt",
    "lib/src/z.py",
    "node_modules/pkg/main.js",
    "Docs/Guide.md",
)
_ANCHOR_PATTERNS = (
    ("src/**/*.py",),
    ("src/*.py",),
    ("src/a/*.py", "src/**/*.py"),
    ("lib/sub/*.txt", "src/main.js"),
    ("main.js",),
    ("src/main.js", "main.js"),
    ("**/main.js",),
    ("src/**",),
    ("node_modules/pkg/*.js",),
    ("linked/*.py",),
    ("missing/*.py",),
    ("docs/*.md",),
    ("lib/src/z.py",),
)


def _reference(root: Path, guard: WorkspaceGuard, patterns: tuple[str, ...]) -> list[Path]:
    return [
        candidate
        for candidate in iter_candidate_files(root, guard, None)
        if any(matches_relative_glob(candidate.relative_to(root).as_posix(), p) for p in patterns)
    ]


@pytest.mark.parametrize("patterns", _ANCHOR_PATTERNS, ids=",".join)
def test_anchored_walk_matches_the_unanchored_walk(
    tmp_path: Path, patterns: tuple[str, ...]
) -> None:
    for relative in _ANCHOR_FIXTURE:
        _write(tmp_path / relative)
    make_dir_link(tmp_path / "linked", tmp_path / "src")
    guard = WorkspaceGuard(str(tmp_path))

    anchored = list(iter_candidate_files(tmp_path, guard, patterns))

    assert anchored == _reference(tmp_path, guard, patterns)


def test_anchored_walk_only_scans_the_anchor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for relative in _ANCHOR_FIXTURE:
        _write(tmp_path / relative)
    scanned: list[str] = []
    original = os.scandir

    def counting(path):  # type: ignore[no-untyped-def]
        scanned.append(Path(path).name)
        return original(path)

    monkeypatch.setattr(walk_module.os, "scandir", counting)

    list(iter_candidate_files(tmp_path, WorkspaceGuard(str(tmp_path)), ("lib/sub/*.txt",)))

    assert scanned == ["sub"]


@requires_git
@pytest.mark.parametrize(
    "patterns", (("build/**/*.py",), ("src/*.log",), ("src/*.py", "build/*.js"))
)
def test_anchored_walk_respects_the_ignore_filter(repo: Path, patterns: tuple[str, ...]) -> None:
    from sidecar.ai.tools.builtins.search_ignore import load_search_ignore_filter

    guard = WorkspaceGuard(str(repo))
    reference_filter = load_search_ignore_filter(repo)
    anchored_filter = load_search_ignore_filter(repo)
    assert reference_filter is not None and anchored_filter is not None

    reference = [
        candidate
        for candidate in iter_candidate_files(repo, guard, None, ignore_filter=reference_filter)
        if any(matches_relative_glob(candidate.relative_to(repo).as_posix(), p) for p in patterns)
    ]
    anchored = list(iter_candidate_files(repo, guard, patterns, ignore_filter=anchored_filter))

    assert anchored == reference
    assert all("build" not in path.parts for path in anchored)


def test_a_root_without_a_filter_is_not_reread_until_the_ttl_passes(tmp_path, monkeypatch):
    from sidecar.ai.tools.builtins import search_ignore

    calls = []
    clock = [1000.0]
    monkeypatch.setattr(search_ignore, "_no_filter_until", {})
    monkeypatch.setattr(search_ignore.time, "monotonic", lambda: clock[0])

    def no_inventory(root, *, timeout_seconds):
        calls.append(root)

    monkeypatch.setattr(search_ignore, "read_covering_git_inventory", no_inventory)

    assert search_ignore.load_search_ignore_filter(tmp_path) is None
    assert search_ignore.load_search_ignore_filter(tmp_path) is None
    assert len(calls) == 1
    clock[0] += search_ignore._NO_FILTER_TTL_SECONDS + 1
    assert search_ignore.load_search_ignore_filter(tmp_path) is None
    assert len(calls) == 2


def test_a_usable_inventory_is_read_on_every_call(tmp_path, monkeypatch):
    from sidecar.ai.tools.builtins import search_ignore
    from sidecar.ai.tools.workspace_manifest_policy import GitPathInventory

    calls = []
    monkeypatch.setattr(search_ignore, "_no_filter_until", {})

    def inventory(root, *, timeout_seconds):
        calls.append(root)
        return GitPathInventory(files=frozenset(), directories=frozenset())

    monkeypatch.setattr(search_ignore, "read_covering_git_inventory", inventory)
    assert search_ignore.load_search_ignore_filter(tmp_path) is not None
    assert search_ignore.load_search_ignore_filter(tmp_path) is not None
    assert len(calls) == 2


@pytest.mark.parametrize(
    ("pattern", "expected"),
    [
        ("package.json, main.js", ("package.json", "main.js")),
        ("src/*.py,tests/*.py", ("src/*.py", "tests/*.py")),
        ("Smith, John.docx", ("Smith, John.docx",)),
        ("report,2024.csv", ("report,2024.csv",)),
    ],
)
def test_a_comma_splits_only_between_file_patterns(pattern, expected):
    from sidecar.ai.tools.builtins.grep_search_file import split_top_level_commas

    assert split_top_level_commas(pattern) == expected


def test_grep_reports_ignored_directories_the_scan_reached_not_the_walk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The walk runs a batch ahead of the scan; a search that stops early must
    # still report the count the old one-file-at-a-time loop saw (row 124 P1).
    if shutil.which("git") is None:
        pytest.skip("needs the git executable")
    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    _write(root / ".gitignore", "b/ign/\n")
    for index in range(1, 6):
        _write(root / f"r{index}.txt")
    _write(root / "b" / "keep.txt")
    _write(root / "b" / "ign" / "hidden.txt")

    whole = grep_module.grep_search_tool({"pattern": "needle"}, WorkspaceGuard(str(root)))
    assert whole.metadata["ignored_directories_skipped"] == 1

    stop = {"now": False}
    original_apply = grep_module._CandidateScan._apply

    def apply_then_stop(self: object, path: Path, outcome: object) -> bool:
        kept = original_apply(self, path, outcome)  # type: ignore[arg-type]
        stop["now"] = stop["now"] or path.name == "r3.txt"
        return kept

    monkeypatch.setattr(grep_module._CandidateScan, "_apply", apply_then_stop)
    monkeypatch.setattr(grep_module, "_runtime_budget_exhausted", lambda _started: stop["now"])

    stopped = grep_module.grep_search_tool({"pattern": "needle"}, WorkspaceGuard(str(root)))

    assert stopped.metadata["aborted_by_runtime_budget"] is True
    assert "r3.txt:1:needle" in stopped.output
    assert "r4.txt" not in stopped.output
    assert stopped.metadata["ignored_directories_skipped"] == 0
