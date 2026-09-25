"""Deadline and shared-transport regressions for built-in web tools."""

from __future__ import annotations

import json
import urllib.error
from email.message import Message
from typing import Any

import pytest

from sidecar.ai.tools.builtins import web_ddg, web_http
from sidecar.ai.tools.builtins.web_ddg import (
    _ddg_http_request,
    _ddg_instant_answer,
)
from sidecar.ai.tools.builtins.web_http import (
    RedirectPolicyBlockedError,
    ValidatedUrl,
    _SingleFetchResult,
    read_url_response,
)


class _Response:
    def __init__(
        self,
        payload: bytes,
        *,
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._payload = payload
        self._offset = 0
        self.status = status
        self.headers = headers or {"Content-Type": "text/html"}
        self.closed = False

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> bool:
        self.close()
        return False

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = len(self._payload) - self._offset
        chunk = self._payload[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def close(self) -> None:
        self.closed = True

    def settimeout(self, _timeout: float) -> None:
        pass


class _Opener:
    def __init__(self, outcome: Any) -> None:
        self._outcome = outcome
        self.calls = 0

    def open(self, *_args: object, **_kwargs: object) -> _Response:
        self.calls += 1
        if isinstance(self._outcome, BaseException):
            raise self._outcome
        return self._outcome


def _patch_current_and_bounded_openers(
    monkeypatch: pytest.MonkeyPatch,
    opener: _Opener,
) -> None:
    monkeypatch.setattr(web_http.urllib.request, "urlopen", opener.open)
    monkeypatch.setattr(web_http, "_build_opener", lambda _pinned_ip: opener)


def _patch_ddg_validation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        web_ddg,
        "validate_public_url",
        lambda raw_url, **_kwargs: ValidatedUrl(url=raw_url, pinned_ip="93.184.216.34"),
        raising=False,
    )


def test_redirect_chain_uses_one_deadline_and_never_opens_third_hop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = [0.0]
    calls: list[str] = []
    timeouts: list[float] = []

    def fake_open_once(validated: ValidatedUrl, **_kwargs: object) -> _SingleFetchResult:
        calls.append(validated.url)
        timeouts.append(float(_kwargs["timeout_s"]))
        now[0] += 0.8
        if len(calls) <= 2:
            return _SingleFetchResult(
                payload=b"",
                was_truncated=False,
                content_type="text/html",
                status_code=302,
                location=f"https://example.com/hop-{len(calls)}",
            )
        return _SingleFetchResult(b"ok", False, "text/plain", 200)

    monkeypatch.setattr(web_http.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(web_http, "_open_url_once", fake_open_once)
    monkeypatch.setattr(
        web_http,
        "validate_public_url",
        lambda raw_url, **_kwargs: ValidatedUrl(url=raw_url, pinned_ip="93.184.216.34"),
    )

    with pytest.raises(TimeoutError, match="timed out"):
        read_url_response(
            ValidatedUrl("https://example.com/start", "93.184.216.34"),
            timeout_s=1,
        )

    assert calls == ["https://example.com/start", "https://example.com/hop-1"]
    assert timeouts == pytest.approx([1.0, 0.2])


def test_trickling_body_expires_and_closes_response(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [0.0]

    class _TricklingResponse(_Response):
        def read(self, _size: int = -1) -> bytes:
            now[0] += 0.5
            return b"x" * 1024

    response = _TricklingResponse(b"")
    opener = _Opener(response)
    monkeypatch.setattr(web_http.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(web_http, "_build_opener", lambda _pinned_ip: opener)

    with pytest.raises(TimeoutError, match="timed out"):
        read_url_response(
            ValidatedUrl("https://example.com/", "93.184.216.34"),
            timeout_s=1,
        )

    assert response.closed is True


def test_ddg_refuses_oversized_response(monkeypatch: pytest.MonkeyPatch) -> None:
    response = _Response(b"x" * 1_048_577)
    opener = _Opener(response)
    _patch_current_and_bounded_openers(monkeypatch, opener)

    with pytest.raises(ValueError, match="too large"):
        _ddg_http_request("https://8.8.8.8/", timeout_s=1)


def test_ddg_refuses_redirect_to_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    headers = Message()
    headers["Location"] = "http://127.0.0.1/"
    redirect = urllib.error.HTTPError(
        "https://8.8.8.8/",
        302,
        "Found",
        headers,
        None,
    )
    opener = _Opener(redirect)
    _patch_current_and_bounded_openers(monkeypatch, opener)

    with pytest.raises(RedirectPolicyBlockedError):
        _ddg_http_request("https://8.8.8.8/", timeout_s=1)


def test_ordinary_ddg_response_still_parses(monkeypatch: pytest.MonkeyPatch) -> None:
    body = json.dumps({"AbstractText": "ordinary", "RelatedTopics": []}).encode()
    opener = _Opener(_Response(body, headers={"Content-Type": "application/json"}))
    _patch_current_and_bounded_openers(monkeypatch, opener)
    _patch_ddg_validation(monkeypatch)

    payload, ok = _ddg_instant_answer("ordinary", timeout_s=1)

    assert ok is True
    assert payload["AbstractText"] == "ordinary"
