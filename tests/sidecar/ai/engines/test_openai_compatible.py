"""Tests for the OpenAI-compatible unmanaged HTTP engine (Slice B Task 5).

The engine is a thin subclass of :class:`VLLMEngine`, so most behavior
is validated by the vLLM engine tests.  These tests cover the pieces
that are specifically *different* from vLLM:

- default base URL (port 8033, loopback only),
- provider label propagated into ``GenerationUsage``,
- error messages scrubbed of any ``vLLM`` wording,
- engine type / reasoning wiring reports ``openai-compatible``.

The engine is protocol-scoped — "OpenAI-compatible" here refers only
to the HTTP schema (``/v1/chat/completions`` / ``/v1/models``), never
to any cloud provider integration.  Jenny's Slice B workflow is: a
user runs ``llama-server`` locally against a GGUF quant, and Jenny's
engine speaks to it over plain HTTP.
"""

from __future__ import annotations

import contextlib
from typing import Any

import httpx
import pytest

from sidecar.ai.context.token_budget import resolve_context_window_hint
from sidecar.ai.engines.openai_compatible import (
    _OPENAI_COMPAT_DEFAULT_BASE_URL,
    OpenAICompatibleEngine,
)
from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.engines.vllm_engine import VLLMEngine


@pytest.fixture(autouse=True)
def _release_engines(monkeypatch: pytest.MonkeyPatch):
    """Close every engine this module builds and drop its request binding.

    Each engine owns an httpx.Client with keep-alive sockets that only
    VLLMEngine.close() releases, and begin_request_context stores its binding in
    a module-level ContextVar that otherwise outlives the test that set it. The
    tests construct engines inline, so track them at __init__ rather than asking
    every test to remember its own teardown.
    """
    built: list[OpenAICompatibleEngine] = []
    original_init = OpenAICompatibleEngine.__init__

    def _tracking_init(self, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        built.append(self)

    monkeypatch.setattr(OpenAICompatibleEngine, "__init__", _tracking_init)
    yield
    for engine in built:
        with contextlib.suppress(Exception):
            engine.clear_request_context()
        with contextlib.suppress(Exception):
            engine.close()


def _make_models_response(*model_ids: str) -> httpx.Response:
    return httpx.Response(
        200,
        request=httpx.Request("GET", "http://127.0.0.1:8033/v1/models"),
        json={"data": [{"id": mid} for mid in model_ids]},
    )


def _patch_models_probe(monkeypatch: pytest.MonkeyPatch, responder: Any) -> None:
    """Route the inherited /models probe at a fake responder.

    ``VLLMEngine._query_models`` no longer builds a throwaway ``httpx.get``
    with an unbounded response body; it goes through the shared
    ``ProviderHttpService``. ``responder`` keeps the old ``(url, **kwargs)``
    calling shape so the existing doubles are reused verbatim.
    """

    def _get_json(
        self: ProviderHttpService,
        path: str,
        *,
        query: Any = None,
        cancel_handle: Any = None,
        timeout: Any = None,
    ) -> dict[str, Any]:
        response = responder(f"{self.base_url}{path}", timeout=timeout)
        response.raise_for_status()
        parsed = response.json()
        return parsed if isinstance(parsed, dict) else {}

    monkeypatch.setattr(ProviderHttpService, "get_json", _get_json)


class TestDefaults:
    def test_default_base_url_is_loopback(self) -> None:
        assert _OPENAI_COMPAT_DEFAULT_BASE_URL == "http://127.0.0.1:8033/v1"

    def test_engine_uses_loopback_default_when_host_missing(self) -> None:
        engine = OpenAICompatibleEngine()
        assert engine._base_url == _OPENAI_COMPAT_DEFAULT_BASE_URL

    def test_engine_resolves_custom_host(self) -> None:
        engine = OpenAICompatibleEngine(host="http://127.0.0.1:9000")
        assert engine._base_url == "http://127.0.0.1:9000/v1"

    def test_engine_keeps_existing_v1_suffix(self) -> None:
        engine = OpenAICompatibleEngine(host="http://127.0.0.1:9000/v1")
        assert engine._base_url == "http://127.0.0.1:9000/v1"

    def test_class_attributes_use_openai_compatible_labels(self) -> None:
        assert OpenAICompatibleEngine._PROVIDER_LABEL == "openai-compatible"
        assert OpenAICompatibleEngine._ENGINE_TYPE == "openai-compatible"
        assert "vLLM" not in OpenAICompatibleEngine._DISPLAY_NAME

    def test_subclasses_vllm_engine(self) -> None:
        # Share helpers, not duplicate them — verify inheritance is intact.
        assert issubclass(OpenAICompatibleEngine, VLLMEngine)

    @pytest.mark.parametrize(
        ("api_key", "expected_authorization"),
        [("k", "Bearer k"), (None, None)],
    )
    def test_api_key_headers_reach_models_and_chat_completions(
        self,
        monkeypatch: pytest.MonkeyPatch,
        api_key: str | None,
        expected_authorization: str | None,
    ) -> None:
        monkeypatch.setattr(
            "sidecar.ai.engines.vllm_engine.probe_server_modalities",
            lambda **_kwargs: None,
        )
        requests: list[tuple[str, str | None]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append((request.url.path, request.headers.get("authorization")))
            if request.url.path == "/v1/models":
                content = b'{"data":[{"id":"test-model"}]}'
            else:
                content = b'{"choices":[{"message":{"content":"ok"}}]}'
            return httpx.Response(
                200,
                request=request,
                headers={"content-type": "application/json"},
                stream=httpx.ByteStream(content),
            )

        engine = OpenAICompatibleEngine(api_key=api_key)
        client_headers = dict(engine._service._client.headers)  # noqa: SLF001
        engine._service._client.close()  # noqa: SLF001
        engine._service._client = httpx.Client(  # noqa: SLF001
            base_url=engine._base_url,
            headers=client_headers,
            transport=httpx.MockTransport(handler),
        )
        engine.load_model("test-model")
        engine.generate_with_tools(prompt="ping", tools=[])

        assert requests == [
            ("/v1/models", expected_authorization),
            ("/v1/chat/completions", expected_authorization),
        ]


class TestLoadModel:
    def test_load_model_succeeds_against_fake_server(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.6-35B-A3B"),
        )
        engine = OpenAICompatibleEngine()
        engine.load_model("Qwen/Qwen3.6-35B-A3B")
        assert engine.model_name == "Qwen/Qwen3.6-35B-A3B"

    def test_load_model_detects_qwen36_thinking(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Thinking detection is inherited from VLLMEngine but must survive
        # the subclass transition — exercise the same prefix path here.
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.6-35B-A3B"),
        )
        engine = OpenAICompatibleEngine()
        engine.load_model("Qwen/Qwen3.6-35B-A3B")
        assert engine.capabilities["thinking"] is True

    def test_load_model_matches_tail(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.6-35B-A3B"),
        )
        engine = OpenAICompatibleEngine()
        engine.load_model("Qwen3.6-35B-A3B")
        assert engine.model_name == "Qwen/Qwen3.6-35B-A3B"

    def test_load_model_unreachable_message_omits_vllm_wording(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        def _fail(*_a: Any, **_kw: Any) -> None:
            raise httpx.ConnectError("refused")

        _patch_models_probe(monkeypatch, _fail)
        engine = OpenAICompatibleEngine()
        with pytest.raises(Exception) as excinfo:
            engine.load_model("Qwen/Qwen3.6-35B-A3B")
        message = str(excinfo.value)
        assert "vLLM" not in message
        assert "is not reachable" in message
        assert "llama-server" in message

    def test_load_model_not_serving_message_omits_vllm_wording(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("meta-llama/Llama-3.1-8B"),
        )
        engine = OpenAICompatibleEngine()
        with pytest.raises(Exception) as excinfo:
            engine.load_model("Qwen/Qwen3.6-35B-A3B")
        message = str(excinfo.value)
        assert "vLLM" not in message
        assert "Qwen/Qwen3.6-35B-A3B" in message


def test_context_window_hint_uses_props_without_configured_or_native_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_models_probe(monkeypatch, lambda *_a, **_kw: _make_models_response("test-model"))
    monkeypatch.setattr(
        "sidecar.ai.engines.vllm_engine.probe_server_modalities",
        lambda **_kwargs: {"default_generation_settings": {"n_ctx": 32768}},
    )
    engine = OpenAICompatibleEngine()
    engine.load_model("test-model")

    assert resolve_context_window_hint(engine) == 32768


@pytest.mark.parametrize(
    ("props", "expected"),
    [({"default_generation_settings": {"n_ctx": 32768}}, 32768), (None, 131_072)],
)
def test_served_context_precedence_single_probe_and_unload(
    monkeypatch: pytest.MonkeyPatch, props: dict[str, Any] | None, expected: int,
) -> None:
    _patch_models_probe(monkeypatch, lambda *_a, **_kw: _make_models_response("test-model"))
    calls = 0

    def _probe(**_kwargs: Any) -> dict[str, Any] | None:
        nonlocal calls
        calls += 1
        return props

    monkeypatch.setattr("sidecar.ai.engines.vllm_engine.probe_server_modalities", _probe)
    engine = OpenAICompatibleEngine(configured_context_length=131_072)
    assert engine._served_context_length is None
    engine.load_model("test-model")

    assert calls == 1
    assert engine.get_configured_context_length() == expected
    engine.unload_model()
    assert engine._served_context_length is None
    assert engine.get_configured_context_length() == 131_072


def test_plain_vllm_has_no_configured_context_getter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_models_probe(monkeypatch, lambda *_a, **_kw: _make_models_response("test-model"))
    monkeypatch.setattr(
        "sidecar.ai.engines.vllm_engine.probe_server_modalities",
        lambda **_kwargs: {"default_generation_settings": {"n_ctx": 32768}},
    )
    engine = VLLMEngine()
    try:
        engine.load_model("test-model")
        assert engine._served_context_length == 32768
        assert not hasattr(engine, "get_configured_context_length")
        assert resolve_context_window_hint(engine) is None
    finally:
        engine.close()


def test_native_context_length_metadata() -> None:
    # llama-server's served window must win; n_ctx_train as native would clamp below it.
    models = [{"id": "test-model", "meta": {"n_ctx_train": 8192}}]
    assert VLLMEngine._extract_context_length(models, "test-model") is None


class TestGenerateWithTools:
    def test_qwen38_anchored_user_row_emits_vision_content_parts(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        model = "qwen3.8:27b-q3-k-s"
        _patch_models_probe(monkeypatch, lambda *_a, **_kw: _make_models_response(model))
        engine = OpenAICompatibleEngine()
        engine.load_model(model)
        image = VisionImage("image/png", 1, 1, 1, b"anchored")
        captured: dict[str, Any] = {}

        def _fake_post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured.update(path=path, payload=payload)
            return {"choices": [{"message": {"content": "ok"}}]}

        engine._service.post_json = _fake_post_json  # type: ignore[method-assign]
        engine.generate_with_tools(
            prompt="unused",
            tools=[],
            system="system",
            messages=[
                {"role": "user", "content": "inspect", "images": [image]},
                {"role": "assistant", "content": "prior answer"},
                {"role": "user", "content": "continue"},
            ],
            reasoning_effort="none",
        )

        assert captured["path"] == "/chat/completions"
        assert captured["payload"]["messages"] == [
            {"role": "system", "content": "system"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "inspect"},
                    {"type": "image_url", "image_url": {"url": image.as_data_uri()}},
                ],
            },
            {"role": "assistant", "content": "prior answer"},
            {"role": "user", "content": "continue"},
        ]
        assert captured["payload"]["chat_template_kwargs"] == {"enable_thinking": False}

    def test_forwards_none_to_disable_llama_server_reasoning(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        model = "qwen3.8:27b-q3-k-s"
        _patch_models_probe(monkeypatch, lambda *_a, **_kw: _make_models_response(model))
        engine = OpenAICompatibleEngine(
            configured_context_length=131_072,
            profile_max_output_tokens=32_768,
            profile_thinking_headroom=32_768,
        )
        engine.load_model(model)
        engine.begin_request_context(
            request_id="qwen38-none",
            app_profile_behavior={
                "instruct_sampler": {
                    "temperature": 0.7,
                    "top_p": 0.8,
                    "top_k": 20,
                    "min_p": 0.0,
                    "presence_penalty": 1.5,
                    "repeat_penalty": 1.0,
                }
            },
        )
        captured: dict[str, Any] = {}

        def _fake_post_json(_path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured.update(payload)
            return {"choices": [{"message": {"content": "ok"}}]}

        engine._service.post_json = _fake_post_json  # type: ignore[method-assign]
        engine.generate_with_tools(
            prompt="answer directly",
            tools=[],
            max_tokens=32_768,
            reasoning_effort="none",
        )

        assert captured["reasoning_effort"] == "none"
        assert captured["chat_template_kwargs"] == {
            "enable_thinking": False,
        }
        assert captured["max_tokens"] == 32_768
        assert engine.get_request_output_reservation("none") == 32_768
        assert {
            key: captured[key]
            for key in (
                "temperature",
                "top_p",
                "top_k",
                "min_p",
                "presence_penalty",
                "repeat_penalty",
            )
        } == {
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 20,
            "min_p": 0.0,
            "presence_penalty": 1.5,
            "repeat_penalty": 1.0,
        }

    @pytest.mark.parametrize(
        ("requested", "resolved"),
        [
            (None, "medium"),
            ("default", "medium"),
            ("minimal", "low"),
            ("low", "low"),
            ("medium", "medium"),
            ("high", "xhigh"),
            ("xhigh", "xhigh"),
            ("max", "xhigh"),
        ],
    )
    def test_maps_qwen38_effort_into_llama_chat_template_kwargs(
        self,
        monkeypatch: pytest.MonkeyPatch,
        requested: str | None,
        resolved: str,
    ) -> None:
        model = "hf.co/unsloth/Qwen3.8-27B-GGUF:Q3_K_S"
        _patch_models_probe(monkeypatch, lambda *_a, **_kw: _make_models_response(model))
        engine = OpenAICompatibleEngine(
            configured_context_length=131_072,
            profile_max_output_tokens=32_768,
            profile_thinking_headroom=32_768,
        )
        engine.load_model(model)
        engine.begin_request_context(
            request_id="qwen38-effort",
            app_profile_behavior={
                "thinking_sampler": {
                    "temperature": 1.0,
                    "top_p": 0.95,
                    "top_k": 20,
                    "min_p": 0.0,
                    "presence_penalty": 0.0,
                    "repeat_penalty": 1.0,
                },
            },
        )
        captured: dict[str, Any] = {}

        def _fake_post_json(_path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured.update(payload)
            return {"choices": [{"message": {"content": "ok"}}]}

        engine._service.post_json = _fake_post_json  # type: ignore[method-assign]
        engine.generate_with_tools(
            prompt="reason carefully",
            tools=[],
            max_tokens=32_768,
            reasoning_effort=requested,
        )

        assert captured["reasoning_effort"] == resolved
        assert captured["chat_template_kwargs"] == {
            "enable_thinking": True,
            "reasoning_effort": resolved,
        }
        assert captured["max_tokens"] == 65_536
        assert engine.get_request_output_reservation(requested) == 65_536
        assert {
            key: captured[key]
            for key in (
                "temperature",
                "top_p",
                "top_k",
                "min_p",
                "presence_penalty",
                "repeat_penalty",
            )
        } == {
            "temperature": 1.0,
            "top_p": 0.95,
            "top_k": 20,
            "min_p": 0.0,
            "presence_penalty": 0.0,
            "repeat_penalty": 1.0,
        }

    def test_non_qwen38_payload_keeps_generic_openai_compatible_shape(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        model = "Qwen/Qwen3.6-35B-A3B"
        _patch_models_probe(monkeypatch, lambda *_a, **_kw: _make_models_response(model))
        engine = OpenAICompatibleEngine()
        engine.load_model(model)
        captured: dict[str, Any] = {}

        def _fake_post_json(_path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured.update(payload)
            return {"choices": [{"message": {"content": "ok"}}]}

        engine._service.post_json = _fake_post_json  # type: ignore[method-assign]
        engine.generate_with_tools(prompt="ping", tools=[], reasoning_effort="none")

        assert captured["reasoning_effort"] == "none"
        assert "chat_template_kwargs" not in captured

    def test_usage_provider_label_is_openai_compatible(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.6-35B-A3B"),
        )
        engine = OpenAICompatibleEngine()
        engine.load_model("Qwen/Qwen3.6-35B-A3B")

        def _fake_post_json(_path: str, _payload: dict[str, Any]) -> dict[str, Any]:
            return {
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6},
            }

        engine._service.post_json = _fake_post_json  # type: ignore[method-assign]
        result = engine.generate_with_tools(
            prompt="ping",
            tools=[],
            max_tokens=16,
            temperature=0.6,
        )
        assert result.usage is not None
        assert result.usage.provider == "openai-compatible"
