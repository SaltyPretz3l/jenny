"""Dark-path tests for AgentKernel / ChatRouter in router.py.

Targets uncovered behavior in the router and its owner modules.

Each test drives a single concrete behaviour; oracles are non-vacuous and
would fail if the router's logic changed.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder, RuntimeToolStatus
from sidecar.ai.context.prompt_cache import StructuredSystemPrompt
from sidecar.ai.error_codes import CMP_TSRCH_DEFERRED_TOOL
from sidecar.ai.mcp.models import MCPToolDescriptor, MCPToolResult
from sidecar.ai.routing import tool_execution, tool_execution_snapshots, tool_resolution
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import AgentKernel, ChatRouter
from sidecar.ai.tools.catalog import tool_display_name
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.ai.tools.schema_examples import (
    schema_placeholder_value,
    tool_schema_hint_text,
    tool_schema_repair_hints,
)
from sidecar.ai.tools.tool_search import TOOL_SEARCH_TOOL_NAME


# ---------------------------------------------------------------------------
# Minimal stubs
# ---------------------------------------------------------------------------


class _StubEngine:
    """Minimal engine that records calls."""

    def __init__(
        self,
        result: GenerationResult | None = None,
        *,
        supports_tool_calling: bool | None = None,
        supports_inband_tool_calling: bool | None = None,
    ) -> None:
        self._result = result or GenerationResult(content="ok", finish_reason="stop")
        self.calls: list[dict[str, Any]] = []
        if supports_tool_calling is not None:
            self.supports_tool_calling = supports_tool_calling
        if supports_inband_tool_calling is not None:
            self.supports_inband_tool_calling = supports_inband_tool_calling

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.calls.append(dict(kwargs))
        return self._result

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _StubMCPClient:
    def __init__(
        self,
        descriptors: list[MCPToolDescriptor] | None = None,
        results: dict[str, MCPToolResult] | None = None,
    ) -> None:
        self._descriptors: list[MCPToolDescriptor] = descriptors or []
        self._results: dict[str, MCPToolResult] = results or {}
        self.executed: list[tuple[str, dict[str, Any]]] = []

    @property
    def available_tools(self) -> list[MCPToolDescriptor]:
        return list(self._descriptors)

    def tool_descriptor(self, tool_name: str) -> MCPToolDescriptor | None:
        for d in self._descriptors:
            if d.name == tool_name:
                return d
        return None

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
    ) -> MCPToolResult:
        _ = timeout_seconds
        self.executed.append((tool_name, dict(arguments)))
        return self._results[tool_name]


def _make_kernel(
    *,
    descriptors: list[MCPToolDescriptor] | None = None,
    results: dict[str, MCPToolResult] | None = None,
    config: RuntimeConfig | None = None,
    engine: _StubEngine | None = None,
) -> ChatRouter:
    _config = config or RuntimeConfig(
        engine_type="mock",
        model="mock-v1",
        tools_workspace_root="C:/workspace",
    )
    _engine = engine or _StubEngine()
    _client = _StubMCPClient(descriptors or [], results or {})
    return ChatRouter(
        config=_config,
        engine=_engine,
        mcp_client=_client,
        context_builder=ContextBuilder(None),
    )


def _make_read_file_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="read_file",
        description="Read a file",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        side_effecting=False,
        server_name="tools",
    )


def _make_web_search_descriptor(*, available: bool = True) -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="web_search",
        description="Search the web",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
        side_effecting=False,
        server_name="tools",
    )


# ---------------------------------------------------------------------------
# Line 140 — available_tools filters to names where available is True
# ---------------------------------------------------------------------------


def test_available_tools_returns_only_available_tool_names() -> None:
    """Line 140: available_tools list-comprehension filters status.available is True."""
    kernel = _make_kernel(
        descriptors=[_make_read_file_descriptor()],
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_workspace_root="C:/workspace",
        ),
    )

    result = kernel.available_tools

    # read_file requires workspace (C:/workspace set), so it should be available
    assert isinstance(result, list)
    assert "read_file" in result
    # Every name in available_tools must correspond to an available entry in tools_status
    for name in result:
        assert kernel.tools_status[name]["available"] is True, (
            f"Tool {name!r} is in available_tools but tools_status says unavailable"
        )


def test_available_tools_excludes_config_disabled_tool() -> None:
    """Line 140: config-disabled tool is absent from available_tools."""
    kernel = _make_kernel(
        descriptors=[
            MCPToolDescriptor(
                name="mermaid_generate",
                description="Generate Mermaid diagram",
                input_schema={"type": "object"},
                side_effecting=False,
                server_name="tools",
            )
        ],
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            tools_workspace_root="C:/workspace",
            tools_mermaid_enabled=False,
        ),
    )

    names = kernel.available_tools
    assert "mermaid_generate" not in names


# ---------------------------------------------------------------------------
# Line 190 — tool_schemas property
# ---------------------------------------------------------------------------


def test_tool_schemas_returns_list_of_dicts_with_required_keys() -> None:
    """Line 190: tool_schemas returns dicts each having 'name' and 'description'."""
    kernel = _make_kernel(descriptors=[_make_read_file_descriptor()])

    schemas = kernel.tool_schemas

    assert isinstance(schemas, list)
    assert len(schemas) >= 1
    for schema in schemas:
        assert "name" in schema, "Each schema must have a 'name' key"
        assert "description" in schema, "Each schema must have a 'description' key"
    schema_names = {s["name"] for s in schemas}
    assert "read_file" in schema_names


# ---------------------------------------------------------------------------
# Line 211 — _build_tool_payload branch (plan_mode=True forces context build)
# ---------------------------------------------------------------------------


def test_build_tool_payload_with_plan_mode_excludes_side_effecting() -> None:
    """Line 211: when plan_mode=True and request_context is None the branch builds it."""
    write_descriptor = MCPToolDescriptor(
        name="write_file",
        description="Write a file",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        side_effecting=True,
        server_name="tools",
    )
    read_descriptor = _make_read_file_descriptor()
    kernel = _make_kernel(
        descriptors=[read_descriptor, write_descriptor],
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            mode="assist",
            tools_workspace_root="C:/workspace",
        ),
    )

    payload = kernel._build_tool_payload(None, plan_mode=True)

    payload_names = [entry.get("name") for entry in payload]
    # Side-effecting tools are excluded in plan mode
    assert "write_file" not in payload_names
    # Non-side-effecting tools remain (read_file is not side-effecting)
    assert "read_file" in payload_names


def test_build_tool_payload_with_tool_preferences_removes_disabled() -> None:
    """Line 211: when tool_preferences is not None the branch builds request_context."""
    kernel = _make_kernel(
        descriptors=[_make_read_file_descriptor(), _make_web_search_descriptor()],
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            mode="assist",
            tools_workspace_root="C:/workspace",
            tools_web_enabled=True,
        ),
    )

    payload = kernel._build_tool_payload(
        None,
        tool_preferences={"disabled_tools": ("web_search",), "enabled_tools": ("read_file",)},
    )

    payload_names = [entry.get("name") for entry in payload]
    assert "web_search" not in payload_names
    # read_file is explicitly enabled
    assert "read_file" in payload_names


# ---------------------------------------------------------------------------
# Line 231 — _engine_supports_inband_tool_calling
# ---------------------------------------------------------------------------


def test_engine_supports_inband_tool_calling_returns_false_when_not_set() -> None:
    """Line 231: when engine has no attribute, defaults to False."""
    engine = _StubEngine()
    # _StubEngine does NOT set supports_inband_tool_calling
    kernel = _make_kernel(engine=engine)

    result = kernel._engine_supports_inband_tool_calling()

    assert result is False


def test_engine_supports_inband_tool_calling_returns_true_when_set() -> None:
    """Line 231: when engine.supports_inband_tool_calling=True, returns True."""
    engine = _StubEngine(supports_inband_tool_calling=True)
    kernel = _make_kernel(engine=engine)

    result = kernel._engine_supports_inband_tool_calling()

    assert result is True


# ---------------------------------------------------------------------------
# Line 235 — _tool_display_name (static)
# ---------------------------------------------------------------------------


def test_tool_display_name_returns_non_empty_string() -> None:
    """The tool catalog returns a human-readable name."""
    result = tool_display_name("read_file")

    # read_file maps to a curated display override in the tool catalog.
    assert result == "Read File", (
        f"Expected catalog display override 'Read File', got {result!r}"
    )
    # A tool name with no override is title-cased and underscores become spaces.
    assert tool_display_name("some_custom_tool") == "Some Custom Tool"


# ---------------------------------------------------------------------------
# Line 374 — _is_direct_deferred_tool_call early return for tool_search
# ---------------------------------------------------------------------------


def test_is_direct_deferred_tool_call_returns_false_for_tool_search() -> None:
    """Line 374: when call.tool_id == TOOL_SEARCH_TOOL_NAME, returns False immediately."""
    kernel = _make_kernel()
    call = ToolCallRequest(
        tool_id=TOOL_SEARCH_TOOL_NAME,
        arguments={},
        call_id="call-ts-1",
    )

    result = kernel._is_direct_deferred_tool_call(call, resolution_context=None)

    assert result is False, (
        f"tool_search must never be classified as a deferred tool call, got {result}"
    )


# ---------------------------------------------------------------------------
# Lines 406-412 — _cache_usage_tokens various branches
# ---------------------------------------------------------------------------


def test_cache_usage_tokens_returns_first_matching_key() -> None:
    """Lines 406-411: first matching key with a positive value is returned."""
    raw_usage = {"prompt_tokens": 42, "completion_tokens": 7}

    result = AgentKernel._cache_usage_tokens(raw_usage, "prompt_tokens", "completion_tokens")

    assert result == 42, f"Expected 42 from first key, got {result}"


def test_cache_usage_tokens_falls_through_to_second_key_on_bad_value() -> None:
    """Lines 409-410: when first key has a non-numeric value, TypeError skips to next key."""
    # "not-a-number" is truthy so `or 0` keeps it; int("not-a-number") raises ValueError
    raw_usage = {"prompt_tokens": "not-a-number", "completion_tokens": 13}

    result = AgentKernel._cache_usage_tokens(raw_usage, "prompt_tokens", "completion_tokens")

    assert result == 13, (
        f"Expected fallthrough to completion_tokens=13 after ValueError on prompt_tokens, got {result}"
    )


def test_cache_usage_tokens_returns_zero_when_no_keys_match() -> None:
    """Line 412: returns 0 when no keys match."""
    raw_usage = {"unrelated_key": 99}

    result = AgentKernel._cache_usage_tokens(raw_usage, "prompt_tokens", "completion_tokens")

    assert result == 0


def test_cache_usage_tokens_skips_unconvertible_value() -> None:
    """Lines 409-410: TypeError/ValueError on conversion is caught; falls to next key."""
    raw_usage = {"cache_read_tokens": "not-a-number", "cache_write_tokens": 5}

    result = AgentKernel._cache_usage_tokens(
        raw_usage, "cache_read_tokens", "cache_write_tokens"
    )

    assert result == 5, (
        f"Expected 5 after skipping non-numeric first key, got {result}"
    )


def test_cache_usage_tokens_clamps_negative_to_zero() -> None:
    """Line 411: max(value, 0) clamps any negative result to 0."""
    # The implementation does int(raw.get(key) or 0) — passing a negative would be clamped
    # We can only get a negative if int() of the value is negative; "or 0" only skips falsy.
    # Use a string that converts to a negative int.
    raw_usage = {"tokens": -10}

    result = AgentKernel._cache_usage_tokens(raw_usage, "tokens")

    assert result == 0, f"Negative token count must be clamped to 0, got {result}"


# ---------------------------------------------------------------------------
# Line 455 — _build_chat_decision
# ---------------------------------------------------------------------------


def test_build_chat_decision_assembles_chat_decision_from_parts() -> None:
    """Line 455: _build_chat_decision returns a ChatDecision with the right fields."""
    from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome

    kernel = _make_kernel()
    working_messages: list[dict[str, object]] = [{"role": "user", "content": "hello"}]

    decision = kernel._build_chat_decision(
        working_messages=working_messages,
        thinking_text="internal plan",
        response_text="Hello there!",
        approval_request=None,
        tool_results=(),
    )

    assert isinstance(decision, ChatDecision)
    assert decision.response_text == "Hello there!"
    assert decision.thinking_text == "internal plan"
    assert decision.approval_request is None
    assert decision.tool_results == ()


# ---------------------------------------------------------------------------
# Line 544 — _attempt_fallback_generation (delegates to generation_runtime)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Line 655 — _classify_run_command_for_approval (delegation)
# ---------------------------------------------------------------------------


def test_classify_run_command_for_approval_returns_none_for_non_run_command() -> None:
    """Any tool other than run_command does not need command classification."""
    kernel = _make_kernel()
    call = ToolCallRequest(
        tool_id="read_file",
        arguments={"path": "README.md"},
        call_id="call-r-1",
    )

    result = tool_execution.classify_run_command_for_approval(
        kernel,
        call,
        descriptor_name="read_file",
    )

    assert result is None, (
        f"Non-run_command descriptor must yield None, got {result!r}"
    )


# ---------------------------------------------------------------------------
# Line 658 — _normalize_snapshot_lookup_path (delegation)
# ---------------------------------------------------------------------------


def test_normalize_snapshot_lookup_path_normalises_relative_path() -> None:
    """The snapshot owner returns a posix-normalized relative path."""
    kernel = _make_kernel()

    result = tool_execution_snapshots.normalize_snapshot_lookup_path(kernel, "src/main.py")

    assert result == "src/main.py", f"Expected 'src/main.py', got {result!r}"


def test_normalize_snapshot_lookup_path_returns_none_for_empty() -> None:
    """An empty snapshot path returns None."""
    kernel = _make_kernel()

    result = tool_execution_snapshots.normalize_snapshot_lookup_path(kernel, "")

    assert result is None


# ---------------------------------------------------------------------------
# Line 689 — _inject_expected_read_snapshot (delegation)
# ---------------------------------------------------------------------------


def test_inject_expected_read_snapshot_passes_through_for_non_write_tool() -> None:
    """Non-mutation tool arguments pass through unchanged."""
    kernel = _make_kernel()
    original_args = {"path": "README.md"}

    result = tool_execution_snapshots.inject_expected_read_snapshot(
        kernel,
        tool_name="read_file",
        tool_arguments=original_args,
        read_snapshot_cache={},
    )

    assert result is original_args, (
        "read_file must receive its arguments unchanged (same object)"
    )


# ---------------------------------------------------------------------------
# Line 717 — _tool_outcome_from_handler_result (delegation)
# ---------------------------------------------------------------------------


def test_tool_outcome_from_handler_result_wraps_string_result() -> None:
    """The tool-execution owner wraps a handler result as an outcome."""
    from sidecar.ai.routing.router import ToolExecutionOutcome

    from sidecar.ai.tools.contracts import ToolHandlerResult

    outcome = tool_execution.tool_outcome_from_handler_result(
        "read_file",
        ToolHandlerResult(output="file contents here", success=True),
        tool_input={"path": "README.md"},
    )

    assert isinstance(outcome, ToolExecutionOutcome)
    assert outcome.tool_name == "read_file"
    assert outcome.success is True
    assert "file contents here" in outcome.output


# ---------------------------------------------------------------------------
# Line 733 — _schema_placeholder_value (static delegation)
# ---------------------------------------------------------------------------


def test_schema_placeholder_value_returns_scalar_placeholder_for_string_type() -> None:
    """A string schema uses the '<string>' scalar placeholder."""
    schema = {"type": "string"}

    result = schema_placeholder_value(schema)

    assert result == "<string>", (
        f"Expected the '<string>' scalar placeholder for a string schema, got {result!r}"
    )
    # A boolean schema must map to a different scalar placeholder (False), proving the
    # type-keyed lookup actually depends on the schema 'type'.
    assert schema_placeholder_value({"type": "boolean"}) is False


def test_schema_placeholder_value_handles_none_schema() -> None:
    """None falls through to the untyped '<value>' placeholder."""
    result = schema_placeholder_value(None)

    # None is coerced to an empty dict with no 'type', so the fallthrough token applies.
    assert result == "<value>", (
        f"Expected the untyped fallthrough placeholder '<value>', got {result!r}"
    )


# ---------------------------------------------------------------------------
# Line 737 — _tool_schema_repair_hints (@classmethod delegation)
# ---------------------------------------------------------------------------


def test_tool_schema_repair_hints_returns_dict() -> None:
    """Hints expose required keys and minimal valid arguments."""
    schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    }

    hints = tool_schema_repair_hints(schema)

    assert hints["required_keys"] == ["path"], (
        f"Expected required_keys to mirror the schema's required list, got {hints!r}"
    )
    # The minimal valid arguments must fill the required key with the scalar placeholder
    # derived from its sub-schema type (string -> '<string>').
    assert hints["minimal_valid_arguments"] == {"path": "<string>"}


def test_tool_schema_repair_hints_none_schema_returns_dict() -> None:
    """None input yields empty required keys and minimal arguments."""
    hints = tool_schema_repair_hints(None)

    assert hints == {"required_keys": [], "minimal_valid_arguments": {}}, (
        f"Expected empty-hint shape for a None schema, got {hints!r}"
    )


# ---------------------------------------------------------------------------
# Line 741 — _tool_schema_hint_text (static delegation)
# ---------------------------------------------------------------------------


def test_tool_schema_hint_text_renders_required_keys_and_arguments() -> None:
    """Populated hints render a readable string naming required keys."""
    hints: dict[str, object] = {
        "required_keys": ["path"],
        "minimal_valid_arguments": {"path": "<string>"},
    }

    text = tool_schema_hint_text(hints)

    assert "Required keys: path" in text, (
        f"Expected the required key to be named in the hint text, got {text!r}"
    )
    # The minimal valid arguments JSON must be embedded so a model can copy it verbatim.
    assert '{"path": "<string>"}' in text


def test_tool_schema_hint_text_empty_hints_returns_empty_string() -> None:
    """Empty hints yield exactly the empty string."""
    text = tool_schema_hint_text({})

    assert text == "", f"Empty hints must produce the empty string, got {text!r}"


# ---------------------------------------------------------------------------
# Line 741 — _system_prompt_for_engine: StructuredSystemPrompt branch
# ---------------------------------------------------------------------------


def test_system_prompt_for_engine_converts_structured_to_text() -> None:
    """Line 401: StructuredSystemPrompt is converted via .to_text()."""
    from sidecar.ai.context.prompt_cache import CacheSection

    kernel = _make_kernel()
    structured = StructuredSystemPrompt(
        sections=(
            CacheSection(
                name="identity",
                content="You are a helpful assistant.",
                cacheable=True,
            ),
        )
    )

    result = kernel._system_prompt_for_engine(structured)

    assert isinstance(result, str)
    assert "You are a helpful assistant." in result
    assert not isinstance(result, StructuredSystemPrompt), (
        "Result must be a plain str, not a StructuredSystemPrompt"
    )


def test_system_prompt_for_engine_plain_string_passes_through() -> None:
    """Line 402: plain string input is returned as-is (as str)."""
    kernel = _make_kernel()
    plain = "You are a desktop AI assistant."

    result = kernel._system_prompt_for_engine(plain)

    assert result == plain


# ---------------------------------------------------------------------------
# Line 330-340 — _log_missing_current_info_tool_use early-return paths
# ---------------------------------------------------------------------------


def test_log_missing_current_info_early_return_not_current_info(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Line 332: returns early without logging when content is not a current-info request."""
    from sidecar.ai.routing.router import ToolExecutionOutcome

    captured: list[Any] = []
    monkeypatch.setattr("sidecar.ai.routing.router.log_event", lambda *a, **kw: captured.append(kw))

    kernel = _make_kernel()
    web_status = RuntimeToolStatus(
        name="web_search",
        display_name="Web Search",
        available=True,
    )

    kernel._log_missing_current_info_tool_use(
        request_id="req-not-current",
        latest_user_content="Please write a poem about cats.",
        tool_statuses=(web_status,),
        tool_results=[],
    )

    # Non-current-info query must NOT trigger the warning event
    warning_events = [e for e in captured if e.get("event") == "ai.router.current_info_without_tool_call"]
    assert len(warning_events) == 0, (
        "Must not log current_info_without_tool_call for a non-current-info request"
    )


def test_log_missing_current_info_early_return_when_tool_results_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Line 334: returns early without logging when tool_results is non-empty."""
    from sidecar.ai.routing.router import ToolExecutionOutcome

    captured: list[Any] = []
    monkeypatch.setattr("sidecar.ai.routing.router.log_event", lambda *a, **kw: captured.append(kw))

    kernel = _make_kernel()
    web_status = RuntimeToolStatus(name="web_search", display_name="Web Search", available=True)
    fake_result = ToolExecutionOutcome(
        tool_name="web_search",
        output="results",
        success=True,
    )

    kernel._log_missing_current_info_tool_use(
        request_id="req-has-results",
        latest_user_content="What is the weather today?",
        tool_statuses=(web_status,),
        tool_results=[fake_result],
    )

    warning_events = [
        e for e in captured
        if e.get("event") == "ai.router.current_info_without_tool_call"
    ]
    assert len(warning_events) == 0, (
        "Must not log current_info_without_tool_call when tool_results is non-empty"
    )


# ---------------------------------------------------------------------------
# _cache_source_key with session_id present
# ---------------------------------------------------------------------------


def test_cache_source_key_uses_session_id_when_present() -> None:
    """Line 360-361: when session_id is set, it is returned as the cache key."""
    result = AgentKernel._cache_source_key(
        request_id="req-abc",
        session_id="sess-xyz",
    )

    assert result == "sess-xyz", (
        f"Expected session_id to be returned as cache key, got {result!r}"
    )


def test_cache_source_key_falls_back_to_request_id() -> None:
    """Line 362: when session_id is None, request_id is returned."""
    result = AgentKernel._cache_source_key(
        request_id="req-fallback",
        session_id=None,
    )

    assert result == "req-fallback"


# ---------------------------------------------------------------------------
# _remaining_deferred_names
# ---------------------------------------------------------------------------


def test_remaining_deferred_names_returns_empty_frozenset_for_none_context() -> None:
    """Line 717 (map): with None resolution_context returns an empty frozenset."""
    result = AgentKernel._remaining_deferred_names(None)

    assert isinstance(result, frozenset)
    assert len(result) == 0


# ---------------------------------------------------------------------------
# _build_deferred_outcome (line 380-394)
# ---------------------------------------------------------------------------


def test_build_deferred_outcome_contains_correct_error_fields() -> None:
    """Lines 380-394: _build_deferred_outcome sets error_code and metadata correctly."""
    from sidecar.ai.routing.router import ToolExecutionOutcome

    call = ToolCallRequest(
        tool_id="some_hidden_tool",
        arguments={"x": "value"},
        call_id="call-def-1",
    )

    outcome = AgentKernel._build_deferred_outcome(call)

    assert isinstance(outcome, ToolExecutionOutcome)
    assert outcome.tool_name == "some_hidden_tool"
    assert outcome.success is False
    assert outcome.error_code == CMP_TSRCH_DEFERRED_TOOL, (
        f"Expected CMP_TSRCH_DEFERRED_TOOL error code, got {outcome.error_code!r}"
    )
    assert outcome.metadata.get("deferred") is True
    assert outcome.metadata.get("tool_search_required") is True
    assert "some_hidden_tool" in outcome.output
    assert outcome.call_id == "call-def-1"
