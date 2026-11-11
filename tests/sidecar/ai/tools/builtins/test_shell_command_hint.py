"""A program in the working directory gets the ``.\\name`` hint, wherever the error lands.

2026-11-03 session: cmd.exe here never runs a program from the current
directory by bare name (NoDefaultCurrentDirectoryInExePath), so
``aegis_kv_test.exe`` failed six times. With ``2>&1`` the shell's message went
to stdout and no hint fired; when one did, it said "use an absolute path";
background jobs got none.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from sidecar.ai.tools.builtins.shell import check_background_job_tool, run_command_tool
from sidecar.ai.tools.builtins.shell_command_hint import unresolved_command_hint
from sidecar.ai.tools.workspace import WorkspaceGuard

_PREFIX = ".\\" if os.name == "nt" else "./"
_CMD_MESSAGE = (
    "'local_tool.exe' is not recognized as an internal or external command,\r\n"
    "operable program or batch file.\r\n"
)


def test_program_in_the_working_directory_gets_the_relative_form(tmp_path: Path) -> None:
    (tmp_path / "local_tool.exe").write_bytes(b"")

    hint = unresolved_command_hint(_CMD_MESSAGE, cwd=tmp_path)

    assert hint is not None
    assert f"{_PREFIX}local_tool.exe" in hint


def test_missing_program_keeps_the_generic_hint(tmp_path: Path) -> None:
    hint = unresolved_command_hint(_CMD_MESSAGE, cwd=tmp_path)

    assert hint is not None
    assert _PREFIX + "local_tool.exe" not in hint
    assert "absolute path" in hint


def test_a_directory_with_the_name_is_not_a_program(tmp_path: Path) -> None:
    (tmp_path / "local_tool.exe").mkdir()

    hint = unresolved_command_hint(_CMD_MESSAGE, cwd=tmp_path)

    assert hint is not None and "absolute path" in hint


def test_long_space_free_output_is_searched_in_linear_time() -> None:
    # The unbounded pattern took minutes on this input (14 s already at 80 KB).
    started = time.perf_counter()

    assert unresolved_command_hint("A" * 200_000 + "\n" + "'x" * 50_000) is None

    assert time.perf_counter() - started < 1.0


def test_posix_message_after_a_shell_prefix_still_matches(tmp_path: Path) -> None:
    hint = unresolved_command_hint("/bin/sh: 1: frobnicate: not found\n", cwd=tmp_path)

    assert hint is not None and "frobnicate" in hint


def test_run_command_finds_the_message_after_2_to_1(tmp_path: Path) -> None:
    (tmp_path / "local_tool.exe").write_bytes(b"")

    result = run_command_tool({"command": "local_tool.exe 2>&1"}, WorkspaceGuard(str(tmp_path)))

    body = json.loads(result.output)
    assert body["exit_code"] != 0
    assert body["stderr"] == ""
    assert f"{_PREFIX}local_tool.exe" in body["hint"]


def test_failed_background_job_gets_the_hint(tmp_path: Path) -> None:
    (tmp_path / "local_tool.exe").write_bytes(b"")
    job_id = "0123456789ab"
    job_dir = tmp_path / ".jenny" / "tool-results" / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "status.json").write_text(
        json.dumps({
            "job_id": job_id, "state": "failed", "exit_code": 1,
            "stdout": "", "stderr": _CMD_MESSAGE,
        }),
        encoding="utf-8",
    )

    result = check_background_job_tool({"job_id": job_id}, WorkspaceGuard(str(tmp_path)))

    assert f"{_PREFIX}local_tool.exe" in json.loads(result.output)["hint"]
