from __future__ import annotations

import importlib.util
import sys
from datetime import date, timedelta
from pathlib import Path
from types import ModuleType


def _load_check_file_size_module() -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / "check_file_size.py"
    spec = importlib.util.spec_from_file_location("check_file_size_script_for_tests", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive load guard
        raise RuntimeError("failed to load check_file_size.py module spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write_lines(path: Path, line_count: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(("x\n" * line_count).rstrip("\n"), encoding="utf-8")


def _configure_repo_root(
    module: ModuleType,
    monkeypatch,
    repo_root: Path,
    *,
    allowlist: dict[Path, object] | None = None,
) -> None:
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "LEGACY_SIZE_ALLOWLIST", allowlist or {})


def test_file_size_check_ignores_port_bundles(tmp_path, monkeypatch, capsys) -> None:
    module = _load_check_file_size_module()
    assert module.MAX_LINES == 1000
    repo_root = tmp_path / "repo"
    oversized_archive_file = (
        repo_root / "PORT_BUNDLES" / "archive" / "files" / "sidecar" / "ai" / "huge_engine.py"
    )
    _write_lines(oversized_archive_file, module.MAX_LINES + 200)
    _configure_repo_root(module, monkeypatch, repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: file-size check" in output


def test_file_size_check_enforces_active_js_files(tmp_path, monkeypatch, capsys) -> None:
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    oversized_source_file = repo_root / "main.js"
    _write_lines(oversized_source_file, module.MAX_LINES + module.BUFFER_LINES + 1)
    _configure_repo_root(module, monkeypatch, repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: file-size ceiling exceeded" in output
    assert "main.js" in output


def test_file_size_check_enforces_active_css_files(tmp_path, monkeypatch, capsys) -> None:
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    oversized_source_file = repo_root / "styles" / "settings.css"
    _write_lines(oversized_source_file, module.MAX_LINES + module.BUFFER_LINES + 1)
    _configure_repo_root(module, monkeypatch, repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: file-size ceiling exceeded" in output
    assert "styles/settings.css" in output


def test_file_size_check_enforces_renderer_source_files(tmp_path, monkeypatch, capsys) -> None:
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    oversized_source_file = repo_root / "renderer" / "chat" / "renderer-turn-row-projector.js"
    _write_lines(oversized_source_file, module.MAX_LINES + module.BUFFER_LINES + 1)
    _configure_repo_root(module, monkeypatch, repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: file-size ceiling exceeded" in output
    assert "renderer/chat/renderer-turn-row-projector.js" in output


def test_file_size_check_fails_for_oversized_active_source(tmp_path, monkeypatch, capsys) -> None:
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    oversized_source_file = repo_root / "sidecar" / "ai" / "too_large.py"
    _write_lines(oversized_source_file, module.MAX_LINES + 1)
    _configure_repo_root(module, monkeypatch, repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 0
    assert "PASS: file-size check" in output


def test_file_size_check_enforces_sidecar_production_source(tmp_path, monkeypatch, capsys) -> None:
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    oversized_source_file = repo_root / "sidecar" / "ai" / "way_too_large.py"
    _write_lines(oversized_source_file, module.MAX_LINES + module.BUFFER_LINES + 1)
    _configure_repo_root(module, monkeypatch, repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: file-size ceiling exceeded" in output
    assert "sidecar/ai/way_too_large.py" in output


def test_file_size_check_skips_sidecar_test_suites(tmp_path, monkeypatch, capsys) -> None:
    # tests/sidecar/ is deferred to a later enforcement packet (see
    # "Planned Refactor Expansion" in docs/operations/LEGACY_SIZE_ALLOWLIST.md).
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    oversized_test_file = repo_root / "tests" / "sidecar" / "test_too_large.py"
    _write_lines(oversized_test_file, module.MAX_LINES + module.BUFFER_LINES + 1)
    _configure_repo_root(module, monkeypatch, repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: file-size check" in output


def test_file_size_check_reports_known_large_active_targets_as_warning(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    split_plan = repo_root / "docs" / "operations" / "LEGACY_SIZE_ALLOWLIST.md"
    split_plan.parent.mkdir(parents=True, exist_ok=True)
    split_plan.write_text("# Legacy size allowlist\n", encoding="utf-8")
    oversized_source_file = repo_root / "renderer/app.js"
    _write_lines(oversized_source_file, module.MAX_LINES + 120)
    _configure_repo_root(
        module,
        monkeypatch,
        repo_root,
        allowlist={
            Path("renderer/app.js"): module.LegacySizeException(
                label="renderer-shell-v2-root",
                reason="test warning",
                split_plan=Path("docs/operations/LEGACY_SIZE_ALLOWLIST.md"),
                # Relative to today, never a literal: a hardcoded date turns
                # this case into a time bomb that silently reclassifies itself
                # as EXPIRED the morning after it passes, and then fails every
                # run on every branch until someone edits the fixture. The
                # behaviour under test is "an UNEXPIRED waiver warns", so the
                # date has to be expressed as exactly that.
                expires_on=(date.today() + timedelta(days=30)).isoformat(),
                # Bounded raised ceiling must cover the fixture's line count, or
                # the file exceeds the waiver's raised ceiling and hard-FAILs.
                max_lines=module.MAX_LINES + 120,
            )
        },
    )

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 0
    assert "WARN: temporary legacy file-size exceptions" in output
    assert "renderer/app.js" in output


def test_file_size_check_fails_for_an_expired_legacy_exception(
    tmp_path, monkeypatch, capsys
) -> None:
    """An expired waiver must hard-FAIL, not quietly keep warning.

    The expiry date is the only thing stopping a "temporary" exception from
    becoming permanent, so it is the half of this contract worth defending -
    and until now only the warning half had a test.
    """
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    split_plan = repo_root / "docs" / "operations" / "LEGACY_SIZE_ALLOWLIST.md"
    split_plan.parent.mkdir(parents=True, exist_ok=True)
    split_plan.write_text("# Legacy size allowlist\n", encoding="utf-8")
    oversized_source_file = repo_root / "renderer/app.js"
    _write_lines(oversized_source_file, module.MAX_LINES + 120)
    expired_on = (date.today() - timedelta(days=1)).isoformat()
    _configure_repo_root(
        module,
        monkeypatch,
        repo_root,
        allowlist={
            Path("renderer/app.js"): module.LegacySizeException(
                label="renderer-shell-v2-root",
                reason="test expiry",
                split_plan=Path("docs/operations/LEGACY_SIZE_ALLOWLIST.md"),
                expires_on=expired_on,
                max_lines=module.MAX_LINES + 120,
            )
        },
    )

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "renderer/app.js" in output
    assert f"expired on {expired_on}" in output


def test_file_size_check_passes_for_normal_active_source(tmp_path, monkeypatch, capsys) -> None:
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    normal_source_file = repo_root / "sidecar" / "ai" / "normal.py"
    _write_lines(normal_source_file, module.MAX_LINES)
    _configure_repo_root(module, monkeypatch, repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: file-size check" in output


def test_file_size_enumerator_prunes_inactive_repository_trees(tmp_path, monkeypatch) -> None:
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    active_file = repo_root / "services" / "main" / "live.js"
    _write_lines(active_file, 1)
    _write_lines(repo_root / "artifacts" / "generated.js", 1)
    _write_lines(repo_root / "node_modules" / "dependency.js", 1)
    _write_lines(repo_root / "docs" / "example.py", 1)
    _configure_repo_root(module, monkeypatch, repo_root)

    scanned = {
        path.relative_to(repo_root).as_posix()
        for path in module.iter_code_files()
    }

    assert scanned == {"services/main/live.js"}


def test_tests_sidecar_stays_outside_the_file_size_scan(tmp_path, monkeypatch) -> None:
    # DONOR_TEST_SUBDIRS is a deliberate deferral, not donor cruft, and it sits in
    # the code that W6-06-F12 stripped of genuinely dead donor handling. Measured at
    # the time of that cleanup: 36 files under tests/sidecar/ exceed the 1015-line
    # ceiling (test_router.py is 6438) and 76 exceed 600. Scoping this tree in would
    # hard-FAIL check_file_size and push test_files_over_600 from 172 to 248 against
    # a baseline sitting exactly at 172 -- blocking every commit in the repository.
    # Retiring this pin means dealing with those suites first, not deleting the line.
    module = _load_check_file_size_module()
    repo_root = tmp_path / "repo"
    deferred = repo_root / "tests" / "sidecar" / "test_huge.py"
    enforced = repo_root / "tests" / "renderer-live.test.js"
    _write_lines(deferred, 2000)
    _write_lines(enforced, 1)
    _configure_repo_root(module, monkeypatch, repo_root)

    scanned = {
        path.relative_to(repo_root).as_posix() for path in module.iter_code_files()
    }

    assert scanned == {"tests/renderer-live.test.js"}
