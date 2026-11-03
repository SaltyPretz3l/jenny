"""Find a skill the user named mid-message with ``/<command>``.

Electron sets ``skill_invocation`` only when the message starts with the slash
command. "Please /po-review the composer" names the skill too; without this the
model searched the repository for the command text instead of applying it.
A mention is a ``/`` at the start of the text or after whitespace, an opening
bracket or a quote, followed by a known command (case-insensitive) that ends at
whitespace, punctuation (a period or colon only when whitespace or the end
follows) or the end of the text. Code spans and fenced code
blocks never count.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import TypeVar

T = TypeVar("T")

# Mentions past this point are not worth a scan of every pasted log.
MAX_MENTION_SCAN_CHARS = 20_000
_FENCED_CODE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]*\1[^\n]*$|\Z)", re.M | re.S)
_INLINE_CODE_RE = re.compile(r"(`+)(?!`).+?(?<!`)\1(?!`)", re.S)
# Code is masked with a character that is neither an opener nor a terminator,
# so a command touching a code span is not a mention either.
_MASK = "\x00"
_OPENERS = "\\s([{<\"'\u201c\u2018\u00ab"
_TERMINATORS = "\\s.,;:!?)\\]}>\"'\u201d\u2019\u00bb"


def _mask(match: re.Match[str]) -> str:
    return _MASK * len(match.group(0))


def _searchable(text: str) -> str:
    bounded = text[:MAX_MENTION_SCAN_CHARS]
    return _INLINE_CODE_RE.sub(_mask, _FENCED_CODE_RE.sub(_mask, bounded))


# One pass over the text: each "/" after an opener, then the run of command
# characters up to a terminator. Openers never occur inside a command, so a
# token stops before one and a later mention is still found.
# "." and ":" end a mention only as punctuation, so /build.gradle is a path.
_HARD_TERMINATORS = _TERMINATORS.replace(".", "").replace(":", "")
_MENTION_RE = re.compile(
    rf"(?:^|(?<=[{_OPENERS}]))/([^{_TERMINATORS}{_OPENERS}{_MASK}]+)"
    rf"(?=$|[{_HARD_TERMINATORS}]|[.:](?=$|[{_HARD_TERMINATORS}]))"
)


def find_skill_mention(text: str, candidates: Iterable[tuple[str, T]]) -> T | None:
    """The value paired with the earliest ``/<command>`` mention in *text*, else ``None``."""
    if "/" not in (text or ""):
        return None
    by_command: dict[str, T] = {}
    for command, value in candidates:
        normalized = str(command or "").strip().lstrip("/").casefold()
        if normalized:
            by_command.setdefault(normalized, value)
    if not by_command:
        return None
    for match in _MENTION_RE.finditer(_searchable(text)):
        token = match.group(1).casefold()
        if token in by_command:
            return by_command[token]
    return None


def latest_user_text(history: Sequence[Mapping[str, object]]) -> str:
    """The text of the last user row in *history* (string or text parts), else ``""``."""
    for message in reversed(history or ()):
        if str(message.get("role") or "") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                str(part.get("text") or "")
                for part in content
                if isinstance(part, Mapping) and part.get("type") == "text"
            )
        return ""
    return ""
