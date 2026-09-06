"""Shared HTTP service for provider engine API calls."""

from __future__ import annotations

import json
import logging
import re
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from sidecar.ai.engines.http_utils import (
    raise_if_cancelled as _raise_if_cancelled_shared,
)
from sidecar.ai.engines.http_utils import register_cancel_callback
from sidecar.ai.error_codes import (
    CMP_CLOUD_HTTP_ERROR,
    CMP_CLOUD_NETWORK_ERROR,
    CMP_CLOUD_RATE_LIMITED,
    CMP_CLOUD_RESPONSE_PARSE,
)
from sidecar.runtime import diagnostics
from sidecar.runtime.bounded_io import BoundedIOError
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT_SECONDS = 30.0
_RATE_LIMIT_CODE = CMP_CLOUD_RATE_LIMITED
_NETWORK_ERROR_CODE = CMP_CLOUD_NETWORK_ERROR
_HTTP_ERROR_CODE = CMP_CLOUD_HTTP_ERROR
_RESPONSE_PARSE_ERROR_CODE = CMP_CLOUD_RESPONSE_PARSE
_RETRYABLE_HTTP_STATUS_CODES = {408, 409, 425, 429}
_HTTP_STATUS_TOO_MANY_REQUESTS = 429
_HTTP_STATUS_BAD_REQUEST = 400
_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_FORBIDDEN = 403
_HTTP_STATUS_NOT_FOUND = 404
_HTTP_STATUS_INTERNAL_SERVER_ERROR = 500
_HTTP_STATUS_OVERLOADED = 529
_MAX_RETRY_AFTER_SECONDS = 32.0
_MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024
_PROVIDER_RESPONSE_CHUNK_BYTES = 64 * 1024
_SECRET_TOKEN_RE = re.compile(
    r"\b(?:sk|sk-proj|sk-ant|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b"
    r"|\b(?:sk|sk-proj|sk-ant)-[A-Za-z0-9_-]{20,}\b"
)
_AUTH_VALUE_RE = re.compile(
    r"(?i)\b(bearer|api[_-]?key|x-api-key)\s*[:=]\s*([^\s,'\"]{8,})"
)
_SSL_ERROR_CODES = frozenset(
    {
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "CERT_SIGNATURE_FAILURE",
        "CERT_NOT_YET_VALID",
        "CERT_HAS_EXPIRED",
        "CERT_REVOKED",
        "CERT_REJECTED",
        "CERT_UNTRUSTED",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "CERT_CHAIN_TOO_LONG",
        "PATH_LENGTH_EXCEEDED",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "HOSTNAME_MISMATCH",
        "ERR_TLS_HANDSHAKE_TIMEOUT",
        "ERR_SSL_WRONG_VERSION_NUMBER",
        "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
    }
)


@dataclass(frozen=True)
class TransportErrorDetails:
    code: str
    message: str
    is_ssl_error: bool


class ProviderHttpError(RuntimeError):
    """Raised when a provider HTTP request fails."""

    def __init__(
        self,
        *,
        provider: str,
        status_code: int | None,
        code: str,
        message: str,
        retryable: bool,
        classification: str = "",
        body: Any = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.status_code = status_code
        self.code = code
        self.retryable = retryable
        self.classification = classification
        self.body = body
        self.retry_after_seconds = retry_after_seconds


class ProviderHttpService:
    """HTTP service wrapper with typed error normalization."""

    def __init__(
        self,
        *,
        provider: str,
        base_url: str,
        headers: dict[str, str],
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._provider = provider
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout_seconds,
            headers=headers,
        )

    @property
    def provider(self) -> str:
        return self._provider

    @property
    def base_url(self) -> str:
        return str(self._client.base_url)

    def close(self) -> None:
        self._client.close()

    def stream_response(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> AbstractContextManager[httpx.Response]:
        """Open a live response stream.

        Callers own status checks, error handling, and response consumption.
        """
        if timeout is None:
            return self._client.stream(method, path, json=json)
        return self._client.stream(method, path, json=json, timeout=timeout)

    def get_json(
        self,
        path: str,
        *,
        query: dict[str, str] | None = None,
        cancel_handle: Any = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """GET JSON and parse the response using the shared provider transport policy.

        ``timeout`` overrides this service's configured client timeout for one
        call, mirroring :py:meth:`stream_response`. Health/probe calls need a
        much shorter bound than a generation request; without it, callers ended
        up hand-rolling a second HTTP client that bypassed the bounded-body,
        cancellation, and retry policy this service owns.
        """
        return self._request_json(
            "GET",
            path,
            payload=None,
            query=query,
            cancel_handle=cancel_handle,
            timeout=timeout,
        )

    def post_json(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        query: dict[str, str] | None = None,
        cancel_handle: Any = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """POST JSON and parse the response. When ``cancel_handle`` is supplied,
        cancellation is honored during the bounded request. The handle is duck-typed:
        it only needs ``cancelled: bool`` and ``wait(timeout_seconds) -> bool``
        (True if cancelled).

        ``timeout`` overrides the configured client timeout for one call.
        """
        return self._request_json(
            "POST",
            path,
            payload=payload,
            query=query,
            cancel_handle=cancel_handle,
            timeout=timeout,
        )

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None,
        query: dict[str, str] | None,
        cancel_handle: Any,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        _raise_if_cancelled(cancel_handle, self._provider)
        try:
            response = self._send_bounded_response(
                method,
                path,
                payload=payload,
                query=query,
                cancel_handle=cancel_handle,
                timeout=timeout,
            )
        except (httpx.TimeoutException, httpx.TransportError) as error:
            _raise_if_cancelled(cancel_handle, self._provider)
            raise _transport_error(self._provider, error) from error

        if response.status_code >= _HTTP_STATUS_BAD_REQUEST:
            raise _response_error(self._provider, response)

        return _parse_success_json_object(response, provider=self._provider)

    def _send_bounded_response(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None,
        query: dict[str, str] | None,
        cancel_handle: Any = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        request_kwargs: dict[str, Any] = {"params": query}
        if method != "GET":
            request_kwargs["json"] = payload
        if timeout is not None:
            request_kwargs["timeout"] = timeout
        try:
            _raise_if_cancelled(cancel_handle, self._provider)
            with self._client.stream(method, path, **request_kwargs) as response:
                unregister_cancel = _register_response_cancel_callback(
                    cancel_handle, response
                )
                try:
                    declared_length = _parse_content_length(response.headers)
                    if (
                        declared_length is not None
                        and declared_length > _MAX_PROVIDER_RESPONSE_BYTES
                    ):
                        raise BoundedIOError(
                            "declared provider response exceeds byte limit"
                        )
                    content = bytearray()
                    for chunk in response.iter_raw(
                        chunk_size=_PROVIDER_RESPONSE_CHUNK_BYTES
                    ):
                        if _cancel_requested(cancel_handle):
                            break
                        if len(content) + len(chunk) > _MAX_PROVIDER_RESPONSE_BYTES:
                            raise BoundedIOError("provider response exceeds byte limit")
                        content.extend(chunk)
                    bounded_response = httpx.Response(
                        response.status_code,
                        headers=response.headers,
                        content=bytes(content),
                        request=response.request,
                        extensions=response.extensions,
                    )
                finally:
                    unregister_cancel()
            _raise_if_cancelled(cancel_handle, self._provider)
            return bounded_response
        except httpx.TransportError:
            _raise_if_cancelled(cancel_handle, self._provider)
            raise
        except BoundedIOError as error:
            logger.warning(
                "%s response exceeded the bounded HTTP transport contract",
                self._provider,
                extra={
                    "event": "ai.engines.provider_http.response_bounded",
                    "provider": self._provider,
                    "max_response_bytes": _MAX_PROVIDER_RESPONSE_BYTES,
                },
            )
            raise ProviderHttpError(
                provider=self._provider,
                status_code=None,
                code=_RESPONSE_PARSE_ERROR_CODE,
                message=f"{self._provider} response exceeded the byte limit",
                retryable=False,
                classification="response_too_large",
            ) from error

def _register_response_cancel_callback(cancel_handle: Any, response: Any) -> Any:
    def _close() -> None:
        response.close()

    return register_cancel_callback(cancel_handle, _close)


def _raise_if_cancelled(cancel_handle: Any, provider: str) -> None:
    _raise_if_cancelled_shared(
        cancel_handle,
        make_error=lambda: TerminalChatStateError(
            status=TURN_STATE_CANCELLED,
            message=f"{provider} request cancelled",
        ),
    )


def _cancel_requested(cancel_handle: Any) -> bool:
    return bool(cancel_handle is not None and getattr(cancel_handle, "cancelled", False))


def _transport_error(provider: str, error: Exception) -> ProviderHttpError:
    if isinstance(error, httpx.TimeoutException):
        return ProviderHttpError(
            provider=provider,
            status_code=None,
            code=_NETWORK_ERROR_CODE,
            message=f"{provider} request timed out: {error}",
            retryable=True,
            classification="api_timeout",
        )

    details = _extract_transport_error_details(error)
    if details is not None and details.is_ssl_error:
        return ProviderHttpError(
            provider=provider,
            status_code=None,
            code=_NETWORK_ERROR_CODE,
            message=f"{provider} SSL connection failed: {details.message}",
            retryable=False,
            classification="ssl_cert_error",
        )

    return ProviderHttpError(
        provider=provider,
        status_code=None,
        code=_NETWORK_ERROR_CODE,
        message=f"{provider} request failed: {error}",
        retryable=True,
        classification="connection_error",
    )


def _response_error(provider: str, response: httpx.Response) -> ProviderHttpError:
    parsed_body = _sanitize_error_body(_parse_body(response))
    retry_after_seconds = _parse_retry_after_seconds(response)
    classification = _classify_http_response_error(response.status_code, parsed_body)

    if response.status_code == _HTTP_STATUS_TOO_MANY_REQUESTS:
        return ProviderHttpError(
            provider=provider,
            status_code=response.status_code,
            code=_RATE_LIMIT_CODE,
            message=f"{provider} request was rate limited",
            retryable=True,
            classification=classification,
            body=parsed_body,
            retry_after_seconds=retry_after_seconds,
        )

    retryable = (
        _is_retryable_http_status(response.status_code) or classification == "context_overflow"
    )
    return ProviderHttpError(
        provider=provider,
        status_code=response.status_code,
        code=_HTTP_ERROR_CODE,
        message=f"{provider} request failed with status {response.status_code}",
        retryable=retryable,
        classification=classification,
        body=parsed_body,
        retry_after_seconds=retry_after_seconds,
    )


def _is_retryable_http_status(status_code: int) -> bool:
    return (
        status_code >= _HTTP_STATUS_INTERNAL_SERVER_ERROR
        or status_code in _RETRYABLE_HTTP_STATUS_CODES
        or status_code == _HTTP_STATUS_OVERLOADED
    )


def _parse_retry_after_seconds(response: httpx.Response) -> float | None:
    retry_after = str(response.headers.get("retry-after", "")).strip()
    if not retry_after:
        return None
    try:
        seconds = float(retry_after)
        if seconds < 0:
            return 0.0
        return seconds
    except ValueError:
        pass

    try:
        parsed_date = parsedate_to_datetime(retry_after)
    except (TypeError, ValueError):
        return None
    if parsed_date.tzinfo is None:
        parsed_date = parsed_date.replace(tzinfo=timezone.utc)
    delay_seconds = (parsed_date - datetime.now(timezone.utc)).total_seconds()
    if delay_seconds < 0:
        return 0.0
    return delay_seconds


def _parse_content_length(headers: httpx.Headers) -> int | None:
    raw_value = str(headers.get("content-length", "")).strip()
    if not raw_value:
        return None
    try:
        parsed = int(raw_value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def _parse_body(response: httpx.Response) -> Any:
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type.lower():
        try:
            return response.json()
        except json.JSONDecodeError:
            return {"raw_text": response.text}
    return {"raw_text": response.text}


def _sanitize_secret_text(value: str) -> str:
    sanitized = _SECRET_TOKEN_RE.sub("<redacted-token>", value)
    return _AUTH_VALUE_RE.sub(lambda match: f"{match.group(1)}=<redacted-token>", sanitized)


def _sanitize_error_body(body: Any) -> Any:
    if isinstance(body, str):
        return _sanitize_secret_text(body)
    if isinstance(body, dict):
        return {
            key: "[redacted]" if diagnostics._is_sensitive_key(key) else _sanitize_error_body(value)
            for key, value in body.items()
        }
    if isinstance(body, list):
        return [_sanitize_error_body(value) for value in body]
    if isinstance(body, tuple):
        return tuple(_sanitize_error_body(value) for value in body)
    return body


def _parse_success_json_object(
    response: httpx.Response,
    *,
    provider: str,
) -> dict[str, Any]:
    content_type = response.headers.get("content-type", "")
    if "application/json" not in content_type.lower():
        raise ProviderHttpError(
            provider=provider,
            status_code=response.status_code,
            code=_RESPONSE_PARSE_ERROR_CODE,
            message=f"{provider} response content-type was not application/json",
            retryable=False,
            classification="response_parse",
            body=_sanitize_error_body({"raw_text": response.text}),
        )

    try:
        parsed = response.json()
    except json.JSONDecodeError as error:
        raise ProviderHttpError(
            provider=provider,
            status_code=response.status_code,
            code=_RESPONSE_PARSE_ERROR_CODE,
            message=f"{provider} response body contained invalid JSON",
            retryable=False,
            classification="response_parse",
            body=_sanitize_error_body({"raw_text": response.text}),
        ) from error

    if not isinstance(parsed, dict):
        raise ProviderHttpError(
            provider=provider,
            status_code=response.status_code,
            code=_RESPONSE_PARSE_ERROR_CODE,
            message=f"{provider} response body was not a JSON object",
            retryable=False,
            classification="response_parse",
            body=_sanitize_error_body(parsed),
        )
    return parsed


def _extract_transport_error_details(error: Exception) -> TransportErrorDetails | None:
    current: BaseException | None = error
    depth = 0
    while current is not None and depth < 5:
        code = getattr(current, "code", None)
        if isinstance(code, str) and code.strip():
            normalized = code.strip()
            return TransportErrorDetails(
                code=normalized,
                message=str(current),
                is_ssl_error=normalized in _SSL_ERROR_CODES,
            )
        current = getattr(current, "__cause__", None) or getattr(current, "__context__", None)
        depth += 1
    return None


def _classify_http_response_error(status_code: int, body: Any) -> str:
    message = _extract_error_message(body).lower()
    if status_code == _HTTP_STATUS_OVERLOADED or '"type":"overloaded_error"' in message:
        return "server_overload"
    if status_code == _HTTP_STATUS_TOO_MANY_REQUESTS:
        return "rate_limit"
    if _is_context_overflow_message(message):
        return "context_overflow"
    if "prompt is too long" in message:
        return "prompt_too_long"
    if status_code == _HTTP_STATUS_UNAUTHORIZED:
        return "invalid_api_key"
    if status_code == _HTTP_STATUS_FORBIDDEN:
        if "oauth token has been revoked" in message:
            return "invalid_api_key"
        if "api key" in message or "x-api-key" in message or "authentication" in message:
            return "invalid_api_key"
        return "client_error"
    if status_code == _HTTP_STATUS_NOT_FOUND and "model" in message:
        return "invalid_model"
    if status_code == _HTTP_STATUS_BAD_REQUEST:
        if "invalid model" in message or "model_not_found" in message:
            return "invalid_model"
        if "credit balance is too low" in message:
            return "credit_balance_low"
        if "x-api-key" in message or "api key" in message:
            return "invalid_api_key"
        return "client_error"
    if status_code == 408:
        return "api_timeout"
    if status_code >= _HTTP_STATUS_INTERNAL_SERVER_ERROR:
        return "server_error"
    return "client_error"


def _extract_error_message(body: Any) -> str:
    if isinstance(body, dict):
        raw_text = body.get("raw_text")
        if isinstance(raw_text, str) and raw_text.strip():
            return raw_text
        error = body.get("error")
        if isinstance(error, dict):
            nested = _extract_error_message(error)
            if nested:
                return nested
        message = body.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
        error_type = body.get("type")
        if isinstance(error_type, str) and error_type.strip():
            return error_type.strip()
    if isinstance(body, list):
        for item in body:
            nested = _extract_error_message(item)
            if nested:
                return nested
    if isinstance(body, str):
        return body.strip()
    return ""


def _is_context_overflow_message(message: str) -> bool:
    return "input length and `max_tokens` exceed context limit" in message


# ---------------------------------------------------------------------------
# Shared status policy, exposed for provider engines that build their own errors.
#
# A provider that hand-rolls its own status table silently drifts from this one --
# that is how ChatGPT ended up treating 408/409/425 as terminal while the shared
# policy considered them retryable. Engines should delegate here instead.
#
# Callers that scrub provider bodies (ChatGPT only lets `code` and `resets_at`
# escape a 429) MUST pass body=None to classify_http_response_error: it greps the
# raw provider message for phrases, so handing it an unscrubbed body would route
# provider text -- potentially token-bearing -- through a decision path.
# ---------------------------------------------------------------------------

is_retryable_http_status = _is_retryable_http_status
classify_http_response_error = _classify_http_response_error
parse_retry_after_seconds = _parse_retry_after_seconds

__all__ = [
    "ProviderHttpError",
    "ProviderHttpService",
    "classify_http_response_error",
    "is_retryable_http_status",
    "parse_retry_after_seconds",
]
