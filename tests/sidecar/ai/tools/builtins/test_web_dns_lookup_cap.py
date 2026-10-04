"""Abandoned DNS lookups are bounded.

``socket.getaddrinfo`` cannot be cancelled, so a lookup that outlives the
request deadline keeps its thread. Without a cap a hung resolver let every web
request leave one more thread behind.
"""

from __future__ import annotations

import socket
import threading
import time
from typing import Any

import pytest

from sidecar.ai.tools.builtins import web_http


def _lookup_threads() -> list[threading.Thread]:
    return [
        t
        for t in threading.enumerate()
        if t.name == web_http._DNS_LOOKUP_THREAD_NAME and t.is_alive()
    ]


def test_abandoned_lookups_are_capped_and_slots_come_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    started: list[str] = []

    def _hung_getaddrinfo(host: str, port: int, **_kwargs: Any) -> list[Any]:
        started.append(host)
        release.wait(timeout=10)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]

    monkeypatch.setattr(web_http.socket, "getaddrinfo", _hung_getaddrinfo)
    monkeypatch.setattr(web_http, "_DNS_LOOKUP_SLOTS", threading.BoundedSemaphore(2))
    try:
        for index in range(5):
            with pytest.raises(TimeoutError):
                web_http._getaddrinfo(
                    f"host{index}.example", 443, deadline=time.monotonic() + 0.1
                )
        # Only two resolver threads were ever started; the other three
        # requests timed out waiting for a slot instead of spawning more.
        assert len(started) == 2
    finally:
        release.set()

    deadline = time.monotonic() + 5
    while started and len(_lookup_threads()) and time.monotonic() < deadline:
        time.sleep(0.02)
    result = web_http._getaddrinfo(
        "after.example", 443, deadline=time.monotonic() + 2
    )
    assert result[0][4][0] == "93.184.216.34"
    assert len(started) == 3



def test_initial_lookup_without_explicit_deadline_uses_bounded_worker(monkeypatch):
    def resolve(_host, port, **_kwargs):
        assert threading.current_thread().name == web_http._DNS_LOOKUP_THREAD_NAME
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]
    monkeypatch.setattr(web_http.socket, "getaddrinfo", resolve)
    result = web_http._getaddrinfo("example.com", 443, deadline=None)
    assert result[0][4][0] == "93.184.216.34"
