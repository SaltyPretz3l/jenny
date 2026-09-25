"""Behavioral unit tests for sidecar.runtime.request_dispatch_compact.

Drives process_compact_method (the manual ``chat.compact`` JSON-RPC handler)
through its guard and error branches with a duck-typed brain_container. The
compaction itself is monkeypatched at the module-under-test seam so no LLM,
disk, or engine is involved. Asserts the four wire response shapes from the
handoff contract: ok / circuit_breaker_open / no_active_turn (nothing to
compact) / compaction_failed — plus the flag-off fail-closed branch (R5:
the sidecar dispatch gates ``compaction_manual`` in addition to the renderer).
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch_compact as rdc
from sidecar.ai.context.compaction import CompactionCircuitBreaker, CompactionResult
from sidecar.ai.engines.admitted import InferenceAttemptContext, InferenceAttemptOutcome
from sidecar.protocol import (
    API_VERSION,
    CHAT_COMPACT_METHOD,
    CONTEXT_COMPACTED_METHOD,
)

LOGGER = logging.getLogger("test.request_dispatch_compact")


class _StubEngine:
    def get_model_context_length(self) -> int:
        return 100_000

    def get_model_max_output_tokens(self) -> int:
        return 8_000


class _StubRouter:
    def __init__(self) -> None:
        self.generate_fn_calls: list[dict[str, Any]] = []

    def _build_compaction_generate_fn(self, **kwargs: Any) -> Any:
        self.generate_fn_calls.append(kwargs)
        return lambda _messages: "<analysis>a</analysis><summary>s</summary>"


class _ManualCompactionEngine:
    def get_model_context_length(self) -> int:
        return 32_768

    def get_model_max_output_tokens(self) -> int:
        return 8_192


class _ReplyRouter:
    def __init__(self, reply: str) -> None:
        self.reply = reply

    def _build_compaction_generate_fn(self, **_kwargs: Any) -> Any:
        return lambda _messages: self.reply


def make_brain(*, manual_enabled: bool = True) -> SimpleNamespace:
    config = SimpleNamespace(
        engine_type="ollama",
        model="qwen3:8b",
        context_length=50_000,
        max_tokens=4_000,
        feature_flags={"compaction_manual": manual_enabled},
        compaction_custom_prompt=None,
        token_budget_auto_compact_ratio=None,
        token_budget_auto_compact_ratio_by_model=None,
    )
    return SimpleNamespace(
        stack=SimpleNamespace(config=config, engine=_StubEngine(), router=_StubRouter())
    )


def make_real_compaction_brain(reply: str) -> SimpleNamespace:
    config = SimpleNamespace(
        engine_type="ollama",
        model="ornith",
        context_length=32_768,
        max_tokens=8_192,
        feature_flags={"compaction_manual": True},
        compaction_custom_prompt=None,
        token_budget_auto_compact_ratio=None,
        token_budget_auto_compact_ratio_by_model=None,
    )
    return SimpleNamespace(
        stack=SimpleNamespace(
            config=config,
            engine=_ManualCompactionEngine(),
            router=_ReplyRouter(reply),
        )
    )


def accept_params(**extra: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"accept_version": API_VERSION}
    base.update(extra)
    return base


def compact_params(**extra: Any) -> dict[str, Any]:
    return accept_params(
        session_id="sess-1",
        messages=[
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "world"},
        ],
        **extra,
    )


TOOL_ROUND_HISTORY = [
    {"role": "user", "content": "Review README.md and main.js."},
    {
        "role": "assistant",
        "content": "A long tutorial about the addition utility. " * 40,
    },
    {
        "role": "user",
        "content": "After the tutorial, reply with QUEUE GATE COMPLETE.",
    },
    {
        "role": "assistant",
        "content": "todo_write",
        "tool_calls": [
            {
                "id": "call-1",
                "type": "function",
                "function": {"name": "todo_write", "arguments": "{}"},
            }
        ],
    },
    {
        "role": "tool",
        "content": "todo_write",
        "tool_call_id": "call-1",
        "name": "todo_write",
    },
    {"role": "assistant", "content": "QUEUE GATE COMPLETE"},
]


def run_real_compaction(reply: str):  # noqa: ANN201 -- test helper returns ProcessOutcome
    return run(
        CHAT_COMPACT_METHOD,
        7,
        accept_params(session_id="sess-b5", messages=TOOL_ROUND_HISTORY),
        brain=make_real_compaction_brain(reply),
    )


def run(  # noqa: PLR0913 -- focused dispatcher helper mirrors its request boundary
    method: str,
    message_id: Any,
    params: Any,
    *,
    initialized: bool = True,
    brain: SimpleNamespace | None = None,
    write_message: Any = None,
    response_reader_factory: Any = None,
):
    return rdc.process_compact_method(
        method,
        message_id,
        params,
        initialized,
        brain or make_brain(),
        LOGGER,
        write_message=write_message,
        response_reader_factory=response_reader_factory,
    )


@pytest.fixture(autouse=True)
def _fresh_breaker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rdc, "_MANUAL_COMPACTION_BREAKER", CompactionCircuitBreaker())


def _compaction_result(strategy: str = "full", error: str | None = None) -> CompactionResult:
    return CompactionResult(
        messages=[{"role": "system", "content": "[Compacted context]"}],
        strategy=strategy,
        tokens_before=1_000,
        tokens_after=200,
        error=error,
    )


# -- routing guards ------------------------------------------------------------


def test_unknown_method_returns_none() -> None:
    assert run("not.chat.compact", 1, compact_params()) is None


def test_missing_accept_version_returns_version_error() -> None:
    outcome = run(CHAT_COMPACT_METHOD, 7, {"session_id": "sess-1"})
    assert outcome is not None
    assert outcome.response is not None
    assert "error" in outcome.response


def test_not_initialized_fails_closed() -> None:
    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params(), initialized=False)
    assert outcome is not None
    assert outcome.response is not None
    assert "error" in outcome.response


def test_notification_style_call_without_id_is_ignored() -> None:
    outcome = run(CHAT_COMPACT_METHOD, None, compact_params())
    assert outcome is not None
    assert outcome.response is None
    assert outcome.notifications == []


# -- flag gate (R5: sidecar-side gate in addition to the renderer) -------------


def test_flag_off_returns_feature_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[Any] = []
    monkeypatch.setattr(rdc, "compact_context", lambda *a, **k: called.append(1))
    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params(), brain=make_brain(manual_enabled=False))
    assert outcome is not None
    result = outcome.response["result"]
    assert result == {
        "api_version": API_VERSION,
        "status": "error",
        "reason": "feature_disabled",
    }
    assert called == []
    assert outcome.notifications == []


# -- fail-closed branches -------------------------------------------------------


def test_empty_messages_returns_no_active_turn() -> None:
    outcome = run(CHAT_COMPACT_METHOD, 7, accept_params(session_id="sess-1", messages=[]))
    assert outcome.response["result"] == {
        "api_version": API_VERSION,
        "status": "error",
        "reason": "no_active_turn",
    }


def test_missing_messages_returns_no_active_turn() -> None:
    outcome = run(CHAT_COMPACT_METHOD, 7, accept_params(session_id="sess-1"))
    assert outcome.response["result"] == {
        "api_version": API_VERSION,
        "status": "error",
        "reason": "no_active_turn",
    }


def test_open_circuit_breaker_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    breaker = CompactionCircuitBreaker()
    for _ in range(breaker.max_failures):
        breaker.record_failure()
    monkeypatch.setattr(rdc, "_MANUAL_COMPACTION_BREAKER", breaker)
    called: list[Any] = []
    monkeypatch.setattr(rdc, "compact_context", lambda *a, **k: called.append(1))

    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params())

    result = outcome.response["result"]
    assert result["status"] == "error"
    assert result["reason"] == "circuit_breaker_open"
    assert result["retry_after_seconds"] > 0
    assert called == []
    assert outcome.notifications == []


def test_compaction_raising_returns_structured_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*_args: Any, **_kwargs: Any) -> CompactionResult:
        raise RuntimeError("engine exploded")

    monkeypatch.setattr(rdc, "compact_context", _boom)

    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params())

    result = outcome.response["result"]
    assert result["status"] == "error"
    assert result["reason"] == "compaction_failed"
    assert "engine exploded" in result["detail"]
    assert outcome.notifications == []


def test_compaction_failure_detail_is_redacted_before_the_wire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*_args: Any, **_kwargs: Any) -> CompactionResult:
        raise RuntimeError("upstream rejected Authorization: Bearer sk-live-secret-token")

    monkeypatch.setattr(rdc, "compact_context", _boom)

    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params())

    result = outcome.response["result"]
    assert result["reason"] == "compaction_failed"
    # result_response does not sanitize, so the detail must arrive redacted.
    assert "sk-live-secret-token" not in result["detail"]
    assert "[redacted]" in result["detail"]


def test_compaction_result_error_returns_structured_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        rdc,
        "compact_context",
        lambda *a, **k: _compaction_result(strategy="micro", error="too long"),
    )

    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params())

    result = outcome.response["result"]
    assert result == {
        "api_version": API_VERSION,
        "status": "error",
        "reason": "compaction_failed",
        "detail": "too long",
    }
    assert outcome.notifications == []


@pytest.mark.parametrize("reply", ["", "### 1. Intent Summary\nreview"])
def test_failed_summary_micro_fallback_returns_compaction_failed(reply: str) -> None:
    outcome = run_real_compaction(reply)

    assert outcome.response["result"] == {
        "api_version": API_VERSION,
        "status": "error",
        "reason": "compaction_failed",
        "detail": "summary_malformed",
    }
    assert outcome.notifications == []


def test_full_compaction_failure_log_carries_reason_code(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger="sidecar.ai.context.compaction")

    run_real_compaction("")

    record = next(
        entry for entry in caplog.records if "Full compaction failed" in entry.getMessage()
    )
    assert record.data["reason_code"] == "summary_malformed"
    assert record.data["error_type"] == "ValueError"
    assert record.data["response_chars"] == 0
    assert record.data["error_message"] == "Empty compaction response"


class _RaisingRouter:
    def _build_compaction_generate_fn(self, **_kwargs: Any) -> Any:
        def generate(_messages: Any) -> str:
            raise ValueError("provider rejected prompt: PRIVATE-REVIEW-SENTINEL")

        return generate


def test_full_compaction_failure_log_omits_generator_error_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger="sidecar.ai.context.compaction")
    brain = make_real_compaction_brain("")
    brain.stack.router = _RaisingRouter()

    run(
        CHAT_COMPACT_METHOD,
        8,
        accept_params(session_id="sess-b5", messages=TOOL_ROUND_HISTORY),
        brain=brain,
    )

    record = next(
        entry for entry in caplog.records if "Full compaction failed" in entry.getMessage()
    )
    assert record.data["error_type"] == "ValueError"
    assert "error_message" not in record.data
    assert "PRIVATE-REVIEW-SENTINEL" not in str(record.data)


def test_manual_full_result_keeps_latest_round_verbatim_after_summary() -> None:
    outcome = run_real_compaction(
        "<analysis>a</analysis><summary>**Intent Summary** x</summary>"
    )

    result = outcome.response["result"]
    assert result["messages"][0]["content"].startswith(
        "## Compacted Conversation Summary"
    )
    assert result["messages"][1:] == TOOL_ROUND_HISTORY[2:]


# -- success path ----------------------------------------------------------------


def test_success_returns_ok_and_emits_existing_notification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_kwargs: dict[str, Any] = {}

    def _fake_compact(messages: Any, budget: Any, **kwargs: Any) -> CompactionResult:
        captured_kwargs.update(kwargs)
        captured_kwargs["messages"] = messages
        captured_kwargs["budget"] = budget
        return _compaction_result(strategy="full")

    monkeypatch.setattr(rdc, "compact_context", _fake_compact)

    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params())

    result = outcome.response["result"]
    assert result["status"] == "ok"
    assert result["compacted"] is True
    assert result["strategy"] == "full"
    assert result["tokens_before"] == 1_000
    assert result["tokens_after"] == 200
    # JCA-003: the compacted replacement history rides the result so Electron
    # can persist it as the session's compaction snapshot.
    assert result["messages"] == [
        {"role": "system", "content": "[Compacted context]"}
    ]

    # The manual path reuses the EXISTING context.compacted notification.
    assert len(outcome.notifications) == 1
    note = outcome.notifications[0]
    assert note["method"] == CONTEXT_COMPACTED_METHOD
    assert note["params"]["strategy"] == "full"
    assert note["params"]["tokens_before"] == 1_000
    assert note["params"]["tokens_after"] == 200
    assert note["params"]["session_id"] == "sess-1"

    # The manual path shares the module-level breaker and the SAME compact_context.
    assert captured_kwargs["circuit_breaker"] is rdc._MANUAL_COMPACTION_BREAKER
    assert len(captured_kwargs["messages"]) == 2


def test_forced_compaction_success_returns_ok_compacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_kwargs: dict[str, Any] = {}

    def _fake_compact(*_args: Any, **kwargs: Any) -> CompactionResult:
        captured_kwargs.update(kwargs)
        return _compaction_result()

    monkeypatch.setattr(rdc, "compact_context", _fake_compact)

    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params())

    result = outcome.response["result"]
    assert result["status"] == "ok"
    assert result["compacted"] is True
    assert captured_kwargs["force"] is True


def test_compacted_result_over_budget_returns_compaction_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rdc, "compact_context", lambda *a, **k: _compaction_result())
    monkeypatch.setattr(
        rdc,
        "check_budget",
        lambda *_args, **_kwargs: SimpleNamespace(level="error"),
        raising=False,
    )

    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params())

    result = outcome.response["result"]
    assert result["status"] == "error"
    assert result["reason"] == "compaction_failed"
    assert "budget" in result["detail"].lower()
    assert outcome.notifications == []


def test_notification_emission_failure_degrades_to_result_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The never-raises contract covers notification EMISSION too: a raise while
    # building context.compacted must degrade to result-without-notification,
    # not propagate into the main loop.
    monkeypatch.setattr(rdc, "compact_context", lambda *a, **k: _compaction_result())

    def _boom(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise ValueError("method not allowlisted")

    monkeypatch.setattr(rdc, "notification", _boom)

    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params())

    result = outcome.response["result"]
    assert result["status"] == "ok"
    assert result["compacted"] is True
    assert outcome.notifications == []


def test_strategy_none_returns_ok_not_compacted_and_forces_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_kwargs: dict[str, Any] = {}

    def _fake_compact(*_args: Any, **kwargs: Any) -> CompactionResult:
        captured_kwargs.update(kwargs)
        return CompactionResult(
            messages=[],
            strategy="none",
            tokens_before=100,
            tokens_after=100,
        )

    monkeypatch.setattr(rdc, "compact_context", _fake_compact)

    outcome = run(CHAT_COMPACT_METHOD, 7, compact_params())

    result = outcome.response["result"]
    assert result["status"] == "ok"
    assert result["compacted"] is False
    assert result["strategy"] == "none"
    assert captured_kwargs["force"] is True
    # Nothing was compacted: no replacement history to persist, and no
    # compaction claim via the notification channel.
    assert "messages" not in result
    assert outcome.notifications == []


def test_custom_prompt_threads_into_compact_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def _fake_compact(*_args: Any, **kwargs: Any) -> CompactionResult:
        captured.update(kwargs)
        return _compaction_result()

    monkeypatch.setattr(rdc, "compact_context", _fake_compact)
    brain = make_brain()
    brain.stack.config.compaction_custom_prompt = "Summarise tersely."

    run(CHAT_COMPACT_METHOD, 7, compact_params(), brain=brain)

    base_prompt = captured["base_prompt"]
    assert base_prompt.startswith("You are a conversation summariser.")
    assert "<optional_user_guidance>\nSummarise tersely." in base_prompt
    assert base_prompt.rfind("Mandatory contract reminder") > base_prompt.rfind("Summarise tersely.")


def test_manual_compaction_threads_session_bound_admission_to_router(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[dict[str, Any]] = []

    def response_reader_factory(rpc_id: int, **_kwargs: Any):  # noqa: ANN202
        def read(_timeout: float) -> dict[str, Any]:
            return {
                "id": rpc_id,
                "result": {
                    "schema_version": 1,
                    "operation_id": sent[-1]["params"]["operation_id"],
                    "status": "granted" if sent[-1]["params"]["phase"] == "admit" else "settled",
                },
            }

        return read

    def compact_with_provider(_messages: Any, _budget: Any, **kwargs: Any) -> CompactionResult:
        generate = kwargs["generate_fn"]
        assert generate([{"role": "user", "content": "summarize"}]) == "summary"
        return _compaction_result()

    brain = make_brain()

    def build_generate(**kwargs: Any):  # noqa: ANN202
        runtime = kwargs["runtime"]

        def generate(_messages: Any) -> str:
            lease = runtime.inference_admission(InferenceAttemptContext(
                request_id=runtime.request_id,
                session_id=runtime.session_id,
                provider="ollama",
                model="qwen3:8b",
                request_source="background_summary",
                attempt=1,
                streaming=True,
            ))
            lease.settle(InferenceAttemptOutcome(
                status="succeeded", cleanup="confirmed"
            ))
            return "summary"

        return generate

    brain.stack.router._build_compaction_generate_fn = build_generate
    monkeypatch.setattr(rdc, "compact_context", compact_with_provider)
    params = compact_params(
        request_id="request_compact_1",
        inference_context={
            "schema_version": 1,
            "request_id": "request_compact_1",
            "session_id": "sess-1",
            "authority_revision": "authority_compact_1",
            "engine_type": "ollama",
        },
    )

    outcome = run(
        CHAT_COMPACT_METHOD,
        7,
        params,
        brain=brain,
        write_message=sent.append,
        response_reader_factory=response_reader_factory,
    )

    assert "result" in outcome.response, outcome.response
    assert outcome.response["result"]["status"] == "ok"
    assert [message["params"]["phase"] for message in sent] == ["admit", "settle"]
    assert all(message["params"]["request_id"] == "request_compact_1" for message in sent)
    assert all(message["params"]["session_id"] == "sess-1" for message in sent)


def test_manual_compaction_rejects_malformed_inference_context() -> None:
    outcome = run(
        CHAT_COMPACT_METHOD,
        7,
        compact_params(inference_context={"schema_version": 1}),
    )

    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["message"] == "invalid inference_context"


def test_manual_compaction_rejects_mismatched_closed_identity() -> None:
    outcome = run(
        CHAT_COMPACT_METHOD,
        7,
        compact_params(
            request_id="request_compact_1",
            inference_context={
                "schema_version": 1,
                "request_id": "request_compact_1",
                "session_id": "different-session",
                "authority_revision": "authority_compact_1",
                "engine_type": "ollama",
            },
        ),
    )

    assert outcome.response["error"]["code"] == -32602
    assert "match compact request identity" in outcome.response["error"]["data"]["detail"]
