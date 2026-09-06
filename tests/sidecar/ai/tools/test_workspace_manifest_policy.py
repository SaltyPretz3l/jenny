from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

from sidecar.ai.tools import workspace_manifest_policy as policy_module
from sidecar.ai.tools.workspace_manifest_policy import (
    ManifestScanPolicy,
    build_manifest_scan_policy,
    classify_workspace_path,
    make_ranked_file_candidate,
    order_ranked_files,
)


def test_root_ignore_subset_is_additive_bounded_and_supports_negation(
    tmp_path: Path,
    monkeypatch,
) -> None:
    # Pin the non-repository path: a tmp workspace can itself sit inside a
    # repository (private basetemps do), and this test is about ignore rules.
    monkeypatch.setattr(policy_module, "_git_marker_present", lambda _root: False)
    (tmp_path / ".gitignore").write_text(
        "ignored/\n*.tmp\n!keep.tmp\n/only-root.txt\ndocs/**/*.bak\n",
        encoding="utf-8",
    )
    (tmp_path / ".jennyignore").write_text("**/*.secret\n!keep.secret\n", encoding="utf-8")

    policy = build_manifest_scan_policy(tmp_path, timeout_seconds=1.0)

    assert policy.inventory_status == "not_repository"
    assert policy.allows("src/main.py", is_directory=False)
    assert not policy.allows("ignored", is_directory=True)
    assert not policy.allows("nested/ignored/value.py", is_directory=False)
    assert not policy.allows("scratch.tmp", is_directory=False)
    assert policy.allows("nested/keep.tmp", is_directory=False)
    assert not policy.allows("only-root.txt", is_directory=False)
    assert policy.allows("nested/only-root.txt", is_directory=False)
    assert not policy.allows("docs/archive/old.bak", is_directory=False)
    assert not policy.allows("nested/value.secret", is_directory=False)
    assert policy.allows("nested/keep.secret", is_directory=False)


def test_oversized_ignore_file_fails_open_with_bounded_diagnostic(tmp_path: Path) -> None:
    (tmp_path / ".jennyignore").write_text(
        "x" * (policy_module.IGNORE_FILE_MAX_BYTES + 1),
        encoding="utf-8",
    )

    policy = build_manifest_scan_policy(tmp_path, timeout_seconds=1.0)
    diagnostic = policy.diagnostics(excluded_entries=0, ranked_candidates=0)

    assert policy.allows("x/private.py", is_directory=False)
    assert diagnostic["ignore_sources"] == [
        {"name": ".gitignore", "status": "missing", "rules_loaded": 0},
        {"name": ".jennyignore", "status": "oversized", "rules_loaded": 0},
    ]
    assert str(tmp_path) not in str(diagnostic)


def test_git_inventory_budget_failure_degrades_to_root_ignore_policy(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    (tmp_path / ".gitignore").write_text("ignored/\n", encoding="utf-8")

    policy = build_manifest_scan_policy(tmp_path, timeout_seconds=0.0)
    diagnostic = policy.diagnostics(excluded_entries=1, ranked_candidates=2)

    assert policy.inventory_status == "degraded"
    assert not policy.allows("ignored/value.py", is_directory=False)
    assert policy.allows("src/main.py", is_directory=False)
    assert diagnostic["inventory"] == {
        "mode": "filesystem",
        "status": "degraded",
        "degraded_reason": "time_budget",
        "paths_indexed": 0,
    }


def test_workspace_ignored_by_an_enclosing_repo_falls_back_to_the_filesystem_scan(
    tmp_path: Path,
) -> None:
    """A folder an enclosing repo ignores is not an empty folder.

    ``git ls-files`` run from such a workspace returns nothing, and treating
    that as a complete inventory erases every real file from orientation.
    """
    repo = tmp_path / "repo"
    (repo / "scratch" / "src").mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    (repo / ".gitignore").write_text("scratch/\n", encoding="utf-8")
    workspace = repo / "scratch"
    (workspace / "package.json").write_text("{}", encoding="utf-8")
    (workspace / "src" / "index.ts").write_text("export {};\n", encoding="utf-8")

    policy = build_manifest_scan_policy(workspace, timeout_seconds=5.0)
    diagnostic = policy.diagnostics(excluded_entries=0, ranked_candidates=0)

    assert policy.inventory_files is None
    assert policy.inventory_status == "uncovered"
    assert diagnostic["inventory"]["mode"] == "filesystem"
    assert policy.allows("src", is_directory=True)
    assert policy.allows("src/index.ts", is_directory=False)
    assert policy.allows("package.json", is_directory=False)


def test_repository_root_holding_only_git_metadata_keeps_its_empty_inventory(
    tmp_path: Path,
) -> None:
    """An empty repo really is empty -- the fallback must not fire on it."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)

    policy = build_manifest_scan_policy(repo, timeout_seconds=5.0)

    assert policy.inventory_files == frozenset()
    assert policy.inventory_status == "complete"


def test_inventory_paths_reject_all_c0_controls_and_del_in_git_and_filesystem_modes() -> None:
    filesystem_policy = ManifestScanPolicy(
        inventory_files=None,
        inventory_directories=frozenset(),
        inventory_status="not_repository",
        inventory_degraded_reason=None,
        ignore_sources=(),
    )

    for codepoint in (*range(0x20), 0x7F):
        path = f"src{chr(codepoint)}INJECT/file.py"
        assert not policy_module._safe_inventory_path(path)
        assert not filesystem_policy.allows(path, is_directory=False)


def test_classification_precedence_and_ranking_are_deterministic() -> None:
    expected = {
        "docs/test_plan.md": "documentation",
        "tests/fixtures/config.py": "test",
        "src/main.py": "source",
        "pyproject.toml": "configuration",
        "dist/main.py": "generated",
        "assets/logo.png": "other",
    }
    assert {path: classify_workspace_path(path) for path in expected} == expected

    candidates = [
        make_ranked_file_candidate("src/zeta.py", is_entry_point=False),
        make_ranked_file_candidate("src/alpha.py", is_entry_point=False),
        make_ranked_file_candidate("main.py", is_entry_point=True),
    ]
    forward = order_ranked_files(candidates)
    reverse = order_ranked_files(reversed(candidates))

    assert forward == reverse
    assert [entry["path"] for entry in forward] == ["main.py", "src/alpha.py", "src/zeta.py"]


def test_git_inventory_normalizes_windows_case_and_allows_gitlink_directories(
    monkeypatch,
) -> None:
    monkeypatch.setattr(policy_module, "_INVENTORY_CASE_INSENSITIVE", True)
    inventory = policy_module._parse_git_inventory_result(
        SimpleNamespace(stdout="Src/Main.py\0vendor/lib\0")
    )
    assert inventory.files is not None
    scan_policy = ManifestScanPolicy(
        inventory_files=inventory.files,
        inventory_directories=inventory.directories,
        inventory_status="complete",
        inventory_degraded_reason=None,
        ignore_sources=(),
    )

    assert scan_policy.allows("src", is_directory=True)
    assert scan_policy.allows("src/main.py", is_directory=False)
    assert scan_policy.allows("VENDOR/LIB", is_directory=True)


def test_git_inventory_shares_one_deadline_across_queue_and_execution(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: dict[str, float] = {}
    successful_result = SimpleNamespace(
        timed_out=False,
        aborted=False,
        output=SimpleNamespace(truncated=False),
        drain_incomplete=False,
        returncode=0,
    )

    def _spawn(_argv, **kwargs):
        calls["queue_timeout"] = kwargs["queue_timeout_seconds"]
        return object()

    def _wait(_owned, **kwargs):
        calls["execution_timeout"] = kwargs["timeout_seconds"]
        return successful_result

    fake_service = SimpleNamespace(spawn=_spawn, wait=_wait)
    monkeypatch.setattr(policy_module, "get_owned_process_service", lambda: fake_service)
    ticks = iter((10.0, 10.75))

    result, reason = policy_module._run_git_inventory_command(
        tmp_path,
        timeout_seconds=1.0,
        clock=lambda: next(ticks),
    )

    assert result is successful_result
    assert reason == ""
    assert calls == {"queue_timeout": 1.0, "execution_timeout": 0.25}
