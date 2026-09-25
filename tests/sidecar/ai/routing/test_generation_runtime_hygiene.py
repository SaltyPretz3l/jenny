from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.routing import generation_runtime
from sidecar.ai.tools.models import GenerationResult


def test_generation_runtime_has_no_archived_structured_prompt_engine_branch() -> None:
    assert not hasattr(generation_runtime, "_STRUCTURED_PROMPT_CACHE_ENGINES")
    assert not hasattr(generation_runtime, "_engine_accepts_structured_prompt_cache")


def test_compaction_runs_with_thinking_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Owner decision 2026-09-22 (gate B5): a thinking summarizer can fix on
    # side details, and at low effort it still returned an unclosed <summary>.
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
    assert observed["reasoning_effort"] == "none"


def test_codex_cli_compaction_keeps_the_lowest_effort_its_models_accept(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Codex CLI forwards the effort verbatim, and the OpenAI models it runs
    # (gpt-6-astra, gpt-5.x) list no "none" effort.
    observed: dict[str, Any] = {}
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            engine_type="codex-cli",
            model="codex-cli/default",
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
        kernel, request_id="req-compaction", max_tokens=64, prompt_cache_enabled=False
    )

    assert generate([{"role": "user", "content": "compact"}]) == "summary"
    assert observed["reasoning_effort"] == "low"


def test_compaction_failure_does_not_leave_its_purpose_for_the_next_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Land review 2026-09-20: the purpose tag is consumed by the engine's
    # provider-request hook; a compaction that dies before that hook left
    # ``compaction_summary`` behind, and the turn's real answer was then
    # recorded as internal (zero visible output).
    engine = object()
    kernel = SimpleNamespace(
        _engine=engine,
        _config=SimpleNamespace(
            engine_type="ollama", model="local-model", feature_flags={}, reasoning_effort="high"
        ),
    )
    events: list[str] = []

    def fake_stream(_kernel: object, **_kwargs: Any) -> tuple[GenerationResult, set[str]]:
        raise RuntimeError("engine not ready")

    def fake_execute(*, operation: Any, **_kwargs: Any) -> GenerationResult:
        return operation(SimpleNamespace(max_tokens=64))

    monkeypatch.setattr(generation_runtime, "stream_generate_with_tools", fake_stream)
    monkeypatch.setattr(generation_runtime, "execute_with_provider_retry", fake_execute)
    monkeypatch.setattr(
        generation_runtime,
        "set_next_provider_call_purpose",
        lambda target, purpose: events.append(f"set:{purpose}:{target is engine}"),
    )
    monkeypatch.setattr(
        generation_runtime,
        "consume_provider_call_purpose",
        lambda target: events.append(f"consume:{target is engine}"),
    )

    generate = generation_runtime.build_compaction_generate_fn(
        kernel, request_id="req-compaction", max_tokens=64, prompt_cache_enabled=False
    )
    with pytest.raises(RuntimeError, match="not ready"):
        generate([{"role": "user", "content": "compact"}])

    assert events == ["set:compaction_summary:True", "consume:True"]
