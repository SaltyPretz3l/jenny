"""Unit tests for sidecar.runtime.session_title and request_dispatch_session_title."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from sidecar.ai.engines.admitted import InferenceAdmissionRefused
from sidecar.ai.routing.retry import QUERY_SOURCE_BACKGROUND_CLASSIFIER
from sidecar.protocol import API_VERSION, SESSION_GENERATE_TITLE_METHOD
from sidecar.runtime import request_dispatch_session_title as dispatch_mod
from sidecar.runtime import server_auxiliary_workers
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.request_dispatch_session_title import process_session_title_method
from sidecar.runtime.session_title import (
    _MAX_INPUT_CHARS,
    clean_title,
    generate_session_title,
)

LOG = logging.getLogger("test.session_title")


def _container(
    reply: str = "Fixing the login bug",
    *,
    engine_type: str = "ollama",
) -> MagicMock:
    container = MagicMock()
    container.stack.engine.generate.return_value = reply
    container.stack.config = SimpleNamespace(
        feature_flags={}, engine_type=engine_type, model="m"
    )
    return container


# ---------------------------------------------------------------------------
# clean_title
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Fixing the login bug", "Fixing the login bug"),
        ('"Fixing the login bug"', "Fixing the login bug"),
        ("“Fixing the login bug”", "Fixing the login bug"),
        ("`Fixing the login bug`", "Fixing the login bug"),
        ("Title: Fixing the login bug", "Fixing the login bug"),
        ("title: Fixing the login bug", "Fixing the login bug"),
        ("NAME: Fixing the login bug", "Fixing the login bug"),
        ("Topic: Fixing the login bug", "Fixing the login bug"),
        ("# Fixing the login bug", "Fixing the login bug"),
        ("**Fixing the login bug**", "Fixing the login bug"),
        ("Fixing the login bug.", "Fixing the login bug"),
        ("Fixing the login bug?!", "Fixing the login bug"),
        ("  Fixing   the\tlogin   bug  ", "Fixing the login bug"),
        ("Fixing the login bug\nThis chat is about logins.", "Fixing the login bug"),
        ("\n\nFixing the login bug\n", "Fixing the login bug"),
        ("```\nFixing the login bug\n```", "Fixing the login bug"),
        ("<think>let me think about this</think>\nFixing the login bug", "Fixing the login bug"),
        ("修复登录错误。", "修复登录错误"),
        ("修复 登录错误！", "修复 登录错误"),
        (
            "Отладка входа в систему.",
            "Отладка входа в систему",
        ),
    ],
)
def test_clean_title_accepts_and_normalizes(raw: str, expected: str) -> None:
    assert clean_title(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   \n  ",
        "A",
        "<think>only thinking, never closed",
        "x" * 61,
        "one two three four five six seven eight nine",
        "I'm sorry, but I can't help with that",
        "I am sorry about that",
        "Sorry, no title",
        "I cannot name this chat",
        "I can't name this",
        "i’m sorry",
        "Naming <b>bold</b> tags",
        "A title </div> here",
        "Title:",
        '""',
    ],
)
def test_clean_title_rejects(raw: str) -> None:
    assert clean_title(raw) == ""


def test_clean_title_rejects_rather_than_clips_a_long_sentence() -> None:
    sentence = "This is a very long sentence that explains the whole conversation in detail"
    assert clean_title(sentence) == ""


# ---------------------------------------------------------------------------
# generate_session_title
# ---------------------------------------------------------------------------


def test_generate_returns_cleaned_title() -> None:
    container = _container('"Fixing the login bug."')
    assert generate_session_title(container, "login is broken", "Try this", LOG) == (
        "Fixing the login bug"
    )


def test_generate_returns_empty_without_user_message() -> None:
    container = _container()
    assert generate_session_title(container, "   ", "reply", LOG) == ""
    container.stack.engine.generate.assert_not_called()


def test_generate_returns_empty_without_stack() -> None:
    container = MagicMock()
    container.stack = None
    assert generate_session_title(container, "hello", "reply", LOG) == ""


def test_generate_reasoning_effort_none_for_ollama() -> None:
    container = _container(engine_type="ollama")
    generate_session_title(container, "hello there", "hi", LOG)
    assert container.stack.engine.generate.call_args.kwargs["reasoning_effort"] == "none"


def test_generate_reasoning_effort_low_for_codex_cli() -> None:
    container = _container(engine_type="codex-cli")
    generate_session_title(container, "hello there", "hi", LOG)
    assert container.stack.engine.generate.call_args.kwargs["reasoning_effort"] == "low"


def test_generate_sends_bounded_plain_text_request() -> None:
    container = _container()
    generate_session_title(container, "hello there", "hi", LOG)
    kwargs = container.stack.engine.generate.call_args.kwargs
    assert kwargs["max_tokens"] == 32
    assert kwargs["temperature"] == 0.2
    assert kwargs["response_format"] is None
    assert "2 to 6 words" in kwargs["system"]
    assert "<user_message>" in kwargs["prompt"]
    assert "<assistant_reply>" in kwargs["prompt"]


def test_generate_caps_each_input() -> None:
    container = _container()
    generate_session_title(container, "u" * (_MAX_INPUT_CHARS + 500), "a" * (_MAX_INPUT_CHARS + 500), LOG)
    prompt = container.stack.engine.generate.call_args.kwargs["prompt"]
    assert prompt.count("u") <= _MAX_INPUT_CHARS + 50  # tag/prose letters only
    assert "u" * (_MAX_INPUT_CHARS + 1) not in prompt
    assert "a" * (_MAX_INPUT_CHARS + 1) not in prompt
    assert "u" * _MAX_INPUT_CHARS in prompt
    assert "a" * _MAX_INPUT_CHARS in prompt


def test_generate_uses_retry_seam_with_background_source(monkeypatch: pytest.MonkeyPatch) -> None:
    container = _container()
    captured: dict[str, Any] = {}

    def _fake_retry(**kwargs: Any) -> str:
        captured["request_source"] = kwargs["request_source"]
        captured["initial_max_tokens"] = kwargs["initial_max_tokens"]
        return kwargs["operation"](SimpleNamespace(attempt=1, max_tokens=17))

    monkeypatch.setattr("sidecar.runtime.session_title.execute_with_provider_retry", _fake_retry)
    assert generate_session_title(container, "hello there", "hi", LOG) == "Fixing the login bug"
    assert captured == {
        "request_source": QUERY_SOURCE_BACKGROUND_CLASSIFIER,
        "initial_max_tokens": 32,
    }
    assert container.stack.engine.generate.call_args.kwargs["max_tokens"] == 17


def test_generate_returns_empty_on_provider_error() -> None:
    container = _container()
    container.stack.engine.generate.side_effect = RuntimeError("engine down")
    assert generate_session_title(container, "hello there", "hi", LOG) == ""


def test_generate_returns_empty_when_output_is_unusable() -> None:
    container = _container("I'm sorry, I can't do that")
    assert generate_session_title(container, "hello there", "hi", LOG) == ""


def test_generate_propagates_admission_error() -> None:
    container = _container()

    def _admission(_context: Any) -> Any:
        raise InferenceAdmissionRefused("nope")

    with pytest.raises(InferenceAdmissionRefused):
        generate_session_title(
            container, "hello there", "hi", LOG, inference_admission=_admission
        )


def test_generate_propagates_cancellation() -> None:
    container = _container()
    handle = TurnCancellationHandle(request_id="aux_title")

    def _generate(**_kwargs: Any) -> str:
        handle.cancel()
        raise RuntimeError("engine saw the cancel")

    container.stack.engine.generate.side_effect = _generate
    with pytest.raises(RuntimeError, match="engine saw the cancel"):
        generate_session_title(container, "hello there", "hi", LOG, cancel_handle=handle)
    assert handle.cancelled


# ---------------------------------------------------------------------------
# process_session_title_method
# ---------------------------------------------------------------------------


def test_process_returns_none_for_wrong_method() -> None:
    assert process_session_title_method("chat.send", 1, {}, True, MagicMock(), LOG) is None


def test_process_returns_error_when_not_initialized() -> None:
    result = process_session_title_method(
        SESSION_GENERATE_TITLE_METHOD,
        1,
        {"accept_version": API_VERSION},
        False,
        MagicMock(),
        LOG,
    )
    assert result is not None
    assert result.initialized is False
    assert result.response["error"]["code"] == -32002


def test_process_rejects_version_mismatch() -> None:
    result = process_session_title_method(
        SESSION_GENERATE_TITLE_METHOD, 1, {}, True, MagicMock(), LOG
    )
    assert result is not None
    assert "error" in result.response


def test_process_rejects_invalid_inference_context() -> None:
    result = process_session_title_method(
        SESSION_GENERATE_TITLE_METHOD,
        1,
        {"accept_version": API_VERSION, "inference_context": {"bogus": 1}},
        True,
        MagicMock(),
        LOG,
    )
    assert result is not None
    assert result.response["error"]["code"] == -32602


def test_process_notification_skips_generation(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []
    monkeypatch.setattr(
        dispatch_mod,
        "generate_session_title",
        lambda *_a, **_k: calls.append(object()) or "x",
    )
    result = process_session_title_method(
        SESSION_GENERATE_TITLE_METHOD,
        None,
        {"accept_version": API_VERSION, "user_message": "hi"},
        True,
        MagicMock(),
        LOG,
    )
    assert result is not None
    assert result.response is None
    assert calls == []


def test_process_returns_title_on_success() -> None:
    result = process_session_title_method(
        SESSION_GENERATE_TITLE_METHOD,
        7,
        {
            "accept_version": API_VERSION,
            "user_message": "login is broken",
            "assistant_message": "Try clearing the cookie",
        },
        True,
        _container("Fixing the login bug"),
        LOG,
    )
    assert result is not None
    assert result.response["result"]["title"] == "Fixing the login bug"


def test_process_empty_user_message_yields_empty_title() -> None:
    result = process_session_title_method(
        SESSION_GENERATE_TITLE_METHOD,
        7,
        {"accept_version": API_VERSION},
        True,
        _container(),
        LOG,
    )
    assert result is not None
    assert result.response["result"]["title"] == ""


def test_process_ignores_non_string_messages() -> None:
    container = _container()
    result = process_session_title_method(
        SESSION_GENERATE_TITLE_METHOD,
        7,
        {"accept_version": API_VERSION, "user_message": 5, "assistant_message": None},
        True,
        container,
        LOG,
    )
    assert result is not None
    assert result.response["result"]["title"] == ""
    container.stack.engine.generate.assert_not_called()


# ---------------------------------------------------------------------------
# worker family
# ---------------------------------------------------------------------------


def test_method_is_mapped_to_the_inference_worker_family() -> None:
    assert server_auxiliary_workers.AUXILIARY_FAMILY_BY_METHOD[SESSION_GENERATE_TITLE_METHOD] == (
        "inference"
    )
    assert SESSION_GENERATE_TITLE_METHOD in server_auxiliary_workers.AUXILIARY_WORKER_METHODS
