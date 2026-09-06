"""Tests for the pluggable web-search provider layer."""

from __future__ import annotations

import json
import logging
import urllib.error
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from sidecar.ai.tools.builtins.web_http import (
    RedirectBlockedError,
    RedirectPolicyBlockedError,
    RedirectTargetInvalidError,
    UrlReadResult,
    ValidatedUrl,
    _NoRedirectHandler,
)
from sidecar.ai.tools.builtins.web_search_providers import (
    _MAX_POLICY_REASON_CHARS,
    _MAX_PROVIDER_RESPONSE_BYTES,
    _VENDOR_OPENER,
    BraveProvider,
    DuckDuckGoProvider,
    GooglePSEProvider,
    SearXNGProvider,
    SerperProvider,
    TavilyProvider,
    _request_json,
    build_provider_dispatch,
    citations_from_sources,
    filter_sources_by_domains,
    normalize_provider_keys,
)

_CANONICAL_KEYS = {
    "query",
    "provider",
    "answer",
    "error",
    "sources",
    "citations",
    "missing_source_metadata",
    "source_url",
}

# Vendors go through the no-redirect seam (their requests carry API keys, so
# a followed redirect would forward the credential to the redirect target).
_URLOPEN_PATCH = "sidecar.ai.tools.builtins.web_search_providers._vendor_urlopen"
_VALIDATE_PATCH = "sidecar.ai.tools.builtins.web_search_providers.validate_public_url"
# SearXNG uses the pinned/no-redirect fetch (web_http.read_url_response), not
# the vendor path the fixed-host providers use.
_READ_URL_PATCH = "sidecar.ai.tools.builtins.web_search_providers.read_url_response"
_PROVIDERS_LOGGER = "sidecar.ai.tools.builtins.web_search_providers"


def _url_read_result(body: bytes, *, status: int = 200, url: str = "https://searx.example.com/search") -> UrlReadResult:
    return UrlReadResult(
        payload=body,
        was_truncated=False,
        content_type="application/json",
        status_code=status,
        requested_url=url,
        final_url=url,
        redirect_chain=(),
    )


def _mock_response(body: bytes, status: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status = status
    resp.read.return_value = body
    resp.headers = {}
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _fake_ddg_search(query: str, **_kwargs: Any) -> dict[str, object]:
    return {
        "query": query,
        "provider": "duckduckgo",
        "answer": "ddg answer",
        "error": "",
        "sources": [],
        "citations": [],
        "missing_source_metadata": True,
        "source_url": "",
    }


def _dispatch(**overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "ddg_search": _fake_ddg_search,
        "searxng_url": None,
        "provider_keys": None,
    }
    kwargs.update(overrides)
    return dict(build_provider_dispatch(**kwargs))


def _search_kwargs(**overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "timeout_s": 5,
        "allowed_domains": None,
        "blocked_domains": None,
    }
    kwargs.update(overrides)
    return kwargs


def _searxng_body(result_count: int = 3, *, answers: list[Any] | None = None) -> bytes:
    return json.dumps(
        {
            "answers": answers if answers is not None else [],
            "results": [
                {
                    "url": f"https://example{i}.com/page",
                    "title": f"Result {i}",
                    "content": f"Snippet {i}",
                }
                for i in range(result_count)
            ],
        }
    ).encode()


class TestDispatchTable:
    def test_dispatch_contains_all_six_providers(self) -> None:
        dispatch = _dispatch()
        assert set(dispatch.keys()) == {
            "duckduckgo",
            "searxng",
            "brave",
            "tavily",
            "serper",
            "google_pse",
        }

    def test_every_provider_conforms_to_the_protocol(self) -> None:
        for name, impl in _dispatch().items():
            assert impl.name == name
            assert isinstance(impl.is_configured(), bool)
            assert callable(impl.search)

    def test_unknown_provider_lookup_returns_none_not_duckduckgo(self) -> None:
        dispatch = _dispatch()
        assert dispatch.get("bing") is None
        assert dispatch.get("") is None

    def test_provider_keys_configure_vendors(self) -> None:
        dispatch = _dispatch(
            searxng_url="https://searx.example.com",
            provider_keys={
                "brave": "bk",
                "tavily": "tk",
                "serper": "sk",
                "google_pse": "gk",
                "google_pse_cx": "cx1",
            },
        )
        for name in ("searxng", "brave", "tavily", "serper", "google_pse"):
            assert dispatch[name].is_configured() is True, name


class TestNormalizeProviderKeys:
    def test_non_mapping_becomes_empty(self) -> None:
        assert normalize_provider_keys(None) == {}
        assert normalize_provider_keys("brave=key") == {}
        assert normalize_provider_keys(["brave"]) == {}

    def test_blank_and_non_string_values_dropped(self) -> None:
        normalized = normalize_provider_keys(
            {"brave": "  key  ", "tavily": "", "serper": None, "google_pse": 42, "": "x"}
        )
        assert normalized == {"brave": "key"}


class TestSharedShapeHelpers:
    def test_citations_are_one_based_web_n(self) -> None:
        citations = citations_from_sources(
            [
                {"url": "https://a.com", "title": "A"},
                {"url": "https://b.com", "title": "B"},
            ]
        )
        assert [c["id"] for c in citations] == ["web:1", "web:2"]

    def test_citation_ids_track_source_index_like_the_historical_ddg_path(self) -> None:
        # Historical behavior (kept for parity): ids come from enumerate() over
        # the source list, so a skipped empty-URL source consumes an id. In
        # practice sources are URL-filtered before this point, so ids stay
        # contiguous on real payloads.
        citations = citations_from_sources(
            [
                {"url": "https://a.com", "title": "A"},
                {"url": "", "title": "skipped"},
                {"url": "https://b.com", "title": "B"},
            ]
        )
        assert [c["id"] for c in citations] == ["web:1", "web:3"]

    def test_filter_sources_by_domains(self) -> None:
        sources = [
            {"url": "https://docs.python.org/3/", "title": "docs"},
            {"url": "https://example.com/x", "title": "other"},
        ]
        kept = filter_sources_by_domains(
            sources,
            allowed_domains=("python.org",),
            blocked_domains=(),
        )
        assert [s["title"] for s in kept] == ["docs"]


class TestDuckDuckGoProvider:
    def test_always_configured(self) -> None:
        assert DuckDuckGoProvider(_fake_ddg_search).is_configured() is True

    def test_delegates_to_injected_search_and_normalizes_domains(self) -> None:
        seen: dict[str, Any] = {}

        def _recording(query: str, **kwargs: Any) -> dict[str, object]:
            seen["query"] = query
            seen.update(kwargs)
            return _fake_ddg_search(query)

        provider = DuckDuckGoProvider(_recording)
        payload = provider.search(
            "hello",
            **_search_kwargs(allowed_domains=["Python.org", " ", ""], blocked_domains=None),
        )
        assert payload["provider"] == "duckduckgo"
        assert seen["query"] == "hello"
        assert seen["timeout_s"] == 5
        assert seen["allowed_domains"] == ("python.org",)
        assert seen["blocked_domains"] == ()


class TestSearXNGProvider:
    def test_not_configured_without_base_url(self) -> None:
        assert SearXNGProvider(base_url=None).is_configured() is False
        assert SearXNGProvider(base_url="   ").is_configured() is False

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH)
    def test_happy_path_maps_to_canonical_shape(
        self, mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        full_url = "https://searx.example.com/search?q=test+query&format=json"
        mock_validate.return_value = ValidatedUrl(url=full_url, pinned_ip="93.184.216.34")
        mock_read.return_value = _url_read_result(
            _searxng_body(3, answers=["Direct answer."]), url=full_url
        )
        provider = SearXNGProvider(base_url="https://searx.example.com/")
        payload = provider.search("test query", **_search_kwargs())
        assert set(payload.keys()) == _CANONICAL_KEYS
        assert payload["provider"] == "searxng"
        assert payload["error"] == ""
        assert payload["answer"] == "Direct answer."
        sources = payload["sources"]
        assert isinstance(sources, list) and len(sources) == 3
        assert sources[0] == {
            "url": "https://example0.com/page",
            "title": "Result 0",
            "snippet": "Snippet 0",
            "source_type": "web",
        }
        citations = payload["citations"]
        assert isinstance(citations, list)
        assert citations[0]["id"] == "web:1"
        assert payload["missing_source_metadata"] is False
        assert payload["source_url"] == "https://example0.com/page"
        # The FULL request URL is what gets validated, and the pinned fetch
        # targets exactly the ValidatedUrl the validation returned.
        assert mock_validate.call_args[0][0] == full_url
        assert mock_read.call_args[0][0] is mock_validate.return_value

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_dict_style_answers_supported(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        mock_read.return_value = _url_read_result(
            _searxng_body(1, answers=[{"answer": "From dict."}])
        )
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs()
        )
        assert payload["answer"] == "From dict."

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_results_capped_at_eight(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        mock_read.return_value = _url_read_result(_searxng_body(12))
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs()
        )
        sources = payload["sources"]
        assert isinstance(sources, list) and len(sources) == 8

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_domain_filters_apply(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        mock_read.return_value = _url_read_result(_searxng_body(3))
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs(allowed_domains=["example1.com"])
        )
        sources = payload["sources"]
        assert isinstance(sources, list)
        assert [s["url"] for s in sources] == ["https://example1.com/page"]

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_unsafe_and_non_http_result_urls_dropped(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        body = json.dumps(
            {
                "results": [
                    {"url": "https://good.com/a", "title": "good", "content": "ok"},
                    {"url": "https://evil.com/b", "title": "evil", "content": "no"},
                    {"url": "ftp://files.example.com/c", "title": "ftp", "content": "no"},
                    {"url": "javascript:alert(1)", "title": "js", "content": "no"},
                ]
            }
        ).encode()
        mock_read.return_value = _url_read_result(body)
        provider = SearXNGProvider(
            base_url="https://searx.example.com",
            result_url_is_safe=lambda url: "evil" not in url,
        )
        payload = provider.search("q", **_search_kwargs())
        sources = payload["sources"]
        assert isinstance(sources, list)
        assert [s["url"] for s in sources] == ["https://good.com/a"]

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_empty_results_is_success_with_no_sources(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        mock_read.return_value = _url_read_result(_searxng_body(0))
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "obscure", **_search_kwargs()
        )
        assert payload["error"] == ""
        assert payload["sources"] == []
        assert payload["missing_source_metadata"] is True
        assert payload["answer"] == "No results found for 'obscure'."

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_http_error_fails_closed(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        mock_read.side_effect = urllib.error.HTTPError(
            "https://searx.example.com/search", 502, "Bad Gateway", None, None
        )
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs()
        )
        assert payload["error"] == "searxng search failed: HTTP 502"
        assert payload["sources"] == []
        assert payload["citations"] == []
        assert payload["missing_source_metadata"] is True

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_non_200_status_fails_closed(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        mock_read.return_value = _url_read_result(b"{}", status=503)
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs()
        )
        assert payload["error"] == "searxng search failed: HTTP 503"

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_blocked_redirect_fails_closed(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        # A SearXNG instance answering 302 -> private/metadata target is
        # rejected by the pinned fetch's per-hop revalidation, never followed.
        mock_read.side_effect = RedirectBlockedError("redirect target blocked")
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs()
        )
        assert payload["error"] == "searxng search failed: redirect blocked"

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_redirect_into_rejected_range_reports_a_policy_block(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        # A hop the safety policy rejects is settled, not transient — it must not
        # come back as the generic "network error" the model would retry.
        mock_read.side_effect = RedirectPolicyBlockedError(
            "Redirect destination was rejected by the URL safety policy."
        )
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs()
        )
        assert payload["error"] == (
            "searxng search failed: redirect destination was rejected "
            "by the URL safety policy."
        )
        assert "network error" not in payload["error"]

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_redirect_to_unusable_url_reports_a_policy_block(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        # Collapsed into one message, matching how the first-hop check treats
        # PermissionError and ValueError identically.
        mock_read.side_effect = RedirectTargetInvalidError(
            "Redirect destination was not a valid, resolvable URL."
        )
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs()
        )
        assert payload["error"] == (
            "searxng search failed: redirect destination was rejected "
            "by the URL safety policy."
        )

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_malformed_json_fails_closed(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        mock_read.return_value = _url_read_result(b"<html>not json</html>")
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs()
        )
        assert payload["error"] == "searxng search failed: malformed JSON response"

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_timeout_fails_closed(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        mock_read.side_effect = TimeoutError("timed out")
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs()
        )
        assert payload["error"] == "searxng search failed: network error"

    @patch(_READ_URL_PATCH)
    def test_ssrf_loopback_base_url_rejected_before_any_request(
        self, mock_read: MagicMock
    ) -> None:
        # Real validate_public_url: IP-literal checks are pure (no DNS).
        payload = SearXNGProvider(base_url="http://127.0.0.1:9999").search(
            "q", **_search_kwargs()
        )
        assert payload["error"] == "searxng base URL was rejected by the URL safety policy."
        assert payload["sources"] == []
        mock_read.assert_not_called()

    @patch(_READ_URL_PATCH)
    def test_ssrf_metadata_ip_base_url_rejected_before_any_request(
        self, mock_read: MagicMock
    ) -> None:
        payload = SearXNGProvider(base_url="http://169.254.169.254/").search(
            "q", **_search_kwargs()
        )
        assert payload["error"] == "searxng base URL was rejected by the URL safety policy."
        mock_read.assert_not_called()

    # The user-facing payload for a rejected base URL is deliberately generic,
    # so the WARN log is the only place the reason survives. Without it a
    # self-hosted instance on a private/CGNAT address is refused with no
    # recoverable explanation.
    @patch(_READ_URL_PATCH)
    def test_rejected_base_url_logs_the_address_policy_reason(
        self, mock_read: MagicMock, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.WARNING, logger=_PROVIDERS_LOGGER):
            SearXNGProvider(base_url="http://127.0.0.1:9999").search(
                "q", **_search_kwargs()
            )
        assert "Private or local IP addresses are blocked." in caplog.text
        assert "searxng" in caplog.text
        mock_read.assert_not_called()

    @patch(_READ_URL_PATCH)
    def test_rejected_base_url_logs_the_scheme_policy_reason(
        self, mock_read: MagicMock, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.WARNING, logger=_PROVIDERS_LOGGER):
            SearXNGProvider(base_url="ftp://searx.example.com").search(
                "q", **_search_kwargs()
            )
        assert "Only http and https URLs are allowed." in caplog.text
        mock_read.assert_not_called()

    @patch(_READ_URL_PATCH)
    def test_rejected_base_url_log_omits_embedded_credentials(
        self, mock_read: MagicMock, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.WARNING, logger=_PROVIDERS_LOGGER):
            SearXNGProvider(base_url="https://user:hunter2@searx.example.com").search(
                "q", **_search_kwargs()
            )
        assert "URLs with embedded credentials are not allowed." in caplog.text
        assert "hunter2" not in caplog.text
        assert "searx.example.com" not in caplog.text
        mock_read.assert_not_called()

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH)
    def test_rejected_base_url_log_omits_the_resolved_host(
        self,
        mock_validate: MagicMock,
        mock_read: MagicMock,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        # validate_public_url appends the offending host to its resolution
        # failures; the reason must survive into the log while the host does not.
        mock_validate.side_effect = ValueError(
            "Hostname resolution failed: searx.internal.example"
        )
        with caplog.at_level(logging.WARNING, logger=_PROVIDERS_LOGGER):
            SearXNGProvider(base_url="https://searx.internal.example").search(
                "q", **_search_kwargs()
            )
        assert "Hostname resolution failed" in caplog.text
        assert "searx.internal.example" not in caplog.text
        mock_read.assert_not_called()

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH)
    def test_rejected_base_url_log_bounds_an_unexpected_reason(
        self,
        mock_validate: MagicMock,
        mock_read: MagicMock,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        mock_validate.side_effect = PermissionError("z" * 500)
        with caplog.at_level(logging.WARNING, logger=_PROVIDERS_LOGGER):
            SearXNGProvider(base_url="https://searx.example.com").search(
                "q", **_search_kwargs()
            )
        assert "z" * _MAX_POLICY_REASON_CHARS in caplog.text
        assert "z" * (_MAX_POLICY_REASON_CHARS + 1) not in caplog.text
        mock_read.assert_not_called()

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH)
    def test_rejected_base_url_log_falls_back_to_the_exception_type(
        self,
        mock_validate: MagicMock,
        mock_read: MagicMock,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        mock_validate.side_effect = PermissionError()
        with caplog.at_level(logging.WARNING, logger=_PROVIDERS_LOGGER):
            SearXNGProvider(base_url="https://searx.example.com").search(
                "q", **_search_kwargs()
            )
        assert "PermissionError" in caplog.text
        mock_read.assert_not_called()

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH)
    def test_all_url_policy_rejection_reasons_stay_host_free(
        self,
        mock_validate: MagicMock,
        mock_read: MagicMock,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        # Every reason validate_public_url can raise, pinned host-free: a new
        # message that appends the host after a colon must stay redacted.
        host = "searx.internal.example"
        for raised, expected in (
            (ValueError("URL must not be empty."), "URL must not be empty."),
            (
                ValueError("Only http and https URLs are allowed."),
                "Only http and https URLs are allowed.",
            ),
            (
                ValueError("URLs with embedded credentials are not allowed."),
                "URLs with embedded credentials are not allowed.",
            ),
            (ValueError("URL must include a hostname."), "URL must include a hostname."),
            (
                PermissionError("Localhost addresses are blocked."),
                "Localhost addresses are blocked.",
            ),
            (
                PermissionError("Local network hostnames are blocked."),
                "Local network hostnames are blocked.",
            ),
            (
                PermissionError("Private or local IP addresses are blocked."),
                "Private or local IP addresses are blocked.",
            ),
            (
                ValueError(f"Hostname resolution failed: {host}"),
                "Hostname resolution failed",
            ),
            (
                ValueError(f"Hostname resolution returned no addresses: {host}"),
                "Hostname resolution returned no addresses",
            ),
            (
                ValueError(f"Hostname resolution returned no usable addresses: {host}"),
                "Hostname resolution returned no usable addresses",
            ),
        ):
            caplog.clear()
            mock_validate.side_effect = raised
            with caplog.at_level(logging.WARNING, logger=_PROVIDERS_LOGGER):
                SearXNGProvider(base_url=f"https://{host}").search(
                    "q", **_search_kwargs()
                )
            assert expected in caplog.text
            assert host not in caplog.text
        mock_read.assert_not_called()

    @patch(_READ_URL_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://searx.example.com", pinned_ip=""))
    def test_domain_filter_applies_before_result_cap(
        self, _mock_validate: MagicMock, mock_read: MagicMock
    ) -> None:
        # SearXNG returns the instance's full result list (no server-side count
        # param), so an allowed domain that only appears past position 8 must
        # still survive: filter first, cap after.
        mock_read.return_value = _url_read_result(_searxng_body(20))
        payload = SearXNGProvider(base_url="https://searx.example.com").search(
            "q", **_search_kwargs(allowed_domains=["example15.com"])
        )
        assert payload["error"] == ""
        sources = payload["sources"]
        assert isinstance(sources, list)
        assert [s["url"] for s in sources] == ["https://example15.com/page"]

    @patch(_READ_URL_PATCH)
    def test_allow_private_addresses_permits_loopback_instance(
        self, mock_read: MagicMock
    ) -> None:
        # The existing tools_web_allow_private_addresses decision applies to a
        # loopback SearXNG instance too — no SearXNG-specific bypass, and the
        # allow-private choice is forwarded into the pinned fetch as well.
        mock_read.return_value = _url_read_result(_searxng_body(1))
        provider = SearXNGProvider(
            base_url="http://127.0.0.1:8080",
            allow_private_addresses=True,
        )
        payload = provider.search("q", **_search_kwargs())
        assert payload["error"] == ""
        mock_read.assert_called_once()
        assert mock_read.call_args.kwargs["allow_private"] is True


class TestVendorHttpPosture:
    """The shared vendor request path must never leak keys via redirects or
    buffer unbounded response bodies."""

    def test_vendor_opener_never_follows_redirects(self) -> None:
        # Structural pin: the real opener's only redirect handler is the
        # raise-on-3xx one, so a vendor 302 can never re-issue the request
        # (and its key headers) to the redirect target.
        redirect_handlers = [
            handler
            for handler in _VENDOR_OPENER.handlers
            if isinstance(handler, urllib.request.HTTPRedirectHandler)
        ]
        assert redirect_handlers, "expected an explicit redirect handler"
        assert all(isinstance(handler, _NoRedirectHandler) for handler in redirect_handlers)

    @patch(_URLOPEN_PATCH)
    def test_redirect_fails_closed_with_key_free_error(self, mock_open: MagicMock) -> None:
        mock_open.side_effect = urllib.error.HTTPError(
            "https://api.search.brave.com/res/v1/web/search", 302, "Found", None, None
        )
        payload = BraveProvider(api_key="brave-key-123").search("q", **_search_kwargs())
        assert payload["error"] == "brave search failed: redirect blocked"
        assert "brave-key-123" not in json.dumps(payload)

    @patch(_URLOPEN_PATCH)
    def test_oversized_response_fails_closed(self, mock_open: MagicMock) -> None:
        oversized = b"x" * (_MAX_PROVIDER_RESPONSE_BYTES + 1)
        mock_open.return_value = _mock_response(oversized)
        payload = TavilyProvider(api_key="tavily-key-123").search("q", **_search_kwargs())
        assert payload["error"] == "tavily search failed: response too large"
        assert "tavily-key-123" not in json.dumps(payload)

    @patch(_URLOPEN_PATCH)
    def test_request_json_reads_no_more_than_the_response_bound(
        self, mock_open: MagicMock
    ) -> None:
        response = _mock_response(json.dumps({"ok": True}).encode())
        mock_open.return_value = response
        data = _request_json("https://api.tavily.com/search", timeout_s=5, provider="tavily")
        assert data == {"ok": True}
        response.read.assert_called_once_with(_MAX_PROVIDER_RESPONSE_BYTES + 1)


class TestBraveProvider:
    def test_not_configured_without_key(self) -> None:
        assert BraveProvider(api_key=None).is_configured() is False
        assert BraveProvider(api_key="  ").is_configured() is False

    @patch(_URLOPEN_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://api.search.brave.com", pinned_ip=""))
    def test_happy_path(self, _mock_validate: MagicMock, mock_urlopen: MagicMock) -> None:
        body = json.dumps(
            {
                "web": {
                    "results": [
                        {
                            "url": "https://a.com/1",
                            "title": "A",
                            "description": "About A",
                        }
                    ]
                }
            }
        ).encode()
        mock_urlopen.return_value = _mock_response(body)
        payload = BraveProvider(api_key="brave-key").search("q", **_search_kwargs())
        assert set(payload.keys()) == _CANONICAL_KEYS
        assert payload["error"] == ""
        sources = payload["sources"]
        assert isinstance(sources, list)
        assert sources[0]["snippet"] == "About A"
        # Answer falls back to the first snippet when the API has no answer field.
        assert payload["answer"] == "About A"
        request = mock_urlopen.call_args[0][0]
        assert request.get_header("X-subscription-token") == "brave-key"

    @patch(_URLOPEN_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://api.search.brave.com", pinned_ip=""))
    def test_malformed_response_fails_closed(
        self, _mock_validate: MagicMock, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _mock_response(b"[]")
        payload = BraveProvider(api_key="brave-key").search("q", **_search_kwargs())
        assert payload["error"] == "brave search failed: unexpected response shape"


class TestTavilyProvider:
    def test_not_configured_without_key(self) -> None:
        assert TavilyProvider(api_key=None).is_configured() is False

    @patch(_URLOPEN_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://api.tavily.com", pinned_ip=""))
    def test_happy_path_uses_answer_and_posts_json(
        self, _mock_validate: MagicMock, mock_urlopen: MagicMock
    ) -> None:
        body = json.dumps(
            {
                "answer": "Tavily answer.",
                "results": [
                    {"url": "https://t.com/1", "title": "T", "content": "Tavily snippet"}
                ],
            }
        ).encode()
        mock_urlopen.return_value = _mock_response(body)
        payload = TavilyProvider(api_key="tavily-key").search("q", **_search_kwargs())
        assert payload["answer"] == "Tavily answer."
        assert payload["error"] == ""
        request = mock_urlopen.call_args[0][0]
        assert request.get_header("Authorization") == "Bearer tavily-key"
        sent = json.loads(request.data.decode("utf-8"))
        assert sent["query"] == "q"

    @patch(_URLOPEN_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://api.tavily.com", pinned_ip=""))
    def test_http_error_fails_closed(
        self, _mock_validate: MagicMock, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "https://api.tavily.com/search", 401, "Unauthorized", None, None
        )
        payload = TavilyProvider(api_key="bad").search("q", **_search_kwargs())
        assert payload["error"] == "tavily search failed: HTTP 401"


class TestSerperProvider:
    def test_not_configured_without_key(self) -> None:
        assert SerperProvider(api_key="").is_configured() is False

    @patch(_URLOPEN_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://google.serper.dev", pinned_ip=""))
    def test_happy_path_with_answer_box(
        self, _mock_validate: MagicMock, mock_urlopen: MagicMock
    ) -> None:
        body = json.dumps(
            {
                "answerBox": {"answer": "42"},
                "organic": [
                    {"link": "https://s.com/1", "title": "S", "snippet": "Serper snippet"}
                ],
            }
        ).encode()
        mock_urlopen.return_value = _mock_response(body)
        payload = SerperProvider(api_key="serper-key").search("q", **_search_kwargs())
        assert payload["answer"] == "42"
        sources = payload["sources"]
        assert isinstance(sources, list)
        assert sources[0]["url"] == "https://s.com/1"
        request = mock_urlopen.call_args[0][0]
        assert request.get_header("X-api-key") == "serper-key"

    @patch(_URLOPEN_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://google.serper.dev", pinned_ip=""))
    def test_malformed_json_fails_closed(
        self, _mock_validate: MagicMock, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _mock_response(b"oops")
        payload = SerperProvider(api_key="serper-key").search("q", **_search_kwargs())
        assert payload["error"] == "serper search failed: malformed JSON response"


class TestGooglePSEProvider:
    def test_requires_both_key_and_cx(self) -> None:
        assert GooglePSEProvider(api_key="k", cx=None).is_configured() is False
        assert GooglePSEProvider(api_key=None, cx="cx").is_configured() is False
        assert GooglePSEProvider(api_key="k", cx="cx").is_configured() is True

    @patch(_URLOPEN_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://www.googleapis.com", pinned_ip=""))
    def test_happy_path(self, _mock_validate: MagicMock, mock_urlopen: MagicMock) -> None:
        body = json.dumps(
            {
                "items": [
                    {"link": "https://g.com/1", "title": "G", "snippet": "PSE snippet"}
                ]
            }
        ).encode()
        mock_urlopen.return_value = _mock_response(body)
        payload = GooglePSEProvider(api_key="gkey", cx="gcx").search("q", **_search_kwargs())
        assert payload["error"] == ""
        sources = payload["sources"]
        assert isinstance(sources, list)
        assert sources[0]["url"] == "https://g.com/1"
        request = mock_urlopen.call_args[0][0]
        assert "key=gkey" in request.full_url
        assert "cx=gcx" in request.full_url
        # The credential-free base endpoint is what gets validated.
        assert _mock_validate.call_args[0][0] == "https://www.googleapis.com/customsearch/v1"

    @patch(_URLOPEN_PATCH)
    @patch(_VALIDATE_PATCH, return_value=ValidatedUrl(url="https://www.googleapis.com", pinned_ip=""))
    def test_http_error_message_contains_no_key_material(
        self, _mock_validate: MagicMock, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "https://www.googleapis.com/customsearch/v1?key=gkey", 403, "Forbidden", None, None
        )
        payload = GooglePSEProvider(api_key="gkey", cx="gcx").search("q", **_search_kwargs())
        assert payload["error"] == "google_pse search failed: HTTP 403"
        assert "gkey" not in json.dumps(payload)
