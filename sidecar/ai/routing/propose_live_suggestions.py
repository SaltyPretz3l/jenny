"""Trusted live-suggestion context for ``propose_change`` (Plan Plus C2).

The router injects it as the private ``_jenny_live_suggestions`` argument, the
same way ``inject_tool_attribution`` adds private fields: Electron's list of
the session's live suggestions plus the successful ``propose_change`` calls
already made in this request. The tool reads it for the overlap rule and the
per-request bounds. A model-supplied value never survives: every ``_jenny_*``
argument is stripped before injection.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

PROPOSE_CHANGE_TOOL = "propose_change"
# The same key as propose_suggestion.LIVE_SUGGESTIONS_ARG (the tool side owns it;
# routing keeps a copy so it does not import a builtin handler module).
LIVE_SUGGESTIONS_ARG = "_jenny_live_suggestions"
_ENTRY_KEYS = ("id", "path", "kind", "old_string")


def _session_entry(value: object) -> dict[str, str] | None:
    if not isinstance(value, Mapping):
        return None
    entry = {key: value.get(key) for key in _ENTRY_KEYS}
    if not all(isinstance(item, str) for item in entry.values()):
        return None
    return {key: str(item) for key, item in entry.items()}


def _recorded_suggestion(outcome: Any) -> dict[str, Any] | None:
    if getattr(outcome, "tool_name", "") != PROPOSE_CHANGE_TOOL:
        return None
    if getattr(outcome, "success", False) is not True:
        return None
    metadata = getattr(outcome, "metadata", None)
    record = metadata.get("suggested_change") if isinstance(metadata, dict) else None
    if not isinstance(record, dict) or not isinstance(record.get("path"), str):
        return None
    return record


def build_live_suggestions(
    session_entries: Iterable[object],
    outcomes: Iterable[Any],
) -> dict[str, object]:
    """``{live, request_count, request_paths}`` for one ``propose_change`` call.

    A suggestion recorded in this request that ``revises`` a live one replaces
    it; this request's suggestions use their tool call id as their id.
    """
    live = [entry for value in session_entries if (entry := _session_entry(value))]
    request_count = 0
    request_paths: list[str] = []
    for outcome in outcomes:
        record = _recorded_suggestion(outcome)
        if record is None:
            continue
        request_count += 1
        path = str(record["path"])
        if path not in request_paths:
            request_paths.append(path)
        revises = record.get("revises")
        call_id = str(getattr(outcome, "call_id", "") or f"request_suggestion_{request_count}")
        # A revision keeps the id it revised (Electron keeps it too), so a second
        # revise of the same suggestion in this request names the same id.
        entry_id = call_id
        if isinstance(revises, str) and revises:
            if any(entry["id"] == revises for entry in live):
                entry_id = revises
            live = [entry for entry in live if entry["id"] != revises]
        live.append({
            "id": entry_id,
            "path": path,
            "kind": str(record.get("kind") or ""),
            "old_string": str(record.get("old_string") or ""),
        })
    return {"live": live, "request_count": request_count, "request_paths": request_paths}


def live_suggestion_arguments(
    tool_name: str,
    request_context: Any | None,
    request_outcomes: Iterable[Any] | None,
) -> dict[str, object]:
    """The private argument to inject for a ``propose_change`` call; ``{}`` for any other."""
    if tool_name != PROPOSE_CHANGE_TOOL:
        return {}
    return {
        LIVE_SUGGESTIONS_ARG: build_live_suggestions(
            getattr(request_context, "suggested_changes_context", None) or (),
            request_outcomes or (),
        )
    }


__all__ = (
    "LIVE_SUGGESTIONS_ARG",
    "PROPOSE_CHANGE_TOOL",
    "build_live_suggestions",
    "live_suggestion_arguments",
)
