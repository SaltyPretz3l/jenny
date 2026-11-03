"""What an "Always allow" on a run_command card may cover (row 103).

Security review item 2, owner pick B (2026-11-02): a plain
``program subcommand ...`` command is saved as its program + subcommand prefix
(any arguments); a command with no safe prefix is saved as its exact text; a
chained, redirected or substituted command can only be allowed once.

Mirrors ``services/tools/command-prefix.js`` exactly; both are driven by
``tests/fixtures/command-prefix-cases.json``. Dependency-free on purpose so
the policy matcher can import it without widening its import graph.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Same bound as the Electron store's MAX_MATCH_TEXT_CHARS (code points).
MAX_COMMAND_CHARS = 1024
# Anywhere in the text, even inside quotes: chaining, redirection,
# substitution, cmd.exe escapes and variable expansion.
_UNSCOPED_CHARACTERS = frozenset("&|;<>`$()^%!")
# Shells, launchers and interpreters: their second word is another program or
# a script, so "any arguments" would mean any command. Always exact.
WRAPPER_PROGRAMS = frozenset(
    {
        "bash", "builtin", "busybox", "call", "cmd", "command", "csh", "dash", "doas", "env",
        "eval", "exec", "fish", "ionice", "ksh", "nice", "nohup", "powershell", "pwsh", "runas",
        "setsid", "sh", "ssh", "scp", "start", "stdbuf", "su", "sudo", "taskset", "tcsh", "time",
        "timeout", "watch", "wsl", "xargs", "zsh",
        "bun", "cscript", "deno", "java", "lua", "mshta", "node", "nodejs", "osascript", "perl",
        "php", "py", "python", "python3", "pythonw", "regsvr32", "rscript", "ruby", "rundll32",
        "ts-node", "tsx", "wscript",
    }
)
RUNNER_SUBCOMMANDS = frozenset({"run", "exec", "x", "dlx", "tool"})
_PROGRAM_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]*")
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9:_-]*")
_EXECUTABLE_SUFFIX_RE = re.compile(r"\.(?:exe|cmd|bat|com)\Z", re.IGNORECASE)
# A versioned interpreter (python3.12, node20, perl5) is still that interpreter.
_VERSION_SUFFIX_RE = re.compile(r"[0-9.]+\Z")
_TRIM_CHARACTERS = " \t\n\r\v\f"
_SEPARATORS = frozenset(" \t")


@dataclass(frozen=True, slots=True)
class CommandScope:
    """``scope`` is ``"prefix"``, ``"exact"`` or ``"none"``."""

    scope: str
    prefix: str | None = None
    command: str | None = None


_NONE = CommandScope(scope="none")


_FIRST_PRINTABLE = 0x20
_DELETE = 0x7F


def _is_control_character(character: str) -> bool:
    code = ord(character)
    return (code < _FIRST_PRINTABLE and character != "\t") or code == _DELETE


def _tokenize(text: str) -> list[str] | None:
    tokens: list[str] = []
    current: list[str] = []
    in_token = False
    quote = ""
    for character in text:
        if quote:
            if character == quote:
                quote = ""
            else:
                current.append(character)
        elif character in {'"', "'"}:
            quote = character
            in_token = True
        elif character in _SEPARATORS:
            if in_token:
                tokens.append("".join(current))
            current = []
            in_token = False
        else:
            current.append(character)
            in_token = True
    if quote:
        return None
    if in_token:
        tokens.append("".join(current))
    return tokens


def _analyze(command: object) -> tuple[str, list[str]] | None:
    """The pre-checks every derivation and match runs; ``None`` = once only."""
    if not isinstance(command, str):
        return None
    text = command.strip(_TRIM_CHARACTERS)
    if not text or len(text) > MAX_COMMAND_CHARS:
        return None
    for character in text:
        if character in _UNSCOPED_CHARACTERS or _is_control_character(character):
            return None
    tokens = _tokenize(text)
    if not tokens:
        return None
    return text, tokens


def _normalize_program(token: str) -> str | None:
    if _PROGRAM_RE.fullmatch(token) is None:
        return None
    return _EXECUTABLE_SUFFIX_RE.sub("", token.lower())


def _is_wrapper_program(program: str) -> bool:
    return program in WRAPPER_PROGRAMS or _VERSION_SUFFIX_RE.sub("", program) in WRAPPER_PROGRAMS


def _is_word(token: str | None) -> bool:
    return token is not None and _WORD_RE.fullmatch(token) is not None


def _prefix_tokens(tokens: list[str]) -> list[str] | None:
    program = _normalize_program(tokens[0])
    if not program or _is_wrapper_program(program):
        return None
    subcommand = tokens[1] if len(tokens) > 1 else None
    if subcommand is None or not _is_word(subcommand):
        return None
    if subcommand not in RUNNER_SUBCOMMANDS:
        return [program, subcommand]
    target = tokens[2] if len(tokens) > 2 else None  # noqa: PLR2004 - token index
    # `uv tool run X` would make the runner itself the saved target.
    if target is None or not _is_word(target) or target in RUNNER_SUBCOMMANDS:
        return None
    return [program, subcommand, target]


def derive_command_scope(command: object) -> CommandScope:
    analyzed = _analyze(command)
    if analyzed is None:
        return _NONE
    text, tokens = analyzed
    prefix = _prefix_tokens(tokens)
    if prefix is None:
        return CommandScope(scope="exact", command=text)
    return CommandScope(scope="prefix", prefix=" ".join(prefix))


def is_canonical_command_prefix(value: object) -> bool:
    """A stored prefix is valid only when it is its own derivation."""
    if not isinstance(value, str):
        return False
    derived = derive_command_scope(value)
    return derived.scope == "prefix" and derived.prefix == value


def is_canonical_command_exact(value: object) -> bool:
    return (
        isinstance(value, str)
        and derive_command_scope(value).scope != "none"
        and value.strip(_TRIM_CHARACTERS) == value
    )


def command_matches_prefix(command: object, prefix: object) -> bool:
    if not isinstance(prefix, str) or not is_canonical_command_prefix(prefix):
        return False
    analyzed = _analyze(command)
    if analyzed is None:
        return False
    _text, tokens = analyzed
    expected = prefix.split(" ")
    if len(tokens) < len(expected) or _normalize_program(tokens[0]) != expected[0]:
        return False
    return tokens[1 : len(expected)] == expected[1:]


def command_matches_exact(command: object, exact: object) -> bool:
    if not is_canonical_command_exact(exact):
        return False
    analyzed = _analyze(command)
    return analyzed is not None and analyzed[0] == exact
