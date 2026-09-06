"""Minimal VCR-style fixture-replay engine for deterministic LLM tests.

This is a **test-only** helper — it lives in ``tests/``, not in sidecar
source.  Tests pass a ``VCREngine`` instance directly as the engine
parameter, matching the existing ``_StubEngine`` pattern.

Usage::

    engine = VCREngine(Path("tests/fixtures/vcr/example.json"))
    result = engine.generate_with_tools(messages=[...])
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional, Set

from sidecar.ai.engines.base import BaseEngine, ModelModality
from sidecar.ai.tools.models import GenerationResult, GenerationUsage


class VCREngine(BaseEngine):
    """Replay canned responses from a JSON fixture file.

    The fixture format is a JSON object mapping content hashes to
    response payloads::

        {
            "<hash>": {
                "content": "response text",
                "finish_reason": "stop",
                "thinking_text": ""
            },
            "_fallback": {
                "content": "default response",
                "finish_reason": "stop"
            }
        }

    When no hash match is found, the ``_fallback`` key is used.  If
    neither exists, the engine returns an empty ``GenerationResult``.

    Pass ``strict=True`` to turn an unmatched lookup into a raised
    :class:`KeyError` instead of a silent ``_fallback`` — this surfaces a stale
    cassette whose recorded prompts no longer match the test. :meth:`unused_keys`
    reports recorded entries that were never matched during the run (also stale).
    """

    def __init__(self, fixture_path: Path | None = None, *, strict: bool = False) -> None:
        self._fixtures: dict[str, dict[str, Any]] = {}
        self._strict = strict
        self._accessed_keys: Set[str] = set()
        if fixture_path is not None and fixture_path.exists():
            self._fixtures = json.loads(
                fixture_path.read_text(encoding="utf-8"),
            )

    @property
    def supported_modalities(self) -> Set[ModelModality]:
        return {ModelModality.TEXT}

    @property
    def supports_tool_calling(self) -> bool:
        return False

    def load_model(self, model_path: str) -> None:
        pass

    def generate(
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: Optional[str] = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: Any = None,
        response_format: Any = None,
    ) -> str:
        _ = (
            max_tokens,
            prompt,
            prompt_cache_enabled,
            reasoning_effort,
            response_format,
            system,
            temperature,
        )
        result = self._lookup(messages)
        return result.get("content", "")

    def stream(self, *args: Any, **kwargs: Any) -> Any:  # type: ignore[override]
        raise NotImplementedError("VCREngine does not support streaming")

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        messages = kwargs.get("messages", [])
        fixture = self._lookup(messages)
        return GenerationResult(
            content=fixture.get("content", ""),
            finish_reason=fixture.get("finish_reason", "stop"),
            thinking_text=fixture.get("thinking_text", ""),
            usage=GenerationUsage(
                input_tokens=fixture.get("input_tokens", 100),
                output_tokens=fixture.get("output_tokens", 50),
                total_tokens=fixture.get("total_tokens", 150),
            ),
        )

    def get_model_context_length(self) -> int:
        return 200_000

    def get_model_max_output_tokens(self) -> int:
        return 16_384

    def unload_model(self) -> None:
        pass

    def unused_keys(self) -> Set[str]:
        """Recorded fixture keys (excluding ``_fallback``) never matched.

        A non-empty result flags stale cassette entries whose prompts no longer
        appear in the test — without this they rot silently behind the hash
        lookup. Call after exercising the engine to assert the cassette is tight.
        """
        return {key for key in self._fixtures if key != "_fallback"} - self._accessed_keys

    # -- internals -----------------------------------------------------------

    def _lookup(self, messages: Any) -> dict[str, Any]:
        if isinstance(messages, list) and messages:
            key = self._hash_messages(messages)
            if key in self._fixtures:
                self._accessed_keys.add(key)
                return self._fixtures[key]
        if self._strict:
            raise KeyError(
                "VCREngine(strict): no recorded response matched these messages; "
                "the cassette is stale -- re-record or update the fixture.",
            )
        fallback = self._fixtures.get("_fallback")
        if fallback is not None:
            return fallback
        return {}

    @staticmethod
    def _hash_messages(messages: list[dict[str, str]]) -> str:
        content = json.dumps(messages, sort_keys=True, default=str)
        return hashlib.sha256(content.encode()).hexdigest()[:16]
