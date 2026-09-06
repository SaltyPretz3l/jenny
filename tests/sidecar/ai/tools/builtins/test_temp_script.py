from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_COMMAND_ABORTED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.builtins import output_chunk_slot
from sidecar.ai.tools.builtins import temp_script as temp_script_module
from sidecar.ai.tools.builtins.temp_script import run_temp_script_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _script(*, output: str = "hello", exit_code: int = 0) -> str:
    if os.name == "nt":
        return f"@echo {output}\r\n@exit /b {exit_code}\r\n"
    return f"echo {output}\nexit {exit_code}\n"


def test_temp_script_runs_and_does_not_expose_or_create_scratch_path(tmp_path: Path) -> None:
    result = run_temp_script_tool({"script": _script()}, WorkspaceGuard(str(tmp_path)))
    payload = json.loads(result.output)

    assert result.success is True
    assert payload["stdout"].strip() == "hello"
    assert payload["command"] == "[temporary script]"
    assert "jenny-tool-" not in result.output
    assert list(tmp_path.iterdir()) == []


def test_temp_script_honors_expected_failure_exit(tmp_path: Path) -> None:
    result = run_temp_script_tool(
        {"script": _script(exit_code=3), "expected_exit_codes": [3]},
        WorkspaceGuard(str(tmp_path)),
    )

    assert result.success is True
    assert result.metadata["expectation_met"] is True


def test_temp_script_blocks_dangerous_script_before_creation(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as raised:
        run_temp_script_tool({"script": "rm -rf /"}, WorkspaceGuard(str(tmp_path)))

    assert raised.value.code == CMP_TOOL_COMMAND_BLOCKED
    assert list(tmp_path.iterdir()) == []


def test_temp_script_reports_temp_directory_creation_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        temp_script_module.tempfile,
        "mkdtemp",
        lambda **_kwargs: (_ for _ in ()).throw(OSError("unavailable")),
    )

    with pytest.raises(ToolExecutionFailure) as raised:
        run_temp_script_tool({"script": _script()}, WorkspaceGuard(str(tmp_path)))

    assert raised.value.code == CMP_TOOL_IO_FAILED
    assert "OSError" in raised.value.message


def test_temp_script_honors_workspace_cwd(tmp_path: Path) -> None:
    subdir = tmp_path / "subdir"
    subdir.mkdir()
    script = "@echo ok>made.txt\r\n" if os.name == "nt" else "printf ok > made.txt\n"

    result = run_temp_script_tool(
        {"script": script, "cwd": "subdir"},
        WorkspaceGuard(str(tmp_path)),
    )

    assert result.success is True
    assert (subdir / "made.txt").read_text(encoding="utf-8").strip() == "ok"


def test_temp_script_timeout_is_structured_and_path_redacted(tmp_path: Path) -> None:
    script = "@ping 127.0.0.1 -n 6 >nul\r\n" if os.name == "nt" else "sleep 5\n"

    result = run_temp_script_tool(
        {"script": script, "timeout_seconds": 0.1},
        WorkspaceGuard(str(tmp_path)),
    )

    assert result.success is False
    assert result.metadata["timed_out"] is True
    assert "jenny-tool-" not in result.output


def test_temp_script_cleans_up_when_execution_is_cancelled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    created: list[Path] = []
    real_mkdtemp = temp_script_module.tempfile.mkdtemp

    def capture_mkdtemp(*args, **kwargs):
        path = Path(real_mkdtemp(*args, **kwargs))
        created.append(path)
        return str(path)

    def abort(_arguments, _workspace):
        raise ToolExecutionFailure(
            code=CMP_TOOL_COMMAND_ABORTED,
            message="cancelled",
            retryable=False,
        )

    monkeypatch.setattr(temp_script_module.tempfile, "mkdtemp", capture_mkdtemp)
    monkeypatch.setattr(temp_script_module, "run_command_tool", abort)

    with pytest.raises(ToolExecutionFailure) as raised:
        run_temp_script_tool({"script": _script()}, WorkspaceGuard(str(tmp_path)))

    assert raised.value.code == CMP_TOOL_COMMAND_ABORTED
    assert created and all(not path.exists() for path in created)


def test_temp_script_output_is_bounded(tmp_path: Path) -> None:
    script = (
        "@for /L %%i in (1,1,3000) do @echo 01234567890123456789\r\n"
        if os.name == "nt"
        else "i=0; while [ $i -lt 3000 ]; do echo 01234567890123456789; i=$((i+1)); done\n"
    )

    result = run_temp_script_tool({"script": script}, WorkspaceGuard(str(tmp_path)))

    assert result.success is True
    assert len(result.output) < 25_000
    assert "...[truncated]" in result.output


def test_live_output_redacts_temporary_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    emitted: list[dict[str, object]] = []
    temp_root = tmp_path / "secret-temp"

    def fake_run(_arguments, _workspace):
        writer = output_chunk_slot.current_writer()
        assert writer is not None
        writer({"lines": [{"stream": "stderr", "text": f"{temp_root}/script.cmd"}]})
        return temp_script_module.ToolHandlerResult(output="ok")

    monkeypatch.setattr(temp_script_module, "run_command_tool", fake_run)
    output_chunk_slot.begin_tool_call(emitted.append)
    try:
        temp_script_module._run_with_redacted_live_output(  # noqa: SLF001
            {"command": "ignored"},
            workspace=WorkspaceGuard(str(tmp_path)),
            temp_root=temp_root,
        )
    finally:
        output_chunk_slot.end_tool_call()

    assert emitted[0]["lines"][0]["text"] == "<temporary-script>/script.cmd"  # type: ignore[index]
