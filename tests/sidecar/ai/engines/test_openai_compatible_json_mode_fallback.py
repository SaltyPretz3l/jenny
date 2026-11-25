"""JSON mode on a server that only serves text (NInfer 0.9.1).

NInfer answers every ``response_format`` other than ``{"type": "text"}`` with
HTTP 400 ``response_format_not_supported``. Memory reflection, suggestions and
the tool-call retry all ask for ``json_object``, so every one of them failed on
the owner's machine (16 of 16 reflections, 2026-10-16 to 10-19). The engine now
retries once without JSON mode and remembers the answer for the server.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.routing.provider_stream_normalizer import FINISH_REASON_PROVIDER_ERROR
from sidecar.ai.tools.models import StreamingEvent

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


# --- a server that validates JSON after the fact (structured_output_failed) ---------------------

_FAILED_BODY = {
    "error": {
        "type": "structured_output_failed",
        "code": "structured_output_failed",
        "message": "model did not return valid JSON: Expecting value: line 1 column 1 (char 0)",
    }
}
_FAILED_FRAME = f"data: {json.dumps(_FAILED_BODY)}\n\n"
_CONTENT_FRAME = 'data: {"choices": [{"delta": {"content": "{\\"ok\\": "}, "finish_reason": null}]}\n\n'
_STOP_FRAMES = 'data: {"choices": [{"delta": {}, "finish_reason": "stop"}]}\n\ndata: [DONE]\n\n'
_STREAM_FAILED = f": keep-alive\n\n{_FAILED_FRAME}data: [DONE]\n\n"
_STREAM_OK = (
    'data: {"choices": [{"delta": {"content": "{\\"ok\\": true}"}, "finish_reason": null}]}\n\n'
    + _STOP_FRAMES
)
_STREAM_FAILED_AFTER_CONTENT = f"{_CONTENT_FRAME}{_FAILED_FRAME}data: [DONE]\n\n"
_JSON = ResponseFormat(type="json_object")


def _streaming_engine(streams: list[str]) -> tuple[OpenAICompatibleEngine, list[dict[str, Any]]]:
    engine = OpenAICompatibleEngine()
    engine.model_name = "qwen3.8-27b-nvfp4"
    engine._ready = True
    queue = list(streams)
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "text/event-stream", "connection": "close"},
            stream=httpx.ByteStream(queue.pop(0).encode("utf-8")),
        )

    engine._service._client.close()
    engine._service._client = httpx.Client(
        base_url=engine._base_url, transport=httpx.MockTransport(handler)
    )
    return engine, sent


def _run_stream(
    engine: OpenAICompatibleEngine, method: str, *, response_format: Any = _JSON
) -> tuple[list[Any], Any]:
    args: dict[str, Any] = {"prompt": "title, as JSON", "response_format": response_format}
    if method == "stream_with_tools":
        args["tools"] = []
    generator = getattr(engine, method)(**args)
    items: list[Any] = []
    while True:
        try:
            items.append(next(generator))
        except StopIteration as stop:
            return items, stop.value


def _kinds(items: list[Any], kind: str) -> list[Any]:
    return [i for i in items if isinstance(i, StreamingEvent) and i.kind == kind]


@pytest.mark.parametrize("method", ["stream", "stream_with_tools"])
def test_a_streamed_structured_output_failure_is_retried_once_as_plain_text(method: str) -> None:
    engine, sent = _streaming_engine([_STREAM_FAILED, _STREAM_OK])

    items, _result = _run_stream(engine, method)

    assert [("response_format" in payload) for payload in sent] == [True, False]
    # Only the retry's terminal event reaches the consumer, and it is a clean stop.
    assert [event.finish_reason for event in _kinds(items, "done")] == ["stop"]
    assert "".join(e.text for e in _kinds(items, "content")) == '{"ok": true}'
    # One miss is a per-request failure, not a capability answer.
    assert getattr(engine, "_json_response_format_unsupported", False) is False
    assert engine._json_mode_failures == 1


@pytest.mark.parametrize("method", ["stream", "stream_with_tools"])
def test_a_failure_after_visible_content_is_not_retried(method: str) -> None:
    engine, sent = _streaming_engine([_STREAM_FAILED_AFTER_CONTENT])

    items, _result = _run_stream(engine, method)

    assert len(sent) == 1
    assert [event.finish_reason for event in _kinds(items, "done")] == [FINISH_REASON_PROVIDER_ERROR]


@pytest.mark.parametrize("method", ["stream", "stream_with_tools"])
def test_a_request_without_json_mode_never_retries_on_that_frame(method: str) -> None:
    engine, sent = _streaming_engine([_STREAM_FAILED])

    items, _result = _run_stream(engine, method, response_format=None)

    assert len(sent) == 1
    assert [event.finish_reason for event in _kinds(items, "done")] == [FINISH_REASON_PROVIDER_ERROR]
    assert engine._json_mode_failures == 0


@pytest.mark.parametrize("method", ["stream", "stream_with_tools"])
def test_an_object_error_frame_with_only_a_message_is_retried_too(method: str) -> None:
    # The shape both stream readers already treat as in-band: object "error", text in `message`.
    frame = {"object": "error", "message": "structured_output_failed: model did not return JSON"}
    engine, sent = _streaming_engine([f"data: {json.dumps(frame)}\n\ndata: [DONE]\n\n", _STREAM_OK])

    items, _result = _run_stream(engine, method)

    assert [("response_format" in payload) for payload in sent] == [True, False]
    assert [event.finish_reason for event in _kinds(items, "done")] == ["stop"]
    assert engine._json_mode_failures == 1


def test_a_new_binding_starts_the_consecutive_failure_count_again() -> None:
    engine, _sent = _streaming_engine([])
    engine._json_mode_failures = 2
    engine._query_models = lambda: [{"id": "qwen3.8-27b-nvfp4"}]  # type: ignore[method-assign]

    try:
        engine.load_model("qwen3.8-27b-nvfp4")
    except Exception:  # noqa: BLE001 - later probes are not under test; the reset comes first.
        pass

    assert engine._json_mode_failures == 0


def test_another_in_band_error_is_not_retried() -> None:
    other = 'data: {"error": {"type": "server_error", "message": "boom"}}\n\ndata: [DONE]\n\n'
    engine, sent = _streaming_engine([other])

    _run_stream(engine, "stream")

    assert len(sent) == 1 and engine._json_mode_failures == 0


def test_a_json_mode_success_resets_the_failure_count() -> None:
    # fail, fail, success, fail: never three in a row, so JSON mode stays on.
    engine, sent = _streaming_engine(
        [_STREAM_FAILED, _STREAM_OK, _STREAM_FAILED, _STREAM_OK, _STREAM_OK, _STREAM_FAILED, _STREAM_OK]
    )

    for _ in range(4):
        _run_stream(engine, "stream")

    assert getattr(engine, "_json_response_format_unsupported", False) is False
    assert engine._json_mode_failures == 1
    assert [("response_format" in payload) for payload in sent] == [
        True, False, True, False, True, True, False,
    ]


def test_three_consecutive_failures_turn_json_mode_off_for_the_next_request() -> None:
    engine, sent = _streaming_engine([_STREAM_FAILED, _STREAM_OK] * 3 + [_STREAM_OK])

    for _ in range(4):
        _run_stream(engine, "stream")

    assert engine._json_response_format_unsupported is True
    assert "response_format" not in sent[-1] and len(sent) == 7


def _post_sequence(
    monkeypatch: pytest.MonkeyPatch, outcomes: list[Any]
) -> tuple[OpenAICompatibleEngine, list[dict[str, Any]]]:
    engine = OpenAICompatibleEngine()
    engine.model_name = "qwen3.8-27b-nvfp4"
    engine._ready = True
    sent: list[dict[str, Any]] = []
    queue = list(outcomes)

    def post_json(_path: str, payload: dict[str, Any]) -> dict[str, Any]:
        sent.append(dict(payload))
        outcome = queue.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(engine._service, "post_json", post_json)
    return engine, sent


def test_a_502_structured_output_failure_is_retried_once_without_json_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, sent = _post_sequence(monkeypatch, [_rejection(502, _FAILED_BODY), _COMPLETION])

    assert engine.generate(prompt="x", response_format=_JSON) == '{"ok": true}'

    assert [("response_format" in payload) for payload in sent] == [True, False]
    assert engine._json_mode_failures == 1
    assert getattr(engine, "_json_response_format_unsupported", False) is False


def test_a_retried_502_that_fails_again_raises_the_second_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, sent = _post_sequence(
        monkeypatch, [_rejection(502, _FAILED_BODY), _rejection(503, "busy")]
    )

    with pytest.raises(ProviderHttpError) as excinfo:
        engine.generate(prompt="x", response_format=_JSON)

    assert excinfo.value.status_code == 503 and len(sent) == 2


def test_a_502_with_another_body_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    engine, sent = _post_sequence(monkeypatch, [_rejection(502, "bad gateway")])

    with pytest.raises(ProviderHttpError):
        engine.generate(prompt="x", response_format=_JSON)

    assert len(sent) == 1 and engine._json_mode_failures == 0


def test_the_failure_body_on_another_status_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    engine, sent = _post_sequence(monkeypatch, [_rejection(503, _FAILED_BODY)])

    with pytest.raises(ProviderHttpError):
        engine.generate(prompt="x", response_format=_JSON)

    assert len(sent) == 1 and engine._json_mode_failures == 0


def test_nonstream_502s_latch_on_the_third_consecutive_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failure = _rejection(502, _FAILED_BODY)
    engine, sent = _post_sequence(
        monkeypatch, [failure, _COMPLETION, failure, _COMPLETION, failure, _COMPLETION, _COMPLETION]
    )

    for _ in range(4):
        engine.generate(prompt="x", response_format=_JSON)

    assert engine._json_response_format_unsupported is True
    assert [("response_format" in payload) for payload in sent] == [
        True, False, True, False, True, False, False,
    ]


def test_the_ninfer_400_still_turns_json_mode_off_on_the_first_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, sent = _post_sequence(monkeypatch, [_rejection(), _COMPLETION])

    engine.generate(prompt="x", response_format=_JSON)

    assert engine._json_response_format_unsupported is True
    assert engine._json_mode_failures == 0
    assert [("response_format" in payload) for payload in sent] == [True, False]
