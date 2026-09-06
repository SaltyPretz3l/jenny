from __future__ import annotations

import base64
import json
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest

from sidecar.ai.engines.base import ModelModality
from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.engines.vllm_engine import VLLMEngine, _model_matches
from sidecar.ai.exceptions import UnsupportedModalityError
from sidecar.ai.routing.generation_runtime_stream import _StreamFailure, _StreamReader
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
)
from sidecar.ai.tools.models import StreamingEvent
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore
from sidecar.runtime.vllm_engine_support import _build_messages, _build_tools_payload

_PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42Y"
    "AAAAASUVORK5CYII="
)
_PNG_BYTES = base64.b64decode(_PNG_BASE64)


def _make_models_response(*model_ids: str) -> httpx.Response:
    """Build a fake /v1/models response."""
    return httpx.Response(
        200,
        request=httpx.Request("GET", "http://localhost:8000/v1/models"),
        json={"data": [{"id": mid} for mid in model_ids]},
    )


def _patch_models_probe(monkeypatch: pytest.MonkeyPatch, responder: Any) -> None:
    """Route ``VLLMEngine._query_models``' /models probe at a fake responder.

    The probe used to be a bare ``httpx.get``: a throwaway client per call with
    an UNBOUNDED response body. It now goes through the shared
    ``ProviderHttpService`` (pooled client, bounded body, per-call timeout
    override), so tests patch the service method rather than the httpx module
    function. ``responder`` keeps the old ``(url, **kwargs)`` calling shape so
    existing doubles -- including the ones that assert ``timeout`` -- are reused
    verbatim.
    """

    def _get_json(
        self: ProviderHttpService,
        path: str,
        *,
        query: Any = None,
        cancel_handle: Any = None,
        timeout: Any = None,
    ) -> dict[str, Any]:
        response = responder(
            f"{self.base_url.rstrip('/')}/{path.lstrip('/')}",
            timeout=timeout,
            headers=dict(self._client.headers),  # noqa: SLF001
        )
        response.raise_for_status()
        parsed = response.json()
        return parsed if isinstance(parsed, dict) else {}

    monkeypatch.setattr(ProviderHttpService, "get_json", _get_json)


class TestBuildMessages:
    def test_user_images_emit_ordered_openai_content_parts(self) -> None:
        first = VisionImage("image/png", 1, 1, 1, b"first")
        second = VisionImage("image/jpeg", 1, 1, 1, b"second")

        result = _build_messages(
            prompt="",
            system="",
            messages=[
                {"role": "user", "content": "compare", "images": [first, second]},
            ],
        )

        assert result == [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "compare"},
                    {"type": "image_url", "image_url": {"url": first.as_data_uri()}},
                    {"type": "image_url", "image_url": {"url": second.as_data_uri()}},
                ],
            }
        ]

    def test_image_only_user_row_is_kept(self) -> None:
        image = VisionImage("image/png", 1, 1, 1, b"image-only")

        result = _build_messages(
            prompt="fallback must stay unused",
            system="",
            messages=[{"role": "user", "content": "", "images": [image]}],
        )

        assert result == [
            {
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": image.as_data_uri()}}],
            }
        ]

    def test_non_user_rows_ignore_stray_images(self) -> None:
        image = VisionImage("image/png", 1, 1, 1, b"stray")

        result = _build_messages(
            prompt="",
            system="",
            messages=[
                {"role": "assistant", "content": "answer", "images": [image]},
                {
                    "role": "tool",
                    "tool_call_id": "call-1",
                    "content": "result",
                    "images": [image],
                },
            ],
        )

        assert result == [
            {"role": "assistant", "content": "answer"},
            {"role": "tool", "tool_call_id": "call-1", "content": "result"},
        ]

    def test_rows_without_images_keep_plain_string_content(self) -> None:
        result = _build_messages(
            prompt="",
            system="",
            messages=[{"role": "user", "content": "plain"}],
        )

        assert result == [{"role": "user", "content": "plain"}]

    def test_system_merge_preserves_user_content_parts(self) -> None:
        image = VisionImage("image/png", 1, 1, 1, b"anchored")

        result = _build_messages(
            prompt="",
            system="",
            messages=[
                {"role": "system", "content": "identity"},
                {"role": "system", "content": "policy"},
                {"role": "user", "content": "inspect", "images": [image]},
            ],
        )

        assert result[0] == {"role": "system", "content": "identity\n\npolicy"}
        assert result[1]["content"] == [
            {"type": "text", "text": "inspect"},
            {"type": "image_url", "image_url": {"url": image.as_data_uri()}},
        ]

    def test_collapses_consecutive_system_messages(self) -> None:
        # vLLM / llama-server apply the model's chat template and build a
        # tool-call parser from it; quirky GGUF templates that only render a
        # single leading system message must not see Jenny's three overlays as
        # separate messages. They are merged exactly like the Ollama path.
        result = _build_messages(
            prompt="",
            system="",
            messages=[
                {"role": "system", "content": "identity"},
                {"role": "system", "content": "personality"},
                {"role": "system", "content": "skills"},
                {"role": "user", "content": "read README"},
            ],
        )
        assert [m["role"] for m in result] == ["system", "user"]
        assert result[0]["content"] == "identity\n\npersonality\n\nskills"
        assert result[1]["content"] == "read README"

    def test_injected_system_prompt_merges_with_leading_system(self) -> None:
        result = _build_messages(
            prompt="",
            system="base",
            messages=[
                {"role": "user", "content": "hi"},
            ],
        )
        # `system` is injected only when the messages carry no system role, so
        # this stays a single system message; the merge is a safe no-op.
        assert [m["role"] for m in result] == ["system", "user"]
        assert result[0]["content"] == "base"

    def test_injected_system_prompt_prepends_ahead_of_other_system_rows(self) -> None:
        # Overlay system rows must not suppress the router-supplied primary
        # prompt; only an exact duplicate does.
        result = _build_messages(
            prompt="",
            system="PRIMARY PROMPT",
            messages=[
                {"role": "system", "content": "runtime overlay"},
                {"role": "user", "content": "and phase four?"},
            ],
        )
        assert [m["role"] for m in result] == ["system", "user"]
        assert result[0]["content"].startswith("PRIMARY PROMPT")
        assert "runtime overlay" in result[0]["content"]

    def test_compaction_summary_is_demoted_out_of_the_trusted_block(self) -> None:
        """Same trust boundary as the Ollama builder — see its twin test.

        The summary is model-generated text derived from a conversation that
        includes tool-result rows, so merging it into the leading system run
        laundered untrusted content into the trusted tier for the rest of the
        session. It is demoted in place instead.
        """
        result = _build_messages(
            prompt="",
            system="PRIMARY PROMPT",
            messages=[
                {"role": "system", "content": "## Compacted Conversation Summary\nstuff"},
                {"role": "user", "content": "and phase four?"},
            ],
        )

        assert [m["role"] for m in result] == ["system", "user", "user"]
        assert result[0]["content"] == "PRIMARY PROMPT"
        assert "Compacted Conversation Summary" not in result[0]["content"]
        assert result[1]["content"] == "## Compacted Conversation Summary\nstuff"

    def test_injected_system_prompt_not_duplicated_when_already_in_history(self) -> None:
        result = _build_messages(
            prompt="",
            system="PRIMARY PROMPT",
            messages=[
                {"role": "system", "content": "PRIMARY PROMPT"},
                {"role": "user", "content": "hi"},
            ],
        )
        assert [m["role"] for m in result] == ["system", "user"]
        assert result[0]["content"] == "PRIMARY PROMPT"

    def test_non_leading_system_message_is_demoted(self) -> None:
        # A system message stranded after conversation history (e.g. the tool
        # loop's tool-failure nudge) is demoted to `user` so system-first GGUF
        # templates -- served via vLLM / the OpenAI-compatible subclass -- do
        # not reject the request ("System message must be at the beginning").
        result = _build_messages(
            prompt="",
            system="",
            messages=[
                {"role": "system", "content": "a"},
                {"role": "user", "content": "q"},
                {"role": "system", "content": "b"},
            ],
        )
        assert [m["role"] for m in result] == ["system", "user", "user"]
        assert result[-1]["content"] == "b"


class TestModelMatches:
    def test_exact_match(self) -> None:
        assert _model_matches("Qwen/Qwen3.5-9B", "Qwen/Qwen3.5-9B") is True

    def test_case_insensitive(self) -> None:
        assert _model_matches("qwen/qwen3.5-9b", "Qwen/Qwen3.5-9B") is True

    def test_tail_match(self) -> None:
        assert _model_matches("Qwen3.5-9B", "Qwen/Qwen3.5-9B") is True

    def test_no_match(self) -> None:
        assert _model_matches("Llama-3.1-8B", "Qwen/Qwen3.5-9B") is False


class TestLoadModel:
    def test_load_model_uses_short_model_probe_timeout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}

        def _fake_get(*_args: Any, **kwargs: Any) -> httpx.Response:
            captured.setdefault("timeout", kwargs.get("timeout"))
            return _make_models_response("Qwen/Qwen3.5-9B")

        _patch_models_probe(monkeypatch, _fake_get)
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen3.5-9B")

        assert captured["timeout"] == 3.0

    def test_load_model_verifies_server_and_model(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.5-9B"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen3.5-9B")
        assert engine.model_name == "Qwen/Qwen3.5-9B"

    def test_load_model_raises_when_unreachable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _fail(*_a: Any, **_kw: Any) -> None:
            raise httpx.ConnectError("refused")

        _patch_models_probe(monkeypatch, _fail)
        engine = VLLMEngine()
        with pytest.raises(Exception, match="not reachable"):
            engine.load_model("Qwen/Qwen3.5-9B")

    def test_load_model_raises_when_model_not_served(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("meta-llama/Llama-3.1-8B"),
        )
        engine = VLLMEngine()
        with pytest.raises(Exception, match="not serving"):
            engine.load_model("Qwen/Qwen3.5-9B")

    def test_load_model_matches_tail(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.5-9B"),
        )
        engine = VLLMEngine()
        engine.load_model("Qwen3.5-9B")
        assert engine.model_name == "Qwen/Qwen3.5-9B"

    def test_load_model_marks_vision_capability(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen2.5-VL-7B-Instruct"),
        )
        engine = VLLMEngine()
        engine.load_model("Qwen/Qwen2.5-VL-7B-Instruct")

        assert engine.capabilities["vision"] is True
        assert engine.supported_modalities == {ModelModality.TEXT, ModelModality.VISION}
        assert engine._local_runtime_capability_sources["vision"] == "model_name"  # noqa: SLF001

    def test_props_true_overrides_non_vision_model_name_and_carries_auth(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: dict[str, Any] = {}

        def _respond(url: str, **kwargs: Any) -> httpx.Response:
            if url.endswith("/props"):
                seen.update(url=url, headers=kwargs["headers"])
                return httpx.Response(
                    200,
                    request=httpx.Request("GET", url),
                    json={"modalities": {"vision": True}},
                )
            return _make_models_response("meta-llama/Llama-3.1-8B")

        _patch_models_probe(monkeypatch, _respond)
        engine = VLLMEngine(
            host="http://localhost:8000/v1",
            headers={"Authorization": "Bearer secret"},
        )
        engine.load_model("meta-llama/Llama-3.1-8B")

        assert engine.capabilities["vision"] is True
        assert engine._local_runtime_capability_sources["vision"] == "server_props"  # noqa: SLF001
        assert httpx.URL(seen["url"]).path == "/props"
        assert seen["headers"]["authorization"] == "Bearer secret"

    def test_props_false_overrides_vision_model_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _respond(url: str, **_kwargs: Any) -> httpx.Response:
            if url.endswith("/props"):
                return httpx.Response(
                    200,
                    request=httpx.Request("GET", url),
                    json={"modalities": {"vision": False}},
                )
            return _make_models_response("Qwen/Qwen2.5-VL-7B-Instruct")

        _patch_models_probe(monkeypatch, _respond)
        engine = VLLMEngine()
        engine.load_model("Qwen/Qwen2.5-VL-7B-Instruct")

        assert engine.capabilities["vision"] is False
        assert engine.supported_modalities == {ModelModality.TEXT}
        assert engine._local_runtime_capability_sources["vision"] == "server_props"  # noqa: SLF001

    def test_props_404_falls_back_to_negative_name_heuristic(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _respond(url: str, **_kwargs: Any) -> httpx.Response:
            if url.endswith("/props"):
                return httpx.Response(404, request=httpx.Request("GET", url))
            return _make_models_response("meta-llama/Llama-3.1-8B")

        _patch_models_probe(monkeypatch, _respond)
        engine = VLLMEngine()
        engine.load_model("meta-llama/Llama-3.1-8B")

        assert engine.capabilities["vision"] is False
        assert engine._local_runtime_capability_sources["vision"] == "model_name"  # noqa: SLF001

    def test_props_timeout_does_not_fail_model_load(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _respond(url: str, **_kwargs: Any) -> httpx.Response:
            if url.endswith("/props"):
                raise httpx.ReadTimeout("timed out")
            return _make_models_response("Qwen/Qwen2.5-VL-7B-Instruct")

        _patch_models_probe(monkeypatch, _respond)
        engine = VLLMEngine()
        engine.load_model("Qwen/Qwen2.5-VL-7B-Instruct")

        assert engine.capabilities["vision"] is True
        assert engine._local_runtime_capability_sources["vision"] == "model_name"  # noqa: SLF001


class TestGenerateWithTools:
    def test_build_tools_payload_skips_deferred_placeholder_tools(self) -> None:
        payload = _build_tools_payload(
            [
                {"name": "mcp__git__commit", "description": "Commit", "defer_loading": True},
                {
                    "name": "tool_search",
                    "description": "Search tools",
                    "parameters": {"type": "object", "properties": {}},
                },
            ]
        )

        names = [item["function"]["name"] for item in payload]
        assert names == ["tool_search"]

    def test_sends_openai_format_payload(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.5-9B"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen3.5-9B")

        captured: dict[str, Any] = {}

        def _fake_post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured["path"] = path
            captured["payload"] = payload
            return {
                "choices": [{"message": {"content": "hello"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(prompt="hi", tools=[], system="sys")
        engine.unload_model()

        assert result.content == "hello"
        assert captured["path"] == "/chat/completions"
        assert captured["payload"]["model"] == "Qwen/Qwen3.5-9B"
        assert captured["payload"]["messages"] == [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
        ]

    def test_request_context_applies_gemma_sampler_defaults(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("google/gemma-4-e4b-it"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("google/gemma-4-e4b-it")
        engine.begin_request_context(
            request_id="req_gemma_profile",
            app_profile_behavior={
                "family": "gemma4",
                "variant": "e4b",
                "temperature": 1.0,
                "top_k": 40,
                "reasoning_parser_start": "<|channel>thought",
                "reasoning_parser_end": "<channel|>",
            },
        )

        captured: dict[str, Any] = {}

        def _fake_post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured["path"] = path
            captured["payload"] = payload
            return {"choices": [{"message": {"content": "hello"}}]}

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(prompt="hi", tools=[], temperature=0.2)

        assert result.content == "hello"
        assert captured["payload"]["temperature"] == 1.0
        assert captured["payload"]["top_k"] == 40
        engine.clear_request_context(request_id="req_gemma_profile")

    def test_request_context_applies_qwen36_sampler_preset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.6-35B-A3B"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen3.6-35B-A3B")
        engine.begin_request_context(
            request_id="req_qwen36_profile",
            app_profile_behavior={
                "family": "qwen36",
                "variant": "35b-a3b",
                "temperature": 0.6,
                "top_k": 20,
                "top_p": 0.95,
                "min_p": 0.0,
                "presence_penalty": 0.0,
                "repeat_penalty": 1.0,
            },
        )

        captured: dict[str, Any] = {}

        def _fake_post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured["path"] = path
            captured["payload"] = payload
            return {"choices": [{"message": {"content": "ok"}}]}

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(prompt="hi", tools=[], temperature=0.2)
        engine.clear_request_context(request_id="req_qwen36_profile")

        assert result.content == "ok"
        payload = captured["payload"]
        assert payload["temperature"] == 0.6
        assert payload["top_k"] == 20
        assert payload["top_p"] == 0.95
        assert payload["min_p"] == 0.0
        assert payload["presence_penalty"] == 0.0
        assert payload["repetition_penalty"] == 1.0

    def test_parses_tool_calls(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.5-9B"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen3.5-9B")

        def _fake_post_json(_path: str, _payload: dict[str, Any]) -> dict[str, Any]:
            return {
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "function": {
                                        "name": "read_file",
                                        "arguments": json.dumps({"path": "/tmp/test.py"}),
                                    },
                                }
                            ],
                        },
                    }
                ],
            }

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(
            prompt="read test.py",
            tools=[{"name": "read_file", "description": "Read a file", "parameters": {}}],
        )
        engine.unload_model()

        assert result.finish_reason == "tool_calls"
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].tool_id == "read_file"
        assert result.tool_calls[0].arguments == {"path": "/tmp/test.py"}

    def test_preserves_tool_context_in_openai_compatible_payload(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.5-9B"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen3.5-9B")

        captured: dict[str, Any] = {}

        def _fake_post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured["path"] = path
            captured["payload"] = payload
            return {"choices": [{"message": {"content": "ready"}}]}

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(
            prompt="fallback",
            tools=[],
            system="You are concise.",
            messages=[
                {
                    "role": "assistant",
                    "content": "Searching for comparisons.",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "name": "web_search",
                            "arguments": {"q": "rtx 5070 ti vs 4070 ti"},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "name": "web_search",
                    "content": "search snippets here",
                },
            ],
        )
        engine.unload_model()

        assert result.content == "ready"
        assert captured["path"] == "/chat/completions"
        assert captured["payload"]["messages"] == [
            {"role": "system", "content": "You are concise."},
            {
                "role": "assistant",
                "content": "Searching for comparisons.",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "web_search",
                            "arguments": '{"q": "rtx 5070 ti vs 4070 ti"}',
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "search snippets here",
            },
        ]

    def test_usage_reports_vllm_provider(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.5-9B"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen3.5-9B")

        def _fake_post_json(_path: str, _payload: dict[str, Any]) -> dict[str, Any]:
            return {
                "choices": [{"message": {"content": "ok"}}],
                "usage": {
                    "prompt_tokens": 7,
                    "completion_tokens": 3,
                    "total_tokens": 10,
                    "generation_duration_ms": 250,
                    "prompt_eval_duration_ms": 40,
                    "load_duration_ms": 15,
                    "time_to_first_token_ms": 80,
                },
            }

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(prompt="test", tools=[])
        engine.unload_model()

        assert result.usage is not None
        assert result.usage.provider == "vllm"
        assert result.usage.model == "Qwen/Qwen3.5-9B"
        assert result.usage.generation_tokens == 3
        assert result.usage.generation_duration_ms == pytest.approx(250)
        assert result.usage.prompt_eval_duration_ms == pytest.approx(40)
        assert result.usage.load_duration_ms == pytest.approx(15)
        assert result.usage.time_to_first_token_ms == pytest.approx(80)
        assert "generation_duration_ms" not in result.usage.raw_usage
        assert "prompt_eval_duration_ms" not in result.usage.raw_usage
        assert "load_duration_ms" not in result.usage.raw_usage
        assert "time_to_first_token_ms" not in result.usage.raw_usage

    def test_records_turn_diagnostics_for_provider_request(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen3.5-9B"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen3.5-9B")
        store = TurnDiagnosticsStore()
        store.begin_turn(request_id="req_vllm_diag", session_id="session-1", mode="assist")
        engine.set_turn_diagnostics_store(store)
        engine.begin_request_context(
            request_id="req_vllm_diag",
            trace_id="trace-vllm-diag",
            diagnostics_store=store,
        )

        def _fake_post_json(_path: str, _payload: dict[str, Any]) -> dict[str, Any]:
            return {
                "choices": [{"message": {"content": "hello"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(
            prompt="hi",
            tools=[{"name": "read_file", "description": "Read", "parameters": {}}],
            system="sys",
        )

        snapshot = store.snapshot()
        assert result.content == "hello"
        assert snapshot is not None
        assert snapshot["provider_message_count"] == 2
        assert snapshot["provider_tool_count"] == 1
        assert snapshot["provider_tool_capable"] is True
        assert snapshot["provider_tool_payload_bytes"] > 0
        assert snapshot["provider_sampler"]["temperature"] == 0.7
        assert snapshot["provider_sampler_present_keys"] == ["temperature"]
        assert "model" not in snapshot["provider_sampler"]
        assert "messages" not in snapshot["provider_sampler"]
        assert snapshot["visible_output_chars"] == 5
        assert snapshot["time_to_first_chunk_ms"] >= 0
        assert snapshot["time_to_first_visible_token_ms"] >= 0
        engine.clear_request_context(request_id="req_vllm_diag")


class TestGenerateWithVision:
    def test_generate_with_vision_payload(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen2.5-VL-7B-Instruct"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen2.5-VL-7B-Instruct")

        captured: dict[str, Any] = {}

        def _fake_post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured["path"] = path
            captured["payload"] = payload
            return {"choices": [{"message": {"content": "vision ok"}}]}

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_vision("Describe", [_PNG_BASE64])

        assert result.content == "vision ok"
        assert result.finish_reason == "stop"
        assert captured["path"] == "/chat/completions"
        assert captured["payload"]["messages"] == [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe"},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{_PNG_BASE64}"},
                    },
                ],
            }
        ]

    def test_generate_with_vision_reports_length_finish_reason(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen2.5-VL-7B-Instruct"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen2.5-VL-7B-Instruct")

        monkeypatch.setattr(
            engine._service,  # noqa: SLF001
            "post_json",
            lambda *_a, **_kw: {
                "choices": [{"message": {"content": "clipped"}, "finish_reason": "length"}]
            },
        )

        result = engine.generate_with_vision("Describe", [_PNG_BASE64])

        # The provider's finish_reason must reach the caller so the chat layer
        # can report honest truncation instead of a hardcoded end_turn.
        assert result.content == "clipped"
        assert result.finish_reason == "length"

    def test_generate_with_vision_raises_for_text_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch, model="Qwen/Qwen3.5-9B")

        with pytest.raises(UnsupportedModalityError):
            engine.generate_with_vision("Describe", ["YWJj"])

    def test_vision_file_read_and_encode(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_models_probe(
            monkeypatch,
            lambda *_a, **_kw: _make_models_response("Qwen/Qwen2.5-VL-7B-Instruct"),
        )
        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen2.5-VL-7B-Instruct")

        image_path = tmp_path / "sample.png"
        image_bytes = _PNG_BYTES
        image_path.write_bytes(image_bytes)

        captured: dict[str, Any] = {}

        def _fake_post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
            captured["path"] = path
            captured["payload"] = payload
            return {"choices": [{"message": {"content": "file ok"}}]}

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_vision("Describe", [str(image_path)])

        assert result.content == "file ok"
        encoded = base64.b64encode(image_bytes).decode("ascii")
        assert captured["payload"]["messages"][0]["content"][1] == {
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{encoded}"},
        }


# -- helpers for streaming tests -------------------------------------------


def _sse_chunk(delta: dict[str, str]) -> str:
    """Build a single SSE line from a delta dict."""
    body = {"choices": [{"delta": delta}]}
    return f"data: {json.dumps(body)}"


class _FakeSSEStream:
    """Simulates an httpx streaming response with SSE lines."""

    def __init__(self, lines: list[str]) -> None:
        self._lines = lines
        self.status_code = 200

    def iter_lines(self) -> list[str]:
        return self._lines

    def raise_for_status(self) -> None:
        pass

    def __enter__(self) -> _FakeSSEStream:
        return self

    def __exit__(self, *_args: Any) -> None:
        pass


def _patch_stream_response(monkeypatch: pytest.MonkeyPatch, target: Any) -> None:
    """Route the pooled ``stream_response`` seam at a fake SSE response.

    ``stream()`` and ``stream_with_tools()`` no longer build a throwaway
    ``httpx.Client`` per call -- both reuse the engine's pooled
    ``ProviderHttpService``, so tests patch the service method rather than the
    httpx module function (mirroring ``_patch_models_probe``).

    ``target`` is either the response object to yield, or a callable
    ``(path, json=..., timeout=...) -> response`` for tests that need to
    inspect the per-call arguments or simulate a transport failure.
    """

    @contextmanager
    def _stream_response(
        _self: ProviderHttpService,
        _method: str,
        path: str,
        *,
        json: Any = None,
        timeout: Any = None,
    ):  # type: ignore[no-untyped-def]
        resolved = target(path, json=json, timeout=timeout) if callable(target) else target
        yield resolved

    monkeypatch.setattr(ProviderHttpService, "stream_response", _stream_response)


def _make_streaming_engine(
    monkeypatch: pytest.MonkeyPatch, model: str = "Qwen/Qwen3.5-9B"
) -> VLLMEngine:
    """Create a VLLMEngine with model loaded, ready for streaming."""
    _patch_models_probe(
        monkeypatch,
        lambda *_a, **_kw: _make_models_response(model),
    )
    engine = VLLMEngine(host="http://localhost:8000")
    engine.load_model(model)
    return engine


def _drain_stream(generator):
    chunks: list[Any] = []
    while True:
        try:
            chunks.append(next(generator))
        except StopIteration as stop:
            return chunks, stop.value


# -- streaming tests -------------------------------------------------------


class TestStream:
    def test_yields_streaming_events_not_strings(self, monkeypatch: pytest.MonkeyPatch) -> None:
        engine = _make_streaming_engine(monkeypatch)
        lines = [
            _sse_chunk({"content": "Hello"}),
            _sse_chunk({"content": " world"}),
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="hi"))

        assert len(chunks) == 3
        assert chunks[0] == StreamingEvent(kind="content", text="Hello")
        assert chunks[1] == StreamingEvent(kind="content", text=" world")
        assert chunks[2] == StreamingEvent(kind="done", text="", finish_reason="stop")

    def test_emits_done_event(self, monkeypatch: pytest.MonkeyPatch) -> None:
        engine = _make_streaming_engine(monkeypatch)
        lines = [
            _sse_chunk({"content": "ok"}),
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="test"))

        assert chunks[-1] == StreamingEvent(kind="done", finish_reason="stop")

    def test_plain_stream_attaches_provider_usage_to_done_event(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        usage = {
            "prompt_tokens": 7,
            "completion_tokens": 3,
            "total_tokens": 10,
            "generation_duration_ms": 250,
            "time_to_first_token_ms": 80,
        }
        lines = [
            _sse_chunk({"content": "ok"}),
            f"data: {json.dumps({'choices': [], 'usage': usage})}",
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        done = list(engine.stream(prompt="test"))[-1]

        assert done.usage is not None
        assert done.usage.provider == "vllm"
        assert done.usage.input_tokens == 7
        assert done.usage.generation_tokens == 3
        assert done.usage.generation_duration_ms == pytest.approx(250)
        assert done.usage.time_to_first_token_ms == pytest.approx(80)

    def test_tool_stream_accumulates_fragmented_calls_and_returns_terminal_result(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        lines = [
            "data: "
            + json.dumps(
                {
                    "choices": [
                        {
                            "delta": {
                                "content": "Checking. ",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_1",
                                        "function": {
                                            "name": "read_file",
                                            "arguments": '{"path":',
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                }
            ),
            "data: "
            + json.dumps(
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "function": {"arguments": '"README.md"}'},
                                    }
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                }
            ),
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks, result = _drain_stream(
            engine.stream_with_tools(
                prompt="read README",
                tools=[{"name": "read_file", "parameters": {"type": "object"}}],
            )
        )

        assert StreamingEvent(kind="content", text="Checking. ") in chunks
        assert chunks[-1] == StreamingEvent(kind="done", finish_reason="tool_calls")
        assert result.finish_reason == "tool_calls"
        assert result.tool_calls[0].tool_id == "read_file"
        assert result.tool_calls[0].arguments == {"path": "README.md"}

    def test_tool_stream_propagates_terminal_cancellation_and_closes_response(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        cancel_handle = TurnCancellationHandle(request_id="req-vllm-cancel")

        class _CancellingStream(_FakeSSEStream):
            closed = False

            def iter_raw(self, *, chunk_size: int):
                _ = chunk_size
                cancel_handle.cancel(reason="test_cancel")
                yield b'data: {"choices":[]}\n'

            def close(self) -> None:
                self.closed = True

        response = _CancellingStream([])
        _patch_stream_response(monkeypatch, response)

        with pytest.raises(TerminalChatStateError):
            list(
                engine.stream_with_tools(
                    prompt="cancel",
                    tools=[],
                    cancel_handle=cancel_handle,
                )
            )

        assert response.closed is True

    def test_tool_stream_deadline_bounds_pre_response_stall_and_reclaims_reader(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        captured_timeout: list[float] = []

        def _stall(_path: str, *, json: Any = None, timeout: Any = None) -> Any:
            # The per-call timeout override now carries the clamped bound that
            # the throwaway client used to take from its constructor.
            captured_timeout.append(float(timeout))
            time.sleep(float(timeout))
            raise httpx.ReadTimeout("stalled before response")

        _patch_stream_response(monkeypatch, _stall)
        started = time.monotonic()
        stream = engine.stream_with_tools(
            prompt="stall",
            tools=[],
            wall_clock_deadline=started + 0.04,
        )
        reader = _StreamReader(stream)
        try:
            item = reader.queue.get(timeout=0.5)
            assert isinstance(item, _StreamFailure)
            reader.join(timeout_seconds=0.2)
            assert not reader.thread.is_alive()
            assert time.monotonic() - started < 0.5
            assert captured_timeout and captured_timeout[0] <= 0.06
        finally:
            reader.close()
            reader.join(timeout_seconds=0.2)

        assert not any(
            thread.name == "router-stream-reader" and thread.is_alive()
            for thread in threading.enumerate()
        )

    def test_emits_thinking_events_for_thinking_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch, model="Qwen/Qwen3.5-9B")
        assert engine._thinking is True  # noqa: SLF001

        lines = [
            _sse_chunk({"reasoning_content": "Let me think..."}),
            _sse_chunk({"content": "The answer is 42"}),
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="what is the answer?"))

        assert chunks[0] == StreamingEvent(kind="thinking", text="Let me think...")
        assert chunks[1] == StreamingEvent(kind="content", text="The answer is 42")
        assert chunks[2] == StreamingEvent(kind="done", finish_reason="stop")

    def test_emits_thinking_events_for_qwen36(self, monkeypatch: pytest.MonkeyPatch) -> None:
        engine = _make_streaming_engine(monkeypatch, model="Qwen/Qwen3.6-35B-A3B")
        assert engine._thinking is True  # noqa: SLF001

        lines = [
            _sse_chunk({"reasoning_content": "Check tools first."}),
            _sse_chunk({"content": "Here is the tool result."}),
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="use a tool"))

        assert chunks[0] == StreamingEvent(kind="thinking", text="Check tools first.")
        assert chunks[1] == StreamingEvent(kind="content", text="Here is the tool result.")
        assert chunks[2] == StreamingEvent(kind="done", finish_reason="stop")

    def test_done_event_reports_reasoning_only_without_engine_attribute(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch, model="Qwen/Qwen3.5-9B")
        lines = [
            _sse_chunk({"reasoning_content": "Only private reasoning, no answer."}),
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="hi"))

        # The verdict rides the request's own terminal chunk; the old shared
        # ``_last_finish_reason`` attribute was never cleared, so one
        # reasoning-only turn poisoned every later turn on the same engine.
        assert chunks[-1] == StreamingEvent(kind="done", finish_reason="reasoning_only")
        assert not hasattr(engine, "_last_finish_reason")

    def test_uses_gemma_reasoning_parser_fallback_when_reasoning_content_is_absent(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        engine = _make_streaming_engine(monkeypatch, model="google/gemma-4-e4b-it")
        engine.begin_request_context(
            request_id="req_gemma_stream",
            app_profile_behavior={
                "family": "gemma4",
                "variant": "e4b",
                "temperature": 1.0,
                "top_k": 40,
                "reasoning_parser_start": "<|channel>thought",
                "reasoning_parser_end": "<channel|>",
            },
        )

        lines = [
            _sse_chunk({"content": "<|channel>thoughtChecking"}),
            _sse_chunk({"content": " the request.<channel|>Visible answer"}),
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="what is the answer?"))

        assert chunks[0] == StreamingEvent(kind="thinking", text="Checking")
        assert chunks[1] == StreamingEvent(kind="thinking", text=" the request.")
        assert chunks[2] == StreamingEvent(kind="content", text="Visible answer")
        assert chunks[3] == StreamingEvent(kind="done", finish_reason="stop")
        engine.clear_request_context(request_id="req_gemma_stream")

    def test_no_thinking_events_for_non_thinking_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch, model="meta-llama/Llama-3.1-8B")
        assert engine._thinking is False  # noqa: SLF001

        lines = [
            _sse_chunk({"reasoning_content": "ignored", "content": "hello"}),
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="hi"))

        kinds = [c.kind for c in chunks if isinstance(c, StreamingEvent)]
        assert "thinking" not in kinds

    def test_suppresses_repetitive_thinking(self, monkeypatch: pytest.MonkeyPatch) -> None:
        engine = _make_streaming_engine(monkeypatch, model="Qwen/Qwen3.5-9B")
        # Feed many identical thinking chunks to trigger the guard
        repeated = "I need to think about this carefully. " * 50
        lines = [_sse_chunk({"reasoning_content": repeated}) for _ in range(20)]
        lines.append(_sse_chunk({"content": "done"}))
        lines.append("data: [DONE]")

        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="think hard", max_tokens=64))

        thinking_chunks = [
            c for c in chunks if isinstance(c, StreamingEvent) and c.kind == "thinking"
        ]
        # Guard should have suppressed some — we should have fewer than 20 thinking events
        assert len(thinking_chunks) < 20


# -- thinking detection tests ----------------------------------------------


class TestDetectThinking:
    def test_qwen35_detected(self) -> None:
        assert VLLMEngine._detect_thinking("Qwen/Qwen3.5-9B") is True  # noqa: SLF001

    def test_qwen36_detected_namespaced(self) -> None:
        assert VLLMEngine._detect_thinking("Qwen/Qwen3.6-35B-A3B") is True  # noqa: SLF001

    def test_qwen36_detected_bare(self) -> None:
        assert VLLMEngine._detect_thinking("qwen3.6-35b-a3b") is True  # noqa: SLF001

    def test_qwen36_gguf_filename_detected(self) -> None:
        assert (
            VLLMEngine._detect_thinking("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf")  # noqa: SLF001
            is True
        )

    def test_thinking_in_name_detected(self) -> None:
        assert VLLMEngine._detect_thinking("some-model-thinking") is True  # noqa: SLF001

    def test_non_thinking_model(self) -> None:
        assert VLLMEngine._detect_thinking("meta-llama/Llama-3.1-8B") is False  # noqa: SLF001

    def test_capabilities_includes_thinking(self, monkeypatch: pytest.MonkeyPatch) -> None:
        engine = _make_streaming_engine(monkeypatch, model="Qwen/Qwen3.5-9B")
        assert engine.capabilities["thinking"] is True

    def test_capabilities_includes_thinking_qwen36(self, monkeypatch: pytest.MonkeyPatch) -> None:
        engine = _make_streaming_engine(monkeypatch, model="Qwen/Qwen3.6-35B-A3B")
        assert engine.capabilities["thinking"] is True

    def test_capabilities_no_thinking(self, monkeypatch: pytest.MonkeyPatch) -> None:
        engine = _make_streaming_engine(monkeypatch, model="meta-llama/Llama-3.1-8B")
        assert engine.capabilities["thinking"] is False


class TestDetectVision:
    def test_detect_vision_positive(self) -> None:
        assert VLLMEngine._detect_vision("Qwen/Qwen2.5-VL-7B-Instruct") is True  # noqa: SLF001
        assert VLLMEngine._detect_vision("llava-hf/llava-1.5-7b-hf") is True  # noqa: SLF001

    def test_detect_vision_negative(self) -> None:
        assert VLLMEngine._detect_vision("Qwen/Qwen3.5-9B") is False  # noqa: SLF001
        assert VLLMEngine._detect_vision("meta-llama/Llama-3.1-8B") is False  # noqa: SLF001


# -- generate_with_tools thinking tests ------------------------------------


class TestGenerateWithToolsThinking:
    def test_captures_reasoning_content(self, monkeypatch: pytest.MonkeyPatch) -> None:
        engine = _make_streaming_engine(monkeypatch, model="Qwen/Qwen3.5-9B")

        def _fake_post_json(_path: str, _payload: dict[str, Any]) -> dict[str, Any]:
            return {
                "choices": [
                    {
                        "message": {
                            "content": "42",
                            "reasoning_content": "The user asks for the answer to everything.",
                        },
                    }
                ],
            }

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(prompt="answer", tools=[])

        assert result.content == "42"
        assert result.thinking_text == "The user asks for the answer to everything."

    def test_no_thinking_text_for_non_thinking_model(self, monkeypatch: pytest.MonkeyPatch) -> None:
        engine = _make_streaming_engine(monkeypatch, model="meta-llama/Llama-3.1-8B")

        def _fake_post_json(_path: str, _payload: dict[str, Any]) -> dict[str, Any]:
            return {
                "choices": [
                    {
                        "message": {
                            "content": "hello",
                            "reasoning_content": "should be ignored",
                        },
                    }
                ],
            }

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(prompt="hi", tools=[])

        assert result.content == "hello"
        assert result.thinking_text == ""

    def test_gemma_reasoning_parser_fallback_preserves_native_reasoning_behavior(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        engine = _make_streaming_engine(monkeypatch, model="google/gemma-4-e4b-it")
        engine.begin_request_context(
            request_id="req_gemma_parser",
            app_profile_behavior={
                "family": "gemma4",
                "variant": "e4b",
                "temperature": 1.0,
                "top_k": 40,
                "reasoning_parser_start": "<|channel>thought",
                "reasoning_parser_end": "<channel|>",
            },
        )

        def _fake_post_json(_path: str, _payload: dict[str, Any]) -> dict[str, Any]:
            return {
                "choices": [
                    {
                        "message": {
                            "content": "<|channel>thoughthidden<channel|>hello",
                            "reasoning_content": "native reasoning",
                        },
                    }
                ],
            }

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(prompt="hi", tools=[])

        assert result.content == "hello"
        assert result.thinking_text == "native reasoning"
        engine.clear_request_context(request_id="req_gemma_parser")

    def test_gemma_stream_suppresses_repetitive_reasoning_fallback(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # This test's subject is suppress-only guard behavior; the default-on
        # thinking-budget abort (covered by test_thinking_budget_abort.py) would
        # end the stream at the char_limit trip before the tail content arrives.
        monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", "0")
        engine = _make_streaming_engine(monkeypatch, model="google/gemma-4-e4b-it")
        engine.begin_request_context(
            request_id="req_gemma_guard",
            app_profile_behavior={
                "family": "gemma4",
                "variant": "e4b",
                "temperature": 1.0,
                "top_k": 40,
                "reasoning_parser_start": "<|channel>thought",
                "reasoning_parser_end": "<channel|>",
            },
        )
        repeated = "I need to think about this carefully. " * 50
        lines = [
            _sse_chunk({"content": f"<|channel>thought{repeated}"}),
            *[_sse_chunk({"content": repeated}) for _ in range(8)],
            _sse_chunk({"content": f"{repeated}<channel|>done"}),
            "data: [DONE]",
        ]

        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="think hard", max_tokens=64))

        thinking_chunks = [
            c for c in chunks if isinstance(c, StreamingEvent) and c.kind == "thinking"
        ]
        assert len(thinking_chunks) < 10
        assert chunks[-2] == StreamingEvent(kind="content", text="done")
        engine.clear_request_context(request_id="req_gemma_guard")

    def test_gemma_reasoning_parser_fallback_extracts_tagged_reasoning(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        engine = _make_streaming_engine(monkeypatch, model="google/gemma-4-e4b-it")
        engine.begin_request_context(
            request_id="req_gemma_parser_fallback",
            app_profile_behavior={
                "family": "gemma4",
                "variant": "e4b",
                "temperature": 1.0,
                "top_k": 40,
                "reasoning_parser_start": "<|channel>thought",
                "reasoning_parser_end": "<channel|>",
            },
        )

        def _fake_post_json(_path: str, _payload: dict[str, Any]) -> dict[str, Any]:
            return {
                "choices": [
                    {
                        "message": {
                            "content": "<|channel>thoughtCheck tools first.<channel|>hello",
                        },
                    }
                ],
            }

        monkeypatch.setattr(engine._service, "post_json", _fake_post_json)  # noqa: SLF001

        result = engine.generate_with_tools(prompt="hi", tools=[])

        assert result.content == "hello"
        assert result.thinking_text == "Check tools first."
        engine.clear_request_context(request_id="req_gemma_parser_fallback")

# ---------------------------------------------------------------------------
# F10 / F13b -- vLLM stream terminal evidence and deadline plumbing
#
# ``stream()`` used to break ONLY on the ``[DONE]`` sentinel and then yield
# ``finish_reason="stop"`` on both the sentinel path AND a bare EOF, so a
# truncated answer was indistinguishable from a complete one. It also hardcoded
# a 120 s transport timeout with no way for the caller turn deadline to bound
# it, letting a transport acquisition outlive the routing watchdog.
# ---------------------------------------------------------------------------


class TestStreamTerminalEvidence:
    def test_eof_without_sentinel_or_finish_reason_reports_incomplete(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        lines = [_sse_chunk({"content": "half an ans"})]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="hi"))

        assert chunks[0] == StreamingEvent(kind="content", text="half an ans")
        assert chunks[-1].kind == "done"
        assert chunks[-1].finish_reason == FINISH_REASON_INCOMPLETE

    def test_finish_reason_without_sentinel_is_terminal_evidence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A server that closes right after the finish_reason chunk (no trailing
        # sentinel) still finished; that must not be reported as truncated.
        engine = _make_streaming_engine(monkeypatch)
        lines = [
            "data: "
            + json.dumps(
                {"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]}
            )
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="hi"))

        assert chunks[-1].finish_reason == "stop"

    def test_inband_error_object_reports_error_and_stops_reading(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        lines = [
            _sse_chunk({"content": "start"}),
            "data: " + json.dumps({"object": "error", "message": "engine died"}),
            _sse_chunk({"content": "never read"}),
            "data: [DONE]",
        ]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="hi"))

        assert [c.text for c in chunks if c.kind == "content"] == ["start"]
        assert chunks[-1].finish_reason == FINISH_REASON_PROVIDER_ERROR

    def test_empty_stream_reports_incomplete(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        _patch_stream_response(monkeypatch, _FakeSSEStream([]))

        chunks = list(engine.stream(prompt="hi"))

        assert chunks[-1].finish_reason == FINISH_REASON_INCOMPLETE

    def test_duplicate_sentinels_still_emit_exactly_one_terminal(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        lines = [_sse_chunk({"content": "ok"}), "data: [DONE]", "data: [DONE]"]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="hi"))

        assert sum(c.kind == "done" for c in chunks) == 1
        assert chunks[-1].finish_reason == "stop"

    def test_reasoning_only_verdict_still_wins_over_terminal_classification(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        lines = [_sse_chunk({"reasoning_content": "thinking"}), "data: [DONE]"]
        _patch_stream_response(monkeypatch, _FakeSSEStream(lines))

        chunks = list(engine.stream(prompt="hi"))

        assert chunks[-1].finish_reason == "reasoning_only"


class TestStreamDeadlinePlumbing:
    def test_stream_clamps_transport_timeout_to_the_wall_clock_deadline(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        captured: dict[str, Any] = {}

        def _open(_path: str, **kwargs: Any) -> _FakeSSEStream:
            captured["timeout"] = kwargs.get("timeout")
            return _FakeSSEStream(["data: [DONE]"])

        _patch_stream_response(monkeypatch, _open)

        list(engine.stream(prompt="hi", wall_clock_deadline=time.monotonic() + 5.0))

        assert captured["timeout"] is not None
        assert captured["timeout"] <= 5.0, "the turn deadline must bound the transport"

    def test_stream_without_a_deadline_keeps_the_provider_default(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        captured: dict[str, Any] = {}

        def _open(_path: str, **kwargs: Any) -> _FakeSSEStream:
            captured["timeout"] = kwargs.get("timeout")
            return _FakeSSEStream(["data: [DONE]"])

        _patch_stream_response(monkeypatch, _open)

        list(engine.stream(prompt="hi"))

        assert captured["timeout"] == 120.0


class TestModelsProbeTransport:
    def test_models_probe_uses_the_shared_bounded_http_service(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The probe must not hand-roll a client that bypasses the bounded body.

        The old bare ``httpx.get`` read an UNBOUNDED response body, so a broken
        /models endpoint could stream the sidecar out of memory, and it built a
        throwaway client on every probe.
        """
        calls: list[dict[str, Any]] = []

        def _get_json(
            _self: ProviderHttpService,
            path: str,
            *,
            query: Any = None,
            cancel_handle: Any = None,
            timeout: Any = None,
        ) -> dict[str, Any]:
            calls.append({"path": path, "timeout": timeout})
            return {"data": [{"id": "Qwen/Qwen3.5-9B"}]}

        monkeypatch.setattr(ProviderHttpService, "get_json", _get_json)

        def _explode(*_a: Any, **_kw: Any) -> None:
            raise AssertionError("the probe must not call httpx.get directly")

        monkeypatch.setattr(httpx, "get", _explode)

        engine = VLLMEngine(host="http://localhost:8000")
        engine.load_model("Qwen/Qwen3.5-9B")

        assert calls and calls[0]["path"] == "/models"
        assert calls[0]["timeout"] == 3.0

    def test_models_probe_failure_still_degrades_to_none(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _boom(*_a: Any, **_kw: Any) -> dict[str, Any]:
            raise RuntimeError("service exploded")

        monkeypatch.setattr(ProviderHttpService, "get_json", _boom)
        engine = VLLMEngine(host="http://localhost:8000")

        with pytest.raises(Exception, match="not reachable"):
            engine.load_model("Qwen/Qwen3.5-9B")


class TestPooledStreamingTransport:
    """F13d: both streaming paths ride the pooled client, not a per-call one."""

    def test_stream_does_not_build_a_per_call_client(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        _patch_stream_response(monkeypatch, _FakeSSEStream(["data: [DONE]"]))

        def _explode(*_a: Any, **_kw: Any) -> None:
            raise AssertionError("stream() must not build a throwaway httpx.Client")

        monkeypatch.setattr(httpx, "Client", _explode)

        chunks = list(engine.stream(prompt="hi"))

        assert chunks[-1] == StreamingEvent(kind="done", finish_reason="stop")

    def test_tool_stream_does_not_build_a_per_call_client(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = _make_streaming_engine(monkeypatch)
        _patch_stream_response(monkeypatch, _FakeSSEStream(["data: [DONE]"]))

        def _explode(*_a: Any, **_kw: Any) -> None:
            raise AssertionError(
                "stream_with_tools() must not build a throwaway httpx.Client"
            )

        monkeypatch.setattr(httpx, "Client", _explode)

        _chunks, result = _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        assert result.finish_reason == "stop"

    def test_streaming_targets_the_relative_path_so_base_url_still_applies(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The pooled client carries base_url, so the path must be relative.

        Passing the old absolute ``{base_url}/chat/completions`` through a
        client that already has a base_url would double the ``/v1`` prefix.
        """
        engine = _make_streaming_engine(monkeypatch)
        seen: list[str] = []

        def _open(path: str, **_kw: Any) -> _FakeSSEStream:
            seen.append(path)
            return _FakeSSEStream(["data: [DONE]"])

        _patch_stream_response(monkeypatch, _open)

        list(engine.stream(prompt="hi"))
        _drain_stream(engine.stream_with_tools(prompt="hi", tools=[]))

        assert seen == ["/chat/completions", "/chat/completions"]

    def test_cancelling_a_tool_stream_leaves_the_pooled_client_usable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Cancellation must close the RESPONSE, never the shared client.

        Forward guard on the critical constraint of F13d: this path used to
        register a cancel callback that called ``close()`` on the client it
        created. Re-pointing that registration at the POOLED client would
        permanently brick the engine -- an ``httpx.Client`` cannot be reopened,
        so every later request would fail. Response-level cancellation inside
        ``_iter_cancel_aware_sse_lines`` is what closes the in-flight stream.
        """
        engine = _make_streaming_engine(monkeypatch)
        cancel_handle = TurnCancellationHandle(request_id="req-vllm-pool-cancel")

        class _CancellingStream(_FakeSSEStream):
            closed = False

            def iter_raw(self, *, chunk_size: int):
                _ = chunk_size
                cancel_handle.cancel(reason="test_cancel")
                yield b'data: {"choices":[]}\n'

            def close(self) -> None:
                self.closed = True

        cancelled_response = _CancellingStream([])
        _patch_stream_response(monkeypatch, cancelled_response)

        with pytest.raises(TerminalChatStateError):
            list(
                engine.stream_with_tools(
                    prompt="cancel",
                    tools=[],
                    cancel_handle=cancel_handle,
                )
            )

        assert cancelled_response.closed is True
        # The pooled client survived: not closed, and still serving.
        assert engine._service._client.is_closed is False  # noqa: SLF001

        _patch_stream_response(monkeypatch, _FakeSSEStream(["data: [DONE]"]))
        chunks = list(engine.stream(prompt="after cancel"))

        assert chunks[-1] == StreamingEvent(kind="done", finish_reason="stop")
