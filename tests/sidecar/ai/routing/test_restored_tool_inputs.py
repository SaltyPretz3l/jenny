from __future__ import annotations

import copy
import hashlib
import json
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.mcp.models import MCPToolDescriptor, MCPToolResult
from sidecar.ai.routing import tool_execution as tool_execution_module
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.resource_pressure import PressureBackoffDecision
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.routing.tool_execution import execute_tool
from sidecar.ai.routing.tool_execution_snapshots import freeze_effective_execution_inputs
from sidecar.ai.routing.tool_restored_inputs import (
    MAX_RESTORED_TOOL_INPUT_BYTES,
    RestoredToolInputError,
    RestoredToolInputs,
)
from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.approval_plan import stable_hash


def _visible_arguments() -> dict[str, Any]:
    return {
        "label": "Ω",
        "nested": {"ratio": 1.0},
        "threshold": 1e-7,
    }


def _frozen_value() -> dict[str, Any]:
    visible = _visible_arguments()
    effective = copy.deepcopy(visible)
    return {
        "call_id": "call_1",
        "effective_args_fingerprint": stable_hash(effective),
        "effective_tool_arguments": effective,
        "execution_context_payload": {
            "authority_revision": "authority_old",
            "logical_turn_id": "turn_1",
            "project_id": "project_1",
            "root_id": "root_1",
            "root_revision": 7,
            "session_id": "session_1",
        },
        "injected_arg_keys": [],
        "tool_name": "custom_tool",
        "visible_tool_arguments": visible,
    }


def _encode(value: dict[str, Any]) -> tuple[bytes, str]:
    body = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return body, hashlib.sha256(body).hexdigest()


def _restored(value: dict[str, Any] | None = None) -> RestoredToolInputs:
    body, digest = _encode(value or _frozen_value())
    return RestoredToolInputs.from_canonical_bytes(body, digest)


def _call(**changes: Any) -> ToolCallRequest:
    values = {
        "tool_id": "custom_tool",
        "arguments": _visible_arguments(),
        "call_id": "call_1",
    }
    values.update(changes)
    return ToolCallRequest(**values)


def _context(**changes: Any) -> SimpleNamespace:
    values = {
        "authority_revision": "authority_current",
        "project_id": "project_1",
        "root_id": "root_1",
        "root_revision": 7,
    }
    values.update(changes)
    return SimpleNamespace(**values)


def test_restored_input_preserves_exact_python_bytes_and_rebinds_only_authority() -> None:
    body, digest = _encode(_frozen_value())
    restored = RestoredToolInputs.from_canonical_bytes(body, digest)

    assert restored.canonical_bytes is body
    assert b'"ratio":1.0' in restored.canonical_bytes
    assert b'"threshold":1e-07' in restored.canonical_bytes
    assert b'"label":"\\u03a9"' in restored.canonical_bytes

    rebound = restored.bind_for_attempt(
        call=_call(),
        session_id="session_1",
        logical_turn_id="turn_1",
        execution_context=_context(),
    )

    source = restored.source_frozen_inputs()
    assert rebound.effective_tool_arguments == source.effective_tool_arguments
    assert rebound.effective_args_fingerprint == source.effective_args_fingerprint
    assert rebound.execution_context_payload == {
        **source.execution_context_payload,
        "authority_revision": "authority_current",
    }
    assert rebound.effective_tool_arguments["nested"]["ratio"] == 1.0


def test_restored_input_views_are_fresh_and_cannot_mutate_retained_source() -> None:
    restored = _restored()
    first = restored.source_frozen_inputs()
    first.visible_tool_arguments["nested"]["ratio"] = 9
    first.execution_context_payload["authority_revision"] = "forged"

    second = restored.source_frozen_inputs()

    assert second.visible_tool_arguments["nested"]["ratio"] == 1.0
    assert second.execution_context_payload["authority_revision"] == "authority_old"


def test_original_freeze_records_logical_turn_without_synthesizing_model_arguments() -> None:
    frozen = freeze_effective_execution_inputs(
        SimpleNamespace(_mcp_client=None),
        _call(),
        session_id="session_1",
        read_snapshot_cache={},
        turn_id="turn_1",
        execution_context=_context(authority_revision="authority_old"),
    )

    assert frozen.execution_context_payload["logical_turn_id"] == "turn_1"
    assert frozen.effective_tool_arguments == _visible_arguments()
    assert "_jenny_turn_id" not in frozen.effective_tool_arguments


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update(extra=True),
        lambda value: value["execution_context_payload"].update(extra=True),
        lambda value: value.update(effective_args_fingerprint="0" * 64),
        lambda value: value.update(call_id="bad call"),
        lambda value: value["execution_context_payload"].update(logical_turn_id=""),
        lambda value: value["execution_context_payload"].update(root_revision=True),
        lambda value: value["effective_tool_arguments"].update(hidden="forged"),
        lambda value: value["injected_arg_keys"].append("unknown_private_key"),
    ],
)
def test_restored_input_rejects_malformed_canonical_values(mutation: Any) -> None:
    value = _frozen_value()
    mutation(value)
    body, digest = _encode(value)

    with pytest.raises(RestoredToolInputError):
        RestoredToolInputs.from_canonical_bytes(body, digest)


def test_restored_input_rejects_noncanonical_duplicate_nonfinite_and_oversize_bytes() -> None:
    canonical, _digest = _encode(_frozen_value())
    variants = [
        b" " + canonical,
        b'{"call_id":"call_1",' + canonical[1:],
        canonical.replace(b"1e-07", b"NaN"),
        b"{" + (b" " * MAX_RESTORED_TOOL_INPUT_BYTES) + b"}",
    ]

    for body in variants:
        with pytest.raises(RestoredToolInputError):
            RestoredToolInputs.from_canonical_bytes(
                body, hashlib.sha256(body).hexdigest()
            )
    with pytest.raises(RestoredToolInputError):
        RestoredToolInputs.from_canonical_bytes(canonical, "0" * 64)


@pytest.mark.parametrize(
    ("call", "session_id", "logical_turn_id", "context"),
    [
        (_call(call_id="call_2"), "session_1", "turn_1", _context()),
        (_call(tool_id="other_tool"), "session_1", "turn_1", _context()),
        (_call(arguments={"label": "changed"}), "session_1", "turn_1", _context()),
        (
            _call(arguments={**_visible_arguments(), "nested": {"ratio": 1}}),
            "session_1", "turn_1", _context(),
        ),
        (_call(), "session_2", "turn_1", _context()),
        (_call(), "session_1", "turn_2", _context()),
        (_call(), "session_1", "turn_1", _context(project_id="project_2")),
        (_call(), "session_1", "turn_1", _context(root_id="root_2")),
        (_call(), "session_1", "turn_1", _context(root_revision=8)),
        (_call(), "session_1", "turn_1", _context(authority_revision="")),
    ],
)
def test_restored_input_rejects_foreign_or_stale_scope(
    call: ToolCallRequest,
    session_id: str,
    logical_turn_id: str,
    context: SimpleNamespace,
) -> None:
    with pytest.raises(RestoredToolInputError):
        _restored().bind_for_attempt(
            call=call,
            session_id=session_id,
            logical_turn_id=logical_turn_id,
            execution_context=context,
        )


class _Lease:
    def __init__(self, events: list[Any]) -> None:
        self.events = events

    def settle(self, status: str, cleanup: str) -> None:
        self.events.append(("settle", status, cleanup))


class _Admission:
    def __init__(self, events: list[Any]) -> None:
        self.events = events

    def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.events.append(("policy", kwargs))
        return {"schema_version": 1, "authority_revision": "authority_current"}

    def acquire_resource(self, **kwargs: Any) -> _Lease:
        self.events.append(("resource", kwargs))
        return _Lease(self.events)


class _Client:
    def __init__(self, events: list[Any]) -> None:
        self.events = events
        self.descriptor = MCPToolDescriptor(
            name="custom_tool",
            description="test",
            input_schema={
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "nested": {"type": "object"},
                    "threshold": {"type": "number"},
                },
                "required": ["label", "nested", "threshold"],
                "additionalProperties": False,
            },
            side_effecting=False,
            server_name=BUILTIN_MCP_SERVER_NAME,
        )

    def tool_descriptor(self, _tool_name: str) -> MCPToolDescriptor:
        return self.descriptor

    def execute_tool(self, tool_name: str, arguments: dict[str, Any], **_kwargs: Any) -> Any:
        self.events.append(("execute", tool_name, copy.deepcopy(arguments)))
        return MCPToolResult(tool_name=tool_name, output="ok", success=True)


def test_execute_tool_uses_restored_input_and_reruns_authority_and_resource_checks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[Any] = []
    client = _Client(events)
    admission = _Admission(events)
    runtime = LoopRuntime(
        request_id="stream_fresh",
        logical_turn_id="turn_1",
        session_id="session_1",
        operation_admission=admission,
    )
    runtime.request_context = SimpleNamespace(
        execution_context=_context(),
        plan_mode=False,
        read_only=False,
        approved_plan=None,
    )
    monkeypatch.setattr(
        tool_execution_module,
        "freeze_effective_execution_inputs",
        lambda *_args, **_kwargs: pytest.fail("restored input was recomputed"),
    )
    monkeypatch.setattr(
        tool_execution_module,
        "build_tool_pressure_backoff_decision",
        lambda **_kwargs: PressureBackoffDecision(False, 0.0, "none", (), {}),
    )

    outcome = execute_tool(
        SimpleNamespace(_config=RuntimeConfig(), _mcp_client=client),
        _call(),
        request_id="stream_fresh",
        session_id="session_1",
        read_snapshot_cache={},
        runtime=runtime,
        restored_inputs=_restored(),
    )

    assert outcome.success is True
    assert [event[0] for event in events] == ["policy", "resource", "execute", "settle"]
    assert events[0][1]["arguments"] == _visible_arguments()
    assert events[1][1]["arguments"] == _visible_arguments()
    dispatched = events[2][2]
    assert dispatched["nested"]["ratio"] == 1.0
    assert dispatched["_jenny_execution_context"]["authority_revision"] == (
        "authority_current"
    )


class _SequentialKernel:
    def __init__(self) -> None:
        self._config = RuntimeConfig()
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def _execute_tool(self, call: ToolCallRequest, **kwargs: Any) -> ToolExecutionOutcome:
        self.calls.append((call.call_id, kwargs))
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output="ok",
            success=True,
            tool_input=dict(call.arguments),
            call_id=call.call_id,
        )

    def _assistant_tool_call_message(self, _result: Any, _call: Any) -> dict[str, Any]:
        return {"role": "assistant"}

    def _tool_result_message(self, _call: Any, _result: Any) -> dict[str, Any]:
        return {"role": "tool"}

    def _update_read_snapshot_cache(self, *_args: Any, **_kwargs: Any) -> None:
        return


def test_sequential_boundary_forwards_restored_input_to_first_call_only_without_reserving() -> None:
    kernel = _SequentialKernel()
    runtime = LoopRuntime(
        request_id="stream_fresh",
        logical_turn_id="turn_1",
        session_id="session_1",
        tool_call_limit=4,
        tool_calls_consumed=2,
    )
    calls = [_call(), _call(call_id="call_2")]

    execute_tool_calls_sequentially(
        indexed_calls=[(calls[0], 1), (calls[1], 2)],
        runtime=runtime,
        kernel=kernel,
        result=SimpleNamespace(),
        request_id="stream_fresh",
        session_id="session_1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=[],
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=[],
        restored_first_input=_restored(),
    )

    assert kernel.calls[0][1]["restored_inputs"].source_sha256 == _restored().source_sha256
    assert "restored_inputs" not in kernel.calls[1][1]
    assert runtime.tool_calls_consumed == 2


def test_restored_input_cannot_be_silently_attached_to_tool_search() -> None:
    with pytest.raises(
        RestoredToolInputError, match="restored_tool_input_has_no_dispatch_target"
    ):
        execute_tool_calls_sequentially(
            indexed_calls=[(_call(tool_id="tool_search"), 1)],
            runtime=LoopRuntime(),
            kernel=_SequentialKernel(),
            result=SimpleNamespace(),
            request_id="stream_fresh",
            session_id="session_1",
            tool_resolution_context=None,
            read_snapshot_cache={},
            outcomes=[],
            working_messages=[],
            iteration_calls=[],
            streamed_event_types=set(),
            tool_payload_ref=[],
            restored_first_input=_restored(),
        )
