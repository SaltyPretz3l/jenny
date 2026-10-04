"""OAuth 2.1 client-credentials token mint + in-memory cache for MCP HTTP auth.

The only OAuth flow in scope for v1 (the interactive authorization-code / PKCE
flow is a documented follow-on). ``ClientCredentialsTokenSource`` mints a bearer
via a form-encoded ``client_credentials`` POST to ``token_url`` (which gets the
same SSRF validation as the server URL), caches it in-memory until shortly
before ``expires_in``, and re-mints on demand after ``invalidate()``. The
``client_secret`` and the minted token never appear in any log, error message,
or ``repr`` -- errors name the server, never the credentials.
"""

from __future__ import annotations

import json
import math
import socket
import threading
import time
import urllib.parse
from typing import Any

from sidecar.ai.config import MCPServerAuth
from sidecar.ai.error_codes import CMP_MCP_CONFIG_INVALID, CMP_MCP_SERVER_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.sse_http_client import (
    _connection_for,
    _read_response_chunk,
    _register_connection_cancel_callback,
    _request_path,
    _response_socket,
)
from sidecar.ai.mcp.transport_base import raise_if_cancelled
from sidecar.ai.tools.builtins.web_http import validate_public_url

# Refresh the token this many seconds before its stated expiry (clock skew +
# in-flight request budget), and fall back to this lifetime when the token
# endpoint omits (or returns a nonsensical) expires_in.
_EXPIRY_SKEW_SECONDS = 30.0
_DEFAULT_EXPIRES_IN_SECONDS = 300.0
# Refuse attacker-controlled multi-day cache lifetimes even when the issuer
# returns a syntactically valid number.
_MAX_EXPIRES_IN_SECONDS = 24 * 60 * 60.0
_MINT_TIMEOUT_SECONDS = 30.0
_MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
_HTTP_SUCCESS_MIN = 200
_HTTP_REDIRECT_MIN = 300


class ClientCredentialsTokenSource:
    """Mints and caches an OAuth client-credentials bearer for one MCP server."""

    def __init__(
        self,
        auth: MCPServerAuth,
        *,
        server_name: str,
        allow_private_addresses: bool = False,
    ) -> None:
        self._auth = auth
        self._server_name = server_name
        self._allow_private_addresses = bool(allow_private_addresses)
        self._lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._cache_generation = 0
        self._cached_token: str | None = None
        self._expires_at_monotonic: float = 0.0

    def __repr__(self) -> str:
        # Never leak the client_secret or the minted token.
        return (
            "ClientCredentialsTokenSource("
            f"server_name={self._server_name!r}, "
            f"token_url={self._auth.token_url!r}, "
            f"client_id={self._auth.client_id!r}, "
            f"cached={'yes' if self._cached_token else 'no'})"
        )

    def token(self, *, deadline: float | None = None, cancel_handle: Any = None) -> str:
        """Keep mint ownership until cleanup, even if the caller stops waiting."""
        mint_deadline = time.monotonic() + _MINT_TIMEOUT_SECONDS
        deadline = min(deadline, mint_deadline) if deadline is not None else mint_deadline
        while True:
            raise_if_cancelled(cancel_handle)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise MCPError(code=CMP_MCP_SERVER_FAILED, retryable=True,
                               message="MCP token request timed out")
            if self._lock.acquire(timeout=min(0.05, remaining)):
                break
        with self._state_lock:
            generation = self._cache_generation
            if self._cached_token is not None and time.monotonic() < self._expires_at_monotonic:
                self._lock.release()
                return self._cached_token
        finished = threading.Event()
        abandoned = threading.Event()
        tokens: list[str] = []
        errors: list[Exception] = []

        def mint() -> None:
            try:
                minted, lifetime = self._mint(deadline=deadline, cancel_handle=cancel_handle)
                raise_if_cancelled(cancel_handle)
                with self._state_lock:
                    if (not abandoned.is_set() and time.monotonic() < deadline
                            and generation == self._cache_generation):
                        self._cached_token = minted
                        self._expires_at_monotonic = time.monotonic() + lifetime
                tokens.append(minted)
            except Exception as error:  # noqa: BLE001 - return worker failures to the caller
                errors.append(error)
            finally:
                self._lock.release()
                finished.set()

        worker = threading.Thread(target=mint, name="mcp-token-mint", daemon=True)
        try:
            worker.start()
        except BaseException:
            self._lock.release()
            raise
        try:
            while not finished.wait(timeout=min(0.05, max(0.0, deadline - time.monotonic()))):
                raise_if_cancelled(cancel_handle)
                if time.monotonic() >= deadline:
                    raise MCPError(code=CMP_MCP_SERVER_FAILED, retryable=True,
                                   message="MCP token request timed out")
            raise_if_cancelled(cancel_handle)
            if errors:
                raise errors[0]
            return tokens[0]
        finally:
            abandoned.set()

    def invalidate(self) -> None:
        """Invalidate without waiting for a network operation or its mint lock."""
        with self._state_lock:
            self._cache_generation += 1
            self._cached_token = None
            self._expires_at_monotonic = 0.0

    def _mint(self, *, deadline: float, cancel_handle: Any) -> tuple[str, float]:
        token_url = str(self._auth.token_url or "").strip()
        if not token_url:
            raise MCPError(
                code=CMP_MCP_CONFIG_INVALID,
                message=(
                    f"mcp server '{self._server_name}' oauth config is missing token_url"
                ),
                retryable=False,
            )
        # SSRF guard on the token endpoint: capture the vetted pinned IP so the
        # request connects to it (no DNS rebinding) and refuse any redirect the
        # server tries -- following a 3xx would bypass this validation entirely
        # (the classic metadata-endpoint SSRF pivot). The redirect refusal holds
        # regardless of ``allow_private_addresses``, which only relaxes the
        # address-class check so an owner-configured self-hosted issuer on a
        # LAN / tailnet / CGNAT address can mint (same single opt-in as the
        # fetch and search paths).
        try:
            validated = validate_public_url(
                token_url,
                allow_private=self._allow_private_addresses,
                deadline=deadline,
            )
        except (ValueError, PermissionError, TimeoutError) as error:
            raise MCPError(
                code=CMP_MCP_CONFIG_INVALID,
                message=(
                    f"mcp server '{self._server_name}' token_url rejected: "
                    f"{type(error).__name__}"
                ),
                retryable=False,
            ) from error

        form: dict[str, str] = {
            "grant_type": "client_credentials",
            "client_id": str(self._auth.client_id or ""),
            "client_secret": str(self._auth.client_secret or ""),
        }
        if self._auth.scope:
            form["scope"] = self._auth.scope.strip()
        raise_if_cancelled(cancel_handle)
        parsed = urllib.parse.urlparse(validated.url or token_url)
        conn = _connection_for(parsed, timeout_seconds=max(0.001, deadline - time.monotonic()),
                               pinned_ip=str(getattr(validated, "pinned_ip", "") or ""))
        response: Any = None
        unregister = _register_connection_cancel_callback(cancel_handle, conn)
        unregister_response = _register_connection_cancel_callback(None, conn)

        def stop() -> None:
            connection_socket = conn.sock or _response_socket(response)
            if connection_socket is not None:
                try:
                    connection_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        timer = threading.Timer(max(0.0, deadline - time.monotonic()), stop)
        timer.daemon = True
        timer.start()
        try:
            conn.request("POST", _request_path(parsed),
                         body=urllib.parse.urlencode(form).encode("utf-8"), headers={
                "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
            })
            response = conn.getresponse()
            unregister_response = _register_connection_cancel_callback(cancel_handle, response)
            if not _HTTP_SUCCESS_MIN <= response.status < _HTTP_REDIRECT_MIN:
                raise ValueError("token endpoint rejected request")
            raw_buffer = bytearray()
            while len(raw_buffer) <= _MAX_TOKEN_RESPONSE_BYTES:
                chunk = _read_response_chunk(
                    response, deadline=deadline, cancel_handle=cancel_handle,
                )
                if not chunk:
                    break
                raw_buffer.extend(chunk)
        except Exception as error:  # never leak secret material
            raise_if_cancelled(cancel_handle)
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=(f"mcp server '{self._server_name}' token mint failed: "
                         f"{type(error).__name__}"),
                retryable=True,
            ) from error
        finally:
            stop()
            if response is not None:
                response.close()
            conn.close()
            timer.cancel()
            unregister_response()
            unregister()
        return self._parse_token_response(bytes(raw_buffer))

    def _parse_token_response(self, raw: bytes) -> tuple[str, float]:
        if len(raw) > _MAX_TOKEN_RESPONSE_BYTES:
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=(
                    f"mcp server '{self._server_name}' token response exceeded maximum size"
                ),
                retryable=False,
            )
        try:
            data = json.loads(
                raw.decode("utf-8"),
                parse_constant=_reject_nonfinite_json_constant,
            )
        except (UnicodeDecodeError, ValueError, RecursionError) as error:
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=(
                    f"mcp server '{self._server_name}' returned an invalid token response: "
                    f"{type(error).__name__}"
                ),
                retryable=False,
            ) from error
        if not isinstance(data, dict):
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=(
                    f"mcp server '{self._server_name}' returned a non-object token response"
                ),
                retryable=False,
            )
        access_token = data.get("access_token")
        if not isinstance(access_token, str) or not access_token.strip():
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=(
                    f"mcp server '{self._server_name}' token response had no access_token"
                ),
                retryable=False,
            )
        lifetime = self._resolve_lifetime(data.get("expires_in"))
        return access_token, lifetime

    def _resolve_lifetime(self, expires_in: object) -> float:
        if isinstance(expires_in, bool):
            seconds = _DEFAULT_EXPIRES_IN_SECONDS
        else:
            try:
                seconds = float(expires_in)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                seconds = _DEFAULT_EXPIRES_IN_SECONDS
        if not math.isfinite(seconds) or seconds <= 0:
            seconds = _DEFAULT_EXPIRES_IN_SECONDS
        seconds = min(seconds, _MAX_EXPIRES_IN_SECONDS)
        return max(seconds - _EXPIRY_SKEW_SECONDS, 1.0)


def _reject_nonfinite_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number is not allowed: {value}")
