from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.routing import generation_runtime
from sidecar.ai.tools.models import GenerationResult


def test_generation_runtime_has_no_archived_structured_prompt_engine_branch() -> None:
    assert not hasattr(generation_runtime, "_STRUCTURED_PROMPT_CACHE_ENGINES")
    assert not hasattr(generation_runtime, "_engine_accepts_structured_prompt_cache")


def test_compaction_forces_low_reasoning_effort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, Any] = {}
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            engine_type="ollama",
            model="local-model",
            feature_flags={},
            reasoning_effort="high",
        )
    )

    def fake_stream(_kernel: object, **kwargs: Any) -> tuple[GenerationResult, set[str]]:
        observed.update(kwargs)
        return GenerationResult(content="summary", finish_reason="stop"), set()

    def fake_execute(*, operation: Any, **_kwargs: Any) -> GenerationResult:
        return operation(SimpleNamespace(max_tokens=64))

    monkeypatch.setattr(generation_runtime, "stream_generate_with_tools", fake_stream)
    monkeypatch.setattr(generation_runtime, "execute_with_provider_retry", fake_execute)

    generate = generation_runtime.build_compaction_generate_fn(
        kernel,
        request_id="req-compaction",
        max_tokens=64,
        prompt_cache_enabled=False,
    )

    assert generate([{"role": "user", "content": "compact"}]) == "summary"
    assert observed["reasoning_effort"] == "low"
