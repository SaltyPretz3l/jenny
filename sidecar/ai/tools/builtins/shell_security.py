"""Fail-closed command classifier for shell tool hardening.

Classifies shell commands into allowed / needs_approval / blocked tiers
using shlex parsing and curated allowlists.  No full bash AST parser —
unknown commands default to NEEDS_APPROVAL, never ALLOWED.

The general classifier is feature-gated behind ``FEATURE_SHELL_SECURITY``.
The destructive-command detector is always active at the approval seam.

Threat model
------------
This classifier is the *first* of three defence layers; downstream layers
(approval UI + workspace-root containment + subprocess hygiene) must also
hold for a command to cause damage.

What it blocks outright:
    - Literal destructive substrings (``rm -rf /``, ``mkfs``, fork bombs,
      disk-device redirects).  Substring match, lowercased, fail-closed.

What it routes to NEEDS_APPROVAL:
    - Executables not in the curated SAFE list, regardless of args.
    - Pipe-to-shell patterns (``| bash``, ``| sh``, ``| python``, ``| node``,
      ``| powershell``, ``| pwsh``, ``| zsh``, ``| ksh``) — classic remote
      exec idioms ``curl … | bash`` / ``wget … | sh``.
    - Encoded-payload decoders (``base64 -d``, ``xxd -r``,
      ``powershell -EncodedCommand``, ``powershell -enc``) — whether piped
      or standalone, these signal an opaque payload.
    - Compound commands where any segment falls into NEEDS_APPROVAL.

What it does NOT attempt:
    - Full bash AST parsing.  ``eval``, ``$()``, backticks, process
      substitution, heredocs, and shell functions are not introspected.
    - Every encoding variant.  Only the most common decoder-to-shell
      idioms are flagged; custom packers, gzip-pipe tricks, or
      character-code reconstruction are accepted risks mitigated by the
      unknown-executable NEEDS_APPROVAL default.
    - Runtime env-var expansion.  ``$MALICIOUS_CMD`` is classified as the
      literal string, not as whatever it might expand to at exec time.
    - Filesystem containment.  Path safety is enforced separately by the
      ``workspace.require_root()`` guard in filesystem builtins.
    - Network isolation.  Fetchers like ``curl`` / ``wget`` route through
      approval; any stronger egress policy is enforced by higher-level tool
      controls.

Upgrade posture: the classifier is conservative on purpose.  Prefer
routing to NEEDS_APPROVAL over adding entries to SAFE_EXECUTABLES.
"""

from __future__ import annotations

import base64
import os
import re
import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import PurePosixPath, PureWindowsPath

from sidecar.ai import feature_flags as _feature_flags
from sidecar.ai.tools.builtins.shell_command_split import split_compound_command

FEATURE_STRICT_AUTO_RUN = _feature_flags.FEATURE_STRICT_AUTO_RUN

# ── Classification types ──────────────────────────────────────────────


class CommandVerdict(Enum):
    ALLOWED = "allowed"
    NEEDS_APPROVAL = "needs_approval"
    BLOCKED = "blocked"


@dataclass(frozen=True)
class ClassificationResult:
    verdict: CommandVerdict
    reason: str
    executable: str
    raw_command: str


# ── Lists ─────────────────────────────────────────────────────────────

_BLOCKED_PATTERN_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("rm -rf /*", re.compile(r"\brm\s+-rf\s+/\*", re.IGNORECASE)),
    ("rm -rf /", re.compile(r"\brm\s+-rf\s+/", re.IGNORECASE)),
    ("del /f /s /q", re.compile(r"\bdel\s+/f\s+/s\s+/q\b", re.IGNORECASE)),
    ("format ", re.compile(r"\bformat\s+", re.IGNORECASE)),
    ("mkfs", re.compile(r"\bmkfs(?:\.\w+)?\b", re.IGNORECASE)),
    ("shutdown ", re.compile(r"\bshutdown\s+", re.IGNORECASE)),
    ("reboot", re.compile(r"\breboot\b", re.IGNORECASE)),
    (":(){:|:&};:", re.compile(re.escape(":(){:|:&};:"), re.IGNORECASE)),
    ("> /dev/sda", re.compile(r">\s*/dev/sda\b", re.IGNORECASE)),
)

_SHELL_EXECUTABLE_RE = r"(?:bash|sh|zsh|ksh|dash|csh|tcsh|fish)"

# Pipe-to-shell idioms: `| bash`, `| sh`, `| python`, `| node`, `| powershell`, etc.
# The shell name may be pathed (`/bin/sh`) or suffixed (`.exe`); we allow either.
_PIPE_TO_SHELL_RE = re.compile(
    r"\|\s*(?:[\w./\\-]*[/\\])?"
    rf"{_SHELL_EXECUTABLE_RE}(?:\.exe)?\b"
    r"|\|\s*(?:[\w./\\-]*[/\\])?busybox(?:\.exe)?\s+"
    rf"{_SHELL_EXECUTABLE_RE}(?:\.exe)?\b"
    r"|\|\s*(?:[\w./\\-]*[/\\])?(?:python[23]?|node|pwsh|powershell)"
    r"(?:\.exe)?\b",
    re.IGNORECASE,
)

_SHELL_EXEC_RE = re.compile(
    rf"\b(?:[\w./\\-]*[/\\])?{_SHELL_EXECUTABLE_RE}(?:\.exe)?\s+-c\b"
    r"|\bxargs\b[^|;&]*\b(?:[\w./\\-]*[/\\])?"
    rf"{_SHELL_EXECUTABLE_RE}(?:\.exe)?\s+-c\b"
    r"|\beval\s+"
    r"|(?:^|[;&|]\s*)(?:source|\.)\s+"
    r"|>\s*\(\s*(?:[\w./\\-]*[/\\])?"
    rf"{_SHELL_EXECUTABLE_RE}(?:\.exe)?\b",
    re.IGNORECASE,
)

# Encoded-payload decoders: base64 -d, xxd -r, powershell -EncodedCommand / -enc.
_ENCODED_EXEC_RE = re.compile(
    r"\bbase64\s+(?:--decode\b|-d\b|-D\b)"
    r"|\bxxd\s+(?:-r\b|--revert\b)"
    r"|\bpowershell(?:\.exe)?\b[^|;&]*?\s-(?:e|enc|encodedcommand)\b"
    r"|\bpwsh(?:\.exe)?\b[^|;&]*?\s-(?:e|enc|encodedcommand)\b",
    re.IGNORECASE,
)

SAFE_EXECUTABLES: frozenset[str] = frozenset(
    {
        # filesystem / info
        "ls",
        "dir",
        "cat",
        "head",
        "tail",
        "wc",
        "sort",
        "uniq",
        "find",
        "which",
        "where",
        "echo",
        "printf",
        "date",
        "whoami",
        "hostname",
        "pwd",
        "env",
        "type",
        "file",
        "stat",
        "du",
        "df",
        "uname",
        "true",
        "false",
        # text processing
        "grep",
        "rg",
        "ag",
        "ack",
        "sed",
        "awk",
        "tr",
        "cut",
        "paste",
        "jq",
        "yq",
        # archive
        "tar",
        "zip",
        "unzip",
        "gzip",
        "gunzip",
        # misc safe
        "diff",
        "basename",
        "dirname",
        "realpath",
        "test",
        "[",
    }
)

APPROVAL_REQUIRED_EXECUTABLES: frozenset[str] = frozenset(
    {
        "rm",
        "rmdir",
        "del",
        "sudo",
        "su",
        "chmod",
        "chown",
        "node",
        "npm",
        "npx",
        "yarn",
        "pnpm",
        "python",
        "python3",
        "pip",
        "pip3",
        "cargo",
        "rustc",
        "go",
        "make",
        "cmake",
        "gcc",
        "g++",
        "javac",
        "java",
        "dotnet",
        "mvn",
        "gradle",
        "curl",
        "wget",
        "patch",
        "tee",
        "kill",
        "killall",
        "pkill",
        "docker",
        "kubectl",
        "terraform",
        "ssh",
        "scp",
        "rsync",
        "apt",
        "apt-get",
        "yum",
        "dnf",
        "brew",
        "choco",
        "winget",
        "xargs",
    }
)

DESTRUCTIVE_EXECUTABLES: frozenset[str] = frozenset(
    {
        "rm",
        "rmdir",
        "rd",
        "del",
        "erase",
        "move",
        "mv",
        "format",
        "mkfs",
        "shred",
        "truncate",
        "dd",
    }
)

_SCRIPT_SUFFIXES: tuple[str, ...] = (".bat", ".cmd", ".ps1", ".sh", ".command")
_SHELL_TEMP_SCRIPT_LANGUAGES: frozenset[str] = frozenset(
    {"", "cmd", "sh", "powershell"}
)
_POWERSHELL_DESTRUCTIVE_COMMANDS: dict[str, str] = {
    "remove-item": "Remove-Item",
    "ri": "ri",
    "rm": "rm",
    "rd": "rd",
    "del": "del",
    "erase": "erase",
    "set-content": "Set-Content",
    "out-file": "Out-File",
    "clear-item": "Clear-Item",
    "clear-content": "Clear-Content",
    "move-item": "Move-Item",
    "mi": "mi",
}
_INTERPRETER_EXECUTABLES: frozenset[str] = frozenset(
    {"cmd", "powershell", "pwsh", "bash", "sh", "dash", "zsh", "wsl"}
)
_SCRIPT_ARGUMENT_LAUNCHERS: frozenset[str] = frozenset(
    _INTERPRETER_EXECUTABLES | {"call", "start"}
)
_CONTENT_TRUNCATION_SUFFIXES: tuple[str, ...] = tuple(
    (
        ".js .ts .tsx .jsx .py .rb .go .rs .java .c .h .cpp .cs "
        ".json .yaml .yml .toml .ini .md .html .css .scss .sql .sh .ps1 .bat"
    ).split()
)
_ENVIRONMENT_VARIABLE_RE = re.compile(r"%[A-Za-z_][A-Za-z0-9_]*%")
_BASE64_TOKEN_RE = re.compile(r"[A-Za-z0-9+/]+={0,2}")
_MAX_INTERPRETER_UNWRAP_DEPTH = 2
_MIN_QUOTED_TOKEN_CHARS = 2
_MIN_POWERSHELL_SWITCH_CHARS = 2
_MIN_BASE64_TOKEN_CHARS = 4

# git subcommands considered read-only
_GIT_READ_SUBCOMMANDS: frozenset[str] = frozenset(
    {
        "status",
        "log",
        "diff",
        "show",
        "remote",
        "tag",
        "describe",
        "shortlog",
        "blame",
        "bisect",
        "ls-files",
        "ls-tree",
        "rev-parse",
        "rev-list",
        "reflog",
    }
)

# git subcommands that mutate the repo
_GIT_WRITE_SUBCOMMANDS: frozenset[str] = frozenset(
    {
        "commit",
        "push",
        "branch",
        "merge",
        "rebase",
        "reset",
        "checkout",
        "switch",
        "pull",
        "fetch",
        "cherry-pick",
        "revert",
        "clean",
        "rm",
        "mv",
        "add",
        "restore",
        "stash",
        "config",
        "submodule",
        "worktree",
        "gc",
        "prune",
        "am",
        "apply",
        "format-patch",
    }
)

# ── Helpers ───────────────────────────────────────────────────────────


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


def _executable_name(raw: str) -> str:
    """Extract the bare executable name from a possibly-pathed token."""
    raw = _path_basename(raw)
    # strip common extensions
    for ext in (".exe", *_SCRIPT_SUFFIXES):
        if raw.lower().endswith(ext):
            raw = raw[: -len(ext)]
            break
    return raw.lower()


def shell_command_for_tool(
    descriptor_name: str,
    arguments: Mapping[str, object],
) -> str | None:
    """Return shell source carried by a shell-capable tool call, if applicable."""
    if descriptor_name == "run_temp_script":
        if "language" in arguments:
            language = arguments.get("language")
            if (
                isinstance(language, str)
                and language.strip().lower() not in _SHELL_TEMP_SCRIPT_LANGUAGES
            ):
                return None
        argument_name = "script"
    elif descriptor_name in {"run_command", "monitor"}:
        argument_name = "command"
    else:
        return None

    raw_command = arguments.get(argument_name)
    if not isinstance(raw_command, str) or not raw_command.strip():
        return None
    return raw_command


def shell_command_uses_powershell(
    descriptor_name: str,
    arguments: Mapping[str, object],
) -> bool:
    """Return whether extracted shell source executes with PowerShell grammar."""
    language = arguments.get("language")
    return (
        descriptor_name == "run_temp_script"
        and isinstance(language, str)
        and language.strip().lower() in {"powershell", "pwsh"}
    )


def _skip_git_global_options(argv: list[str]) -> str | None:
    """Return the git subcommand from *argv*, skipping global options.

    Global options: ``-c key=val``, ``-C path``, ``--git-dir=X``,
    ``--work-tree=X``, ``--namespace=X``, ``--no-pager``, ``--bare``.
    Returns ``None`` when no subcommand is found.
    """
    i = 1  # skip "git" itself
    while i < len(argv):
        token = argv[i]
        if token in ("-c", "-C", "--git-dir", "--work-tree", "--namespace"):
            i += 2  # skip flag + value
            continue
        if token.startswith(("--git-dir=", "--work-tree=", "--namespace=")):
            i += 1
            continue
        if token in ("--no-pager", "--bare", "--no-replace-objects"):
            i += 1
            continue
        if token.startswith("-") and not token.startswith("--"):
            # single-char flag clusters we don't recognise — skip
            i += 1
            continue
        return token.lower()
    return None


def _classify_git_command(
    argv: list[str],
    raw_command: str,
) -> ClassificationResult:
    """Classify a git command by its subcommand."""
    subcmd = _skip_git_global_options(argv)
    if subcmd is None:
        return ClassificationResult(
            CommandVerdict.NEEDS_APPROVAL,
            "no git subcommand found",
            "git",
            raw_command,
        )
    if subcmd in _GIT_READ_SUBCOMMANDS:
        return ClassificationResult(
            CommandVerdict.ALLOWED,
            f"git read subcommand: {subcmd}",
            "git",
            raw_command,
        )
    if subcmd in _GIT_WRITE_SUBCOMMANDS:
        return ClassificationResult(
            CommandVerdict.NEEDS_APPROVAL,
            f"git write subcommand: {subcmd}",
            "git",
            raw_command,
        )
    return ClassificationResult(
        CommandVerdict.NEEDS_APPROVAL,
        f"unknown git subcommand: {subcmd}",
        "git",
        raw_command,
    )


def _classify_single(command: str, *, powershell: bool = False) -> ClassificationResult:
    """Classify a single (non-compound) command string."""
    try:
        argv = shlex.split(command, posix=False)
    except ValueError:
        return ClassificationResult(
            CommandVerdict.NEEDS_APPROVAL,
            "unparseable command",
            "",
            command,
        )
    if not argv:
        return ClassificationResult(
            CommandVerdict.BLOCKED,
            "empty command",
            "",
            command,
        )

    exe = _executable_name(argv[0])

    if _has_truncating_redirect(command, powershell=powershell, sensitive_only=False):
        return ClassificationResult(
            CommandVerdict.NEEDS_APPROVAL,
            "output overwrite redirect",
            exe,
            command,
        )

    # git gets its own sub-classifier
    if exe == "git":
        return _classify_git_command(argv, command)

    if exe in APPROVAL_REQUIRED_EXECUTABLES:
        return ClassificationResult(
            CommandVerdict.NEEDS_APPROVAL,
            f"executable requires approval: {exe}",
            exe,
            command,
        )
    if exe in SAFE_EXECUTABLES:
        return ClassificationResult(
            CommandVerdict.ALLOWED,
            f"known safe executable: {exe}",
            exe,
            command,
        )
    return ClassificationResult(
        CommandVerdict.NEEDS_APPROVAL,
        f"unknown executable: {exe}",
        exe,
        command,
    )


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
            if i + 1 < len(command) and command[i + 1] == ">":
                escape_run = 0
                i += 2
                continue
            target_index = i + 1
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


def _destructive_git_use(argv: list[str], lowered: list[str]) -> str | None:
    subcommand = _skip_git_global_options(argv)
    if subcommand is None:
        return None
    try:
        subcommand_index = lowered.index(subcommand, 1)
    except ValueError:
        return None
    args = lowered[subcommand_index + 1 :]
    if subcommand == "clean" and not {"--help", "-n", "--dry-run"}.intersection(args):
        return "git clean"
    if subcommand == "reset" and "--hard" in args:
        return "git reset --hard"
    if subcommand == "checkout" and "--" in args and args.index("--") + 1 < len(args):
        return "git checkout --"
    if subcommand == "restore" and ("--staged" not in args or "--worktree" in args):
        return "git restore"
    recursive = any(
        token in {"-r", "--recursive"}
        or (token.startswith("-") and not token.startswith("--") and "r" in token[1:])
        for token in args
    )
    if subcommand == "rm" and "--cached" in args and recursive:
        return "git rm -r --cached"
    return None


def _destructive_safe_executable_use(executable: str, argv: list[str]) -> str | None:
    lowered = [_strip_surrounding_quotes(token).lower() for token in argv]
    if executable == "find":
        if "-delete" in lowered[1:]:
            return "find -delete"
        for index, token in enumerate(lowered[1:], start=1):
            if token in {"-exec", "-execdir"} and index + 1 < len(argv):
                nested_executable = _executable_name(argv[index + 1])
                if nested_executable in DESTRUCTIVE_EXECUTABLES:
                    return f"find {token} {nested_executable}"
    if executable == "sed" and any(
        token in {"-i", "--in-place"}
        or token.startswith("--in-place=")
        or (token.startswith("-i") and not token.startswith("--"))
        for token in lowered[1:]
    ):
        return "sed -i"
    if executable == "git":
        return _destructive_git_use(argv, lowered)
    if executable == "robocopy" and {"/mir", "/purge"}.intersection(lowered[1:]):
        return "robocopy mirror/purge"
    return None


def _script_invocation_token(raw_executable: str) -> str | None:
    basename = _path_basename(raw_executable).lower()
    if basename.endswith(_SCRIPT_SUFFIXES):
        return f"script:{basename}"
    return None


def _script_argument_token(executable: str, argv: list[str]) -> str | None:
    if executable not in _SCRIPT_ARGUMENT_LAUNCHERS:
        return None
    if executable == "start" or (
        executable in _INTERPRETER_EXECUTABLES
        and _interpreter_payload(argv, executable) is not None
    ):
        return None
    for token in argv[1:]:
        script_token = _script_invocation_token(token)
        if script_token is not None:
            return script_token
    return None


def _start_payload(argv: list[str]) -> str | None:
    index = 1
    if index < len(argv) and _strip_surrounding_quotes(argv[index]).lower() == "/wait":
        index += 1
    if index < len(argv) and argv[index].strip().startswith('"'):
        index += 1
    remainder = _strip_surrounding_quotes(" ".join(argv[index:]).strip())
    return remainder or None


def _xargs_destructive_payload(
    argv: list[str],
    *,
    depth: int,
) -> str | None:
    if depth >= _MAX_INTERPRETER_UNWRAP_DEPTH:
        return "xargs"
    for index, token in enumerate(argv[1:], start=1):
        nested_executable = _executable_name(token)
        if nested_executable not in DESTRUCTIVE_EXECUTABLES | _INTERPRETER_EXECUTABLES:
            continue
        match = _find_destructive(
            " ".join(argv[index:]),
            depth=depth + 1,
            powershell=False,
        )
        if match is not None:
            return match
    return None


def _environment_interpreter_match(argv: list[str], *, depth: int) -> str | None:
    if not _ENVIRONMENT_VARIABLE_RE.search(_strip_surrounding_quotes(argv[0])):
        return None
    payload = _interpreter_payload(argv, "cmd")
    remainder = payload[1] if payload is not None else " ".join(argv[1:]).strip()
    if depth < _MAX_INTERPRETER_UNWRAP_DEPTH and remainder:
        match = _find_destructive(remainder, depth=depth + 1, powershell=False)
        if match is not None:
            return match
    return "environment interpreter"


def _interpreter_match(executable: str, argv: list[str], *, depth: int) -> str | None:
    if executable not in _INTERPRETER_EXECUTABLES:
        return None
    payload = _interpreter_payload(argv, executable)
    if payload is None:
        return None
    switch, remainder, decode_failed = payload
    if decode_failed:
        return f"{executable} -EncodedCommand"
    if depth >= _MAX_INTERPRETER_UNWRAP_DEPTH:
        return f"{executable} {switch}"
    return _find_destructive(
        remainder,
        depth=depth + 1,
        powershell=executable in {"powershell", "pwsh"},
    )


def _launcher_match(executable: str, argv: list[str], *, depth: int) -> str | None:
    if executable == "xargs":
        return _xargs_destructive_payload(argv, depth=depth)
    if executable != "start":
        return None
    remainder = _start_payload(argv)
    if remainder is None:
        return None
    if depth >= _MAX_INTERPRETER_UNWRAP_DEPTH:
        return "start"
    return _find_destructive(remainder, depth=depth + 1, powershell=False)


def _find_destructive_segment(segment: str, *, depth: int, powershell: bool) -> str | None:
    argv = _command_argv(segment)
    if not argv:
        return None
    environment_match = _environment_interpreter_match(argv, depth=depth)
    if environment_match is not None:
        return environment_match
    executable = _executable_name(argv[0])
    if powershell and executable in _POWERSHELL_DESTRUCTIVE_COMMANDS:
        return _POWERSHELL_DESTRUCTIVE_COMMANDS[executable]
    if executable in DESTRUCTIVE_EXECUTABLES:
        return executable
    nested_match = _interpreter_match(executable, argv, depth=depth)
    if nested_match is not None:
        return nested_match
    launcher_match = _launcher_match(executable, argv, depth=depth)
    if launcher_match is not None:
        return launcher_match
    destructive_use = _destructive_safe_executable_use(executable, argv)
    if destructive_use is not None:
        return destructive_use
    script_token = _script_invocation_token(argv[0]) or _script_argument_token(executable, argv)
    if script_token is not None:
        return script_token
    return ">" if _has_truncating_redirect(segment, powershell=powershell) else None


def _find_destructive(
    command: str,
    *,
    depth: int,
    powershell: bool,
) -> str | None:
    segments = (
        _split_powershell_commands(command)
        if powershell
        else split_compound_command(command)
    )
    for segment in segments:
        match = _find_destructive_segment(segment, depth=depth, powershell=powershell)
        if match is not None:
            return match
    return None


# ── Verdict ordering for compound commands ────────────────────────────

def find_blocked_pattern(command: str) -> str | None:
    """Return the canonical blocked pattern matched by *command*, if any."""
    for pattern, regex in _BLOCKED_PATTERN_RULES:
        if regex.search(command):
            return pattern
    return None


_VERDICT_SEVERITY = {
    CommandVerdict.ALLOWED: 0,
    CommandVerdict.NEEDS_APPROVAL: 1,
    CommandVerdict.BLOCKED: 2,
}


# ── Public API ────────────────────────────────────────────────────────


def find_destructive_executable(command: str, *, powershell: bool = False) -> str | None:
    """Return the first data-destroying command token in *command*, if any."""
    return _find_destructive(command, depth=0, powershell=powershell)


def classify_command(command: str, *, powershell: bool = False) -> ClassificationResult:
    """Classify *command* into allowed / needs_approval / blocked.

    Fail-closed: unknown commands default to ``NEEDS_APPROVAL``.
    Compound commands are split using the active platform's shell separators,
    and the most restrictive sub-verdict wins.
    """
    stripped = command.strip()
    if not stripped:
        return ClassificationResult(
            CommandVerdict.BLOCKED,
            "empty command",
            "",
            command,
        )

    # blocked-pattern scan on the raw string (before parsing)
    blocked_pattern = find_blocked_pattern(stripped)
    if blocked_pattern is not None:
        return ClassificationResult(
            CommandVerdict.BLOCKED,
            f"blocked pattern: {blocked_pattern}",
            "",
            command,
        )

    # Pipe-to-shell and encoded-command detection: force NEEDS_APPROVAL
    # regardless of how individual segments classify.
    if _PIPE_TO_SHELL_RE.search(stripped):
        return ClassificationResult(
            CommandVerdict.NEEDS_APPROVAL,
            "pipe-to-shell",
            "",
            command,
        )
    if _ENCODED_EXEC_RE.search(stripped):
        return ClassificationResult(
            CommandVerdict.NEEDS_APPROVAL,
            "encoded-command",
            "",
            command,
        )
    if _SHELL_EXEC_RE.search(stripped):
        return ClassificationResult(
            CommandVerdict.NEEDS_APPROVAL,
            "shell-exec",
            "",
            command,
        )

    segments = (
        _split_powershell_commands(stripped)
        if powershell
        else split_compound_command(stripped)
    )
    if len(segments) == 1:
        return _classify_single(command, powershell=powershell)

    worst: ClassificationResult | None = None
    for seg in segments:
        result = _classify_single(seg, powershell=powershell)
        if worst is None or _VERDICT_SEVERITY[result.verdict] > _VERDICT_SEVERITY[worst.verdict]:
            worst = result
        if result.verdict is CommandVerdict.BLOCKED:
            return result  # short-circuit

    assert worst is not None
    return ClassificationResult(
        worst.verdict,
        worst.reason,
        worst.executable,
        command,
    )
