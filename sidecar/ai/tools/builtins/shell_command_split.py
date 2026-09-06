"""Platform-aware compound-command splitting for shell classification.

Split out of ``shell_security`` so the classifier keeps its allowlists and
verdict logic in one file. This module owns exactly one job: cutting a raw
command string into the segments the active platform's shell would run as
separate commands, so a safe leading command cannot hide a riskier tail.

``cmd.exe`` treats a single ``&`` and CR/LF as command separators, escapes
with caret, and does not recognize single quotes as grouping. POSIX shells
recognize both quote styles and escape with backslash. Getting that grammar
exactly right is a security property, not a formatting nicety: every segment
is classified independently and the most restrictive verdict wins.
"""

from __future__ import annotations

import os

_SEPARATOR_CHARS = (";", "|", "&", "\r", "\n")


def _is_escaped(current: list[str], escape_char: str) -> bool:
    escape_count = 0
    for prior in reversed(current):
        if prior != escape_char:
            break
        escape_count += 1
    return escape_count % 2 == 1


def _double_quote_changes_state(
    current: list[str],
    escape_char: str,
    *,
    windows: bool,
    in_double: bool,
) -> bool:
    # cmd.exe treats caret as a literal inside double quotes, so it cannot
    # protect a closing quote. Outside quotes it can escape an opening quote.
    return (windows and in_double) or not _is_escaped(current, escape_char)


def _is_file_descriptor_redirect_ampersand(
    chars: str,
    index: int,
    current: list[str],
) -> bool:
    if index + 1 >= len(chars) or not chars[index + 1].isdigit():
        return False
    return (bool(current) and current[-1] in {">", "<"}) or chars[index + 1] in {"1", "2"}


def split_compound_command(command: str) -> list[str]:
    """Split shell command separators outside platform-appropriate quotes.

    ``cmd.exe`` treats single ``&`` and CR/LF as command separators and does
    not recognize single quotes as grouping. POSIX shells recognize both quote
    styles and use backslash rather than caret escaping. Classifying the exact
    platform grammar prevents a safe first command from hiding a riskier tail.
    """
    segments: list[str] = []
    current: list[str] = []
    in_single = False
    in_double = False
    windows = os.name == "nt"
    escape_char = "^" if windows else "\\"
    i = 0
    chars = command

    while i < len(chars):
        ch = chars[i]

        if (
            ch == "'"
            and not windows
            and not in_double
            and (in_single or not _is_escaped(current, escape_char))
        ):
            in_single = not in_single
            current.append(ch)
        elif (
            ch == '"'
            and not in_single
            and _double_quote_changes_state(
                current,
                escape_char,
                windows=windows,
                in_double=in_double,
            )
        ):
            in_double = not in_double
            current.append(ch)
        elif not in_single and not in_double:
            if ch in _SEPARATOR_CHARS and (
                _is_escaped(current, escape_char)
                or (ch == "&" and _is_file_descriptor_redirect_ampersand(chars, i, current))
            ):
                current.append(ch)
                i += 1
                continue
            two = chars[i : i + 2]
            if two in ("&&", "||"):
                seg = "".join(current).strip()
                if seg:
                    segments.append(seg)
                current = []
                i += 2
                continue
            if ch in _SEPARATOR_CHARS:
                seg = "".join(current).strip()
                if seg:
                    segments.append(seg)
                current = []
            else:
                current.append(ch)
        else:
            current.append(ch)
        i += 1

    tail = "".join(current).strip()
    if tail:
        segments.append(tail)

    return segments if segments else [command.strip()]
