"""Actionable hints for a command the shell could not resolve.

Split from ``shell.py`` (file-size ceiling). run_command and
check_background_job attach the hint to a failed result.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from sidecar.ai.tools.builtins.shell_harness import powershell_directory as _powershell_directory


# shell.py keeps its own copy: its tests fake the platform through shell.os.
def _shell_name() -> str:
    return "cmd.exe" if os.name == "nt" else "/bin/sh"


# Name groups are bounded (longer names are refused below anyway) and the
# POSIX form starts only at a token boundary: an unbounded ``[^\s:]+`` tried at
# every offset of a long space-free stdout line backtracked quadratically
# (14 s for 80 KB).
_UNRESOLVED_COMMAND_RE = re.compile(
    r"'([^'\r\n]{1,64})' is not recognized as an internal or external command"
    r"|(?<![^\s:])([^\s:]{1,64}): (?:command not found|not found)"
    r"|The term ['\"]([^'\"\r\n]{1,64})['\"] is not recognized as (?:the |a )?name of a cmdlet",
    re.IGNORECASE,
)
# The name comes from command output (untrusted) and is echoed into the
# trusted-looking ``hint``: only a short bare program name qualifies.
_HINT_COMMAND_NAME_RE = re.compile(r"[A-Za-z0-9_.\-]{1,64}")
# cmd.exe's default PATHEXT; a hint does not need the live value (env reads stay in config.py).
_WINDOWS_PROGRAM_EXTENSIONS = (".com", ".exe", ".bat", ".cmd")


def unresolved_command_hint(  # noqa: PLR0911 - one return per hint case.
    output: str, *, cwd: Path | None = None,
) -> str | None:
    """Turn a bare shell "not recognized" line into actionable guidance.

    Without this the model sees only the shell's own message, concludes it
    should retry with a full path, announces that, and burns another turn.
    ``output`` is stderr, then stdout: ``2>&1`` moves the shell's message there.
    """
    match = _UNRESOLVED_COMMAND_RE.search(output or "")
    if match is None or not (
        name := (match.group(1) or match.group(2) or match.group(3) or "").strip()
    ) or _HINT_COMMAND_NAME_RE.fullmatch(name) is None:
        return None
    local = _working_directory_program_hint(name, cwd)
    if local is not None:
        return local
    powershell_error = match.group(3) is not None
    resolved = shutil.which(name)
    if resolved:
        if powershell_error:
            escaped = resolved.replace("'", "''")
            return f"{name!r} was not found by PowerShell; invoke the executable as & '{escaped}'."
        return f"{name!r} is not on this shell's PATH; invoke it as {resolved!r}."
    if name.lower() in {"powershell", "powershell.exe", "pwsh", "pwsh.exe"}:
        directory = _powershell_directory()
        if directory is not None:
            return (
                f"{name!r} is not on this shell's PATH; invoke it as "
                f"{str(directory / 'powershell.exe')!r}."
            )
    if powershell_error:
        return (
            f"{name!r} was not found by PowerShell. Check Get-Command, the command spelling, "
            "and installation; use & 'absolute executable path' for commands outside the "
            "constructed tool PATH."
        )
    return (
        f"{name!r} could not be resolved by {_shell_name()}. Use an absolute "
        "path, or a different tool for this step."
    )


def _working_directory_program_hint(name: str, cwd: Path | None) -> str | None:
    """Name the ``.\\`` form when the program sits in the command's directory.

    The harness sets NoDefaultCurrentDirectoryInExePath (shell_harness), so
    cmd.exe never runs a program from the current directory by bare name; the
    2026-11-03 session hit that six times. ``name`` is a bare file name
    (_HINT_COMMAND_NAME_RE), so the lookup stays inside ``cwd``.
    """
    if cwd is None:
        return None
    candidates = [name]
    if os.name == "nt" and not Path(name).suffix:
        candidates += [name + extension for extension in _WINDOWS_PROGRAM_EXTENSIONS]
    if not any((cwd / candidate).is_file() for candidate in candidates):
        return None
    prefix = ".\\" if os.name == "nt" else "./"
    return (
        f"{name!r} is in the working directory, but this shell does not run programs "
        f"from the current directory by bare name. Run it as {prefix}{name}."
    )
