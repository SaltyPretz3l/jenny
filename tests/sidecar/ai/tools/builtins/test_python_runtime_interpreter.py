"""Focused bootstrap-lock regressions for the Python runtime interpreter."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

import pytest

import sidecar
from sidecar.ai.tools.builtins.python_runtime import (
    bootstrap_lock,
    bootstrap_subprocess,
    bootstrap_telemetry,
    interpreter,
    tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def test_default_wheelhouse_is_anchored_independent_of_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sidecar_package_dir = Path(sidecar.__file__).resolve().parent
    expected = sidecar_package_dir.parent / "vendor" / "python-runtime-wheels"

    assert interpreter.DEFAULT_RUNTIME_WHEELHOUSE == expected
    assert interpreter.DEFAULT_RUNTIME_WHEELHOUSE.is_absolute()

    monkeypatch.chdir(tmp_path)

    assert interpreter.DEFAULT_RUNTIME_WHEELHOUSE == expected


def test_default_wheelhouse_without_manifest_is_treated_as_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wheelhouse = tmp_path / "vendor" / "python-runtime-wheels"
    wheelhouse.mkdir(parents=True)
    (wheelhouse / ".gitignore").write_text("*\n!.gitignore\n", encoding="utf-8")
    monkeypatch.setattr(interpreter, "DEFAULT_RUNTIME_WHEELHOUSE", wheelhouse)

    assert interpreter._runtime_wheelhouse({}) is None  # noqa: SLF001


def test_discover_base_interpreter_prefers_sys_executable_over_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    controlled = tmp_path / "controlled-python.exe"
    path_python = tmp_path / "path-python.exe"
    controlled.write_text("", encoding="utf-8")
    path_python.write_text("", encoding="utf-8")
    validated: list[Path] = []

    monkeypatch.setattr(interpreter.sys, "executable", str(controlled))
    monkeypatch.setattr(interpreter, "read_environment_value", lambda _key: None)
    monkeypatch.setattr(interpreter.shutil, "which", lambda _command: str(path_python))
    monkeypatch.setattr(
        interpreter,
        "_validated_interpreter",
        lambda candidate: validated.append(candidate) or candidate,
    )

    result = interpreter.discover_base_interpreter({})

    assert result == controlled
    assert validated == [controlled]
    assert interpreter._VALIDATED_INTERPRETER_SOURCES[str(controlled)] == "sys_executable"


def test_discover_base_interpreter_honours_config_then_trusted_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    explicit = tmp_path / "configured-python.exe"
    env_python = tmp_path / "env-python.exe"
    controlled = tmp_path / "controlled-python.exe"
    path_python = tmp_path / "path-python.exe"
    for candidate in (explicit, env_python, controlled, path_python):
        candidate.write_text("", encoding="utf-8")
    validated: list[Path] = []

    monkeypatch.setattr(interpreter.sys, "executable", str(controlled))
    monkeypatch.setattr(interpreter, "read_environment_value", lambda _key: str(env_python))
    monkeypatch.setattr(interpreter.shutil, "which", lambda _command: str(path_python))
    monkeypatch.setattr(
        interpreter,
        "_validated_interpreter",
        lambda candidate: validated.append(candidate) or candidate,
    )

    configured_result = interpreter.discover_base_interpreter(
        {"tools_python_runtime_interpreter": str(explicit)}
    )
    validated.clear()
    env_result = interpreter.discover_base_interpreter({})

    assert configured_result == explicit
    assert env_result == env_python
    assert validated == [env_python]
    assert interpreter._VALIDATED_INTERPRETER_SOURCES[str(explicit)] == "config"
    assert interpreter._VALIDATED_INTERPRETER_SOURCES[str(env_python)] == "env"


def test_cp313_wheelhouse_rejects_python311_before_pip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    wheel = wheelhouse / "numpy-2.4.3-cp313-cp313-win_amd64.whl"
    wheel.write_bytes(b"cp313 wheel")
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    (wheelhouse / interpreter.WHEELHOUSE_MANIFEST_FILENAME).write_text(
        json.dumps({"files": {wheel.name: digest}}),
        encoding="utf-8",
    )
    install_calls: list[list[str]] = []
    monkeypatch.setattr(interpreter, "_interpreter_identity", lambda _python: "3.11.7")
    monkeypatch.setattr(
        interpreter.bootstrap_subprocess,
        "run",
        lambda command, **_kwargs: install_calls.append(command)
        or subprocess.CompletedProcess(command, 0, "", ""),
    )

    with pytest.raises(interpreter.PythonRuntimeError) as caught:
        interpreter._install_runtime_packages(  # noqa: SLF001
            tmp_path / "python.exe",
            {"tools_python_runtime_wheelhouse_dir": str(wheelhouse)},
        )

    assert caught.value.failed_phase == "install_finished"
    assert "3.11.7" in str(caught.value)
    assert "cp313" in str(caught.value)
    assert "cp313" in caught.value.remediation
    assert "cp311" in caught.value.remediation
    assert install_calls == []


def test_mixed_wheelhouse_rejects_python311_before_pip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    pure_wheel = wheelhouse / "packaging-26.0-py3-none-any.whl"
    binary_wheel = wheelhouse / "numpy-2.4.3-cp313-cp313-win_amd64.whl"
    pure_wheel.write_bytes(b"pure Python wheel")
    binary_wheel.write_bytes(b"cp313 wheel")
    manifest = {
        wheel.name: hashlib.sha256(wheel.read_bytes()).hexdigest()
        for wheel in (pure_wheel, binary_wheel)
    }
    (wheelhouse / interpreter.WHEELHOUSE_MANIFEST_FILENAME).write_text(
        json.dumps({"files": manifest}),
        encoding="utf-8",
    )
    install_calls: list[list[str]] = []
    monkeypatch.setattr(interpreter, "_interpreter_identity", lambda _python: "3.11.7")
    monkeypatch.setattr(
        interpreter.bootstrap_subprocess,
        "run",
        lambda command, **_kwargs: install_calls.append(command)
        or subprocess.CompletedProcess(command, 0, "", ""),
    )

    with pytest.raises(interpreter.PythonRuntimeError) as caught:
        interpreter._install_runtime_packages(  # noqa: SLF001
            tmp_path / "python.exe",
            {"tools_python_runtime_wheelhouse_dir": str(wheelhouse)},
        )

    assert "3.11.7" in str(caught.value)
    assert binary_wheel.name in str(caught.value)
    assert install_calls == []


def test_abi3_wheel_does_not_reject_later_python(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    wheel = wheelhouse / "example-1.0-cp313-abi3-win_amd64.whl"
    wheel.write_bytes(b"abi3 wheel")
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    (wheelhouse / interpreter.WHEELHOUSE_MANIFEST_FILENAME).write_text(
        json.dumps({"files": {wheel.name: digest}}),
        encoding="utf-8",
    )
    install_calls: list[list[str]] = []
    monkeypatch.setattr(
        interpreter,
        "_interpreter_identity",
        lambda _python: pytest.fail("abi3 must not constrain interpreter selection"),
    )
    monkeypatch.setattr(
        interpreter.bootstrap_subprocess,
        "run",
        lambda command, **_kwargs: install_calls.append(command)
        or subprocess.CompletedProcess(command, 0, "", ""),
    )

    interpreter._install_runtime_packages(  # noqa: SLF001
        tmp_path / "python.exe",
        {"tools_python_runtime_wheelhouse_dir": str(wheelhouse)},
    )

    assert len(install_calls) == 1
    assert install_calls[0][1:4] == ["-m", "pip", "install"]


def test_python_runtime_tool_forwards_bootstrap_remediation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    remediation = "Restore the bundled CPython 3.13 interpreter."
    failure = interpreter.PythonRuntimeError(
        "wheelhouse ABI mismatch",
        failed_phase="install_finished",
        remediation=remediation,
    )
    monkeypatch.setattr(tool.sys, "platform", "win32")
    monkeypatch.setattr(
        tool,
        "ensure_runtime_venv",
        lambda _config, **_kwargs: (_ for _ in ()).throw(failure),
    )

    with pytest.raises(ToolExecutionFailure) as caught:
        tool.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))

    assert caught.value.remediation == remediation
    assert caught.value.to_error_data()["remediation"] == remediation


def _disable_lock_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bootstrap_lock, "BOOTSTRAP_LOCK_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(bootstrap_lock, "BOOTSTRAP_LOCK_POLL_SECONDS", 0)


def test_bootstrap_lock_recovers_current_process_unlink_residue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock_path = tmp_path / ".bootstrap.lock"
    lock_path.write_text(
        json.dumps({"pid": os.getpid(), "created_at": time.time()}),
        encoding="utf-8",
    )
    monkeypatch.setattr(bootstrap_lock, "_process_exists", lambda _pid: True)
    _disable_lock_wait(monkeypatch)

    with interpreter._bootstrap_lock(lock_path):  # noqa: SLF001
        payload = json.loads(lock_path.read_text(encoding="utf-8"))
        assert payload["pid"] == os.getpid()

    assert not lock_path.exists()


def test_bootstrap_lock_recovers_stale_live_recycled_pid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock_path = tmp_path / ".bootstrap.lock"
    lock_path.write_text(
        json.dumps(
            {
                "pid": os.getpid() + 1,
                "created_at": time.time() - bootstrap_lock.BOOTSTRAP_LOCK_STALE_SECONDS - 1,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(bootstrap_lock, "_process_exists", lambda _pid: True)
    _disable_lock_wait(monkeypatch)

    with interpreter._bootstrap_lock(lock_path):  # noqa: SLF001
        assert lock_path.exists()

    assert not lock_path.exists()


def test_bootstrap_lock_write_failure_closes_descriptor_and_removes_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock_path = tmp_path / ".bootstrap.lock"
    acquired_fds: list[int] = []

    def fail_write(lock_fd: int) -> None:
        acquired_fds.append(lock_fd)
        raise OSError("disk full")

    monkeypatch.setattr(bootstrap_lock, "_write_bootstrap_lock", fail_write)

    with pytest.raises(OSError, match="disk full"):
        with interpreter._bootstrap_file_lock(lock_path):  # noqa: SLF001
            pytest.fail("write failure must prevent lock acquisition")

    assert acquired_fds
    with pytest.raises(OSError):
        os.fstat(acquired_fds[0])
    assert not lock_path.exists()


def test_discover_base_interpreter_skips_a_frozen_sys_executable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A packaged sidecar is a PyInstaller binary: sys.executable is sidecar.exe.

    It answers ``--version`` with exit 0, so an ordering that trusts it ahead
    of PATH would select it, fail ``-m venv`` and never try the interpreter
    that used to work.
    """
    frozen_self = tmp_path / "sidecar.exe"
    path_python = tmp_path / "path-python.exe"
    frozen_self.write_text("", encoding="utf-8")
    path_python.write_text("", encoding="utf-8")
    validated: list[Path] = []

    monkeypatch.setattr(interpreter.sys, "executable", str(frozen_self))
    monkeypatch.setattr(interpreter.sys, "frozen", True, raising=False)
    monkeypatch.setattr(interpreter, "read_environment_value", lambda _key: None)
    monkeypatch.setattr(interpreter.shutil, "which", lambda _command: str(path_python))
    monkeypatch.setattr(
        interpreter,
        "_validated_interpreter",
        lambda candidate: validated.append(candidate) or candidate,
    )

    assert interpreter.discover_base_interpreter({}) == path_python
    assert validated == [path_python]


def test_validated_interpreter_probes_with_python_code_not_version_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``--version`` is not proof of an interpreter; evaluating Python is."""
    candidate = tmp_path / "python.exe"
    probes: list[list[str]] = []

    def fake_run(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        probes.append(argv)
        if argv[1:2] == ["--version"]:
            return subprocess.CompletedProcess(argv, 0, "", "2026-08-17")
        assert argv[1] == "-c" and "sys.version" in argv[2]
        return subprocess.CompletedProcess(argv, 0, "3.13.14\n", "")

    monkeypatch.setattr(bootstrap_subprocess, "run", fake_run)
    interpreter._VALIDATED_INTERPRETER_CACHE.pop(str(candidate), None)  # noqa: SLF001

    assert interpreter._validated_interpreter(candidate) == candidate  # noqa: SLF001
    assert probes and probes[0][1] == "-c"
    assert interpreter._VALIDATED_INTERPRETER_VERSIONS[str(candidate)] == "3.13.14"  # noqa: SLF001


def test_mixed_tag_wheelhouse_fails_fast_before_pip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every binary wheel must fit the interpreter, not just one of them."""
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    for name in (
        "numpy-2.4.3-cp313-cp313-win_amd64.whl",
        "scipy-1.17.1-cp312-cp312-win_amd64.whl",
        "tabulate-0.10.0-py3-none-any.whl",
    ):
        (wheelhouse / name).write_bytes(name.encode("utf-8"))
    install_calls: list[list[str]] = []
    monkeypatch.setattr(interpreter, "_interpreter_identity", lambda _python: "3.13.14")
    monkeypatch.setattr(
        bootstrap_subprocess,
        "run",
        lambda argv, **_kwargs: install_calls.append(argv)
        or subprocess.CompletedProcess(argv, 0, "", ""),
    )

    with pytest.raises(interpreter.PythonRuntimeError) as exc_info:
        interpreter._install_from_wheelhouse(tmp_path / "python.exe", wheelhouse)  # noqa: SLF001

    assert "scipy-1.17.1-cp312-cp312-win_amd64.whl" in str(exc_info.value)
    assert "cp312" in str(exc_info.value)
    assert install_calls == [], "pip must not run against a wheelhouse that cannot fit"


def test_retained_staging_from_another_interpreter_is_rebuilt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A resume behind a changed interpreter would republish the old build."""
    venv_root = tmp_path / "runtime"
    staging_dir = venv_root / "venv.build"
    staging_python = staging_dir / "Scripts" / "python.exe"
    staging_python.parent.mkdir(parents=True)
    staging_python.write_text("", encoding="utf-8")
    config = {"tools_python_runtime_root": str(venv_root)}
    (staging_dir / interpreter.RUNTIME_INSTALL_SENTINEL).write_text(
        json.dumps(
            {
                "requirements_fingerprint": interpreter._runtime_requirements_fingerprint(  # noqa: SLF001
                    config
                ),
                "base_interpreter": str(tmp_path / "old-python.exe"),
                "created_at": time.time(),
            }
        ),
        encoding="utf-8",
    )
    new_python = tmp_path / "new-python.exe"
    rebuilt: list[str] = []

    def fake_create(_config: object, target: Path, **_kwargs: object) -> Path:
        rebuilt.append("create")
        python = target / "Scripts" / "python.exe"
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_text("", encoding="utf-8")
        return python

    monkeypatch.setattr(interpreter, "discover_base_interpreter", lambda _config: new_python)
    monkeypatch.setattr(interpreter, "_create_runtime_venv", fake_create)
    monkeypatch.setattr(interpreter, "_validate_runtime_imports", lambda *_a, **_k: True)
    monkeypatch.setattr(interpreter, "_interpreter_identity", lambda _path: "3.13.14")
    interpreter._READY_VENV_CACHE.clear()  # noqa: SLF001

    with caplog.at_level("INFO"):
        interpreter.ensure_runtime_venv(config)

    assert rebuilt == ["create"], "a tree built by another interpreter must be rebuilt"
    assert any(
        getattr(record, "event", "") == "ai.tools.python_runtime.bootstrap.staging_reclaimed"
        and getattr(record, "data", {}).get("reason") == "interpreter_changed"
        for record in caplog.records
    )


def test_lock_stale_window_outlives_the_longest_bootstrap_budget() -> None:
    """A live owner inside its budget must never have its lock (and its
    half-built staging tree) reclaimed by the next caller."""
    assert bootstrap_lock.BOOTSTRAP_LOCK_STALE_SECONDS > interpreter.MAX_BOOTSTRAP_BUDGET_SECONDS


def test_stderr_tail_is_redacted_before_it_is_truncated() -> None:
    """A 400-char cut landing inside a path used to strip the drive anchor the
    redaction keys on, leaving the username in the tail."""
    private = r"C:\Users\example\.companion\python-runtime\venv\Lib\site-packages\numpy\core\_multiarray_umath.cp313-win_amd64.pyd"
    stderr = ("x " * 190) + private + (" y" * 120)
    error = subprocess.CalledProcessError(1, ["pip"], stderr=stderr)

    detail = bootstrap_telemetry.BootstrapTelemetry.error_detail(error)

    assert "example" not in detail
    assert "[redacted:path]" in detail
