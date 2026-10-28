"""A legacy bare external MCP name cannot bypass the request tool contract (C2 #1, C2 #2).

The MCP client resolves ``lookup`` to ``mcp__remote_docs__lookup``; the contract
is keyed by the namespaced name, so a bare-name call used to skip request
preferences, Plan/read-only blocking and offline lockdown and dispatch anyway.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.mcp.transport_base import MCPTransport
from sidecar.ai.routing import tool_call_execution as tce
from sidecar.ai.routing import tool_execution as te
from sidecar.ai.routing import tool_resolution as tr
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime import turn_state
from sidecar.runtime.chat_models import ChatRequestContext

NAMESPACED = "mcp__remote_docs__lookup"


class _Transport(MCPTransport):
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    @property
    def server_name(self) -> str:
        return "remote_docs"

    def list_tools(self, *, cancel_handle=None):
        return [
            {
                "name": "lookup",
                "description": "Look up docs.",
                "input_schema": {"type": "object"},
                "side_effecting": False,
            }
        ]

    def call_tool(self, tool_name, arguments, *, timeout_seconds=None, cancel_handle=None):
        self.calls.append((tool_name, dict(arguments)))
        return {"content": [{"type": "text", "text": "EXECUTED"}]}

    def list_resources(self, **_kwargs):
        return {"resources": []}

    def read_resource(self, uri, **_kwargs):
        return {"contents": []}

    def list_resource_templates(self, **_kwargs):
        return {"resourceTemplates": []}

    def list_prompts(self, **_kwargs):
        return []

    def get_prompt(self, *_args, **_kwargs):
        raise NotImplementedError

    def close(self) -> None:
        return None


def _kernel_and_contract() -> tuple[Any, Any, _Transport]:
    client = MCPClient()
    transport = _Transport()
    client._register_transport(transport)
    config = RuntimeConfig()
    kernel = SimpleNamespace(
        _config=config,
        _mcp_client=client,
        _engine=SimpleNamespace(supports_tool_calling=True, supports_inband_tool_calling=False),
    )
    request_context = ChatRequestContext(
        request_id="r",
        trace_id=None,
        session_id=None,
        mode=config.mode,
        approvals_pre_granted=True,
        tool_preferences={"disabled_tools": (NAMESPACED,)},
        workspace_root_present=False,
    )
    contract = tr.assemble_tool_contract(kernel, request_context=request_context)
    assert contract.entry(NAMESPACED) is not None
    assert contract.entry(NAMESPACED).available is False
    assert contract.entry("lookup") is None
    assert client.tool_descriptor("lookup").name == NAMESPACED
    return kernel, contract, transport


def test_contract_entry_for_call_resolves_the_bare_name_to_the_namespaced_entry() -> None:
    kernel, contract, _transport = _kernel_and_contract()

    entry, descriptor = tr.contract_entry_for_call(kernel, contract, "lookup")

    assert entry is contract.entry(NAMESPACED)
    assert descriptor.name == NAMESPACED


def test_execute_tool_blocks_the_bare_name_like_the_namespaced_call() -> None:
    kernel, contract, transport = _kernel_and_contract()

    bare = te.execute_tool(
        kernel,
        ToolCallRequest(tool_id="lookup", arguments={}, call_id="c1"),
        request_id="r",
        read_snapshot_cache={},
        tool_contract=contract,
        runtime=None,
    )
    namespaced = te.execute_tool(
        kernel,
        ToolCallRequest(tool_id=NAMESPACED, arguments={}, call_id="c2"),
        request_id="r",
        read_snapshot_cache={},
        tool_contract=contract,
        runtime=None,
    )

    assert transport.calls == []
    assert bare.success is False
    assert namespaced.success is False
    assert bare.error_code == namespaced.error_code


def test_pre_filter_settles_the_bare_name_as_blocked() -> None:
    kernel, contract, _transport = _kernel_and_contract()
    stub_kernel = SimpleNamespace(
        **{
            **vars(kernel),
            "_assert_valid_tool_call": te.assert_valid_tool_call,
            "_build_deferred_outcome": lambda _call: None,
            "_is_direct_deferred_tool_call": lambda *_args: False,
            "_remaining_deferred_names": lambda _context: frozenset(),
            "_assistant_tool_call_message": lambda _result, _calls: {},
            "_tool_result_message": lambda _call, _outcome: {},
        }
    )
    outcomes: list[Any] = []

    remaining, _index = tce.pre_filter_tool_calls(
        [ToolCallRequest(tool_id="lookup", arguments={}, call_id="c1")],
        kernel=stub_kernel,
        runtime=LoopRuntime(
            emit=lambda _event: None,
            request_id="r",
            session_id="s",
            streaming=False,
            tool_call_limit=20,
        ),
        result=SimpleNamespace(),
        request_id="r",
        tool_resolution_context=None,
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        outcome_index=0,
        tool_contract=contract,
        request_disabled_tools=frozenset({NAMESPACED}),
    )

    assert remaining == []
    assert len(outcomes) == 1
    assert outcomes[0].success is False


def test_unattended_pause_sees_electron_owned_tools_through_the_contract() -> None:
    # C2 #2: Electron-owned tools have no MCP client descriptor, only a contract entry.
    descriptor = MCPToolDescriptor(
        name="worktree_create",
        description="Create a worktree.",
        input_schema={"type": "object"},
        side_effecting=True,
        server_name="electron",
        source_kind="electron",
        tool_family="workspace",
    )
    contract = SimpleNamespace(
        entry=lambda name: (
            SimpleNamespace(descriptor=descriptor, available=True)
            if name == "worktree_create"
            else None
        )
    )
    kernel = SimpleNamespace(_mcp_client=SimpleNamespace(tool_descriptor=lambda _name: None))
    call = ToolCallRequest(tool_id="worktree_create", arguments={"name": "x"}, call_id="c1")
    state = turn_state.LiveRunModeState(approval_mode="prompt", paused_unattended=True)

    with turn_state.bind_live_run_mode_state(state):
        with_contract = tce.should_pause_for_live_prompt(
            kernel,
            call,
            approvals_pre_granted=True,
            scan_approval_mode="prompt",
            tool_contract=contract,
        )
        without_contract = tce.should_pause_for_live_prompt(
            kernel, call, approvals_pre_granted=True, scan_approval_mode="prompt"
        )

    assert with_contract is True
    assert without_contract is False
