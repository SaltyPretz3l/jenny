"""Tests for pytest test-file discovery used by the progress grid."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.test_progress import TestProgressTracker
from sidecar.ai.tools.builtins.test_progress_manifest import discover, positional_paths, pytest_args


def write(root: Path, relative: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("def test_x():\n    pass\n", encoding="utf-8")


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    for relative in (
        "tests/test_a.py",
        "tests/sub/test_b.py",
        "tests/sub/helper.py",
        "tests/sub/b_check.py",
        "tests/sub/c_test.py",
        "node_modules/test_x.py",
        ".venv/test_y.py",
        "tests/__pycache__/test_c.py",
        "build/test_d.py",
        "dist/test_f.py",
        "pkg.egg-info/test_e.py",
        ".git/test_g.py",
        ".tox/test_h.py",
    ):
        write(tmp_path, relative)
    return tmp_path


def run(command: str, root: Path, **kwargs: object) -> list[str] | None:
    return discover(command=command, cwd=root, workspace_root=root, **kwargs)  # type: ignore[arg-type]


def test_default_patterns_and_skip_dirs(tree: Path) -> None:
    assert run("pytest", tree) == [
        "tests/sub/c_test.py",
        "tests/sub/test_b.py",
        "tests/test_a.py",
    ]


def test_python_files_from_pytest_ini_wins_over_pyproject(tree: Path) -> None:
    (tree / "pytest.ini").write_text("[pytest]\npython_files = *_check.py\n", encoding="utf-8")
    (tree / "pyproject.toml").write_text(
        '[tool.pytest.ini_options]\npython_files = ["test_*.py"]\n', encoding="utf-8"
    )
    assert run("pytest", tree) == ["tests/sub/b_check.py"]


def test_pyproject_python_files_and_testpaths(tree: Path) -> None:
    (tree / "pyproject.toml").write_text(
        '[tool.pytest.ini_options]\npython_files = ["*_check.py", "c_*.py"]\n'
        'testpaths = ["tests/sub"]\n',
        encoding="utf-8",
    )
    assert run("pytest", tree) == ["tests/sub/b_check.py", "tests/sub/c_test.py"]


def test_setup_cfg_and_tox_ini_sections(tree: Path) -> None:
    (tree / "setup.cfg").write_text(
        "[tool:pytest]\npython_files =\n    *_check.py\n    helper.py\n", encoding="utf-8"
    )
    assert run("pytest", tree) == ["tests/sub/b_check.py", "tests/sub/helper.py"]
    (tree / "setup.cfg").unlink()
    (tree / "tox.ini").write_text("[pytest]\npython_files = c_test.py\n", encoding="utf-8")
    assert run("pytest", tree) == ["tests/sub/c_test.py"]


def test_positional_arguments_select_roots(tree: Path) -> None:
    assert run("python -m pytest -n 8 -k expr tests/sub/test_b.py::test_x", tree) == [
        "tests/sub/test_b.py"
    ]
    assert run(r".venv\Scripts\python.exe -m pytest --tb short tests/sub -q", tree) == [
        "tests/sub/c_test.py",
        "tests/sub/test_b.py",
    ]
    assert run("pytest tests/test_a.py tests/sub/test_b.py && echo done other", tree) == [
        "tests/sub/test_b.py",
        "tests/test_a.py",
    ]


def test_argument_parsing_skips_options_and_their_values() -> None:
    args = pytest_args("python -m pytest -n 8 -m 'slow' -p xdist -c cfg.ini --tb=short tests/a.py")
    assert positional_paths(args) == ["tests/a.py"]
    assert pytest_args("echo hello") == []


def test_root_outside_workspace_is_ignored(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    write(workspace, "tests/test_in.py")
    write(tmp_path, "outside/test_out.py")
    result = discover(command="pytest ../outside", cwd=workspace, workspace_root=workspace)
    assert result is None


def test_directory_symlink_escape_is_not_followed(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    write(workspace, "tests/test_in.py")
    write(tmp_path, "outside/test_evil.py")
    try:
        os.symlink(tmp_path / "outside", workspace / "tests" / "link", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted here")
    result = discover(command="pytest", cwd=workspace, workspace_root=workspace)
    assert result == ["tests/test_in.py"]


@pytest.mark.skipif(sys.platform != "win32", reason="NTFS junctions are Windows-only")
def test_directory_junction_escape_is_not_followed(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    write(workspace, "tests/test_in.py")
    write(tmp_path, "outside/test_evil.py")
    link = workspace / "tests" / "junction"
    made = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(tmp_path / "outside")],
        capture_output=True,
        check=False,
    )
    if made.returncode != 0:
        pytest.skip("junction creation is not permitted here")
    result = discover(command="pytest", cwd=workspace, workspace_root=workspace)
    assert result == ["tests/test_in.py"]


def test_exceeding_the_time_budget_returns_none(tree: Path) -> None:
    ticks = iter(range(1000))

    def clock() -> float:
        return float(next(ticks))

    assert run("pytest", tree, budget_seconds=0.5, clock=clock) is None


def test_unreadable_config_returns_none(tree: Path) -> None:
    (tree / "pyproject.toml").write_text("[tool.pytest.ini_options\nbroken", encoding="utf-8")
    assert run("pytest", tree) is None


def test_tracker_discovers_the_manifest_on_a_background_thread(tmp_path: Path) -> None:
    for index in range(14):
        write(tmp_path, f"tests/test_f{index:02d}.py")
    tracker = TestProgressTracker(
        command="pytest tests",
        cwd=tmp_path,
        workspace_root=tmp_path,
    )
    tracker.feed_line("collected 14 items")
    tracker.feed_line("tests/test_f00.py .  [  7%]")
    deadline = time.monotonic() + 5.0
    snapshot = tracker.snapshot()
    while snapshot is not None and snapshot["grid"] is None and time.monotonic() < deadline:
        time.sleep(0.01)
        snapshot = tracker.snapshot()
    assert snapshot is not None
    assert snapshot["unit"] == "file"
    grid = snapshot["grid"]
    assert isinstance(grid, dict)
    assert grid["count"] == 14
    assert snapshot["labels"][:2] == ["tests/test_f00.py", "tests/test_f01.py"]  # type: ignore[index]


# ----------------------------------------------------------------------------- S3 review fixes


@pytest.mark.parametrize(
    "command",
    [
        "pytest tests/sub 2>&1",
        "pytest tests/sub >out.txt",
        "pytest tests/sub > out.txt",
        "pytest tests/sub &> log.txt",
        "pytest tests/sub 2>/dev/null",
        "pytest --cov-report html tests/sub",
        "pytest -q nonexistent_dir tests/sub",
    ],
)
def test_redirections_and_option_values_are_not_positional_paths(tree: Path, command: str) -> None:
    assert run(command, tree) == ["tests/sub/c_test.py", "tests/sub/test_b.py"]


def test_only_junk_positionals_fall_back_to_the_default_root(tree: Path) -> None:
    assert run("pytest 2>&1", tree) == [
        "tests/sub/c_test.py",
        "tests/sub/test_b.py",
        "tests/test_a.py",
    ]


def test_no_files_found_returns_none(tmp_path: Path) -> None:
    assert run("pytest", tmp_path) is None


def test_a_crashing_discovery_never_leaves_the_manifest_pending(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sidecar.ai.tools.builtins.test_progress as progress_module

    def boom(**_: object) -> None:
        raise RuntimeError("discovery exploded")

    monkeypatch.setattr(progress_module, "discover", boom)
    tracker = TestProgressTracker(command="pytest", cwd=tmp_path, workspace_root=tmp_path)
    tracker.feed_line("collected 20 items")
    tracker.feed_line("tests/a.py ..  [ 10%]")
    deadline = time.monotonic() + 5.0
    snapshot = tracker.snapshot()
    while snapshot is not None and snapshot["grid"] is None and time.monotonic() < deadline:
        time.sleep(0.01)
        snapshot = tracker.snapshot()
    assert snapshot is not None
    assert snapshot["unit"] == "order"
