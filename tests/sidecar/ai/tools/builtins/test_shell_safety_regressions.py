"""Regression coverage for always-active destructive shell detection."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import shell as shell_module
from sidecar.ai.tools.builtins import shell_command_split as split_module
from sidecar.ai.tools.builtins import shell_security as security_module
from sidecar.ai.tools.builtins.shell_security import (
    find_destructive_executable,
    shell_command_for_tool,
)
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        (r"C:\Program Files\Git\usr\bin\rm.exe", "rm"),
        (r"bin\rm.exe", "rm"),
        ('"rmdir" /s /q x', "rmdir"),
    ],
)
def test_destructive_executable_handles_windows_paths_and_quotes(
    command: str,
    expected: str,
) -> None:
    assert find_destructive_executable(command) == expected


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ('cmd /c rmdir /s /q "a"', "rmdir"),
        ('powershell -Command "Remove-Item -Recurse -Force x"', "Remove-Item"),
        ('find . -name "*.js" -delete', "find -delete"),
        ('find . -name "*.js" -exec rm {} +', "find -exec rm"),
        ('sed -i "s/.*//" src/a.js', "sed -i"),
        ("type nul > important.js", ">"),
        ("git clean -xdff", "git clean"),
        (r".\organize.bat", "script:organize.bat"),
    ],
)
def test_destructive_command_shapes_are_detected(command: str, expected: str) -> None:
    assert find_destructive_executable(command) == expected


@pytest.mark.parametrize(
    "command",
    [
        'bash -c "rm -rf x"',
        'sh -c "rm -rf x"',
        'dash -c "rm -rf x"',
        'zsh -c "rm -rf x"',
        'bash -lc "rm -rf x"',
        'sh -xc "rm -rf x"',
        'dash -ec "rm -rf x"',
        'zsh -lc "rm -rf x"',
        "sh organize.sh",
        "wsl -- rm -rf /mnt/g/Projects",
        "wsl -e rm -rf /mnt/g/Projects",
        "wsl --exec rm -rf /mnt/g/Projects",
        '%COMSPEC% /c rmdir /s /q "a"',
    ],
)
def test_interpreter_bypass_shapes_are_detected(command: str) -> None:
    assert find_destructive_executable(command) is not None


@pytest.mark.parametrize(
    "switch",
    ["-c", "-co", "-com", "-comm", "-Comman", "-command"],
)
@pytest.mark.parametrize("executable", ["powershell", "pwsh"])
def test_powershell_command_abbreviations_are_unwrapped(
    executable: str,
    switch: str,
) -> None:
    command = f'{executable} {switch} "Remove-Item -Recurse -Force x"'
    assert find_destructive_executable(command) is not None


@pytest.mark.parametrize("switch", ["-e", "-en", "-enc", "-encodedcommand"])
def test_powershell_encoded_command_is_decoded_and_scanned(switch: str) -> None:
    encoded = base64.b64encode(
        "Remove-Item -Recurse -Force x".encode("utf-16-le")
    ).decode("ascii")

    assert find_destructive_executable(f"powershell {switch} {encoded}") is not None


@pytest.mark.parametrize(
    "command",
    ["powershell -EncodedCommand not-valid!", "powershell -EncodedCommand"],
)
def test_invalid_powershell_encoded_command_fails_closed(command: str) -> None:
    assert (
        find_destructive_executable(command)
        == "powershell -EncodedCommand"
    )


@pytest.mark.parametrize(
    "script",
    [
        r"Remove-Item -Recurse -Force C:\Users\me\Docs",
        "ri -Recurse -Force x",
        "Get-ChildItem . | Remove-Item -Recurse -Force",
        "`\nRemove-Item -Recurse -Force x",
    ],
)
def test_powershell_temp_script_bodies_use_powershell_grammar(script: str) -> None:
    assert find_destructive_executable(script, powershell=True) is not None


def test_null_temp_script_language_falls_through_to_shell_source() -> None:
    command = shell_command_for_tool(
        "run_temp_script",
        {"language": None, "script": "rmdir /s /q old"},
    )

    assert command is not None
    assert find_destructive_executable(command) is not None


@pytest.mark.parametrize(
    "command",
    [
        "git reset --hard HEAD~1",
        "git checkout -- src/changed.py",
        "git restore src/changed.py",
        "git rm -r --cached generated",
        "robocopy src dst /mir",
        "robocopy src dst /purge",
        "echo x | xargs rm -rf",
        "sed --in-place 's/a/b/' src/a.py",
        "find . -execdir rm -rf {} +",
        r"powershell -File .\organize.ps1",
        r"powershell .\organize.ps1",
        r"cmd /c .\organize.bat",
        r"cmd /c .\organize.cmd",
        "sh ./organize.sh",
        "start rm -rf x",
        "start /wait rm -rf x",
        'start "cleanup" rm -rf x',
        'start /wait "cleanup" rm -rf x',
    ],
)
def test_residual_destructive_command_shapes_are_detected(command: str) -> None:
    assert find_destructive_executable(command) is not None


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ('powershell -Command "ri -Recurse x"', "ri"),
        ('powershell -Command "rm -Recurse x"', "rm"),
        ('powershell -Command "rd -Recurse x"', "rd"),
        ('powershell -Command "del x"', "del"),
        ('powershell -Command "erase x"', "erase"),
        ('powershell -Command "Set-Content x changed"', "Set-Content"),
        ('powershell -Command "Out-File x"', "Out-File"),
        ('powershell -Command "Clear-Item x"', "Clear-Item"),
        ('powershell -Command "Clear-Content x"', "Clear-Content"),
        ('powershell -Command "Move-Item x y"', "Move-Item"),
        ('powershell -Command "mi x y"', "mi"),
    ],
)
def test_powershell_destructive_command_words_are_detected(
    command: str,
    expected: str,
) -> None:
    assert find_destructive_executable(command) == expected


@pytest.mark.parametrize(
    "command",
    [
        "git status",
        "git clean --help",
        "git clean -n",
        "git clean --dry-run",
        "git restore --staged src/changed.py",
        'find . -name "*.js"',
        "sed 's/a/b/' f.txt",
        "echo hi >> log.txt",
        "npm run build > build.log",
        "npm test > test.log",
        "git log --oneline > /tmp/log",
        'echo "done" > status.txt',
        "npm run build 2>&1",
        "pytest -q 2>&1 | tee log.txt",
        'bash -c "echo organize.sh"',
        'sh -c "printf organize.sh"',
        'powershell -Command "Write-Output organize.ps1"',
        'cmd /c "echo organize.cmd"',
    ],
)
def test_non_destructive_command_shapes_do_not_match(command: str) -> None:
    assert find_destructive_executable(command) is None


def test_posix_escaped_space_redirect_preserves_sensitive_suffix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(security_module, "os", SimpleNamespace(name="posix"))
    assert find_destructive_executable(r"echo hi > important\ file.js") == ">"


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("npm run build 2>&1", ["npm run build 2>&1"]),
        ("dir 1>out.txt 2>&1", ["dir 1>out.txt 2>&1"]),
        ("echo error >&2", ["echo error >&2"]),
        ("read input <&0", ["read input <&0"]),
        ("echo output &1", ["echo output &1"]),
        ("echo error &2", ["echo error &2"]),
        ("a & b", ["a", "b"]),
        ('echo "2>&1" & dir', ['echo "2>&1"', "dir"]),
    ],
)
def test_compound_splitter_preserves_file_descriptor_redirects(
    command: str,
    expected: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(split_module, "os", SimpleNamespace(name="nt"))
    assert split_module.split_compound_command(command) == expected


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _successful_command_with_stderr(
    monkeypatch: pytest.MonkeyPatch,
    command: str,
    tmp_path: Path,
) -> tuple[object, dict[str, object]]:
    monkeypatch.setattr(
        shell_module,
        "_run_owned_process",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout="final output",
            stderr="an earlier segment failed",
        ),
    )
    result = shell_module.run_command_tool({"command": command}, _guard(tmp_path))
    return result, json.loads(result.output)


def test_pipeline_reports_final_segment_exit_code_in_payload_and_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    result, body = _successful_command_with_stderr(
        monkeypatch,
        "curl -f https://x/y | tee out.txt",
        tmp_path,
    )

    assert body["ok"] is True
    assert result.success is True
    assert body["exit_code_covers"] == "final_segment_only"
    assert body["completed_with_warnings"] is True
    assert result.metadata["exit_code_covers"] == "final_segment_only"
    assert result.metadata["completed_with_warnings"] is True
    assert body["semantic_note"] == (
        "The exit code reflects only the final segment of this chained command; "
        "earlier segments may have failed. Check stderr."
    )


@pytest.mark.parametrize(
    "command",
    ["npm run build 2>&1", "dir 1>out.txt 2>&1"],
)
def test_file_descriptor_redirect_is_not_reported_as_a_chained_command(
    command: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    result, body = _successful_command_with_stderr(monkeypatch, command, tmp_path)

    assert "exit_code_covers" not in body
    assert "completed_with_warnings" not in body
    assert "exit_code_covers" not in result.metadata
    assert "completed_with_warnings" not in result.metadata


def test_windows_semicolon_is_not_reported_as_a_chained_command(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(shell_module, "os", SimpleNamespace(name="nt"))
    result, body = _successful_command_with_stderr(
        monkeypatch,
        "dir ; echo hi",
        tmp_path,
    )

    assert body["ok"] is True
    assert result.success is True
    assert "exit_code_covers" not in body
    assert "completed_with_warnings" not in body
    assert "exit_code_covers" not in result.metadata
    assert "completed_with_warnings" not in result.metadata


def test_compound_warning_uses_raw_stderr_before_distillation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        shell_module,
        "_maybe_distill_output",
        lambda *args, **kwargs: ("distilled", "", False),
    )
    result, body = _successful_command_with_stderr(
        monkeypatch,
        "echo first & echo second",
        tmp_path,
    )

    assert body["ok"] is True
    assert result.success is True
    assert body["stderr"] == ""
    assert body["completed_with_warnings"] is True
    assert result.metadata["completed_with_warnings"] is True
