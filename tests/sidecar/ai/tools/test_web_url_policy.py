"""Redirect-hop request policy, hop limit before DNS, and the loopback/metadata split.

Security review 2026-10-25 hardening items 3, 4 and 10 (roadmap row 103).
"""

from __future__ import annotations

import socket
from typing import Any

import pytest

from sidecar.ai.tools.builtins import web_http
from sidecar.ai.tools.builtins.web_http import (
    RedirectBlockedError,
    RedirectPolicyBlockedError,
    ValidatedUrl,
    _SingleFetchResult,
    read_url_response,
    validate_public_url,
)

_CALLER_HEADERS = {
    "Authorization": "Bearer secret-token",
    "Cookie": "session=abc",
    "Proxy-Authorization": "Basic cHJveHk=",
    "X-Api-Key": "vendor-key",
    "Content-Type": "application/json",
}


def _redirect(status: int, location: str) -> _SingleFetchResult:
    return _SingleFetchResult(
        payload=b"", was_truncated=False, content_type="", status_code=status, location=location
    )


def _ok() -> _SingleFetchResult:
    return _SingleFetchResult(
        payload=b"ok", was_truncated=False, content_type="text/plain", status_code=200
    )


def _drive(
    monkeypatch: pytest.MonkeyPatch,
    hops: list[_SingleFetchResult],
    *,
    url: str = "https://api.example.com/start",
    **kwargs: Any,
) -> list[dict[str, Any]]:
    """Run ``read_url_response`` over scripted hops; return each hop's request."""
    calls: list[dict[str, Any]] = []
    script = iter(hops)

    def fake_open_once(validated: ValidatedUrl, **open_kwargs: Any) -> _SingleFetchResult:
        calls.append(
            {
                "url": validated.url,
                "method": open_kwargs.get("method"),
                "data": open_kwargs.get("data"),
                "headers": dict(open_kwargs.get("headers") or {}),
            }
        )
        return next(script)

    monkeypatch.setattr(web_http, "_open_url_once", fake_open_once)
    monkeypatch.setattr(
        web_http,
        "validate_public_url",
        lambda raw_url, **_kwargs: ValidatedUrl(url=raw_url, pinned_ip=""),
    )
    read_url_response(ValidatedUrl(url=url, pinned_ip=""), **kwargs)
    return calls


class TestCrossOriginHopHeaders:
    def test_cross_origin_hop_drops_every_caller_header(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _drive(
            monkeypatch,
            [_redirect(302, "https://elsewhere.example.net/landing"), _ok()],
            headers=dict(_CALLER_HEADERS),
        )
        assert calls[0]["headers"] == _CALLER_HEADERS
        assert calls[1]["url"] == "https://elsewhere.example.net/landing"
        assert calls[1]["headers"] == {}

    def test_same_origin_hop_keeps_caller_headers(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = _drive(
            monkeypatch,
            [_redirect(302, "/next"), _ok()],
            headers=dict(_CALLER_HEADERS),
        )
        assert calls[1]["url"] == "https://api.example.com/next"
        assert calls[1]["headers"] == _CALLER_HEADERS

    @pytest.mark.parametrize(
        "location",
        [
            "http://api.example.com/start",  # scheme differs
            "https://api.example.com:8443/start",  # port differs
            "https://API.example.org/start",  # host differs
        ],
    )
    def test_scheme_host_or_port_change_is_cross_origin(
        self, monkeypatch: pytest.MonkeyPatch, location: str
    ) -> None:
        calls = _drive(
            monkeypatch,
            [_redirect(302, location), _ok()],
            headers={"Authorization": "Bearer secret-token"},
        )
        assert calls[1]["headers"] == {}

    def test_default_port_spelled_out_is_same_origin(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _drive(
            monkeypatch,
            [_redirect(302, "https://API.example.com:443/next"), _ok()],
            headers={"Authorization": "Bearer secret-token"},
        )
        assert calls[1]["headers"] == {"Authorization": "Bearer secret-token"}

    def test_headers_stay_dropped_after_returning_to_the_first_origin(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _drive(
            monkeypatch,
            [
                _redirect(302, "https://elsewhere.example.net/bounce"),
                _redirect(302, "https://api.example.com/back"),
                _ok(),
            ],
            headers={"Authorization": "Bearer secret-token"},
        )
        assert calls[2]["url"] == "https://api.example.com/back"
        assert calls[2]["headers"] == {}


class TestRedirectMethodRewrite:
    def test_303_turns_post_into_bodyless_get(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = _drive(
            monkeypatch,
            [_redirect(303, "/result"), _ok()],
            method="POST",
            data=b'{"q": 1}',
            headers={"Content-Type": "application/json", "X-Trace": "1"},
        )
        assert calls[0]["method"] == "POST"
        assert calls[1]["method"] == "GET"
        assert calls[1]["data"] is None
        # Same origin: ordinary headers stay, request-body headers go with the body.
        assert calls[1]["headers"] == {"X-Trace": "1"}

    def test_303_turns_put_into_get(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = _drive(
            monkeypatch, [_redirect(303, "/result"), _ok()], method="PUT", data=b"x"
        )
        assert (calls[1]["method"], calls[1]["data"]) == ("GET", None)

    def test_303_keeps_head(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = _drive(monkeypatch, [_redirect(303, "/result"), _ok()], method="HEAD")
        assert calls[1]["method"] == "HEAD"

    @pytest.mark.parametrize("status", [301, 302])
    def test_301_302_turn_post_into_bodyless_get(
        self, monkeypatch: pytest.MonkeyPatch, status: int
    ) -> None:
        calls = _drive(
            monkeypatch,
            [_redirect(status, "https://elsewhere.example.net/form-done"), _ok()],
            method="POST",
            data=b"a=1",
        )
        assert (calls[1]["method"], calls[1]["data"]) == ("GET", None)

    @pytest.mark.parametrize("status", [307, 308])
    def test_307_308_same_origin_keep_method_body_and_headers(
        self, monkeypatch: pytest.MonkeyPatch, status: int
    ) -> None:
        calls = _drive(
            monkeypatch,
            [_redirect(status, "/v2/search"), _ok()],
            method="POST",
            data=b'{"q": 1}',
            headers=dict(_CALLER_HEADERS),
        )
        assert calls[1]["method"] == "POST"
        assert calls[1]["data"] == b'{"q": 1}'
        assert calls[1]["headers"] == _CALLER_HEADERS

    @pytest.mark.parametrize("status", [307, 308])
    def test_307_308_cross_origin_with_body_is_refused_before_the_hop(
        self, monkeypatch: pytest.MonkeyPatch, status: int
    ) -> None:
        with pytest.raises(RedirectBlockedError):
            _drive(
                monkeypatch,
                [_redirect(status, "https://elsewhere.example.net/collect"), _ok()],
                method="POST",
                data=b'{"q": 1}',
            )

    def test_307_cross_origin_unsafe_method_without_body_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with pytest.raises(RedirectBlockedError):
            _drive(
                monkeypatch,
                [_redirect(307, "https://elsewhere.example.net/thing"), _ok()],
                method="DELETE",
            )

    def test_307_cross_origin_get_follows_without_caller_headers(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _drive(
            monkeypatch,
            [_redirect(307, "https://elsewhere.example.net/page"), _ok()],
            headers={"Authorization": "Bearer secret-token"},
        )
        assert calls[1]["method"] == "GET"
        assert calls[1]["headers"] == {}


class TestHopLimitBeforeDns:
    @staticmethod
    def _forbid_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
        def fail(*_args: object, **_kwargs: object) -> object:
            pytest.fail("the hop limit must be enforced before the Location host is resolved")

        monkeypatch.setattr(web_http, "validate_public_url", fail)
        monkeypatch.setattr(web_http, "_getaddrinfo", fail)
        monkeypatch.setattr(web_http.socket, "getaddrinfo", fail)

    def test_zero_redirects_never_resolves_the_location_host(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            web_http,
            "_open_url_once",
            lambda _validated, **_kwargs: _redirect(302, "https://hostile-vendor.example/ping"),
        )
        self._forbid_resolution(monkeypatch)
        with pytest.raises(RedirectBlockedError, match="Too many redirects"):
            read_url_response(
                ValidatedUrl(url="https://api.example.com/", pinned_ip="93.184.216.34"),
                max_redirects=0,
            )

    def test_hop_past_the_limit_is_not_validated(self, monkeypatch: pytest.MonkeyPatch) -> None:
        validated: list[str] = []
        counter = iter(range(1, 10))
        monkeypatch.setattr(
            web_http,
            "_open_url_once",
            lambda _validated, **_kwargs: _redirect(302, f"https://hop{next(counter)}.example/"),
        )

        def record(raw_url: str, **_kwargs: object) -> ValidatedUrl:
            validated.append(raw_url)
            return ValidatedUrl(url=raw_url, pinned_ip="")

        monkeypatch.setattr(web_http, "validate_public_url", record)
        with pytest.raises(RedirectBlockedError, match="Too many redirects"):
            read_url_response(
                ValidatedUrl(url="https://api.example.com/", pinned_ip=""), max_redirects=1
            )
        assert validated == ["https://hop1.example/"]


def _resolve_to(monkeypatch: pytest.MonkeyPatch, *addresses: str) -> None:
    infos = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (addr, 443)) for addr in addresses]
    monkeypatch.setattr(web_http.socket, "getaddrinfo", lambda *_a, **_k: infos)


def _forbid_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        web_http.socket,
        "getaddrinfo",
        lambda *_a, **_k: pytest.fail("no DNS lookup expected"),
    )


class TestLoopbackOnlyFlag:
    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:8888/search",
            "http://localhost.localdomain/search",
            "http://127.0.0.1:8888/search",
            "http://127.9.9.9/search",
            "http://[::1]:8888/search",
        ],
    )
    def test_loopback_targets_pass(self, monkeypatch: pytest.MonkeyPatch, url: str) -> None:
        _forbid_dns(monkeypatch)
        assert validate_public_url(url, allow_loopback=True).url == url

    @pytest.mark.parametrize(
        "url",
        [
            "http://192.168.1.10/",
            "http://10.0.0.1/",
            "http://172.16.0.1/",
            "http://100.64.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[fe80::1]/",
            "http://[fd00::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://nas.local/",
        ],
    )
    def test_loopback_flag_does_not_open_private_ranges(self, url: str) -> None:
        with pytest.raises(PermissionError):
            validate_public_url(url, allow_loopback=True)

    def test_hostname_resolving_to_loopback_is_pinned(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _resolve_to(monkeypatch, "127.0.0.1")
        result = validate_public_url("http://searx.example.test/", allow_loopback=True)
        assert result.pinned_ip == "127.0.0.1"

    def test_hostname_resolving_to_lan_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _resolve_to(monkeypatch, "127.0.0.1", "192.168.1.5")
        with pytest.raises(PermissionError):
            validate_public_url("http://searx.example.test/", allow_loopback=True)

    def test_loopback_stays_blocked_without_either_flag(self) -> None:
        with pytest.raises(PermissionError):
            validate_public_url("http://127.0.0.1:8888/")
        with pytest.raises(PermissionError):
            validate_public_url("http://localhost:8888/")

    def test_redirect_hops_honour_the_loopback_flag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        hops = iter([_redirect(302, "http://127.0.0.1:8888/search?q=x"), _ok()])
        monkeypatch.setattr(web_http, "_open_url_once", lambda _v, **_k: next(hops))
        result = read_url_response(
            ValidatedUrl(url="http://localhost:8888/search?q=x", pinned_ip=""),
            allow_loopback=True,
        )
        assert result.final_url == "http://127.0.0.1:8888/search?q=x"

        monkeypatch.setattr(
            web_http,
            "_open_url_once",
            lambda _v, **_k: _redirect(302, "http://192.168.1.1/admin"),
        )
        with pytest.raises(RedirectPolicyBlockedError):
            read_url_response(
                ValidatedUrl(url="http://localhost:8888/search", pinned_ip=""),
                allow_loopback=True,
            )


class TestPrivateFlagCompatAndMetadata:
    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:8888/",
            "http://127.0.0.1/",
            "http://192.168.1.10/",
            "http://100.64.0.1/",
            "http://[fe80::1]/",
            "http://[fd00::1]/",
        ],
    )
    def test_private_flag_still_opens_loopback_and_private_literals(self, url: str) -> None:
        assert validate_public_url(url, allow_private=True).url == url

    def test_private_flag_pins_the_screened_address(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A rebinding name must not resolve again at connect time (to cloud metadata).
        _resolve_to(monkeypatch, "192.168.1.5")
        assert validate_public_url("http://nas.local/", allow_private=True).pinned_ip == "192.168.1.5"

    @pytest.mark.parametrize(
        "url",
        [
            "http://169.254.169.254/latest/meta-data/",
            "http://169.254.170.2/v2/credentials",
            "http://100.100.100.200/latest/meta-data/",
            "http://[fd00:ec2::254]/latest/meta-data/",
            "http://[::ffff:169.254.169.254]/",
            "http://[64:ff9b::a9fe:a9fe]/",
            "http://[2002:a9fe:a9fe::1]/",
        ],
    )
    @pytest.mark.parametrize("flags", [{"allow_private": True}, {"allow_loopback": True}, {}])
    def test_cloud_metadata_is_never_opened(self, url: str, flags: dict[str, bool]) -> None:
        with pytest.raises(PermissionError):
            validate_public_url(url, **flags)

    def test_hostname_resolving_to_metadata_is_refused_under_private_flag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _resolve_to(monkeypatch, "169.254.169.254")
        with pytest.raises(PermissionError):
            validate_public_url("http://metadata.google.internal/", allow_private=True)
