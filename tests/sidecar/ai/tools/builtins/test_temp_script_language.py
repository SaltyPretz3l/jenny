"""Red-first contract for W2b run_temp_script `language` mode (§2.4).

With `language`, the harness owns interpreter invocation (argv-shaped command,
correct extension), deleting the quoting/heredoc error class. Raw mode stays
one release but pre-validates the known-fatal POSIX-heredoc-into-cmd.exe shape.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_COERCED_ARGS_REJECTED
from sidecar.ai.tools.builtins.temp_script import run_temp_script_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def test_language_python_runs_a_real_python_script(tmp_path: Path) -> None:
    result = run_temp_script_tool(
        {
            "script": "import sys\nprint('lang-ok', sys.version_info[0])\n",
            "language": "python",
            "timeout_seconds": 60,
        },
        _guard(tmp_path),
    )
    payload = json.loads(result.output)
    assert payload["exit_code"] == 0
    assert "lang-ok 3" in payload["stdout"]


def test_language_python_heredoc_text_is_fine_as_data(tmp_path: Path) -> None:
    # The exact shape that dies under cmd.exe raw mode must be a non-issue
    # under language mode: << appears inside a Python string literal.
    result = run_temp_script_tool(
        {
            "script": "s = 'a << b'\nprint(s)\n",
            "language": "python",
            "timeout_seconds": 60,
        },
        _guard(tmp_path),
    )
    payload = json.loads(result.output)
    assert payload["exit_code"] == 0
    assert "a << b" in payload["stdout"]


def test_unknown_language_is_rejected_with_the_valid_values(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        run_temp_script_tool(
            {"script": "print(1)", "language": "ruby"},
            _guard(tmp_path),
        )
    assert excinfo.value.code == CMP_TOOL_COERCED_ARGS_REJECTED
    assert "python" in excinfo.value.message


@pytest.mark.parametrize(
    ("script", "family"),
    [
        ("import sys\nprint(sys.version)\n", "python"),
        ("const value = 1;\nconsole.log(value);\n", "javascript"),
        ("$value = 1\nWrite-Output $value\n", "powershell"),
    ],
)
def test_omitted_language_refuses_obvious_script_family(
    tmp_path: Path, script: str, family: str
) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        run_temp_script_tool({"script": script}, _guard(tmp_path))

    assert excinfo.value.code == CMP_TOOL_COERCED_ARGS_REJECTED
    assert excinfo.value.retryable is False
    assert f"script looks like {family}" in excinfo.value.message
    assert f"pass language: {family}" in excinfo.value.message


def test_empty_language_refuses_obvious_python_script(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        run_temp_script_tool(
            {"script": "print('python')\n", "language": ""},
            _guard(tmp_path),
        )

    assert excinfo.value.code == CMP_TOOL_COERCED_ARGS_REJECTED
    assert "script looks like python" in excinfo.value.message


@pytest.mark.skipif(os.name != "nt", reason="platform gate is windows-specific")
def test_sh_language_is_rejected_on_windows(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        run_temp_script_tool(
            {"script": "echo hi", "language": "sh"},
            _guard(tmp_path),
        )
    assert excinfo.value.code == CMP_TOOL_COERCED_ARGS_REJECTED
    assert "python" in excinfo.value.message


@pytest.mark.skipif(os.name != "nt", reason="raw-mode heredoc pre-validation is windows-specific")
def test_raw_mode_heredoc_into_cmd_is_prevalidated(tmp_path: Path) -> None:
    script = "python - <<'EOF'\nprint(1)\nEOF\n"
    with pytest.raises(ToolExecutionFailure) as excinfo:
        run_temp_script_tool({"script": script}, _guard(tmp_path))
    assert excinfo.value.code == CMP_TOOL_COERCED_ARGS_REJECTED
    assert "language: python" in excinfo.value.message
    assert "cmd.exe" in excinfo.value.message


def test_raw_mode_without_heredoc_is_unchanged(tmp_path: Path) -> None:
    result = run_temp_script_tool(
        {"script": "echo raw-ok", "timeout_seconds": 60},
        _guard(tmp_path),
    )
    payload = json.loads(result.output)
    assert payload["exit_code"] == 0
    assert "raw-ok" in payload["stdout"]


def test_missing_interpreter_reports_unavailable_class(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sidecar.ai.tools.builtins.temp_script as temp_script_module

    monkeypatch.setattr(temp_script_module.shutil, "which", lambda _name: None)
    with pytest.raises(ToolExecutionFailure) as excinfo:
        run_temp_script_tool(
            {"script": "console.log(1)", "language": "javascript"},
            _guard(tmp_path),
        )
    assert "node" in excinfo.value.message
    assert excinfo.value.to_error_data().get("failure_class") == "unavailable"


def test_language_manifest_declares_the_enum() -> None:
    manifest = json.loads(
        (Path(__file__).resolve().parents[5] / "services" / "tools" / "tool-manifest.json")
        .read_text(encoding="utf-8")
    )
    tools = manifest["tools"] if isinstance(manifest, dict) else manifest
    entry = next(tool for tool in tools if tool["name"] == "run_temp_script")
    parameters = entry["parameters"]["properties"]
    assert "language" in parameters
    assert set(parameters["language"]["enum"]) == {
        "python",
        "powershell",
        "cmd",
        "sh",
        "javascript",
    }
    assert "language" not in entry["parameters"].get("required", [])
