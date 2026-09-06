"""ChatGPT plan-usage rolling-window snapshot: parse, stash, republish.

The ChatGPT/Codex backend answers every ``/responses`` call (200 **and**
429) with an ``x-codex-*`` header family describing how much of the plan's
rolling usage windows have been consumed. Engines have no notification
channel of their own (only the tool loop can call ``runtime.emit_safe``), so
this module uses the request-scoped ``ContextVar`` binding in
``sidecar.runtime.local_engine.request_context`` as the engine -> runtime
side channel: :func:`record_plan_usage_snapshot` is called from inside the
engine's HTTP hook and stashes a scrubbed snapshot into the current request
context; :func:`attach_plan_usage` is called later from the runtime layer
(``chat_decision_render.py`` / ``chat_streaming.py``) to copy that snapshot
onto the outgoing ``chat.done``/``chat.error`` payload.

Security/robustness posture mirrors the existing usage-meter scrubs: only
numbers, bools, and one bounded enum leave the header parse -- never raw
provider text. Malformed input drops the affected window (or the whole
snapshot); parsing and stashing never raise, because a meter reading must
never break inference.

Imports only ``sidecar.runtime.*`` (never ``sidecar.ai.*``) to stay clear of
the ``sidecar/ai`` leaf import fan-out budget and keep the dependency
direction the same one every other engine-adjacent runtime hint (e.g.
``attach_context_window``) already uses.
"""

from __future__ import annotations

import copy
import logging
import math
from datetime import datetime, timezone
from typing import Any, Mapping

from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.local_engine.request_context import current_request_context

PLAN_USAGE_SCHEMA_VERSION = 1
PLAN_USAGE_CONTEXT_KEY = "plan_usage"

_RESET_AT_MIN_EPOCH_SECONDS = 1_000_000_000
_RESET_AT_MAX_EPOCH_SECONDS = 9_007_199_254_740_991
_WINDOW_MINUTES_MIN = 1
_WINDOW_MINUTES_MAX = 1_051_200
_REACHED_TYPE_ALLOWLIST = frozenset({"primary", "secondary"})
_HEADER_VALUE_MAX_CHARS = 64

_logger = logging.getLogger(__name__)

_WINDOW_HEADER_NAMES: dict[str, dict[str, str]] = {
    "primary": {
        "used_percent": "x-codex-primary-used-percent",
        "window_minutes": "x-codex-primary-window-minutes",
        "reset_at": "x-codex-primary-reset-at",
    },
    "secondary": {
        "used_percent": "x-codex-secondary-used-percent",
        "window_minutes": "x-codex-secondary-window-minutes",
        "reset_at": "x-codex-secondary-reset-at",
    },
}
_REACHED_TYPE_HEADER = "x-codex-rate-limit-reached-type"


def _header_get(headers: Any, name: str) -> str | None:
    """Read one header, coerced+bounded, from either httpx headers or a dict.

    httpx's ``Headers`` object is case-insensitive on ``.get``; test fakes
    (and any other case-sensitive mapping) are handled with a lowercase-key
    fallback scan.
    """
    if headers is None:
        return None
    getter = getattr(headers, "get", None)
    if callable(getter):
        try:
            value = getter(name)
        except Exception:  # noqa: BLE001 -- a hostile header getter must not break parsing
            value = None
        if value is not None:
            return str(value)[:_HEADER_VALUE_MAX_CHARS]
    if isinstance(headers, Mapping):
        target = name.lower()
        for key, value in headers.items():
            if isinstance(key, str) and key.lower() == target and value is not None:
                return str(value)[:_HEADER_VALUE_MAX_CHARS]
    return None


def _parse_used_percent(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):  # NaN / +-inf
        return None
    return round(max(0.0, min(100.0, value)), 1)


def _parse_window_minutes(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        value = int(float(raw))
    except (TypeError, ValueError, OverflowError):  # inf -> OverflowError
        return None
    if not (_WINDOW_MINUTES_MIN <= value <= _WINDOW_MINUTES_MAX):
        return None
    return value


def _parse_reset_at(raw: str | None) -> int | None:
    if raw is None:
        return None
    value: float | None = None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        text = raw.strip()
        if text[-1:] in ("Z", "z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except (TypeError, ValueError):
            return None
        if parsed.tzinfo is None:
            # A naive ISO stamp is UTC by provider convention; .timestamp() on
            # a naive datetime would read it in the host's local zone.
            parsed = parsed.replace(tzinfo=timezone.utc)
        value = parsed.timestamp()
    if value is None or not math.isfinite(value):
        return None
    epoch_seconds = int(value)
    if not (_RESET_AT_MIN_EPOCH_SECONDS <= epoch_seconds <= _RESET_AT_MAX_EPOCH_SECONDS):
        return None
    return epoch_seconds


def _parse_window(headers: Any, names: dict[str, str]) -> dict[str, Any] | None:
    used_percent = _parse_used_percent(_header_get(headers, names["used_percent"]))
    if used_percent is None:
        return None
    reset_at = _parse_reset_at(_header_get(headers, names["reset_at"]))
    if reset_at is None:
        return None
    window: dict[str, Any] = {"used_percent": used_percent, "reset_at": reset_at}
    window_minutes = _parse_window_minutes(_header_get(headers, names["window_minutes"]))
    if window_minutes is not None:
        window["window_minutes"] = window_minutes
    return window


def _parse_reached_type(headers: Any) -> str | None:
    raw = _header_get(headers, _REACHED_TYPE_HEADER)
    if raw is None:
        return None
    value = raw.strip().lower()
    if value not in _REACHED_TYPE_ALLOWLIST:
        return None
    return value


def parse_plan_usage_headers(response: Any) -> dict[str, Any] | None:
    """Parse the ``x-codex-*`` plan-usage header family off a response.

    Returns ``None`` when neither window parses (nothing to show); otherwise
    a fixed-key snapshot dict (``schema_version`` plus whichever of
    ``primary``/``secondary``/``rate_limit_reached_type`` are present and
    valid). Never raises -- an unexpected header shape degrades to a dropped
    window/snapshot, not an exception.
    """
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    primary = _parse_window(headers, _WINDOW_HEADER_NAMES["primary"])
    secondary = _parse_window(headers, _WINDOW_HEADER_NAMES["secondary"])
    if primary is None and secondary is None:
        return None
    snapshot: dict[str, Any] = {"schema_version": PLAN_USAGE_SCHEMA_VERSION}
    if primary is not None:
        snapshot["primary"] = primary
    if secondary is not None:
        snapshot["secondary"] = secondary
    reached_type = _parse_reached_type(headers)
    if reached_type is not None:
        snapshot["rate_limit_reached_type"] = reached_type
    return snapshot


def record_plan_usage_snapshot(engine: Any, response: Any) -> None:
    """Parse ``response`` headers and stash the snapshot on the current request.

    Called from the engine's HTTP hook, before the initial-status raise, so
    both a 200 and a 429 response share this capture. Silently does nothing
    when there is no bound request context (e.g. a direct ``engine.generate()``
    call outside a ``chat.send`` turn) or when no window parses. Wrapped so a
    meter reading can never break inference.
    """
    try:
        snapshot = parse_plan_usage_headers(response)
        if snapshot is None:
            return
        context = current_request_context(engine)
        if context is None:
            return
        context[PLAN_USAGE_CONTEXT_KEY] = snapshot
        log_event(
            _logger,
            logging.DEBUG,
            component="ai.engine.chatgpt",
            event="chatgpt.plan_usage_headers",
            message="Captured ChatGPT plan-usage headers",
            data=snapshot,
        )
    except Exception:  # noqa: BLE001 -- a meter reading must never break inference
        return


def read_plan_usage_snapshot(engine: Any) -> dict[str, Any] | None:
    """Return the stashed snapshot for the current request, if any."""
    context = current_request_context(engine)
    if context is None:
        return None
    snapshot = context.get(PLAN_USAGE_CONTEXT_KEY)
    if not isinstance(snapshot, dict):
        return None
    return snapshot


def attach_plan_usage(payload: dict[str, Any], engine: Any, *, enabled: bool) -> None:
    """Copy the stashed plan-usage snapshot onto ``payload`` when enabled.

    A deep copy, never an alias -- the caller's payload must not be able to
    mutate the request-context stash (or vice versa). Sets nothing when the
    flag is off or there is no snapshot, so the wire key is omitted entirely
    rather than published as ``null``.
    """
    if not enabled or not isinstance(payload, dict):
        return
    snapshot = read_plan_usage_snapshot(engine)
    if not snapshot:
        return
    payload[PLAN_USAGE_CONTEXT_KEY] = copy.deepcopy(snapshot)
