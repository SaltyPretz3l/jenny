"""Security review item 11: python_execute never runs with a null root.

With no bound workspace the run's own scratch directory is bound as the explicit
authority root; a null or missing root that reaches the runner fails closed before
anything launches.
"""

from __future__ import annotations

import io
import json
import threading
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_TOOL_DISABLED
from sidecar.ai.tools.builtins.python_runtime import sandbox as sandbox_module
from sidecar.ai.tools.builtins.python_runtime import tool as tool_module
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


@pytest.fixture
def scratch_parent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    parent = tmp_path / "temp"
    parent.mkdir()
    monkeypatch.setattr(sandbox_module.tempfile, "tempdir", str(parent))
    return parent


def _no_spawn(*_args: object, **_kwargs: object) -> None:
    pytest.fail("a run without bound authority must not launch")


def _stub_tool_runtime(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(tool_module.sys, "platform", "win32")
    monkeypatch.setattr(
        tool_module, "ensure_runtime_venv", lambda _config, **_kwargs: tmp_path / "python.exe"
    )


def test_no_bound_root_runs_with_the_scratch_dir_as_its_explicit_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scratch_parent: Path
) -> None:
    _stub_tool_runtime(monkeypatch, tmp_path)
    captured: dict[str, Any] = {}

    class _Result:
        payload = {
            "stdout": "", "stderr": "", "error": None,
            "images": ["figure_0.png"], "tables": [], "last_expr_repr": None,
        }
        returncode = 0

        def __init__(self, work_dir: Path) -> None:
            self.work_dir = work_dir

        def cleanup(self) -> None:
            sandbox_module._remove_tree(self.work_dir)

    def execute(**kwargs: Any) -> _Result:
        captured.update(kwargs)
        (kwargs["work_dir"] / "figure_0.png").write_bytes(_PNG)
        return _Result(kwargs["work_dir"])

    monkeypatch.setattr(tool_module, "execute_sandboxed", execute)

    result = tool_module.python_execute_tool({"code": "plot()"}, WorkspaceGuard(None))

    root = captured["working_directory"]
    assert isinstance(root, Path)
    assert root == captured["work_dir"]
    assert root.parent == scratch_parent
    assert root.name.startswith("jenny-pyexec-")
    # The chart the runner mediated is read from inside that root and still admitted.
    assert [item["kind"] for item in result.trusted_attachments] == ["chart"]
    assert not list(scratch_parent.iterdir())  # removed with the run


def test_a_workspace_root_that_is_gone_falls_back_to_a_scratch_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scratch_parent: Path
) -> None:
    _stub_tool_runtime(monkeypatch, tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    guard = WorkspaceGuard(str(workspace))
    workspace.rmdir()
    captured: dict[str, Any] = {}

    class _Result:
        payload = {"stdout": "", "stderr": "", "error": None, "images": [], "tables": []}
        returncode = 0
        work_dir = tmp_path

        def cleanup(self) -> None:
            return None

    def execute(**kwargs: Any) -> _Result:
        captured.update(kwargs)
        return _Result()

    monkeypatch.setattr(tool_module, "execute_sandboxed", execute)

    tool_module.python_execute_tool({"code": "print(1)"}, guard)

    assert captured["working_directory"] is not None
    assert captured["working_directory"] == captured["work_dir"]
    assert captured["working_directory"].parent == scratch_parent


def test_a_null_root_forced_into_the_runner_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scratch_parent: Path
) -> None:
    _stub_tool_runtime(monkeypatch, tmp_path)
    monkeypatch.setattr(tool_module, "create_scratch_dir", lambda: None)
    monkeypatch.setattr(sandbox_module.subprocess, "Popen", _no_spawn)

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_module.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(None))

    assert caught.value.code == CMP_TOOL_DISABLED
    assert not list(scratch_parent.iterdir())


@pytest.mark.parametrize("root", [None, "missing"], ids=["null", "missing"])
def test_the_runner_refuses_a_root_it_cannot_bind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scratch_parent: Path, root: str | None
) -> None:
    monkeypatch.setattr(sandbox_module.subprocess, "Popen", _no_spawn)
    scratch = sandbox_module.create_scratch_dir()

    with pytest.raises(ToolExecutionFailure) as caught:
        sandbox_module.execute_sandboxed(
            code="print(1)",
            venv_python=tmp_path / "python.exe",
            timeout_seconds=5,
            memory_limit_mb=128,
            working_directory=None if root is None else tmp_path / root,  # type: ignore[arg-type]
            work_dir=scratch,
        )

    assert caught.value.code == CMP_TOOL_DISABLED
    assert caught.value.message == "tools workspace root is not configured"
    assert not scratch.exists()  # the passed scratch root is owned and removed


def test_a_pre_set_abort_removes_the_passed_scratch_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scratch_parent: Path
) -> None:
    monkeypatch.setattr(sandbox_module.subprocess, "Popen", _no_spawn)
    scratch = sandbox_module.create_scratch_dir()
    abort_event = threading.Event()
    abort_event.set()

    with pytest.raises(sandbox_module.SandboxExecutionCancelled) as caught:
        sandbox_module.execute_sandboxed(
            code="print(1)",
            venv_python=tmp_path / "python.exe",
            timeout_seconds=5,
            memory_limit_mb=128,
            working_directory=scratch,
            work_dir=scratch,
            abort_event=abort_event,
        )

    assert caught.value.cleanup_confirmed is True
    assert not scratch.exists()


def test_the_scratch_root_is_the_launch_directory_and_never_named_a_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scratch_parent: Path
) -> None:
    launched: list[dict[str, Any]] = []

    class _FakeProcess:
        pid = 123
        returncode = 0

        def __init__(self, argv: list[str], **kwargs: Any) -> None:
            launched.append(kwargs)
            self.stdout = io.BytesIO()
            self.stderr = io.BytesIO()
            Path(argv[-2]).write_text(
                json.dumps({
                    "schema_version": 1, "stdout": "", "stderr": "", "error": None,
                    "images": [], "tables": [], "last_expr_repr": None,
                }),
                encoding="utf-8",
            )

        def poll(self) -> int:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            return self.returncode

    class _FakeJobObject:
        def __init__(self, **_kwargs: object) -> None:
            pass

        def __enter__(self) -> "_FakeJobObject":
            return self

        def assign(self, _proc: object) -> None:
            return None

        def resume(self, _proc: object) -> None:
            return None

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(sandbox_module.os, "name", "nt", raising=False)
    monkeypatch.setattr(sandbox_module.subprocess, "Popen", _FakeProcess)
    monkeypatch.setattr(sandbox_module, "JobObject", _FakeJobObject)
    scratch = sandbox_module.create_scratch_dir()

    result = sandbox_module.execute_sandboxed(
        code="print(1)",
        venv_python=tmp_path / "python.exe",
        timeout_seconds=5,
        memory_limit_mb=128,
        working_directory=scratch,
        work_dir=scratch,
    )
    try:
        assert result.work_dir == scratch
        assert launched[0]["cwd"] == str(scratch)
        assert launched[0]["env"]["JENNY_OUTPUT_DIR"] == str(scratch)
        assert "JENNY_WORKSPACE_ROOT" not in launched[0]["env"]
    finally:
        result.cleanup()
    assert not scratch.exists()
