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
_NAT64_WELL_KNOWN_NETWORK = ipaddress.ip_network("64:ff9b::/96")
_SHARED_ADDRESS_SPACE = ipaddress.ip_network("100.64.0.0/10")
# RFC 5214 §6.1: the top 32 bits of an ISATAP interface identifier. `0200:5efe`
# sets the universal/local bit and is reserved for a globally-unique embedded
# IPv4; `0000:5efe` is the form used otherwise. Both are matched — see
# `_is_public_ip`.
_ISATAP_INTERFACE_MARKERS = frozenset({0x00005EFE, 0x02005EFE})


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


def _is_public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # IPv4-mapped IPv6 (::ffff:a.b.c.d) is a classic SSRF-filter bypass shape and
    # its stdlib classification changed across Python 3.11.x — fail closed.
    if getattr(ip, "ipv4_mapped", None) is not None:
        return False
    # 6to4 and Teredo embed an IPv4 target inside an IPv6 wrapper. Veto on that
    # embedded IPv4 — an extra rejection, not a replacement: the wrapper's own
    # range checks below still run. 6to4 is the live gap, since up to Python
    # 3.11.9 those checks score 2002::/16 as public and an embedded private
    # target rides straight through. Teredo is drift-proofing — every 3.11.x
    # already rejects 2001::/32 incidentally via `is_private` — but that is
    # stdlib classification we do not control (it moved for 6to4 in 3.11.10 /
    # gh-113171), so decide it here rather than inherit it.
    embedded = getattr(ip, "sixtofour", None)
    teredo = getattr(ip, "teredo", None)
    if teredo is not None:
        embedded = teredo[1]
    if embedded is not None and not _is_public_ip(embedded):
        return False
    # ISATAP (RFC 5214) embeds its IPv4 target in the interface identifier, under
    # *any* /64 — there is no prefix that confirms the form, so the stdlib exposes
    # no attribute for it and this arm is a pattern match rather than a decode.
    # That imprecision is bounded by gating the veto on the embedded value: the
    # only address it can wrongly reject is a public IPv6 host whose identifier
    # both matches a 32-bit marker and trails a non-public IPv4 — ~2/2**32 x 0.14
    # of random identifiers, and structurally impossible for EUI-64 ones, whose
    # `ff` byte sits where the marker requires `fe`. A wrong reject costs one
    # blocked fetch; a wrong accept is the SSRF this function exists to stop.
    # Both markers are matched even though RFC 5214 reserves `0200:5efe` for a
    # globally-unique (hence public) IPv4: decapsulation ignores that bit, so an
    # attacker-published literal must not evade the veto by setting it.
    if isinstance(ip, ipaddress.IPv6Address):
        isatap_marker = (int(ip) >> 32) & 0xFFFFFFFF
        isatap_target = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        if isatap_marker in _ISATAP_INTERFACE_MARKERS and not _is_public_ip(isatap_target):
            return False
    # NAT64's well-known prefix and CGNAT shared address space both reach hosts we
    # must not treat as public. The NAT64 arm is defense-in-depth for the same
    # reason as Teredo — 64:ff9b::/96 currently lands in `is_reserved`. The CGNAT
    # arm is a live gap: upstream deliberately leaves 100.64.0.0/10 out of
    # `is_private`.
    if ip in _NAT64_WELL_KNOWN_NETWORK or ip in _SHARED_ADDRESS_SPACE:
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_public_url(
    raw_url: str,
    *,
    allow_private: bool = False,
    deadline: float | None = None,
) -> ValidatedUrl:
    """Validate a URL for safe fetching with SSRF protection."""
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
    if not allow_private and host_lower in {"localhost", "localhost.localdomain"}:
        raise PermissionError("Localhost addresses are blocked.")
    if not allow_private and host_lower.endswith(".local"):
        raise PermissionError("Local network hostnames are blocked.")

    try:
        ip = ipaddress.ip_address(host)
        if not allow_private and not _is_public_ip(ip):
            raise PermissionError("Private or local IP addresses are blocked.")
        return ValidatedUrl(url=parsed.geturl(), pinned_ip="")
    except ValueError:
        pass

    if allow_private:
        return ValidatedUrl(url=parsed.geturl(), pinned_ip="")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = _getaddrinfo(host, port, deadline=deadline)
    except socket.gaierror as exc:
        raise ValueError(f"Hostname resolution failed: {host}") from exc

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
        if not _is_public_ip(ip):
            raise PermissionError("Private or local IP addresses are blocked.")
        if not pinned_ip:
            pinned_ip = addr_text
    if not pinned_ip:
        raise ValueError(f"Hostname resolution returned no usable addresses: {host}")
    return ValidatedUrl(url=parsed.geturl(), pinned_ip=pinned_ip)


def _remaining_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError(_TIMEOUT_MESSAGE)
    return remaining


def _getaddrinfo(host: str, port: int, *, deadline: float | None) -> list[Any]:
    if deadline is None:
        return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)

    remaining = _remaining_seconds(deadline)
    finished = threading.Event()
    results: list[list[Any]] = []
    errors: list[Exception] = []

    def resolve() -> None:
        try:
            results.append(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
        finally:
            finished.set()

    threading.Thread(target=resolve, daemon=True).start()
    if not finished.wait(timeout=remaining):
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
    def redirect_request(  # type: ignore[override]  # noqa: PLR0917
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
    handlers: list[urllib.request.BaseHandler] = [_NoRedirectHandler()]
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
    max_redirects: int = _MAX_REDIRECTS,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> UrlReadResult:
    """Fetch URL bytes with DNS pinning, redirect validation, and size limits."""
    deadline = time.monotonic() + float(timeout_s)
    limit = min(_MAX_FETCH_BYTES_HARD, max(1024, int(max_bytes)))
    requested_url = validated.url
    current = validated
    redirect_chain: list[str] = []
    seen_urls = {requested_url}

    for _ in range(max_redirects + 1):
        remaining = _remaining_seconds(deadline)
        single = _open_url_once(
            current,
            timeout_s=remaining,
            max_bytes=limit,
            deadline=deadline,
            method=method,
            data=data,
            headers=headers,
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
        target_url = urllib.parse.urljoin(current.url, single.location)
        # Re-raise a rejected hop as a redirect-shaped failure so callers give it
        # the same non-retryable classification the first hop gets. The messages
        # stay host-free on purpose: unlike the first hop, this target comes from
        # an attacker-controlled Location header and must never echo into output.
        try:
            next_validated = validate_public_url(
                target_url,
                allow_private=allow_private,
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

    raise RedirectBlockedError(f"Too many redirects (maximum {max_redirects}).")
