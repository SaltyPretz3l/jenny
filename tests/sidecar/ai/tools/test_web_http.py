"""Tests for web_http network security primitives."""

from __future__ import annotations

import ipaddress
import socket
from unittest.mock import MagicMock, patch

import pytest

from sidecar.ai.tools.builtins.web_http import (
    RedirectBlockedError,
    RedirectPolicyBlockedError,
    RedirectTargetInvalidError,
    UrlReadResult,
    ValidatedUrl,
    WebRateLimiter,
    _is_public_ip,
    _open_url_once,
    _SingleFetchResult,
    read_url_response,
    validate_public_url,
)


class _ForcedTunnelAddress(ipaddress.IPv6Address):
    """IPv6 address whose tunnel attributes are forced onto a public wrapper.

    The real tunnel forms cannot exercise `_is_public_ip`'s embedded-IPv4 branch
    on every interpreter: 2001::/23 (Teredo) is unconditionally `is_private` on
    every 3.11.x, and 2002::/16 (6to4) became private in 3.11.10 (gh-113171), so
    the top-level range checks reject them before the branch is reached. Forcing
    the attribute onto an ordinary public address is the only way to test that
    the branch itself picks the right embedded address.
    """

    forced_sixtofour: ipaddress.IPv4Address | None = None
    forced_teredo: tuple[ipaddress.IPv4Address, ipaddress.IPv4Address] | None = None

    @property
    def sixtofour(self) -> ipaddress.IPv4Address | None:
        return self.forced_sixtofour

    @property
    def teredo(self) -> tuple[ipaddress.IPv4Address, ipaddress.IPv4Address] | None:
        return self.forced_teredo


class _NonReservedAddress(ipaddress.IPv6Address):
    """IPv6 address that denies `is_reserved`, exposing the NAT64 membership arm.

    64:ff9b::/96 currently lands in the stdlib's reserved set, which masks the
    explicit NAT64 rejection in `_is_public_ip`. Denying that one flag leaves the
    membership check as the only thing that can reject the address.
    """

    @property
    def is_reserved(self) -> bool:
        return False


class TestIsPublicIp:
    def test_public_ipv4(self) -> None:
        assert _is_public_ip(ipaddress.ip_address("8.8.8.8")) is True

    def test_private_ipv4(self) -> None:
        assert _is_public_ip(ipaddress.ip_address("192.168.1.1")) is False

    def test_loopback_ipv4(self) -> None:
        assert _is_public_ip(ipaddress.ip_address("127.0.0.1")) is False

    def test_link_local_ipv4(self) -> None:
        assert _is_public_ip(ipaddress.ip_address("169.254.1.1")) is False

    def test_multicast_ipv4(self) -> None:
        assert _is_public_ip(ipaddress.ip_address("224.0.0.1")) is False

    def test_ipv6_loopback(self) -> None:
        assert _is_public_ip(ipaddress.ip_address("::1")) is False

    def test_ipv6_mapped_ipv4_loopback(self) -> None:
        addr = ipaddress.ip_address("::ffff:127.0.0.1")
        assert _is_public_ip(addr) is False

    def test_ipv6_mapped_ipv4_private(self) -> None:
        addr = ipaddress.ip_address("::ffff:192.168.1.1")
        assert _is_public_ip(addr) is False

    def test_ipv6_mapped_ipv4_public_is_reserved(self) -> None:
        addr = ipaddress.ip_address("::ffff:8.8.8.8")
        assert _is_public_ip(addr) is False

    def test_unspecified(self) -> None:
        assert _is_public_ip(ipaddress.ip_address("0.0.0.0")) is False

    def test_ipv6_6to4_loopback(self) -> None:
        addr = ipaddress.ip_address("2002:7f00:1::")
        assert _is_public_ip(addr) is False

    def test_ipv6_6to4_private(self) -> None:
        addr = ipaddress.ip_address("2002:c0a8:101::")
        assert _is_public_ip(addr) is False

    def test_ipv6_6to4_public_stays_public(self) -> None:
        if ipaddress.ip_address("2002::").is_private:
            pytest.skip(
                "Python 3.11.10+ (gh-113171) classifies all of 2002::/16 as private; "
                "that upstream verdict is fail-closed and supersedes this pin."
            )
        addr = ipaddress.ip_address("2002:808:808::")
        assert _is_public_ip(addr) is True

    def test_ipv6_teredo_private_client(self) -> None:
        addr = ipaddress.ip_address("2001:0:4136:e378:8000:0:3f57:fefe")
        assert _is_public_ip(addr) is False

    def test_ipv6_teredo_loopback_client(self) -> None:
        addr = ipaddress.ip_address("2001:0:4136:e378:8000:0:80ff:fffe")
        assert _is_public_ip(addr) is False

    def test_ipv6_teredo_public_client_still_nonpublic(self) -> None:
        addr = ipaddress.ip_address("2001:0:4136:e378:8000:0:f7f7:f7f7")
        assert _is_public_ip(addr) is False

    def test_cgnat_shared_address_space_ipv4(self) -> None:
        assert _is_public_ip(ipaddress.ip_address("100.64.0.1")) is False

    def test_ipv6_6to4_cgnat_shared_address_space(self) -> None:
        addr = ipaddress.ip_address("2002:6440:1::")
        assert _is_public_ip(addr) is False

    def test_ipv6_nat64_loopback(self) -> None:
        addr = ipaddress.ip_address("64:ff9b::7f00:1")
        assert _is_public_ip(addr) is False

    def test_ipv6_nat64_public_ipv4_still_rejected(self) -> None:
        addr = ipaddress.ip_address("64:ff9b::808:808")
        assert _is_public_ip(addr) is False

    def test_ipv6_public_global_unicast(self) -> None:
        addr = ipaddress.ip_address("2606:4700::1111")
        assert _is_public_ip(addr) is True

    # ISATAP needs no stub wrapper the way 6to4 and Teredo do: the form carries no
    # reserved prefix, so a public-prefixed ISATAP address reaches the branch with
    # every top-level range check passing. That is exactly why it was a live gap.
    @pytest.mark.parametrize(
        ("literal", "target"),
        [
            ("2606:4700::5efe:c0a8:101", "192.168.1.1"),
            ("2606:4700::5efe:7f00:1", "127.0.0.1"),
            ("2606:4700::5efe:a9fe:1", "169.254.0.1"),
            ("2606:4700::5efe:6440:1", "100.64.0.1"),
            ("2606:4700::5efe:0:0", "0.0.0.0"),
        ],
    )
    def test_ipv6_isatap_nonpublic_target(self, literal: str, target: str) -> None:
        addr = ipaddress.ip_address(literal)
        # Pin that the literal really does embed the address named, so a typo in
        # the table cannot quietly turn into a vacuous pass.
        assert ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF) == ipaddress.ip_address(target)
        assert _is_public_ip(addr) is False

    def test_ipv6_isatap_universal_bit_variant_private_target(self) -> None:
        # RFC 5214 reserves the 0200:5efe form for globally-unique IPv4, but an
        # attacker publishes the literal, so the private target must still lose.
        addr = ipaddress.ip_address("2606:4700::200:5efe:c0a8:101")
        assert _is_public_ip(addr) is False

    def test_ipv6_isatap_public_target_stays_public(self) -> None:
        addr = ipaddress.ip_address("2606:4700::5efe:808:808")
        assert _is_public_ip(addr) is True


class TestIsPublicIpTunnelBranches:
    """Direct coverage for the embedded-IPv4 and NAT64 branches.

    The tests above that use real tunnel addresses are masked by the top-level
    range checks on at least one supported interpreter, so they would still pass
    if a branch here were deleted, inverted, or read the wrong tuple element.
    These stub-backed cases fail in each of those cases.
    """

    def test_stub_wrapper_is_public_without_forced_attributes(self) -> None:
        # Control: the stubs must not make an address non-public on their own.
        assert _is_public_ip(_ForcedTunnelAddress("2606:4700::1111")) is True
        assert _is_public_ip(_NonReservedAddress("2606:4700::1111")) is True

    @pytest.mark.parametrize(
        "embedded",
        ["192.168.1.1", "127.0.0.1", "169.254.1.1", "224.0.0.1", "0.0.0.0", "100.64.0.1"],
    )
    def test_teredo_branch_rejects_every_nonpublic_client(self, embedded: str) -> None:
        # The branch must run the embedded address through the whole policy, not
        # just an `is_private` spot check — one case per rejected class.
        addr = _ForcedTunnelAddress("2606:4700::1111")
        addr.forced_teredo = (
            ipaddress.ip_address("8.8.8.8"),
            ipaddress.ip_address(embedded),
        )
        assert _is_public_ip(addr) is False

    def test_teredo_branch_judges_the_client_not_the_server(self) -> None:
        # A private *server* with a public client must stay public; paired with
        # the test above this pins `teredo[1]` from both directions.
        addr = _ForcedTunnelAddress("2606:4700::1111")
        addr.forced_teredo = (
            ipaddress.ip_address("192.168.1.1"),
            ipaddress.ip_address("8.8.8.8"),
        )
        assert _is_public_ip(addr) is True

    @pytest.mark.parametrize(
        "embedded",
        ["192.168.1.1", "127.0.0.1", "169.254.1.1", "224.0.0.1", "0.0.0.0", "100.64.0.1"],
    )
    def test_sixtofour_branch_rejects_every_nonpublic_ipv4(self, embedded: str) -> None:
        addr = _ForcedTunnelAddress("2606:4700::1111")
        addr.forced_sixtofour = ipaddress.ip_address(embedded)
        assert _is_public_ip(addr) is False

    def test_sixtofour_branch_allows_public_embedded_ipv4(self) -> None:
        addr = _ForcedTunnelAddress("2606:4700::1111")
        addr.forced_sixtofour = ipaddress.ip_address("8.8.8.8")
        assert _is_public_ip(addr) is True

    def test_nat64_prefix_rejected_without_the_reserved_flag(self) -> None:
        addr = _NonReservedAddress("64:ff9b::808:808")
        assert _is_public_ip(addr) is False

    # The ISATAP arm is a pattern match on an unreserved bit pattern, so its
    # precision is the thing that needs pinning: widening the marker set, masking
    # the wrong 32 bits, or dropping the embedded-value gate would each let it
    # reject ordinary public IPv6. Every literal below trails a private IPv4 and
    # must still be public, so only over-matching can fail them.
    @pytest.mark.parametrize(
        ("literal", "why"),
        [
            ("2606:4700::5eff:c0a8:101", "marker 0000:5eff — one bit off"),
            ("2606:4700::5efd:c0a8:101", "marker 0000:5efd — one bit off"),
            ("2606:4700::1:5efe:c0a8:101", "marker 0001:5efe — high half not zero"),
            ("2606:4700::201:5efe:c0a8:101", "marker 0201:5efe — not the u-bit form"),
            ("2606:4700:5efe:c0a8:101:0:c0a8:101", "5efe in the prefix, not the identifier"),
            ("2606:4700::5efe:1:c0a8:101", "marker shifted out of the identifier's top half"),
        ],
    )
    def test_isatap_near_miss_markers_stay_public(self, literal: str, why: str) -> None:
        assert _is_public_ip(ipaddress.ip_address(literal)) is True, why


class TestValidatePublicUrl:
    def test_rejects_empty_url(self) -> None:
        with pytest.raises(ValueError, match="empty"):
            validate_public_url("")

    def test_rejects_ftp_scheme(self) -> None:
        with pytest.raises(ValueError, match="http"):
            validate_public_url("ftp://example.com")

    def test_rejects_data_scheme(self) -> None:
        with pytest.raises(ValueError, match="http"):
            validate_public_url("data:text/html,hello")

    def test_rejects_file_scheme(self) -> None:
        with pytest.raises(ValueError, match="http"):
            validate_public_url("file:///etc/passwd")

    def test_rejects_credentials_in_url(self) -> None:
        with pytest.raises(ValueError, match="credentials"):
            validate_public_url("https://user:pass@example.com")

    def test_rejects_url_too_long(self) -> None:
        long_url = "https://example.com/" + "a" * 9000
        with pytest.raises(ValueError, match="maximum length"):
            validate_public_url(long_url)

    def test_rejects_localhost(self) -> None:
        with pytest.raises(PermissionError, match="Localhost"):
            validate_public_url("http://localhost/foo")

    def test_rejects_localhost_localdomain(self) -> None:
        with pytest.raises(PermissionError, match="Localhost"):
            validate_public_url("http://localhost.localdomain/foo")

    def test_rejects_dot_local(self) -> None:
        with pytest.raises(PermissionError, match="Local network"):
            validate_public_url("http://myserver.local/foo")

    def test_rejects_private_ip_literal(self) -> None:
        with pytest.raises(PermissionError, match="Private"):
            validate_public_url("http://192.168.1.1/foo")

    def test_rejects_loopback_ip_literal(self) -> None:
        with pytest.raises(PermissionError, match="Private"):
            validate_public_url("http://127.0.0.1/foo")

    def test_allows_localhost_with_allow_private(self) -> None:
        result = validate_public_url("http://localhost/foo", allow_private=True)
        assert result.url == "http://localhost/foo"

    @patch("sidecar.ai.tools.builtins.web_http.socket.getaddrinfo")
    def test_rejects_private_resolved_ip(self, mock_getaddrinfo: MagicMock) -> None:
        mock_getaddrinfo.return_value = [
            (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.1", 443)),
        ]
        with pytest.raises(PermissionError, match="Private"):
            validate_public_url("https://evil.example.com")

    @patch("sidecar.ai.tools.builtins.web_http.socket.getaddrinfo")
    def test_pins_public_ip(self, mock_getaddrinfo: MagicMock) -> None:
        mock_getaddrinfo.return_value = [
            (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443)),
        ]
        result = validate_public_url("https://example.com")
        assert result.pinned_ip == "93.184.216.34"

    @patch("sidecar.ai.tools.builtins.web_http.socket.getaddrinfo")
    def test_dns_failure_raises(self, mock_getaddrinfo: MagicMock) -> None:
        mock_getaddrinfo.side_effect = socket.gaierror("DNS failed")
        with pytest.raises(ValueError, match="resolution failed"):
            validate_public_url("https://nonexistent.example.com")


class TestReadUrlResponse:
    def test_follows_safe_redirect_chain(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls: list[str] = []

        def fake_open_once(
            validated: ValidatedUrl, *, timeout_s: int, max_bytes: int
        ) -> _SingleFetchResult:
            _ = (timeout_s, max_bytes)
            calls.append(validated.url)
            if validated.url == "https://start.example.com":
                return _SingleFetchResult(
                    payload=b"",
                    was_truncated=False,
                    content_type="text/html",
                    status_code=302,
                    location="https://docs.example.com/page",
                )
            return _SingleFetchResult(
                payload=b"ok",
                was_truncated=False,
                content_type="text/plain",
                status_code=200,
            )

        monkeypatch.setattr("sidecar.ai.tools.builtins.web_http._open_url_once", fake_open_once)
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.web_http.validate_public_url",
            lambda raw_url, allow_private=False: ValidatedUrl(url=raw_url, pinned_ip=""),
        )

        result = read_url_response(ValidatedUrl(url="https://start.example.com", pinned_ip=""))

        assert isinstance(result, UrlReadResult)
        assert result.requested_url == "https://start.example.com"
        assert result.final_url == "https://docs.example.com/page"
        assert result.redirect_chain == ("https://docs.example.com/page",)
        assert calls == ["https://start.example.com", "https://docs.example.com/page"]

    def test_blocks_redirect_to_private_target(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.web_http._open_url_once",
            lambda validated, **_kwargs: _SingleFetchResult(
                payload=b"",
                was_truncated=False,
                content_type="text/html",
                status_code=302,
                location="http://127.0.0.1/secret",
            ),
        )

        # Typed as a redirect-shaped policy block (not a bare PermissionError)
        # so callers classify it exactly like the first-hop rejection.
        with pytest.raises(RedirectPolicyBlockedError, match="URL safety policy"):
            read_url_response(ValidatedUrl(url="https://example.com", pinned_ip=""))

    def test_blocked_redirect_target_is_a_redirect_blocked_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The subclassing is load-bearing: existing `except RedirectBlockedError`
        # handlers must keep catching a rejected hop.
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.web_http._open_url_once",
            lambda validated, **_kwargs: _SingleFetchResult(
                payload=b"",
                was_truncated=False,
                content_type="text/html",
                status_code=302,
                location="http://169.254.169.254/latest/meta-data/",
            ),
        )

        with pytest.raises(RedirectBlockedError):
            read_url_response(ValidatedUrl(url="https://example.com", pinned_ip=""))

    def test_blocked_redirect_message_never_echoes_the_target_host(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The Location header is attacker-controlled, so its host must not reach
        # model-visible output the way a user-supplied first-hop host may.
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.web_http._open_url_once",
            lambda validated, **_kwargs: _SingleFetchResult(
                payload=b"",
                was_truncated=False,
                content_type="text/html",
                status_code=302,
                location="http://169.254.169.254/latest/meta-data/",
            ),
        )

        with pytest.raises(RedirectPolicyBlockedError) as excinfo:
            read_url_response(ValidatedUrl(url="https://example.com", pinned_ip=""))
        assert "169.254.169.254" not in str(excinfo.value)

    def test_blocks_redirect_to_unresolvable_target(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.web_http._open_url_once",
            lambda validated, **_kwargs: _SingleFetchResult(
                payload=b"",
                was_truncated=False,
                content_type="text/html",
                status_code=302,
                location="ftp://example.com/file",
            ),
        )

        with pytest.raises(RedirectTargetInvalidError, match="not a valid"):
            read_url_response(ValidatedUrl(url="https://example.com", pinned_ip=""))

    def test_blocks_redirect_loop(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.web_http._open_url_once",
            lambda validated, **_kwargs: _SingleFetchResult(
                payload=b"",
                was_truncated=False,
                content_type="text/html",
                status_code=302,
                location=validated.url,
            ),
        )
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.web_http.validate_public_url",
            lambda raw_url, allow_private=False: ValidatedUrl(url=raw_url, pinned_ip=""),
        )

        with pytest.raises(RedirectBlockedError, match="loop"):
            read_url_response(ValidatedUrl(url="https://example.com", pinned_ip=""))

    def test_blocks_too_many_redirects(self, monkeypatch: pytest.MonkeyPatch) -> None:
        counter = {"count": 0}

        def fake_open_once(
            validated: ValidatedUrl, *, timeout_s: int, max_bytes: int
        ) -> _SingleFetchResult:
            _ = (validated, timeout_s, max_bytes)
            counter["count"] += 1
            return _SingleFetchResult(
                payload=b"",
                was_truncated=False,
                content_type="text/html",
                status_code=302,
                location=f"https://example.com/{counter['count']}",
            )

        monkeypatch.setattr("sidecar.ai.tools.builtins.web_http._open_url_once", fake_open_once)
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.web_http.validate_public_url",
            lambda raw_url, allow_private=False: ValidatedUrl(url=raw_url, pinned_ip=""),
        )

        with pytest.raises(RedirectBlockedError, match="Too many redirects"):
            read_url_response(
                ValidatedUrl(url="https://example.com/start", pinned_ip=""), max_redirects=2
            )


class _FakeResponse:
    def __init__(self, payload: bytes = b"ok") -> None:
        self._payload = payload
        self.headers = {"Content-Type": "text/html"}
        self.status = 200

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def read(self, *_args: int) -> bytes:
        return self._payload


class TestOpenUrlOnceHeaders:
    def test_fetch_request_advertises_browser_user_agent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # fetch_url was advertising the old "Jenny/1.0 (Desktop)" bot UA, which made
        # bot-filtering sites block it outright. It now presents a browser-like client.
        captured: dict[str, object] = {}

        class _FakeOpener:
            def open(self, request: object, timeout: object = None) -> _FakeResponse:
                _ = timeout
                captured["request"] = request
                return _FakeResponse()

        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.web_http._build_opener",
            lambda _pinned_ip: _FakeOpener(),
        )

        _open_url_once(
            ValidatedUrl(url="https://example.com", pinned_ip="93.184.216.34"),
            timeout_s=10,
            max_bytes=1024,
        )

        request = captured["request"]
        user_agent = request.get_header("User-agent") or ""  # type: ignore[attr-defined]
        assert "Chrome" in user_agent
        assert "Jenny" not in user_agent
        assert request.get_header("Accept-language")  # type: ignore[attr-defined]


class TestWebRateLimiter:
    def test_allows_within_limit(self) -> None:
        limiter = WebRateLimiter(requests_per_minute=5)
        for _ in range(5):
            limiter.check()

    def test_rejects_over_limit(self) -> None:
        limiter = WebRateLimiter(requests_per_minute=3)
        for _ in range(3):
            limiter.check()
        with pytest.raises(RuntimeError, match="rate limit"):
            limiter.check()

    @patch("sidecar.ai.tools.builtins.web_http.time.monotonic")
    def test_window_slides(self, mock_monotonic: MagicMock) -> None:
        limiter = WebRateLimiter(requests_per_minute=2)
        mock_monotonic.return_value = 0.0
        limiter.check()
        limiter.check()

        with pytest.raises(RuntimeError):
            limiter.check()

        mock_monotonic.return_value = 61.0
        limiter.check()
