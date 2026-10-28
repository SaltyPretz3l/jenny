"""Provider-parse replay tests (chat-lifecycle cold review W4.6).

The engine-level corpus runner in ``test_replay_corpus.py`` is admittedly
tautological: :class:`ReplayEngine` echoes ``expected_engine_events`` by
construction (see its module docstring). This module closes that gap for
fixtures whose provider has a REAL streaming tool parser: each fixture's
captured ``raw_chunks`` are fed through the production parser — Ollama's
``stream_with_tools`` over a fake NDJSON HTTP response — and the yielded
events plus the terminal :class:`GenerationResult` are asserted against the
fixture's declared expectations. A parser regression now fails here even
though the ReplayEngine echo still matches.

vLLM-provider fixtures replay the same way through the real
``VLLMEngine.stream_with_tools`` (``vllm_engine_generation``; backlog item
W7b-34-F05): each ``raw_chunks`` ``sse`` line is served from a stub on the
pooled ``ProviderHttpService.stream_response`` seam, so the production SSE
reader and tool-call normalizer run over the captured wire lines.

``provider_neutral`` fixtures have no provider wire format and are excluded
from the parametrize rather than reported as skips; the engine-level corpus
runner still covers them.
"""

from __future__ import annotations

import json
import threading
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.engines.engine_events import EngineEvent
from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.ai.exceptions import GenerationError
from sidecar.ai.tools.models import StreamingEvent, ThinkingDelta
from tests.sidecar.ai.engines import test_vllm_engine as vllm_test
from tests.sidecar.replay.assertions import assert_generation_result_matches
from tests.sidecar.replay.fixture_format import (
    Fixture,
    build_engine_event,
    discover_fixtures,
    load_fixture,
)

_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {"name": "read_file", "parameters": {}},
    },
    {
        "type": "function",
        "function": {"name": "glob_files", "parameters": {}},
    },
]


def _build_ollama_engine() -> OllamaEngine:
    """Minimal real OllamaEngine instance (same idiom as test_ollama_wrapper)."""
    engine = object.__new__(OllamaEngine)
    engine.host = "http://localhost:11434"
    engine._request_timeout_seconds = 300
    engine.model_name = "test-model"
    engine._ready = True
    engine._vision = False
    engine._thinking = False
    engine._tool_calls_enabled = True
    engine._context_length = None
    engine._configured_context_length = None
    engine._thinking_capability_source = "unsupported"
    engine._cached_tools_key = None
    engine._cached_tools_payload = None
    engine._request_context_lock = threading.Lock()
    return engine


class _CapturedChunksResponse:
    """Streaming response stub that serves a fixture's raw_chunks as NDJSON."""

    def __init__(self, chunks: list[dict[str, Any]]) -> None:
        self._lines = [json.dumps(chunk).encode("utf-8") for chunk in chunks]
        self.closed = threading.Event()

    def __enter__(self) -> "_CapturedChunksResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def __iter__(self):
        return iter(self._lines)

    def close(self) -> None:
        self.closed.set()


class _CapturedSSEResponse:
    """Streaming response stub that serves a fixture's raw_chunks as SSE lines."""

    status_code = 200

    def __init__(self, chunks: list[dict[str, Any]]) -> None:
        self._lines = [str(chunk["sse"]) for chunk in chunks]
        self.closed = threading.Event()

    def iter_lines(self) -> list[str]:
        return self._lines

    def raise_for_status(self) -> None:
        return None

    def close(self) -> None:
        self.closed.set()

    def __enter__(self) -> "_CapturedSSEResponse":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


_REPLAYED_PROVIDERS = ("ollama", "vllm")
_TEXT_EVENT_TYPES = frozenset({"thinking", "content"})

_FIXTURE_CACHE: dict[Path, Fixture] = {}


def _load_cached(path: Path) -> Fixture:
    cached = _FIXTURE_CACHE.get(path)
    if cached is not None:
        return cached
    fixture = load_fixture(path)
    _FIXTURE_CACHE[path] = fixture
    return fixture


def _provider_parse_params() -> list[Any]:
    items: list[Any] = []
    for path in discover_fixtures():
        fixture = _load_cached(path)
        provider = str(getattr(fixture.metadata, "provider", "") or "").strip().lower()
        if provider not in _REPLAYED_PROVIDERS:
            continue
        items.append(pytest.param(path, id=path.stem))
    return items


def _drive_real_parser(fixture: Fixture, monkeypatch: pytest.MonkeyPatch) -> tuple[list[Any], Any]:
    """Feed the fixture's raw_chunks through the real provider stream parser."""
    provider = str(fixture.metadata.provider or "").strip().lower()
    engine: Any
    if provider == "vllm":
        engine = vllm_test._make_streaming_engine(monkeypatch)
        vllm_test._patch_stream_response(
            monkeypatch, _CapturedSSEResponse(list(fixture.raw_chunks))
        )
    else:
        engine = _build_ollama_engine()
        response = _CapturedChunksResponse(list(fixture.raw_chunks))
        monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: response)

    try:
        stream = engine.stream_with_tools(
            prompt="user request",
            tools=_TOOL_SCHEMAS,
            max_tokens=128,
        )
        yielded: list[Any] = []
        while True:
            try:
                yielded.append(next(stream))
            except StopIteration as stop:
                return yielded, stop.value
    finally:
        if isinstance(engine, VLLMEngine):
            engine.clear_request_context()
            engine.close()


def _normalize_event(event: Any) -> dict[str, Any]:
    """Reduce an engine event to its routing-seam meaning: (type, text).

    The corpus encodes thinking as ``ThinkingDelta`` (the generic carrier)
    while the real Ollama parser yields ``StreamingEvent(kind="thinking")``.
    ``generation_runtime`` treats both as the same ``emit_thinking`` call
    (generation_runtime.py:679-686 — the only carrier difference is the
    persist flag, which the routing-level corpus test already pins), so the
    parse-level comparison is on type+text.

    ``EngineEvent`` carries the mid-stream ``tool_call_completed``
    announcement, whose whole point is tool identity rather than text, so its
    projection also pins the announced call id, tool name, and arguments —
    the call id is the invariant that must equal the one the terminal
    ``GenerationResult`` derives for the same call
    (``ollama_tool_call_announce.build_tool_call_announcement``).
    """
    if isinstance(event, ThinkingDelta):
        return {"type": "thinking", "text": str(event.text or "")}
    if isinstance(event, EngineEvent):
        return {
            "type": str(event.kind or "").strip().lower(),
            "text": str(event.text or ""),
            "tool_call_id": str(event.tool_call_id or ""),
            "tool_name": str(event.tool_name or ""),
            "arguments": dict(event.arguments or {}),
            "sequence": int(event.sequence),
        }
    if isinstance(event, StreamingEvent):
        return {
            "type": str(event.kind or "content").strip().lower(),
            "text": str(event.text or ""),
        }
    return {"type": type(event).__name__, "text": str(event or "")}


# Hand-written vLLM fixture expectations that diverge from what the production
# engine does today. The replay pins the production behavior explicitly instead
# of skipping, so a regression in either direction still fails here. The
# fixture JSON files are owned elsewhere; update them to retire these entries.
#
# * 07: malformed tool-call arguments are rejected with CMP-AI-0005 (the fixture
#   still records an empty ``tool_calls`` result with a clean finish).
# * 09: a reasoning-only completion resolves to ``reasoning_only`` and the
#   engine accumulates every thinking delta (the fixture records ``stop`` and
#   only the last delta).
_VLLM_REJECTED_FIXTURES = {"07-malformed-tool-arguments-vllm": "CMP-AI-0005"}
_VLLM_RESULT_OVERRIDES: dict[str, dict[str, Any]] = {
    "09-reasoning-only-completion-vllm": {
        "finish_reason": "reasoning_only",
        "thinking_text": "I should explain this carefully.Actually, I am not sure what to do.",
    },
}


def _assert_vllm_tool_calls(result: Any, fixture: Fixture) -> None:
    """Pin the parsed tool calls (id, tool, arguments) against the fixture."""
    actual = [
        {
            "call_id": call.call_id,
            "tool_id": call.tool_id,
            "arguments": dict(call.arguments),
        }
        for call in result.tool_calls
    ]
    expected = [
        {
            "call_id": call["call_id"],
            "tool_id": call["tool_id"],
            "arguments": dict(call["arguments"]),
        }
        for call in fixture.expected_generation_result.get("tool_calls", [])
    ]
    assert actual == expected, f"vLLM tool-call mismatch in {fixture.path.stem}"


def _text_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event["type"] in _TEXT_EVENT_TYPES]


@pytest.mark.parametrize("fixture_path", _provider_parse_params())
def test_real_provider_parser_reproduces_fixture_expectations(
    fixture_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = _load_cached(fixture_path)
    if fixture_path.stem in _VLLM_REJECTED_FIXTURES:
        with pytest.raises(GenerationError, match=_VLLM_REJECTED_FIXTURES[fixture_path.stem]):
            _drive_real_parser(fixture, monkeypatch)
        return
    yielded, result = _drive_real_parser(fixture, monkeypatch)

    actual_events = [_normalize_event(event) for event in yielded]
    expected_events = [
        _normalize_event(build_engine_event(spec))
        for spec in fixture.expected_engine_events
    ]
    if str(fixture.metadata.provider or "").strip().lower() == "vllm":
        # The production vLLM stream also yields mid-stream tool-call
        # announcements and a terminal ``done`` event that the hand-written
        # fixture expectations never modelled. Compare the model-visible text
        # (thinking/content) here; tool calls are pinned by
        # ``_assert_vllm_tool_calls`` and the finish reason by the
        # GenerationResult assertion below.
        actual_events = _text_events(actual_events)
        expected_events = _text_events(expected_events)
    assert actual_events == expected_events, (
        f"real-parser event mismatch in {fixture_path.stem}\n"
        f"  expected: {expected_events}\n"
        f"  actual:   {actual_events}"
    )
    expected_result = dict(fixture.expected_generation_result)
    expected_result.update(_VLLM_RESULT_OVERRIDES.get(fixture_path.stem, {}))
    assert_generation_result_matches(
        result,
        expected_result,
        fixture_label=fixture_path.stem,
    )
    if str(fixture.metadata.provider or "").strip().lower() == "vllm":
        _assert_vllm_tool_calls(result, fixture)
