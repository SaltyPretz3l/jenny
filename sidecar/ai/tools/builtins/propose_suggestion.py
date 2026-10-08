"""Rules and the record for one ``propose_change`` suggestion (Plan Plus C2).

Pure: no filesystem access. The handler in ``propose_change.py`` reads the file;
this module bounds the request, checks overlap with live suggestions, validates
the match with edit_file's own matching, trims the plain-words fields and builds
the ``suggested_change`` v1 record Electron stores.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from sidecar.ai.tools.builtins.edit_matching import (
    _dominant_newline,
    _fold_edits,
    _FoldContext,
    _normalize_newlines,
    _render_with_newlines,
)

# propose_facts is the base module (path keys, derived facts); this one re-exports
# derive_import_facts so propose_change keeps one import for the suggestion rules.
from sidecar.ai.tools.builtins.propose_facts import derive_import_facts, path_key
from sidecar.ai.tools.builtins.structured_diff import compute_structured_diff, sha256_text
from sidecar.ai.tools.contracts import ToolHandlerResult

SUGGESTED_CHANGE_SCHEMA_VERSION = 1
# Router-injected private argument: the live suggestions this call must not
# overlap, plus this request's own suggestion count and paths for the bounds.
LIVE_SUGGESTIONS_ARG = "_jenny_live_suggestions"
MAX_SUGGESTIONS_PER_REQUEST = 10
MAX_FILES_PER_REQUEST = 5
# Electron stores suggestions in the session record, so they stay small.
MAX_SUGGESTION_STRING_CHARS = 262_144
MAX_LIVE_SUGGESTIONS = 50 + MAX_SUGGESTIONS_PER_REQUEST
MAX_OVERLAP_SCAN = 1_000
TITLE_MAX_CHARS = 80
EXPLANATION_MAX_CHARS = 400
WATCH_FOR_MAX_CHARS = 240
SUGGESTION_KINDS = frozenset({"create", "replace"})

RECORDED_TEXT = "Suggested change recorded (not applied; the file is unchanged)."
TOO_LARGE_TEXT = "This change is too large to suggest; split it into smaller suggestions."
ONE_CHANGE_TEXT = (
    "propose_change takes one change: path, kind, old_string and new_string. There is no "
    "replace_all or edits list; suggest each change separately, with enough context in "
    "old_string to match exactly once."
)
_UNCHANGED_NOTE = "Suggested changes are not applied: the file on disk is unchanged."
_REVISES_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
# A group label the model picks for changes that must apply together (W3).
_GROUP_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,39}\Z")
MAX_DEPENDS_ON = 10
_SENTENCE_BREAK = re.compile(r"(?<=[.!?…])\s+")


@dataclass(frozen=True)
class LiveSuggestion:
    id: str
    path: str
    kind: str
    old_string: str


@dataclass(frozen=True)
class LiveContext:
    live: tuple[LiveSuggestion, ...] = ()
    request_count: int = 0
    request_paths: frozenset[str] = frozenset()


def trim_plain_text(value: object, *, max_chars: int, max_sentences: int | None = None) -> str:
    """Bound a plain-words field: whole sentences first, then a word-boundary cut with "…".

    Missing or non-text values become "" so the UI can say Jenny didn't explain
    the change; text is never invented and never refused for length.
    """
    if not isinstance(value, str):
        return ""
    text = " ".join(value.split())
    if not text:
        return ""
    if max_sentences is not None:
        sentences = _SENTENCE_BREAK.split(text)
        if len(sentences) > max_sentences:
            text = " ".join(sentences[:max_sentences])
    if len(text) <= max_chars:
        return text
    cut = text[: max_chars - 1]
    space = cut.rfind(" ")
    if space > 0:
        cut = cut[:space]
    return cut.rstrip(" ,;:-") + "…"


def plain_words(arguments: dict[str, object]) -> dict[str, str]:
    return {
        "title": trim_plain_text(arguments.get("title"), max_chars=TITLE_MAX_CHARS),
        "what": trim_plain_text(
            arguments.get("what"), max_chars=EXPLANATION_MAX_CHARS, max_sentences=2
        ),
        "why": trim_plain_text(
            arguments.get("why"), max_chars=EXPLANATION_MAX_CHARS, max_sentences=2
        ),
        "watch_for": trim_plain_text(
            arguments.get("watch_for"), max_chars=WATCH_FOR_MAX_CHARS, max_sentences=1
        ),
    }


def valid_revises(value: object) -> bool:
    return value is None or (isinstance(value, str) and _REVISES_RE.match(value) is not None)


def valid_group(value: object) -> bool:
    return value is None or (isinstance(value, str) and _GROUP_RE.match(value) is not None)


def valid_depends_on(value: object) -> bool:
    """None, or up to MAX_DEPENDS_ON suggestion ids (or same-turn tool call ids)."""
    if value is None:
        return True
    return (
        isinstance(value, list)
        and len(value) <= MAX_DEPENDS_ON
        and all(isinstance(item, str) and _REVISES_RE.match(item) is not None for item in value)
    )


def parse_live_context(value: object) -> LiveContext:
    """Read the router-injected context; anything malformed counts as empty."""
    if not isinstance(value, dict):
        return LiveContext()
    raw_live = value.get("live")
    live: list[LiveSuggestion] = []
    for item in raw_live if isinstance(raw_live, list) else []:
        if len(live) >= MAX_LIVE_SUGGESTIONS:
            break
        if not isinstance(item, dict):
            continue
        entry_id, path, kind, old = (item.get(key) for key in ("id", "path", "kind", "old_string"))
        if (
            isinstance(entry_id, str) and entry_id and isinstance(path, str) and path
            and kind in SUGGESTION_KINDS and isinstance(old, str)
        ):
            live.append(LiveSuggestion(entry_id, path, str(kind), old))
    raw_count = value.get("request_count")
    raw_paths = value.get("request_paths")
    return LiveContext(
        live=tuple(live),
        request_count=raw_count if isinstance(raw_count, int) and raw_count > 0 else 0,
        request_paths=frozenset(
            path_key(item) for item in (raw_paths if isinstance(raw_paths, list) else [])
            if isinstance(item, str) and item
        ),
    )


def batch_refusal(context: LiveContext, relative_path: str) -> str | None:
    if context.request_count >= MAX_SUGGESTIONS_PER_REQUEST:
        return (
            f"Suggestion limit reached: at most {MAX_SUGGESTIONS_PER_REQUEST} suggestions per "
            "request. Stop proposing and summarize the suggestions you recorded for the user."
        )
    key = path_key(relative_path)
    if key not in context.request_paths and len(context.request_paths) >= MAX_FILES_PER_REQUEST:
        return (
            f"File limit reached: suggestions in one request may touch at most "
            f"{MAX_FILES_PER_REQUEST} files. Stop proposing and summarize the suggestions you "
            "recorded; changes to other files can follow in a later turn."
        )
    return None


def _overlap_message(entry_id: str) -> str:
    return (
        f"This change overlaps suggestion {entry_id}, which is still waiting for review. "
        f'To change that region again, call propose_change with revises="{entry_id}" and one '
        f"old_string that covers both changes. {_UNCHANGED_NOTE}"
    )


def _regions_intersect(content: str, other: str, start: int, end: int) -> bool:
    position = content.find(other)
    scanned = 0
    while position != -1 and scanned < MAX_OVERLAP_SCAN:
        if position < end and start < position + len(other):
            return True
        position = content.find(other, position + 1)
        scanned += 1
    return False


def overlap_refusal(  # noqa: PLR0913 - explicit region context.
    context: LiveContext,
    *,
    kind: str,
    relative_path: str,
    revises: str | None,
    content: str = "",
    old_string: str = "",
) -> str | None:
    """Refuse a change whose region intersects a live suggestion it does not revise.

    Matching runs on LF-normalized text, as edit_file matches. A live suggestion
    whose text no longer occurs in the file has no region and never overlaps.
    """
    key = path_key(relative_path)
    content, old_string = _normalize_newlines(content), _normalize_newlines(old_string)
    start = content.find(old_string) if kind == "replace" else -1
    end = start + len(old_string)
    for entry in context.live:
        if entry.id == revises or entry.kind != kind or path_key(entry.path) != key:
            continue
        if kind == "create":
            return _overlap_message(entry.id)
        other = _normalize_newlines(entry.old_string)
        if other and start >= 0 and _regions_intersect(content, other, start, end):
            return _overlap_message(entry.id)
    return None


def match_replace(
    file_text: str,
    old_string: str,
    new_string: str,
    *,
    relative_path: str,
    max_bytes: int,
) -> str | ToolHandlerResult:
    """Return the rendered new file text, or edit_file's failure in suggestion wording."""
    newline_style = _dominant_newline(file_text)
    folded = _fold_edits(
        ((old_string, new_string, False),),
        content=_normalize_newlines(file_text),
        context=_FoldContext(
            relative_path=relative_path,
            newline_style=newline_style,
            max_final_bytes=max_bytes,
            name_failures=False,
            suggestion_mode=True,
        ),
    )
    if isinstance(folded, ToolHandlerResult):
        return folded
    return _render_with_newlines(folded[0], newline_style)


def build_suggestion_record(  # noqa: PLR0913 - one explicit field per record key.
    *,
    relative_path: str,
    kind: str,
    old_string: str,
    new_string: str,
    texts: dict[str, str],
    revises: str | None,
    old_text: str,
    new_text: str,
    group: str | None = None,
    depends_on: tuple[str, ...] = (),
    facts: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """``suggested_change`` v1. ``diff`` is computed only: no pre-change snapshot is taken."""
    created = kind == "create"
    return {
        "schema_version": SUGGESTED_CHANGE_SCHEMA_VERSION,
        "path": relative_path,
        "kind": kind,
        "old_string": old_string,
        "new_string": new_string,
        "title": texts["title"],
        "what": texts["what"],
        "why": texts["why"],
        "watch_for": texts["watch_for"],
        "revises": revises,
        "group": group,
        "depends_on": list(dict.fromkeys(depends_on)),
        "facts": list(facts or []),
        "base_hash": None if created else sha256_text(_normalize_newlines(old_text)),
        "diff": compute_structured_diff(
            relative_path,
            old_text,
            new_text,
            status="created" if created else "modified",
        ),
    }


__all__ = (
    "LIVE_SUGGESTIONS_ARG",
    "MAX_DEPENDS_ON",
    "MAX_FILES_PER_REQUEST",
    "MAX_SUGGESTIONS_PER_REQUEST",
    "MAX_SUGGESTION_STRING_CHARS",
    "ONE_CHANGE_TEXT",
    "RECORDED_TEXT",
    "SUGGESTED_CHANGE_SCHEMA_VERSION",
    "SUGGESTION_KINDS",
    "TOO_LARGE_TEXT",
    "LiveContext",
    "LiveSuggestion",
    "batch_refusal",
    "build_suggestion_record",
    "derive_import_facts",
    "match_replace",
    "overlap_refusal",
    "parse_live_context",
    "path_key",
    "plain_words",
    "trim_plain_text",
    "valid_depends_on",
    "valid_group",
    "valid_revises",
)
