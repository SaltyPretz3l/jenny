"""Test-only fixture-driven engine double for the replay corpus.

The :class:`ReplayEngine` mirrors the duck-typed surface of Jenny's local
engine wrappers (``Ollama``, ``vLLM``) sufficient for
``sidecar.ai.routing.generation_runtime.stream_generate_with_tools`` to drive
it: ``stream_with_tools`` yields events from a fixture's
``expected_engine_events`` and returns a :class:`GenerationResult` constructed
from ``expected_generation_result``.

No HTTP, no socket I/O, no live provider calls. Identical idiom to
``_StreamingToolEngine`` in ``tests/sidecar/ai/routing/test_generation_runtime.py``,
extended to be fixture-driven and reusable across the corpus.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Generator

from sidecar.ai.tools.models import GenerationResult, StreamingEvent, ThinkingDelta
from tests.sidecar.replay.fixture_format import (
    Fixture,
    build_engine_event,
    build_generation_result,
)


class ReplayEngine:
    """Yield engine events declared in a fixture, then return its GenerationResult."""

    def __init__(
        self,
        fixture: Fixture,
        *,
        max_output_tokens: int = 4096,
        supports_tool_calling: bool = True,
    ) -> None:
        self._fixture = fixture
        self._max_output_tokens = int(max_output_tokens)
        self._supports_tool_calling = bool(supports_tool_calling)
        self.recorded_calls: list[dict[str, Any]] = []

    @property
    def fixture(self) -> Fixture:
        return self._fixture

    @property
    def supports_tool_calling(self) -> bool:
        return self._supports_tool_calling

    def get_model_max_output_tokens(self) -> int:
        return self._max_output_tokens

    def stream_with_tools(
        self, **kwargs: Any
    ) -> Generator[StreamingEvent | ThinkingDelta, None, GenerationResult]:
        """Yield each event from ``expected_engine_events``, then return ``GenerationResult``.

        Records every kwargs invocation in ``self.recorded_calls`` for assertions.
        """
        self.recorded_calls.append(dict(kwargs))
        for event_spec in self._fixture.expected_engine_events:
            event = build_engine_event(event_spec)
            yield event  # type: ignore[misc]
        return build_generation_result(self._fixture.expected_generation_result)


def make_kernel(engine: ReplayEngine, *, system_prompt_passthrough: bool = True) -> SimpleNamespace:
    """Build a minimal ``kernel`` stand-in suitable for ``stream_generate_with_tools``.

    ``stream_generate_with_tools`` reads:
      - ``kernel._engine.stream_with_tools(...)``
      - ``kernel._engine.get_model_max_output_tokens()``
      - ``kernel._config.temperature``
      - ``kernel._config.reasoning_effort``
      - ``kernel._config.feature_flags``
      - ``kernel._config.engine_type`` (used by ``_engine_accepts_structured_prompt_cache``)
      - ``kernel._system_prompt_for_engine(value)``
    """
    return SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            temperature=0.0,
            reasoning_effort=None,
            feature_flags={},
            engine_type="local-replay",
        ),
        _system_prompt_for_engine=(
            (lambda value: value) if system_prompt_passthrough else (lambda value: str(value))
        ),
    )
