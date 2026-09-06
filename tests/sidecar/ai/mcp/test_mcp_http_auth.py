"""Red-first tests for the OAuth 2.1 client-credentials token mint + cache."""

from __future__ import annotations

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

import pytest

from sidecar.ai.config import MCPServerAuth
from sidecar.ai.error_codes import CMP_MCP_CONFIG_INVALID, CMP_MCP_SERVER_FAILED
from sidecar.ai.mcp import mcp_http_auth
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.mcp_http_auth import ClientCredentialsTokenSource
from sidecar.ai.tools.builtins.web_http import (
    ValidatedUrl,
)
from sidecar.ai.tools.builtins.web_http import (
    validate_public_url as _REAL_VALIDATE_PUBLIC_URL,
)

_SECRET = "super-secret-value-xyz"


class _TokenHandler(BaseHTTPRequestHandler):
    responder: Callable[["_TokenHandler", dict[str, str]], None]

    def log_message(self, *args: Any) -> None:
        return

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        form = {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode("utf-8")).items()}
        self.server.responder(self, form)  # type: ignore[attr-defined]

    def do_GET(self) -> None:  # noqa: N802
        # A redirect-following client converts the 302 POST into a GET; the
        # redirect-target hit counter must see those too (exploit detection).
        self.server.responder(self, {})  # type: ignore[attr-defined]


class _TokenServer:
    def __init__(self, responder: Callable[[_TokenHandler, dict[str, str]], None]) -> None:
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), _TokenHandler)
        self._httpd.responder = responder  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}/token"

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=2.0)


@pytest.fixture()
def make_token_server() -> Any:
    servers: list[_TokenServer] = []

    def _make(responder: Callable[[_TokenHandler, dict[str, str]], None]) -> _TokenServer:
        server = _TokenServer(responder)
        servers.append(server)
        return server

    yield _make
    for server in servers:
        server.shutdown()


@pytest.fixture(autouse=True)
def allow_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    # The token endpoint binds loopback; bypass the SSRF address check but return
    # a real ValidatedUrl pinned at loopback so the no-redirect pinned opener
    # still connects to the fake server.
    monkeypatch.setattr(
        mcp_http_auth,
        "validate_public_url",
        lambda url, *, allow_private=False: ValidatedUrl(url=url, pinned_ip="127.0.0.1"),
    )


def _write_token(handler: _TokenHandler, body: dict[str, Any], *, status: int = 200) -> None:
    raw = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def _auth(token_url: str, *, scope: str | None = None) -> MCPServerAuth:
    return MCPServerAuth(
        kind="oauth_client_credentials",
        token_url=token_url,
        client_id="client-abc",
        client_secret=_SECRET,
        scope=scope,
    )


def test_happy_mint_returns_access_token(make_token_server: Any) -> None:
    def responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        assert form["grant_type"] == "client_credentials"
        assert form["client_id"] == "client-abc"
        assert form["client_secret"] == _SECRET
        _write_token(handler, {"access_token": "minted-1", "expires_in": 3600})

    server = make_token_server(responder)
    source = ClientCredentialsTokenSource(_auth(server.url), server_name="remote")
    assert source.token() == "minted-1"


def test_scope_passthrough(make_token_server: Any) -> None:
    seen: list[dict[str, str]] = []

    def responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        seen.append(form)
        _write_token(handler, {"access_token": "minted-2", "expires_in": 3600})

    server = make_token_server(responder)
    source = ClientCredentialsTokenSource(_auth(server.url, scope="a b"), server_name="remote")
    source.token()
    assert seen[0]["scope"] == "a b"


def test_cache_hit_within_expiry(make_token_server: Any) -> None:
    mint_count = {"n": 0}

    def responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        mint_count["n"] += 1
        _write_token(handler, {"access_token": f"minted-{mint_count['n']}", "expires_in": 3600})

    server = make_token_server(responder)
    source = ClientCredentialsTokenSource(_auth(server.url), server_name="remote")
    first = source.token()
    second = source.token()
    assert first == second == "minted-1"
    assert mint_count["n"] == 1


def test_remint_after_invalidation(make_token_server: Any) -> None:
    mint_count = {"n": 0}

    def responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        mint_count["n"] += 1
        _write_token(handler, {"access_token": f"minted-{mint_count['n']}", "expires_in": 3600})

    server = make_token_server(responder)
    source = ClientCredentialsTokenSource(_auth(server.url), server_name="remote")
    first = source.token()
    source.invalidate()
    second = source.token()
    assert first == "minted-1"
    assert second == "minted-2"
    assert mint_count["n"] == 2


def test_missing_expires_in_uses_conservative_default(make_token_server: Any) -> None:
    mint_count = {"n": 0}

    def responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        mint_count["n"] += 1
        _write_token(handler, {"access_token": f"minted-{mint_count['n']}"})

    server = make_token_server(responder)
    source = ClientCredentialsTokenSource(_auth(server.url), server_name="remote")
    # No expires_in: still cached (conservative default), so a second call reuses it.
    source.token()
    source.token()
    assert mint_count["n"] == 1


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
def test_token_response_rejects_nonfinite_json_constants(token: str) -> None:
    source = ClientCredentialsTokenSource(
        _auth("https://issuer.example/token"), server_name="remote"
    )
    raw = f'{{"access_token":"minted","expires_in":{token}}}'.encode()

    with pytest.raises(MCPError) as excinfo:
        source._parse_token_response(raw)  # noqa: SLF001

    assert excinfo.value.code == "CMP-MCP-0004"


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf"), -1])
def test_invalid_oauth_lifetime_uses_bounded_default(value: object) -> None:
    source = ClientCredentialsTokenSource(
        _auth("https://issuer.example/token"), server_name="remote"
    )

    assert source._resolve_lifetime(value) == 270.0  # noqa: SLF001


def test_oauth_lifetime_is_capped_before_expiry_skew() -> None:
    source = ClientCredentialsTokenSource(
        _auth("https://issuer.example/token"), server_name="remote"
    )

    assert source._resolve_lifetime(10**12) == 86_370.0  # noqa: SLF001


def test_mint_failure_raises_structured_error_without_secret(make_token_server: Any) -> None:
    def responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        _write_token(handler, {"error": "invalid_client"}, status=401)

    server = make_token_server(responder)
    source = ClientCredentialsTokenSource(_auth(server.url), server_name="remote")
    with pytest.raises(MCPError) as excinfo:
        source.token()
    assert _SECRET not in str(excinfo.value)
    assert "remote" in str(excinfo.value)


def test_token_url_ssrf_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    def reject(url: str, *, allow_private: bool = False) -> None:
        raise PermissionError("Private or local IP addresses are blocked.")

    monkeypatch.setattr(mcp_http_auth, "validate_public_url", reject)
    source = ClientCredentialsTokenSource(
        _auth("http://127.0.0.1:9/token"),
        server_name="remote",
    )
    with pytest.raises(MCPError) as excinfo:
        source.token()
    assert _SECRET not in str(excinfo.value)


def test_token_url_private_rejected_by_default_with_real_validator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Real validator, no opt-in: a CGNAT (100.64.0.0/10) issuer is refused before
    # the client_secret can leave the process.
    monkeypatch.undo()
    source = ClientCredentialsTokenSource(
        _auth("http://100.64.0.1:9/token"),
        server_name="remote",
    )
    with pytest.raises(MCPError) as excinfo:
        source.token()
    assert excinfo.value.code == CMP_MCP_CONFIG_INVALID
    assert _SECRET not in str(excinfo.value)


def test_token_url_private_allowed_when_owner_opts_in(make_token_server: Any) -> None:
    # allow_private_addresses mirrors tools_web_allow_private_addresses: a
    # self-hosted issuer on a private/CGNAT address mints end to end against the
    # REAL validator (the autouse loopback bypass is removed first).
    def responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        _write_token(handler, {"access_token": "minted-private", "expires_in": 3600})

    server = make_token_server(responder)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(mcp_http_auth, "validate_public_url", _REAL_VALIDATE_PUBLIC_URL)
        source = ClientCredentialsTokenSource(
            _auth(server.url),
            server_name="remote",
            allow_private_addresses=True,
        )
        assert source.token() == "minted-private"


def test_token_url_opt_in_still_refuses_redirects(make_token_server: Any) -> None:
    # allow_private_addresses relaxes ONLY the address-class check. A private
    # issuer that 302s is still refused -- the redirect guard is not weakened.
    def responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        handler.send_response(302)
        handler.send_header("Location", "http://169.254.169.254/latest/meta-data/")
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    server = make_token_server(responder)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(mcp_http_auth, "validate_public_url", _REAL_VALIDATE_PUBLIC_URL)
        source = ClientCredentialsTokenSource(
            _auth(server.url),
            server_name="remote",
            allow_private_addresses=True,
        )
        with pytest.raises(MCPError) as excinfo:
            source.token()
    assert excinfo.value.code == CMP_MCP_SERVER_FAILED
    assert _SECRET not in str(excinfo.value)


def test_secret_never_in_repr() -> None:
    source = ClientCredentialsTokenSource(_auth("https://issuer.example/token"), server_name="remote")
    assert _SECRET not in repr(source)


def test_mint_redirect_is_refused_and_target_never_hit(make_token_server: Any) -> None:
    # SSRF hardening: a token endpoint that 302s (e.g. toward a metadata IP)
    # must fail closed as a structured MCPError; the redirect target must
    # NEVER be requested.
    target_hits = {"n": 0}

    def target_responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        target_hits["n"] += 1
        _write_token(handler, {"access_token": "evil-minted", "expires_in": 3600})

    target = make_token_server(target_responder)

    def redirect_responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        handler.send_response(302)
        handler.send_header("Location", target.url)
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    issuer = make_token_server(redirect_responder)
    source = ClientCredentialsTokenSource(_auth(issuer.url), server_name="remote")
    with pytest.raises(MCPError) as excinfo:
        source.token()
    assert target_hits["n"] == 0
    assert _SECRET not in str(excinfo.value)


def test_mint_3xx_maps_to_structured_error(make_token_server: Any) -> None:
    target_hits = {"n": 0}

    def target_responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        target_hits["n"] += 1
        _write_token(handler, {"access_token": "evil-minted", "expires_in": 3600})

    target = make_token_server(target_responder)

    def responder(handler: _TokenHandler, form: dict[str, str]) -> None:
        handler.send_response(301)
        handler.send_header("Location", target.url)
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    server = make_token_server(responder)
    source = ClientCredentialsTokenSource(_auth(server.url), server_name="remote")
    with pytest.raises(MCPError) as excinfo:
        source.token()
    assert excinfo.value.code == "CMP-MCP-0004"  # CMP_MCP_SERVER_FAILED
    assert target_hits["n"] == 0
    assert _SECRET not in str(excinfo.value)
