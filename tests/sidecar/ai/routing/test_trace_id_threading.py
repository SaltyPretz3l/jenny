"""Red-first contract for W0 trace-id threading (tool-contract program).

``LoopRuntime.trace_id`` already exists but never reaches a tool call. W0
threads it to builtin dispatch as ``_jenny_trace_id`` carrying the per-call
token ``f"{trace_id}.{call_id}"`` — injected at the dispatch seam (after
``freeze_effective_execution_inputs``), so approval fingerprints and the
frozen execution snapshot are untouched, and scoped to non-MCP descriptors so
external servers never receive surprise ``_jenny_*`` keys.
"""

from __future__ import annotations

from dataclasses import dataclass

from sidecar.ai.routing.tool_execution import inject_dispatch_trace_id
from sidecar.ai.routing.tool_observation import tool_argument_fingerprint
from sidecar.ai.tools.models import ToolCallRequest


@dataclass
class _Descriptor:
    source_kind: str = "builtin"


@dataclass
class _Runtime:
    trace_id: str = ""


def _call(call_id: str = "call_7") -> ToolCallRequest:
    return ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}, call_id=call_id)


def test_builtin_dispatch_gains_the_per_call_token() -> None:
    args: dict[str, object] = {"path": "a.txt"}
    out = inject_dispatch_trace_id(
        args,
        descriptor=_Descriptor(source_kind="builtin"),
        runtime=_Runtime(trace_id="trace_abc"),
        call=_call("call_7"),
    )
    assert out["_jenny_trace_id"] == "trace_abc.call_7"
    assert out["path"] == "a.txt"


def test_mcp_descriptor_is_never_injected() -> None:
    out = inject_dispatch_trace_id(
        {"path": "a.txt"},
        descriptor=_Descriptor(source_kind="mcp"),
        runtime=_Runtime(trace_id="trace_abc"),
        call=_call(),
    )
    assert "_jenny_trace_id" not in out


def test_missing_trace_or_call_id_or_descriptor_is_a_noop() -> None:
    assert "_jenny_trace_id" not in inject_dispatch_trace_id(
        {"path": "a.txt"},
        descriptor=_Descriptor(),
        runtime=_Runtime(trace_id=""),
        call=_call(),
    )
    assert "_jenny_trace_id" not in inject_dispatch_trace_id(
        {"path": "a.txt"},
        descriptor=_Descriptor(),
        runtime=_Runtime(trace_id="trace_abc"),
        call=_call(call_id=""),
    )
    assert "_jenny_trace_id" not in inject_dispatch_trace_id(
        {"path": "a.txt"},
        descriptor=None,
        runtime=_Runtime(trace_id="trace_abc"),
        call=_call(),
    )
    assert "_jenny_trace_id" not in inject_dispatch_trace_id(
        {"path": "a.txt"},
        descriptor=_Descriptor(),
        runtime=None,
        call=_call(),
    )


def test_trace_id_never_perturbs_observation_fingerprints() -> None:
    base = {"path": "a.txt"}
    with_trace = {"path": "a.txt", "_jenny_trace_id": "trace_abc.call_7"}
    other_trace = {"path": "a.txt", "_jenny_trace_id": "trace_zzz.call_9"}
    assert tool_argument_fingerprint(base) == tool_argument_fingerprint(with_trace)
    assert tool_argument_fingerprint(with_trace) == tool_argument_fingerprint(other_trace)
