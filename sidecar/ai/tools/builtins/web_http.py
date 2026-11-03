"""Network-level security primitives for web tool requests."""

from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass
from email.message import Message
from typing import Any

from sidecar.ai.tools.builtins.web_url_policy import (
    LOOPBACK_HOSTNAMES,
    HopRequest,
    _is_public_ip,  # noqa: F401 - re-exported; web_ddg and tests import it from here
    address_allowed,
    next_hop_request,
    url_origin,
)

_MAX_URL_LENGTH = 8192
_MAX_FETCH_BYTES_HARD = 1024 * 1024
_MAX_REDIRECTS = 5
_READ_CHUNK_BYTES = 64 * 1024
_TIMEOUT_MESSAGE = "Web request timed out."
# Use a browser-like user agent because sites block bot-identifying clients.
# User-agent selection does not alter pinned-IP/no-redirect SSRF enforcement.
_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
_BROWSER_ACCEPT_LANGUAGE = "en-US,en;q=0.9"
_REDIRECT_STATUS_CODES = frozenset({301, 302, 303, 307, 308})
_MAX_CONCURRENT_DNS_LOOKUPS = 8
_DNS_LOOKUP_SLOTS = threading.BoundedSemaphore(_MAX_CONCURRENT_DNS_LOOKUPS)
_DNS_LOOKUP_THREAD_NAME = "web-dns-lookup"


@dataclass(frozen=True)
class ValidatedUrl:
    url: str
    pinned_ip: str = ""


@dataclass(frozen=True)
class UrlReadResult:
    payload: bytes
    was_truncated: bool
    content_type: str
    status_code: int
    requested_url: str
    final_url: str
    redirect_chain: tuple[str, ...]


@dataclass(frozen=True)
class _SingleFetchResult:
    payload: bytes
    was_truncated: bool
    content_type: str
    status_code: int
    location: str = ""


class HostResolutionError(ValueError):
    """The hostname did not resolve (DNS failure, not a malformed URL)."""


class RedirectBlockedError(RuntimeError):
    """Raised when redirect handling fails closed."""


class RedirectPolicyBlockedError(RedirectBlockedError):
    """A redirect hop resolved to an address the URL safety policy rejects.

    Mirrors the ``PermissionError`` the first hop raises out of
    ``validate_public_url``, so callers can classify a rejected redirect
    destination as the same non-retryable policy block rather than as a
    generic (retryable) fetch failure.
    """


class RedirectTargetInvalidError(RedirectBlockedError):
    """A redirect hop pointed at a malformed or unresolvable URL.

    The per-hop mirror of the ``ValueError`` arm of ``validate_public_url``.
    """


class WebRateLimiter:
    """Thread-safe sliding-window rate limiter."""

    def __init__(self, *, requests_per_minute: int = 30) -> None:
        self._limit = max(1, int(requests_per_minute))
        self._window_s = 60.0
        self._timestamps: deque[float] = deque()
        self._lock = threading.Lock()

    def check(self) -> None:
        now = time.monotonic()
        with self._lock:
            while self._timestamps and (now - self._timestamps[0]) > self._window_s:
                self._timestamps.popleft()
            if len(self._timestamps) >= self._limit:
                raise RuntimeError("Web tool rate limit exceeded.")
            self._timestamps.append(now)


def validate_public_url(
    raw_url: str,
    *,
    allow_private: bool = False,
    allow_loopback: bool = False,
    deadline: float | None = None,
) -> ValidatedUrl:
    """Validate a URL for safe fetching with SSRF protection.

    ``allow_loopback`` opens 127.0.0.0/8, ``::1`` and ``localhost`` only.
    ``allow_private`` opens every non-public range including loopback (it
    implies ``allow_loopback``). Cloud metadata addresses are refused under
    both. Under ``allow_private`` a hostname is resolved to screen out metadata
    targets but is returned unpinned, as before the loopback split.
    """
    if deadline is not None:
        _remaining_seconds(deadline)
    url_str = str(raw_url or "").strip()
    if not url_str:
        raise ValueError("URL must not be empty.")
    if len(url_str) > _MAX_URL_LENGTH:
        raise ValueError(f"URL exceeds maximum length of {_MAX_URL_LENGTH} characters.")

    parsed = urllib.parse.urlparse(url_str)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http and https URLs are allowed.")
    if parsed.username or parsed.password:
        raise ValueError("URLs with embedded credentials are not allowed.")
    host = str(parsed.hostname or "").strip()
    if not host:
        raise ValueError("URL must include a hostname.")

    host_lower = host.lower()
    if host_lower in LOOPBACK_HOSTNAMES:
        if not (allow_private or allow_loopback):
            raise PermissionError("Localhost addresses are blocked.")
        # The resolver answers `localhost` locally with loopback only (RFC 6761).
        # Left unpinned so the OS can fall back between ::1 and 127.0.0.1.
        return ValidatedUrl(url=parsed.geturl(), pinned_ip="")
    if not allow_private and host_lower.endswith(".local"):
        raise PermissionError("Local network hostnames are blocked.")

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not address_allowed(
            literal, allow_private=allow_private, allow_loopback=allow_loopback
        ):
            raise PermissionError("Private or local IP addresses are blocked.")
        return ValidatedUrl(url=parsed.geturl(), pinned_ip="")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    pinned_ip = _resolve_allowed_address(
        host, port, allow_private=allow_private, allow_loopback=allow_loopback, deadline=deadline
    )
    # Pinned under every flag, the private opt-in included: an unpinned connect
    # would resolve again, and a rebinding name could then reach cloud metadata.
    return ValidatedUrl(url=parsed.geturl(), pinned_ip=pinned_ip)


def _resolve_allowed_address(
    host: str,
    port: int,
    *,
    allow_private: bool,
    allow_loopback: bool,
    deadline: float | None,
) -> str:
    """Resolve ``host``; every address must pass the policy. Returns the first."""
    try:
        infos = _getaddrinfo(host, port, deadline=deadline)
    except socket.gaierror as exc:
        raise HostResolutionError(f"Hostname resolution failed: {host}") from exc

    if not infos:
        raise ValueError(f"Hostname resolution returned no addresses: {host}")
    pinned_ip = ""
    for info in infos:
        sockaddr = info[4]
        if not isinstance(sockaddr, tuple) or not sockaddr:
            continue
        addr_text = str(sockaddr[0]).strip()
        try:
            ip = ipaddress.ip_address(addr_text)
        except ValueError:
            continue
        if not address_allowed(ip, allow_private=allow_private, allow_loopback=allow_loopback):
            raise PermissionError("Private or local IP addresses are blocked.")
        if not pinned_ip:
            pinned_ip = addr_text
    if not pinned_ip:
        raise ValueError(f"Hostname resolution returned no usable addresses: {host}")
    return pinned_ip


def _remaining_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError(_TIMEOUT_MESSAGE)
    return remaining


def _getaddrinfo(host: str, port: int, *, deadline: float | None) -> list[Any]:
    if deadline is None:
        deadline = time.monotonic() + 10.0

    remaining = _remaining_seconds(deadline)
    # getaddrinfo cannot be cancelled, so a lookup that outlives its deadline is
    # abandoned to finish on its own. Each lookup holds a slot until it really
    # returns, which caps how many abandoned resolver threads can pile up behind
    # a hung DNS server; with every slot held a new lookup times out instead of
    # spawning another thread.
    slots = _DNS_LOOKUP_SLOTS
    if not slots.acquire(timeout=remaining):
        raise TimeoutError(_TIMEOUT_MESSAGE)
    finished = threading.Event()
    results: list[list[Any]] = []
    errors: list[Exception] = []

    def resolve() -> None:
        try:
            results.append(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
        finally:
            slots.release()
            finished.set()

    try:
        threading.Thread(target=resolve, name=_DNS_LOOKUP_THREAD_NAME, daemon=True).start()
    except BaseException:
        slots.release()
        raise
    if not finished.wait(timeout=_remaining_seconds(deadline)):
        raise TimeoutError(_TIMEOUT_MESSAGE)
    _remaining_seconds(deadline)
    if errors:
        raise errors[0]
    return results[0]


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, *, pinned_ip: str, **kwargs: Any) -> None:
        self._pinned_ip = str(pinned_ip or "").strip()
        super().__init__(host, **kwargs)

    def connect(self) -> None:
        source_address = getattr(self, "source_address", None)
        self.sock = socket.create_connection(
            (self._pinned_ip, self.port),
            self.timeout,
            source_address,
        )
        tunnel_host = getattr(self, "_tunnel_host", None)
        tunnel = getattr(self, "_tunnel", None)
        if tunnel_host and callable(tunnel):
            tunnel()


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, *, pinned_ip: str, **kwargs: Any) -> None:
        self._pinned_ip = str(pinned_ip or "").strip()
        super().__init__(host, **kwargs)

    def connect(self) -> None:
        source_address = getattr(self, "source_address", None)
        raw_sock = socket.create_connection(
            (self._pinned_ip, self.port),
            self.timeout,
            source_address,
        )
        tunnel_host = getattr(self, "_tunnel_host", None)
        tunnel = getattr(self, "_tunnel", None)
        if tunnel_host and callable(tunnel):
            self.sock = raw_sock
            tunnel()
            raw_sock = self.sock
        context = getattr(self, "_context", None)
        ssl_context = (
            context if isinstance(context, ssl.SSLContext) else ssl.create_default_context()
        )
        self.sock = ssl_context.wrap_socket(raw_sock, server_hostname=self.host)


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, pinned_ip: str) -> None:
        super().__init__()
        self._pinned_ip = str(pinned_ip or "").strip()

    def http_open(self, req: urllib.request.Request):  # type: ignore[override]
        return self.do_open(
            lambda host, **kwargs: _PinnedHTTPConnection(host, pinned_ip=self._pinned_ip, **kwargs),
            req,
        )


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(
        self,
        pinned_ip: str,
        *,
        context: ssl.SSLContext | None = None,
        check_hostname: bool | None = None,
    ) -> None:
        super().__init__(context=context, check_hostname=check_hostname)
        self._pinned_ip = str(pinned_ip or "").strip()
        self._ssl_context = context
        self._ssl_check_hostname = check_hostname

    def https_open(self, req: urllib.request.Request):  # type: ignore[override]
        conn_kwargs: dict[str, Any] = {}
        if self._ssl_context is not None:
            conn_kwargs["context"] = self._ssl_context
        if self._ssl_check_hostname is not None:
            conn_kwargs["check_hostname"] = self._ssl_check_hostname
        return self.do_open(
            lambda host, **kwargs: _PinnedHTTPSConnection(
                host,
                pinned_ip=self._pinned_ip,
                **kwargs,
            ),
            req,
            **conn_kwargs,
        )


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(  # type: ignore[override]
        self, req, fp, code, msg, headers, newurl
    ):
        _ = (code, msg, headers, newurl)
        response_headers = getattr(fp, "headers", None)
        if not isinstance(response_headers, Message):
            response_headers = Message()
        raise urllib.error.HTTPError(
            req.full_url,
            fp.status if hasattr(fp, "status") else 302,
            "Redirect intercepted for manual validation.",
            response_headers,
            fp,
        )


def _build_opener(pinned_ip: str) -> Any:
    # An empty ProxyHandler first: the default one reads env/system proxies and
    # rewrites req.host, so the pinned connection would dial the target IP at the
    # proxy's port. Web tools always connect directly to the validated address.
    handlers: list[urllib.request.BaseHandler] = [
        urllib.request.ProxyHandler({}),
        _NoRedirectHandler(),
    ]
    safe_pinned_ip = str(pinned_ip or "").strip()
    if safe_pinned_ip:
        handlers.extend(
            (
                _PinnedHTTPHandler(safe_pinned_ip),
                _PinnedHTTPSHandler(safe_pinned_ip),
            )
        )
    return urllib.request.build_opener(*handlers)


def _set_response_timeout(response: Any, timeout_s: float) -> None:
    fp = getattr(response, "fp", None)
    raw = getattr(fp, "raw", None)
    nested_fp = getattr(fp, "fp", None)
    nested_raw = getattr(nested_fp, "raw", None)
    candidates = (
        response,
        getattr(raw, "_sock", None),
        getattr(nested_raw, "_sock", None),
        getattr(fp, "_sock", None),
        getattr(nested_fp, "_sock", None),
        getattr(response, "_sock", None),
    )
    for candidate in candidates:
        setter = getattr(candidate, "settimeout", None)
        if callable(setter):
            setter(timeout_s)
            return


def _read_response_payload(
    response: Any,
    *,
    limit: int,
    deadline: float,
) -> tuple[bytes, bool, str]:
    content_type = str(response.headers.get("Content-Type", "") or "").strip()
    raw_cl = response.headers.get("Content-Length")
    if raw_cl is not None:
        try:
            declared_length = int(raw_cl)
            if declared_length > limit:
                return b"", True, content_type
        except (TypeError, ValueError):
            pass
    chunks: list[bytes] = []
    total = 0
    while total <= limit:
        remaining = _remaining_seconds(deadline)
        _set_response_timeout(response, remaining)
        chunk = response.read(min(_READ_CHUNK_BYTES, limit + 1 - total))
        _remaining_seconds(deadline)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    payload = b"".join(chunks)
    truncated = len(payload) > limit
    if truncated:
        payload = payload[:limit]
    return payload, truncated, content_type


def _open_url_once(
    validated: ValidatedUrl,
    *,
    timeout_s: float,
    max_bytes: int,
    deadline: float,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> _SingleFetchResult:
    request = urllib.request.Request(validated.url, data=data, method=method)
    request.add_header("User-Agent", _BROWSER_USER_AGENT)
    request.add_header("Accept", _BROWSER_ACCEPT)
    request.add_header("Accept-Language", _BROWSER_ACCEPT_LANGUAGE)
    for header, value in (headers or {}).items():
        request.add_header(header, value)
    opener = _build_opener(validated.pinned_ip)
    try:
        open_timeout = min(timeout_s, _remaining_seconds(deadline))
        with opener.open(request, timeout=open_timeout) as response:
            status_code = int(getattr(response, "status", getattr(response, "code", 200)) or 200)
            if status_code in _REDIRECT_STATUS_CODES:
                return _SingleFetchResult(
                    payload=b"",
                    was_truncated=False,
                    content_type=str(response.headers.get("Content-Type", "") or "").strip(),
                    status_code=status_code,
                    location=str(response.headers.get("Location", "") or "").strip(),
                )
            payload, truncated, content_type = _read_response_payload(
                response,
                limit=max_bytes,
                deadline=deadline,
            )
            return _SingleFetchResult(
                payload=payload,
                was_truncated=truncated,
                content_type=content_type,
                status_code=status_code,
            )
    except urllib.error.HTTPError as exc:
        if exc.code in _REDIRECT_STATUS_CODES:
            location = str(exc.headers.get("Location", "") or "").strip()
            try:
                return _SingleFetchResult(
                    payload=b"",
                    was_truncated=False,
                    content_type=str(exc.headers.get("Content-Type", "") or "").strip(),
                    status_code=exc.code,
                    location=location,
                )
            finally:
                exc.close()
        raise


def read_url_response(
    validated: ValidatedUrl,
    *,
    timeout_s: float = 10,
    max_bytes: int = _MAX_FETCH_BYTES_HARD,
    allow_private: bool = False,
    allow_loopback: bool = False,
    max_redirects: int = _MAX_REDIRECTS,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    deadline: float | None = None,
) -> UrlReadResult:
    """Fetch URL bytes with DNS pinning, redirect validation, and size limits."""
    if deadline is None:
        deadline = time.monotonic() + float(timeout_s)
    limit = min(_MAX_FETCH_BYTES_HARD, max(1024, int(max_bytes)))
    requested_url = validated.url
    current = validated
    redirect_chain: list[str] = []
    seen_urls = {requested_url}
    request = HopRequest(method=method, data=data, headers=dict(headers or {}))

    for hop in range(max_redirects + 1):
        remaining = _remaining_seconds(deadline)
        single = _open_url_once(
            current,
            timeout_s=remaining,
            max_bytes=limit,
            deadline=deadline,
            method=request.method,
            data=request.data,
            headers=request.headers,
        )
        _remaining_seconds(deadline)
        if single.status_code not in _REDIRECT_STATUS_CODES:
            return UrlReadResult(
                payload=single.payload,
                was_truncated=single.was_truncated,
                content_type=single.content_type,
                status_code=single.status_code,
                requested_url=requested_url,
                final_url=current.url,
                redirect_chain=tuple(redirect_chain),
            )

        if not single.location:
            raise RedirectBlockedError("Redirect response did not include a Location header.")
        # The hop limit comes before the Location host is parsed or resolved, so a
        # caller that follows no redirects never DNS-pings the target.
        if hop >= max_redirects:
            break
        target_url = urllib.parse.urljoin(current.url, single.location)
        # Decided from the URL alone, so a refused cross-origin resend costs no DNS.
        next_request = next_hop_request(
            single.status_code,
            request,
            same_origin=url_origin(current.url) == url_origin(target_url),
        )
        if next_request is None:
            raise RedirectBlockedError(
                "Redirect would resend a request body or unsafe method to another origin."
            )
        # Re-raise a rejected hop as a redirect-shaped failure so callers give it
        # the same non-retryable classification the first hop gets. The messages
        # stay host-free on purpose: unlike the first hop, this target comes from
        # an attacker-controlled Location header and must never echo into output.
        try:
            next_validated = validate_public_url(
                target_url,
                allow_private=allow_private,
                allow_loopback=allow_loopback,
                deadline=deadline,
            )
        except PermissionError as exc:
            raise RedirectPolicyBlockedError(
                "Redirect destination was rejected by the URL safety policy."
            ) from exc
        except ValueError as exc:
            raise RedirectTargetInvalidError(
                "Redirect destination was not a valid, resolvable URL."
            ) from exc
        if next_validated.url in seen_urls:
            raise RedirectBlockedError("Redirect loop detected.")
        seen_urls.add(next_validated.url)
        redirect_chain.append(next_validated.url)
        current = next_validated
        request = next_request

    raise RedirectBlockedError(f"Too many redirects (maximum {max_redirects}).")
