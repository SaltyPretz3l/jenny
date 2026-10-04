"""Per-request safety fields carried on ``chat.send`` (owner decision D3).

``chat.send`` carries the user's current safety mode and auto-approve streak
cap as additive optional params (see ``sidecar/protocol.py``) so a Settings
change applies from the next turn without a config refresh. The values are
bound for the request like the live run mode (``sidecar.runtime.turn_state``)
because ``approval_if_needed`` reads them below the router; ``RuntimeConfig``
is the fallback when a request carries none.

Lives beside :mod:`route_policy_runtime` (which re-exports these names for its
callers) so the runtime module keeps its import fan-out at the leaf budget.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from functools import wraps
from typing import Any, Callable, TypeVar

from sidecar.ai.config import _parse_auto_approve_streak_cap
from sidecar.ai.config_parsing import _normalize_safety_mode


@dataclass(frozen=True)
class RequestSafety:
    safety_mode: str | None = None
    auto_approve_streak_cap: int | None = None


_REQUEST_SAFETY: ContextVar[RequestSafety | None] = ContextVar(
    "sidecar_request_safety", default=None
)
_Result = TypeVar("_Result")


def request_safety_from_params(params: Any) -> RequestSafety | None:
    """Validate the optional chat.send fields; an invalid value is dropped."""

    if not isinstance(params, dict):
        return None
    safety_mode = _normalize_safety_mode(params.get("safety_mode"), default="") or None
    cap = params.get("auto_approve_streak_cap")
    # Only a value the config parser would accept unchanged is honoured: a
    # fractional, negative or oversized cap is dropped (config fallback) rather
    # than clamped, so a malformed request never lowers the guard.
    parsed = _parse_auto_approve_streak_cap({"auto_approve_streak_cap": cap})
    valid_cap = isinstance(cap, (int, float)) and not isinstance(cap, bool) and parsed == cap
    return RequestSafety(
        safety_mode=safety_mode,
        auto_approve_streak_cap=parsed if valid_cap else None,
    )


def with_request_safety(func: Callable[..., _Result]) -> Callable[..., _Result]:
    """Bind the request's safety fields (``params=`` keyword) for the call."""

    @wraps(func)
    def wrapped(*args: Any, **kwargs: Any) -> _Result:
        token = _REQUEST_SAFETY.set(request_safety_from_params(kwargs.get("params")))
        try:
            return func(*args, **kwargs)
        finally:
            _REQUEST_SAFETY.reset(token)

    return wrapped


def current_request_safety() -> RequestSafety | None:
    return _REQUEST_SAFETY.get()


def resolve_safety_mode(request_context: Any | None, config: Any) -> str:
    requested = getattr(request_context, "safety_mode", None)
    return requested or str(getattr(config, "safety_mode", "normal")).lower()


def resolve_streak_cap(request_context: Any | None, config: Any) -> int:
    requested = getattr(request_context, "auto_approve_streak_cap", None)
    return int(getattr(config, "auto_approve_streak_cap", 50)) if requested is None else requested
