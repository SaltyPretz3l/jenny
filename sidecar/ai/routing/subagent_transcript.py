"""Bounded, UI-only transcript of one subagent child (row 67).

A pure recorder: no I/O and no lock of its own (``SubagentLiveActivity`` calls
it under its lock). Entries ride only in ``child_activity`` frames and the
terminal report metadata, never in the parent model's tool output.
"""

from __future__ import annotations

import json
import math
import re
import time
from typing import Any, Callable

from sidecar.ai.routing.delegate_child_steps import _step_text, scrub_failed_paths
from sidecar.ai.routing.delegate_contracts import DELEGATE_TOOL_NAME, strip_format_controls
from sidecar.ai.tools.catalog import tool_display_name
from sidecar.ai.tools.sanitization import sanitize_tool_output_no_truncate

MAX_TRANSCRIPT_ENTRIES = 80
# Shared by every text, input and output field of one child.
MAX_TRANSCRIPT_CHARS = 24_000
MAX_TRANSCRIPT_TEXT_CHARS = 1_500
MAX_TRANSCRIPT_INPUT_CHARS = 1_000
MAX_TRANSCRIPT_OUTPUT_CHARS = 2_000
_MAX_CALL_ID_CHARS = 200
_MAX_NAME_CHARS = 64
# Streamed text and reasoning are held raw up to this multiple of the field
# cap, since redaction can shrink text before the cut.
_RAW_SLACK = 4
_LAST_WORD_RE = re.compile(r"\s\S*\Z")
_KEEP_PATHS = object()


def _cut_raw(text: str, limit: int) -> str:
    """Cut raw text before it is sanitized. A fragment too short for the
    redactor to recognise must not survive: the last word goes, and so does a
    PEM block whose END marker the cut removed."""

    text = text[:limit]
    last_word = _LAST_WORD_RE.search(text)
    text = text[: last_word.start()] if last_word else text
    begin = text.rfind("-----BEGIN")
    if begin != -1 and "-----END" not in text[begin:]:
        text = text[:begin]
    return text


class _RawText:
    """Raw streamed text, bounded before it is sanitized."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self.text = ""
        self.overflow = False

    def add(self, delta: str) -> None:
        room = self._limit - len(self.text)
        self.overflow |= len(delta) > room
        self.text += delta[: max(0, room)]

    def take(self) -> tuple[str, bool]:
        text, overflow = self.text, self.overflow
        if overflow:
            text = _cut_raw(text, len(text))
        self.text, self.overflow = "", False
        return text, overflow


class ChildTranscript:
    """Ordered thought / text / tool entries under entry and character caps."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self.version = 0
        self.dropped = 0
        self._entries: list[dict[str, Any]] = []
        self._budget = MAX_TRANSCRIPT_CHARS
        self._pending = _RawText(MAX_TRANSCRIPT_TEXT_CHARS * _RAW_SLACK)
        self._thought_text = _RawText(MAX_TRANSCRIPT_TEXT_CHARS * _RAW_SLACK)
        self._thinking_id: str | None = None
        self._thought: dict[str, Any] | None = None
        self._thought_started = 0.0
        # call_id -> entry, or None when the entry was dropped at the cap.
        self._calls: dict[str, dict[str, Any] | None] = {}
        self._arguments: dict[str, dict[str, Any]] = {}

    def entries(self) -> list[dict[str, Any]]:
        return [dict(entry) for entry in self._entries]

    def text_delta(self, delta: str) -> None:
        if not delta:
            return
        self._end_thought()
        self._pending.add(delta)

    def reset(self, *, keep_text: bool) -> None:
        """A ``tool_continuation`` reset keeps the note; a retry discards it."""

        self._end_thought()
        if keep_text:
            self._commit_text()
        else:
            self._pending.take()

    def reasoning(self, thinking_id: object, delta: str) -> None:
        if not delta:
            return
        key = str(thinking_id or "")
        if self._thinking_id is not None and key != self._thinking_id:
            self._end_thought()
        if self._thinking_id is None:
            self._commit_text()
            self._thinking_id = key
            self._thought_started = self._clock()
            self._thought = None
            if self._has_room():
                self._thought = self._add({"kind": "thought", "text": "", "live": True})
        self._thought_text.add(delta)

    def tool_started(self, call_id: object, tool_name: object, arguments: object) -> None:
        self._end_thought()
        self._commit_text()
        key = str(call_id or "")
        if key in self._calls:
            return
        if not self._has_room():
            self._calls[key] = None
            return
        entry = self._calls[key] = self._add(_tool_entry(key, tool_name))
        if isinstance(arguments, dict) and arguments:
            # The call may yet be refused for naming a path outside the
            # workspace, so a running call's input is path-scrubbed.
            self._arguments[key] = arguments
            self._set_input(entry, arguments, scrub=True)

    def tool_finished(  # noqa: PLR0913 - mirrors the ToolResultEvent fields.
        self,
        call_id: object,
        *,
        tool_name: object,
        success: object,
        content: object,
        tool_input: object,
        error_code: object = None,
        duration_ms: object = None,
    ) -> None:
        self._end_thought()
        self._commit_text()
        key = str(call_id or "")
        if key in self._calls:
            entry = self._calls[key]
            if entry is None or entry["status"] != "running":
                return
        elif not self._has_room():
            self._calls[key] = None
            return
        else:
            entry = self._calls[key] = self._add(_tool_entry(key, tool_name))
        failed = success is not True
        entry["status"] = "failed" if failed else "completed"
        started_arguments = self._arguments.pop(key, None)
        shown = started_arguments or (tool_input if isinstance(tool_input, dict) else None)
        if shown:
            # Settled: an admitted call shows its real paths, a refused one
            # stays scrubbed. The running input's budget is returned first.
            self._budget += len(entry.pop("input", ""))
            entry.pop("input_truncated", None)
            self._set_input(entry, shown, scrub=failed)
        scrub = (tool_input or shown or {}) if failed else _KEEP_PATHS
        output, full_chars, cut = self._field(content, MAX_TRANSCRIPT_OUTPUT_CHARS, scrub=scrub)
        if output:
            entry["output"] = output
        if cut:
            entry["output_chars"] = full_chars
        code = _step_text(error_code, _MAX_NAME_CHARS) if error_code else ""
        if code:
            entry["error_code"] = code
        if (
            isinstance(duration_ms, (int, float))
            and not isinstance(duration_ms, bool)
            and math.isfinite(duration_ms)
            and duration_ms >= 0
        ):
            entry["ms"] = int(round(duration_ms))
        self.version += 1

    def finish(self) -> None:
        """Close a live thought and interrupt running tools; pending text is the answer."""

        self._end_thought()
        self._pending.take()
        for entry in self._calls.values():
            if entry is not None and entry["status"] == "running":
                entry["status"] = "interrupted"
                self.version += 1
        self._arguments.clear()

    def _has_room(self) -> bool:
        if len(self._entries) < MAX_TRANSCRIPT_ENTRIES:
            return True
        self.dropped += 1
        return False

    def _add(self, entry: dict[str, Any]) -> dict[str, Any]:
        self._entries.append(entry)
        self.version += 1
        return entry

    def _commit_text(self) -> None:
        raw, overflow = self._pending.take()
        if not raw.strip() or not self._has_room():
            return
        text, _full, cut = self._field(raw, MAX_TRANSCRIPT_TEXT_CHARS, strip=True)
        entry: dict[str, Any] = {"kind": "text", "text": text}
        if cut or overflow:
            entry["truncated"] = True
        self._add(entry)

    def _end_thought(self) -> None:
        if self._thinking_id is None:
            return
        raw, overflow = self._thought_text.take()
        entry, self._thought, self._thinking_id = self._thought, None, None
        if entry is None:
            return
        text, _full, cut = self._field(raw, MAX_TRANSCRIPT_TEXT_CHARS, strip=True)
        entry["text"] = text
        entry.pop("live", None)
        if cut or overflow:
            entry["truncated"] = True
        entry["ms"] = max(0, int(round((self._clock() - self._thought_started) * 1000)))
        self.version += 1

    def _set_input(self, entry: dict[str, Any], arguments: dict[str, Any], *, scrub: bool) -> None:
        try:
            raw = json.dumps(arguments, separators=(",", ":"), ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            return
        paths = arguments if scrub else _KEEP_PATHS
        text, _full, cut = self._field(raw, MAX_TRANSCRIPT_INPUT_CHARS, scrub=paths)
        if text:
            entry["input"] = text
        if cut:
            entry["input_truncated"] = True

    def _field(
        self, value: object, cap: int, *, scrub: object = _KEEP_PATHS, strip: bool = False,
    ) -> tuple[str, int, bool]:
        """Redact, scrub a failed call's paths, cut to the cap and the shared
        budget; returns the kept text, the full sanitized length and the cut."""

        # A huge tool output is cut before the sanitizer runs: it runs under
        # the live-activity lock on the child's loop thread.
        raw_chars = 0
        if isinstance(value, str) and len(value) > cap * _RAW_SLACK:
            raw_chars, value = len(value), _cut_raw(value, cap * _RAW_SLACK)
        full = sanitize_tool_output_no_truncate(value, tool_name=DELEGATE_TOOL_NAME)
        full = full.strip() if strip else full
        text = full if scrub is _KEEP_PATHS else scrub_failed_paths(full, scrub, max_chars=cap)
        limit = min(cap, self._budget)
        kept = strip_format_controls(text[:limit])
        self._budget -= len(kept)
        full_chars = raw_chars or len(full)
        return kept, full_chars, full_chars > cap or len(text) > limit


def _tool_entry(call_id: str, tool_name: object) -> dict[str, Any]:
    tool = _step_text(tool_name, _MAX_NAME_CHARS)
    return {
        "kind": "tool",
        "call_id": _step_text(call_id, _MAX_CALL_ID_CHARS),
        "tool": tool,
        "display": _step_text(tool_display_name(tool), _MAX_NAME_CHARS) or tool,
        "status": "running",
    }


__all__ = [
    "MAX_TRANSCRIPT_CHARS",
    "MAX_TRANSCRIPT_ENTRIES",
    "MAX_TRANSCRIPT_INPUT_CHARS",
    "MAX_TRANSCRIPT_OUTPUT_CHARS",
    "MAX_TRANSCRIPT_TEXT_CHARS",
    "ChildTranscript",
]
