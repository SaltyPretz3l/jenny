from __future__ import annotations

import base64
import ctypes
import hashlib
import importlib
import io
import json
import os
import subprocess
import sys
import threading
import time
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_PYTHON_EXECUTION_FAILED,
    CMP_TOOL_PYTHON_NOT_AVAILABLE,
)
from sidecar.ai.tools.builtins.python_runtime import bootstrap_lock as bootstrap_lock_module
from sidecar.ai.tools.builtins.python_runtime import interpreter as interpreter_module
from sidecar.ai.tools.builtins.python_runtime import job_object as job_object_module
from sidecar.ai.tools.builtins.python_runtime import pip_bootstrap as pip_bootstrap_module
from sidecar.ai.tools.builtins.python_runtime import sandbox as sandbox_module
from sidecar.ai.tools.builtins.python_runtime import tool as tool_module
from sidecar.ai.tools.builtins.python_runtime.interpreter import (
    RUNTIME_PACKAGES,
    _bootstrap_lock,
    configured_memory_limit_mb,
    configured_timeout_seconds,
    discover_base_interpreter,
    ensure_runtime_venv,
)
from sidecar.ai.tools.builtins.python_runtime.output import format_python_output
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

# For tests that exercise the real Windows venv layout (Scripts/python.exe) or
# fake os.name="nt": on POSIX the os.name patch flips pathlib to WindowsPath,
# which pytest itself then trips over (INTERNALERROR aborting the session).
windows_only = pytest.mark.skipif(
    sys.platform != "win32",
    reason="exercises Windows-only venv layout / sandbox wiring",
)


def test_wrapper_pipe_capture_rejects_output_over_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sandbox_module, "MAX_WRAPPER_PIPE_BYTES", 64)

    class _FakeProcess:
        args = ["python"]
        stdout = io.BytesIO(b"x" * 65)
        stderr = io.BytesIO()

        @staticmethod
        def poll() -> int:
            return 0

    with pytest.raises(RuntimeError, match="output exceeded"):
        sandbox_module._capture_wrapper_output(  # noqa: SLF001
            _FakeProcess(),  # type: ignore[arg-type]
            timeout_seconds=1,
        )


@windows_only
def test_windows_python_job_sets_aggregate_and_per_process_memory_limits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, int] = {}

    class _Kernel32:
        @staticmethod
        def CreateJobObjectW(_security: object, _name: object) -> int:
            return 123

        @staticmethod
        def SetInformationJobObject(
            _handle: object,
            _info_class: object,
            raw_info: object,
            _size: object,
        ) -> bool:
            info = ctypes.cast(
                raw_info,
                ctypes.POINTER(job_object_module.JOBOBJECT_EXTENDED_LIMIT_INFORMATION),
            ).contents
            captured["flags"] = int(info.BasicLimitInformation.LimitFlags)
            captured["process"] = int(info.ProcessMemoryLimit)
            captured["job"] = int(info.JobMemoryLimit)
            return True

        @staticmethod
        def CloseHandle(_handle: object) -> bool:
            return True

    monkeypatch.setattr(job_object_module, "kernel32", _Kernel32())
    with job_object_module.JobObject(memory_limit_mb=128):
        pass

    assert captured["flags"] & job_object_module.JOB_OBJECT_LIMIT_PROCESS_MEMORY
    assert captured["flags"] & job_object_module.JOB_OBJECT_LIMIT_JOB_MEMORY
    assert captured["process"] == 128 * 1024 * 1024
    assert captured["job"] == 128 * 1024 * 1024


def test_discover_base_interpreter_prefers_explicit_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    explicit = tmp_path / "python.exe"
    explicit.write_text("", encoding="utf-8")
    validated: list[Path] = []

    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.python_runtime.interpreter._validated_interpreter",
        lambda candidate: validated.append(candidate) or candidate,
    )

    result = discover_base_interpreter({"tools_python_runtime_interpreter": str(explicit)})

    assert result == explicit
    assert validated == [explicit]


def test_discover_base_interpreter_ignores_untrusted_env_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env_python = tmp_path / "malware-python.exe"
    env_python.write_text("", encoding="utf-8")
    validated: list[Path] = []

    monkeypatch.setattr(
        interpreter_module,
        "read_environment_value",
        lambda key: str(env_python) if key == "JENNY_PYTHON_RUNTIME" else None,
    )
    monkeypatch.setattr(interpreter_module.shutil, "which", lambda _command: None)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.python_runtime.interpreter._validated_interpreter",
        lambda candidate: validated.append(candidate) or candidate,
    )

    result = discover_base_interpreter({})

    assert result == Path(sys.executable)
    assert env_python not in validated


def _write_fresh_marker(venv_dir: Path, config: dict[str, str]) -> None:
    """Write a marker production will accept as ready.

    Readiness binds to the *config-aware* fingerprint: when a wheelhouse
    carrying ``runtime_lock_sha256`` is resolvable (this repo vendors one),
    production hashes the top-level pins together with that transitive lock.
    Writing the bare top-level fingerprint here reads as stale and silently
    diverts these tests into a real venv rebuild instead of the path under test.
    """
    (venv_dir / interpreter_module.RUNTIME_READY_MARKER).write_text(
        json.dumps(
            {
                "schema_version": interpreter_module.RUNTIME_MARKER_SCHEMA_VERSION,
                "interpreter_identity": "3.12.4",
                "requirements_fingerprint": interpreter_module._runtime_requirements_fingerprint(config),  # noqa: SLF001
                "validated_imports": list(interpreter_module._REQUIRED_IMPORT_NAMES),  # noqa: SLF001
                "created_at": time.time(),
            }
        ),
        encoding="utf-8",
    )


@windows_only
def test_ensure_runtime_venv_is_noop_when_marker_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv_root = tmp_path / "runtime"
    venv_dir = venv_root / "venv"
    python_path = venv_dir / "Scripts" / "python.exe"
    python_path.parent.mkdir(parents=True)
    python_path.write_text("", encoding="utf-8")
    config = {"tools_python_runtime_root": str(venv_root)}
    _write_fresh_marker(venv_dir, config)
    monkeypatch.setattr(
        interpreter_module,
        "_validate_runtime_imports",
        lambda _venv_python, **_kwargs: True,
    )

    result = ensure_runtime_venv(config)

    assert result == python_path


def test_runtime_packages_are_version_pinned() -> None:
    assert all("==" in package for package in RUNTIME_PACKAGES)


def _write_wheelhouse_fixture(wheelhouse: Path) -> None:
    """Write a single dummy wheel plus a manifest whose checksum matches it,
    satisfying `_verify_wheelhouse_integrity` for tests that only care about
    the install command construction, not real package contents."""
    wheelhouse.mkdir(parents=True, exist_ok=True)
    wheel_path = wheelhouse / "dummy_pkg-1.0-py3-none-any.whl"
    wheel_path.write_bytes(b"dummy wheel contents")
    digest = hashlib.sha256(wheel_path.read_bytes()).hexdigest()
    (wheelhouse / interpreter_module.WHEELHOUSE_MANIFEST_FILENAME).write_text(
        json.dumps({"schema_version": 1, "algorithm": "sha256", "files": {wheel_path.name: digest}}),
        encoding="utf-8",
    )


def test_install_runtime_packages_prefers_configured_offline_wheelhouse(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    venv_python = tmp_path / "venv" / "Scripts" / "python.exe"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("", encoding="utf-8")
    wheelhouse = tmp_path / "wheelhouse"
    _write_wheelhouse_fixture(wheelhouse)
    calls: list[list[str]] = []

    monkeypatch.setattr(interpreter_module.shutil, "which", lambda _command: None)

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(interpreter_module.bootstrap_subprocess, "run", fake_run)

    interpreter_module._install_runtime_packages(  # noqa: SLF001
        venv_python,
        {"tools_python_runtime_wheelhouse_dir": str(wheelhouse)},
    )

    assert calls == [
        [
            str(venv_python),
            "-m",
            "pip",
            "install",
            "--no-input",
            "--no-index",
            "--find-links",
            str(wheelhouse),
            "--only-binary=:all:",
            "--no-compile",
            *RUNTIME_PACKAGES,
        ]
    ]


@windows_only
def test_ensure_runtime_venv_bootstraps_via_staging_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    venv_root = tmp_path / "runtime"
    final_venv_dir = venv_root / "venv"
    partial_python = final_venv_dir / "Scripts" / "python.exe"
    partial_python.parent.mkdir(parents=True)
    partial_python.write_text("partial", encoding="utf-8")
    base_python = tmp_path / "base-python.exe"
    base_python.write_text("", encoding="utf-8")
    install_targets: list[Path] = []

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        if command[1:3] == ["-m", "venv"]:
            staging_dir = Path(command[3])
            staging_python = staging_dir / "Scripts" / "python.exe"
            staging_python.parent.mkdir(parents=True, exist_ok=True)
            staging_python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.python_runtime.interpreter.discover_base_interpreter",
        lambda _config: base_python,
    )
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.python_runtime.interpreter.bootstrap_subprocess.run",
        fake_run,
    )
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.python_runtime.interpreter._install_runtime_packages",
        lambda python_path, _config=None: install_targets.append(python_path),
    )

    result = ensure_runtime_venv({"tools_python_runtime_root": str(venv_root)})

    assert result == final_venv_dir / "Scripts" / "python.exe"
    assert install_targets == [venv_root / "venv.build" / "Scripts" / "python.exe"]
    assert (final_venv_dir / ".jenny-ready").exists()
    assert not (venv_root / "venv.build").exists()


# ── Fingerprinted readiness marker ──────────────────────────────────


@windows_only
def test_validation_failure_retains_installed_staging_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv_root = tmp_path / "runtime"
    staging_dir = venv_root / "venv.build"
    base_python = tmp_path / "base-python.exe"
    base_python.write_text("", encoding="utf-8")

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[1:3] == ["-m", "venv"]:
            staging_python = Path(command[3]) / "Scripts" / "python.exe"
            staging_python.parent.mkdir(parents=True)
            staging_python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")

    def fail_validation(
        _python_path: Path,
        *_args: object,
        error_sink: list[BaseException] | None = None,
        **_kwargs: object,
    ) -> bool:
        if error_sink is not None:
            error_sink.append(subprocess.TimeoutExpired("cold imports", 180))
        return False

    monkeypatch.setattr(interpreter_module, "discover_base_interpreter", lambda _config: base_python)
    monkeypatch.setattr(interpreter_module.bootstrap_subprocess, "run", fake_run)
    monkeypatch.setattr(interpreter_module, "_install_runtime_packages", lambda *_args: "wheelhouse")
    monkeypatch.setattr(interpreter_module, "_validate_runtime_imports", fail_validation)

    config = {"tools_python_runtime_root": str(venv_root)}
    with pytest.raises(interpreter_module.PythonRuntimeError, match="import validation"):
        ensure_runtime_venv(config)

    sentinel = staging_dir / interpreter_module.RUNTIME_INSTALL_SENTINEL
    assert staging_dir.is_dir()
    assert sentinel.is_file()
    assert json.loads(sentinel.read_text(encoding="utf-8"))["requirements_fingerprint"] == (
        interpreter_module._runtime_requirements_fingerprint(config)  # noqa: SLF001
    )
    assert not (staging_dir / interpreter_module.RUNTIME_READY_MARKER).exists()
    assert not (venv_root / "venv").exists()


@windows_only
def test_sentinel_staging_revalidates_and_publishes_without_reinstall(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    venv_root = tmp_path / "runtime"
    staging_dir = venv_root / "venv.build"
    staging_python = staging_dir / "Scripts" / "python.exe"
    staging_python.parent.mkdir(parents=True)
    staging_python.write_text("", encoding="utf-8")
    config = {"tools_python_runtime_root": str(venv_root)}
    base_python = tmp_path / "base-python.exe"
    (staging_dir / interpreter_module.RUNTIME_INSTALL_SENTINEL).write_text(
        json.dumps(
            {
                "requirements_fingerprint": interpreter_module._runtime_requirements_fingerprint(  # noqa: SLF001
                    config
                ),
                "base_interpreter": str(base_python),
                "created_at": time.time(),
            }
        ),
        encoding="utf-8",
    )
    validate_calls: list[Path] = []

    # Resume re-discovers the interpreter (cheap, cached) so a retained tree
    # is only revalidated behind the interpreter that built it.
    monkeypatch.setattr(
        interpreter_module,
        "discover_base_interpreter",
        lambda _config: base_python,
    )
    monkeypatch.setattr(
        interpreter_module,
        "_install_runtime_packages",
        lambda *_args: pytest.fail("resume must not reinstall packages"),
    )
    monkeypatch.setattr(
        interpreter_module,
        "_validate_runtime_imports",
        lambda python_path, **_kwargs: validate_calls.append(python_path) or True,
    )
    monkeypatch.setattr(interpreter_module, "_interpreter_identity", lambda _path: "3.11.7")

    with caplog.at_level("INFO"):
        result = ensure_runtime_venv(config)

    final_dir = venv_root / "venv"
    assert result == final_dir / "Scripts" / "python.exe"
    assert validate_calls == [staging_python]
    assert (final_dir / interpreter_module.RUNTIME_READY_MARKER).is_file()
    assert (final_dir / interpreter_module.RUNTIME_INSTALL_SENTINEL).is_file()
    assert not staging_dir.exists()
    assert any(
        getattr(record, "event", "")
        == "ai.tools.python_runtime.bootstrap.imports_validated"
        and getattr(record, "data", {}).get("source") == "retained_staging"
        for record in caplog.records
    )


@windows_only
def test_marker_write_failure_leaves_staging_resumable_without_reinstall(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv_root = tmp_path / "runtime"
    staging_dir = venv_root / "venv.build"
    staging_python = staging_dir / "Scripts" / "python.exe"
    base_python = tmp_path / "base-python.exe"
    base_python.write_text("", encoding="utf-8")
    install_calls: list[Path] = []
    marker_calls = 0
    original_write_marker = interpreter_module._write_runtime_marker  # noqa: SLF001

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[1:3] == ["-m", "venv"]:
            staging_python.parent.mkdir(parents=True)
            staging_python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")

    def fail_marker_once(*args: object, **kwargs: object) -> None:
        nonlocal marker_calls
        marker_calls += 1
        if marker_calls == 1:
            raise OSError("marker write failed")
        original_write_marker(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(interpreter_module, "discover_base_interpreter", lambda _config: base_python)
    monkeypatch.setattr(interpreter_module.bootstrap_subprocess, "run", fake_run)
    monkeypatch.setattr(
        interpreter_module,
        "_install_runtime_packages",
        lambda python_path, _config=None: install_calls.append(python_path) or "wheelhouse",
    )
    monkeypatch.setattr(interpreter_module, "_validate_runtime_imports", lambda *_a, **_k: True)
    monkeypatch.setattr(interpreter_module, "_interpreter_identity", lambda _path: "3.11.7")
    monkeypatch.setattr(interpreter_module, "_write_runtime_marker", fail_marker_once)

    config = {"tools_python_runtime_root": str(venv_root)}
    with pytest.raises(OSError, match="marker write failed"):
        ensure_runtime_venv(config)

    assert staging_dir.is_dir()
    assert (staging_dir / interpreter_module.RUNTIME_INSTALL_SENTINEL).is_file()
    monkeypatch.setattr(
        interpreter_module,
        "_install_runtime_packages",
        lambda *_args: pytest.fail("resume must not reinstall packages"),
    )

    result = ensure_runtime_venv(config)

    assert result == venv_root / "venv" / "Scripts" / "python.exe"
    assert install_calls == [staging_python]
    assert marker_calls == 2


@windows_only
def test_install_failure_deletes_staging_tree_without_sentinel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv_root = tmp_path / "runtime"
    staging_dir = venv_root / "venv.build"
    base_python = tmp_path / "base-python.exe"
    base_python.write_text("", encoding="utf-8")

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[1:3] == ["-m", "venv"]:
            staging_python = Path(command[3]) / "Scripts" / "python.exe"
            staging_python.parent.mkdir(parents=True)
            staging_python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(interpreter_module, "discover_base_interpreter", lambda _config: base_python)
    monkeypatch.setattr(interpreter_module.bootstrap_subprocess, "run", fake_run)
    monkeypatch.setattr(
        interpreter_module,
        "_install_runtime_packages",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("install failed")),
    )

    with pytest.raises(RuntimeError, match="install failed"):
        ensure_runtime_venv({"tools_python_runtime_root": str(venv_root)})

    assert not staging_dir.exists()
    assert not (staging_dir / interpreter_module.RUNTIME_INSTALL_SENTINEL).exists()


@windows_only
def test_sentinel_staging_tree_never_satisfies_ready_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    staging_dir = tmp_path / "venv.build"
    staging_python = staging_dir / "Scripts" / "python.exe"
    staging_python.parent.mkdir(parents=True)
    staging_python.write_text("", encoding="utf-8")
    (staging_dir / interpreter_module.RUNTIME_INSTALL_SENTINEL).write_text(
        json.dumps({"created_at": time.time()}), encoding="utf-8"
    )
    monkeypatch.setattr(
        interpreter_module,
        "_validate_runtime_imports",
        lambda *_args, **_kwargs: pytest.fail("unmarked staging must not be validated as ready"),
    )

    assert interpreter_module._venv_is_ready(staging_dir) is None  # noqa: SLF001


def test_marker_matches_expected_rejects_corrupted_json(tmp_path: Path) -> None:
    marker_path = tmp_path / ".jenny-ready"
    marker_path.write_text("{not valid json", encoding="utf-8")

    marker = interpreter_module._read_runtime_marker(marker_path)  # noqa: SLF001

    assert marker is None
    assert interpreter_module._marker_matches_expected(marker) is False  # noqa: SLF001


def test_marker_matches_expected_rejects_missing_fields() -> None:
    incomplete = {"schema_version": interpreter_module.RUNTIME_MARKER_SCHEMA_VERSION}

    assert interpreter_module._marker_matches_expected(incomplete) is False  # noqa: SLF001


def test_marker_matches_expected_rejects_stale_requirements_fingerprint() -> None:
    marker = {
        "schema_version": interpreter_module.RUNTIME_MARKER_SCHEMA_VERSION,
        "interpreter_identity": "3.12.4",
        "requirements_fingerprint": "stale-fingerprint-from-an-old-lock",
        "validated_imports": list(interpreter_module._REQUIRED_IMPORT_NAMES),  # noqa: SLF001
    }

    assert interpreter_module._marker_matches_expected(marker) is False  # noqa: SLF001


def test_marker_matches_expected_rejects_incomplete_validated_imports() -> None:
    marker = {
        "schema_version": interpreter_module.RUNTIME_MARKER_SCHEMA_VERSION,
        "interpreter_identity": "3.12.4",
        "requirements_fingerprint": interpreter_module._requirements_fingerprint(),  # noqa: SLF001
        "validated_imports": ["pandas"],
    }

    assert interpreter_module._marker_matches_expected(marker) is False  # noqa: SLF001


def test_marker_matches_expected_accepts_a_fresh_marker() -> None:
    marker = {
        "schema_version": interpreter_module.RUNTIME_MARKER_SCHEMA_VERSION,
        "interpreter_identity": "3.12.4",
        "requirements_fingerprint": interpreter_module._requirements_fingerprint(),  # noqa: SLF001
        "validated_imports": list(interpreter_module._REQUIRED_IMPORT_NAMES),  # noqa: SLF001
    }

    assert interpreter_module._marker_matches_expected(marker) is True  # noqa: SLF001


def test_venv_is_ready_returns_none_for_corrupted_marker(tmp_path: Path) -> None:
    venv_dir = tmp_path / "venv"
    python_path = interpreter_module._venv_python(venv_dir)  # noqa: SLF001
    python_path.parent.mkdir(parents=True)
    python_path.write_text("", encoding="utf-8")
    (venv_dir / interpreter_module.RUNTIME_READY_MARKER).write_text("{corrupted", encoding="utf-8")

    assert interpreter_module._venv_is_ready(venv_dir) is None  # noqa: SLF001


@windows_only
def test_ensure_runtime_venv_rebuilds_when_marker_fingerprint_is_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A marker from an older/different dependency lock must not be trusted:
    it should be treated as not-ready and rebuilt, not reused as-is."""
    venv_root = tmp_path / "runtime"
    venv_dir = venv_root / "venv"
    python_path = venv_dir / "Scripts" / "python.exe"
    python_path.parent.mkdir(parents=True)
    python_path.write_text("stale", encoding="utf-8")
    (venv_dir / interpreter_module.RUNTIME_READY_MARKER).write_text(
        json.dumps(
            {
                "schema_version": interpreter_module.RUNTIME_MARKER_SCHEMA_VERSION,
                "interpreter_identity": "3.12.4",
                "requirements_fingerprint": "stale-fingerprint-from-an-old-lock",
                "validated_imports": list(interpreter_module._REQUIRED_IMPORT_NAMES),  # noqa: SLF001
            }
        ),
        encoding="utf-8",
    )
    base_python = tmp_path / "base-python.exe"
    base_python.write_text("", encoding="utf-8")
    install_calls: list[Path] = []

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        if command[1:3] == ["-m", "venv"]:
            staging_dir = Path(command[3])
            staging_python = staging_dir / "Scripts" / "python.exe"
            staging_python.parent.mkdir(parents=True, exist_ok=True)
            staging_python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(interpreter_module, "discover_base_interpreter", lambda _config: base_python)
    monkeypatch.setattr(interpreter_module.bootstrap_subprocess, "run", fake_run)
    monkeypatch.setattr(
        interpreter_module,
        "_install_runtime_packages",
        lambda python_path, _config=None: install_calls.append(python_path),
    )

    config = {"tools_python_runtime_root": str(venv_root)}
    result = ensure_runtime_venv(config)

    assert result == python_path
    assert install_calls == [venv_root / "venv.build" / "Scripts" / "python.exe"]
    marker = json.loads((venv_dir / interpreter_module.RUNTIME_READY_MARKER).read_text(encoding="utf-8"))
    # The rebuild stamps the fingerprint production validates against: the
    # top-level pins hashed together with the vendored wheelhouse's lock.
    expected_fingerprint = interpreter_module._runtime_requirements_fingerprint(config)  # noqa: SLF001
    assert marker["requirements_fingerprint"] == expected_fingerprint


@windows_only
def test_ensure_runtime_venv_rebuilds_when_import_validation_fails_on_existing_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fresh-looking marker whose recorded packages no longer actually
    import (e.g. corrupted/partially-deleted site-packages) must be treated
    as not ready rather than trusted at face value."""
    venv_root = tmp_path / "runtime"
    venv_dir = venv_root / "venv"
    python_path = venv_dir / "Scripts" / "python.exe"
    python_path.parent.mkdir(parents=True)
    python_path.write_text("", encoding="utf-8")
    config = {"tools_python_runtime_root": str(venv_root)}
    _write_fresh_marker(venv_dir, config)
    base_python = tmp_path / "base-python.exe"
    base_python.write_text("", encoding="utf-8")
    install_calls: list[Path] = []

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        if command[1:3] == ["-m", "venv"]:
            staging_dir = Path(command[3])
            staging_python = staging_dir / "Scripts" / "python.exe"
            staging_python.parent.mkdir(parents=True, exist_ok=True)
            staging_python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(interpreter_module, "discover_base_interpreter", lambda _config: base_python)
    monkeypatch.setattr(interpreter_module.bootstrap_subprocess, "run", fake_run)
    monkeypatch.setattr(
        interpreter_module,
        "_install_runtime_packages",
        lambda python_path, _config=None: install_calls.append(python_path),
    )
    # The existing env's real import check fails (simulating corrupted
    # site-packages); the rebuild's own post-install import check must still
    # succeed so the rebuild can complete.
    validate_calls: list[Path] = []

    def fake_validate(candidate_python: Path, *_args, **_kwargs) -> bool:
        validate_calls.append(candidate_python)
        return candidate_python != python_path

    monkeypatch.setattr(interpreter_module, "_validate_runtime_imports", fake_validate)

    result = ensure_runtime_venv(config)

    assert result == python_path
    assert install_calls == [venv_root / "venv.build" / "Scripts" / "python.exe"]
    assert python_path in validate_calls


@windows_only
def test_ensure_runtime_venv_interrupted_install_produces_no_ready_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv_root = tmp_path / "runtime"
    venv_dir = venv_root / "venv"
    base_python = tmp_path / "base-python.exe"
    base_python.write_text("", encoding="utf-8")

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        if command[1:3] == ["-m", "venv"]:
            staging_dir = Path(command[3])
            staging_python = staging_dir / "Scripts" / "python.exe"
            staging_python.parent.mkdir(parents=True, exist_ok=True)
            staging_python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")

    def boom(_python_path: Path, _config: object = None) -> None:
        raise RuntimeError("simulated interrupted install")

    monkeypatch.setattr(interpreter_module, "discover_base_interpreter", lambda _config: base_python)
    monkeypatch.setattr(interpreter_module.bootstrap_subprocess, "run", fake_run)
    monkeypatch.setattr(interpreter_module, "_install_runtime_packages", boom)

    with pytest.raises(RuntimeError, match="simulated interrupted install"):
        ensure_runtime_venv({"tools_python_runtime_root": str(venv_root)})

    assert not (venv_dir / interpreter_module.RUNTIME_READY_MARKER).exists()
    assert not venv_dir.exists()


@windows_only
def test_ensure_runtime_venv_concurrent_first_invocation_builds_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv_root = tmp_path / "runtime"
    base_python = tmp_path / "base-python.exe"
    base_python.write_text("", encoding="utf-8")
    install_calls: list[Path] = []
    calls_guard = threading.Lock()

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        if command[1:3] == ["-m", "venv"]:
            staging_dir = Path(command[3])
            staging_python = staging_dir / "Scripts" / "python.exe"
            staging_python.parent.mkdir(parents=True, exist_ok=True)
            staging_python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")

    def fake_install(python_path: Path, _config: object = None) -> None:
        with calls_guard:
            install_calls.append(python_path)
        time.sleep(0.05)  # widen the race window so a locking bug would show up

    monkeypatch.setattr(interpreter_module, "discover_base_interpreter", lambda _config: base_python)
    monkeypatch.setattr(interpreter_module.bootstrap_subprocess, "run", fake_run)
    monkeypatch.setattr(interpreter_module, "_install_runtime_packages", fake_install)

    config = {"tools_python_runtime_root": str(venv_root)}
    results: list[Path] = []
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            results.append(ensure_runtime_venv(config))
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert not any(thread.is_alive() for thread in threads)
    assert not errors
    assert len(install_calls) == 1
    assert len(results) == 4
    assert set(results) == {venv_root / "venv" / "Scripts" / "python.exe"}


# ── Wheelhouse checksum-manifest integrity ──────────────────────────


def test_configured_missing_wheelhouse_reports_actionable_fail_closed_error(
    tmp_path: Path,
) -> None:
    wheelhouse = tmp_path / "missing-wheelhouse"

    with pytest.raises(FileNotFoundError) as caught:
        interpreter_module._runtime_wheelhouse(  # noqa: SLF001
            {"tools_python_runtime_wheelhouse_dir": str(wheelhouse)}
        )

    assert str(wheelhouse) in str(caught.value)
    assert "scripts/build-python-runtime-bundle.py" in str(caught.value)
    assert "will not fall back" in str(caught.value)


def test_install_runtime_packages_fails_closed_on_wheelhouse_checksum_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv_python = tmp_path / "venv" / "Scripts" / "python.exe"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("", encoding="utf-8")
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    wheel_path = wheelhouse / "dummy_pkg-1.0-py3-none-any.whl"
    wheel_path.write_bytes(b"original contents")
    (wheelhouse / interpreter_module.WHEELHOUSE_MANIFEST_FILENAME).write_text(
        json.dumps(
            {"schema_version": 1, "algorithm": "sha256", "files": {wheel_path.name: "0" * 64}}
        ),
        encoding="utf-8",
    )
    uv_calls: list[Path] = []
    network_calls: list[Path] = []
    monkeypatch.setattr(
        interpreter_module,
        "_install_via_uv",
        lambda candidate: uv_calls.append(candidate) or False,
    )
    monkeypatch.setattr(
        interpreter_module,
        "_install_via_network_pip",
        lambda candidate: network_calls.append(candidate),
    )

    with pytest.raises(interpreter_module.PythonRuntimeWheelhouseIntegrityError):
        interpreter_module._install_runtime_packages(  # noqa: SLF001
            venv_python, {"tools_python_runtime_wheelhouse_dir": str(wheelhouse)}
        )

    assert uv_calls == []
    assert network_calls == []


def test_install_runtime_packages_fails_closed_on_missing_wheelhouse_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv_python = tmp_path / "venv" / "Scripts" / "python.exe"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("", encoding="utf-8")
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    (wheelhouse / "dummy_pkg-1.0-py3-none-any.whl").write_bytes(b"contents")
    network_calls: list[Path] = []
    monkeypatch.setattr(
        interpreter_module,
        "_install_via_network_pip",
        lambda candidate: network_calls.append(candidate),
    )

    with pytest.raises(interpreter_module.PythonRuntimeWheelhouseIntegrityError):
        interpreter_module._install_runtime_packages(  # noqa: SLF001
            venv_python, {"tools_python_runtime_wheelhouse_dir": str(wheelhouse)}
        )

    assert network_calls == []


def test_install_runtime_packages_fails_closed_on_unexpected_extra_wheel(
    tmp_path: Path,
) -> None:
    venv_python = tmp_path / "venv" / "Scripts" / "python.exe"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("", encoding="utf-8")
    wheelhouse = tmp_path / "wheelhouse"
    _write_wheelhouse_fixture(wheelhouse)
    # A wheel present on disk but absent from the manifest is itself a supply
    # chain risk (an attacker could plant a wheel alongside legitimate ones).
    (wheelhouse / "unexpected_pkg-9.9-py3-none-any.whl").write_bytes(b"planted")

    with pytest.raises(interpreter_module.PythonRuntimeWheelhouseIntegrityError):
        interpreter_module._install_runtime_packages(venv_python, {  # noqa: SLF001
            "tools_python_runtime_wheelhouse_dir": str(wheelhouse)
        })


def test_install_runtime_packages_raises_typed_error_when_offline_install_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """No wheelhouse configured/present, uv unavailable, and the network pip
    install fails -> a typed PythonRuntimeOfflineInstallError, not a raw
    subprocess error, and no silent hang."""
    venv_python = tmp_path / "venv" / "Scripts" / "python.exe"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("", encoding="utf-8")

    monkeypatch.setattr(interpreter_module, "_runtime_wheelhouse", lambda _config: None)
    monkeypatch.setattr(interpreter_module.shutil, "which", lambda _command: None)

    def fake_run(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(interpreter_module.bootstrap_subprocess, "run", fake_run)

    with pytest.raises(interpreter_module.PythonRuntimeOfflineInstallError):
        interpreter_module._install_runtime_packages(venv_python, {})  # noqa: SLF001


def test_configured_python_runtime_limits_are_clamped() -> None:
    assert configured_timeout_seconds({"tools_python_runtime_timeout_seconds": -5}) == 1
    assert configured_timeout_seconds({"tools_python_runtime_timeout_seconds": 999999}) == 600
    assert configured_timeout_seconds({"tools_python_runtime_timeout_seconds": True}) == 30

    assert configured_memory_limit_mb({"tools_python_runtime_max_memory_mb": -5}) == 1
    assert configured_memory_limit_mb({"tools_python_runtime_max_memory_mb": 999999}) == 8192
    assert configured_memory_limit_mb({"tools_python_runtime_max_memory_mb": True}) == 512


def test_format_python_output_truncates_fields_and_produces_chart_attachments(
    tmp_path: Path,
) -> None:
    image_path = tmp_path / "figure_0.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\n")

    payload, attachments = format_python_output(
        {
            "stdout": "a" * 25000,
            "stderr": "",
            "error": None,
            "images": ["figure_0.png"],
            "tables": [
                {
                    "name": "df",
                    "html": "<table><tr><th>a</th></tr><tr><td>1</td></tr></table>",
                    "shape": [1, 1],
                }
            ],
            "last_expr_repr": "42",
        },
        tmp_path,
    )

    assert payload["truncated"] is True
    assert str(payload["stdout"]).endswith("...[truncated]")
    # WIDE-019: the model-visible payload carries safe refs only; the full
    # bytes ride the typed trusted-attachment side channel.
    assert "base64," not in json.dumps(payload)
    assert payload["images"][0]["id"] == attachments[0]["id"]
    assert payload["images"][0]["mime_type"] == "image/png"
    assert len(attachments) == 1
    assert attachments[0]["kind"] == "chart"
    assert attachments[0]["source_tool"] == "python_execute"
    decoded = base64.b64decode(attachments[0]["data_base64"], validate=True)
    assert decoded == image_path.read_bytes()
    assert attachments[0]["byte_length"] == len(decoded)
    assert payload["tables"][0]["name"] == "df"
    assert payload["last_expr_repr"] == "42"


def test_format_python_output_enforces_total_image_budget(tmp_path: Path) -> None:
    image_names = []
    for index in range(3):
        image_path = tmp_path / f"figure_{index}.png"
        image_path.write_bytes(b"\x89PNG\r\n\x1a\n" + (b"a" * 800_000))
        image_names.append(image_path.name)

    payload, attachments = format_python_output(
        {
            "stdout": "",
            "stderr": "",
            "error": None,
            "images": image_names,
            "tables": [],
            "last_expr_repr": None,
        },
        tmp_path,
    )

    assert payload["truncated"] is True
    assert len(payload["images"]) == 2
    assert len(attachments) == 2
    # WIDE-021: every kept encoding is COMPLETE — the over-budget third image
    # was dropped whole, never truncated mid-encoding.
    for attachment in attachments:
        decoded = base64.b64decode(attachment["data_base64"], validate=True)
        assert len(decoded) == attachment["byte_length"]


def test_format_python_output_rejects_oversized_image_before_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_path = tmp_path / "figure_0.png"
    image_path.write_bytes(b"png")
    image_path.write_bytes(b"x" * 64)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.python_runtime.output.MAX_IMAGE_BYTES",
        8,
    )

    payload, attachments = format_python_output(
        {"images": [image_path.name], "tables": []},
        tmp_path,
    )

    assert payload["images"] == []
    assert attachments == ()
    assert payload["truncated"] is True


def test_format_python_output_bounds_table_count_and_html(tmp_path: Path) -> None:
    payload, _attachments = format_python_output(
        {
            "images": [],
            "tables": [
                {"name": f"table-{index}", "html": "x" * 120_000, "shape": [1, 1000]}
                for index in range(12)
            ],
        },
        tmp_path,
    )

    assert len(payload["tables"]) <= 8
    assert sum(len(str(table["html"])) for table in payload["tables"]) <= 250_000
    assert payload["truncated"] is True


def test_python_execute_tool_fails_closed_on_non_windows(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(tool_module.sys, "platform", "linux")

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_module.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))

    assert caught.value.code == CMP_TOOL_PYTHON_NOT_AVAILABLE


def test_python_execute_tool_rejects_blank_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(tool_module.sys, "platform", "win32")

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_module.python_execute_tool({"code": "   "}, WorkspaceGuard(str(tmp_path)))

    assert caught.value.code == CMP_TOOL_PYTHON_EXECUTION_FAILED


def test_python_execute_tool_rejects_invalid_utf8_code(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(tool_module.sys, "platform", "win32")

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_module.python_execute_tool({"code": "print('x')\udc8f"}, WorkspaceGuard(str(tmp_path)))

    assert caught.value.code == CMP_TOOL_PYTHON_EXECUTION_FAILED
    assert "utf-8" in caught.value.message.lower()


def test_python_exec_wrapper_safe_json_dumps_replaces_lone_surrogates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_matplotlib = types.ModuleType("matplotlib")
    fake_matplotlib.use = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
    fake_pyplot = types.ModuleType("matplotlib.pyplot")
    fake_pyplot.get_fignums = lambda: []  # type: ignore[attr-defined]
    fake_pyplot.figure = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
    fake_pyplot.close = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
    fake_pyplot.show = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "matplotlib", fake_matplotlib)
    monkeypatch.setitem(sys.modules, "matplotlib.pyplot", fake_pyplot)
    sys.modules.pop("sidecar.ai.tools.builtins.python_runtime._exec_wrapper", None)
    exec_wrapper_module = importlib.import_module(
        "sidecar.ai.tools.builtins.python_runtime._exec_wrapper"
    )

    serialized = exec_wrapper_module._safe_json_dumps({"stdout": "bad\udc8fvalue"})  # noqa: SLF001

    assert "\udc8f" not in serialized
    assert json.loads(serialized) == {"stdout": "bad\ufffdvalue"}


def test_python_execute_tool_wraps_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(
        tool_module, "_PYTHON_RUNTIME_CONFIG", {"tools_python_runtime_timeout_seconds": 7}
    )
    monkeypatch.setattr(
        tool_module,
        "ensure_runtime_venv",
        lambda _config, **_kwargs: tmp_path / "python.exe",
    )
    monkeypatch.setattr(
        tool_module,
        "execute_sandboxed",
        lambda **_kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("python", 7)),
    )

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_module.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))

    assert caught.value.code == CMP_TOOL_PYTHON_EXECUTION_FAILED
    assert "timed out" in caught.value.message


def test_python_execute_tool_passes_bootstrap_deadline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captured: dict[str, float | None] = {}

    def ensure_runtime(
        _config: object, *, deadline_monotonic: float | None = None
    ) -> Path:
        captured["deadline_monotonic"] = deadline_monotonic
        return tmp_path / "python.exe"

    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(tool_module, "ensure_runtime_venv", ensure_runtime)
    monkeypatch.setattr(
        tool_module,
        "execute_sandboxed",
        lambda **_kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("python", 30)),
    )

    with pytest.raises(ToolExecutionFailure):
        tool_module.python_execute_tool(
            {"code": "print(1)"}, WorkspaceGuard(str(tmp_path))
        )

    assert captured["deadline_monotonic"] is not None


def test_python_execute_tool_reports_bootstrap_timeout_honestly(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config = {"tools_python_runtime_timeout_seconds": 7}
    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(tool_module, "_PYTHON_RUNTIME_CONFIG", config)
    monkeypatch.setattr(
        tool_module,
        "ensure_runtime_venv",
        lambda _config, **_kwargs: (_ for _ in ()).throw(
            subprocess.TimeoutExpired("bootstrap", 120)
        ),
    )

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_module.python_execute_tool(
            {"code": "print(1)"}, WorkspaceGuard(str(tmp_path))
        )

    assert "bootstrap" in caught.value.message
    assert "timed out after 7s" not in caught.value.message
    assert caught.value.failed_phase == "bootstrap"
    assert caught.value.failure_class == "limit_exceeded"
    assert caught.value.retryable is True


def test_python_execute_tool_preserves_user_code_timeout_wording(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config = {"tools_python_runtime_timeout_seconds": 7}
    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(tool_module, "_PYTHON_RUNTIME_CONFIG", config)
    monkeypatch.setattr(
        tool_module,
        "ensure_runtime_venv",
        lambda _config, **_kwargs: tmp_path / "python.exe",
    )
    monkeypatch.setattr(
        tool_module,
        "execute_sandboxed",
        lambda **_kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("python", 7)),
    )

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_module.python_execute_tool(
            {"code": "print(1)"}, WorkspaceGuard(str(tmp_path))
        )

    assert caught.value.message == "python execution timed out after 7s"
    assert caught.value.retryable is True


def test_python_execute_tool_surfaces_bootstrap_failed_phase(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    failure = interpreter_module.PythonRuntimeError(
        "required imports failed", failed_phase="imports_validated"
    )
    failure.phase_timings_json = json.dumps({"imports_validated": 12.5})
    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(
        tool_module,
        "ensure_runtime_venv",
        lambda _config, **_kwargs: (_ for _ in ()).throw(failure),
    )

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_module.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))

    assert caught.value.failed_phase == "imports_validated"
    assert caught.value.failure_class == "unavailable"
    assert "import validation" in caught.value.message
    assert json.loads(caught.value.phase_timings_json) == {"imports_validated": 12.5}


def test_validate_runtime_imports_captures_subprocess_failure_detail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    error = subprocess.CalledProcessError(
        7,
        ["python", "-c", "import pandas"],
        stderr="prefix\nImportError: DLL load failed while importing pandas",
    )
    monkeypatch.setattr(
        interpreter_module.bootstrap_subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )
    details: list[str] = []

    result = interpreter_module._validate_runtime_imports(  # noqa: SLF001
        Path("python.exe"), detail_sink=details
    )

    assert result is False
    assert len(details) == 1
    assert "CalledProcessError" in details[0]
    assert "exit code 7" in details[0]
    assert "DLL load failed" in details[0]


def test_python_execute_error_detail_redacts_stderr_tail_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    private_path = tmp_path / "private" / "wheelhouse" / "package.whl"
    bootstrap_error = subprocess.CalledProcessError(
        1,
        ["python", "-m", "pip", "install"],
        stderr=f"pip failed while reading {private_path}",
    )
    telemetry = interpreter_module.BootstrapTelemetry(tool_module.logger)
    with pytest.raises(subprocess.CalledProcessError) as bootstrap_caught:
        with telemetry.phase("install_finished", data={"strategy": "unknown"}):
            raise bootstrap_error

    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(tool_module, "_PYTHON_RUNTIME_CONFIG", {})
    monkeypatch.setattr(
        tool_module,
        "ensure_runtime_venv",
        lambda _config, **_kwargs: (_ for _ in ()).throw(bootstrap_caught.value),
    )

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_module.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))

    assert str(private_path) not in caught.value.error_message
    assert "stderr tail" in caught.value.error_message
    assert "[redacted:path]" in caught.value.error_message


def test_python_execute_tool_formats_successful_payload(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class _Result:
        def __init__(self) -> None:
            self.payload = {
                "stdout": "4\n",
                "stderr": "",
                "error": None,
                "images": [],
                "tables": [],
                "last_expr_repr": None,
            }
            self.work_dir = tmp_path
            self.returncode = 0
            self.cleaned = False

        def cleanup(self) -> None:
            self.cleaned = True

    sandbox_result = _Result()
    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(tool_module, "_PYTHON_RUNTIME_CONFIG", {})
    monkeypatch.setattr(
        tool_module,
        "ensure_runtime_venv",
        lambda _config, **_kwargs: tmp_path / "python.exe",
    )
    monkeypatch.setattr(tool_module, "execute_sandboxed", lambda **_kwargs: sandbox_result)

    result = tool_module.python_execute_tool(
        {"code": "print(2 + 2)"}, WorkspaceGuard(str(tmp_path))
    )
    payload = json.loads(result.output)

    assert result.success is True
    assert payload["stdout"] == "4\n"
    assert sandbox_result.cleaned is True


@pytest.mark.parametrize("use_workspace", [True, False], ids=["workspace", "scratch"])
def test_python_execute_tool_working_directory_and_chart_attachment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    use_workspace: bool,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    work_dir = tmp_path / "scratch"
    work_dir.mkdir()
    image_path = work_dir / "figure_0.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\n")
    captured: dict[str, object] = {}

    class _Result:
        payload = {
            "stdout": "",
            "stderr": "",
            "error": None,
            "images": ["figure_0.png"],
            "tables": [],
            "last_expr_repr": None,
        }
        returncode = 0
        cleaned = False

        def __init__(self) -> None:
            self.work_dir = work_dir

        def cleanup(self) -> None:
            self.cleaned = True

    sandbox_result = _Result()

    def execute(**kwargs: object) -> _Result:
        captured.update(kwargs)
        return sandbox_result

    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(
        tool_module,
        "ensure_runtime_venv",
        lambda _config, **_kwargs: tmp_path / "python.exe",
    )
    monkeypatch.setattr(tool_module, "execute_sandboxed", execute)

    with caplog.at_level("INFO", logger=tool_module.__name__):
        result = tool_module.python_execute_tool(
            {"code": "import matplotlib.pyplot as plt; plt.plot([1, 2])"},
            WorkspaceGuard(str(workspace_root) if use_workspace else None),
        )

    expected_working_directory = workspace_root.resolve() if use_workspace else None
    assert captured["working_directory"] == expected_working_directory
    assert len(result.trusted_attachments) == 1
    assert result.trusted_attachments[0]["kind"] == "chart"
    assert result.trusted_attachments[0]["source_tool"] == "python_execute"
    assert sandbox_result.cleaned is True
    execution_record = next(
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.tools.python_runtime.execution.started"
    )
    expected_kind = "workspace_root" if use_workspace else "scratch_fallback"
    assert execution_record.data == {"working_directory_kind": expected_kind}
    assert str(workspace_root) not in execution_record.getMessage()


def test_python_execute_tool_cleanup_failure_does_not_replace_success(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    class _Result:
        payload = {
            "stdout": "ok\n",
            "stderr": "",
            "error": None,
            "images": [],
            "tables": [],
            "last_expr_repr": None,
        }
        work_dir = tmp_path
        returncode = 0

        def cleanup(self) -> None:
            raise OSError("locked scratch")

    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(
        tool_module,
        "ensure_runtime_venv",
        lambda _config, **_kwargs: tmp_path / "python.exe",
    )
    monkeypatch.setattr(tool_module, "execute_sandboxed", lambda **_kwargs: _Result())

    with caplog.at_level("WARNING"):
        result = tool_module.python_execute_tool(
            {"code": "print('ok')"},
            WorkspaceGuard(str(tmp_path)),
        )

    assert result.success is True
    assert "cleanup failed" in caplog.text.lower()


def test_python_result_reader_refuses_oversize_before_json_decode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result_path = tmp_path / "result.json"
    result_path.write_bytes(b"{}" + (b" " * 32))
    monkeypatch.setattr(sandbox_module, "MAX_RESULT_JSON_BYTES", 8)

    with pytest.raises(RuntimeError, match="byte limit"):
        sandbox_module._read_result_payload(result_path)  # noqa: SLF001


@windows_only
def test_windows_sandbox_starts_process_suspended_before_job_assignment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    processes: list[object] = []

    class _FakeProcess:
        returncode = 0
        _handle = 123
        _thread = 456

        def __init__(self, argv: list[str], **kwargs: object) -> None:
            events.append("popen")
            self.result_path = Path(argv[3])
            self.creationflags = kwargs.get("creationflags")
            self.env = kwargs.get("env")
            self.stdout = io.BytesIO()
            self.stderr = io.BytesIO()
            self.args = argv
            self.result_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "stdout": "",
                        "stderr": "",
                        "error": None,
                        "images": [],
                        "tables": [],
                        "last_expr_repr": None,
                    }
                ),
                encoding="utf-8",
            )
            processes.append(self)

        def poll(self) -> int:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            _ = timeout
            return self.returncode

        def kill(self) -> None:
            events.append("kill")

    class _FakeJobObject:
        def __init__(self, **_kwargs: object) -> None:
            self.process: _FakeProcess | None = None

        def __enter__(self) -> "_FakeJobObject":
            events.append("enter_job")
            return self

        def assign(self, proc: _FakeProcess) -> None:
            events.append("assign")
            self.process = proc

        def resume(self, proc: _FakeProcess) -> None:
            assert self.process is proc
            events.append("resume")

        def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
            events.append("exit_job")

    monkeypatch.setattr(sandbox_module.os, "name", "nt", raising=False)
    monkeypatch.setattr(sandbox_module.subprocess, "CREATE_SUSPENDED", 4, raising=False)
    monkeypatch.setattr(sandbox_module.subprocess, "Popen", _FakeProcess)
    monkeypatch.setattr(sandbox_module, "JobObject", _FakeJobObject)

    result = sandbox_module.execute_sandboxed(
        code="print(1)",
        venv_python=tmp_path / "python.exe",
        timeout_seconds=5,
        memory_limit_mb=128,
    )
    work_dir = result.work_dir
    try:
        assert result.returncode == 0
        assert events == ["enter_job", "popen", "assign", "resume", "exit_job"]
        assert processes[0].creationflags == 4
        assert processes[0].env["OPENBLAS_NUM_THREADS"] == "1"
        assert processes[0].env["OMP_NUM_THREADS"] == "1"
        assert processes[0].env["MKL_NUM_THREADS"] == "1"
        assert processes[0].env["NUMEXPR_NUM_THREADS"] == "1"
        assert processes[0].env["WINDIR"]
    finally:
        result.cleanup()
    assert not work_dir.exists()


def test_posix_sandbox_timeout_kills_process_group(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scratch_dir = tmp_path / "scratch"
    scratch_dir.mkdir()
    process = MagicMock(pid=4321, args=["python"])
    process.poll.return_value = None
    process.stdout = io.BytesIO()
    process.stderr = io.BytesIO()
    job = MagicMock()
    job.__enter__.return_value = job
    killpg_calls: list[tuple[int, int]] = []

    def killpg(pid: int, sig: int) -> None:
        killpg_calls.append((pid, sig))

    class _PosixOs:
        name = "posix"

        def __getattr__(self, name: str) -> object:
            return getattr(os, name)

    monkeypatch.setattr(sandbox_module.tempfile, "mkdtemp", lambda **_kwargs: str(scratch_dir))
    posix_os = _PosixOs()
    posix_os.killpg = killpg
    monkeypatch.setattr(sandbox_module, "os", posix_os)
    monkeypatch.setattr(sandbox_module, "signal", types.SimpleNamespace(SIGKILL=9))
    monkeypatch.setattr(sandbox_module.subprocess, "Popen", MagicMock(return_value=process))
    monkeypatch.setattr(sandbox_module, "JobObject", MagicMock(return_value=job))
    monkeypatch.setattr(
        sandbox_module,
        "_capture_wrapper_output",
        MagicMock(side_effect=subprocess.TimeoutExpired("python", 5)),
    )

    with pytest.raises(subprocess.TimeoutExpired):
        sandbox_module.execute_sandboxed(
            code="print(1)",
            venv_python=tmp_path / "python",
            timeout_seconds=5,
            memory_limit_mb=128,
        )

    assert killpg_calls == [(4321, 9)]
    process.kill.assert_not_called()
    process.wait.assert_called_once_with(timeout=1.0)
    assert not scratch_dir.exists()


@windows_only
@pytest.mark.parametrize("use_workspace", [True, False], ids=["workspace", "scratch"])
def test_windows_sandbox_working_directory_and_scratch_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    use_workspace: bool,
) -> None:
    scratch_dir = tmp_path / "scratch"
    scratch_dir.mkdir()
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    processes: list[object] = []

    class _FakeProcess:
        returncode = 0

        def __init__(self, argv: list[str], **kwargs: object) -> None:
            self.args = argv
            self.cwd = kwargs["cwd"]
            self.env = kwargs["env"]
            self.stdout = io.BytesIO()
            self.stderr = io.BytesIO()
            Path(argv[3]).write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "stdout": "",
                        "stderr": "",
                        "error": None,
                        "images": [],
                        "tables": [],
                        "last_expr_repr": None,
                    }
                ),
                encoding="utf-8",
            )
            processes.append(self)

        def poll(self) -> int:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            _ = timeout
            return self.returncode

        def kill(self) -> None:
            self.returncode = 1

    class _FakeJobObject:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def __enter__(self) -> "_FakeJobObject":
            return self

        def assign(self, _proc: _FakeProcess) -> None:
            return None

        def resume(self, _proc: _FakeProcess) -> None:
            return None

        def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
            return None

    monkeypatch.setattr(sandbox_module.tempfile, "mkdtemp", lambda **_kwargs: str(scratch_dir))
    monkeypatch.setattr(sandbox_module.os, "name", "nt", raising=False)
    monkeypatch.setattr(sandbox_module.subprocess, "Popen", _FakeProcess)
    monkeypatch.setattr(sandbox_module, "JobObject", _FakeJobObject)

    result = sandbox_module.execute_sandboxed(
        code="print(1)",
        venv_python=tmp_path / "python.exe",
        timeout_seconds=5,
        memory_limit_mb=128,
        working_directory=workspace_root if use_workspace else None,
    )
    try:
        process = processes[0]
        expected_cwd = workspace_root if use_workspace else scratch_dir
        assert process.cwd == str(expected_cwd)
        for key in ("TEMP", "TMP", "MPLCONFIGDIR", "JENNY_OUTPUT_DIR"):
            assert process.env[key] == str(scratch_dir)
        if use_workspace:
            assert process.env["JENNY_WORKSPACE_ROOT"] == str(workspace_root)
        else:
            assert "JENNY_WORKSPACE_ROOT" not in process.env
    finally:
        result.cleanup()
    assert not scratch_dir.exists()


def test_windows_job_object_resume_uses_process_handle_when_thread_handle_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[int] = []

    class _FakeNtdll:
        def NtResumeProcess(self, handle: object) -> int:
            calls.append(int(getattr(handle, "value", 0) or 0))
            return 0

    class _FakeProcess:
        _handle = 456

    monkeypatch.setattr(job_object_module, "IS_WINDOWS", True)
    monkeypatch.setattr(job_object_module, "ntdll", _FakeNtdll(), raising=False)

    job = job_object_module.JobObject(memory_limit_mb=128, max_processes=5)
    job._handle = 123  # type: ignore[attr-defined]

    job.resume(_FakeProcess())  # type: ignore[arg-type]

    assert calls == [456]


def test_bootstrap_lock_recovers_dead_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock_path = tmp_path / ".bootstrap.lock"
    lock_path.write_text(
        json.dumps({"pid": 424242, "created_at": 1.0}),
        encoding="utf-8",
    )
    monkeypatch.setattr(bootstrap_lock_module, "_process_exists", lambda pid: False)

    with _bootstrap_lock(lock_path):
        assert lock_path.exists()
        payload = json.loads(lock_path.read_text(encoding="utf-8"))
        assert payload["pid"] == os.getpid()
        assert "created_at" in payload

    assert not lock_path.exists()


def test_bootstrap_lock_waits_for_live_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock_path = tmp_path / ".bootstrap.lock"
    lock_path.write_text(
        json.dumps({"pid": os.getpid() + 1, "created_at": time.time()}),
        encoding="utf-8",
    )
    monkeypatch.setattr(bootstrap_lock_module, "_process_exists", lambda pid: True)
    monkeypatch.setattr(bootstrap_lock_module, "BOOTSTRAP_LOCK_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(bootstrap_lock_module, "BOOTSTRAP_LOCK_POLL_SECONDS", 0)

    with pytest.raises(TimeoutError, match="bootstrap lock"):
        with _bootstrap_lock(lock_path):
            raise AssertionError("lock should remain owned by live process")

    assert lock_path.exists()


def test_bootstrap_lock_serializes_threads_before_file_poll(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock_path = tmp_path / ".bootstrap.lock"
    owner_entered = threading.Event()
    release_owner = threading.Event()
    waiter_entered = threading.Event()
    errors: list[BaseException] = []

    def run_owner() -> None:
        try:
            with _bootstrap_lock(lock_path):
                owner_entered.set()
                release_owner.wait(timeout=2)
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    def run_waiter() -> None:
        try:
            with _bootstrap_lock(lock_path):
                waiter_entered.set()
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    monkeypatch.setattr(
        bootstrap_lock_module,
        "_should_recover_bootstrap_lock",
        lambda _path, **_kwargs: pytest.fail("same-process waiter inspected the file lock"),
    )
    owner = threading.Thread(target=run_owner)
    waiter = threading.Thread(target=run_waiter)
    owner.start()
    assert owner_entered.wait(timeout=2)
    waiter.start()
    assert not waiter_entered.wait(timeout=0.05)
    release_owner.set()
    owner.join(timeout=2)
    waiter.join(timeout=2)

    assert not owner.is_alive()
    assert not waiter.is_alive()
    assert not errors
    assert waiter_entered.is_set()


def test_bootstrap_lock_treats_transient_read_permission_error_as_live_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A concurrent writer can transiently make the lock file unreadable
    (observed in practice as a Windows sharing violation). That must never
    be conflated with "the lock is corrupt/abandoned" — doing so would let a
    waiter steal a live lock out from under its owner, defeating the whole
    point of the lock under real concurrent contention."""
    lock_path = tmp_path / ".bootstrap.lock"
    lock_path.write_text(
        json.dumps({"pid": os.getpid(), "created_at": time.time()}),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        bootstrap_lock_module.Path,
        "read_text",
        lambda self, *args, **kwargs: (_ for _ in ()).throw(PermissionError(13, "denied")),
    )

    assert bootstrap_lock_module._should_recover_bootstrap_lock(lock_path) is False  # noqa: SLF001


# ── POSIX rlimit preexec_fn ──────────────────────────────────────────


def test_posix_preexec_sets_rlimits(monkeypatch: pytest.MonkeyPatch) -> None:
    """The POSIX preexec factory applies RLIMIT_CPU/AS/NOFILE/CORE + setsid.

    Runs on every platform: we import ``resource`` at call time inside a
    fake module so Windows CI still exercises the factory logic.  The
    real call site is gated by ``os.name != "nt"``.
    """
    from sidecar.ai.tools.builtins.python_runtime import sandbox as sandbox_module

    calls: list[tuple[str, tuple[int, int]]] = []
    setsid_called: list[bool] = []

    fake_resource = types.ModuleType("resource")
    fake_resource.RLIMIT_CPU = 1001  # type: ignore[attr-defined]
    fake_resource.RLIMIT_AS = 1002  # type: ignore[attr-defined]
    fake_resource.RLIMIT_NOFILE = 1003  # type: ignore[attr-defined]
    fake_resource.RLIMIT_CORE = 1004  # type: ignore[attr-defined]

    def _setrlimit(which: int, limits: tuple[int, int]) -> None:
        name = {1001: "cpu", 1002: "as", 1003: "nofile", 1004: "core"}[which]
        calls.append((name, limits))

    fake_resource.setrlimit = _setrlimit  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "resource", fake_resource)
    monkeypatch.setattr(
        sandbox_module.os, "setsid", lambda: setsid_called.append(True), raising=False
    )

    preexec = sandbox_module._posix_preexec_fn(memory_limit_mb=512, timeout_seconds=30)
    preexec()

    assert setsid_called == [True]
    limits = dict(calls)
    assert limits["cpu"] == (30 + sandbox_module._POSIX_CPU_GRACE_SECONDS,) * 2
    assert limits["as"] == (512 * 1024 * 1024,) * 2
    assert limits["nofile"] == (sandbox_module._POSIX_NOFILE_LIMIT,) * 2
    assert limits["core"] == (0, 0)


def test_posix_preexec_is_noop_when_resource_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """If the POSIX ``resource`` module is unavailable, the preexec
    function returns cleanly instead of raising.  Protects the Windows
    build where the factory may still be called in unit tests."""
    from sidecar.ai.tools.builtins.python_runtime import sandbox as sandbox_module

    monkeypatch.setitem(sys.modules, "resource", None)  # ImportError on `import resource`

    preexec = sandbox_module._posix_preexec_fn(memory_limit_mb=128, timeout_seconds=10)
    preexec()  # must not raise


def test_probe_pip_distinguishes_its_failure_modes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Timeout, launch failure and non-zero exit must be told apart.

    They used to collapse into a bare ``False``, so a bootstrap failure raised
    a one-line error naming no cause at all -- leaving no way to tell a slow
    machine from genuinely broken pip after the fact.
    """
    probe = pip_bootstrap_module._probe_pip
    python = Path("python.exe")

    def raising(exc):
        def _run(*args, **kwargs):  # noqa: ANN002, ANN003
            raise exc
        return _run

    runner = pip_bootstrap_module.bootstrap_subprocess
    monkeypatch.setattr(
        runner, "run", raising(subprocess.TimeoutExpired(cmd="pip", timeout=60))
    )
    ok, detail = probe(python, timeout=60)
    assert ok is False
    assert "timed out after 60s" in detail

    monkeypatch.setattr(runner, "run", raising(OSError("access denied")))
    ok, detail = probe(python, timeout=60)
    assert ok is False
    assert "could not start" in detail
    assert "access denied" in detail

    monkeypatch.setattr(
        runner,
        "run",
        lambda *a, **k: types.SimpleNamespace(
            returncode=1, stdout="", stderr="No module named pip"
        ),
    )
    ok, detail = probe(python, timeout=60)
    assert ok is False
    assert "exited 1" in detail
    assert "No module named pip" in detail

    monkeypatch.setattr(
        runner,
        "run",
        lambda *a, **k: types.SimpleNamespace(returncode=0, stdout="pip 26.2", stderr=""),
    )
    assert probe(python, timeout=60) == (True, "")


def test_offline_pip_bootstrap_failure_names_the_cause(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The raised error must carry the probe detail, not just a bare sentence."""
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    (wheelhouse / "pip-26.2-py3-none-any.whl").write_bytes(b"")
    python = tmp_path / "python.exe"
    python.write_bytes(b"")

    # Patch the module that OWNS these helpers: ``interpreter`` only re-exports
    # them, and ``_ensure_offline_pip`` resolves them from its own globals.
    monkeypatch.setattr(
        pip_bootstrap_module, "_extract_verified_pip_wheel", lambda *a, **k: None
    )
    monkeypatch.setattr(
        pip_bootstrap_module,
        "_probe_pip",
        lambda *a, **k: (False, "pip probe exited 1: No module named pip"),
    )

    with pytest.raises(interpreter_module.PythonRuntimeOfflineInstallError) as excinfo:
        interpreter_module._ensure_offline_pip(python, wheelhouse)

    assert "No module named pip" in str(excinfo.value)
