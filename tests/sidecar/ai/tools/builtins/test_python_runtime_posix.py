"""POSIX and bundled-copy regressions for the managed Python runtime."""

from __future__ import annotations

import json
import os
import subprocess
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pytest

from sidecar.ai.error_codes import CMP_TOOL_PYTHON_NOT_AVAILABLE
from sidecar.ai.tools.builtins.python_runtime import bundled_runtime, interpreter, sandbox, tool
from sidecar.ai.tools.builtins.python_runtime.errors import PythonRuntimeError
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _write_python(path: Path, *, executable: bool = True) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"python")
    if executable and os.name != "nt":
        path.chmod(0o755)
    return path


def _pbs_tree(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "python-embed"
    python = _write_python(root / "bin" / "python3.13")
    (root / bundled_runtime.EMBED_MANIFEST_FILENAME).write_text(
        json.dumps({"distribution": "python-build-standalone"}), encoding="utf-8"
    )
    return root, python


def test_bundled_runtime_root_recognizes_pbs(tmp_path: Path) -> None:
    root, python = _pbs_tree(tmp_path)

    assert bundled_runtime.bundled_runtime_root(python) == (root, "bundled_copy")


def test_bundled_runtime_root_recognizes_windows_embeddable(tmp_path: Path) -> None:
    root = tmp_path / "python-embed"
    python = _write_python(root / "python.exe")
    (root / bundled_runtime.EMBED_MANIFEST_FILENAME).write_text("{}", encoding="utf-8")
    (root / "python313._pth").write_text("python313.zip\n", encoding="utf-8")

    assert bundled_runtime.bundled_runtime_root(python) == (root, "bundled_embeddable")


def test_bundled_runtime_root_rejects_plain_venv(tmp_path: Path) -> None:
    python = _write_python(tmp_path / "venv" / "bin" / "python")

    assert bundled_runtime.bundled_runtime_root(python) is None


@pytest.mark.parametrize(
    "manifest",
    ("{invalid", json.dumps({"distribution": "another-distribution"})),
    ids=("invalid-json", "other-distribution"),
)
def test_bundled_runtime_root_rejects_non_pbs_manifest(
    tmp_path: Path, manifest: str
) -> None:
    root = tmp_path / "python-embed"
    python = _write_python(root / "bin" / "python3.13")
    (root / bundled_runtime.EMBED_MANIFEST_FILENAME).write_text(manifest, encoding="utf-8")

    assert bundled_runtime.bundled_runtime_root(python) is None


def test_copy_bundled_runtime_copies_whole_root(tmp_path: Path) -> None:
    root, python = _pbs_tree(tmp_path)
    stdlib = root / "lib" / "python3.13" / "os.py"
    stdlib.parent.mkdir(parents=True)
    stdlib.write_text("", encoding="utf-8")
    staging = tmp_path / "runtime.build"

    copied_python = bundled_runtime.copy_bundled_runtime(python, root, staging)

    assert copied_python == staging / "bin" / "python3.13"
    assert (staging / "lib" / "python3.13" / "os.py").is_file()
    assert (staging / bundled_runtime.EMBED_MANIFEST_FILENAME).is_file()


def test_copy_bundled_runtime_creates_python_alias(tmp_path: Path) -> None:
    root, python = _pbs_tree(tmp_path)
    staging = tmp_path / "runtime.build"

    bundled_runtime.copy_bundled_runtime(python, root, staging)

    alias = staging / "bin" / "python"
    assert alias.is_file()
    if alias.is_symlink():
        assert os.readlink(alias) == "python3.13"
    else:
        assert alias.read_bytes() == python.read_bytes()
    if os.name != "nt":
        assert os.access(alias, os.X_OK)


def test_copy_bundled_runtime_keeps_existing_python_alias(tmp_path: Path) -> None:
    root, python = _pbs_tree(tmp_path)
    alias = _write_python(root / "bin" / "python")
    alias.write_bytes(b"alias")
    staging = tmp_path / "runtime.build"

    bundled_runtime.copy_bundled_runtime(python, root, staging)

    copied_alias = staging / "bin" / "python"
    assert copied_alias.read_bytes() == b"alias"
    assert not copied_alias.is_symlink()


def test_copy_bundled_runtime_leaves_windows_embeddable_alone(tmp_path: Path) -> None:
    root = tmp_path / "python-embed"
    python = _write_python(root / "python.exe")
    (root / "python313._pth").write_text("python313.zip\n", encoding="utf-8")
    (root / bundled_runtime.EMBED_MANIFEST_FILENAME).write_text("{}", encoding="utf-8")
    staging = tmp_path / "runtime.build"

    bundled_runtime.copy_bundled_runtime(python, root, staging)

    assert not (staging / "bin").exists()


def test_copy_bundled_runtime_rejects_overlapping_destination(tmp_path: Path) -> None:
    root, python = _pbs_tree(tmp_path)

    with pytest.raises(PythonRuntimeError, match="destination overlaps"):
        bundled_runtime.copy_bundled_runtime(python, root, root / "runtime.build")


def test_copy_bundled_runtime_requires_copied_executable(tmp_path: Path) -> None:
    root = tmp_path / "python-embed"
    python = root / "bin" / "python3.13"
    python.mkdir(parents=True)

    with pytest.raises(PythonRuntimeError, match="did not create an executable"):
        bundled_runtime.copy_bundled_runtime(python, root, tmp_path / "runtime.build")


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable-bit contract")
def test_copy_bundled_runtime_requires_executable_bit(tmp_path: Path) -> None:
    root, python = _pbs_tree(tmp_path)
    python.chmod(0o644)

    with pytest.raises(PythonRuntimeError, match="not executable"):
        bundled_runtime.copy_bundled_runtime(python, root, tmp_path / "runtime.build")


class _RecordingTelemetry:
    def __init__(self) -> None:
        self.events: dict[str, dict[str, object]] = {}

    @contextmanager
    def phase(
        self, name: str, *, data: dict[str, Any]
    ) -> Iterator[dict[str, Any]]:
        yield data
        self.events[name] = dict(data)


def test_create_runtime_venv_copies_pbs_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, python = _pbs_tree(tmp_path)
    staging = tmp_path / "runtime.build"
    telemetry = _RecordingTelemetry()

    def record_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        if command[1:3] == ["-m", "venv"]:
            pytest.fail("PBS bootstrap must not invoke -m venv")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(interpreter, "discover_base_interpreter", lambda _config: python)
    monkeypatch.setattr(interpreter, "_install_runtime_packages", lambda *_args: "wheelhouse")
    monkeypatch.setattr(interpreter.bootstrap_subprocess, "run", record_run)

    result = interpreter._create_runtime_venv(
        {},
        staging,
        telemetry=telemetry,  # type: ignore[arg-type]
        deadline_monotonic=None,
        requirements_fingerprint="fingerprint",
    )

    assert result == staging / "bin" / "python3.13"
    assert telemetry.events["venv_created"]["creation_path"] == "bundled_copy"
    assert (staging / "bin" / "python").is_file()
    if os.name != "nt":
        assert interpreter._venv_python(staging) == staging / "bin" / "python"  # noqa: SLF001
        assert interpreter._venv_python(staging).is_file()  # noqa: SLF001


@pytest.mark.parametrize("working_directory", (None, Path("workspace")))
def test_child_environment_posix(
    tmp_path: Path, working_directory: Path | None
) -> None:
    venv_python = tmp_path / "venv" / "bin" / "python"
    work_dir = tmp_path / "work"

    env = sandbox._child_environment(
        venv_python, work_dir, working_directory, posix=True
    )

    assert env["HOME"] == str(work_dir)
    assert env["TMPDIR"] == str(work_dir)
    assert env["LANG"] == "C.UTF-8"
    assert env["LC_ALL"] == "C.UTF-8"
    assert env["PATH"] == os.pathsep.join(
        [str(venv_python.parent), "/usr/local/bin", "/usr/bin", "/bin"]
    )
    assert env["VIRTUAL_ENV"] == str(venv_python.parent.parent)
    forbidden = (
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "LD_LIBRARY_PATH",
        "PYTHONPATH",
        "USER",
    )
    assert all(key not in env for key in forbidden)
    assert ("JENNY_WORKSPACE_ROOT" in env) is (working_directory is not None)


@pytest.mark.parametrize("working_directory", (None, Path("workspace")))
def test_child_environment_windows_shape(
    tmp_path: Path, working_directory: Path | None
) -> None:
    venv_python = tmp_path / "venv" / "Scripts" / "python.exe"

    env = sandbox._child_environment(
        venv_python, tmp_path / "work", working_directory, posix=False
    )

    assert all(key in env for key in ("SYSTEMROOT", "WINDIR", "COMSPEC"))
    assert "HOME" not in env
    assert env["VIRTUAL_ENV"] == str(venv_python.parent.parent)
    assert ("JENNY_WORKSPACE_ROOT" in env) is (working_directory is not None)


class _ReachedRuntimeVenv(BaseException):
    pass


def test_python_execute_allows_linux(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tool.sys, "platform", "linux")
    monkeypatch.setattr(
        tool,
        "ensure_runtime_venv",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(_ReachedRuntimeVenv()),
    )

    with pytest.raises(_ReachedRuntimeVenv):
        tool.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))


def test_python_execute_rejects_unsupported_platform(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tool.sys, "platform", "darwin")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        tool.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))

    assert exc_info.value.code == CMP_TOOL_PYTHON_NOT_AVAILABLE
    assert exc_info.value.message == (
        "python runtime is only available on Windows and Linux in this build"
    )
    assert exc_info.value.retryable is False
