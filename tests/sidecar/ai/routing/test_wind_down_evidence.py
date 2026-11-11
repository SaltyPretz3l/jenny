"""The tools-stripped wind-down carries the latest command result and later edits.

2026-11-03 review: an iteration-limit summary said "Done and verified" while
the last test run had failed with a parse error.
"""

from __future__ import annotations

from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.wind_down_evidence import wind_down_evidence_note


def _command(
    command: str, exit_code: int | None, *, success: bool | None = None,
) -> ToolExecutionOutcome:
    metadata: dict[str, object] = {} if exit_code is None else {"exit_code": exit_code}
    return ToolExecutionOutcome(
        tool_name="run_command", output="",
        success=(exit_code == 0) if success is None else success,
        tool_input={"command": command}, metadata=metadata,
    )


def _edit(path: str, *, success: bool = True) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name="edit_file", output="", success=success,
        tool_input={"file_path": path}, metadata={"path": path},
    )


def test_failed_last_run_and_later_edits_are_stated() -> None:
    note = wind_down_evidence_note([
        _command("powershell -File .\\aegis_kv.ps1 -Test", 0),
        _edit("aegis_kv.ps1"),
        _command("powershell -File .\\aegis_kv.ps1 -Test", 1),
        _edit("aegis_kv.ps1"),
        _edit("aegis_kv.rs"),
        _edit("aegis_kv.ps1"),
    ])

    assert note is not None
    assert "`powershell -File .\\aegis_kv.ps1 -Test`; it exited with code 1 (failed)" in note
    assert "Files changed after the last command: aegis_kv.ps1, aegis_kv.rs." in note
    assert "Earlier commands" not in note
    assert "verified only if its latest run above succeeded" in note


def test_green_last_run_with_no_later_edit() -> None:
    note = wind_down_evidence_note([_edit("a.rs"), _command("rustc --test a.rs", 0)])

    assert note is not None
    assert "exited with code 0 (succeeded)" in note
    assert "No files were changed after the last command." in note


def test_a_timed_out_run_is_the_latest_run_not_the_green_one_before_it() -> None:
    note = wind_down_evidence_note([_command("pytest", 0), _command("pytest", None, success=False)])

    assert note is not None
    assert "`pytest`; it did not complete" in note
    assert "succeeded" not in note.split("\n")[1]


def test_a_later_harmless_command_does_not_hide_a_failing_check() -> None:
    note = wind_down_evidence_note([_command("pytest", 1), _command("git status", 0)])

    assert note is not None
    assert "`git status`; it exited with code 0 (succeeded)" in note
    assert "Earlier commands whose latest run failed: `pytest`." in note

    fixed = wind_down_evidence_note([
        _command("pytest", 1), _command("pytest", 0), _command("git status", 0),
    ])
    assert fixed is not None and "Earlier commands" not in fixed


def test_success_comes_from_the_outcome_not_the_exit_code() -> None:
    note = wind_down_evidence_note([_command("rg TODO src", 1, success=True)])

    assert note is not None
    assert "it exited with code 1 (succeeded)" in note


def test_no_command_run_means_no_note() -> None:
    background_start = ToolExecutionOutcome(
        tool_name="run_command", output="", success=True,
        tool_input={"command": "server.exe"}, metadata={"background_job_id": "0123456789ab"},
    )

    assert wind_down_evidence_note([_edit("a.rs"), background_start]) is None
    assert wind_down_evidence_note([]) is None


def test_failed_edits_and_long_commands_are_bounded() -> None:
    note = wind_down_evidence_note([
        _command("x" * 400, 2),
        _edit("never-written.rs", success=False),
        *[_edit(f"f{index}.rs") for index in range(10)],
    ])

    assert note is not None
    assert "never-written.rs" not in note
    assert "x" * 157 + "..." in note
    assert "and 2 more." in note


def test_temporary_script_is_named_by_its_purpose() -> None:
    script = ToolExecutionOutcome(
        tool_name="run_temp_script", output="", success=False,
        tool_input={"script": "...", "purpose": "Probe raw\nthreads"}, metadata={"exit_code": 2},
    )

    note = wind_down_evidence_note([script])

    assert note is not None
    assert "a temporary script (Probe raw threads); it exited with code 2 (failed)" in note
