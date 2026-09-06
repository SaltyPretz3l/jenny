"""DuckDuckGo web-search subsystem.

Imports are one-way (``web.py`` imports this module, never the reverse).
Provider infrastructure from ``web_search_providers`` is re-exported through
here so the hub reaches it transitively and its ``sidecar.ai.*`` import fan-out
stays at 6.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from sidecar.ai.tools.builtins.web_http import _BROWSER_USER_AGENT, _is_public_ip

# web_ddg is the SOLE importer of web_search_providers (the hub reaches it
# transitively, keeping the hub fan-out at 6). web_ddg uses the two aliased
# source helpers directly; the three unaliased names are re-exported for the
# hub, so the block carries a statement-level noqa for F401 (chat.py precedent).
from sidecar.ai.tools.builtins.web_search_providers import (  # noqa: F401
    WebSearchProvider,
    build_provider_dispatch,
    normalize_provider_keys,
)
from sidecar.ai.tools.builtins.web_search_providers import (
    citations_from_sources as _citations_from_sources,
)
from sidecar.ai.tools.builtins.web_search_providers import (
    filter_sources_by_domains as _filter_sources,
)
from sidecar.ai.tools.sanitization import sanitize_tool_output

logger = logging.getLogger(__name__)


_DEFAULT_SEARCH_MAX_CHARS = 4000


_BLOCKED_METADATA_HOSTS = frozenset({"localhost", "localhost.localdomain"})
_BLOCKED_METADATA_IPV4_PREFIXES = ("127.", "10.", "169.254.", "192.168.")


# DuckDuckGo's HTML/lite endpoints challenge or rate-limit obvious bot clients, so the
# search path presents a browser-like client and retries once on a challenge/throttle
# status before giving up. The browser User-Agent is shared with the `fetch_url`
# SSRF opener (`web_http._BROWSER_USER_AGENT`) — both paths were advertising a
# bot client, which made blocking trivial.
_DDG_REQUEST_HEADERS = {
    "User-Agent": _BROWSER_USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
# Statuses DuckDuckGo uses for bot-challenge / rate-limit (202 = "please retry").
_DDG_RETRY_STATUS = frozenset({202, 403, 429})
_DDG_MAX_ATTEMPTS = 2
_DDG_RETRY_BACKOFF_SECONDS = 0.5
_DDG_MAX_RETRY_AFTER_SECONDS = 2.0


def _extract_ddg_answer(payload: dict[str, Any], query: str) -> str:
    abstract = str(payload.get("AbstractText") or "").strip()
    answer = str(payload.get("Answer") or "").strip()
    if abstract:
        return abstract
    if answer:
        return answer
    related = payload.get("RelatedTopics") or []
    if isinstance(related, list):
        for topic in related:
            if isinstance(topic, dict):
                text = str(topic.get("Text") or "").strip()
                if text:
                    return text
                nested = topic.get("Topics")
                if isinstance(nested, list):
                    for subtopic in nested:
                        if isinstance(subtopic, dict):
                            text = str(subtopic.get("Text") or "").strip()
                            if text:
                                return text
    return f"No instant answer found for '{query}'."


# ---------------------------------------------------------------------------
# DuckDuckGo HTML search fallback
# ---------------------------------------------------------------------------

_DDG_HTML_RESULT_RE = re.compile(
    r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_DDG_HTML_SNIPPET_RE = re.compile(
    r'<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_DDG_HTML_RESULT_BLOCK_RE = re.compile(
    r'<div[^>]+class="[^"]*result\b[^"]*"[^>]*>(.*?)</div>\s*(?=<div[^>]+class="[^"]*result\b|$)',
    re.IGNORECASE | re.DOTALL,
)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_DDG_HTML_MAX_RESULTS = 8


def _strip_html_tags(text: str) -> str:
    from html import unescape as html_unescape

    return html_unescape(_HTML_TAG_RE.sub("", text)).strip()


def _resolve_ddg_redirect(raw_url: str) -> str:
    """Resolve DuckDuckGo's ``//duckduckgo.com/l/?uddg=`` redirect wrapper."""
    if "duckduckgo.com/l/" in raw_url or "uddg=" in raw_url:
        parsed = urllib.parse.urlparse(raw_url)
        params = urllib.parse.parse_qs(parsed.query)
        targets = params.get("uddg", [])
        if targets:
            return urllib.parse.unquote(targets[0])
    return raw_url


def _extract_ddg_html_results(html_body: str) -> list[dict[str, str]]:
    """Parse search results from DuckDuckGo's HTML search page."""
    results: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    blocks = _DDG_HTML_RESULT_BLOCK_RE.findall(html_body)
    if not blocks:
        blocks = [html_body]

    for block in blocks:
        link_match = _DDG_HTML_RESULT_RE.search(block)
        if not link_match:
            continue
        raw_url = link_match.group(1)
        url = _resolve_ddg_redirect(raw_url)
        if not url or url in seen_urls:
            continue
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            continue
        if not _is_safe_metadata_url(url):
            logger.info(
                "Dropped unsafe web-search HTML fallback URL.",
                extra={
                    "event": "ai.tools.web.unsafe_source_dropped",
                    "component": "ai.tools.web",
                    "source_type": "web_result",
                    "url_scheme": parsed.scheme or "",
                },
            )
            continue
        seen_urls.add(url)

        title = _strip_html_tags(link_match.group(2))
        snippet_match = _DDG_HTML_SNIPPET_RE.search(block)
        snippet = _strip_html_tags(snippet_match.group(1)) if snippet_match else ""

        results.append(
            {
                "url": url,
                "title": sanitize_tool_output(title, max_chars=300, tool_name="web_search"),
                "snippet": sanitize_tool_output(
                    snippet,
                    max_chars=500,
                    tool_name="web_search",
                ),
                "source_type": "web_result",
            }
        )
        if len(results) >= _DDG_HTML_MAX_RESULTS:
            break

    return results


_DDG_LITE_RESULT_RE = re.compile(
    r'<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_DDG_LITE_SNIPPET_RE = re.compile(
    r'<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>(.*?)</td>',
    re.IGNORECASE | re.DOTALL,
)


def _extract_ddg_lite_results(html_body: str) -> list[dict[str, str]]:
    """Parse results from DuckDuckGo's lite endpoint (simple table layout)."""
    links = list(_DDG_LITE_RESULT_RE.finditer(html_body))
    snippets = list(_DDG_LITE_SNIPPET_RE.finditer(html_body))
    results: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for index, link in enumerate(links):
        raw_url, raw_title = link.group(1), link.group(2)
        url = _resolve_ddg_redirect(raw_url)
        if not url or url in seen_urls:
            continue
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            continue
        if not _is_safe_metadata_url(url):
            continue
        seen_urls.add(url)
        # Pair by document position, not list index: a link's snippet is the first
        # result-snippet cell that falls between this link and the next one. This stays
        # correct even when an earlier link is dropped (unsafe URL) or has no snippet.
        region_end = links[index + 1].start() if index + 1 < len(links) else len(html_body)
        snippet = ""
        for snippet_match in snippets:
            if link.end() <= snippet_match.start() < region_end:
                snippet = _strip_html_tags(snippet_match.group(1))
                break
        results.append(
            {
                "url": url,
                "title": sanitize_tool_output(
                    _strip_html_tags(raw_title),
                    max_chars=300,
                    tool_name="web_search",
                ),
                "snippet": sanitize_tool_output(
                    snippet,
                    max_chars=500,
                    tool_name="web_search",
                ),
                "source_type": "web_result",
            }
        )
        if len(results) >= _DDG_HTML_MAX_RESULTS:
            break
    return results


class _DdgBlockedError(Exception):
    """DuckDuckGo answered with a bot-challenge / rate-limit status on every attempt.

    Distinct from "no results" so the caller can tell the model the search was *blocked*
    (and is worth retrying) rather than silently reporting an empty result set.
    """

    def __init__(self, status: int) -> None:
        super().__init__(f"DuckDuckGo returned blocking status {status}")
        self.status = status


def _coerce_response_status(resp: Any, *, default: int = 200) -> int:
    """Read an HTTP status from a response, tolerating mocks whose ``status`` isn't an int.

    Only ever called on a successful ``urlopen`` response (an ``http.client.HTTPResponse``,
    which always exposes ``.status``); ``HTTPError`` statuses are read separately from
    ``exc.code``. The ``int()`` guard is what tolerates ``MagicMock`` test responses.
    """
    try:
        return int(getattr(resp, "status", default))
    except (TypeError, ValueError):
        return default


def _retry_after_seconds(headers: Any) -> float:
    """Bounded backoff from a ``Retry-After`` header, defaulting to the base backoff."""
    raw = ""
    if headers is not None:
        try:
            raw = str(headers.get("Retry-After") or "").strip()
        except Exception:  # noqa: BLE001
            raw = ""
    if not raw:
        return _DDG_RETRY_BACKOFF_SECONDS
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        return _DDG_RETRY_BACKOFF_SECONDS
    if seconds < 0:
        return _DDG_RETRY_BACKOFF_SECONDS
    return min(seconds, _DDG_MAX_RETRY_AFTER_SECONDS)


def _backoff_sleep(seconds: float, deadline: float | None) -> None:
    """Sleep ``seconds``, but never past ``deadline`` (the total-operation budget)."""
    if deadline is not None:
        seconds = min(seconds, max(0.0, deadline - time.monotonic()))
    if seconds > 0:
        time.sleep(seconds)


def _ddg_http_request(
    url: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    timeout_s: int,
    deadline: float | None = None,
) -> str:
    """Issue a DDG request with browser headers + bounded retry on challenge statuses.

    Returns the decoded response body. Raises ``_DdgBlockedError`` when DuckDuckGo answers
    with a challenge/rate-limit status (202/403/429) on every attempt; re-raises other
    HTTP errors. Transient network failures are retried once, then re-raised. ``deadline``
    (a ``time.monotonic`` value) bounds the TOTAL operation: each attempt's per-request
    timeout shrinks to the remaining budget and retries stop once it elapses, so the
    whole search honors the caller's ``timeout_s`` instead of spending it per request.
    """
    for attempt in range(_DDG_MAX_ATTEMPTS):
        last_attempt = attempt + 1 >= _DDG_MAX_ATTEMPTS
        req_timeout = timeout_s
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            req_timeout = max(1, min(timeout_s, int(remaining) or 1))
        req = urllib.request.Request(url, data=data, method=method)
        for header, value in _DDG_REQUEST_HEADERS.items():
            req.add_header(header, value)
        if data is not None:
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(req, timeout=req_timeout) as resp:
                status = _coerce_response_status(resp)
                if status in _DDG_RETRY_STATUS:
                    if last_attempt:
                        raise _DdgBlockedError(status)
                    _backoff_sleep(_retry_after_seconds(getattr(resp, "headers", None)), deadline)
                    continue
                return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            status = int(getattr(exc, "code", 0) or 0)
            if status not in _DDG_RETRY_STATUS:
                raise
            if last_attempt:
                raise _DdgBlockedError(status) from exc
            _backoff_sleep(_retry_after_seconds(getattr(exc, "headers", None)), deadline)
            continue
        except TimeoutError:
            # Only timeouts are retried among transport errors; other connection
            # failures fail fast (no backoff) so the caller surfaces them immediately.
            if last_attempt:
                raise
            _backoff_sleep(_DDG_RETRY_BACKOFF_SECONDS, deadline)
            continue
    # Unreachable on the happy/last-attempt paths (each returns or raises); this is the
    # required fall-through that also fires if the deadline elapsed mid-loop.
    raise _DdgBlockedError(0)


def _ddg_html_search(
    query: str,
    *,
    timeout_s: int = 10,
    deadline: float | None = None,
) -> list[dict[str, str]]:
    """Fetch search results from DuckDuckGo's HTML then lite endpoints.

    Both are POSTed with browser headers (the GET html endpoint + bot User-Agent was the
    most-blocked combination). Raises ``_DdgBlockedError`` only when every endpoint is
    blocked, so the caller can distinguish a bot challenge from a genuine empty result.

    Note: like the rest of the search path (and unlike ``fetch_url``), these requests use
    the default opener and target only hard-coded DuckDuckGo hosts — they intentionally do
    NOT use ``fetch_url``'s pinned-IP / no-redirect SSRF opener, since the query is not a
    user-supplied URL. Result links are still filtered through ``_is_safe_metadata_url``.
    """
    body = urllib.parse.urlencode({"q": query}).encode("utf-8")
    blocked_status = 0
    got_response = False
    last_error: Exception | None = None
    for endpoint, parser in (
        ("https://html.duckduckgo.com/html/", _extract_ddg_html_results),
        ("https://lite.duckduckgo.com/lite/", _extract_ddg_lite_results),
    ):
        if deadline is not None and time.monotonic() >= deadline:
            break
        try:
            raw = _ddg_http_request(
                endpoint,
                method="POST",
                data=body,
                timeout_s=timeout_s,
                deadline=deadline,
            )
        except _DdgBlockedError as exc:
            blocked_status = exc.status or blocked_status
            continue
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            logger.debug("DuckDuckGo search endpoint failed (%s): %s", endpoint, query)
            continue
        got_response = True
        results = parser(raw)
        if results:
            return results
    if blocked_status:
        raise _DdgBlockedError(blocked_status)
    # A non-blocking transport failure with no usable response is a genuine error, not an
    # empty result — re-raise so the tool reports failure rather than "no results".
    if not got_response and last_error is not None:
        raise last_error
    return []


def _ddg_instant_answer(
    query: str,
    *,
    timeout_s: int,
    deadline: float | None = None,
) -> tuple[dict[str, Any], bool]:
    """Query DuckDuckGo's Instant-Answer API.

    Returns ``(data, ok)`` where ``ok`` is True when the API responded (even with an empty
    answer). Deliberately never raises: an Instant-Answer miss/block falls through to the
    HTML/lite scrape rather than aborting the whole tool. ``ok`` lets the caller tell a
    live-but-empty network apart from a total network failure.
    """
    encoded = urllib.parse.quote_plus(query)
    url = f"https://api.duckduckgo.com/?q={encoded}&format=json&no_redirect=1&no_html=1"
    try:
        raw = _ddg_http_request(url, method="GET", timeout_s=timeout_s, deadline=deadline)
        data = json.loads(raw)
    except _DdgBlockedError:
        return {}, False
    except Exception:  # noqa: BLE001
        logger.debug("DuckDuckGo instant-answer failed for query: %s", query)
        return {}, False
    return (data if isinstance(data, dict) else {}), True


def _host_has_blocked_private_prefix(host: str) -> bool:
    if host.startswith(_BLOCKED_METADATA_IPV4_PREFIXES):
        return True
    if not host.startswith("172."):
        return False
    try:
        return 16 <= int(host.split(".", 2)[1]) <= 31
    except (ValueError, IndexError):
        return False


def _host_is_blocked_ip_literal(host: str) -> bool:
    # Delegates to the fetch path's classifier instead of keeping a second list of
    # address properties here. A citation must not display a URL that `fetch_url`
    # would refuse to fetch, and a duplicated list drifts every time one side is
    # tightened — this one had already fallen behind on multicast and reserved
    # ranges. Unconditional by construction: `_is_public_ip` takes no
    # `allow_private` escape, because `tools_web_allow_private_addresses` governs
    # what the fetch path may *reach*, not what is *rendered* as a citation.
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return not _is_public_ip(address)


def _is_safe_metadata_url(url: str) -> bool:
    """Return True only if *url* is an http(s) URL with no embedded credentials
    and a non-empty public-looking host.

    Rejects `javascript:`, `file:`, `data:`, credentialed URLs
    (`http://user:pass@...`), localhost/loopback, link-local, and private-range
    hosts so DuckDuckGo instant-answer metadata cannot promote unsafe targets
    into citations or `source_url`. Address literals are classified by the
    fetch path's `_is_public_ip`, so a citation can never display an address
    `fetch_url` would reject; the prefix check additionally covers hostnames
    that merely *look* like private literals (`192.168.1.1.nip.io`).
    """
    candidate = str(url or "").strip()
    if not candidate:
        return False
    try:
        parsed = urllib.parse.urlparse(candidate)
    except ValueError:
        return False
    host = (parsed.hostname or "").strip().lower()
    return (
        parsed.scheme in ("http", "https")
        and not parsed.username
        and not parsed.password
        and bool(host)
        and host not in _BLOCKED_METADATA_HOSTS
        and not _host_has_blocked_private_prefix(host)
        and not _host_is_blocked_ip_literal(host)
    )


def _extract_ddg_sources(payload: dict[str, Any]) -> list[dict[str, str]]:
    sources: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    def _append(*, url: str, title: str, snippet: str, source_type: str) -> None:
        safe_url = str(url or "").strip()
        if not safe_url or safe_url in seen_urls:
            return
        if not _is_safe_metadata_url(safe_url):
            logger.info(
                "Dropped unsafe web-search source metadata URL.",
                extra={
                    "event": "ai.tools.web.unsafe_source_dropped",
                    "component": "ai.tools.web",
                    "source_type": source_type,
                    "url_scheme": urllib.parse.urlparse(safe_url).scheme or "",
                },
            )
            return
        seen_urls.add(safe_url)
        sources.append(
            {
                "url": safe_url,
                "title": sanitize_tool_output(
                    str(title or "").strip(),
                    max_chars=300,
                    tool_name="web_search",
                ),
                "snippet": sanitize_tool_output(
                    str(snippet or "").strip(),
                    max_chars=500,
                    tool_name="web_search",
                ),
                "source_type": str(source_type or "").strip() or "unknown",
            }
        )

    abstract_url = str(payload.get("AbstractURL") or "").strip()
    abstract_text = str(payload.get("AbstractText") or "").strip()
    abstract_source = str(payload.get("AbstractSource") or "").strip()
    heading = str(payload.get("Heading") or "").strip()
    if abstract_url:
        _append(
            url=abstract_url,
            title=heading or abstract_source or abstract_url,
            snippet=abstract_text,
            source_type="instant_answer",
        )

    related = payload.get("RelatedTopics") or []
    if isinstance(related, list):
        for topic in related:
            if not isinstance(topic, dict):
                continue
            nested_topics = topic.get("Topics")
            if isinstance(nested_topics, list):
                for nested in nested_topics:
                    if not isinstance(nested, dict):
                        continue
                    _append(
                        url=str(nested.get("FirstURL") or "").strip(),
                        title=str(topic.get("Name") or nested.get("Result") or "").strip(),
                        snippet=str(nested.get("Text") or "").strip(),
                        source_type="related_topic",
                    )
                continue
            _append(
                url=str(topic.get("FirstURL") or "").strip(),
                title=str(topic.get("Result") or "").strip(),
                snippet=str(topic.get("Text") or "").strip(),
                source_type="related_topic",
            )
            if len(sources) >= 5:
                break
    return sources


def _answer_from_sources(sources: list[dict[str, str]], *, query: str) -> str:
    for source in sources:
        snippet = str(source.get("snippet") or "").strip()
        if snippet:
            return snippet
        title = str(source.get("title") or "").strip()
        if title:
            return title
    return f"No instant answer found for '{query}'."


def _duckduckgo_search(
    query: str,
    *,
    timeout_s: int,
    allowed_domains: tuple[str, ...],
    blocked_domains: tuple[str, ...],
) -> dict[str, Any]:
    """Return the DuckDuckGo provider payload behind the provider seam.

    Returns the canonical web-search payload; ``error`` is non-empty exactly
    when the search should be reported as ``success=False`` (blocked scrape
    with no sources, or total transport failure).
    """
    filters_requested = bool(allowed_domains or blocked_domains)
    # Bound the TOTAL wall-clock across the Instant-Answer + html + lite requests to
    # timeout_s, rather than letting each request (and its retry) spend it independently.
    deadline = time.monotonic() + timeout_s

    # Instant-Answer API first (best-effort; a miss/block returns {} and falls
    # through to the HTML/lite scrape rather than aborting the whole tool).
    instant_data, instant_ok = _ddg_instant_answer(
        query, timeout_s=timeout_s, deadline=deadline
    )
    sources = _filter_sources(
        _extract_ddg_sources(instant_data),
        allowed_domains=allowed_domains,
        blocked_domains=blocked_domains,
    )
    blocked = False
    scrape_failed = False
    if sources:
        if filters_requested:
            answer = sanitize_tool_output(
                _answer_from_sources(sources, query=query),
                max_chars=_DEFAULT_SEARCH_MAX_CHARS,
                tool_name="web_search",
            )
        else:
            answer = sanitize_tool_output(
                _extract_ddg_answer(instant_data, query),
                max_chars=_DEFAULT_SEARCH_MAX_CHARS,
                tool_name="web_search",
            )
    elif filters_requested:
        answer = "Search completed, but no results matched the requested domain filters."
    else:
        # Instant answer returned nothing useful — scrape DuckDuckGo's HTML/lite
        # endpoints for real web results.
        html_results: list[dict[str, str]] = []
        try:
            html_results = _ddg_html_search(
                query, timeout_s=timeout_s, deadline=deadline
            )
        except _DdgBlockedError as exc:
            blocked = True
            logger.warning(
                "web_search blocked by DuckDuckGo (status %s) for query: %s",
                exc.status,
                query,
            )
        except Exception as exc:  # noqa: BLE001
            scrape_failed = True
            logger.warning("web_search scrape failed for query %s: %s", query, exc)
        html_sources = _filter_sources(
            html_results,
            allowed_domains=allowed_domains,
            blocked_domains=blocked_domains,
        )
        if html_sources:
            sources = html_sources
            answer = sanitize_tool_output(
                _answer_from_sources(sources, query=query),
                max_chars=_DEFAULT_SEARCH_MAX_CHARS,
                tool_name="web_search",
            )
        else:
            answer = sanitize_tool_output(
                _extract_ddg_answer(instant_data, query),
                max_chars=_DEFAULT_SEARCH_MAX_CHARS,
                tool_name="web_search",
            )
    citations = _citations_from_sources(sources)
    source_url = str(citations[0].get("url", "") if citations else "")
    # A blocked scrape with no sources is surfaced as a failure (worth retrying), so
    # the model does not mistake a bot challenge for a genuine empty result — but it
    # is explicitly NOT a network outage. A scrape transport error only counts as a
    # hard failure when the Instant-Answer API also could not be reached (otherwise
    # the network is up and an empty result is genuine).
    search_blocked = blocked and not sources
    search_failed = scrape_failed and not sources and not instant_ok
    if search_blocked:
        # Only claim the network is up when the Instant-Answer API actually answered;
        # if it was ALSO unreachable, the network itself may be down.
        error = (
            "Web search was temporarily blocked by DuckDuckGo. The network is "
            "available; retry shortly or rephrase the query."
            if instant_ok
            else "Web search was blocked by DuckDuckGo and the Instant-Answer API "
            "was unreachable; the network may be down. Retry shortly."
        )
    elif search_failed:
        error = "Web search failed."
    else:
        error = ""
    return {
        "query": query,
        "provider": "duckduckgo",
        "answer": "" if search_failed else answer,
        "error": error,
        "sources": sources,
        "citations": citations,
        "missing_source_metadata": len(citations) == 0,
        "source_url": source_url,
    }

