"""Pluggable web-search providers behind a single dispatch table.

`web.py` owns the `web_search` tool handler, rate limiting, argument validation,
and the DuckDuckGo implementation. This module owns the ``WebSearchProvider``
protocol, concrete provider implementations, and ``build_provider_dispatch``,
which assembles the name -> provider table `web.py` dispatches on.

Contract (frozen — the citations feature consumes this shape verbatim):
every provider's ``search`` returns exactly::

    {
        "query": str,
        "provider": str,          # the provider key that answered
        "answer": str,            # short answer/snippet if available, else ""
        "error": str,             # non-empty only on failure
        "sources": [{"url", "title", "snippet", "source_type"}],
        "citations": [{"id": "web:N", "url", "title"}],   # N is 1-based
        "missing_source_metadata": bool,
        "source_url": str,        # first citation URL or ""
    }

Providers never raise across the ``search`` boundary: unsupported config,
upstream failures, malformed JSON, and timeouts all come back as this same
payload with a non-empty ``error`` and ``sources``/``citations`` emptied.
Providers must not cache responses.

SearXNG note: the provider is a client for an instance the user already runs;
it targets the documented ``GET {base_url}/search?q=<query>&format=json``
JSON API (``results[].url/title/content`` plus optional ``answers[]``).
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from sidecar.ai.tools.builtins.web_http import (
    _BROWSER_USER_AGENT,
    RedirectBlockedError,
    RedirectPolicyBlockedError,
    RedirectTargetInvalidError,
    _NoRedirectHandler,
    read_url_response,
    validate_public_url,
)
from sidecar.ai.tools.sanitization import sanitize_tool_output

logger = logging.getLogger(__name__)

# Result/answer bounds mirror the DuckDuckGo path in `web.py`
# (`_DDG_HTML_MAX_RESULTS`, `_DEFAULT_SEARCH_MAX_CHARS`, and the 300/500-char
# title/snippet caps) so no provider returns a larger payload than DDG would.
_MAX_PROVIDER_RESULTS = 8
_MAX_ANSWER_CHARS = 4000
_MAX_TITLE_CHARS = 300
_MAX_SNIPPET_CHARS = 500
# Response-size bound for every provider fetch — the pinned SearXNG path and
# the vendor path both refuse bodies past this (mirrors the default
# tools_web_max_fetch_bytes bound used by fetch_url).
_MAX_PROVIDER_RESPONSE_BYTES = 1_048_576
# Bound on the logged reason for a URL-policy rejection; the in-tree reasons
# are all well under this, so the cap only ever truncates an unexpected one.
_MAX_POLICY_REASON_CHARS = 120

_SEARXNG_PROVIDER = "searxng"
_BRAVE_PROVIDER = "brave"
_TAVILY_PROVIDER = "tavily"
_SERPER_PROVIDER = "serper"
_GOOGLE_PSE_PROVIDER = "google_pse"

_BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search"
_TAVILY_API_URL = "https://api.tavily.com/search"
_SERPER_API_URL = "https://google.serper.dev/search"
_GOOGLE_PSE_API_URL = "https://www.googleapis.com/customsearch/v1"

_HTTP_SUCCESS = 200
_HTTP_REDIRECT_MIN = 300
_HTTP_CLIENT_ERROR_MIN = 400


@dataclass(frozen=True)
class _ProviderHttpRequest:
    url: str
    method: str = "GET"
    headers: Mapping[str, str] | None = None
    body: bytes | None = None


@dataclass(frozen=True)
class _ProviderSearchRequest:
    query: str
    provider: str
    allowed_domains: list[str] | None
    blocked_domains: list[str] | None
    result_url_is_safe: Callable[[str], bool]


class WebSearchProvider(Protocol):
    """A pluggable `web_search` backend.

    ``is_configured`` must be cheap and network-free; ``search`` is a blocking
    call bounded by ``timeout_s`` that returns the canonical payload above and
    never raises.
    """

    name: str

    def is_configured(self) -> bool: ...

    def search(
        self,
        query: str,
        *,
        timeout_s: int,
        allowed_domains: list[str] | None,
        blocked_domains: list[str] | None,
    ) -> dict[str, object]: ...


# ---------------------------------------------------------------------------
# Canonical-shape helpers (shared with `web.py`, which imports them back so
# the DuckDuckGo path and the new providers build citations/filters from the
# exact same code)
# ---------------------------------------------------------------------------


def _host_matches_domain(host: str, domain: str) -> bool:
    return host == domain or host.endswith(f".{domain}")


def _source_host(url: str) -> str:
    return str(urllib.parse.urlparse(url).hostname or "").strip().lower()


def source_allowed_by_domains(
    url: str,
    *,
    allowed_domains: tuple[str, ...],
    blocked_domains: tuple[str, ...],
) -> bool:
    """Return True when *url*'s host passes the allow/block domain filters."""
    host = _source_host(url)
    if not host:
        return False
    if blocked_domains and any(_host_matches_domain(host, domain) for domain in blocked_domains):
        return False
    if not allowed_domains:
        return True
    return any(_host_matches_domain(host, domain) for domain in allowed_domains)


def filter_sources_by_domains(
    sources: list[dict[str, str]],
    *,
    allowed_domains: tuple[str, ...],
    blocked_domains: tuple[str, ...],
) -> list[dict[str, str]]:
    if not allowed_domains and not blocked_domains:
        return list(sources)
    return [
        source
        for source in sources
        if source_allowed_by_domains(
            str(source.get("url") or ""),
            allowed_domains=allowed_domains,
            blocked_domains=blocked_domains,
        )
    ]


def citations_from_sources(sources: list[dict[str, str]]) -> list[dict[str, str]]:
    """Build 1-based ``web:N`` citations — identical to the historical DDG path."""
    citations: list[dict[str, str]] = []
    for idx, source in enumerate(list(sources or []), start=1):
        url = str(source.get("url", "") or "").strip()
        if not url:
            continue
        citations.append(
            {
                "id": f"web:{idx}",
                "url": url,
                "title": str(source.get("title", "") or "").strip(),
            }
        )
    return citations


def _canonical_payload(
    *,
    query: str,
    provider: str,
    answer: str = "",
    error: str = "",
    sources: list[dict[str, str]] | None = None,
) -> dict[str, object]:
    resolved_sources = list(sources or [])
    resolved_citations = citations_from_sources(resolved_sources)
    source_url = str(resolved_citations[0].get("url", "") if resolved_citations else "")
    return {
        "query": query,
        "provider": provider,
        "answer": answer,
        "error": error,
        "sources": resolved_sources,
        "citations": resolved_citations,
        "missing_source_metadata": len(resolved_citations) == 0,
        "source_url": source_url,
    }


def _error_payload(*, query: str, provider: str, error: str) -> dict[str, object]:
    return _canonical_payload(query=query, provider=provider, error=error)


def _redacted_url_policy_reason(error: BaseException) -> str:
    """Bounded, host-free reason for a base URL rejected by the URL policy.

    ``validate_public_url`` appends the offending host after a colon on its
    resolution failures (``Hostname resolution failed: <host>``), so keep only
    the leading clause. The reason is what makes the rejection diagnosable —
    the configured host is user-supplied and stays out of diagnostics per the
    redaction contract, exactly as it stays out of the user-facing payload.
    """
    reason = str(error).split(":", 1)[0].strip()
    if not reason:
        return type(error).__name__
    return reason[:_MAX_POLICY_REASON_CHARS]


def _normalized_domain_tuple(domains: list[str] | None) -> tuple[str, ...]:
    if not domains:
        return ()
    return tuple(
        str(domain or "").strip().lower()
        for domain in domains
        if str(domain or "").strip()
    )


# ---------------------------------------------------------------------------
# HTTP plumbing shared by the JSON-API providers
# ---------------------------------------------------------------------------


class _ProviderRequestError(Exception):
    """Bounded, key-free description of an upstream provider failure."""


# Vendor requests carry API keys (auth headers or, for Google PSE, the query
# string), and urllib's default redirect handler re-issues the request —
# credentials included — to whatever host a 3xx points at. The vendor opener
# therefore never follows redirects: a 3xx surfaces as an HTTPError and the
# search fails closed, mirroring the pinned SearXNG fetch.
_VENDOR_OPENER = urllib.request.build_opener(_NoRedirectHandler())


def _vendor_urlopen(request: urllib.request.Request, *, timeout_s: int) -> Any:
    return _VENDOR_OPENER.open(request, timeout=timeout_s)


def _request_json(
    request_spec: str | _ProviderHttpRequest,
    *,
    timeout_s: int,
    provider: str,
) -> dict[str, Any]:
    """Issue one blocking HTTP request and parse a JSON object response.

    Error messages never include the request URL or headers — vendor URLs and
    headers can carry API keys, and these messages flow into tool output/logs.
    """
    spec = (
        request_spec
        if isinstance(request_spec, _ProviderHttpRequest)
        else _ProviderHttpRequest(url=request_spec)
    )
    request = urllib.request.Request(spec.url, data=spec.body, method=spec.method)
    request.add_header("User-Agent", _BROWSER_USER_AGENT)
    request.add_header("Accept", "application/json")
    for header, value in (spec.headers or {}).items():
        request.add_header(header, value)
    try:
        with _vendor_urlopen(request, timeout_s=timeout_s) as response:
            raw = response.read(_MAX_PROVIDER_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        status = int(getattr(exc, "code", 0) or 0)
        if _HTTP_REDIRECT_MIN <= status < _HTTP_CLIENT_ERROR_MIN:
            raise _ProviderRequestError(f"{provider} search failed: redirect blocked") from exc
        raise _ProviderRequestError(f"{provider} search failed: HTTP {status}") from exc
    except Exception as exc:
        raise _ProviderRequestError(f"{provider} search failed: network error") from exc
    if len(raw) > _MAX_PROVIDER_RESPONSE_BYTES:
        raise _ProviderRequestError(f"{provider} search failed: response too large")
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError as exc:
        raise _ProviderRequestError(f"{provider} search failed: malformed JSON response") from exc
    if not isinstance(data, dict):
        raise _ProviderRequestError(f"{provider} search failed: unexpected response shape")
    return data


def _shaped_source(
    *,
    url: str,
    title: str,
    snippet: str,
    result_url_is_safe: Callable[[str], bool],
) -> dict[str, str] | None:
    candidate = str(url or "").strip()
    if not candidate:
        return None
    parsed = urllib.parse.urlparse(candidate)
    if parsed.scheme not in ("http", "https"):
        return None
    if not result_url_is_safe(candidate):
        logger.info(
            "Dropped unsafe web-search provider result URL.",
            extra={
                "event": "ai.tools.web.unsafe_source_dropped",
                "component": "ai.tools.web_search_providers",
                "source_type": "web",
                "url_scheme": parsed.scheme or "",
            },
        )
        return None
    return {
        "url": candidate,
        "title": sanitize_tool_output(
            str(title or "").strip(),
            max_chars=_MAX_TITLE_CHARS,
            tool_name="web_search",
        ),
        "snippet": sanitize_tool_output(
            str(snippet or "").strip(),
            max_chars=_MAX_SNIPPET_CHARS,
            tool_name="web_search",
        ),
        "source_type": "web",
    }


def _finalize_payload(
    request: _ProviderSearchRequest,
    *,
    answer: str,
    raw_sources: list[tuple[str, str, str]],
) -> dict[str, object]:
    """Shape, dedupe, domain-filter, and cap provider results into the contract.

    The domain filter runs before the result cap: SearXNG returns the
    instance's full result list, so capping first could discard every
    allowed-domain match that sits past the cap.
    """
    allowed = _normalized_domain_tuple(request.allowed_domains)
    blocked = _normalized_domain_tuple(request.blocked_domains)
    sources: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for url, title, snippet in raw_sources:
        shaped = _shaped_source(
            url=url,
            title=title,
            snippet=snippet,
            result_url_is_safe=request.result_url_is_safe,
        )
        if shaped is None or shaped["url"] in seen_urls:
            continue
        seen_urls.add(shaped["url"])
        if (allowed or blocked) and not source_allowed_by_domains(
            shaped["url"], allowed_domains=allowed, blocked_domains=blocked
        ):
            continue
        sources.append(shaped)
        if len(sources) >= _MAX_PROVIDER_RESULTS:
            break
    resolved_answer = str(answer or "").strip()
    if not resolved_answer:
        for source in sources:
            snippet = str(source.get("snippet") or "").strip()
            if snippet:
                resolved_answer = snippet
                break
    if not resolved_answer:
        resolved_answer = f"No results found for '{request.query}'."
    return _canonical_payload(
        query=request.query,
        provider=request.provider,
        answer=sanitize_tool_output(
            resolved_answer,
            max_chars=_MAX_ANSWER_CHARS,
            tool_name="web_search",
        ),
        sources=sources,
    )


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------


class DuckDuckGoProvider:
    """Delegates to the injected DuckDuckGo search callable so headers, retry
    behavior, and payload shaping remain canonical.
    """

    name = "duckduckgo"

    def __init__(self, search_fn: Callable[..., dict[str, object]]) -> None:
        self._search_fn = search_fn

    def is_configured(self) -> bool:
        return True

    def search(
        self,
        query: str,
        *,
        timeout_s: int,
        allowed_domains: list[str] | None,
        blocked_domains: list[str] | None,
    ) -> dict[str, object]:
        return self._search_fn(
            query,
            timeout_s=timeout_s,
            allowed_domains=_normalized_domain_tuple(allowed_domains),
            blocked_domains=_normalized_domain_tuple(blocked_domains),
        )


class _JsonApiProvider:
    """Template for the JSON-over-HTTP providers.

    Subclasses supply ``name``, ``is_configured``, ``_validation_url`` (the
    request target checked through ``validate_public_url`` BEFORE any network
    call), and ``_build_request``/``_extract`` hooks. ``search`` implements
    the shared validate -> request -> parse -> shape pipeline and converts
    every failure into the canonical error payload.
    """

    name = "provider"

    def __init__(
        self,
        *,
        allow_private_addresses: bool = False,
        result_url_is_safe: Callable[[str], bool] | None = None,
    ) -> None:
        self._allow_private_addresses = bool(allow_private_addresses)
        self._result_url_is_safe = result_url_is_safe or (lambda _url: True)

    def is_configured(self) -> bool:
        return False

    def _validation_url(self) -> str:
        raise NotImplementedError

    def _validation_target(self, request_url: str) -> str:
        """The URL that must pass ``validate_public_url`` before any request.

        Vendors validate their fixed, credential-free base endpoint;
        user-supplied-host providers (SearXNG) override this to validate the
        full request URL so the pinned fetch targets exactly what was checked.
        """
        _ = request_url
        return self._validation_url()

    def _build_request(
        self, query: str
    ) -> _ProviderHttpRequest:
        """Build the bounded HTTP request for one provider query."""
        raise NotImplementedError

    def _fetch_json(
        self,
        validated: Any,
        request: _ProviderHttpRequest,
        *,
        timeout_s: int,
    ) -> dict[str, Any]:
        """Issue the search request and parse the JSON object response.

        Default path (fixed public vendor endpoints): one plain request, same
        posture as the DDG path uses for its hardcoded hosts. Providers with a
        user-supplied host override this with the pinned/no-redirect fetch.
        """
        _ = validated
        return _request_json(
            request,
            timeout_s=timeout_s,
            provider=self.name,
        )

    def _extract(self, data: dict[str, Any]) -> tuple[str, list[tuple[str, str, str]]]:
        """Return ``(answer, [(url, title, snippet), ...])`` from a response."""
        raise NotImplementedError

    def search(
        self,
        query: str,
        *,
        timeout_s: int,
        allowed_domains: list[str] | None,
        blocked_domains: list[str] | None,
    ) -> dict[str, object]:
        try:
            request = self._build_request(query)
        except Exception:  # noqa: BLE001 — providers never raise across the boundary
            logger.warning("web_search provider %s failed building its request", self.name)
            return _error_payload(
                query=query,
                provider=self.name,
                error=f"{self.name} search failed.",
            )
        try:
            validated = validate_public_url(
                self._validation_target(request.url),
                allow_private=self._allow_private_addresses,
            )
        except (PermissionError, ValueError) as error:
            # Fail closed without issuing any request; keep the message
            # host-free so a hostile/typo'd base URL never echoes into output.
            # The payload stays deliberately generic, so log the redacted
            # reason: it is the only signal a user has for why their own
            # SearXNG instance (bad scheme, embedded credentials, non-public
            # resolved address, DNS failure) was refused.
            logger.warning(
                "web_search provider %s base URL was rejected by the URL safety policy: %s",
                self.name,
                _redacted_url_policy_reason(error),
            )
            return _error_payload(
                query=query,
                provider=self.name,
                error=f"{self.name} base URL was rejected by the URL safety policy.",
            )
        try:
            data = self._fetch_json(
                validated,
                request,
                timeout_s=timeout_s,
            )
            answer, raw_sources = self._extract(data)
        except _ProviderRequestError as exc:
            logger.warning("web_search provider %s failed: %s", self.name, exc)
            return _error_payload(query=query, provider=self.name, error=str(exc))
        except Exception:  # noqa: BLE001 — providers never raise across the boundary
            logger.warning("web_search provider %s failed unexpectedly", self.name)
            return _error_payload(
                query=query,
                provider=self.name,
                error=f"{self.name} search failed.",
            )
        return _finalize_payload(
            _ProviderSearchRequest(
                query=query,
                provider=self.name,
                allowed_domains=allowed_domains,
                blocked_domains=blocked_domains,
                result_url_is_safe=self._result_url_is_safe,
            ),
            answer=answer,
            raw_sources=raw_sources,
        )


class SearXNGProvider(_JsonApiProvider):
    """Client for a user-run SearXNG instance's ``format=json`` search API."""

    name = _SEARXNG_PROVIDER

    def __init__(self, *, base_url: str | None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._base_url = str(base_url or "").strip().rstrip("/")

    def is_configured(self) -> bool:
        return bool(self._base_url)

    def _validation_url(self) -> str:
        return self._base_url

    def _validation_target(self, request_url: str) -> str:
        # Validate the FULL request URL: the pinned fetch below targets the
        # exact ValidatedUrl, so validation and fetch can never diverge.
        return request_url

    def _build_request(self, query: str) -> _ProviderHttpRequest:
        encoded = urllib.parse.quote_plus(query)
        return _ProviderHttpRequest(f"{self._base_url}/search?q={encoded}&format=json")

    def _fetch_json(
        self,
        validated: Any,
        request: _ProviderHttpRequest,
        *,
        timeout_s: int,
    ) -> dict[str, Any]:
        # SearXNG is the one user-supplied-host provider, so it uses the same
        # DNS-pinned, redirect-revalidating, size-bounded fetch as fetch_url
        # (web_http.read_url_response) instead of a plain urlopen.
        _ = request
        try:
            result = read_url_response(
                validated,
                timeout_s=timeout_s,
                max_bytes=_MAX_PROVIDER_RESPONSE_BYTES,
                allow_private=self._allow_private_addresses,
            )
        # A redirect hop the safety policy rejects gets the same wording as the
        # first-hop rejection above — a settled policy block, not the retryable
        # "network error"/"redirect blocked" (loop, hop cap, missing Location)
        # arms. Must stay ahead of the RedirectBlockedError arm it subclasses.
        except (RedirectPolicyBlockedError, RedirectTargetInvalidError) as exc:
            raise _ProviderRequestError(
                f"{self.name} search failed: redirect destination was rejected "
                "by the URL safety policy."
            ) from exc
        except RedirectBlockedError as exc:
            raise _ProviderRequestError(f"{self.name} search failed: redirect blocked") from exc
        except urllib.error.HTTPError as exc:
            status = int(getattr(exc, "code", 0) or 0)
            raise _ProviderRequestError(f"{self.name} search failed: HTTP {status}") from exc
        except Exception as exc:
            raise _ProviderRequestError(f"{self.name} search failed: network error") from exc
        if result.status_code != _HTTP_SUCCESS:
            raise _ProviderRequestError(
                f"{self.name} search failed: HTTP {result.status_code}"
            )
        try:
            data = json.loads(result.payload.decode("utf-8", errors="replace"))
        except ValueError as exc:
            raise _ProviderRequestError(
                f"{self.name} search failed: malformed JSON response"
            ) from exc
        if not isinstance(data, dict):
            raise _ProviderRequestError(f"{self.name} search failed: unexpected response shape")
        return data

    def _extract(self, data: dict[str, Any]) -> tuple[str, list[tuple[str, str, str]]]:
        answer = ""
        answers = data.get("answers")
        if isinstance(answers, list):
            for item in answers:
                if isinstance(item, str) and item.strip():
                    answer = item.strip()
                    break
                if isinstance(item, dict):
                    text = str(item.get("answer") or "").strip()
                    if text:
                        answer = text
                        break
        raw_sources: list[tuple[str, str, str]] = []
        results = data.get("results")
        if isinstance(results, list):
            for result in results:
                if not isinstance(result, dict):
                    continue
                raw_sources.append(
                    (
                        str(result.get("url") or ""),
                        str(result.get("title") or ""),
                        str(result.get("content") or ""),
                    )
                )
        return answer, raw_sources


class BraveProvider(_JsonApiProvider):
    """Brave Search API (`X-Subscription-Token` key)."""

    name = _BRAVE_PROVIDER

    def __init__(self, *, api_key: str | None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._api_key = str(api_key or "").strip()

    def is_configured(self) -> bool:
        return bool(self._api_key)

    def _validation_url(self) -> str:
        return _BRAVE_API_URL

    def _build_request(self, query: str) -> _ProviderHttpRequest:
        encoded = urllib.parse.quote_plus(query)
        url = f"{_BRAVE_API_URL}?q={encoded}&count={_MAX_PROVIDER_RESULTS}"
        return _ProviderHttpRequest(
            url,
            headers={"X-Subscription-Token": self._api_key},
        )

    def _extract(self, data: dict[str, Any]) -> tuple[str, list[tuple[str, str, str]]]:
        raw_sources: list[tuple[str, str, str]] = []
        web = data.get("web")
        results = web.get("results") if isinstance(web, dict) else None
        if isinstance(results, list):
            for result in results:
                if not isinstance(result, dict):
                    continue
                raw_sources.append(
                    (
                        str(result.get("url") or ""),
                        str(result.get("title") or ""),
                        str(result.get("description") or ""),
                    )
                )
        return "", raw_sources


class TavilyProvider(_JsonApiProvider):
    """Tavily Search API (Bearer key, JSON POST)."""

    name = _TAVILY_PROVIDER

    def __init__(self, *, api_key: str | None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._api_key = str(api_key or "").strip()

    def is_configured(self) -> bool:
        return bool(self._api_key)

    def _validation_url(self) -> str:
        return _TAVILY_API_URL

    def _build_request(self, query: str) -> _ProviderHttpRequest:
        body = json.dumps(
            {"query": query, "max_results": _MAX_PROVIDER_RESULTS},
            ensure_ascii=False,
        ).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        return _ProviderHttpRequest(
            _TAVILY_API_URL,
            method="POST",
            headers=headers,
            body=body,
        )

    def _extract(self, data: dict[str, Any]) -> tuple[str, list[tuple[str, str, str]]]:
        answer = str(data.get("answer") or "").strip()
        raw_sources: list[tuple[str, str, str]] = []
        results = data.get("results")
        if isinstance(results, list):
            for result in results:
                if not isinstance(result, dict):
                    continue
                raw_sources.append(
                    (
                        str(result.get("url") or ""),
                        str(result.get("title") or ""),
                        str(result.get("content") or ""),
                    )
                )
        return answer, raw_sources


class SerperProvider(_JsonApiProvider):
    """Serper.dev Google-results API (`X-API-KEY`, JSON POST)."""

    name = _SERPER_PROVIDER

    def __init__(self, *, api_key: str | None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._api_key = str(api_key or "").strip()

    def is_configured(self) -> bool:
        return bool(self._api_key)

    def _validation_url(self) -> str:
        return _SERPER_API_URL

    def _build_request(self, query: str) -> _ProviderHttpRequest:
        body = json.dumps(
            {"q": query, "num": _MAX_PROVIDER_RESULTS},
            ensure_ascii=False,
        ).encode("utf-8")
        headers = {
            "X-API-KEY": self._api_key,
            "Content-Type": "application/json",
        }
        return _ProviderHttpRequest(
            _SERPER_API_URL,
            method="POST",
            headers=headers,
            body=body,
        )

    def _extract(self, data: dict[str, Any]) -> tuple[str, list[tuple[str, str, str]]]:
        answer = ""
        answer_box = data.get("answerBox")
        if isinstance(answer_box, dict):
            answer = str(answer_box.get("answer") or answer_box.get("snippet") or "").strip()
        raw_sources: list[tuple[str, str, str]] = []
        organic = data.get("organic")
        if isinstance(organic, list):
            for result in organic:
                if not isinstance(result, dict):
                    continue
                raw_sources.append(
                    (
                        str(result.get("link") or ""),
                        str(result.get("title") or ""),
                        str(result.get("snippet") or ""),
                    )
                )
        return answer, raw_sources


class GooglePSEProvider(_JsonApiProvider):
    """Google Programmable Search Engine JSON API (API key + ``cx`` engine id)."""

    name = _GOOGLE_PSE_PROVIDER

    def __init__(self, *, api_key: str | None, cx: str | None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._api_key = str(api_key or "").strip()
        self._cx = str(cx or "").strip()

    def is_configured(self) -> bool:
        return bool(self._api_key and self._cx)

    def _validation_url(self) -> str:
        # Validate the credential-free base endpoint; the key/cx query string
        # is appended only after validation and never appears in any error.
        return _GOOGLE_PSE_API_URL

    def _build_request(self, query: str) -> _ProviderHttpRequest:
        params = urllib.parse.urlencode(
            {
                "key": self._api_key,
                "cx": self._cx,
                "q": query,
                "num": _MAX_PROVIDER_RESULTS,
            }
        )
        return _ProviderHttpRequest(f"{_GOOGLE_PSE_API_URL}?{params}")

    def _extract(self, data: dict[str, Any]) -> tuple[str, list[tuple[str, str, str]]]:
        raw_sources: list[tuple[str, str, str]] = []
        items = data.get("items")
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                raw_sources.append(
                    (
                        str(item.get("link") or ""),
                        str(item.get("title") or ""),
                        str(item.get("snippet") or ""),
                    )
                )
        return "", raw_sources


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------


def normalize_provider_keys(raw_keys: Any) -> dict[str, str]:
    """Coerce a raw provider-keys mapping into non-empty str -> str pairs."""
    if not isinstance(raw_keys, Mapping):
        return {}
    normalized: dict[str, str] = {}
    for key, value in raw_keys.items():
        name = str(key or "").strip()
        secret = str(value or "").strip() if isinstance(value, str) else ""
        if name and secret:
            normalized[name] = secret
    return normalized


def build_provider_dispatch(
    *,
    ddg_search: Callable[..., dict[str, object]],
    searxng_url: str | None,
    provider_keys: Mapping[str, str] | None,
    allow_private_addresses: bool = False,
    result_url_is_safe: Callable[[str], bool] | None = None,
) -> dict[str, WebSearchProvider]:
    """Build the provider dispatch table `web.py` looks providers up in.

    An unknown provider name must resolve to ``None`` at the call site
    (``dispatch.get(name)`` with NO default) — never fall back to DuckDuckGo
    on a lookup miss; the caller reports a structured error instead.
    """
    keys = normalize_provider_keys(provider_keys)
    shared: dict[str, Any] = {
        "allow_private_addresses": allow_private_addresses,
        "result_url_is_safe": result_url_is_safe,
    }
    return {
        "duckduckgo": DuckDuckGoProvider(ddg_search),
        _SEARXNG_PROVIDER: SearXNGProvider(base_url=searxng_url, **shared),
        _BRAVE_PROVIDER: BraveProvider(api_key=keys.get(_BRAVE_PROVIDER), **shared),
        _TAVILY_PROVIDER: TavilyProvider(api_key=keys.get(_TAVILY_PROVIDER), **shared),
        _SERPER_PROVIDER: SerperProvider(api_key=keys.get(_SERPER_PROVIDER), **shared),
        _GOOGLE_PSE_PROVIDER: GooglePSEProvider(
            api_key=keys.get(_GOOGLE_PSE_PROVIDER),
            cx=keys.get("google_pse_cx"),
            **shared,
        ),
    }
