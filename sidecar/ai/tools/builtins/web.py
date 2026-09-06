"""Web search and URL fetch built-in tools."""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, cast

from sidecar.ai.error_codes import (
    CMP_WEB_CONTENT_TOO_LARGE,
    CMP_WEB_FETCH_FAILED,
    CMP_WEB_INVALID_URL,
    CMP_WEB_RATE_LIMITED,
    CMP_WEB_REDIRECT_BLOCKED,
    CMP_WEB_SSRF_BLOCKED,
)
from sidecar.ai.tools.builtins.web_ddg import (
    WebSearchProvider,
    _ddg_http_request,  # noqa: F401  (re-exported for tests/consumers)
    _DdgBlockedError,  # noqa: F401  (re-exported for tests/consumers)
    _duckduckgo_search,
    _extract_ddg_html_results,  # noqa: F401  (re-exported for tests/consumers)
    _extract_ddg_lite_results,  # noqa: F401  (re-exported for tests/consumers)
    _is_safe_metadata_url,
    build_provider_dispatch,
    normalize_provider_keys,
)
from sidecar.ai.tools.builtins.web_extract import convert_html_to_markdown, is_text_content_type
from sidecar.ai.tools.builtins.web_http import (
    RedirectBlockedError,
    RedirectPolicyBlockedError,
    RedirectTargetInvalidError,
    UrlReadResult,
    ValidatedUrl,
    WebRateLimiter,
    read_url_response,
    validate_public_url,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.sanitization import sanitize_tool_output

logger = logging.getLogger(__name__)

_MAX_QUERY_LENGTH = 2000
_DEFAULT_FETCH_MAX_CHARS = 20_000
_MAX_FETCH_CONTENT_CHARS = 20_000
# Managed tool-loop response cap (see
# `sidecar/ai/routing/harness_helpers.MAX_RESPONSE_CHARS`). Keep the full
# serialized `fetch_url` JSON payload inside this budget so the downstream
# generic sanitizer does not truncate mid-JSON and produce an invalid
# tool-result row.
_FETCH_RESPONSE_SERIALIZATION_BUDGET = 16_000
_FETCH_RESPONSE_TRIM_HEADROOM = 32
_FETCH_CACHE_TTL_SECONDS = 15 * 60
_FETCH_CACHE_MAX_BYTES = 50 * 1024 * 1024

_rate_limiter = WebRateLimiter(requests_per_minute=30)
_allow_private_addresses = False
_max_fetch_bytes = 1_048_576
_search_provider = "duckduckgo"
_searxng_url: str | None = None
_provider_keys: dict[str, str] = {}
# Rebuilt by `configure_web_tools` and initialized at the bottom of this
# module (after `_duckduckgo_search` exists to be injected).
_provider_dispatch: dict[str, WebSearchProvider] = {}


@dataclass(frozen=True)
class _CachedFetchEntry:
    requested_url: str
    final_url: str
    redirect_chain: tuple[str, ...]
    status_code: int
    content_type: str
    content_format: str
    content: str
    truncated: bool
    size_bytes: int


class _FetchResponseCache:
    def __init__(self, *, ttl_seconds: int, max_bytes: int) -> None:
        self._ttl_seconds = max(1, int(ttl_seconds))
        self._max_bytes = max(1024, int(max_bytes))
        self._entries: OrderedDict[str, tuple[float, _CachedFetchEntry]] = OrderedDict()
        self._size_bytes = 0
        self._lock = threading.Lock()

    def get(self, key: str) -> _CachedFetchEntry | None:
        token = str(key or "").strip()
        if not token:
            return None
        with self._lock:
            return self._get_locked(token)

    def set(self, key: str, entry: _CachedFetchEntry) -> None:
        token = str(key or "").strip()
        if not token:
            return
        with self._lock:
            existing = self._entries.pop(token, None)
            if existing is not None:
                self._size_bytes = max(0, self._size_bytes - existing[1].size_bytes)
            self._entries[token] = (time.monotonic() + self._ttl_seconds, entry)
            self._entries.move_to_end(token)
            self._size_bytes += entry.size_bytes
            self._evict_if_needed_locked()

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._size_bytes = 0

    def _get_locked(self, token: str) -> _CachedFetchEntry | None:
        entry = self._entries.get(token)
        if entry is None:
            return None
        expires_at, payload = entry
        if expires_at <= time.monotonic():
            self._entries.pop(token, None)
            self._size_bytes = max(0, self._size_bytes - payload.size_bytes)
            return None
        self._entries.move_to_end(token)
        return payload

    def _evict_if_needed_locked(self) -> None:
        while self._entries:
            oldest_key, (expires_at, payload) = next(iter(self._entries.items()))
            if expires_at <= time.monotonic():
                self._entries.pop(oldest_key, None)
                self._size_bytes = max(0, self._size_bytes - payload.size_bytes)
                continue
            if self._size_bytes <= self._max_bytes:
                return
            self._entries.popitem(last=False)
            self._size_bytes = max(0, self._size_bytes - payload.size_bytes)


_fetch_cache = _FetchResponseCache(
    ttl_seconds=_FETCH_CACHE_TTL_SECONDS,
    max_bytes=_FETCH_CACHE_MAX_BYTES,
)


def configure_web_tools(config: Any) -> None:
    """Apply runtime configuration to web tool module state."""
    global _rate_limiter, _allow_private_addresses, _max_fetch_bytes, _search_provider
    global _searxng_url, _provider_keys, _provider_dispatch
    if config is None:
        return

    if isinstance(config, dict):
        rate = config.get("tools_web_rate_limit_per_min", 30)
        _allow_private_addresses = bool(config.get("tools_web_allow_private_addresses", False))
        _max_fetch_bytes = int(config.get("tools_web_max_fetch_bytes", 1_048_576))
        _search_provider = str(config.get("tools_web_search_provider", "duckduckgo"))
        raw_searxng_url = config.get("tools_web_searxng_url")
        raw_provider_keys = config.get("tools_web_search_provider_keys")
    else:
        rate = getattr(config, "tools_web_rate_limit_per_min", 30)
        _allow_private_addresses = bool(getattr(config, "tools_web_allow_private_addresses", False))
        _max_fetch_bytes = int(getattr(config, "tools_web_max_fetch_bytes", 1_048_576))
        _search_provider = str(getattr(config, "tools_web_search_provider", "duckduckgo"))
        raw_searxng_url = getattr(config, "tools_web_searxng_url", None)
        raw_provider_keys = getattr(config, "tools_web_search_provider_keys", None)

    searxng_url = str(raw_searxng_url).strip() if isinstance(raw_searxng_url, str) else ""
    _searxng_url = searxng_url or None
    _provider_keys = normalize_provider_keys(raw_provider_keys)
    _rate_limiter = WebRateLimiter(requests_per_minute=int(rate))
    _provider_dispatch = _rebuild_provider_dispatch()


def _check_rate_limit() -> None:
    try:
        _rate_limiter.check()
    except RuntimeError as exc:
        raise ToolExecutionFailure(
            code=CMP_WEB_RATE_LIMITED,
            message=str(exc),
            retryable=True,
        ) from exc


def _sanitize_text(text: str) -> str:
    return "".join(ch for ch in text if ch == "\n" or ch == "\t" or ord(ch) >= 32)


def _coerce_int_argument(arguments: dict[str, object], key: str, default: int) -> int:
    raw_value = arguments.get(key, default)
    if isinstance(raw_value, bool):
        return default
    try:
        return int(cast(Any, raw_value))
    except (TypeError, ValueError):
        return default


def _coerce_domain_filters(arguments: dict[str, object], key: str) -> tuple[str, ...]:
    raw_value = arguments.get(key)
    if raw_value is None:
        return ()
    candidates = raw_value if isinstance(raw_value, list) else [raw_value]
    normalized: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, str):
            continue
        token = candidate.strip().lower()
        if not token:
            continue
        if "://" in token:
            token = urllib.parse.urlparse(token).hostname or ""
        token = token.split("/", 1)[0].split(":", 1)[0].lstrip(".")
        if not token or token in seen:
            continue
        normalized.append(token)
        seen.add(token)
    return tuple(normalized)


def _safe_fetch_content_limit(requested: int) -> int:
    normalized = min(max(200, requested), _DEFAULT_FETCH_MAX_CHARS)
    return min(normalized, _MAX_FETCH_CONTENT_CHARS)


def _build_cached_fetch_entry(validated: ValidatedUrl, result: UrlReadResult) -> _CachedFetchEntry:
    if result.was_truncated and not result.payload:
        raise ToolExecutionFailure(
            code=CMP_WEB_CONTENT_TOO_LARGE,
            message="Fetched content exceeded the configured size limit.",
            retryable=False,
        )

    content_type = str(result.content_type or "").strip()
    if not is_text_content_type(content_type) and content_type:
        mime = content_type.split(";", 1)[0].strip()
        raise ToolExecutionFailure(
            code=CMP_WEB_FETCH_FAILED,
            message=f"Unsupported content type: {mime}",
            retryable=False,
        )

    body = result.payload.decode("utf-8", errors="replace")
    content_format = "text"
    html_truncated = False
    if "text/html" in content_type.lower():
        body, html_truncated = convert_html_to_markdown(body)
        content_format = "markdown"

    body = _sanitize_text(body)
    body = sanitize_tool_output(body, max_chars=_MAX_FETCH_CONTENT_CHARS, tool_name="fetch_url")
    payload_size = len(body.encode("utf-8")) + len(result.final_url.encode("utf-8"))
    return _CachedFetchEntry(
        requested_url=validated.url,
        final_url=result.final_url,
        redirect_chain=result.redirect_chain,
        status_code=result.status_code,
        content_type=content_type,
        content_format=content_format,
        content=body,
        truncated=result.was_truncated or html_truncated,
        size_bytes=payload_size,
    )


def _load_fetch_entry(validated: ValidatedUrl, *, timeout_s: int) -> tuple[_CachedFetchEntry, bool]:
    cached = _fetch_cache.get(validated.url)
    if cached is not None:
        return cached, True
    result = read_url_response(
        validated,
        timeout_s=timeout_s,
        max_bytes=_max_fetch_bytes,
        allow_private=_allow_private_addresses,
    )
    entry = _build_cached_fetch_entry(validated, result)
    _fetch_cache.set(validated.url, entry)
    return entry, False


def _rebuild_provider_dispatch() -> dict[str, WebSearchProvider]:
    return build_provider_dispatch(
        ddg_search=_duckduckgo_search,
        searxng_url=_searxng_url,
        provider_keys=_provider_keys,
        allow_private_addresses=_allow_private_addresses,
        result_url_is_safe=_is_safe_metadata_url,
    )


# Default table so `web_search_tool` works before any `configure_web_tools`
# call (DuckDuckGo only, matching the module-global defaults above).
_provider_dispatch = _rebuild_provider_dispatch()


def web_search_tool(arguments: dict[str, object], workspace: object) -> ToolHandlerResult:
    """Search the web for current information using the configured provider."""
    _ = workspace
    _check_rate_limit()

    query = str(arguments.get("query", "")).strip()
    if not query:
        raise ToolExecutionFailure(
            code=CMP_WEB_INVALID_URL,
            message="Missing search query.",
            retryable=False,
        )
    if len(query) > _MAX_QUERY_LENGTH:
        raise ToolExecutionFailure(
            code=CMP_WEB_INVALID_URL,
            message=f"Query exceeds maximum length of {_MAX_QUERY_LENGTH} characters.",
            retryable=False,
        )

    provider = _search_provider
    # `.get(provider)` with NO default: an unknown provider name must produce
    # the structured error below, never a silent fallback to DuckDuckGo.
    impl = _provider_dispatch.get(provider)
    if impl is None:
        payload = {
            "query": query,
            "provider": provider,
            "answer": "",
            "error": f"Unsupported web provider: {provider}",
            "sources": [],
            "citations": [],
            "missing_source_metadata": True,
            "source_url": "",
        }
        return ToolHandlerResult(output=json.dumps(payload, ensure_ascii=False), success=False)
    if not impl.is_configured():
        payload = {
            "query": query,
            "provider": provider,
            "answer": "",
            "error": f"{provider} is not configured (missing url/key).",
            "sources": [],
            "citations": [],
            "missing_source_metadata": True,
            "source_url": "",
        }
        return ToolHandlerResult(output=json.dumps(payload, ensure_ascii=False), success=False)

    timeout_s = max(1, min(30, _coerce_int_argument(arguments, "timeout_s", 10)))
    allowed_domains = _coerce_domain_filters(arguments, "allowed_domains")
    blocked_domains = _coerce_domain_filters(arguments, "blocked_domains")

    try:
        payload = impl.search(
            query,
            timeout_s=timeout_s,
            allowed_domains=list(allowed_domains) or None,
            blocked_domains=list(blocked_domains) or None,
        )
        # Contract: `error` is non-empty exactly when the search failed.
        return ToolHandlerResult(
            output=json.dumps(payload, ensure_ascii=False),
            success=not payload.get("error"),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("web_search failed: %s", exc)
        payload = {
            "query": query,
            "provider": provider,
            "answer": "",
            "error": "Web search failed.",
            "sources": [],
            "citations": [],
            "missing_source_metadata": True,
            "source_url": "",
        }
        return ToolHandlerResult(output=json.dumps(payload, ensure_ascii=False), success=False)


def fetch_url_tool(arguments: dict[str, object], workspace: object) -> ToolHandlerResult:
    """Fetch a URL and return bounded text or markdown content."""
    _ = workspace
    _check_rate_limit()

    url = str(arguments.get("url", "")).strip()
    if not url:
        raise ToolExecutionFailure(
            code=CMP_WEB_INVALID_URL,
            message="Missing url.",
            retryable=False,
        )

    try:
        validated = validate_public_url(url, allow_private=_allow_private_addresses)
    except PermissionError as exc:
        raise ToolExecutionFailure(
            code=CMP_WEB_SSRF_BLOCKED,
            message=str(exc),
            retryable=False,
        ) from exc
    except ValueError as exc:
        raise ToolExecutionFailure(
            code=CMP_WEB_INVALID_URL,
            message=str(exc),
            retryable=False,
        ) from exc

    requested = _coerce_int_argument(arguments, "max_chars", _DEFAULT_FETCH_MAX_CHARS)
    max_chars = _safe_fetch_content_limit(requested)
    timeout_s = max(1, min(30, _coerce_int_argument(arguments, "timeout_s", 10)))

    try:
        entry, cache_hit = _load_fetch_entry(validated, timeout_s=timeout_s)
    # A redirect hop that lands on a rejected address is the same policy block as
    # the first-hop check above — never a retryable fetch failure. These two arms
    # must stay ahead of the RedirectBlockedError arm they subclass.
    except RedirectPolicyBlockedError as exc:
        raise ToolExecutionFailure(
            code=CMP_WEB_SSRF_BLOCKED,
            message=str(exc),
            retryable=False,
        ) from exc
    except RedirectTargetInvalidError as exc:
        raise ToolExecutionFailure(
            code=CMP_WEB_INVALID_URL,
            message=str(exc),
            retryable=False,
        ) from exc
    except RedirectBlockedError as exc:
        raise ToolExecutionFailure(
            code=CMP_WEB_REDIRECT_BLOCKED,
            message=str(exc),
            retryable=False,
        ) from exc
    except urllib.error.HTTPError as exc:
        raise ToolExecutionFailure(
            code=CMP_WEB_FETCH_FAILED,
            message=f"HTTP error {exc.code}",
            retryable=True,
        ) from exc
    except ToolExecutionFailure:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ToolExecutionFailure(
            code=CMP_WEB_FETCH_FAILED,
            message="Failed to fetch URL.",
            retryable=True,
        ) from exc

    content = sanitize_tool_output(entry.content, max_chars=max_chars, tool_name="fetch_url")
    truncated = entry.truncated or len(content) < len(entry.content)
    host = urllib.parse.urlparse(entry.final_url).netloc
    citations = [
        {
            "id": "web:1",
            "url": entry.final_url,
            "title": host or entry.final_url,
        }
    ]
    payload: dict[str, Any] = {
        "ok": True,
        "status_code": entry.status_code,
        "url": entry.final_url,
        "requested_url": entry.requested_url,
        "final_url": entry.final_url,
        "redirected": bool(entry.redirect_chain),
        "redirect_chain": list(entry.redirect_chain),
        "cache_hit": cache_hit,
        "content_format": entry.content_format,
        "max_chars": max_chars,
        "timeout_s": timeout_s,
        "truncated": truncated,
        "content": content,
        "source_url": entry.final_url,
        "sources": [
            {
                "url": entry.final_url,
                "title": host or entry.final_url,
                "snippet": content[: min(280, max_chars)],
                "source_type": "fetched_url",
            }
        ],
        "citations": citations,
        "missing_source_metadata": False,
    }
    serialized = json.dumps(payload, ensure_ascii=False)
    if len(serialized) > _FETCH_RESPONSE_SERIALIZATION_BUDGET:
        overage = len(serialized) - _FETCH_RESPONSE_SERIALIZATION_BUDGET
        new_content_len = max(0, len(content) - overage - _FETCH_RESPONSE_TRIM_HEADROOM)
        trimmed_content = content[:new_content_len]
        payload["content"] = trimmed_content
        payload["truncated"] = True
        sources = cast(list[dict[str, Any]], payload["sources"])
        sources[0]["snippet"] = trimmed_content[:280]
        serialized = json.dumps(payload, ensure_ascii=False)
    return ToolHandlerResult(output=serialized, success=True)
