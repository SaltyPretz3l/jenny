"""Workspace scope of shell command arguments (security review 2026-10-25, item 1).

The command classifier sees only the command string, so a read it allows by
executable name (``type C:\\Users\\me\\.ssh\\id_rsa``, ``cat ../../secret``)
would run without approval and, with a cloud engine, send the file off the
machine. ``find_out_of_root_argument`` names the first argument that resolves
outside the bound workspace root, or that cannot be resolved statically (an
environment variable, a home-directory reference or a PowerShell provider drive),
so the approval seam can ask instead of auto-running. cmd.exe carets are dropped
first, as cmd.exe drops them (``C^:\\x`` is ``C:\\x``).
Resolution uses ``realpath``, so a junction or symlink inside the root that
points outside it counts as outside; a plain relative name is resolved too when
it exists, which is how such a link is found. Redirects inside a token
(``0<file``), ``--opt=value`` and ``-Param:value`` are unwrapped first. The
first operand of a pattern tool (grep, sed, awk) is its pattern or program, not
a file, unless ``-e``/``-f`` moved the pattern into an option.

Fail-closed by design: a false positive costs one approval prompt; this module
never turns a NEEDS_APPROVAL verdict into ALLOWED.
"""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path

from sidecar.ai.tools.builtins.shell_command_split import split_compound_command
from sidecar.ai.tools.builtins.shell_security import ClassificationResult, CommandVerdict
from sidecar.ai.tools.builtins.shell_security_tokens import (
    _path_basename,
    _split_powershell_commands,
    _strip_surrounding_quotes,
)

_URL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
# The variable syntax the running shell expands: cmd.exe (run_command on Windows)
# expands only %NAME% (and %NAME:~0,2% substrings) and leaves `~` alone;
# PowerShell and sh expand $NAME and `~`.
_CMD_VARIABLE_RE = re.compile(r"%[A-Za-z_][^%\s]*%")
_DOLLAR_VARIABLE_RE = re.compile(r"\$\{?(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}?", re.IGNORECASE)
_DRIVE_RE = re.compile(r"^[A-Za-z]:")
# PowerShell provider drives (Env:, HKLM:\..., Cert:\...) read outside any directory.
_PROVIDER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]+:")
_REDIRECT_RE = re.compile(r"\d*(?:>>?|<)&?")
_SEPARATORS_RE = re.compile(r"[\\/]")
_UNC_RE = re.compile(r"^[\\/]{2}")
_WINDOWS_SWITCH_RE = re.compile(r"^/[A-Za-z?](?::|$)")
_PATTERN_TOOLS = frozenset(
    {"grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "mawk", "findstr"}
)
_PATTERN_OPTION_RE = re.compile(r"^-(?:e|f)|^--(?:regexp|file|expression)", re.IGNORECASE)
# Above this many words the check stops resolving and asks (bounds the approval seam).
MAX_CHECKED_TOKENS = 512


def _pieces(token: str, *, cmd: bool) -> list[str]:
    """The values a token may name a path with: redirect targets, `--opt=` and `-Param:` values."""
    if cmd:
        token = token.replace("^", "")
    pieces = []
    for raw in _REDIRECT_RE.split(_strip_surrounding_quotes(token)):
        value = _strip_surrounding_quotes(raw)
        if value.startswith("-"):
            option_value = re.split(r"[=:]", value, maxsplit=1)[1:]
            value = _strip_surrounding_quotes(option_value[0]) if option_value else ""
        if value:
            pieces.append(value)
    return pieces


def _is_option(token: str, *, windows: bool) -> bool:
    value = _strip_surrounding_quotes(token)
    return value.startswith("-") or (windows and _WINDOWS_SWITCH_RE.match(value) is not None)


def _path_like(value: str, *, windows: bool) -> bool:
    if ".." in _SEPARATORS_RE.split(value):
        return True
    if windows:
        if _DRIVE_RE.match(value) or value.startswith("\\"):
            return True
        # `/s`, `/b` are cmd switches; `/etc/x` is a path on the current drive.
        return value.startswith("/") and _SEPARATORS_RE.search(value[1:]) is not None
    return value.startswith("/")


def _unresolvable(value: str, *, cmd: bool, powershell: bool) -> bool:
    r"""A value the shell rewrites before use, so its path cannot be checked here.

    `%USERPROFILE%\.ssh`, `$HOME/.ssh` and `Env:` qualify; git's `--format=%h%n`
    and PowerShell's `$_.Name` do not.
    """
    if powershell and _PROVIDER_RE.match(value):
        return True
    if not cmd and value.startswith("~"):
        return True
    match = (_CMD_VARIABLE_RE if cmd else _DOLLAR_VARIABLE_RE).search(value)
    return match is not None and (
        match.group(0) == value or _SEPARATORS_RE.search(value, match.end()) is not None
    )


def _segments(command: str, *, powershell: bool) -> list[list[str]] | None:
    split = _split_powershell_commands if powershell else split_compound_command
    argvs = []
    for segment in split(command):
        try:
            argvs.append(shlex.split(segment, posix=False))
        except ValueError:
            return None
    return argvs


def _checked_tokens(argv: list[str], *, windows: bool) -> list[str]:
    """The words of one command that may name files: all but a pattern tool's pattern."""
    if not argv:
        return []
    tool = _path_basename(_strip_surrounding_quotes(argv[0])).lower().removesuffix(".exe")
    args = argv[1:]
    if tool not in _PATTERN_TOOLS or any(_PATTERN_OPTION_RE.match(arg) for arg in args):
        return argv
    for index, arg in enumerate(args):
        if not _is_option(arg, windows=windows):
            # `grep x<C:\secret` reads stdin from a file: a redirect is never a pattern.
            if _REDIRECT_RE.search(arg):
                return argv
            return [argv[0], *args[:index], *args[index + 1:]]
    return argv


def find_out_of_root_argument(
    command: str,
    *,
    root: str | None,
    cwd: str | None = None,
    powershell: bool = False,
    windows: bool = os.name == "nt",
) -> str | None:
    """Return the first argument naming a path outside *root*, or ``None``.

    With no bound root every path-like argument counts as outside.
    """
    argvs = _segments(command.strip(), powershell=powershell)
    if argvs is None:
        return command.strip()
    tokens = [token for argv in argvs for token in _checked_tokens(argv, windows=windows)]
    if len(tokens) > MAX_CHECKED_TOKENS:
        return f"more than {MAX_CHECKED_TOKENS} arguments"
    cmd = windows and not powershell
    base = Path(root, cwd or "") if root else None
    bound = os.path.normcase(os.path.realpath(root)) if root else ""
    seen: set[str] = set()
    for token in tokens:
        for value in _pieces(token, cmd=cmd):
            if value in seen or _URL_RE.match(value):
                continue
            seen.add(value)
            # A UNC name is never resolved: realpath would open it over SMB.
            if _unresolvable(value, cmd=cmd, powershell=powershell) or (
                windows and _UNC_RE.match(value)
            ):
                return value
            path_like = _path_like(value, windows=windows)
            if base is None:
                if path_like:
                    return value
                continue
            # An existing relative name may be a junction or symlink out of the root.
            target = os.fspath(base / value)
            if (path_like or os.path.lexists(target)) and not _inside(target, bound):
                return value
    return None


def _inside(path: str, bound: str) -> bool:
    resolved = os.path.normcase(os.path.realpath(path))
    try:
        return os.path.commonpath([resolved, bound]) == bound
    except ValueError:  # different drives
        return False


def escalate_out_of_root(
    result: ClassificationResult,
    *,
    root: str | None,
    cwd: str | None,
    powershell: bool,
) -> ClassificationResult:
    """Turn an ALLOWED verdict into NEEDS_APPROVAL when an argument leaves *root*."""
    if result.verdict is not CommandVerdict.ALLOWED:
        return result
    outside = find_out_of_root_argument(
        result.raw_command, root=root, cwd=cwd, powershell=powershell
    )
    if outside is None:
        return result
    return ClassificationResult(
        CommandVerdict.NEEDS_APPROVAL,
        f"argument outside the workspace: {outside}",
        result.executable,
        result.raw_command,
    )
