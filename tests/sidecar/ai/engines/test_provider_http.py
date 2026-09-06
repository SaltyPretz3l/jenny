from __future__ import annotations

import httpx
import pytest

from sidecar.ai.engines.provider_http import ProviderHttpError, ProviderHttpService
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle


def _response(
    status_code: int,
    *,
    text: str,
    content_type: str,
) -> httpx.Response:
    request = httpx.Request("POST", "https://example.test/chat/completions")
    return httpx.Response(
        status_code,
        request=request,
        headers={"content-type": content_type},
        text=text,
    )


def test_post_json_rejects_non_json_success_body(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    try:
        monkeypatch.setattr(
            service,
            "_send_bounded_response",
            lambda *_args, **_kwargs: _response(
                200,
                text="plain text",
                content_type="text/plain",
            ),
        )

        with pytest.raises(ProviderHttpError, match="content-type") as exc_info:
            service.post_json("/chat/completions", {"model": "gpt-4.1"})

        assert exc_info.value.classification == "response_parse"
        assert exc_info.value.retryable is False
    finally:
        service.close()


def test_post_json_rejects_invalid_json_success_body(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    try:
        monkeypatch.setattr(
            service,
            "_send_bounded_response",
            lambda *_args, **_kwargs: _response(
                200,
                text="{not-json",
                content_type="application/json",
            ),
        )

        with pytest.raises(ProviderHttpError, match="invalid JSON") as exc_info:
            service.post_json("/chat/completions", {"model": "gpt-4.1"})

        assert exc_info.value.classification == "response_parse"
        assert exc_info.value.retryable is False
    finally:
        service.close()


def test_post_json_accepts_valid_json_object(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    try:
        monkeypatch.setattr(
            service,
            "_send_bounded_response",
            lambda *_args, **_kwargs: _response(
                200,
                text='{"choices":[{"message":{"content":"ok"}}]}',
                content_type="application/json",
            ),
        )

        body = service.post_json("/chat/completions", {"model": "gpt-4.1"})
        assert body["choices"][0]["message"]["content"] == "ok"
    finally:
        service.close()


def test_get_json_accepts_valid_json_object(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ProviderHttpService(
        provider="ollama",
        base_url="https://example.test",
        headers={},
    )
    try:
        monkeypatch.setattr(
            service,
            "_send_bounded_response",
            lambda *_args, **_kwargs: _response(
                200,
                text='{"models":[{"name":"qwen3.5:9b"}]}',
                content_type="application/json",
            ),
        )

        body = service.get_json("/api/tags")
        assert body["models"][0]["name"] == "qwen3.5:9b"
    finally:
        service.close()


def test_post_json_marks_overload_retryable_with_classification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    try:
        monkeypatch.setattr(
            service,
            "_send_bounded_response",
            lambda *_args, **_kwargs: _response(
                529,
                text='{"error":{"message":"overloaded","type":"overloaded_error"}}',
                content_type="application/json",
            ),
        )

        with pytest.raises(ProviderHttpError) as exc_info:
            service.post_json("/chat/completions", {"model": "gpt-4.1"})

        assert exc_info.value.status_code == 529
        assert exc_info.value.retryable is True
        assert exc_info.value.classification == "server_overload"
        assert exc_info.value.code == "CMP-CLOUD-1003"
    finally:
        service.close()


def test_post_json_classifies_invalid_model_as_non_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    try:
        monkeypatch.setattr(
            service,
            "_send_bounded_response",
            lambda *_args, **_kwargs: _response(
                400,
                text='{"error":{"message":"invalid model name: nope"}}',
                content_type="application/json",
            ),
        )

        with pytest.raises(ProviderHttpError) as exc_info:
            service.post_json("/chat/completions", {"model": "nope"})

        assert exc_info.value.classification == "invalid_model"
        assert exc_info.value.retryable is False
    finally:
        service.close()


def test_post_json_redacts_tokens_from_error_body(monkeypatch: pytest.MonkeyPatch) -> None:
    leaked_token = "sk-" + ("a" * 40)
    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    try:
        monkeypatch.setattr(
            service,
            "_send_bounded_response",
            lambda *_args, **_kwargs: _response(
                401,
                text=f'{{"error":{{"message":"bad token {leaked_token}"}}}}',
                content_type="application/json",
            ),
        )

        with pytest.raises(ProviderHttpError) as exc_info:
            service.post_json("/chat/completions", {"model": "gpt-4.1"})

        assert exc_info.value.classification == "invalid_api_key"
        assert leaked_token not in str(exc_info.value.body)
        assert "<redacted-token>" in str(exc_info.value.body)
    finally:
        service.close()


def test_post_json_redacts_opaque_secrets_under_sensitive_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    try:
        monkeypatch.setattr(
            service,
            "_send_bounded_response",
            lambda *_args, **_kwargs: _response(
                401,
                text=(
                    '{"api_key":"opaque-key-value","nested":'
                    '{"authorization":"Bearer opaque-auth","items":'
                    '[{"password":"opaque-password"},{"cookie":"opaque-cookie"}]}}'
                ),
                content_type="application/json",
            ),
        )

        with pytest.raises(ProviderHttpError) as exc_info:
            service.post_json("/chat/completions", {"model": "gpt-4.1"})

        rendered_body = str(exc_info.value.body)
        for secret in (
            "opaque-key-value",
            "opaque-auth",
            "opaque-password",
            "opaque-cookie",
        ):
            assert secret not in rendered_body
    finally:
        service.close()


def test_post_json_marks_timeout_transport_error_as_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    try:

        def _raise_timeout(*_args, **_kwargs):
            raise httpx.ReadTimeout("request timed out")

        monkeypatch.setattr(service, "_send_bounded_response", _raise_timeout)

        with pytest.raises(ProviderHttpError) as exc_info:
            service.post_json("/chat/completions", {"model": "gpt-4.1"})

        assert exc_info.value.classification == "api_timeout"
        assert exc_info.value.retryable is True
    finally:
        service.close()


def test_provider_transport_rejects_oversized_declared_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            headers={
                "content-type": "application/json",
                "content-length": str((16 * 1024 * 1024) + 1),
            },
            content=b"{}",
        )

    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    service._client.close()  # noqa: SLF001
    service._client = httpx.Client(  # noqa: SLF001
        base_url="https://example.test",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderHttpError) as exc_info:
            service.post_json("/chat/completions", {"model": "gpt-4.1"})

        assert exc_info.value.classification == "response_too_large"
        assert exc_info.value.retryable is False
    finally:
        service.close()


def test_provider_transport_closes_stream_and_propagates_terminal_cancellation() -> None:
    cancel_handle = TurnCancellationHandle(request_id="req-provider-cancel")

    class _CancellingStream(httpx.SyncByteStream):
        closed = False

        def __iter__(self):
            cancel_handle.cancel(reason="test_cancel")
            yield b'{"ok":true}'

        def close(self) -> None:
            self.closed = True

    stream = _CancellingStream()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            request=request,
            headers={"content-type": "application/json"},
            stream=stream,
        )

    service = ProviderHttpService(
        provider="openai",
        base_url="https://example.test",
        headers={},
    )
    service._client.close()  # noqa: SLF001
    service._client = httpx.Client(  # noqa: SLF001
        base_url="https://example.test",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(TerminalChatStateError):
            service.post_json(
                "/chat/completions",
                {"model": "gpt-4.1"},
                cancel_handle=cancel_handle,
            )
        assert stream.closed is True
    finally:
        service.close()
