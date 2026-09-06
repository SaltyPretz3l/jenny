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
import threading
import time
import urllib.parse
import urllib.request

from sidecar.ai.config import MCPServerAuth
from sidecar.ai.error_codes import CMP_MCP_CONFIG_INVALID, CMP_MCP_SERVER_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.tools.builtins.web_http import _build_opener, validate_public_url

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

    def token(self) -> str:
        """Return a valid bearer, minting (and caching) one if needed."""
        with self._lock:
            now = time.monotonic()
            if self._cached_token is not None and now < self._expires_at_monotonic:
                return self._cached_token
            minted, lifetime = self._mint()
            self._cached_token = minted
            self._expires_at_monotonic = time.monotonic() + lifetime
            return minted

    def invalidate(self) -> None:
        """Drop the cached token so the next ``token()`` re-mints."""
        with self._lock:
            self._cached_token = None
            self._expires_at_monotonic = 0.0

    def _mint(self) -> tuple[str, float]:
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
            )
        except (ValueError, PermissionError) as error:
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
        scope = str(self._auth.scope or "").strip()
        if scope:
            form["scope"] = scope
        body = urllib.parse.urlencode(form).encode("utf-8")
        request = urllib.request.Request(
            validated.url or token_url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
        )
        opener = _build_opener(str(getattr(validated, "pinned_ip", "") or ""))
        try:
            with opener.open(request, timeout=_MINT_TIMEOUT_SECONDS) as response:
                raw = response.read(_MAX_TOKEN_RESPONSE_BYTES + 1)
        except Exception as error:  # noqa: BLE001 - never leak secret material
            # A refused redirect surfaces here as urllib.error.HTTPError (the
            # _NoRedirectHandler raises on 3xx) -- fail closed, never followed.
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=(
                    f"mcp server '{self._server_name}' token mint failed: "
                    f"{type(error).__name__}"
                ),
                retryable=True,
            ) from error
        return self._parse_token_response(raw)

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
        except (UnicodeDecodeError, ValueError) as error:
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
