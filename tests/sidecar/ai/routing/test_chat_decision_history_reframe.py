"""Wiring: the routed lane re-frames prior-turn tool rows before the engine.

Unit coverage for the re-framer lives in
`tests/sidecar/ai/context/test_history_reframe.py`. This file pins only that
`build_chat_decision`'s admitted semantic history passes through the pass with
the kernel's config — framed when `tool_result_envelope_enabled` is on, raw
byte-identical when off (the default). Mirrors the session-environment wiring
harness.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat_models import ChatRequestContext


class _StubEngine:
    def __init__(self, result: GenerationResult) -> None:
        self._result = result
        self.last_kwargs: dict[str, Any] = {}

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.last_kwargs = kwargs
        return self._result

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _StubMCPClient:
    @property
    def available_tools(self) -> list[Any]:
        return []

    def tool_descriptor(self, _tool_name: str) -> Any | None:
        return None

    def execute_tool(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("no tool calls are expected in this test")


_HISTORY = [
    {"role": "user", "content": "read the file"},
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"id": "call_1", "name": "read_file", "arguments": {"path": "a.txt"}}],
    },
    {
        "role": "tool",
        "tool_call_id": "call_1",
        "name": "read_file",
        "content": "raw persisted output",
        "is_error": True,
        "error_code": "CMP-TOOL-0004",
    },
    {"role": "user", "content": "so what does it say?"},
]


def _run_turn(*, envelope_enabled: bool) -> _StubEngine:
    engine = _StubEngine(GenerationResult(content="hi", finish_reason="stop"))
    config = RuntimeConfig(engine_type="mock", model="mock-v1")
    if not config.tools_workspace_root and not config.agent_workspace_root:
        config = replace(config, tools_workspace_root="C:/workspace")
    if config.mode == "chat":
        config = replace(config, mode="assist")
    config = replace(config, tool_result_envelope_enabled=envelope_enabled)
    router = ChatRouter(
        config=config,
        engine=engine,
        mcp_client=_StubMCPClient(),
        context_builder=ContextBuilder(None),
    )
    router.build_chat_decision(
        request_context=ChatRequestContext(
            request_id="req-reframe",
            trace_id=None,
            session_id="session-reframe",
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=0,
        ),
        request_id="req-reframe",
        messages=[dict(row) for row in _HISTORY],
        latest_user_content="so what does it say?",
        mode="chat",
        approvals_pre_granted=True,
    )
    return engine


def _engine_tool_rows(engine: _StubEngine) -> list[dict[str, Any]]:
    messages = engine.last_kwargs.get("messages") or []
    return [dict(m) for m in messages if str(m.get("role")) == "tool"]


def test_flag_on_frames_prior_turn_tool_rows_for_the_engine() -> None:
    engine = _run_turn(envelope_enabled=True)
    tool_rows = _engine_tool_rows(engine)
    assert len(tool_rows) == 1
    content = str(tool_rows[0]["content"])
    assert content.startswith("## Tool Result — read_file [call_1]")
    assert "outcome: error" in content
    assert "error_code: CMP-TOOL-0004" in content
    assert "<untrusted_tool_output>" in content
    assert "raw persisted output" in content


def test_flag_off_default_leaves_tool_rows_raw() -> None:
    engine = _run_turn(envelope_enabled=False)
    tool_rows = _engine_tool_rows(engine)
    assert len(tool_rows) == 1
    assert tool_rows[0]["content"] == "raw persisted output"
    # Byte-parity with pre-W1: Electron's always-forwarded W1 fields must not
    # reach the engine request when the flag is off ('name' included — the
    # Ollama serializer forwards it when present).
    assert "name" not in tool_rows[0]
    assert "tool_envelope" not in tool_rows[0]


def test_default_config_has_the_flag_off() -> None:
    assert RuntimeConfig(engine_type="mock", model="mock-v1").tool_result_envelope_enabled is True
