"""Opaque per-request routing token for a local gateway.

A ``chat.send`` request may carry ``route_token``. The dispatcher binds it for
the duration of that one request; an engine that opts in reads it with
:func:`route_token_headers` and adds it to its chat-completion calls when the
endpoint is a loopback IP literal. The sidecar attaches no meaning to the
value: it is validated for shape, carried, and never logged.

The value lives in a ``ContextVar``, so it follows ``copy_context()`` into the
worker threads a request starts and stays invisible to unrelated threads.
"""

from __future__ import annotations

import ipaddress
import re
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from typing import Any, Callable, Iterator, TypeVar

from sidecar.protocol import ROUTE_TOKEN_HEADER

_Result = TypeVar("_Result")

# 32 random bytes in unpadded base64url.
_ROUTE_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}")
_ROUTE_TOKEN: ContextVar[str | None] = ContextVar("request_route_token", default=None)
_IPV4_LOOPBACK = ipaddress.IPv4Network("127.0.0.0/8")
_IPV6_LOOPBACK = ipaddress.IPv6Address("::1")
REDACTED_ROUTE_TOKEN = "[redacted:route-token]"


def _valid_route_token(value: Any) -> str | None:
    if isinstance(value, str) and _ROUTE_TOKEN_RE.fullmatch(value):
        return value
    return None


@contextmanager
def bind_route_token(value: Any) -> Iterator[None]:
    """Bind ``value`` for the body; an invalid value binds nothing (``None``).

    An invalid value also hides any outer token for the body: fail closed.
    """
    reset_token = _ROUTE_TOKEN.set(_valid_route_token(value))
    try:
        yield
    finally:
        _ROUTE_TOKEN.reset(reset_token)


def current_route_token() -> str | None:
    return _ROUTE_TOKEN.get()


def with_route_token(func: Callable[..., _Result]) -> Callable[..., _Result]:
    """Bind the request's optional ``route_token`` (``params=`` keyword) for the call."""

    @wraps(func)
    def wrapped(*args: Any, **kwargs: Any) -> _Result:
        params = kwargs.get("params")
        value = params.get("route_token") if isinstance(params, dict) else None
        with bind_route_token(value):
            return func(*args, **kwargs)

    return wrapped


def is_loopback_ip_literal(url: str) -> bool:
    """True only for a host in 127.0.0.0/8 or exactly ``::1``; a hostname never is.

    The host is parsed the way the HTTP client parses it, so the decision matches
    where a request actually goes. Refused: names (``localhost`` included),
    ``0.0.0.0``, an IPv4-mapped IPv6 address and an IPv6 address with a zone.
    """
    import httpx  # Loaded lazily, as in provider_http; it is in memory by any HTTP call.

    try:
        address = ipaddress.ip_address(httpx.URL(str(url)).host)
    except (ValueError, TypeError, httpx.InvalidURL):
        return False
    if isinstance(address, ipaddress.IPv4Address):
        return address in _IPV4_LOOPBACK
    return address == _IPV6_LOOPBACK and address.scope_id is None


def route_token_headers(base_url: str) -> dict[str, str] | None:
    """The per-call header for ``base_url``, or ``None`` when it must not be sent."""
    token = _ROUTE_TOKEN.get()
    if token is None or not is_loopback_ip_literal(base_url):
        return None
    return {ROUTE_TOKEN_HEADER: token}


def redact_route_token(text: str) -> str:
    """Replace the bound token in ``text`` (a peer may echo it back in an error body)."""
    token = _ROUTE_TOKEN.get()
    if token is None or not text or token not in text:
        return text
    return text.replace(token, REDACTED_ROUTE_TOKEN)


__all__ = [
    "REDACTED_ROUTE_TOKEN",
    "bind_route_token",
    "current_route_token",
    "is_loopback_ip_literal",
    "redact_route_token",
    "route_token_headers",
    "with_route_token",
]
