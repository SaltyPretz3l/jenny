"""Initial-status mapping shared by every API-provider transport (row 78).

A 3xx is refused (the client never follows redirects, so a key cannot ride to
another host) and an error status becomes a typed ``ProviderHttpError``
classified on the status alone: provider body text never reaches a decision or
a message.
"""

from __future__ import annotations

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
    raise ProviderHttpError(
        provider=API_PROVIDER_LABEL,
        status_code=status,
        code=CMP_CLOUD_RATE_LIMITED if status == _HTTP_TOO_MANY_REQUESTS else CMP_CLOUD_HTTP_ERROR,
        message=f"{label} request failed with status {status}",
        retryable=is_retryable_http_status(status),
        classification=classify_http_response_error(status, None),
        body=None,
        retry_after_seconds=parse_retry_after_seconds(response),
    )


__all__ = ["API_PROVIDER_LABEL", "ProviderHttpError", "raise_for_provider_status"]
