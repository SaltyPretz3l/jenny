from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.protocol import ALLOWED_NOTIFICATION_METHODS
from sidecar.runtime.local_engine.load_failure import (
    build_load_failure_payload,
    classify_load_failure,
)
from sidecar.runtime.local_engine.snapshot import build_local_runtime_payload
from sidecar.runtime.rpc import notification


@pytest.mark.parametrize(("message", "cause"), [
    ("model requires more system memory (7.2 GiB) than is available (5.9 GiB)", "out_of_memory"),
    ("Could not connect to Ollama at 127.0.0.1:11434", "engine_unreachable"),
    ("request timed out", "timeout"),
    ("unexpected EOF", "other"),
    ("CUDA error", "out_of_memory"),
    ("cudaMalloc failed", "out_of_memory"),
    ("VRAM exhausted", "out_of_memory"),
])
def test_classification(message: str, cause: str) -> None:
    assert classify_load_failure(message) == cause


def test_explicit_flags_take_precedence() -> None:
    assert classify_load_failure("memory", timed_out=True, unreachable=True) == "timeout"
    assert classify_load_failure("memory", unreachable=True) == "engine_unreachable"


def test_payload_bounds_and_redacts_paths() -> None:
    payload = build_load_failure_payload(
        cause="other", message="failed /home/private/model.gguf C:\\private\\model.gguf " + "x" * 300,
        context=8192, engine="ollama", model="qwen3:8b",
    )
    assert len(payload["message"]) == 240
    assert "private" not in payload["message"]
    assert payload["context"] == 8192
    assert datetime.fromisoformat(payload["at"]).utcoffset().total_seconds() == 0


def test_snapshot_and_notification_carry_failure() -> None:
    config = SimpleNamespace(engine_type="ollama", model="qwen3:8b")
    engine = SimpleNamespace(model_name="qwen3:8b", _ready=True)
    assert build_local_runtime_payload(runtime_config=config, engine=engine)["load_failure"] is None
    failure = build_load_failure_payload(
        cause="out_of_memory", message="memory exhausted", context=None,
        engine="ollama", model="qwen3:8b",
    )
    engine.last_load_failure = failure
    snapshot = build_local_runtime_payload(runtime_config=config, engine=engine)
    assert snapshot["load_failure"] == failure
    assert snapshot["contract_version"] == "2"
    assert "runtime.load_failure" in ALLOWED_NOTIFICATION_METHODS
    envelope = notification("runtime.load_failure", failure)
    assert envelope["params"]["cause"] == "out_of_memory"
    assert "request_id" not in envelope["params"]


@pytest.mark.parametrize("writer_fails", [False, True])
def test_initialize_dispatch_installs_background_failure_writer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, writer_fails: bool,
) -> None:
    from sidecar.ai import container as container_module
    from sidecar.ai.engines.factory import EngineSelection
    from sidecar.ai.engines.ollama import OllamaEngine
    from sidecar.protocol import API_VERSION
    from sidecar.runtime.request_dispatch import process_message

    engine = OllamaEngine(host="http://localhost:11434", configured_context_length=8192)
    engine.model_name = "qwen3:8b"
    monkeypatch.setattr(container_module, "create_engine", lambda *_args, **_kwargs: EngineSelection(
        engine=engine, engine_type="ollama", model="qwen3:8b",
    ))
    monkeypatch.setattr(
        container_module, "resolve_memory_db_path", lambda _cfg: tmp_path / "memory.db",
    )
    monkeypatch.setattr(
        container_module, "resolve_background_runtime_root", lambda _cfg: tmp_path / "runtime",
    )
    written: list[dict] = []

    def writer(envelope: dict) -> None:
        written.append(envelope)
        if writer_fails:
            raise OSError("writer closed")

    def post(_endpoint: str, data: dict, **_kwargs: object) -> dict:
        if data.get("keep_alive") == 0:
            return {"done": True}
        raise RuntimeError("model requires more system memory")

    monkeypatch.setattr(engine, "_post", post)
    container = container_module.BrainContainer()
    try:
        outcome = process_message(
            {"id": 1, "method": "initialize", "params": {
                "accept_version": API_VERSION,
                "config": {"engine_type": "ollama", "model": "qwen3:8b", "context_length": 8192},
            }}, False, brain_container=container, logger=logging.getLogger(__name__),
            write_message=writer, read_message=lambda: {},
        )
        assert outcome.initialized is True
        thread = engine._warmup_model_async("qwen3:8b")
        thread.join(timeout=2)
        assert not thread.is_alive()
        assert len(written) == 1
        assert written[0]["method"] == "runtime.load_failure"
        assert written[0]["params"]["cause"] == "out_of_memory"
        assert "request_id" not in written[0]["params"]
    finally:
        container.close()


def test_late_listener_receives_an_already_failed_warmup(monkeypatch: pytest.MonkeyPatch) -> None:
    from sidecar.ai.engines.ollama import OllamaEngine

    engine = OllamaEngine(host="http://localhost:11434")

    def fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("memory exhausted")

    monkeypatch.setattr(engine, "_post", fail)
    thread = engine._warmup_model_async("qwen3:8b")
    thread.join(timeout=2)
    assert not thread.is_alive()
    received: list[dict] = []
    engine.set_load_failure_listener(received.append)
    assert received == [engine.last_load_failure]


def test_listener_installs_while_a_warmup_is_in_flight(monkeypatch: pytest.MonkeyPatch) -> None:
    import threading
    import time

    from sidecar.ai.engines.ollama import OllamaEngine

    engine = OllamaEngine(host="http://localhost:11434")
    release = threading.Event()

    def blocked_post(*_args: object, **_kwargs: object) -> dict:
        release.wait(timeout=5)
        return {"done": True}

    monkeypatch.setattr(engine, "_post", blocked_post)
    thread = engine._warmup_model_async("qwen3:8b")
    started = time.monotonic()
    try:
        engine.set_load_failure_listener(lambda _payload: None)
        assert time.monotonic() - started < 0.5, "initialize must not wait for the warmup"
    finally:
        release.set()
        thread.join(timeout=2)
    assert not thread.is_alive()


def test_a_new_load_clears_the_previous_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    from sidecar.ai.engines.ollama import OllamaEngine

    engine = OllamaEngine(host="http://localhost:11434")
    engine.last_load_failure = {"cause": "other"}
    monkeypatch.setattr(engine, "_probe_catalog", lambda _name: ("present", None))
    monkeypatch.setattr(engine, "get_model_info", lambda _name: None)
    monkeypatch.setattr(engine, "_claim_residency", lambda: None)
    monkeypatch.setattr(engine, "_warmup_model_async", lambda _name: None)
    engine.load_model("qwen3:8b")
    assert engine.last_load_failure is None
