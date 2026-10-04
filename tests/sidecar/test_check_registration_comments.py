"""CHK-20: a commented-out runner entry must not count as registered."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / "checks" / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_commented_smoke_entry_is_not_registered(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    checker = _load("check_gui_smoke_registered")
    runner = tmp_path / "run-gui-smoke.js"
    runner.write_text(
        "const suiteFiles = [\n"
        "  path.join(dir, 'live.smoke.js'),\n"
        "  // path.join(dir, 'line-comment.smoke.js'),\n"
        "  /* path.join(dir, 'block-comment.smoke.js'), */\n"
        "];\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(checker, "RUNNER", runner)
    assert checker._registered_names() == {"live.smoke.js"}


def test_smoke_files_without_their_runner_fail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    checker = _load("check_gui_smoke_registered")
    smoke_dir = tmp_path / "gui-smoke"
    smoke_dir.mkdir()
    (smoke_dir / "live.smoke.js").write_text("", encoding="utf-8")
    monkeypatch.setattr(checker, "SMOKE_DIR", smoke_dir)
    monkeypatch.setattr(checker, "RUNNER", tmp_path / "missing-runner.js")
    assert checker.main() == 1


def test_release_compat_tests_without_their_runner_fail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    checker = _load("check_release_compat_registered")
    monkeypatch.setattr(checker, "_expected_paths", lambda: ["tests/release-compat/test_live.js"])
    monkeypatch.setattr(checker, "DIST_RUNNER", tmp_path / "missing-runner.js")
    assert checker.main() == 1


def test_commented_release_compat_entry_is_not_registered(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    checker = _load("check_release_compat_registered")
    runner = tmp_path / "run-dist-tests.js"
    runner.write_text(
        "const DIST_NODE_TESTS = [\n"
        "  'tests/release-compat/test_live.js',\n"
        "  // 'tests/release-compat/test_dropped.js',\n"
        "];\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(checker, "DIST_RUNNER", runner)
    assert checker._registered_paths() == {"tests/release-compat/test_live.js"}
