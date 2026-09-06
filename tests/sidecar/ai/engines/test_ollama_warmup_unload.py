from __future__ import annotations

import threading
from typing import Any

import pytest

from sidecar.ai.engines.ollama import OllamaEngine


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

    warmup_thread = engine._warmup_model_async("test-model")  # noqa: SLF001
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
