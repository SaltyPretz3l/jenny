"""Regression coverage for byte-faithful Ollama thinking streams."""

from __future__ import annotations

import json
from pathlib import Path

from sidecar.ai.engines.ollama_runtime import _thinking_delta, stream
from tests.sidecar.ai.engines.test_ollama_runtime_reasoning import FakeEngine, _patch_urlopen

FIXTURE = Path(__file__).parent / "fixtures" / "ollama_qwen38_thinking_stream.ndjson"


def test_real_ollama_thinking_stream_is_byte_faithful(monkeypatch):
    with FIXTURE.open("rb") as fixture:
        lines = list(fixture)
    _patch_urlopen(monkeypatch, lines)

    events = list(stream(FakeEngine(think_value=True), prompt="hi"))
    joined = "".join(event.text for event in events if event.kind == "thinking")
    expected = "".join(json.loads(line)["message"].get("thinking", "") for line in lines)

    assert joined.encode("utf-8") == expected.encode("utf-8")
    assert "100%" in joined
    assert "800" in joined
    assert "\n" in joined


def test_repeated_per_token_digits_are_preserved():
    accumulated = ""
    emitted: list[str] = []

    for chunk in ["1", "0", "0"]:
        delta, accumulated = _thinking_delta(accumulated, chunk)
        emitted.append(delta)

    assert "".join(emitted) == "100"
