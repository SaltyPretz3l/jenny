"""MCP Streamable-HTTP (SSE) transport.

A drop-in peer of ``StdioMCPTransport`` that talks to a remote MCP server over
HTTP POST + an SSE (or single-JSON) response, per the MCP Streamable-HTTP spec.
The JSON-RPC 2.0 framing mirrors the stdio transport (monotonic ids,
result-shape validation per method, ``_raise_for_error`` error mapping); only
the wire mechanism differs. Unlike stdio, a lazy ``initialize`` handshake runs
before the first RPC (remote servers enforce it), bounded by
``init_timeout_seconds``.

Boundary invariant: no bare exception escapes -- every network / timeout /
parse / auth failure becomes a structured ``MCPError``. The bearer token and
OAuth client secret never appear in any log, error message, or repr.
"""

from __future__ import annotations

import logging
import threading
from itertools import count
from typing import Any

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp.exceptions import (
    CMP_MCP_CONFIG_INVALID,
    CMP_MCP_PROTOCOL_FAILED,
    CMP_MCP_SERVER_FAILED,
    MCPError,
)
from sidecar.ai.mcp.mcp_http_auth import ClientCredentialsTokenSource
from sidecar.ai.mcp.sse_http_client import SSEHttpError, post_jsonrpc, post_notification
from sidecar.ai.mcp.transport_base import MCPTransport
from sidecar.ai.mcp.transport_base import raise_if_cancelled as _raise_if_cancelled
from sidecar.ai.tools.builtins.web_http import validate_public_url

logger = logging.getLogger(__name__)

MCP_PROTOCOL_VERSION = "2025-03-26"
_JENNY_CLIENT_NAME = "jenny"
_JENNY_CLIENT_VERSION = "1"
_MIN_TIMEOUT_SECONDS = 1.0
_MAX_TIMEOUT_SECONDS = 600.0
# Cap the server-supplied JSON-RPC error.message before it reaches any log or
# MCPError message so a hostile server cannot balloon our logs/errors.
_MAX_SERVER_MESSAGE_CHARS = 500
_HTTP_BAD_REQUEST = 400
_HTTP_UNAUTHORIZED = 401
_HTTP_SERVER_ERROR = 500


def _clamp_timeout(seconds: float) -> float:
    return min(max(float(seconds), _MIN_TIMEOUT_SECONDS), _MAX_TIMEOUT_SECONDS)


def _bounded_server_message(text: object) -> str:
    message = str(text or "").strip()
    if len(message) > _MAX_SERVER_MESSAGE_CHARS:
        return message[:_MAX_SERVER_MESSAGE_CHARS] + "...(truncated)"
    return message


class SSEMCPTransport(MCPTransport):
    def __init__(
        self,
        config: MCPServerConfig,
        *,
        request_timeout_seconds: float | None = None,
        allow_private_addresses: bool = False,
    ) -> None:
        self._config = config
        url = str(config.url or "").strip()
        if not url:
            raise MCPError(
                code=CMP_MCP_CONFIG_INVALID,
                message=f"sse transport requires a url for '{config.name}'",
                retryable=False,
            )
        # SSRF guard BEFORE any request is ever possible. Keep the validated
        # pinned IP so every request connects to the vetted address instead of
        # re-resolving the hostname (defeats DNS rebinding).
        # ``allow_private_addresses`` mirrors the owner's
        # ``tools_web_allow_private_addresses`` decision so a self-hosted server
        # on a LAN / tailnet / CGNAT address is reachable under the same single
        # opt-in that governs the fetch and search paths. It relaxes only the
        # address-class check -- the redirect refusal and the no-credentials-in-URL
        # rules still apply.
        try:
            validated = validate_public_url(url, allow_private=allow_private_addresses)
        except (ValueError, PermissionError) as error:
            raise MCPError(
                code=CMP_MCP_CONFIG_INVALID,
                message=(
                    f"sse transport url rejected for '{config.name}': "
                    f"{type(error).__name__}"
                ),
                retryable=False,
            ) from error
        self._url = validated.url or url
        self._pinned_ip = str(getattr(validated, "pinned_ip", "") or "")
        self._ids = count(1)
        self._request_lock = threading.Lock()
        self._request_timeout_seconds = request_timeout_seconds
        self._initialized = False
        self._session_id: str | None = None
        self._token_source: ClientCredentialsTokenSource | None = None
        if config.auth is not None and config.auth.kind == "oauth_client_credentials":
            self._token_source = ClientCredentialsTokenSource(
                config.auth,
                server_name=config.name,
                allow_private_addresses=allow_private_addresses,
            )

    @property
    def server_name(self) -> str:
        return self._config.name

    # -- ABC methods -------------------------------------------------------

    def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        response = self._request("tools/list", {}, cancel_handle=cancel_handle)
        result = self._require_result(response, "tools/list")
        tools = result.get("tools")
        if not isinstance(tools, list):
            return []
        return [tool for tool in tools if isinstance(tool, dict)]

    def call_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
        on_output_chunk: Any = None,  # noqa: ARG002 - stdio-only live tail
    ) -> dict[str, Any]:
        _raise_if_cancelled(cancel_handle, message="MCP HTTP request cancelled")
        response = self._request(
            "tools/call",
            {"name": tool_name, "arguments": arguments},
            timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle,
        )
        _raise_if_cancelled(cancel_handle, message="MCP HTTP request cancelled")
        return self._require_result(response, "tools/call")

    def list_resources(
        self,
        *,
        cursor: str | None = None,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if isinstance(cursor, str) and cursor.strip():
            params["cursor"] = cursor.strip()
        response = self._request(
            "resources/list",
            params,
            timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle,
        )
        return self._require_result(response, "resources/list")

    def read_resource(
        self,
        uri: str,
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        response = self._request(
            "resources/read",
            {"uri": uri},
            timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle,
        )
        return self._require_result(response, "resources/read")

    def list_resource_templates(
        self,
        *,
        cursor: str | None = None,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if isinstance(cursor, str) and cursor.strip():
            params["cursor"] = cursor.strip()
        response = self._request(
            "resources/templates/list",
            params,
            timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle,
        )
        return self._require_result(response, "resources/templates/list")

    def close(self) -> None:
        # No pooled sockets are held between requests (each request opens and
        # closes its own connection); just drop session + token state. Idempotent
        # and never raises.
        self._session_id = None
        self._initialized = False
        if self._token_source is not None:
            try:
                self._token_source.invalidate()
            except Exception:  # noqa: BLE001 - close must never raise
                pass

    # -- internals ---------------------------------------------------------

    def _require_result(self, response: dict[str, Any], method: str) -> dict[str, Any]:
        result = response.get("result")
        if not isinstance(result, dict):
            raise MCPError(
                code=CMP_MCP_PROTOCOL_FAILED,
                message=f"mcp server '{self.server_name}' returned invalid {method} result",
                retryable=False,
            )
        return result

    def _request_timeout(self, timeout_seconds: float | None) -> float:
        if timeout_seconds is not None:
            return min(max(float(timeout_seconds), 0.001), _MAX_TIMEOUT_SECONDS)
        if self._request_timeout_seconds is not None:
            return _clamp_timeout(self._request_timeout_seconds)
        return _clamp_timeout(self._config.request_timeout_seconds)

    def _init_timeout(self) -> float:
        configured = _clamp_timeout(self._config.init_timeout_seconds)
        if self._request_timeout_seconds is None:
            return configured
        return min(configured, max(0.001, float(self._request_timeout_seconds)))

    def _headers(self, *, allow_remint: bool = True) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        token = self._resolve_bearer(allow_remint=allow_remint)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        return headers

    def _resolve_bearer(self, *, allow_remint: bool) -> str | None:
        auth = self._config.auth
        if auth is None:
            return None
        if self._token_source is not None:
            del allow_remint  # mint-on-demand; caller controls invalidation
            return self._token_source.token()
        token = str(auth.token or "").strip()
        return token or None

    def _ensure_initialized(self, *, cancel_handle: Any = None) -> None:
        if self._initialized:
            return
        with self._request_lock:
            if self._initialized:
                return
            params = {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "clientInfo": {
                    "name": _JENNY_CLIENT_NAME,
                    "version": _JENNY_CLIENT_VERSION,
                },
                "capabilities": {},
            }
            response = self._send(
                "initialize",
                params,
                timeout_seconds=self._init_timeout(),
                cancel_handle=cancel_handle,
            )
            result = response.get("result")
            protocol_version = result.get("protocolVersion") if isinstance(result, dict) else None
            if not isinstance(protocol_version, str) or not protocol_version.strip():
                raise MCPError(
                    code=CMP_MCP_PROTOCOL_FAILED,
                    message=(
                        f"mcp server '{self.server_name}' returned an invalid initialize result"
                    ),
                    retryable=False,
                )
            self._send_notification(
                "notifications/initialized",
                {},
                cancel_handle=cancel_handle,
            )
            self._initialized = True

    def _request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        _raise_if_cancelled(cancel_handle, message="MCP HTTP request cancelled")
        self._ensure_initialized(cancel_handle=cancel_handle)
        timeout = self._request_timeout(timeout_seconds)
        with self._request_lock:
            response = self._send(
                method,
                params,
                timeout_seconds=timeout,
                cancel_handle=cancel_handle,
            )
        _raise_if_cancelled(cancel_handle, message="MCP HTTP request cancelled")
        return response

    def _send(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout_seconds: float,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        request_id = next(self._ids)
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }
        response = self._post(
            payload,
            method=method,
            timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle,
        )
        if response.get("id") != request_id:
            raise MCPError(
                code=CMP_MCP_PROTOCOL_FAILED,
                message=f"mcp server '{self.server_name}' returned a response with an invalid id",
                retryable=False,
            )
        self._raise_for_error(response)
        return response

    def _post(
        self,
        payload: dict[str, Any],
        *,
        method: str,
        timeout_seconds: float,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        try:
            post_kwargs: dict[str, Any] = {
                "headers": self._headers(),
                "timeout_seconds": timeout_seconds,
                "pinned_ip": self._pinned_ip,
            }
            if cancel_handle is not None:
                post_kwargs["cancel_handle"] = cancel_handle
            response = post_jsonrpc(
                self._url,
                payload,
                **post_kwargs,
            )
        except SSEHttpError as error:
            _raise_if_cancelled(cancel_handle, message="MCP HTTP request cancelled")
            if error.status == _HTTP_UNAUTHORIZED:
                return self._handle_401(
                    payload,
                    method=method,
                    timeout_seconds=timeout_seconds,
                    cancel_handle=cancel_handle,
                )
            raise self._map_http_error(error) from error
        self._capture_session_id(response)
        return response

    def _handle_401(
        self,
        payload: dict[str, Any],
        *,
        method: str,
        timeout_seconds: float,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        # A minted client-credentials token may have expired: invalidate + re-mint
        # ONCE, and replay only non-side-effecting requests. tools/call is never
        # replayed by the transport -- the client's side-effect-aware retry policy
        # owns any replay -- so a fresh 401 there becomes a retryable MCPError.
        if self._token_source is not None and method != "tools/call":
            self._token_source.invalidate()
            try:
                retry_kwargs: dict[str, Any] = {
                    "headers": self._headers(),
                    "timeout_seconds": timeout_seconds,
                    "pinned_ip": self._pinned_ip,
                }
                if cancel_handle is not None:
                    retry_kwargs["cancel_handle"] = cancel_handle
                response = post_jsonrpc(
                    self._url,
                    payload,
                    **retry_kwargs,
                )
            except SSEHttpError as retry_error:
                _raise_if_cancelled(cancel_handle, message="MCP HTTP request cancelled")
                raise self._map_auth_failure(retry_error) from retry_error
            self._capture_session_id(response)
            return response
        if self._token_source is not None:
            # tools/call after a 401: hand off to the client's retry policy.
            self._token_source.invalidate()
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"mcp server '{self.server_name}' authentication failed",
                retryable=True,
            )
        raise MCPError(
            code=CMP_MCP_SERVER_FAILED,
            message=f"mcp server '{self.server_name}' authentication failed",
            retryable=False,
        )

    def _map_auth_failure(self, error: SSEHttpError) -> MCPError:
        if error.status == _HTTP_UNAUTHORIZED:
            return MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"mcp server '{self.server_name}' authentication failed",
                retryable=False,
            )
        return self._map_http_error(error)

    def _map_http_error(self, error: SSEHttpError) -> MCPError:
        status = error.status
        if status == _HTTP_UNAUTHORIZED:
            return MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"mcp server '{self.server_name}' authentication failed",
                retryable=False,
            )
        if status is not None and status >= _HTTP_SERVER_ERROR:
            return MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"mcp server '{self.server_name}' returned http {status}",
                retryable=True,
            )
        if status is not None and status >= _HTTP_BAD_REQUEST:
            return MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"mcp server '{self.server_name}' returned http {status}",
                retryable=False,
            )
        # Connect / timeout / read / parse faults: retryable transport failures
        # map to SERVER_FAILED; content/shape faults to PROTOCOL_FAILED.
        if error.retryable:
            return MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"mcp server '{self.server_name}' request failed",
                retryable=True,
            )
        return MCPError(
            code=CMP_MCP_PROTOCOL_FAILED,
            message=f"mcp server '{self.server_name}' returned a malformed response",
            retryable=False,
        )

    def _send_notification(
        self,
        method: str,
        params: dict[str, Any],
        *,
        cancel_handle: Any = None,
    ) -> None:
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        try:
            notification_kwargs: dict[str, Any] = {
                "headers": self._headers(),
                "timeout_seconds": self._init_timeout(),
                "pinned_ip": self._pinned_ip,
            }
            if cancel_handle is not None:
                notification_kwargs["cancel_handle"] = cancel_handle
            post_notification(
                self._url,
                payload,
                **notification_kwargs,
            )
        except SSEHttpError as error:
            _raise_if_cancelled(cancel_handle, message="MCP HTTP request cancelled")
            raise self._map_http_error(error) from error

    def _capture_session_id(self, response: dict[str, Any]) -> None:
        # The session id is populated ONLY from the Mcp-Session-Id response
        # header inside post_jsonrpc (which strips any body-supplied value first),
        # surfaced under the reserved __mcp_session_id__ key.
        session_id = response.get("__mcp_session_id__")
        if isinstance(session_id, str) and session_id.strip():
            self._session_id = session_id.strip()

    def _raise_for_error(self, response: dict[str, Any]) -> None:
        error = response.get("error")
        if not isinstance(error, dict):
            return
        raw_message = error.get("message")
        # Bound the server-supplied message everywhere it reaches a log or error.
        message = (
            _bounded_server_message(raw_message)
            if raw_message
            else "mcp server returned an error"
        )
        error_code = CMP_MCP_SERVER_FAILED
        retryable = False
        data = error.get("data")
        if isinstance(data, dict):
            if isinstance(data.get("code"), str):
                error_code = str(data["code"])
            retryable = data.get("retryable") is True
        logger.warning("mcp call failed on server=%s message=%s", self.server_name, message)
        raise MCPError(code=error_code, message=message, retryable=retryable)
