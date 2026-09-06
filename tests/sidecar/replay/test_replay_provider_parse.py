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

vLLM-provider fixtures are skipped explicitly rather than silently: the
production vLLM engine inherits the blocking base-class ``stream_with_tools``
default (W4.9) — there is no real vLLM tool-stream parser to replay, so those
fixtures' ``raw_chunks`` stay aspirational until W4.9 lands.
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
from sidecar.ai.tools.models import StreamingEvent, ThinkingDelta
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
    engine._request_timeout_seconds = 300  # noqa: SLF001
    engine.model_name = "test-model"
    engine._ready = True  # noqa: SLF001
    engine._vision = False  # noqa: SLF001
    engine._thinking = False  # noqa: SLF001
    engine._tool_calls_enabled = True  # noqa: SLF001
    engine._context_length = None  # noqa: SLF001
    engine._configured_context_length = None  # noqa: SLF001
    engine._thinking_capability_source = "unsupported"  # noqa: SLF001
    engine._cached_tools_key = None  # noqa: SLF001
    engine._cached_tools_payload = None  # noqa: SLF001
    engine._request_context_lock = threading.Lock()  # noqa: SLF001
    return engine


class _CapturedChunksResponse:
    """Streaming response stub that serves a fixture's raw_chunks as NDJSON."""

    def __init__(self, chunks: list[dict[str, Any]]) -> None:
        self._lines = [json.dumps(chunk).encode("utf-8") for chunk in chunks]
        self.closed = threading.Event()

    def __enter__(self) -> "_CapturedChunksResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        self.close()

    def __iter__(self):
        return iter(self._lines)

    def close(self) -> None:
        self.closed.set()


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
        marks: list[Any] = []
        if provider != "ollama":
            marks.append(
                pytest.mark.skip(
                    reason=(
                        f"provider '{provider}': no production tool-stream parser to "
                        "replay — vLLM/OpenAI-compatible engines inherit the blocking "
                        "base-class stream_with_tools default (W4.9)"
                    )
                )
            )
        items.append(pytest.param(path, id=path.stem, marks=marks))
    return items


def _drive_real_parser(fixture: Fixture, monkeypatch: pytest.MonkeyPatch) -> tuple[list[Any], Any]:
    """Feed the fixture's raw_chunks through the real Ollama stream parser."""
    engine = _build_ollama_engine()
    response = _CapturedChunksResponse(list(fixture.raw_chunks))
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: response)

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


@pytest.mark.parametrize("fixture_path", _provider_parse_params())
def test_real_provider_parser_reproduces_fixture_expectations(
    fixture_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = _load_cached(fixture_path)
    yielded, result = _drive_real_parser(fixture, monkeypatch)

    actual_events = [_normalize_event(event) for event in yielded]
    expected_events = [
        _normalize_event(build_engine_event(spec))
        for spec in fixture.expected_engine_events
    ]
    assert actual_events == expected_events, (
        f"real-parser event mismatch in {fixture_path.stem}\n"
        f"  expected: {expected_events}\n"
        f"  actual:   {actual_events}"
    )
    assert_generation_result_matches(
        result,
        fixture.expected_generation_result,
        fixture_label=fixture_path.stem,
    )
