"""Unit tests for sidecar.runtime.commit_message and request_dispatch_commit."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from sidecar.ai.routing.retry import QUERY_SOURCE_BACKGROUND_CLASSIFIER
from sidecar.protocol import API_VERSION
from sidecar.runtime import request_dispatch_commit as dispatch_mod
from sidecar.runtime.commit_message import (
    _MAX_DIFF_CHARS,
    _build_user_message,
    _strip_code_fences,
    generate_commit_message,
    summarize_diff_truncation,
)
from sidecar.runtime.request_dispatch_commit import process_commit_method


def _multi_file_diff(file_count: int, body_chars: int) -> str:
    """Build a unified-diff string with ``file_count`` distinct file sections."""
    sections = []
    for index in range(file_count):
        header = (
            f"diff --git a/f{index}.py b/f{index}.py\n"
            f"--- a/f{index}.py\n+++ b/f{index}.py\n"
        )
        body = "+" + ("a" * body_chars) + "\n"
        sections.append(header + body)
    return "".join(sections)

# ---------------------------------------------------------------------------
# _strip_code_fences
# ---------------------------------------------------------------------------


def test_strip_code_fences_removes_plain_fence() -> None:
    assert _strip_code_fences("```\nfeat: x\n```") == "feat: x"


def test_strip_code_fences_removes_language_fence() -> None:
    assert _strip_code_fences("```text\nfix: y\n```") == "fix: y"


def test_strip_code_fences_noop_on_clean_message() -> None:
    assert _strip_code_fences("chore: z") == "chore: z"


# ---------------------------------------------------------------------------
# _build_user_message
# ---------------------------------------------------------------------------


def test_build_user_message_wraps_the_diff() -> None:
    msg = _build_user_message("diff --git a/x b/x")
    assert "diff --git a/x b/x" in msg
    assert "<diff>" in msg


def test_build_user_message_truncates_oversized_diff() -> None:
    big = "x" * (_MAX_DIFF_CHARS + 5_000)
    msg = _build_user_message(big)
    assert "truncated for length" in msg
    # The clipped payload must be far smaller than the original.
    assert len(msg) < len(big)


def test_build_user_message_tells_model_how_many_files_unseen() -> None:
    # An over-cap multi-file diff must warn the model, in its prompt, how many
    # files it cannot see — so it does not over-claim coverage.
    diff = _multi_file_diff(10, 3_000)
    summary = summarize_diff_truncation(diff)
    msg = _build_user_message(diff)
    assert summary["omitted_files"] > 0
    assert "truncated" in msg.lower()
    assert "NOT shown" in msg
    assert f"{summary['omitted_files']} of {summary['total_files']}" in msg


def test_build_user_message_no_note_when_within_cap() -> None:
    msg = _build_user_message(_multi_file_diff(2, 50))
    assert "NOT shown" not in msg
    assert "truncated for length" not in msg


# ---------------------------------------------------------------------------
# summarize_diff_truncation
# ---------------------------------------------------------------------------


def test_summarize_diff_truncation_small_diff_not_truncated() -> None:
    summary = summarize_diff_truncation(_multi_file_diff(2, 50))
    assert summary["truncated"] is False
    assert summary["total_files"] == 2
    assert summary["shown_files"] == 2
    assert summary["omitted_files"] == 0


def test_summarize_diff_truncation_counts_omitted_files() -> None:
    summary = summarize_diff_truncation(_multi_file_diff(10, 3_000))
    assert summary["truncated"] is True
    assert summary["total_files"] == 10
    assert summary["omitted_files"] > 0
    # The accounting must be internally consistent.
    assert summary["shown_files"] + summary["omitted_files"] == summary["total_files"]


def test_summarize_diff_truncation_handles_blank_diff() -> None:
    summary = summarize_diff_truncation("")
    assert summary == {
        "truncated": False,
        "total_files": 0,
        "shown_files": 0,
        "omitted_files": 0,
    }


# ---------------------------------------------------------------------------
# generate_commit_message
# ---------------------------------------------------------------------------


def _make_brain_container(generate_return: str = "feat: add thing") -> MagicMock:
    container = MagicMock()
    container.stack.engine.generate.return_value = generate_return
    return container


def test_generate_returns_empty_on_blank_diff() -> None:
    container = _make_brain_container()
    assert generate_commit_message(container, "   ", logging.getLogger("test")) == ""
    container.stack.engine.generate.assert_not_called()


def test_generate_returns_empty_when_no_stack() -> None:
    container = MagicMock()
    container.stack = None
    assert generate_commit_message(container, "diff", logging.getLogger("test")) == ""


def test_generate_returns_message_on_success() -> None:
    container = _make_brain_container("feat(scm): add write-message button")
    out = generate_commit_message(container, "diff --git a/x b/x", logging.getLogger("test"))
    assert out == "feat(scm): add write-message button"


def test_generate_disables_thinking_for_background_call() -> None:
    """Background classifier calls must send an explicit think:false so a
    thinking-capable model cannot burn its 16k thinking headroom holding the
    single Ollama slot (2026-07-17 splash-suggestions RCA; same class)."""
    container = _make_brain_container("feat: x")
    generate_commit_message(container, "diff --git a/x b/x", logging.getLogger("test"))
    assert container.stack.engine.generate.call_args.kwargs["reasoning_effort"] == "low"


def test_generate_strips_code_fences_from_response() -> None:
    container = _make_brain_container("```\nfix: trim the fence\n```")
    out = generate_commit_message(container, "diff", logging.getLogger("test"))
    assert out == "fix: trim the fence"


def test_generate_returns_empty_on_engine_error() -> None:
    container = _make_brain_container()
    container.stack.engine.generate.side_effect = RuntimeError("engine down")
    assert generate_commit_message(container, "diff", logging.getLogger("test")) == ""


def test_generate_feeds_a_clipped_prompt_for_an_oversized_diff() -> None:
    container = _make_brain_container("chore: big change")
    big = "x" * (_MAX_DIFF_CHARS + 5_000)
    out = generate_commit_message(container, big, logging.getLogger("test"))
    assert out == "chore: big change"
    sent_prompt = container.stack.engine.generate.call_args.kwargs["prompt"]
    assert "truncated for length" in sent_prompt
    assert len(sent_prompt) < len(big), "oversized diff must be clipped before the model sees it"


def test_generate_uses_retry_seam(monkeypatch: pytest.MonkeyPatch) -> None:
    container = _make_brain_container("feat: x")
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
        "sidecar.runtime.commit_message.execute_with_provider_retry",
        _fake_retry,
    )

    out = generate_commit_message(container, "diff", logging.getLogger("test"))

    assert out == "feat: x"
    assert captured == {
        "request_source": QUERY_SOURCE_BACKGROUND_CLASSIFIER,
        "initial_max_tokens": 220,
    }
    assert container.stack.engine.generate.call_args.kwargs["max_tokens"] == 123
    # Plain-text generation: no JSON response_format constraint.
    assert container.stack.engine.generate.call_args.kwargs["response_format"] is None


# ---------------------------------------------------------------------------
# process_commit_method
# ---------------------------------------------------------------------------


def test_process_commit_method_returns_none_for_wrong_method() -> None:
    result = process_commit_method(
        "chat.send", 1, {}, True, MagicMock(), logging.getLogger("test")
    )
    assert result is None


def test_process_commit_method_returns_error_when_not_initialized() -> None:
    result = process_commit_method(
        "commit.generate_message",
        1,
        {"accept_version": API_VERSION},
        False,
        MagicMock(),
        logging.getLogger("test"),
    )
    assert result is not None
    assert result.initialized is False
    assert "error" in result.response


def test_process_commit_method_notification_skips_generation(monkeypatch) -> None:  # noqa: ANN001
    calls: list[object] = []
    monkeypatch.setattr(
        dispatch_mod,
        "generate_commit_message",
        lambda *_args, **_kwargs: calls.append(object()) or "generated",
    )

    result = process_commit_method(
        "commit.generate_message",
        None,
        {"accept_version": API_VERSION, "diff": "diff --git a/x b/x"},
        True,
        MagicMock(),
        logging.getLogger("test"),
    )

    assert result is not None
    assert result.response is None
    assert calls == []


def test_process_commit_method_returns_message_on_success() -> None:
    container = _make_brain_container("feat: dispatched")
    result = process_commit_method(
        "commit.generate_message",
        1,
        {"accept_version": API_VERSION, "diff": "diff --git a/x b/x"},
        True,
        container,
        logging.getLogger("test"),
    )
    assert result is not None
    assert result.response["result"]["message"] == "feat: dispatched"


def test_process_commit_method_empty_diff_yields_empty_message() -> None:
    container = _make_brain_container()
    result = process_commit_method(
        "commit.generate_message",
        1,
        {"accept_version": API_VERSION, "diff": ""},
        True,
        container,
        logging.getLogger("test"),
    )
    assert result.response["result"]["message"] == ""
    # No truncation keys for a within-cap (here empty) diff.
    assert "truncated" not in result.response["result"]


def test_process_commit_method_reports_diff_truncation() -> None:
    container = _make_brain_container("chore: big sweep")
    result = process_commit_method(
        "commit.generate_message",
        1,
        {"accept_version": API_VERSION, "diff": _multi_file_diff(12, 3_000)},
        True,
        container,
        logging.getLogger("test"),
    )
    payload = result.response["result"]
    assert payload["message"] == "chore: big sweep"
    assert payload["truncated"] is True
    assert payload["omitted_files"] > 0
    assert payload["total_files"] == 12


def test_process_commit_method_no_truncation_keys_for_small_diff() -> None:
    container = _make_brain_container("feat: small")
    result = process_commit_method(
        "commit.generate_message",
        1,
        {"accept_version": API_VERSION, "diff": "diff --git a/x b/x\n+one line"},
        True,
        container,
        logging.getLogger("test"),
    )
    assert result.response["result"]["message"] == "feat: small"
    assert "truncated" not in result.response["result"]
