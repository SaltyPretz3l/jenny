"""Regression coverage for byte-faithful Ollama thinking streams."""

from __future__ import annotations

import json
from pathlib import Path

from sidecar.ai.engines.ollama_runtime import stream
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


def test_repeated_and_prefix_per_token_chunks_are_preserved(monkeypatch):
    chunks = ["1", "0", "0", " is", " island"]
    lines = [json.dumps({"message": {"thinking": chunk}}).encode() + b"\n" for chunk in chunks]
    lines.append(json.dumps({"message": {"content": "answer"}, "done": True}).encode() + b"\n")
    _patch_urlopen(monkeypatch, lines)

    events = list(stream(FakeEngine(think_value=True), prompt="hi"))
    emitted = [event.text for event in events if event.kind == "thinking"]

    assert emitted == chunks
    assert "".join(emitted) == "100 is island"
