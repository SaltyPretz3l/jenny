"""Pre-dispatch guard against models echoing the schema example placeholders.

A local 27B model copied the ``build_tool_use_nudge`` worked example verbatim
and emitted a real, structurally valid mutating call carrying a placeholder.
The loop created a pre-mutation git auto-checkpoint
and dispatched it.  These tests pin the guard that settles such a call before
``maybe_create_auto_checkpoint`` ever sees it.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED
from sidecar.ai.routing import auto_checkpoint as _auto_checkpoint
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import pre_filter_tool_calls
from sidecar.ai.routing.tool_execution_results import tool_result_message
from sidecar.ai.tools import schema_examples as _tools_schema_examples
from sidecar.ai.tools.models import ToolCallRequest

_EDIT_FILE_SCHEMA = {
    "type": "object",
    "properties": {"file_path": {"type": "string"}},
    "required": ["file_path"],
}


def _call(tool_id: str, arguments: dict[str, Any]) -> ToolCallRequest:
    return ToolCallRequest(
        tool_id=tool_id,
        arguments=arguments,
        call_id=f"call-{tool_id}",
    )


def _entry(name: str, *, side_effecting: bool, input_schema: dict[str, Any] | None) -> Any:
    return SimpleNamespace(
        descriptor=SimpleNamespace(
            name=name,
            side_effecting=side_effecting,
            input_schema=input_schema,
        ),
        available=True,
        reason=None,
        deferred=False,
    )


class _Contract:
    def __init__(self, entries: dict[str, Any]) -> None:
        self.entries = entries

    def entry(self, name: str) -> Any | None:
        return self.entries.get(name)


class _Kernel:
    def __init__(self) -> None:
        self._mcp_client = SimpleNamespace(tool_descriptor=lambda _name: None)

    def _assert_valid_tool_call(self, _call: ToolCallRequest) -> None:
        return

    def _assistant_tool_call_message(
        self,
        _result: Any,
        call: ToolCallRequest,
    ) -> dict[str, object]:
        return {"role": "assistant", "tool": call.tool_id}

    def _tool_result_message(
        self,
        call: ToolCallRequest,
        outcome: ToolExecutionOutcome,
    ) -> dict[str, object]:
        return tool_result_message(call, outcome)


def _prefilter(
    call: ToolCallRequest,
    *,
    tool_contract: Any | None = None,
) -> tuple[list[tuple[Any, int]], list[ToolExecutionOutcome], list[dict[str, object]]]:
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req-1",
        session_id="session-1",
        streaming=False,
        tool_call_limit=20,
    )
    outcomes: list[ToolExecutionOutcome] = []
    messages: list[dict[str, object]] = []
    remaining, _index = pre_filter_tool_calls(
        [call],
        kernel=_Kernel(),
        runtime=runtime,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        tool_contract=tool_contract,
        outcomes=outcomes,
        working_messages=messages,
        iteration_calls=[],
        streamed_event_types=set(),
        outcome_index=0,
    )
    return remaining, outcomes, messages


def _edit_file_contract() -> _Contract:
    return _Contract(
        {
            "edit_file": _entry(
                "edit_file",
                side_effecting=True,
                input_schema=_EDIT_FILE_SCHEMA,
            )
        }
    )


def test_schema_example_echo_is_settled_without_dispatch() -> None:
    remaining, outcomes, messages = _prefilter(
        _call("edit_file", {"file_path": "<string>"}),
        tool_contract=_edit_file_contract(),
    )

    assert remaining == []
    assert len(outcomes) == 1
    assert outcomes[0].error_code == CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED
    assert outcomes[0].success is False
    assert "schema example placeholders" in outcomes[0].output
    assert outcomes[0].metadata["placeholder_arguments_rejected"] is True
    assert outcomes[0].metadata["reason"] == "schema_example_echo"
    tool_messages = [message for message in messages if message.get("role") == "tool"]
    assert tool_messages[0]["is_error"] is True
    assert tool_messages[0]["error_code"] == CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED


def test_real_arguments_pass_through_untouched() -> None:
    call = _call("edit_file", {"file_path": "sample.txt"})

    remaining, outcomes, _messages = _prefilter(call, tool_contract=_edit_file_contract())

    assert remaining == [(call, 1)]
    assert outcomes == []


def test_partial_placeholder_argument_is_rejected() -> None:
    """Only one of several arguments needs to be the placeholder literal."""
    schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}, "contents": {"type": "string"}},
        "required": ["path", "contents"],
    }
    contract = _Contract(
        {"write_file": _entry("write_file", side_effecting=True, input_schema=schema)}
    )

    remaining, outcomes, _messages = _prefilter(
        _call("write_file", {"path": "notes.md", "contents": "<string>"}),
        tool_contract=contract,
    )

    assert remaining == []
    assert outcomes[0].error_code == CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED
    assert outcomes[0].metadata["reason"] == "placeholder_literal"


_GREP_SEARCH_SCHEMA = {
    "type": "object",
    "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}},
    "required": ["pattern"],
}


def _grep_search_contract() -> _Contract:
    return _Contract(
        {
            "grep_search": _entry(
                "grep_search",
                side_effecting=False,
                input_schema=_GREP_SEARCH_SCHEMA,
            )
        }
    )


def test_read_only_tool_may_search_for_a_placeholder_shaped_literal() -> None:
    """``<string>`` is a real thing to grep for in a plist/XML/Obj-C tree.

    The literal rule is scoped to side-effecting (and descriptor-less) tools
    precisely so this search stays executable; a blanket rule would leave the
    model no way to run it at all."""
    call = _call("grep_search", {"pattern": "<string>", "path": "Info.plist"})

    remaining, outcomes, _messages = _prefilter(call, tool_contract=_grep_search_contract())

    assert remaining == [(call, 1)]
    assert outcomes == []


def test_read_only_tool_echoing_its_own_marker_example_is_still_rejected() -> None:
    """The echo rule is not narrowed: arguments byte-identical to the tool's own
    marker-bearing minimal example are the nudge example, not a real search."""
    assert _tools_schema_examples.minimal_valid_arguments(_GREP_SEARCH_SCHEMA) == {
        "pattern": "<string>"
    }

    remaining, outcomes, _messages = _prefilter(
        _call("grep_search", {"pattern": "<string>"}),
        tool_contract=_grep_search_contract(),
    )

    assert remaining == []
    assert outcomes[0].error_code == CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED
    assert outcomes[0].metadata["reason"] == "schema_example_echo"


def test_side_effecting_tool_with_placeholder_literal_is_still_rejected() -> None:
    """Negative control for the narrowing: the incident tool is unaffected."""
    remaining, outcomes, _messages = _prefilter(
        _call("edit_file", {"file_path": "<string>", "cwd": "repo"}),
        tool_contract=_edit_file_contract(),
    )

    assert remaining == []
    assert outcomes[0].error_code == CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED
    assert outcomes[0].metadata["reason"] == "placeholder_literal"


def test_schemaless_tool_with_placeholder_literal_is_still_rejected() -> None:
    """No contract entry and no descriptor: the literal rule still applies."""
    remaining, outcomes, _messages = _prefilter(_call("legacy_tool", {"path": "<string>"}))

    assert remaining == []
    assert outcomes[0].error_code == CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED
    assert outcomes[0].metadata["reason"] == "placeholder_literal"


def test_nested_placeholder_literal_is_rejected() -> None:
    remaining, outcomes, _messages = _prefilter(
        _call("legacy_tool", {"options": {"paths": ["<string>"]}})
    )

    assert remaining == []
    assert outcomes[0].error_code == CMP_TOOL_PLACEHOLDER_ARGUMENTS_REJECTED


def test_enum_derived_minimal_example_is_not_treated_as_a_placeholder() -> None:
    """A minimal example built only from the schema's own enum is a real call.

    ``home`` really does generate ``{"action": "calendar_list"}`` as its
    minimal example, and that is exactly what a legitimate call looks like.
    """
    schema = {
        "type": "object",
        "properties": {"action": {"type": "string", "enum": ["calendar_list", "daybook_read"]}},
        "required": ["action"],
    }
    contract = _Contract({"home": _entry("home", side_effecting=False, input_schema=schema)})
    call = _call("home", {"action": "calendar_list"})

    remaining, outcomes, _messages = _prefilter(call, tool_contract=contract)

    assert remaining == [(call, 1)]
    assert outcomes == []


def test_empty_arguments_are_not_treated_as_placeholders() -> None:
    schema: dict[str, Any] = {"type": "object", "properties": {}, "required": []}
    contract = _Contract(
        {"jenny_status": _entry("jenny_status", side_effecting=False, input_schema=schema)}
    )
    call = _call("jenny_status", {})

    remaining, outcomes, _messages = _prefilter(call, tool_contract=contract)

    assert remaining == [(call, 1)]
    assert outcomes == []


def _loop_run() -> Any:
    return SimpleNamespace(
        checkpoint_created=False,
        session_id="session-1",
        request_id="req-1",
        runtime=SimpleNamespace(raise_if_interrupted=lambda: None),
        kernel=SimpleNamespace(
            _config=SimpleNamespace(feature_flags={"auto_checkpoint": True}),
        ),
    )


def test_placeholder_rejected_call_never_reaches_the_auto_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested: list[Any] = []

    def _record(loop_run: Any) -> None:
        requested.append(loop_run)

    monkeypatch.setattr(_auto_checkpoint, "_request_checkpoint", _record)

    remaining, _outcomes, _messages = _prefilter(
        _call("edit_file", {"file_path": "<string>"}),
        tool_contract=_edit_file_contract(),
    )
    _auto_checkpoint.maybe_create_auto_checkpoint(_loop_run(), remaining)

    assert remaining == []
    assert requested == []


def test_real_mutating_call_still_reaches_the_auto_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Negative control: the guard above is not vacuous."""
    requested: list[Any] = []

    def _record(loop_run: Any) -> None:
        requested.append(loop_run)

    monkeypatch.setattr(_auto_checkpoint, "_request_checkpoint", _record)

    remaining, _outcomes, _messages = _prefilter(
        _call("edit_file", {"file_path": "sample.txt"}),
        tool_contract=_edit_file_contract(),
    )
    _auto_checkpoint.maybe_create_auto_checkpoint(_loop_run(), remaining)

    assert len(remaining) == 1
    assert len(requested) == 1
