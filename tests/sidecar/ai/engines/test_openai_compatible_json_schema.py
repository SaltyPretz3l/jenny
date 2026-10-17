"""Opt-in llama-server ``json_schema`` response_format pass-through (row 58 W2)."""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_models import RuntimeConfig
from sidecar.ai.engines.factory import create_engine
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.engines.vllm_engine import VLLMEngine

_SCHEMA = {
    "title": "MemoryReflection",
    "type": "object",
    "properties": {"facts": {"type": "array", "items": {"type": "string"}}},
    "required": ["facts"],
}


def _payload(engine: Any, response_format: ResponseFormat | None) -> dict[str, Any]:
    engine.model_name = "probe"
    engine._ready = True
    return engine._build_payload(
        prompt="hi",
        max_tokens=8,
        temperature=0.0,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system="",
        messages=None,
        response_format=response_format,
    )


def test_flag_off_keeps_json_object_even_with_a_schema() -> None:
    engine = OpenAICompatibleEngine()
    payload = _payload(engine, ResponseFormat(type="json_object", json_schema=_SCHEMA))
    assert payload["response_format"] == {"type": "json_object"}


def test_flag_on_llama_cpp_with_schema_sends_strict_json_schema() -> None:
    engine = OpenAICompatibleEngine()
    engine.set_json_schema_response_format(True)
    payload = _payload(engine, ResponseFormat(type="json_object", json_schema=_SCHEMA))
    assert payload["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "MemoryReflection", "schema": _SCHEMA, "strict": True},
    }


def test_untitled_schema_is_named_response() -> None:
    engine = OpenAICompatibleEngine()
    engine.set_json_schema_response_format(True)
    schema = {"type": "object"}
    payload = _payload(engine, ResponseFormat(type="json_object", json_schema=schema))
    assert payload["response_format"]["json_schema"]["name"] == "response"


def test_flag_on_without_schema_keeps_json_object() -> None:
    engine = OpenAICompatibleEngine()
    engine.set_json_schema_response_format(True)
    payload = _payload(engine, ResponseFormat(type="json_object"))
    assert payload["response_format"] == {"type": "json_object"}


def test_flag_on_text_format_sends_no_response_format() -> None:
    engine = OpenAICompatibleEngine()
    engine.set_json_schema_response_format(True)
    assert "response_format" not in _payload(engine, ResponseFormat(type="text"))


def test_plain_vllm_never_sends_json_schema() -> None:
    engine = VLLMEngine()
    engine._json_schema_response_format = True
    payload = _payload(engine, ResponseFormat(type="json_object", json_schema=_SCHEMA))
    assert payload["response_format"] == {"type": "json_object"}


@pytest.mark.parametrize(("raw", "expected"), [(True, True), (False, False), ("true", False)])
def test_runtime_config_parses_the_flag_strictly(raw: object, expected: bool) -> None:
    config = parse_runtime_config({"engine_type": "mock", "json_schema_response_format": raw})
    assert config.json_schema_response_format is expected
    assert RuntimeConfig().json_schema_response_format is False


def test_factory_adopts_the_flag_on_the_openai_compatible_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[bool] = []

    def load(engine: OpenAICompatibleEngine, _model: str) -> None:
        observed.append(engine._json_schema_response_format)

    monkeypatch.setattr(OpenAICompatibleEngine, "load_model", load)
    for enabled in (False, True):
        selection = create_engine(RuntimeConfig(
            engine_type="openai-compatible", model="probe",
            api_url="http://127.0.0.1:8048/v1", json_schema_response_format=enabled,
        ))
        assert selection.engine_type == "openai-compatible"
        selection.engine.close()
    assert observed == [False, True]
