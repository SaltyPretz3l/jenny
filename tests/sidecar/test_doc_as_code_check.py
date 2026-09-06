from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType


def _load_script_module(script_name: str) -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / script_name
    spec = importlib.util.spec_from_file_location(f"test_loader_{script_name}", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError(f"unable to load script module: {script_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write_file(path: Path, content: str = "stub\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _write_minimal_domain_manifest(repo_root: Path, name: str, paths: list[str]) -> None:
    lines = [
        "---",
        "kind: workspace-manifest-domain",
        f"domain: {name}",
        "summary: Stub.",
        "paths:",
    ]
    lines.extend(f"  - {value}" for value in paths)
    lines.extend(
        [
            "entrypoints:",
            "  - stub.txt",
            "tests:",
            "  - stub.txt",
            "related_docs:",
            "  - stub.txt",
            "---",
            "",
            "# Domain",
            "",
        ]
    )
    rendered = "\n".join(lines) + "\n"
    _write_file(repo_root / "docs" / "manifests" / f"{name}.md", rendered)


def _seed_repo(repo_root: Path) -> None:
    """Lay down enough fixture files for the check to operate."""
    _write_minimal_domain_manifest(
        repo_root,
        "ui-ux",
        ["renderer/", "index.html", "styles/"],
    )
    _write_minimal_domain_manifest(
        repo_root,
        "electron-wiring",
        ["main.js", "preload.js", "services/"],
    )
    _write_minimal_domain_manifest(
        repo_root,
        "sidecar-runtime",
        ["sidecar/", "services/backend/"],
    )


def test_passes_when_protocol_change_pairs_with_runtime_manifest(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        [
            "--changed-file",
            "sidecar/protocol.py",
            "--changed-file",
            "docs/manifests/sidecar-runtime.md",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: doc-as-code pairing" in output
    assert "validated" in output


def test_fails_when_protocol_changes_alone(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "sidecar/protocol.py"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: doc-as-code pairing" in output
    assert "sidecar/protocol.py" in output
    assert "docs/manifests/sidecar-runtime.md" in output


def test_passes_when_builtin_tool_pairs_with_matching_doc(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        [
            "--changed-file",
            "sidecar/ai/tools/builtins/filesystem.py",
            "--changed-file",
            "docs/TOOLS.md",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: doc-as-code pairing" in output


def test_passes_when_builtin_tool_pairs_with_tool_manifest(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        [
            "--changed-file",
            "sidecar/ai/tools/builtins/filesystem.py",
            "--changed-file",
            "services/tools/tool-manifest.json",
            "--changed-file",
            "docs/manifests/electron-wiring.md",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: doc-as-code pairing" in output


def test_fails_when_builtin_tool_changes_without_any_tool_doc(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "sidecar/ai/tools/builtins/shell.py"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: doc-as-code pairing" in output
    assert "sidecar/ai/tools/builtins/shell.py" in output


def _seed_git_repo(repo_root: Path) -> None:
    _seed_repo(repo_root)
    (repo_root / ".git").mkdir(parents=True, exist_ok=True)


def _fake_git_factory(committed: str, status: str):
    """Git stub for the marker tests: one merge base, a committed diff, a status."""

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args == ["merge-base", "origin/main", "HEAD"]:
            return 0, "remote123\n", ""
        if args == ["diff", "--name-only", "--diff-filter=ACDMR", "remote123...HEAD"]:
            return 0, committed, ""
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, status, ""
        return 1, "", "unexpected command"

    return _fake_git


def test_skip_marker_bypasses_check_for_committed_history_on_a_clean_tree(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    # The marker's one legitimate mode, and the reason it still exists: the change
    # set is exactly what HEAD committed, so HEAD's message can speak for it. This
    # test previously drove the same assertion through --changed-file, which is the
    # fail-open W6-06-F09 reports; the scenario moved, the bypass stayed pinned.
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_git_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_read_head_commit_message", lambda: "hotfix [skip-doc]")
    monkeypatch.setattr(
        module,
        "_run_git_command",
        _fake_git_factory("sidecar/protocol.py\n", ""),
    )

    exit_code = module.main([])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: doc-as-code pairing" in output
    assert "[skip-doc]" in output


def test_skip_marker_does_not_waive_explicit_changed_files(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    # W6-06-F09. An explicit list is someone else's set of paths; HEAD's message
    # never described it and must not waive it.
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_read_head_commit_message", lambda: "hotfix [skip-doc]")

    exit_code = module.main(["--changed-file", "sidecar/protocol.py"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: doc-as-code pairing" in output
    assert "sidecar/protocol.py" in output


def test_skip_marker_does_not_waive_uncommitted_worktree_changes(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    # W6-06-F09, in the shape that actually fires: the pre-commit hook runs before
    # the new commit exists, so HEAD is the PREVIOUS commit. A [skip-doc] tagged
    # docs commit must not waive the undocumented change being made on top of it.
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_git_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(
        module, "_read_head_commit_message", lambda: "docs(hygiene): ledger [skip-doc]"
    )
    monkeypatch.setattr(
        module,
        "_run_git_command",
        _fake_git_factory("", " M sidecar/protocol.py\n"),
    )

    exit_code = module.main([])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: doc-as-code pairing" in output
    assert "sidecar/protocol.py" in output


def test_unrelated_doc_does_not_suppress_manifest_fallback(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    # W6-06-F10. A typo fix in an unrelated doc used to waive every fallback
    # violation in the same diff, including this undocumented backend change.
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        [
            "--changed-file",
            "services/backend/runtime.js",
            "--changed-file",
            "docs/process/TESTING_STRATEGY.md",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "services/backend/runtime.js" in output
    assert "falls under docs/manifests/" in output


def test_paired_tool_doc_still_satisfies_the_manifest_fallback(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    # The other half of W6-06-F10: judging per owning manifest must NOT start
    # demanding sidecar-runtime.md for a builtin tool that is already paired with
    # its own docs/TOOLS.md section. A fix that reds this one is too tight.
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        [
            "--changed-file",
            "sidecar/ai/tools/builtins/filesystem.py",
            "--changed-file",
            "docs/TOOLS.md",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: doc-as-code pairing" in output


def test_manifest_paths_fallback_fires_when_no_docs_touched(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    # services/feature-flags.js matches electron-wiring 'paths:' (services/)
    # and is not in SURFACE_RULES, so it tests the fallback branch.
    exit_code = module.main(["--changed-file", "services/feature-flags.js"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: doc-as-code pairing" in output
    assert "services/feature-flags.js" in output
    assert "docs/manifests/electron-wiring.md" in output


def test_ui_ux_paths_excluded_from_fallback_enforcement(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    """Renderer surface edits do not require a paired ui-ux.md update.

    The ui-ux manifest is refreshed on explicit user request, not paired with
    each renderer edit. index.html and other paths under ui-ux 'paths:' must
    therefore PASS the doc-as-code check even when no docs/** file changed.
    """
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        [
            "--changed-file",
            "index.html",
            "--changed-file",
            "renderer/chat/renderer-stream-handler.js",
            "--changed-file",
            "styles/chat-thread.css",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 0, output
    assert "PASS: doc-as-code pairing" in output
    assert "ui-ux.md" not in output


def test_ui_ux_carve_out_does_not_mask_electron_wiring_violations(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    """A mixed diff with both ui-ux and electron-wiring paths still fails on
    the electron-wiring side when no docs/** file is touched."""
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        [
            "--changed-file",
            "index.html",
            "--changed-file",
            "services/feature-flags.js",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: doc-as-code pairing" in output
    assert "services/feature-flags.js" in output
    assert "docs/manifests/electron-wiring.md" in output


def test_warns_and_passes_when_no_git_metadata_and_no_explicit_input(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    _seed_repo(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.delenv(module.CHANGED_FILES_ENV, raising=False)

    exit_code = module.main([])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: doc-as-code pairing" in output
    assert "WARN: doc-as-code pairing not enforced" in output
    assert module.CHANGED_FILES_ENV in output


def test_doc_as_code_change_detection_includes_committed_deletion(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    commands = (
        ("init",),
        ("config", "user.email", "tests@example.invalid"),
        ("config", "user.name", "Jenny Tests"),
    )
    for arguments in commands:
        subprocess.run(
            ["git", *arguments],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        )
    documented_path = repo_root / "docs" / "process" / "DOC_AS_CODE.md"
    _write_file(documented_path)
    for arguments in (
        ("add", "."),
        ("commit", "-m", "add documented file"),
    ):
        subprocess.run(
            ["git", *arguments],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        )
    documented_path.unlink()
    for arguments in (
        ("add", "-A"),
        ("commit", "-m", "delete documented file"),
    ):
        subprocess.run(
            ["git", *arguments],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        )
    monkeypatch.setattr(module, "ROOT", repo_root)

    changed_files, fallback_reason = module._collect_git_changed_files("HEAD~1", "HEAD")

    assert fallback_reason is None
    assert changed_files == ["docs/process/DOC_AS_CODE.md"]


def test_doc_as_code_change_detection_prefers_origin_main(
    tmp_path: Path,
    monkeypatch,
) -> None:
    # origin/main must win over local main: on a checkout of main itself the
    # local-main merge base is HEAD, so the diff is empty and the check passes
    # vacuously.
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)
    calls: list[list[str]] = []

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        calls.append(args)
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args == ["merge-base", "origin/main", "HEAD"]:
            return 0, "remote123\n", ""
        if args == ["diff", "--name-only", "--diff-filter=ACDMR", "remote123...HEAD"]:
            return 0, "services/backend/runtime.js\n", ""
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, "", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(None, None)

    assert fallback_reason is None
    assert changed_files == ["services/backend/runtime.js"]
    assert ["merge-base", "main", "HEAD"] not in calls


def test_doc_as_code_change_detection_falls_back_to_local_main(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("check_doc_as_code.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args == ["merge-base", "origin/main", "HEAD"]:
            return 1, "", "no such ref"
        if args == ["merge-base", "main", "HEAD"]:
            return 0, "local123\n", ""
        if args == ["diff", "--name-only", "--diff-filter=ACDMR", "local123...HEAD"]:
            return 0, "services/backend/runtime.js\n", ""
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, "", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(None, None)

    assert fallback_reason is None
    assert changed_files == ["services/backend/runtime.js"]
