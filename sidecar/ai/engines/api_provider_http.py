"""Initial-status mapping shared by every API-provider transport (row 78).

A 3xx is refused (the client never follows redirects, so a key cannot ride to
another host) and an error status becomes a typed ``ProviderHttpError``
classified on the status alone: provider body text never reaches a decision or
a message.

One narrow exception (row 183 W1): a 400 or 413 is checked for the two context
overflow phrases, so the provider retry can shrink ``max_tokens`` and the tool
loop can compact and resend. Only a fixed phrase and its integers leave
``_overflow_body``; no provider text does.
"""

from __future__ import annotations

import re
from typing import Any

from sidecar.ai.engines.provider_http import (
    ProviderHttpError,
    classify_http_response_error,
    is_retryable_http_status,
    parse_retry_after_seconds,
)
from sidecar.ai.error_codes import CMP_CLOUD_HTTP_ERROR, CMP_CLOUD_RATE_LIMITED

API_PROVIDER_LABEL = "api-provider"
_HTTP_REDIRECT_FLOOR = 300
_HTTP_ERROR_FLOOR = 400
_HTTP_TOO_MANY_REQUESTS = 429
_OVERFLOW_STATUSES = frozenset({400, 413})
_OVERFLOW_BODY_LIMIT = 16_384
_LIMIT_PHRASE = "input length and `max_tokens` exceed context limit"
_LIMIT_NUMBERS = re.compile(r"exceed context limit: (\d{1,9}) \+ (\d{1,9}) > (\d{1,9})")
_TOO_LONG_PHRASE = "prompt is too long"


def _overflow_body(response: Any, status: int) -> dict[str, Any] | None:
    """A synthetic body naming a context overflow, built from fixed text and digits only."""
    if status not in _OVERFLOW_STATUSES:
        return None
    try:
        raw = b""
        for chunk in response.iter_bytes():
            raw += chunk
            if len(raw) >= _OVERFLOW_BODY_LIMIT:
                break
        text = raw[:_OVERFLOW_BODY_LIMIT].decode("utf-8", "replace").lower()
    except Exception:  # noqa: BLE001 - an unreadable body keeps the status-only class.
        return None
    numbers = _LIMIT_NUMBERS.search(text)
    if numbers is not None:
        prompt, reply, limit = (int(value) for value in numbers.groups())
        message = f"{_LIMIT_PHRASE}: {prompt} + {reply} > {limit}"
    elif _LIMIT_PHRASE in text:
        message = _LIMIT_PHRASE
    elif _TOO_LONG_PHRASE in text:
        message = _TOO_LONG_PHRASE
    else:
        return None
    return {"error": {"message": message}}


def raise_for_provider_status(response: Any, *, label: str) -> None:
    status = int(getattr(response, "status_code", 0) or 0)
    if status < _HTTP_REDIRECT_FLOOR:
        return
    if status < _HTTP_ERROR_FLOOR:
        raise ProviderHttpError(
            provider=API_PROVIDER_LABEL,
            status_code=status,
            code=CMP_CLOUD_HTTP_ERROR,
            message=f"{label} redirect refused",
            retryable=False,
            classification="redirect_refused",
        )
    overflow = _overflow_body(response, status)
    raise ProviderHttpError(
        provider=API_PROVIDER_LABEL,
        status_code=status,
        code=CMP_CLOUD_RATE_LIMITED if status == _HTTP_TOO_MANY_REQUESTS else CMP_CLOUD_HTTP_ERROR,
        message=f"{label} request failed with status {status}",
        retryable=is_retryable_http_status(status),
        classification=classify_http_response_error(status, overflow),
        body=overflow,
        retry_after_seconds=parse_retry_after_seconds(response),
    )


__all__ = ["API_PROVIDER_LABEL", "ProviderHttpError", "raise_for_provider_status"]
