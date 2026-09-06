"""Shared imports/helpers for ``sidecar.ai.engines.ollama``."""

from __future__ import annotations

from sidecar.ai.engines.catalog import resolve_ollama_base_url, resolve_template_diagnostics
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.exceptions import (
    EngineConnectionError,
    GenerationError,
    ModelNotLoadedError,
    UnsupportedModalityError,
)
from sidecar.ai.reasoning_parser import (
    DelimitedReasoningParser,
    ReasoningExtraction,
    extract_delimited_reasoning,
    strip_known_reasoning_blocks,
    strip_known_reasoning_markers,
)
from sidecar.ai.thinking_guard import ThinkingRepetitionGuard
from sidecar.ai.tools.inband_parser import (
    extract_inband_tool_calls,
    extract_inband_tool_calls_detailed,
)
from sidecar.ai.tools.models import (
    GenerationResult,
    StreamChunk,
    StreamingEvent,
    ToolCallRequest,
)

__all__ = [
    "DelimitedReasoningParser",
    "EngineConnectionError",
    "GenerationError",
    "GenerationResult",
    "ModelNotLoadedError",
    "ReasoningExtraction",
    "ResponseFormat",
    "StreamChunk",
    "StreamingEvent",
    "ThinkingRepetitionGuard",
    "ToolCallRequest",
    "UnsupportedModalityError",
    "extract_delimited_reasoning",
    "extract_inband_tool_calls",
    "extract_inband_tool_calls_detailed",
    "resolve_ollama_base_url",
    "resolve_template_diagnostics",
    "strip_known_reasoning_blocks",
    "strip_known_reasoning_markers",
]
