"""JSON mode on a server that only serves text (NInfer 0.9.1).

NInfer answers every ``response_format`` other than ``{"type": "text"}`` with
HTTP 400 ``response_format_not_supported``. Memory reflection, suggestions and
the tool-call retry all ask for ``json_object``, so every one of them failed on
the owner's machine (16 of 16 reflections, 2026-10-16 to 10-19). The engine now
retries once without JSON mode and remembers the answer for the server.
"""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.engines.response_format import ResponseFormat

_NINFER_BODY = {
    "error": {
        "message": (
            "this response_format requires constrained output, which NInfer cannot "
            'guarantee; only {"type":"text"} is available'
        ),
        "type": "invalid_request_error",
        "code": "response_format_not_supported",
    }
}
_COMPLETION = {"choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}]}


def _rejection(status_code: int = 400, body: Any = _NINFER_BODY) -> ProviderHttpError:
    return ProviderHttpError(
        provider="openai-compatible",
        status_code=status_code,
        code="CMP-ENGINE-HTTP",
        message=f"openai-compatible request failed with status {status_code}",
        retryable=False,
        classification="client_error",
        body=body,
    )


def _engine(monkeypatch: pytest.MonkeyPatch, *, reject: ProviderHttpError | None) -> tuple[
    OpenAICompatibleEngine, list[dict[str, Any]]
]:
    engine = OpenAICompatibleEngine()
    engine.model_name = "qwen3.8-27b-nvfp4"
    engine._ready = True
    sent: list[dict[str, Any]] = []

    def post_json(_path: str, payload: dict[str, Any]) -> dict[str, Any]:
        sent.append(dict(payload))
        if reject is not None and "response_format" in payload:
            raise reject
        return _COMPLETION

    monkeypatch.setattr(engine._service, "post_json", post_json)
    return engine, sent


def test_a_json_mode_rejection_is_retried_once_as_text_and_remembered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, sent = _engine(monkeypatch, reject=_rejection())

    content = engine.generate(prompt="reflect", response_format=ResponseFormat(type="json_object"))

    assert content == '{"ok": true}'
    assert [("response_format" in payload) for payload in sent] == [True, False]
    assert engine._json_response_format_unsupported is True

    # The next JSON request skips the doomed attempt entirely.
    engine.generate(prompt="again", response_format=ResponseFormat(type="json_object"))
    assert len(sent) == 3
    assert "response_format" not in sent[-1]


def test_a_retry_that_fails_too_propagates_the_second_error(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = OpenAICompatibleEngine()
    engine.model_name = "qwen3.8-27b-nvfp4"
    engine._ready = True
    calls: list[dict[str, Any]] = []

    def post_json(_path: str, payload: dict[str, Any]) -> dict[str, Any]:
        calls.append(dict(payload))
        raise _rejection() if "response_format" in payload else _rejection(status_code=503, body="busy")

    monkeypatch.setattr(engine._service, "post_json", post_json)
    with pytest.raises(ProviderHttpError) as excinfo:
        engine.generate(prompt="x", response_format=ResponseFormat(type="json_object"))

    assert excinfo.value.status_code == 503
    assert len(calls) == 2 and engine._json_response_format_unsupported is True


def test_the_cancellable_path_retries_through_the_interruptible_post(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace

    engine = OpenAICompatibleEngine()
    engine.model_name = "qwen3.8-27b-nvfp4"
    engine._ready = True
    sent: list[dict[str, Any]] = []

    def post_json_interruptible(_path: str, payload: dict[str, Any], *, cancel_handle: Any) -> dict[str, Any]:
        sent.append(dict(payload))
        if "response_format" in payload:
            raise _rejection()
        return _COMPLETION

    monkeypatch.setattr(engine._service, "post_json_interruptible", post_json_interruptible)
    monkeypatch.setattr(engine._service, "post_json", lambda *_a, **_k: pytest.fail("non-cancellable post used"))
    content = engine.generate(
        prompt="reflect",
        response_format=ResponseFormat(type="json_object"),
        cancel_handle=SimpleNamespace(cancelled=False),
    )
    assert content == '{"ok": true}'
    assert [("response_format" in payload) for payload in sent] == [True, False]


@pytest.mark.parametrize(
    "body",
    [
        {"error": {"message": "model not found", "code": "model_not_found"}},
        # A validation echo that merely names the field is not a capability answer.
        {"detail": [{"loc": ["body", "response_format", "json_schema"], "msg": "field required"}]},
    ],
)
def test_other_bad_requests_are_not_retried(monkeypatch: pytest.MonkeyPatch, body: Any) -> None:
    other = _rejection(body=body)
    engine, sent = _engine(monkeypatch, reject=other)

    with pytest.raises(ProviderHttpError):
        engine.generate(prompt="x", response_format=ResponseFormat(type="json_object"))

    assert len(sent) == 1
    assert getattr(engine, "_json_response_format_unsupported", False) is False


def test_a_text_request_never_consults_the_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    engine, sent = _engine(monkeypatch, reject=_rejection())

    assert engine.generate(prompt="plain") == '{"ok": true}'
    assert sent == [sent[0]] and "response_format" not in sent[0]
