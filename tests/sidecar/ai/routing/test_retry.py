from __future__ import annotations

import logging
import time

import pytest

from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.retry import (
    QUERY_SOURCE_BACKGROUND_SUMMARY,
    QUERY_SOURCE_CHAT_SEND,
    RetryExecutionContext,
    execute_with_provider_retry,
)
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED, TURN_STATE_TIMEOUT


def _provider_error(
    *,
    classification: str,
    retryable: bool,
    status_code: int | None = None,
    retry_after_seconds: float | None = None,
    body: object | None = None,
) -> ProviderHttpError:
    return ProviderHttpError(
        provider="openai",
        status_code=status_code,
        code="CMP-CLOUD-1003",
        message=f"provider failure: {classification}",
        retryable=retryable,
        classification=classification,
        retry_after_seconds=retry_after_seconds,
        body=body,
    )


def test_execute_with_provider_retry_retries_transient_failure_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = {"count": 0}
    delays: list[float] = []
    retry_hooks: list[tuple[RetryExecutionContext, str]] = []
    monkeypatch.setattr("sidecar.ai.routing.retry.time.sleep", delays.append)

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise _provider_error(classification="connection_error", retryable=True)
        return "ok"

    result = execute_with_provider_retry(
        operation=_operation,
        logger=logging.getLogger("test.retry"),
        component="test.retry",
        event_prefix="test.retry",
        request_source=QUERY_SOURCE_CHAT_SEND,
        provider="openai",
        model="gpt-4.1",
        initial_max_tokens=4096,
        feature_flags={"api_retry": True},
        before_retry=lambda context, error: retry_hooks.append(
            (context, error.classification)
        ),
    )

    assert result == "ok"
    assert attempts["count"] == 2
    assert len(delays) == 1
    assert retry_hooks == [(RetryExecutionContext(attempt=1, max_tokens=4096), "connection_error")]


def test_execute_with_provider_retry_does_not_retry_non_retryable_failures() -> None:
    attempts = {"count": 0}
    retry_hooks: list[RetryExecutionContext] = []

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        raise _provider_error(classification="invalid_model", retryable=False, status_code=400)

    with pytest.raises(ProviderHttpError) as exc_info:
        execute_with_provider_retry(
            operation=_operation,
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=QUERY_SOURCE_CHAT_SEND,
            provider="openai",
            model="gpt-4.1",
            initial_max_tokens=4096,
            feature_flags={"api_retry": True},
            before_retry=lambda context, _error: retry_hooks.append(context),
        )

    assert attempts["count"] == 1
    assert exc_info.value.classification == "invalid_model"
    assert retry_hooks == []


def test_execute_with_provider_retry_skips_retry_logic_when_feature_flag_is_disabled() -> None:
    seen_contexts: list[RetryExecutionContext] = []

    def _operation(context: RetryExecutionContext) -> str:
        seen_contexts.append(context)
        return "ok"

    result = execute_with_provider_retry(
        operation=_operation,
        logger=logging.getLogger("test.retry"),
        component="test.retry",
        event_prefix="test.retry",
        request_source=QUERY_SOURCE_CHAT_SEND,
        provider="openai",
        model="gpt-4.1",
        initial_max_tokens=4096,
        feature_flags={"api_retry": False},
    )

    assert result == "ok"
    assert seen_contexts == [RetryExecutionContext(attempt=1, max_tokens=4096)]


def test_execute_with_provider_retry_honors_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}
    delays: list[float] = []
    monkeypatch.setattr("sidecar.ai.routing.retry.time.sleep", delays.append)

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise _provider_error(
                classification="rate_limit",
                retryable=True,
                status_code=429,
                retry_after_seconds=2.5,
            )
        return "ok"

    assert (
        execute_with_provider_retry(
            operation=_operation,
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=QUERY_SOURCE_CHAT_SEND,
            provider="openai",
            model="gpt-4.1",
            initial_max_tokens=4096,
            feature_flags={"api_retry": True},
        )
        == "ok"
    )
    assert delays == [2.5]


def test_execute_with_provider_retry_caps_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}
    delays: list[float] = []
    monkeypatch.setattr("sidecar.ai.routing.retry.time.sleep", delays.append)

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise _provider_error(
                classification="rate_limit",
                retryable=True,
                status_code=429,
                retry_after_seconds=999.0,
            )
        return "ok"

    assert (
        execute_with_provider_retry(
            operation=_operation,
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=QUERY_SOURCE_CHAT_SEND,
            provider="openai",
            model="gpt-4.1",
            initial_max_tokens=4096,
            feature_flags={"api_retry": True},
        )
        == "ok"
    )
    assert delays == [32.0]


def test_execute_with_provider_retry_bails_immediately_on_background_overload() -> None:
    attempts = {"count": 0}

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        raise _provider_error(
            classification="server_overload",
            retryable=True,
            status_code=529,
        )

    with pytest.raises(ProviderHttpError) as exc_info:
        execute_with_provider_retry(
            operation=_operation,
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=QUERY_SOURCE_BACKGROUND_SUMMARY,
            provider="openai",
            model="gpt-4.1",
            initial_max_tokens=4096,
            feature_flags={"api_retry": True},
        )

    assert attempts["count"] == 1
    assert exc_info.value.classification == "server_overload"


def test_execute_with_provider_retry_treats_none_request_source_as_foreground(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = {"count": 0}
    monkeypatch.setattr("sidecar.ai.routing.retry.time.sleep", lambda _delay: None)

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        raise _provider_error(
            classification="server_overload",
            retryable=True,
            status_code=529,
        )

    with pytest.raises(ProviderHttpError):
        execute_with_provider_retry(
            operation=_operation,
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=None,
            provider="openai",
            model="gpt-4.1",
            initial_max_tokens=4096,
            feature_flags={"api_retry": True},
        )

    assert attempts["count"] == 3


def test_execute_with_provider_retry_honors_cancel_during_retry_delay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = {"count": 0}
    retry_hooks: list[RetryExecutionContext] = []
    cancel_handle = TurnCancellationHandle("req_cancel_retry")
    monkeypatch.setattr(
        "sidecar.ai.routing.retry.time.sleep",
        lambda _delay: pytest.fail("retry delay should wait on the cancel handle"),
    )
    monkeypatch.setattr(
        cancel_handle,
        "wait",
        lambda _delay: cancel_handle.cancel(reason="user_cancel"),
    )

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        raise _provider_error(classification="connection_error", retryable=True)

    with pytest.raises(TerminalChatStateError) as exc_info:
        execute_with_provider_retry(
            operation=_operation,
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=QUERY_SOURCE_CHAT_SEND,
            provider="openai",
            model="gpt-4.1",
            initial_max_tokens=4096,
            feature_flags={"api_retry": True},
            cancel_handle=cancel_handle,
            before_retry=lambda context, _error: retry_hooks.append(context),
        )

    assert attempts["count"] == 1
    assert retry_hooks == [RetryExecutionContext(attempt=1, max_tokens=4096)]
    assert exc_info.value.status == TURN_STATE_CANCELLED
    assert exc_info.value.terminal_subcode == "user_cancel"


def test_execute_with_provider_retry_caps_overload_retries_at_three(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = {"count": 0}
    monkeypatch.setattr("sidecar.ai.routing.retry.time.sleep", lambda _delay: None)

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        raise _provider_error(
            classification="server_overload",
            retryable=True,
            status_code=529,
        )

    with pytest.raises(ProviderHttpError):
        execute_with_provider_retry(
            operation=_operation,
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=QUERY_SOURCE_CHAT_SEND,
            provider="openai",
            model="gpt-4.1",
            initial_max_tokens=4096,
            feature_flags={"api_retry": True},
        )

    assert attempts["count"] == 3


def test_execute_with_provider_retry_reduces_max_tokens_after_context_overflow() -> None:
    seen_contexts: list[RetryExecutionContext] = []
    retry_hooks: list[RetryExecutionContext] = []

    def _operation(context: RetryExecutionContext) -> str:
        seen_contexts.append(context)
        if len(seen_contexts) == 1:
            raise _provider_error(
                classification="context_overflow",
                retryable=True,
                status_code=400,
                body={
                    "error": {
                        "message": (
                            "input length and `max_tokens` exceed context limit: "
                            "188059 + 20000 > 200000"
                        )
                    }
                },
            )
        return "ok"

    result = execute_with_provider_retry(
        operation=_operation,
        logger=logging.getLogger("test.retry"),
        component="test.retry",
        event_prefix="test.retry",
        request_source=QUERY_SOURCE_CHAT_SEND,
        provider="anthropic",
        model="claude-sonnet-4-6",
        initial_max_tokens=20_000,
        feature_flags={"api_retry": True},
        before_retry=lambda context, _error: retry_hooks.append(context),
    )

    assert result == "ok"
    assert [context.max_tokens for context in seen_contexts] == [20_000, 10_941]
    assert retry_hooks == [RetryExecutionContext(attempt=1, max_tokens=20_000)]


def test_execute_with_provider_retry_does_not_retry_context_overflow_below_floor() -> None:
    attempts = {"count": 0}

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        raise _provider_error(
            classification="context_overflow",
            retryable=True,
            status_code=400,
            body={
                "error": {
                    "message": (
                        "input length and `max_tokens` exceed context limit: "
                        "195500 + 20000 > 199000"
                    )
                }
            },
        )

    with pytest.raises(ProviderHttpError):
        execute_with_provider_retry(
            operation=_operation,
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=QUERY_SOURCE_CHAT_SEND,
            provider="anthropic",
            model="claude-sonnet-4-6",
            initial_max_tokens=20_000,
            feature_flags={"api_retry": True},
        )

    assert attempts["count"] == 1


def test_provider_retry_deadline_bounds_backoff_and_prevents_next_attempt() -> None:
    # A fake clock/sleep pair makes the deadline decision exact. The former
    # real-clock version (deadline = now + 0.03) was load-flaky on Windows:
    # GetTickCount64's 15.625ms resolution can quantize the elapsed backoff
    # sleep to a single tick, leaving measured "remaining" time > 0 after a
    # full-length sleep and admitting a second attempt. All values below are
    # exact binary fractions so remaining-time arithmetic carries no float dust.
    attempts = {"count": 0}
    clock = {"now": 1024.0}
    slept: list[float] = []

    def _sleep(seconds: float) -> None:
        slept.append(seconds)
        clock["now"] += seconds

    runtime = LoopRuntime(
        request_id="req-deadline",
        wall_clock_deadline=1024.0 + 0.03125,
        clock=lambda: clock["now"],
        sleep=_sleep,
    )

    def _operation(_context: RetryExecutionContext) -> str:
        attempts["count"] += 1
        raise _provider_error(classification="connection_error", retryable=True)

    with pytest.raises(TerminalChatStateError) as excinfo:
        execute_with_provider_retry(
            operation=_operation,
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=QUERY_SOURCE_CHAT_SEND,
            provider="ollama",
            model="local",
            initial_max_tokens=4096,
            feature_flags={"api_retry": True},
            runtime=runtime,
        )

    assert excinfo.value.status == TURN_STATE_TIMEOUT
    assert attempts["count"] == 1
    # The first backoff (base 0.5s + jitter) must be clamped to the remaining
    # deadline budget rather than sleeping the full computed delay.
    assert slept == [0.03125]


def test_expired_provider_deadline_prevents_first_attempt() -> None:
    runtime = LoopRuntime(
        request_id="req-expired",
        wall_clock_deadline=time.monotonic() - 1.0,
    )

    with pytest.raises(TerminalChatStateError) as excinfo:
        execute_with_provider_retry(
            operation=lambda _context: pytest.fail("expired request must not dispatch"),
            logger=logging.getLogger("test.retry"),
            component="test.retry",
            event_prefix="test.retry",
            request_source=QUERY_SOURCE_CHAT_SEND,
            provider="ollama",
            model="local",
            initial_max_tokens=4096,
            feature_flags={"api_retry": True},
            runtime=runtime,
        )

    assert excinfo.value.status == TURN_STATE_TIMEOUT
