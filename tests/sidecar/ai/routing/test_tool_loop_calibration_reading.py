"""The terminal usage block carries the last request's provider-vs-estimate reading.

Row 66 W2: the router keeps no state between requests, so the calibration the
next turn's count ladder needs rides out on ``chat.done`` and back in on the
next request. The reading is taken where the provider's count is noted: it pairs
the provider's whole-prompt count with the INNER (unscaled) estimate of exactly
the messages and tool schemas of the request that produced it.
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.context_count import ScaledTokenizerBackend
from sidecar.ai.context.token_budget import (
    CharEstimationBackend,
    estimate_messages_tokens,
    estimate_tool_schema_tokens,
)
from sidecar.ai.routing import tool_loop_compaction
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.routing.tool_loop_compaction import note_request_measurement
from sidecar.ai.tools.models import GenerationResult, GenerationUsage
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_helpers import attach_context_calibration
from sidecar.runtime.chat_models import ChatRequestContext

_TOOLS = [
    {
        "name": "read_file",
        "description": "Read a file from the workspace.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
    }
]
_MESSAGES = [
    {"role": "system", "content": "You are Jenny. " * 40},
    {"role": "user", "content": "Summarise the repository layout please. " * 20},
]


def _loop(
    *,
    full_prompt: bool = True,
    backend: Any = CharEstimationBackend(),  # noqa: B008 - stateless estimator.
    request_context: Any = None,
    messages: list[dict[str, Any]] | None = None,
    preview_images: dict[str, Any] | None = None,
) -> Any:
    return SimpleNamespace(
        kernel=SimpleNamespace(
            _engine=SimpleNamespace(
                reports_full_prompt_input_tokens=full_prompt, model_name="qwen3.8"
            ),
            _config=SimpleNamespace(engine_type="ninfer", model="qwen3.8", feature_flags={}),
        ),
        budget_tracker=SimpleNamespace(backend=backend, calibration_reading=None),
        working_messages=list(messages if messages is not None else _MESSAGES),
        request_context=request_context,
        request_measurement=None,
        runtime=SimpleNamespace(preview_images=dict(preview_images or {})),
    )


def _usage(tokens: int, model: str = "") -> Any:
    return SimpleNamespace(last_request_input_tokens=tokens, model=model)


def _inner_estimate(messages: list[dict[str, Any]], backend: Any = None) -> int:
    inner = backend or CharEstimationBackend()
    return estimate_messages_tokens(messages, inner) + estimate_tool_schema_tokens(_TOOLS, inner)


def test_a_full_prompt_engine_records_the_inner_whole_prompt_estimate() -> None:
    loop = _loop()
    note_request_measurement(loop, _usage(1_500), tool_payload=_TOOLS)

    assert loop.budget_tracker.calibration_reading == {
        "provider_tokens": 1_500,
        "estimate_tokens": _inner_estimate(_MESSAGES),
        "estimator": "CharEstimationBackend",
        "engine": "ninfer",
        "model": "qwen3.8",
    }


def test_a_reply_from_the_configured_model_still_calibrates() -> None:
    loop = _loop()
    note_request_measurement(loop, _usage(1_500, model="qwen3.8"), tool_payload=_TOOLS)

    assert loop.budget_tracker.calibration_reading is not None


def test_a_tracker_without_a_backend_falls_back_to_the_configured_estimator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inner = CharEstimationBackend()
    monkeypatch.setattr(tool_loop_compaction, "resolve_tokenizer_backend", lambda _config: inner)
    loop = _loop(backend=None)
    note_request_measurement(loop, _usage(1_500), tool_payload=_TOOLS)

    assert loop.budget_tracker.calibration_reading["estimate_tokens"] == _inner_estimate(
        _MESSAGES, inner
    )


def test_a_scaled_tracker_backend_is_unwrapped_to_its_inner_estimator() -> None:
    inner = CharEstimationBackend()
    loop = _loop(backend=ScaledTokenizerBackend(inner, 1.4))
    note_request_measurement(loop, _usage(1_500), tool_payload=_TOOLS)

    reading = loop.budget_tracker.calibration_reading
    assert reading["estimate_tokens"] == _inner_estimate(_MESSAGES, inner)
    assert reading["estimator"] == "CharEstimationBackend"


def test_a_grown_window_keeps_counting_only_the_new_rows_and_stays_exact() -> None:
    loop = _loop()
    note_request_measurement(loop, _usage(1_500), tool_payload=_TOOLS)
    loop.working_messages.append({"role": "tool", "content": "file content\n" * 200})
    note_request_measurement(loop, _usage(2_400), tool_payload=_TOOLS)

    reading = loop.budget_tracker.calibration_reading
    assert reading["provider_tokens"] == 2_400
    assert reading["estimate_tokens"] == _inner_estimate(loop.working_messages)


@pytest.mark.parametrize(
    "case",
    [
        "ollama_like_engine",
        "zero_usage",
        "image_surcharge",
        "image_attached",
        "tool_preview_image",
        "fallback_model_reply",
        "no_tool_payload",
    ],
)
def test_the_reading_is_withheld_when_it_would_mislead(case: str) -> None:
    request_context = None
    if case == "image_surcharge":
        request_context = SimpleNamespace(vision_images=(), vision_token_surcharge=765)
    elif case == "image_attached":
        request_context = SimpleNamespace(vision_images=(object(),), vision_token_surcharge=0)
    loop = _loop(
        full_prompt=case != "ollama_like_engine",
        request_context=request_context,
        preview_images={"call-1": object()} if case == "tool_preview_image" else None,
    )
    loop.budget_tracker.calibration_reading = {"stale": 1}
    note_request_measurement(
        loop,
        _usage(
            0 if case == "zero_usage" else 1_500,
            model="gemma-fallback" if case == "fallback_model_reply" else "",
        ),
        tool_payload=None if case == "no_tool_payload" else _TOOLS,
    )
    assert loop.budget_tracker.calibration_reading is None


def test_a_later_request_without_a_provider_count_clears_the_reading() -> None:
    loop = _loop()
    note_request_measurement(loop, _usage(1_500), tool_payload=_TOOLS)
    assert loop.budget_tracker.calibration_reading is not None
    note_request_measurement(loop, _usage(0), tool_payload=_TOOLS)
    assert loop.budget_tracker.calibration_reading is None


# -- End to end through the real router and the terminal serializer ------------


class _Engine:
    def __init__(self, *, full_prompt: bool = True, provider_tokens: int = 4_321) -> None:
        self.reports_full_prompt_input_tokens = full_prompt
        self._provider_tokens = provider_tokens

    def generate_with_tools(self, **_kwargs: Any) -> GenerationResult:
        return GenerationResult(
            content="Done.",
            finish_reason="stop",
            usage=GenerationUsage(
                input_tokens=self._provider_tokens,
                output_tokens=5,
                total_tokens=self._provider_tokens + 5,
                last_request_input_tokens=self._provider_tokens,
            ),
        )

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return 32_768


class _MCPClient:
    @property
    def available_tools(self) -> list[Any]:
        return []

    def tool_descriptor(self, _tool_name: str) -> None:
        return None


def _render_turn(
    monkeypatch: pytest.MonkeyPatch, *, engine: _Engine
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    seen: list[dict[str, Any]] = []
    original = tool_loop_compaction.note_request_measurement

    def spy(loop: Any, usage: Any, **kwargs: Any) -> None:
        seen.append(
            {
                "messages": [dict(row) for row in loop.working_messages],
                "tools": list(kwargs.get("tool_payload") or ()),
            }
        )
        original(loop, usage, **kwargs)

    monkeypatch.setattr(tool_loop_compaction, "note_request_measurement", spy)
    config = replace(
        RuntimeConfig(
            engine_type="vllm",
            model="qwen",
            tools_workspace_root="C:/workspace",
            feature_flags={"token_budget": True, "context_compaction": True},
        ),
        mode="assist",
    )
    router = ChatRouter(
        config=config, engine=engine, mcp_client=_MCPClient(), context_builder=ContextBuilder(None)
    )
    router.set_harness_snapshot_provider(lambda **_kwargs: {"tools": {"items": []}})
    decision = router.build_chat_decision(
        request_id="req_cal",
        messages=[{"role": "user", "content": "Answer the question."}],
        latest_user_content="Answer the question.",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(request_id="req_cal", max_iterations=1),
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                background_runtime_root=None,
                engine_type="vllm",
                feature_flags={},
                max_inline_payload_bytes=65_536,
                model="qwen",
            ),
            engine=engine,
            tool_observations=None,
            turn_diagnostics=None,
        )
    )
    response = _chat_response_from_decision(
        request_context=ChatRequestContext(
            request_id="req_cal",
            trace_id=None,
            session_id=None,
            mode="chat",
            approvals_pre_granted=False,
        ),
        latest_user_content="Answer the question.",
        canonical_session_messages=[],
        session_title="",
        brain_container=brain,
        decision=decision,
    )
    done = next(row for row in response.notifications if row["method"] == "chat.done")
    return done["params"]["usage"], seen


def test_a_plain_turn_emits_the_calibration_on_the_terminal_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    usage, seen = _render_turn(monkeypatch, engine=_Engine())

    assert len(seen) == 1
    expected = estimate_messages_tokens(seen[0]["messages"], CharEstimationBackend())
    expected += estimate_tool_schema_tokens(seen[0]["tools"], CharEstimationBackend())
    assert usage["context_calibration"] == {
        "provider_tokens": 4_321,
        "estimate_tokens": expected,
        "engine": "vllm",
        "model": "qwen",
        "estimator": "CharEstimationBackend",
    }


def test_an_ollama_like_engine_emits_no_calibration(monkeypatch: pytest.MonkeyPatch) -> None:
    usage, _ = _render_turn(monkeypatch, engine=_Engine(full_prompt=False))
    assert "context_calibration" not in usage


def test_a_zero_provider_reading_emits_no_calibration(monkeypatch: pytest.MonkeyPatch) -> None:
    usage, _ = _render_turn(monkeypatch, engine=_Engine(provider_tokens=0))
    assert "context_calibration" not in usage


def test_a_reading_for_a_different_request_than_the_usage_block_is_dropped() -> None:
    reading = {"provider_tokens": 1_500, "estimate_tokens": 1_000, "estimator": "X"}
    config = SimpleNamespace(engine_type="vllm", model="qwen")
    engine = _Engine()

    matching: dict[str, Any] = {"last_request_input_tokens": 1_500}
    attach_context_calibration(matching, reading, engine, config)
    assert matching["context_calibration"]["estimate_tokens"] == 1_000

    # A later request (recovery pass) moved the usage block's reading on.
    moved: dict[str, Any] = {"last_request_input_tokens": 1_900}
    attach_context_calibration(moved, reading, engine, config)
    assert "context_calibration" not in moved


def test_the_labels_stamped_at_measurement_win_over_the_turns_config() -> None:
    reading = {
        "provider_tokens": 1_500,
        "estimate_tokens": 1_000,
        "estimator": "X",
        "engine": "ninfer",
        "model": "qwen3.8",
    }
    usage: dict[str, Any] = {"last_request_input_tokens": 1_500}

    attach_context_calibration(
        usage, reading, _Engine(), SimpleNamespace(engine_type="vllm", model="other")
    )

    assert usage["context_calibration"]["engine"] == "ninfer"
    assert usage["context_calibration"]["model"] == "qwen3.8"
