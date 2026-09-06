from __future__ import annotations

import contextlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.tools import workspace_manifest
from sidecar.ai.tools import workspace_manifest_policy as policy_module
from sidecar.ai.tools import workspace_manifest_scan as scan_module
from sidecar.ai.tools.builtins.filesystem import read_file_tool
from sidecar.ai.tools.builtins.workspace_manifest_tool import workspace_manifest_read_tool
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_manifest import (
    WorkspaceManifestCache,
    WorkspaceManifestLimits,
    build_workspace_manifest,
    render_workspace_manifest_block,
    summarize_workspace_manifest,
)


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_build_workspace_manifest_collects_workspace_signals(
    tmp_path: Path,
    monkeypatch,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    _write(
        root / "README.md",
        "Jenny example workspace.\n\nThis repository demonstrates the runtime manifest.",
    )
    _write(root / "package.json", "{}")
    _write(root / "pyproject.toml", "[project]\nname = 'demo'\n")
    _write(root / "src" / "index.ts", "export const ok = true;\n")
    _write(root / "main.py", "print('hello')\n")
    _write(root / "node_modules" / "ignored" / "index.js", "ignored\n")
    _write(root / ".jenny" / "ignored.py", "ignored\n")

    # Pin the non-repository path: a tmp workspace can itself sit inside a
    # repository (private basetemps do), which would change the inventory mode.
    monkeypatch.setattr(policy_module, "_git_marker_present", lambda _root: False)
    monkeypatch.setattr(
        workspace_manifest,
        "_build_git_snapshot",
        lambda _root, **_kwargs: {
            "available": True,
            "known": True,
            "branch": "main",
            "ahead": 1,
            "behind": 2,
            "dirty_count": 3,
            "head_sha7": "abc1234",
        },
    )

    manifest = build_workspace_manifest(root)

    assert manifest["version"] == 2
    assert manifest["root"] == str(root.resolve())
    assert manifest["project_type"] == ["node", "python"]
    assert manifest["project_markers"] == ["package.json", "pyproject.toml"]
    assert manifest["readme_excerpt"].startswith("Jenny example workspace.")
    assert "src/index.ts" in manifest["entry_points"]
    assert "main.py" in manifest["entry_points"]
    assert manifest["extension_counts"][".ts"] == 1
    assert manifest["extension_counts"][".py"] == 1
    assert "package.json" not in {entry["name"] for entry in manifest["top_dirs"]}
    assert "src" in {entry["name"] for entry in manifest["top_dirs"]}
    assert all(
        not recent["path"].startswith(("node_modules/", ".jenny/"))
        for recent in manifest["recent_files"]
    )
    assert manifest["git"]["dirty_count"] == 3
    assert manifest["totals"]["truncated"] is False
    assert manifest["classification_counts"]["source"] == 2
    assert manifest["ranked_files"][0]["path"] == "main.py"
    assert manifest["diagnostics"]["orientation"]["inventory"]["status"] == "not_repository"


def test_build_workspace_manifest_marks_truncated_when_entry_cap_is_hit(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    for index in range(6):
        _write(root / "src" / f"file_{index}.py", "x = 1\n")

    manifest = build_workspace_manifest(
        root,
        limits=WorkspaceManifestLimits(max_entries=3, max_depth=4, wall_budget_seconds=10.0),
    )

    assert manifest["totals"]["truncated"] is True
    assert manifest["totals"]["entries_scanned"] == 3


def test_manifest_v2_honors_git_and_jenny_ignores_without_changing_access_or_git_truth(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    _run_git(root, "init")
    _run_git(root, "config", "user.email", "jenny@example.invalid")
    _run_git(root, "config", "user.name", "Jenny Test")
    _write(root / ".gitignore", "ignored/\n*.tmp\n!keep.tmp\n")
    _write(root / "src" / "main.py", "print('tracked')\n")
    _run_git(root, "add", ".gitignore", "src/main.py")
    _run_git(root, "commit", "-m", "fixture")

    _write(root / ".jennyignore", "/private/\n")
    _write(root / "src" / ".gitignore", "generated.py\n")
    _write(root / "src" / "generated.py", "ignored by nested git rules\n")
    _write(root / "ignored" / "decoy.py", "ignored by git\n")
    _write(root / "scratch.tmp", "ignored by git\n")
    _write(root / "keep.tmp", "git negation keeps this\n")
    _write(root / "private" / "hidden.py", "hidden from orientation\n")

    manifest = build_workspace_manifest(root)
    ranked_paths = {entry["path"] for entry in manifest["ranked_files"]}

    assert manifest["version"] == 2
    assert manifest["diagnostics"]["orientation"]["inventory"] == {
        "mode": "git",
        "status": "complete",
        "degraded_reason": None,
        "paths_indexed": 6,
    }
    assert manifest["extension_counts"][".py"] == 1
    assert "src/main.py" in ranked_paths
    assert "keep.tmp" in ranked_paths
    assert "ignored/decoy.py" not in ranked_paths
    assert "scratch.tmp" not in ranked_paths
    assert "private/hidden.py" not in ranked_paths
    assert "src/generated.py" not in ranked_paths
    assert manifest["totals"]["orientation_excluded_entries"] >= 3

    expected_dirty_count = sum(
        1
        for line in _run_git(root, "status", "--porcelain=v1").splitlines()
        if line.strip()
    )
    assert manifest["git"]["dirty_count"] == expected_dirty_count
    assert "hidden from orientation" in read_file_tool(
        {"path": "private/hidden.py"}, WorkspaceGuard(str(root))
    ).output
    assert "ignored by git" in read_file_tool(
        {"path": "ignored/decoy.py"}, WorkspaceGuard(str(root))
    ).output


def test_jennyignore_negation_requires_a_traversable_parent(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    _write(root / ".jennyignore", "ignored/*\n!ignored/keep.py\n")
    _write(root / "ignored" / "drop.py", "drop\n")
    _write(root / "ignored" / "keep.py", "keep\n")

    reincluded = build_workspace_manifest(root)
    reincluded_paths = {entry["path"] for entry in reincluded["ranked_files"]}
    assert "ignored/keep.py" in reincluded_paths
    assert "ignored/drop.py" not in reincluded_paths

    _write(root / ".jennyignore", "ignored/\n!ignored/keep.py\n")
    pruned_parent = build_workspace_manifest(root)
    pruned_paths = {entry["path"] for entry in pruned_parent["ranked_files"]}
    assert "ignored/keep.py" not in pruned_paths


def _run_git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout


def _stub_git(monkeypatch) -> None:
    monkeypatch.setattr(
        workspace_manifest,
        "_build_git_snapshot",
        lambda _root, **_kwargs: {"available": False, "known": True},
    )


class _FakeDirStat:
    st_file_attributes = 0
    st_mtime = 0.0


class _FakeDirEntry:
    """Directory-shaped dirent for lazily faking huge trees via os.scandir."""

    def __init__(self, path: Path) -> None:
        self.path = str(path)
        self.name = path.name

    def is_symlink(self) -> bool:
        return False

    def is_dir(self, follow_symlinks: bool = True) -> bool:  # noqa: FBT001, FBT002
        return True

    def is_file(self, follow_symlinks: bool = True) -> bool:  # noqa: FBT001, FBT002
        return False

    def stat(self, follow_symlinks: bool = True) -> _FakeDirStat:  # noqa: FBT001, FBT002
        return _FakeDirStat()


def test_scan_stops_at_directory_budget_on_20k_directory_tree(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A >20k-directory tree must stop at the directory budget DURING iteration:
    only the budgeted number of directories may ever be scandir-opened (work
    actually stops), directories_scanned must be truthful, and cursor metadata
    must let the caller tell the scan was partial and what remained."""
    root = tmp_path / "workspace"
    root.mkdir()
    branch = 143  # 1 + 143 + 143*143 = 20,593 directories in the faked tree.
    scandir_opened: list[str] = []

    def fake_scandir(path: object):
        current = Path(str(path))
        scandir_opened.append(str(current))
        depth = len(current.relative_to(root).parts)
        children = (
            iter([])
            if depth >= 2
            else iter(_FakeDirEntry(current / f"d{index:03d}") for index in range(branch))
        )
        return contextlib.nullcontext(children)

    monkeypatch.setattr(scan_module.os, "scandir", fake_scandir)

    # Exercise the traversal directly: build_workspace_manifest would also glob
    # for README files (pathlib globbing uses os.scandir too), which would blur
    # the "exactly N directories were opened" work-stoppage assertion below.
    scan = scan_module.scan_workspace(
        root,
        WorkspaceManifestLimits(
            max_entries=1_000_000,
            max_depth=4,
            wall_budget_seconds=1_000_000.0,
            max_directories=25,
        ),
        # An explicit policy keeps policy-building work (which probes the root
        # when an enclosing repository is present) out of the count below.
        policy=policy_module.ManifestScanPolicy(
            inventory_files=None,
            inventory_directories=frozenset(),
            inventory_status="not_repository",
            inventory_degraded_reason=None,
            ignore_sources=(),
        ),
    )

    assert scan["directories_scanned"] == 25
    assert len(scandir_opened) == 25  # enumeration work stopped, not just reporting
    assert scan["truncated"] is True
    assert scan["truncation_reason"] == "directory_budget"
    assert scan["totals_known"] is False
    cursor = scan["cursor"]
    assert isinstance(cursor, dict)
    assert cursor["pending_directories"] > 0
    assert isinstance(cursor["next_directory"], str) and cursor["next_directory"]


def test_scan_stops_on_elapsed_time_budget_mid_scan(tmp_path: Path, monkeypatch) -> None:
    """Elapsed-time budget expiry (driven by an injected fake clock, no real
    waiting) must stop the scan mid-flight with a truthful time_budget reason."""
    root = tmp_path / "workspace"
    root.mkdir()
    for index in range(4):
        directory = root / f"dir_{index}"
        directory.mkdir()
        (directory / f"file_{index}.py").write_text("x = 1\n", encoding="utf-8")

    ticks = {"now": 0.0}

    def fake_clock() -> float:
        ticks["now"] += 0.30
        return ticks["now"]

    _stub_git(monkeypatch)
    manifest = build_workspace_manifest(
        root,
        limits=WorkspaceManifestLimits(wall_budget_seconds=1.0),
        clock=fake_clock,
    )

    totals = manifest["totals"]
    assert totals["truncated"] is True
    assert totals["truncation_reason"] == "time_budget"
    assert totals["totals_known"] is False
    # 5 directories exist (root + 4); the fake clock expires the budget long
    # before all of them can be visited.
    assert 1 <= totals["directories_scanned"] < 5
    assert totals["cursor"] is not None


def test_readme_excerpt_reads_bounded_prefix_of_huge_readme(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A huge README must be read through one bounded os.read of the opened
    no-follow handle — asserted on the bytes actually requested/returned from
    the file descriptor, not merely on the final excerpt length."""
    root = tmp_path / "workspace"
    root.mkdir()
    huge_readme = root / "README.md"
    huge_readme.write_text("word " * 400_000, encoding="utf-8")  # ~2 MB
    assert huge_readme.stat().st_size > 4 * scan_module.README_MAX_READ_BYTES

    reads: list[tuple[int, int]] = []
    real_os_read = os.read

    def spying_os_read(fd: int, size: int) -> bytes:
        data = real_os_read(fd, size)
        reads.append((size, len(data)))
        return data

    _stub_git(monkeypatch)
    monkeypatch.setattr(scan_module.os, "read", spying_os_read)

    manifest = build_workspace_manifest(root)

    assert manifest["readme_excerpt"].startswith("word")
    assert len(manifest["readme_excerpt"]) <= scan_module.README_MAX_CHARS + len("...")
    assert reads, "README was not read through the bounded os.read path"
    assert all(requested <= scan_module.README_MAX_READ_BYTES for requested, _ in reads)
    assert sum(returned for _, returned in reads) <= scan_module.README_MAX_READ_BYTES


def _make_dir_link(link: Path, target: Path) -> bool:
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except (NotImplementedError, OSError):
        pass
    if os.name != "nt":
        return False
    completed = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )
    return completed.returncode == 0


def test_scan_refuses_linked_directory_and_continues(tmp_path: Path, monkeypatch) -> None:
    """A planted symlink/junction directory must be refused (never followed),
    while the rest of the scan continues and the refusal is surfaced truthfully."""
    root = tmp_path / "workspace"
    root.mkdir()
    real_dir = root / "real_dir"
    real_dir.mkdir()
    (real_dir / "main.py").write_text("print('ok')\n", encoding="utf-8")
    outside = tmp_path / "outside_target"
    outside.mkdir()
    (outside / "leaked.py").write_text("leaked = True\n", encoding="utf-8")
    if not _make_dir_link(root / "linked_dir", outside):
        pytest.skip("symlink/junction creation unavailable in this environment")

    _stub_git(monkeypatch)
    manifest = build_workspace_manifest(root)

    top_dir_names = {entry["name"] for entry in manifest["top_dirs"]}
    assert "real_dir" in top_dir_names  # scan continued past the refused link
    assert "linked_dir" not in top_dir_names
    assert all(
        not recent["path"].startswith("linked_dir/") for recent in manifest["recent_files"]
    )
    assert "real_dir/main.py" in manifest["entry_points"]
    totals = manifest["totals"]
    assert totals["links_skipped"] == 1
    # A policy refusal is not a budget truncation: totals for the traversable
    # tree remain complete and known.
    assert totals["truncated"] is False
    assert totals["totals_known"] is True
    assert totals["cursor"] is None


class _FakeOutput:
    truncated = False


class _FakeCompleted:
    """Shape of OwnedProcessResult as `_run_git` consumes it."""

    def __init__(self, stdout: str) -> None:
        self.stdout = stdout
        self.returncode = 0
        self.timed_out = False
        self.aborted = False
        self.output = _FakeOutput()


_GIT_RESPONSES = {
    ("rev-parse", "--is-inside-work-tree"): "true",
    ("rev-parse", "--abbrev-ref", "HEAD"): "feature/deadline",
    ("rev-parse", "--short=7", "HEAD"): "abc1234",
    ("status", "--porcelain=v1", "--branch"): (
        "## feature/deadline...origin/feature/deadline [ahead 2, behind 1]\n"
        " M alpha.py\n"
        " M beta.py\n"
        "?? gamma.py\n"
    ),
}


def _install_recording_git(monkeypatch) -> list[float]:
    """Serve canned git output, recording the timeout each command was granted."""
    granted_timeouts: list[float] = []

    def run(argv, *, cwd, timeout_seconds):  # noqa: ARG001 - cwd is unused here.
        granted_timeouts.append(timeout_seconds)
        return _FakeCompleted(_GIT_RESPONSES[tuple(argv[3:])])

    service = type("RecordingService", (), {"run": staticmethod(run)})()
    monkeypatch.setattr(
        workspace_manifest,
        "get_owned_process_service",
        lambda: service,
    )
    return granted_timeouts


def test_git_snapshot_keeps_a_usable_budget_after_a_scan_that_burns_the_wall_budget(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """The git snapshot runs LAST, so it must own a fresh budget rather than the
    leftovers of the scan's. The scan stops only when it trips wall_budget_seconds,
    so a shared deadline arrives here fully spent and git is skipped entirely --
    which is how an unmeasured working tree got reported as clean."""
    root = tmp_path / "workspace"
    root.mkdir()
    for index in range(4):
        directory = root / f"dir_{index}"
        directory.mkdir()
        (directory / f"file_{index}.py").write_text("x = 1\n", encoding="utf-8")

    ticks = {"now": 0.0}

    def fake_clock() -> float:
        ticks["now"] += 0.30
        return ticks["now"]

    granted_timeouts = _install_recording_git(monkeypatch)

    manifest = build_workspace_manifest(
        root,
        limits=WorkspaceManifestLimits(wall_budget_seconds=1.0, git_budget_seconds=4.0),
        clock=fake_clock,
    )

    # The scan consumed the entire shared wall budget ...
    assert manifest["totals"]["truncation_reason"] == "time_budget"
    # ... and git still got to run all four commands on a real, positive timeout.
    assert len(granted_timeouts) == len(_GIT_RESPONSES)
    assert all(timeout > 0 for timeout in granted_timeouts)
    assert manifest["git"] == {
        "available": True,
        "known": True,
        "branch": "feature/deadline",
        "ahead": 2,
        "behind": 1,
        "dirty_count": 3,
        "head_sha7": "abc1234",
    }


def test_starved_git_snapshot_reports_unknown_rather_than_zeros(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A git snapshot cut short mid-way must report ahead/behind/dirty_count as
    unknown. Reporting them as 0 states that the tree is clean and in sync --
    a falsehood, not an absence, whenever the working tree is actually dirty."""
    root = tmp_path / "workspace"
    root.mkdir()
    _install_recording_git(monkeypatch)

    # One clock tick per git command. The budget survives the three rev-parse
    # calls, then expires before `git status` can run.
    times = iter([0.0, 0.0, 0.0, 99.0])
    latest = {"value": 99.0}

    def expiring_clock() -> float:
        latest["value"] = next(times, latest["value"])
        return latest["value"]

    snapshot = workspace_manifest._build_git_snapshot(  # noqa: SLF001
        root,
        deadline_monotonic=10.0,
        clock=expiring_clock,
    )

    assert snapshot["available"] is True
    assert snapshot["known"] is False
    assert snapshot["branch"] == "feature/deadline"
    assert snapshot["ahead"] is None
    assert snapshot["behind"] is None
    assert snapshot["dirty_count"] is None
    assert snapshot["degraded_reason"] == "budget_exhausted"


def test_git_snapshot_does_not_claim_not_a_repository_when_the_check_never_ran(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A budget exhausted before the first command means repo-ness was never
    established; that must stay distinguishable from a confirmed non-repo."""
    root = tmp_path / "workspace"
    root.mkdir()

    def fail_run(*_args, **_kwargs):
        raise AssertionError("git should not run once the git budget is exhausted")

    fail_service = type("FailService", (), {"run": staticmethod(fail_run)})()
    monkeypatch.setattr(
        workspace_manifest,
        "get_owned_process_service",
        lambda: fail_service,
    )

    assert workspace_manifest._build_git_snapshot(  # noqa: SLF001
        root,
        deadline_monotonic=0.0,
    ) == {
        "available": False,
        "known": False,
        "degraded_reason": "budget_exhausted",
    }


def test_confirmed_non_repository_stays_a_known_answer(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    def run(argv, *, cwd, timeout_seconds):  # noqa: ARG001 - signature parity only.
        return _FakeCompleted("false")

    non_repo_service = type("NonRepoService", (), {"run": staticmethod(run)})()
    monkeypatch.setattr(
        workspace_manifest,
        "get_owned_process_service",
        lambda: non_repo_service,
    )

    assert workspace_manifest._build_git_snapshot(root) == {  # noqa: SLF001
        "available": False,
        "known": True,
    }


def test_unknown_git_state_is_never_rendered_or_summarized_as_zero(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """The prompt block and the harness summary are where an unknown count would
    actually reach the model, so both must refuse to print it as 0."""
    root = tmp_path / "workspace"
    root.mkdir()
    monkeypatch.setattr(
        workspace_manifest,
        "_build_git_snapshot",
        lambda _root, **_kwargs: {
            "available": True,
            "known": False,
            "branch": "main",
            "ahead": None,
            "behind": None,
            "dirty_count": None,
            "head_sha7": "abc1234",
            "degraded_reason": "budget_exhausted",
        },
    )

    block = render_workspace_manifest_block(root)
    assert "changed files unknown" in block
    assert "0 changed files" not in block

    summary = summarize_workspace_manifest(build_workspace_manifest(root))
    assert summary["git"] == {
        "branch": "main",
        "dirty_count": None,
        "dirty_count_known": False,
    }


def test_summary_does_not_invent_a_clean_tree_when_git_is_unavailable() -> None:
    """The starvation path this fix targets surfaced here first: an absent git
    payload was summarized as dirty_count 0 -- a clean-tree claim from no data."""
    summary = summarize_workspace_manifest(
        {
            "version": 1,
            "generated_at": "2026-07-18T10:22:00Z",
            "git": {"available": False, "known": False, "degraded_reason": "budget_exhausted"},
            "totals": {"files_scanned": 0, "truncated": True},
        }
    )

    assert summary["git"] == {
        "branch": "",
        "dirty_count": None,
        "dirty_count_known": False,
    }


def test_render_workspace_manifest_block_is_bounded_orientation(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    _write(root / "README.md", "A workspace used for manifest rendering.")
    _write(root / "src" / "index.ts", "export {};\n")

    block = render_workspace_manifest_block(root)

    assert block.startswith("## Workspace Manifest")
    assert "Project type:" in block
    assert "Top directories:" in block
    assert "workspace_manifest_read" in block
    assert str(root) not in block


def test_render_workspace_manifest_block_skips_error_payload() -> None:
    block = render_workspace_manifest_block(None)

    assert block == ""


def test_summarize_workspace_manifest_returns_bounded_harness_payload() -> None:
    summary = summarize_workspace_manifest(
        {
            "version": 1,
            "generated_at": "2026-05-13T10:22:00Z",
            "project_type": ["node", "python"],
            "project_markers": ["package.json"],
            "entry_points": ["src/index.ts", "main.py", "extra.py"],
            "top_dirs": [
                {"name": "src", "files": 10, "subdirs": 2},
                {"name": "tests", "files": 8, "subdirs": 1},
                {"name": "docs", "files": 3, "subdirs": 0},
                {"name": "scripts", "files": 2, "subdirs": 0},
            ],
            "git": {"branch": "main", "dirty_count": 4},
            "totals": {"files_scanned": 42, "truncated": False},
        }
    )

    assert summary == {
        "available": True,
        "generated_at": "2026-05-13T10:22:00Z",
        "project_type": ["node", "python"],
        "project_markers": ["package.json"],
        "entry_points": ["src/index.ts", "main.py"],
        "top_dirs": ["src", "tests", "docs"],
        "git": {"branch": "main", "dirty_count": 4, "dirty_count_known": True},
        "totals": {"files_scanned": 42, "truncated": False},
    }


def test_workspace_manifest_cache_reuses_and_evicts_oldest_root(tmp_path: Path) -> None:
    roots = [tmp_path / f"workspace_{index}" for index in range(3)]
    for root in roots:
        root.mkdir()

    now = 1_000.0
    calls: dict[str, int] = {}

    def clock() -> float:
        return now

    def generate(root: Path) -> dict[str, object]:
        key = str(root)
        calls[key] = calls.get(key, 0) + 1
        return {
            "version": 1,
            "root": key,
            "generated_at": "2026-05-13T10:22:00Z",
            "project_type": [],
            "project_markers": [],
            "readme_excerpt": "",
            "top_dirs": [],
            "extension_counts": {},
            "entry_points": [],
            "recent_files": [],
            "git": {"available": False},
            "totals": {"files_scanned": 0, "truncated": False},
        }

    cache = WorkspaceManifestCache(
        generator=generate,
        clock=clock,
        max_roots=2,
        soft_ttl_seconds=30.0,
        hard_ttl_seconds=300.0,
    )

    first = cache.read(roots[0])
    first["project_type"].append("mutated")
    assert cache.read(roots[0])["project_type"] == []

    cache.read(roots[1])
    cache.read(roots[2])
    cache.read(roots[0])

    assert calls[str(roots[0].resolve())] == 2
    assert calls[str(roots[1].resolve())] == 1
    assert calls[str(roots[2].resolve())] == 1


def test_workspace_manifest_cache_refreshes_after_hard_ttl(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    now = 1_000.0
    calls = 0

    def clock() -> float:
        return now

    def generate(root: Path) -> dict[str, object]:
        nonlocal calls
        calls += 1
        return {"version": 1, "root": str(root), "count": calls}

    cache = WorkspaceManifestCache(
        generator=generate,
        clock=clock,
        soft_ttl_seconds=30.0,
        hard_ttl_seconds=300.0,
    )

    assert cache.read(root)["count"] == 1
    now += 301.0
    assert cache.read(root)["count"] == 2


def test_workspace_manifest_read_tool_output_is_json(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    _write(root / "README.md", "Tool output workspace.")

    result = workspace_manifest_read_tool({}, WorkspaceGuard(str(root)))

    payload = json.loads(result.output)
    assert payload["version"] == 2
    assert payload["readme_excerpt"] == "Tool output workspace."
