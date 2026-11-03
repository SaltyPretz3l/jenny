"""URL safety policy for web requests: address classes and redirect-hop rules.

Pure decisions with no I/O; `web_http` owns DNS, connections and reads.
"""

from __future__ import annotations

import ipaddress
import urllib.parse
from dataclasses import dataclass

_SEE_OTHER = 303
# Statuses on which fetch rewrites a POST (only) to a bodyless GET.
_POST_TO_GET_STATUSES = frozenset({301, 302})
# Methods a redirect may carry to another origin (no body, no side effect).
_CROSS_ORIGIN_SAFE_METHODS = frozenset({"GET", "HEAD"})
# Request-body headers dropped with the body when a redirect rewrites to GET.
_REQUEST_BODY_HEADERS = frozenset(
    {"content-type", "content-length", "content-encoding", "content-language", "content-location"}
)
_NAT64_WELL_KNOWN_NETWORK = ipaddress.ip_network("64:ff9b::/96")
_NAT64_LOCAL_USE_NETWORK = ipaddress.ip_network("64:ff9b:1::/48")
_SHARED_ADDRESS_SPACE = ipaddress.ip_network("100.64.0.0/10")
# Ranges older Python 3.11.x classify as public: deprecated site-local, the full
# IETF protocol-assignments /24 (stdlib only knows a /29 of it) and local-use NAT64.
_EXTRA_BLOCKED = (
    ipaddress.ip_network("fec0::/10"),
    ipaddress.ip_network("192.0.0.0/24"),
    _NAT64_LOCAL_USE_NETWORK,
)
LOOPBACK_HOSTNAMES = frozenset({"localhost", "localhost.localdomain"})
_IPV4_LOOPBACK_NETWORK = ipaddress.ip_network("127.0.0.0/8")
_IPV6_LOOPBACK = ipaddress.ip_address("::1")
# Cloud instance-metadata endpoints. Neither opt-in flag opens them, directly or
# wrapped in an IPv4-mapped/NAT64/6to4/Teredo/ISATAP form.
_CLOUD_METADATA_ADDRESSES = frozenset(
    ipaddress.ip_address(address)
    for address in (
        "169.254.169.254",  # AWS, GCP, Azure, OCI, DigitalOcean
        "169.254.170.2",  # AWS ECS task credentials
        "100.100.100.200",  # Alibaba Cloud
        "fd00:ec2::254",  # AWS IMDS over IPv6
    )
)
# RFC 5214 §6.1: the top 32 bits of an ISATAP interface identifier. `0200:5efe`
# sets the universal/local bit and is reserved for a globally-unique embedded
# IPv4; `0000:5efe` is the form used otherwise. Both are matched — see
# `_is_public_ip`.
_ISATAP_INTERFACE_MARKERS = frozenset({0x00005EFE, 0x02005EFE})


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
    if any(ip in net for net in _EXTRA_BLOCKED):
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _embedded_ipv4(
    ip: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> tuple[ipaddress.IPv4Address, ...]:
    """Every IPv4 an IPv6 address may carry (mapped, 6to4, Teredo, NAT64, ISATAP)."""
    if not isinstance(ip, ipaddress.IPv6Address):
        return ()
    found = [addr for addr in (ip.ipv4_mapped, ip.sixtofour) if addr is not None]
    if ip.teredo is not None:
        found.append(ip.teredo[1])
    marker = (int(ip) >> 32) & 0xFFFFFFFF
    if (
        ip in _NAT64_WELL_KNOWN_NETWORK
        or ip in _NAT64_LOCAL_USE_NETWORK
        or marker in _ISATAP_INTERFACE_MARKERS
    ):
        found.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return tuple(found)


def _is_cloud_metadata_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip in _CLOUD_METADATA_ADDRESSES:
        return True
    return any(addr in _CLOUD_METADATA_ADDRESSES for addr in _embedded_ipv4(ip))


def _is_loopback_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # Plain forms only: an IPv4-mapped or tunnelled loopback stays refused.
    return ip in _IPV4_LOOPBACK_NETWORK or ip == _IPV6_LOOPBACK


def address_allowed(
    ip: ipaddress.IPv4Address | ipaddress.IPv6Address,
    *,
    allow_private: bool,
    allow_loopback: bool,
) -> bool:
    if _is_cloud_metadata_ip(ip):
        return False
    if allow_private:
        return True
    if allow_loopback and _is_loopback_ip(ip):
        return True
    return _is_public_ip(ip)


@dataclass(frozen=True)
class HopRequest:
    method: str
    data: bytes | None
    headers: dict[str, str]


def url_origin(url: str) -> tuple[str, str, int]:
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    try:
        port = parsed.port or (443 if scheme == "https" else 80)
    except ValueError:
        port = -1  # malformed port: never equal to a real origin, so fail closed
    return scheme, str(parsed.hostname or "").lower(), port


def next_hop_request(
    status: int, request: HopRequest, *, same_origin: bool
) -> HopRequest | None:
    """The request a redirect hop sends, following fetch's method/header rules.

    303 rewrites anything but GET/HEAD to a bodyless GET and 301/302 rewrite a
    POST the same way. A cross-origin hop drops every caller-supplied header
    (Authorization, Cookie, API keys; the module defaults are re-added per hop)
    and is refused (None) if it would still carry a body or a non-GET/HEAD
    method (a 307/308 POST, for one).
    """
    method, data, headers = request.method, request.data, request.headers
    upper = method.upper()
    if (status == _SEE_OTHER and upper not in _CROSS_ORIGIN_SAFE_METHODS) or (
        status in _POST_TO_GET_STATUSES and upper == "POST"
    ):
        method, data = "GET", None
        headers = {k: v for k, v in headers.items() if k.lower() not in _REQUEST_BODY_HEADERS}
    if not same_origin:
        if data is not None or method.upper() not in _CROSS_ORIGIN_SAFE_METHODS:
            return None
        headers = {}
    return HopRequest(method=method, data=data, headers=headers)
