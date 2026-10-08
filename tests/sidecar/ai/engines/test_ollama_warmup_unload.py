from __future__ import annotations

import http.client
import threading
import time
from typing import Any
from urllib.error import HTTPError

import pytest

from sidecar.ai.engines import ollama as ollama_module
from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.exceptions import GenerationError


def test_failed_warmup_notifies_once_and_success_clears_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = OllamaEngine(host="http://localhost:11434", configured_context_length=8192)
    failures: list[dict[str, Any]] = []
    engine.set_load_failure_listener(failures.append)

    def fail(*_args: Any, **_kwargs: Any) -> Any:
        raise HTTPError(engine.host, 500, "model requires more system memory", None, None)

    monkeypatch.setattr(engine, "_post", fail)
    thread = engine._warmup_model_async("qwen3:8b")
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert len(failures) == 1
    assert failures[0]["cause"] == "out_of_memory"
    assert failures[0]["context"] == 8192
    assert engine.last_load_failure == failures[0]
    monkeypatch.setattr(engine, "_post", lambda *_args, **_kwargs: {"done": True})
    thread = engine._warmup_model_async("qwen3:8b")
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert engine.last_load_failure is None
    assert len(failures) == 1


def test_swap_aborted_warmup_does_not_notify(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = OllamaEngine(host="http://localhost:11434")
    failures: list[dict[str, Any]] = []
    engine.set_load_failure_listener(failures.append)

    def abort(*_args: Any, **_kwargs: Any) -> Any:
        engine._cancel_pending_warmup()
        raise ConnectionAbortedError("swap aborted")

    monkeypatch.setattr(engine, "_post", abort)
    thread = engine._warmup_model_async("qwen3:8b")
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert failures == []
    assert getattr(engine, "last_load_failure", None) is None


def test_unload_is_final_request_when_warmup_is_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = OllamaEngine(host="http://localhost:11434")
    engine.model_name = "test-model"
    warmup_entered = threading.Event()
    release_warmup = threading.Event()
    unload_finished = threading.Event()
    requests: list[str] = []

    def fake_post(
        _endpoint: str,
        data: dict[str, Any],
        timeout: float | None = None,
    ) -> dict[str, object]:
        del timeout
        if data.get("keep_alive") == 0:
            requests.append("unload")
            return {"done": True}
        warmup_entered.set()
        assert release_warmup.wait(timeout=2)
        requests.append("warmup")
        return {"done": True}

    monkeypatch.setattr(engine, "_post", fake_post)

    warmup_thread = engine._warmup_model_async("test-model")
    assert warmup_entered.wait(timeout=2)

    def unload() -> None:
        engine.unload_model()
        unload_finished.set()

    unload_thread = threading.Thread(target=unload)
    unload_thread.start()
    # The contract is that unload BLOCKS until warmup releases. The return value
    # of this wait used to be discarded, so an unload that sailed straight past
    # the coordination lock still produced the same request order below.
    assert not unload_finished.wait(timeout=0.5), (
        "unload_model completed while warmup still held the coordination lock"
    )
    release_warmup.set()
    warmup_thread.join(timeout=2)
    unload_thread.join(timeout=2)

    assert not warmup_thread.is_alive()
    assert not unload_thread.is_alive()
    assert requests == ["warmup", "unload"]


@pytest.mark.parametrize("retire", ["close", "unload"])
def test_engine_swap_cancels_a_warmup_that_has_not_posted_yet(
    monkeypatch: pytest.MonkeyPatch,
    retire: str,
) -> None:
    engine = OllamaEngine(host="http://localhost:11434")
    engine.model_name = "test-model"
    posts: list[dict[str, Any]] = []

    def fake_post(
        _endpoint: str,
        data: dict[str, Any],
        timeout: float | None = None,
    ) -> dict[str, object]:
        del timeout
        posts.append(dict(data))
        return {"done": True}

    monkeypatch.setattr(engine, "_post", fake_post)

    class _ParkedThread(threading.Thread):
        """Scheduled but not running until the test releases it."""

        def start(self) -> None:
            parked.append(self)

    parked: list[threading.Thread] = []
    with monkeypatch.context() as scoped:
        scoped.setattr(threading, "Thread", _ParkedThread)
        warmup_thread = engine._warmup_model_async("test-model")
    assert parked == [warmup_thread]

    if retire == "close":
        engine.close()
    else:
        # A sibling engine still holds the shared runner, so this unload does
        # not evict; the pending warmup must still be cancelled.
        monkeypatch.setattr(engine, "_release_residency_claim", lambda: False)
        engine.unload_model()
    threading.Thread.start(warmup_thread)
    warmup_thread.join(timeout=2)

    assert not warmup_thread.is_alive()
    assert [p for p in posts if p.get("keep_alive") != 0] == []


class _BlockingConnection:
    """http.client connection fake whose getresponse() blocks until close()."""

    created: list["_BlockingConnection"] = []
    events: list[str] = []
    entered = threading.Event()
    # urllib's handler (the pre-abort request path) borrows this off the class.
    _get_content_length = staticmethod(http.client.HTTPConnection._get_content_length)

    def __init__(self, _host: str, _port: int | None = None, **_kwargs: Any) -> None:
        self.sock = None
        self.closed = threading.Event()
        type(self).created.append(self)

    def set_debuglevel(self, _level: int) -> None:
        pass

    def connect(self) -> None:
        pass

    def request(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    def getresponse(self) -> Any:
        type(self).entered.set()
        if not self.closed.wait(timeout=5.0):
            raise TimeoutError("blocked connection was never closed")
        raise ConnectionAbortedError("connection closed under the request")

    def close(self) -> None:
        if not self.closed.is_set():
            type(self).events.append("warmup-closed")
        self.closed.set()


@pytest.fixture
def blocked_warmup_engine(monkeypatch: pytest.MonkeyPatch) -> Any:
    """A real engine whose warmup request blocks in a connection fake."""
    _BlockingConnection.created = []
    _BlockingConnection.events = []
    _BlockingConnection.entered = threading.Event()
    monkeypatch.setattr(http.client, "HTTPConnection", _BlockingConnection)
    engine = OllamaEngine(host="http://localhost:11434")
    engine.model_name = "test-model"
    real_post = OllamaEngine._post

    def post(endpoint: str, data: dict[str, Any], timeout: float | None = None) -> Any:
        if data.get("keep_alive") == 0:
            _BlockingConnection.events.append("unload")
            return {"done": True}
        return real_post(engine, endpoint, data, timeout)

    monkeypatch.setattr(engine, "_post", post)
    warmup_thread = engine._warmup_model_async("test-model")
    try:
        assert _BlockingConnection.entered.wait(timeout=2)
        yield engine, warmup_thread
    finally:
        for connection in _BlockingConnection.created:
            connection.closed.set()
        warmup_thread.join(timeout=2)


@pytest.mark.parametrize("target", [None, "test-model"])
def test_unload_aborts_the_inflight_warmup_before_evicting(
    blocked_warmup_engine: Any,
    target: str | None,
) -> None:
    engine, warmup_thread = blocked_warmup_engine
    done = threading.Event()
    errors: list[BaseException] = []

    def unload() -> None:
        try:
            engine.unload_model(target)
        except BaseException as error:  # noqa: BLE001
            errors.append(error)
        finally:
            done.set()

    unload_thread = threading.Thread(target=unload)
    unload_thread.start()
    try:
        finished = done.wait(timeout=2.0)
        state = {
            "unload_finished": finished,
            "warmup_alive": warmup_thread.is_alive(),
            "events": list(_BlockingConnection.events),
        }
        assert finished, f"unload stayed blocked behind the warmup request: {state}"
    finally:
        for connection in _BlockingConnection.created:
            connection.closed.set()
        unload_thread.join(timeout=2.0)
        warmup_thread.join(timeout=2.0)

    assert errors == []
    assert not warmup_thread.is_alive()
    # The eviction request is only sent after the warmup request was aborted.
    assert _BlockingConnection.events == ["warmup-closed", "unload"]


def test_close_aborts_the_inflight_warmup_request(blocked_warmup_engine: Any) -> None:
    engine, warmup_thread = blocked_warmup_engine

    engine.close()
    warmup_thread.join(timeout=2.0)

    assert not warmup_thread.is_alive()
    assert _BlockingConnection.events == ["warmup-closed"]


def test_unload_of_a_foreign_model_does_not_abort_the_warmup(
    blocked_warmup_engine: Any,
) -> None:
    engine, warmup_thread = blocked_warmup_engine
    done = threading.Event()

    def unload() -> None:
        engine.unload_model("some-other-model")
        done.set()

    unload_thread = threading.Thread(target=unload)
    unload_thread.start()
    try:
        # The warmup is not this unload's to cancel: it keeps its request open.
        assert not done.wait(timeout=0.2)
        assert warmup_thread.is_alive()
        assert _BlockingConnection.events == []
    finally:
        for connection in _BlockingConnection.created:
            connection.closed.set()
        unload_thread.join(timeout=2.0)
        warmup_thread.join(timeout=2.0)
    assert not unload_thread.is_alive()


def test_unload_gives_up_when_the_warmup_never_releases_the_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = OllamaEngine(host="http://localhost:11434")
    engine.model_name = "test-model"
    warmup_entered = threading.Event()
    release_warmup = threading.Event()
    posts: list[dict[str, Any]] = []
    resets: list[bool] = []

    def fake_post(
        _endpoint: str,
        data: dict[str, Any],
        timeout: float | None = None,
    ) -> dict[str, object]:
        del timeout
        posts.append(dict(data))
        warmup_entered.set()
        # Ignores the abort: stays blocked until the test releases it.
        assert release_warmup.wait(timeout=5)
        return {"done": True}

    monkeypatch.setattr(engine, "_post", fake_post)
    monkeypatch.setattr(ollama_module, "_UNLOAD_TIMEOUT", 0.2)
    monkeypatch.setattr(engine, "_reset_loaded_state", lambda: resets.append(True))

    warmup_thread = engine._warmup_model_async("test-model")
    try:
        assert warmup_entered.wait(timeout=2)
        started = time.monotonic()
        with pytest.raises(GenerationError, match="warmup"):
            engine.unload_model()
        elapsed = time.monotonic() - started
    finally:
        release_warmup.set()
        warmup_thread.join(timeout=2)

    assert elapsed < 2.0
    assert not warmup_thread.is_alive()
    # No eviction request was sent and the engine did not claim to be unloaded.
    assert [post for post in posts if post.get("keep_alive") == 0] == []
    assert resets == []


def test_the_lock_wait_and_the_eviction_request_share_one_unload_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = OllamaEngine(host="http://localhost:11434")
    engine.model_name = "test-model"
    warmup_entered = threading.Event()
    eviction_timeouts: list[float | None] = []

    def fake_post(
        _endpoint: str,
        data: dict[str, Any],
        timeout: float | None = None,
    ) -> dict[str, object]:
        if data.get("keep_alive") == 0:
            eviction_timeouts.append(timeout)
            return {"done": True}
        warmup_entered.set()
        time.sleep(0.4)  # a warmup that is slow to let go of the engine
        return {"done": True}

    monkeypatch.setattr(engine, "_post", fake_post)
    monkeypatch.setattr(ollama_module, "_UNLOAD_TIMEOUT", 10.0)

    warmup_thread = engine._warmup_model_async("test-model")
    assert warmup_entered.wait(timeout=2)
    engine.unload_model()
    warmup_thread.join(timeout=2)

    # The time spent waiting for the warmup came out of the eviction's timeout.
    assert len(eviction_timeouts) == 1
    assert eviction_timeouts[0] is not None
    assert 1.0 <= eviction_timeouts[0] <= 9.75


def test_an_abort_before_the_socket_exists_stops_the_request_from_being_sent() -> None:
    import urllib.request

    sent: list[str] = []
    abortable = ollama_module._AbortableRequest()

    class _AbortedWhileConnecting:
        def __init__(self, _host: str, _port: int | None = None, **_kwargs: Any) -> None:
            self.sock = None

        def connect(self) -> None:
            # The canceller runs while the socket does not exist yet.
            abortable.abort()

        def request(self, *_args: Any, **_kwargs: Any) -> None:
            sent.append("request")

        def close(self) -> None:
            pass

    original = http.client.HTTPConnection
    http.client.HTTPConnection = _AbortedWhileConnecting  # type: ignore[misc,assignment]
    try:
        req = urllib.request.Request(
            "http://localhost:11434/api/generate", data=b"{}", method="POST"
        )
        with pytest.raises(ConnectionAbortedError):
            ollama_module._post_abortable(abortable, req.full_url, req, 1.0)
    finally:
        http.client.HTTPConnection = original  # type: ignore[misc]

    assert sent == []
