"""Unit tests for sidecar.runtime.suggestions and request_dispatch_suggestions."""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from sidecar.ai.routing.retry import QUERY_SOURCE_BACKGROUND_CLASSIFIER
from sidecar.protocol import API_VERSION
from sidecar.runtime import request_dispatch_suggestions as dispatch_mod
from sidecar.runtime.request_dispatch_suggestions import process_suggestions_method
from sidecar.runtime.suggestions import (
    _parse_and_validate,
    _strip_code_fences,
    generate_suggestions,
)

# ---------------------------------------------------------------------------
# _strip_code_fences
# ---------------------------------------------------------------------------


def test_strip_code_fences_removes_json_fence() -> None:
    raw = '```json\n["a", "b"]\n```'
    assert _strip_code_fences(raw) == '["a", "b"]'


def test_strip_code_fences_removes_plain_fence() -> None:
    raw = '```\n["a", "b"]\n```'
    assert _strip_code_fences(raw) == '["a", "b"]'


def test_strip_code_fences_noop_on_clean_json() -> None:
    raw = '["a", "b"]'
    assert _strip_code_fences(raw) == '["a", "b"]'


def test_strip_code_fences_handles_extra_whitespace() -> None:
    raw = '  ```json  \n  ["a"]  \n  ```  '
    result = _strip_code_fences(raw)
    assert result.startswith("[")


# ---------------------------------------------------------------------------
# _parse_and_validate
# ---------------------------------------------------------------------------


def test_parse_and_validate_returns_valid_prompts() -> None:
    raw = json.dumps(
        [
            "Hello there friend",
            "How can I help today?",
            "What are you working on?",
            "Tell me more about it",
        ]
    )
    result = _parse_and_validate(raw)
    assert len(result) == 4


def test_parse_and_validate_limits_valid_prompts_to_four() -> None:
    prompts = [f"Valid prompt number {index}" for index in range(5)]

    assert _parse_and_validate(json.dumps(prompts)) == prompts[:4]


def test_parse_and_validate_filters_short_prompts() -> None:
    raw = json.dumps(
        [
            "Hi",
            "Ok",
            "Hello there friend",
            "What are you working on today?",
            "Tell me more about it",
        ]
    )
    result = _parse_and_validate(raw)
    assert len(result) == 3
    assert "Hi" not in result
    assert "Ok" not in result


def test_parse_and_validate_filters_long_prompts() -> None:
    long_prompt = "x" * 81
    raw = json.dumps(
        [long_prompt, "Hello there friend", "What are you working on?", "Tell me more"]
    )
    result = _parse_and_validate(raw)
    assert len(result) == 3
    assert long_prompt not in result


def test_parse_and_validate_returns_empty_if_fewer_than_min_valid() -> None:
    raw = json.dumps(["Only one valid prompt here"])
    result = _parse_and_validate(raw)
    assert result == []


def test_parse_and_validate_returns_empty_on_non_list() -> None:
    raw = json.dumps({"prompts": ["a", "b"]})
    result = _parse_and_validate(raw)
    assert result == []


def test_parse_and_validate_filters_non_string_items() -> None:
    raw = json.dumps(["Valid prompt one", 42, None, "Valid prompt two"])
    result = _parse_and_validate(raw)
    assert len(result) == 2


# ---------------------------------------------------------------------------
# generate_suggestions
# ---------------------------------------------------------------------------


def _make_brain_container(generate_return: str = "[]") -> MagicMock:
    container = MagicMock()
    container.stack.engine.generate.return_value = generate_return
    return container


def test_generate_suggestions_returns_empty_when_no_stack() -> None:
    container = MagicMock()
    container.stack = None
    result = generate_suggestions(container, {}, logging.getLogger("test"))
    assert result == []


def test_generate_suggestions_returns_empty_on_engine_error() -> None:
    container = _make_brain_container()
    container.stack.engine.generate.side_effect = RuntimeError("engine down")
    result = generate_suggestions(container, {}, logging.getLogger("test"))
    assert result == []


def test_generate_suggestions_returns_valid_list() -> None:
    prompts = ["Hello there", "How can I help?", "What is on your mind?", "Tell me more"]
    container = _make_brain_container(json.dumps(prompts))
    result = generate_suggestions(container, {}, logging.getLogger("test"))
    assert result == prompts


def test_generate_suggestions_returns_empty_on_invalid_json() -> None:
    container = _make_brain_container("not json at all {{{")
    result = generate_suggestions(container, {}, logging.getLogger("test"))
    assert result == []


def test_generate_suggestions_handles_code_fenced_response() -> None:
    prompts = ["Hello there", "How can I help?", "What next?", "Tell me more"]
    fenced = f"```json\n{json.dumps(prompts)}\n```"
    container = _make_brain_container(fenced)
    result = generate_suggestions(container, {}, logging.getLogger("test"))
    assert result == prompts


def test_generate_suggestions_disables_thinking_for_background_call() -> None:
    """Regression 2026-07-17: without an explicit opt-out, a thinking-capable
    model inflates num_predict by its thinking headroom (16k on large-context
    models) and the splash-chip generation held Ollama's single slot for
    minutes, starving the user's real chat (stream_8b1459c1: 8,645 thinking
    tokens decoded while the timeline showed nothing). "low" is the engine
    contract for an explicit think:false."""
    prompts = ["Hello there", "How can I help?", "What next?", "Tell me more"]
    container = _make_brain_container(json.dumps(prompts))
    generate_suggestions(container, {}, logging.getLogger("test"))
    assert container.stack.engine.generate.call_args.kwargs["reasoning_effort"] == "low"


def test_generate_suggestions_uses_retry_seam(monkeypatch: pytest.MonkeyPatch) -> None:
    prompts = ["Hello there", "How can I help?", "What next?", "Tell me more"]
    container = _make_brain_container(json.dumps(prompts))
    container.stack.config = SimpleNamespace(
        feature_flags={"api_retry": True},
        engine_type="openai",
        model="gpt-4.1",
    )
    captured: dict[str, object] = {}

    def _fake_retry(**kwargs: object) -> str:
        captured.update(
            {
                "request_source": kwargs["request_source"],
                "initial_max_tokens": kwargs["initial_max_tokens"],
            }
        )
        return kwargs["operation"](SimpleNamespace(attempt=1, max_tokens=123))

    monkeypatch.setattr(
        "sidecar.runtime.suggestions.execute_with_provider_retry",
        _fake_retry,
    )

    result = generate_suggestions(container, {}, logging.getLogger("test"))

    assert result == prompts
    assert captured == {
        "request_source": QUERY_SOURCE_BACKGROUND_CLASSIFIER,
        "initial_max_tokens": 300,
    }
    assert container.stack.engine.generate.call_args.kwargs["max_tokens"] == 123


# ---------------------------------------------------------------------------
# process_suggestions_method
# ---------------------------------------------------------------------------


def test_process_suggestions_method_returns_none_for_wrong_method() -> None:
    result = process_suggestions_method(
        "chat.send", 1, {}, True, MagicMock(), logging.getLogger("test")
    )
    assert result is None


def test_process_suggestions_method_returns_error_when_not_initialized() -> None:
    result = process_suggestions_method(
        "suggestions.generate",
        1,
        {"accept_version": API_VERSION},
        False,
        MagicMock(),
        logging.getLogger("test"),
    )
    assert result is not None
    assert result.initialized is False
    assert result.response is not None
    assert "error" in result.response


def test_process_suggestions_method_notification_skips_generation(monkeypatch) -> None:  # noqa: ANN001
    calls: list[object] = []
    monkeypatch.setattr(
        dispatch_mod,
        "generate_suggestions",
        lambda *_args, **_kwargs: calls.append(object()) or ["generated"],
    )

    result = process_suggestions_method(
        "suggestions.generate",
        None,
        {"accept_version": API_VERSION},
        True,
        MagicMock(),
        logging.getLogger("test"),
    )

    assert result is not None
    assert result.response is None
    assert calls == []


def test_process_suggestions_method_returns_suggestions_on_success() -> None:
    prompts = ["Hello there", "How can I help?", "What is next?", "Tell me more"]
    container = _make_brain_container(json.dumps(prompts))
    result = process_suggestions_method(
        "suggestions.generate",
        1,
        {"accept_version": API_VERSION},
        True,
        container,
        logging.getLogger("test"),
    )
    assert result is not None
    assert result.response["result"]["suggestions"] == prompts
