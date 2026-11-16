"""Gate sitting 2026-11-14 (G3): fetch_url trusts certifi's roots as well as the OS store.

The pinned HTTPS connection built ``ssl.create_default_context()``, which on Windows loads only
the roots already cached in the machine store; Python never fetches a missing root the way
Windows does on demand. https://example.com/ failed with CERTIFICATE_VERIFY_FAILED on the
owner's machine while certifi (the bundle the engine clients already use) verified it.
"""

from __future__ import annotations

import ssl
import urllib.request
from typing import Any

import certifi
import pytest

from sidecar.ai.tools.builtins import web_http


def _bundle_count() -> int:
    with open(certifi.where(), encoding="ascii", errors="ignore") as handle:
        return handle.read().count("BEGIN CERTIFICATE")


def test_default_tls_context_trusts_certifi_roots_and_verifies() -> None:
    context = web_http._default_tls_context()
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    assert context.cert_store_stats()["x509_ca"] >= _bundle_count()
    assert web_http._default_tls_context() is context, "built once, shared"


def test_pinned_https_handler_hands_the_shared_context_to_its_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real path: the opener's handler builds the connection; http.client would otherwise
    fill a missing context with its own OS-store default (the first fix missed this)."""
    seen: list[Any] = []

    def fake_do_open(self: Any, http_class: Any, req: Any, **kwargs: Any) -> Any:
        connection = http_class("example.com", timeout=1, **kwargs)  # as urllib's do_open does
        seen.append(connection._context)
        raise RuntimeError("stop before dialing")

    monkeypatch.setattr(web_http._PinnedHTTPSHandler, "do_open", fake_do_open)
    handler = web_http._PinnedHTTPSHandler("93.184.215.14")
    request = urllib.request.Request("https://example.com/")
    with pytest.raises(RuntimeError):
        handler.https_open(request)
    assert seen == [web_http._default_tls_context()]
