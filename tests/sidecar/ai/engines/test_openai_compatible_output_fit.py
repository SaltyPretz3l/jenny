"""Output-room fit for the OpenAI-compatible engine (row 66, slice W1b).

``_fit_output_to_window`` sizes the wire ``max_tokens`` from a chars/4 prompt
estimate. It scales the estimate by the turn's published count scale or the
server's own prompt count learned from usage (never below 1.0), asks
``_exact_prompt_tokens`` when a cold fit is tight, and otherwise assumes the
measured 1.4x code-heavy undercount.
"""

from __future__ import annotations

import contextlib
import json
import math
from pathlib import Path
from typing import Any

import httpx
import pytest

from sidecar.ai.engines import vllm_engine as vllm_engine_module
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine, _estimate_prompt_tokens

FIXTURES = Path(__file__).parent / "fixtures" / "ninfer"
WINDOW = 262_144
MARGIN = 512


def _engine(window: int = WINDOW, model: str | None = "model-a") -> OpenAICompatibleEngine:
    engine = OpenAICompatibleEngine(
        host="http://127.0.0.1:8080/v1", configured_context_length=window
    )
    engine.model_name = model
    return engine


def _payload(chars: int, requested: int = 250_000) -> dict[str, Any]:
    # The role value ("user", 6 chars with quotes) and the content's two quotes
    # are counted too, so the whole payload estimates to ``chars // 4``.
    return {"messages": [{"role": "user", "content": "x" * (chars - 8)}], "max_tokens": requested}


def _cold(estimate: int) -> int:
    """A tight fit with no scale and no exact count assumes the 1.4x undercount."""
    return math.ceil(estimate * 1.4)


def test_loose_unmeasured_fit_keeps_the_request() -> None:
    engine = _engine()
    payload = _payload(40_000, requested=4_096)  # 10k x 1.6 + 4k: far from the window
    assert engine._fit_output_to_window(payload) == 4_096


def test_tight_unmeasured_fit_assumes_the_cold_undercount() -> None:
    # The old fit trusted chars/4 here; with the smaller budget reservation that
    # could ask for more output than the server slot holds.
    engine = _engine()
    payload = _payload(200_000)  # 50k x 1.6 + 250k request > window
    assert engine._fit_output_to_window(payload) == WINDOW - _cold(50_000) - MARGIN


def test_recorded_usage_scales_the_fit() -> None:
    engine = _engine()
    engine._fit_output_to_window(_payload(200_000))
    engine._record_prompt_usage(65_000)  # 1.3 x the 50,000 estimate
    assert engine._fit_output_to_window(_payload(200_000)) == (
        WINDOW - math.ceil(50_000 * 1.3) - MARGIN
    )


@pytest.mark.parametrize(
    ("reported", "expected_scale"),
    [(1, None), (40_000, None), (10_000_000, None), (60_000, 1.2), (47_500, 0.95)],
)
def test_only_plausible_scales_are_learned(reported: int, expected_scale: float | None) -> None:
    # Below 0.9 the server most likely counted only the uncached tail.
    engine = _engine()
    engine._fit_output_to_window(_payload(200_000))
    engine._record_prompt_usage(reported)
    if expected_scale is None:
        assert engine._learned_prompt_scale() is None
    else:
        assert engine._learned_prompt_scale() == pytest.approx(expected_scale)


def test_a_learned_scale_below_one_never_shrinks_the_estimate() -> None:
    engine = _engine()
    engine._fit_output_to_window(_payload(200_000))
    engine._record_prompt_usage(47_500)  # 0.95
    assert engine._fit_output_to_window(_payload(200_000)) == WINDOW - 50_000 - MARGIN


@pytest.mark.parametrize("reported", [0, -5, None, "7", True, float("nan")])
def test_unusable_usage_is_ignored(reported: Any) -> None:
    engine = _engine()
    engine._fit_output_to_window(_payload(200_000))
    engine._record_prompt_usage(reported)
    assert engine._learned_prompt_scale() is None


def test_usage_without_a_fitted_estimate_is_ignored() -> None:
    engine = _engine()
    engine._record_prompt_usage(65_000)
    assert engine._learned_prompt_scale() is None


def test_an_estimate_teaches_at_most_one_reading() -> None:
    engine = _engine()
    engine._fit_output_to_window(_payload(200_000))
    engine._record_prompt_usage(65_000)
    engine._prompt_scale = None
    engine._record_prompt_usage(65_000)  # no new fit since: nothing to pair with
    assert engine._learned_prompt_scale() is None


def test_an_engine_without_full_prompt_counts_learns_nothing() -> None:
    engine = _engine()
    engine.reports_full_prompt_input_tokens = False  # type: ignore[misc]
    engine._fit_output_to_window(_payload(200_000))
    engine._record_prompt_usage(65_000)
    assert engine._learned_prompt_scale() is None


def test_an_image_request_teaches_no_scale() -> None:
    engine = _engine()
    payload = _payload(200_000)
    payload["messages"].append(
        {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:"}}]}
    )
    engine._fit_output_to_window(payload)
    engine._record_prompt_usage(65_000)
    assert engine._learned_prompt_scale() is None


def test_the_turns_published_scale_sizes_the_fit(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = _engine()
    context: dict[str, Any] = {"prompt_token_scale": 1.25}
    monkeypatch.setattr(engine, "_current_request_context", lambda: context)
    assert engine._fit_output_to_window(_payload(200_000)) == (
        WINDOW - math.ceil(50_000 * 1.25) - MARGIN
    )
    engine._prompt_scale = ("model-a", 1.3)  # the larger known scale wins
    assert engine._fit_output_to_window(_payload(200_000)) == (
        WINDOW - math.ceil(50_000 * 1.3) - MARGIN
    )


def test_model_change_and_unload_reset_the_scale() -> None:
    engine = _engine()
    engine._fit_output_to_window(_payload(200_000))
    engine._record_prompt_usage(65_000)
    assert engine._learned_prompt_scale() == pytest.approx(1.3)
    engine.model_name = "model-b"
    assert engine._learned_prompt_scale() is None
    engine.model_name = "model-a"
    engine.unload_model()
    engine.model_name = "model-a"
    assert engine._learned_prompt_scale() is None


def test_tight_unmeasured_fit_uses_the_exact_count() -> None:
    engine = _engine()
    seen: list[dict[str, Any]] = []

    def exact(payload: dict[str, Any]) -> int:
        seen.append(payload)
        return 70_000

    engine._exact_prompt_tokens = exact  # type: ignore[method-assign]
    payload = _payload(800_000)  # 200k estimate x 1.6 + 250k request > window
    assert engine._fit_output_to_window(payload) == WINDOW - 70_000 - MARGIN
    assert len(seen) == 1


def test_exact_count_is_not_asked_when_loose_or_already_measured() -> None:
    engine = _engine()
    calls: list[int] = []
    engine._exact_prompt_tokens = lambda _payload: calls.append(1) or 5  # type: ignore[method-assign]
    engine._fit_output_to_window(_payload(40_000, requested=4_096))
    assert calls == []
    engine._fit_output_to_window(_payload(800_000))
    assert calls == [1]
    engine._record_prompt_usage(260_000)  # 1.3 x 200k
    engine._fit_output_to_window(_payload(800_000))
    assert calls == [1]


@pytest.mark.parametrize("result", ["raise", 0, -3, None])
def test_failing_or_unusable_exact_count_falls_back_to_the_cold_allowance(result: Any) -> None:
    engine = _engine()

    def exact(_payload: dict[str, Any]) -> Any:
        if result == "raise":
            raise RuntimeError("count endpoint down")
        return result

    engine._exact_prompt_tokens = exact  # type: ignore[method-assign]
    assert engine._fit_output_to_window(_payload(600_000)) == WINDOW - _cold(150_000) - MARGIN


@pytest.mark.parametrize("estimate_chars", [400_000, 600_000, 800_000])
def test_a_cold_fit_never_overflows_at_the_measured_undercount(estimate_chars: int) -> None:
    # Invariant: prompt (at the 1.37x code-heavy undercount) + fitted max_tokens
    # stays within the window on a cold engine, unless the floor binds.
    engine = _engine()
    payload = _payload(estimate_chars)
    fitted = engine._fit_output_to_window(payload)
    true_prompt = math.ceil(_estimate_prompt_tokens(payload) * 1.37)
    assert true_prompt + fitted <= WINDOW or fitted == 1_024


def _sse(prompt_tokens: int) -> bytes:
    chunks = [
        {"choices": [{"index": 0, "delta": {"content": "ok"}, "finish_reason": None}]},
        {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        {
            "choices": [],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": 2,
                "total_tokens": prompt_tokens + 2,
            },
        },
    ]
    lines = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks] + ["data: [DONE]\n\n"]
    return "".join(lines).encode("utf-8")


def test_streamed_usage_teaches_the_next_fit(monkeypatch: pytest.MonkeyPatch) -> None:
    props = json.loads((FIXTURES / "props.json").read_text(encoding="utf-8"))
    monkeypatch.setattr(vllm_engine_module, "probe_server_modalities", lambda **_kw: props)
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            body, content_type = (FIXTURES / "v1_models.json").read_bytes(), "application/json"
        elif request.url.path != "/v1/chat/completions":
            # A tight cold fit asks for an exact count first; this server has no route.
            return httpx.Response(404, request=request, json={"error": "not found"})
        else:
            payload = json.loads(request.content)
            sent.append(payload)
            reported = math.ceil(_estimate_prompt_tokens(payload) * 1.3)
            body, content_type = _sse(reported), "text/event-stream"
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": content_type},
            stream=httpx.ByteStream(body),
        )

    engine = OpenAICompatibleEngine(host="http://127.0.0.1:8080/v1")
    engine._service._client.close()
    engine._service._client = httpx.Client(
        base_url=engine._base_url, transport=httpx.MockTransport(handler)
    )
    try:
        engine.load_model("qwen3.8-27b-nvfp4")
        window = engine.get_configured_context_length()
        assert window == 32_768
        messages = [{"role": "user", "content": "y" * 60_000}]
        for _ in range(2):
            list(engine.stream(prompt="", max_tokens=30_000, messages=messages))
        assert engine._learned_prompt_scale() == pytest.approx(1.3, abs=0.01)
        first, second = (item["max_tokens"] for item in sent)
        estimate = _estimate_prompt_tokens(sent[0])
        assert first == window - _cold(estimate) - MARGIN
        assert second == window - math.ceil(estimate * 1.3) - MARGIN
    finally:
        with contextlib.suppress(Exception):
            engine.close()
