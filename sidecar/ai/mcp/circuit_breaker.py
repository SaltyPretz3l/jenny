"""Bounded process-local circuit breaker for builtin tool phases."""

from __future__ import annotations

import threading
from collections import OrderedDict

BREAKER_FAILURE_THRESHOLD = 3
_MAX_FAILURE_KEYS = 1024
_FAILURE_COUNTS: OrderedDict[tuple[str, str], int] = OrderedDict()
_FAILURE_COUNTS_LOCK = threading.Lock()


def record_failure(tool_name: str, phase: str) -> None:
    key = (tool_name, phase)
    with _FAILURE_COUNTS_LOCK:
        if key not in _FAILURE_COUNTS and len(_FAILURE_COUNTS) >= _MAX_FAILURE_KEYS:
            _FAILURE_COUNTS.popitem(last=False)
        _FAILURE_COUNTS[key] = _FAILURE_COUNTS.get(key, 0) + 1


def record_success(tool_name: str, phase: str) -> None:
    with _FAILURE_COUNTS_LOCK:
        _FAILURE_COUNTS.pop((tool_name, phase), None)


def breaker_open_reason(tool_name: str, phase: str) -> str | None:
    with _FAILURE_COUNTS_LOCK:
        failure_count = _FAILURE_COUNTS.get((tool_name, phase), 0)
    if failure_count < BREAKER_FAILURE_THRESHOLD:
        return None
    return (
        f"Circuit breaker is open for tool '{tool_name}' phase '{phase}'; "
        "the tool is temporarily unavailable."
    )


def reset_all_for_tests() -> None:
    with _FAILURE_COUNTS_LOCK:
        _FAILURE_COUNTS.clear()
