"""Behavioral unit tests for sidecar.runtime.ollama_support re-export surface."""

from sidecar.runtime import ollama_support

from sidecar.ai.reasoning_parser import (
    DelimitedReasoningParser,
    extract_delimited_reasoning,
)
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.thinking_guard import ThinkingRepetitionGuard
from sidecar.ai.tools.inband_parser import extract_inband_tool_calls
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.ai.engines.catalog import resolve_ollama_base_url
from sidecar.ai.exceptions import ModelNotLoadedError


def test_all_is_nonempty_list():
    assert isinstance(ollama_support.__all__, list)
    assert len(ollama_support.__all__) > 0


def test_all_names_are_present_as_attributes():
    missing = [
        name
        for name in ollama_support.__all__
        if not hasattr(ollama_support, name)
    ]
    assert missing == []


def test_delimited_reasoning_parser_in_all():
    assert "DelimitedReasoningParser" in ollama_support.__all__


def test_delimited_reasoning_parser_identity():
    assert ollama_support.DelimitedReasoningParser is DelimitedReasoningParser


def test_extract_delimited_reasoning_identity():
    assert ollama_support.extract_delimited_reasoning is extract_delimited_reasoning


def test_response_format_identity():
    assert ollama_support.ResponseFormat is ResponseFormat


def test_thinking_repetition_guard_identity():
    assert ollama_support.ThinkingRepetitionGuard is ThinkingRepetitionGuard


def test_extract_inband_tool_calls_identity():
    assert ollama_support.extract_inband_tool_calls is extract_inband_tool_calls


def test_generation_result_identity():
    assert ollama_support.GenerationResult is GenerationResult


def test_tool_call_request_identity():
    assert ollama_support.ToolCallRequest is ToolCallRequest


def test_resolve_ollama_base_url_identity():
    assert ollama_support.resolve_ollama_base_url is resolve_ollama_base_url


def test_model_not_loaded_error_identity():
    assert ollama_support.ModelNotLoadedError is ModelNotLoadedError
