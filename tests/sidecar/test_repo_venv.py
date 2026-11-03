"""The gate scripts re-run under the repo venv when the invoking python lacks their deps."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks import repo_venv  # noqa: E402

MISSING = "jenny_module_that_does_not_exist"


class Recorder:
    def __init__(self, code: int = 0) -> None:
        self.calls: list[tuple[list[str], dict[str, str]]] = []
        self.code = code

    def __call__(self, args: list[str], *, env: dict[str, str], check: bool):
        assert check is False
        self.calls.append((args, env))
        return subprocess.CompletedProcess(args, self.code)


def fake_venv(root: Path) -> Path:
    target = repo_venv.venv_python(root)
    target.parent.mkdir(parents=True)
    target.write_bytes(b"")
    return target


def test_present_modules_never_re_run(tmp_path: Path) -> None:
    fake_venv(tmp_path)
    run = Recorder()
    repo_venv.ensure_repo_venv(("json",), root=tmp_path, run=run)
    assert run.calls == []


def test_missing_module_re_runs_under_the_venv_with_the_same_arguments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(repo_venv.REEXEC_ENV, raising=False)
    monkeypatch.setattr(sys, "argv", ["scripts/checks/run_all.py", "--flag"])
    target = fake_venv(tmp_path)
    run = Recorder(code=3)
    with pytest.raises(SystemExit) as exit_info:
        repo_venv.ensure_repo_venv((MISSING,), root=tmp_path, run=run)
    assert exit_info.value.code == 3
    [(args, env)] = run.calls
    assert args == [str(target), "scripts/checks/run_all.py", "--flag"]
    assert env[repo_venv.REEXEC_ENV] == "1"


def test_no_venv_leaves_the_import_to_fail_on_its_own(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(repo_venv.REEXEC_ENV, raising=False)
    run = Recorder()
    repo_venv.ensure_repo_venv((MISSING,), root=tmp_path, run=run)
    assert run.calls == []


def test_a_re_run_never_re_runs_again(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(repo_venv.REEXEC_ENV, "1")
    fake_venv(tmp_path)
    run = Recorder()
    repo_venv.ensure_repo_venv((MISSING,), root=tmp_path, run=run)
    assert run.calls == []


def test_already_the_venv_interpreter_does_not_re_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(repo_venv.REEXEC_ENV, raising=False)
    target = fake_venv(tmp_path)
    monkeypatch.setattr(sys, "executable", str(target))
    run = Recorder()
    repo_venv.ensure_repo_venv((MISSING,), root=tmp_path, run=run)
    assert run.calls == []
