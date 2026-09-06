from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import pytest

from sidecar.runtime.turn_retry import (
    InnerRetryableTurnError,
    append_retry_system_message,
    execute_with_inner_turn_retry,
)


def test_execute_with_inner_turn_retry_retries_twice_without_mutating_source_params() -> None:
    attempts = {"count": 0}
    source_params = {
        "messages": [{"role": "user", "content": "hello"}],
        "request_id": "req-retry",
    }

    def _flaky(params: dict[str, object]) -> dict[str, object]:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise InnerRetryableTurnError(
                reason="Malformed router payload.",
                retry_prompt="Return a valid router payload.",
                terminal_subcode="protocol_violation",
            )
        return params

    result = execute_with_inner_turn_retry(
        params=source_params,
        execute_attempt=_flaky,
        max_inner_retries=2,
    )

    assert attempts["count"] == 3
    assert len(source_params["messages"]) == 1
    assert len(result["messages"]) == 3
    assert result["messages"][-1]["role"] == "system"


def test_execute_with_inner_turn_retry_exhausts_to_runtime_error_payload() -> None:
    attempts = {"count": 0}

    def _always_fail(_params: dict[str, object]) -> dict[str, object]:
        attempts["count"] += 1
        raise InnerRetryableTurnError(
            reason="Still malformed after retries.",
            retry_prompt="Return valid structured output.",
            terminal_subcode="schema_retry_exhausted",
        )

    result = execute_with_inner_turn_retry(
        params={"messages": [{"role": "user", "content": "hello"}]},
        execute_attempt=_always_fail,
        max_inner_retries=2,
        exhausted_factory=lambda error, attempt: {
            "status": "runtime_error",
            "reason": error.reason,
            "attempts": attempt,
        },
    )

    assert attempts["count"] == 3
    assert result == {
        "status": "runtime_error",
        "reason": "Still malformed after retries.",
        "attempts": 3,
    }


def test_execute_with_inner_turn_retry_does_not_retry_non_inner_retry_errors() -> None:
    attempts = {"count": 0}

    def _invalid_params(_params: dict[str, object]) -> dict[str, object]:
        attempts["count"] += 1
        raise ValueError("chat.send params.messages must be a non-empty list.")

    with pytest.raises(ValueError, match="non-empty list"):
        execute_with_inner_turn_retry(
            params={"messages": [{"role": "user", "content": "hello"}]},
            execute_attempt=_invalid_params,
            max_inner_retries=2,
        )

    assert attempts["count"] == 1


def test_append_retry_system_message_preserves_existing_messages() -> None:
    params = {"messages": [{"role": "user", "content": "hello"}]}

    updated = append_retry_system_message(
        params,
        error=InnerRetryableTurnError(
            reason="Need retry.",
            retry_prompt="Retry safely.",
            terminal_subcode="protocol_violation",
        ),
        retry_index=1,
    )

    assert len(params["messages"]) == 1
    assert len(updated["messages"]) == 2
    assert updated["messages"][-1]["metadata"]["jenny_retry_index"] == 1


def test_clone_turn_retry_params_deep_clones_nested_message_payloads() -> None:
    params = {
        "messages": [
            {
                "role": "user",
                "content": "hello",
                "metadata": {"nested": {"count": 1}},
            }
        ],
        "debug_options": {"labels": ["a", "b"]},
    }

    cloned = append_retry_system_message(
        params,
        error=InnerRetryableTurnError(
            reason="Need retry.",
            retry_prompt="Retry safely.",
            terminal_subcode="protocol_violation",
        ),
        retry_index=1,
    )
    assert isinstance(cloned["messages"][0], dict)
    cloned["messages"][0]["metadata"]["nested"]["count"] = 99
    cloned["debug_options"]["labels"].append("c")

    assert params["messages"][0]["metadata"]["nested"]["count"] == 1
    assert params["debug_options"]["labels"] == ["a", "b"]


def test_inner_retryable_turn_error_survives_a_contextlib_context_manager() -> None:
    """The error must cross a ``@contextmanager`` without being replaced.

    ``contextlib._GeneratorContextManager.__exit__`` assigns ``__traceback__``
    onto the propagating exception. A frozen dataclass rejects that assignment,
    so the real failure is swallowed and a ``FrozenInstanceError`` surfaces in
    its place -- exactly what ``scoped_chat_request_context`` would do to the
    re-raise in ``_approval_resume_exhausted_factory``.
    """

    @contextmanager
    def _scoped() -> Iterator[None]:
        try:
            yield
        finally:
            pass

    with pytest.raises(InnerRetryableTurnError) as exc_info:
        with _scoped():
            raise InnerRetryableTurnError(
                reason="Approval plan drifted before execution.",
                retry_prompt="Re-evaluate the request and emit a fresh tool plan.",
                terminal_subcode="approval_plan_drift",
                diagnostic_components=("system_prompt",),
            )

    assert exc_info.value.reason == "Approval plan drifted before execution."
    assert exc_info.value.terminal_subcode == "approval_plan_drift"
    assert exc_info.value.diagnostic_components == ("system_prompt",)


def test_exhausted_factory_reraise_crosses_a_context_manager_intact() -> None:
    """Mirror the live shape: the exhausted-factory re-raise escapes the scope.

    ``resume_chat_send_response_from_approval_plan`` runs the retry loop inside
    ``scoped_chat_request_context``, and ``_handle_exhausted`` re-raises for any
    non-``plan_drift`` subcode. That re-raise leaves the retry loop and unwinds
    through the context manager, where the caller's ``except
    InnerRetryableTurnError`` must still match.
    """

    @contextmanager
    def _scoped() -> Iterator[None]:
        try:
            yield
        finally:
            pass

    def _always_fail(_params: dict[str, object]) -> dict[str, object]:
        raise InnerRetryableTurnError(
            reason="Still malformed after retries.",
            retry_prompt="Return valid structured output.",
            terminal_subcode="schema_retry_exhausted",
        )

    def _reraise(error: InnerRetryableTurnError, _attempt: int) -> dict[str, object]:
        raise error

    with pytest.raises(InnerRetryableTurnError) as exc_info:
        with _scoped():
            execute_with_inner_turn_retry(
                params={"messages": [{"role": "user", "content": "hello"}]},
                execute_attempt=_always_fail,
                max_inner_retries=2,
                exhausted_factory=_reraise,
            )

    assert exc_info.value.terminal_subcode == "schema_retry_exhausted"
