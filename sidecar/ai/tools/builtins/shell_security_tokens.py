"""Tokenization helpers for the shell command classifier.

Quote stripping, argv splitting (POSIX and PowerShell grammars), redirect
detection, PowerShell switch/base64 handling and interpreter payload
extraction. Pure functions over command text: no policy lives here. The
verdict allowlists (``SAFE_EXECUTABLES``, the git read/write sets) stay in
``shell_security.py`` where ``check_phase3_security_invariants.py`` reads
them.
"""

from __future__ import annotations

import base64
import os
import re
import shlex
from pathlib import PurePosixPath, PureWindowsPath

_CONTENT_TRUNCATION_SUFFIXES: tuple[str, ...] = tuple(
    (
        ".js .ts .tsx .jsx .py .rb .go .rs .java .c .h .cpp .cs "
        ".json .yaml .yml .toml .ini .md .html .css .scss .sql .sh .ps1 .bat"
    ).split()
)
_BASE64_TOKEN_RE = re.compile(r"[A-Za-z0-9+/]+={0,2}")
_MIN_QUOTED_TOKEN_CHARS = 2
_MIN_POWERSHELL_SWITCH_CHARS = 2
_MIN_BASE64_TOKEN_CHARS = 4


def _strip_surrounding_quotes(raw: str) -> str:
    stripped = raw.strip()
    if (
        len(stripped) >= _MIN_QUOTED_TOKEN_CHARS
        and stripped[0] == stripped[-1]
        and stripped[0] in {"'", '"'}
    ):
        return stripped[1:-1]
    return stripped


def _path_basename(raw: str) -> str:
    """Resolve a basename through both POSIX and Windows path grammars."""
    raw = _strip_surrounding_quotes(raw)
    for cls in (PurePosixPath, PureWindowsPath):
        name = cls(raw).name
        if name:
            raw = name
    return raw


_STANDALONE_WINDOWS_EXECUTABLE_RE = re.compile(
    r"^[A-Za-z]:[\\/].+\.(?:exe|bat|cmd|ps1|sh|command)$",
    re.IGNORECASE,
)


def _command_argv(command: str) -> list[str]:
    stripped = command.strip()
    unquoted = _strip_surrounding_quotes(stripped)
    if _STANDALONE_WINDOWS_EXECUTABLE_RE.fullmatch(unquoted):
        return [unquoted]
    try:
        return shlex.split(stripped, posix=False)
    except ValueError:
        return []


def _split_powershell_commands(command: str) -> list[str]:
    """Split PowerShell command words while honoring its quote and escape rules."""
    segments: list[str] = []
    current: list[str] = []
    in_single = False
    in_double = False
    i = 0
    while i < len(command):
        ch = command[i]
        if ch == "`" and i + 1 < len(command):
            if command[i + 1] in "\r\n":
                i += 3 if command[i + 1 : i + 3] == "\r\n" else 2
                continue
            current.extend((ch, command[i + 1]))
            i += 2
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            current.append(ch)
        elif ch == '"' and not in_single:
            in_double = not in_double
            current.append(ch)
        elif not in_single and not in_double and ch in ";|&\r\n":
            segment = "".join(current).strip()
            if segment:
                segments.append(segment)
            current = []
            if command[i : i + 2] in {"&&", "||"}:
                i += 1
        else:
            current.append(ch)
        i += 1
    tail = "".join(current).strip()
    if tail:
        segments.append(tail)
    return segments if segments else [command.strip()]


def _redirect_target(command: str, target_index: int, *, powershell: bool) -> str | None:
    remainder = command[target_index:].strip()
    if not remainder:
        return None
    try:
        argv = shlex.split(remainder, posix=os.name != "nt" and not powershell)
    except ValueError:
        return None
    if not argv:
        return None
    return _strip_surrounding_quotes(argv[0])


def _has_truncating_redirect(
    command: str,
    *,
    powershell: bool,
    sensitive_only: bool = True,
) -> bool:
    windows_cmd = os.name == "nt" and not powershell
    escape_char = "`" if powershell else ("^" if windows_cmd else "\\")
    in_single = False
    in_double = False
    escape_run = 0
    i = 0
    while i < len(command):
        ch = command[i]
        escaped = escape_run % 2 == 1
        if ch == "'" and not windows_cmd and not in_double and not escaped:
            in_single = not in_single
        elif ch == '"' and not in_single and not escaped:
            in_double = not in_double
        elif ch == ">" and not in_single and not in_double and not escaped:
            target_index = i + 2 if command[i : i + 2] == ">>" else i + 1
            while target_index < len(command) and command[target_index].isspace():
                target_index += 1
            if target_index < len(command) and command[target_index] == "&":
                escape_run = 0
                i += 1
                continue
            if not sensitive_only:
                return True
            target = _redirect_target(command, target_index, powershell=powershell)
            if target is not None and _path_basename(target).lower().endswith(
                _CONTENT_TRUNCATION_SUFFIXES
            ):
                return True
        escape_run = escape_run + 1 if ch == escape_char else 0
        i += 1
    return False


def _is_switch_prefix(token: str, canonical: str) -> bool:
    return len(token) >= _MIN_POWERSHELL_SWITCH_CHARS and canonical.startswith(token)


def _looks_like_base64(token: str) -> bool:
    return len(token) >= _MIN_BASE64_TOKEN_CHARS and _BASE64_TOKEN_RE.fullmatch(token) is not None


def _decode_powershell_command(token: str) -> str | None:
    if not token:
        return None
    try:
        payload = base64.b64decode(token, validate=True)
        return payload.decode("utf-16-le")
    except (UnicodeDecodeError, ValueError):
        return None


def _interpreter_payload(
    argv: list[str],
    executable: str,
) -> tuple[str, str, bool] | None:
    for index, token in enumerate(argv[1:], start=1):
        switch = _strip_surrounding_quotes(token).lower()
        if executable == "cmd" and switch not in {"/c", "/k"}:
            continue
        if executable in {"bash", "sh", "dash", "zsh"}:
            if switch.startswith("--") or not switch.startswith("-") or "c" not in switch[1:]:
                continue
        if executable == "wsl" and switch not in {"--", "-e", "--exec"}:
            continue
        if executable in {"powershell", "pwsh"}:
            encoded_prefix = _is_switch_prefix(switch, "-encodedcommand")
            next_token = (
                _strip_surrounding_quotes(argv[index + 1])
                if index + 1 < len(argv)
                else ""
            )
            if encoded_prefix and (switch != "-e" or _looks_like_base64(next_token)):
                decoded = _decode_powershell_command(next_token)
                if decoded is None:
                    return "-EncodedCommand", "", True
                return "-EncodedCommand", decoded, False
            if not _is_switch_prefix(switch, "-command"):
                continue
        remainder = _strip_surrounding_quotes(" ".join(argv[index + 1 :]).strip())
        if remainder:
            return switch, remainder, False
        return None
    return None
