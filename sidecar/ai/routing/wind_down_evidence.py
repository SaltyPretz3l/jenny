"""Facts from the turn's own tool results for a tools-stripped wind-down reply.

2026-11-03 review: a turn that hit the iteration limit summarized itself as
"Done and verified" while its last test run had failed on a parse error, and
another said the server "serves real TCP clients" after a later edit broke the
build. The wind-down generation now carries the latest command result, any
command whose latest run failed, and the files changed after the last run,
with a rule against claiming what they contradict.
"""

from __future__ import annotations

from typing import Any

_COMMAND_TOOLS = frozenset({"run_command", "run_temp_script"})
_EDIT_TOOLS = frozenset({"write_file", "edit_file"})
_MAX_COMMAND_CHARS = 160
_MAX_LISTED = 8


def wind_down_evidence_note(outcomes: list[Any]) -> str | None:
    """The latest command run, commands still failing, and later edits, or None."""
    latest_ok: dict[str, bool] = {}  # command label -> its latest run succeeded, run order
    last_label: str | None = None
    last_status = ""
    changed_after: list[str] = []
    for outcome in outcomes:
        tool_name = str(getattr(outcome, "tool_name", "") or "")
        metadata = getattr(outcome, "metadata", None) or {}
        if tool_name in _COMMAND_TOOLS and "background_job_id" not in metadata:
            # A background start is not a run; a timeout or refusal is one that failed.
            label = _command_label(outcome)
            succeeded = bool(getattr(outcome, "success", False))
            latest_ok.pop(label, None)
            latest_ok[label] = succeeded
            last_label, last_status = label, _run_status(succeeded, metadata.get("exit_code"))
            changed_after = []
        elif tool_name in _EDIT_TOOLS and getattr(outcome, "success", False):
            path = metadata.get("path")
            if isinstance(path, str) and path and path not in changed_after:
                changed_after.append(path)
    if last_label is None:
        return None
    lines = [
        "Facts from this turn's tool results:",
        f"- The last command run was {last_label}; {last_status}.",
    ]
    still_failing = [label for label, ok in latest_ok.items() if not ok and label != last_label]
    if still_failing:
        lines.append(
            "- Earlier commands whose latest run failed: "
            + ", ".join(still_failing[-_MAX_LISTED:]) + "."
        )
    if changed_after:
        listed = ", ".join(changed_after[:_MAX_LISTED])
        more = len(changed_after) - _MAX_LISTED
        lines.append(
            f"- Files changed after the last command: {listed}"
            + (f" and {more} more." if more > 0 else ".")
        )
    else:
        lines.append("- No files were changed after the last command.")
    lines.append(
        "Say a build, test or check passed, works or is verified only if its latest run "
        "above succeeded and nothing it covers changed afterwards; otherwise say it is "
        "failing or unverified."
    )
    return "\n".join(lines)


def _run_status(succeeded: bool, exit_code: object) -> str:
    """The run's outcome by its success flag (rg exit 1 can succeed), with the code."""
    if isinstance(exit_code, bool) or not isinstance(exit_code, int):
        if succeeded:
            return "it succeeded"
        return "it did not complete (no exit code: it timed out, was stopped or was refused)"
    return f"it exited with code {exit_code} ({'succeeded' if succeeded else 'failed'})"


def _command_label(outcome: Any) -> str:
    tool_input = getattr(outcome, "tool_input", None) or {}
    if getattr(outcome, "tool_name", "") == "run_temp_script":
        purpose = _one_line(tool_input.get("purpose"))
        return f"a temporary script ({purpose})" if purpose else "a temporary script"
    command = _one_line(tool_input.get("command"))
    return f"`{command}`" if command else "a command"


def _one_line(value: object) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > _MAX_COMMAND_CHARS:
        text = text[: _MAX_COMMAND_CHARS - 3] + "..."
    return text
