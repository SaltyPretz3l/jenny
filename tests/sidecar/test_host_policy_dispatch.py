"""Focused hosted-sidecar policy regressions."""

from __future__ import annotations

import logging
from dataclasses import replace
from types import SimpleNamespace

import pytest

from sidecar.ai import container as container_module
from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_models import RuntimeConfig
from sidecar.ai.container import BrainContainer
from sidecar.ai.host_policy import (
    HOST_ALLOWED_RPC_METHODS,
    HOST_EXECUTION_POLICY_VERSION,
    container_host_policy_is_enforced,
)
from sidecar.ai.routing import auto_checkpoint, verification_gate
from sidecar.ai.routing import tool_execution as tool_execution_module
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.routing.tool_execution import approval_if_needed
from sidecar.ai.tools.assembly import (
    ToolAssemblyContext,
    assemble_tool_contract,
)
from sidecar.ai.tools.catalog import (
    MANAGED_SIDECAR_SURFACE,
    CanonicalToolAvailability,
    CanonicalToolDescriptor,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.policy import POLICY_DECISION_AUTO, tool_policy_call_key
from sidecar.ai.tools.tool_search import ToolResolutionContext
from sidecar.protocol import API_VERSION
from sidecar.runtime import request_dispatch


def _host_config() -> dict[str, object]:
    return {
        "host_mode": "server",
        "host_execution_policy_version": HOST_EXECUTION_POLICY_VERSION,
    }


def _host_runtime_config() -> RuntimeConfig:
    return parse_runtime_config(
        {
            **_host_config(),
            "feature_flags": {
                "auto_checkpoint": True,
                "verification_gate": True,
            },
            "tools_verify_enabled": True,
        }
    )


def _descriptor(name: str, *, side_effecting: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        description=name,
        side_effecting=side_effecting,
        read_only=not side_effecting,
        input_schema={"type": "object", "properties": {}},
        availability=SimpleNamespace(plan_mode_artifact_write=False, plan_mode_only=False),
        actions=None,
    )


def _approval_kernel(config: RuntimeConfig, descriptor: object) -> SimpleNamespace:
    return SimpleNamespace(
        _config=config,
        _is_direct_deferred_tool_call=lambda *_args: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: descriptor),
    )


@pytest.mark.parametrize("tool_name", ["write_file", "edit_file", "create_artifact"])
def test_hosted_filesystem_mutations_precede_auto_run_and_persistent_auto(
    tool_name: str,
) -> None:
    descriptor = _descriptor(tool_name)
    call = ToolCallRequest(
        tool_id=tool_name,
        arguments={"path": "note.md", "content": "safe"},
        call_id=f"call-{tool_name}",
    )
    request = approval_if_needed(
        _approval_kernel(_host_runtime_config(), descriptor),
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=False,
        approvals_pre_granted=False,
        resolution_context=None,
        approval_mode="auto_run",
        policy_decisions_by_call={
            tool_policy_call_key(call): SimpleNamespace(
                decision=POLICY_DECISION_AUTO,
                reason="persisted auto",
            )
        },
    )

    assert request is not None
    assert request.tool_name == tool_name
    assert request.policy_decision_id is None
    assert "one-off approval" in request.reason


def test_hosted_config_forces_callback_hooks_off_even_when_forged() -> None:
    config = _host_runtime_config()

    assert config.tools_verify_enabled is False
    assert config.feature_flags == {
        "auto_checkpoint": False,
        "verification_gate": False,
    }


def test_hosted_auto_checkpoint_edge_skips_bridge_even_with_forged_flags(monkeypatch) -> None:
    config = replace(
        _host_runtime_config(),
        feature_flags={"auto_checkpoint": True},
    )
    loop_run = SimpleNamespace(
        kernel=SimpleNamespace(_config=config),
        checkpoint_created=False,
        session_id="session-1",
    )
    call = ToolCallRequest("write_file", {"path": "x", "content": "y"})
    monkeypatch.setattr(
        auto_checkpoint,
        "_request_checkpoint",
        lambda *_args: pytest.fail("hosted checkpoint bridge must not be called"),
    )

    auto_checkpoint.maybe_create_auto_checkpoint(loop_run, [(call, 0)])
    assert loop_run.checkpoint_created is False


def test_hosted_verification_edge_skips_bridge_even_with_forged_flags(monkeypatch) -> None:
    config = replace(
        _host_runtime_config(),
        feature_flags={"verification_gate": True},
        tools_verify_enabled=True,
    )
    loop_run = SimpleNamespace(
        kernel=SimpleNamespace(_config=config),
        runtime=SimpleNamespace(),
        request_id="request-1",
        session_id="session-1",
    )
    monkeypatch.setattr(
        verification_gate,
        "_run_gate_tool",
        lambda *_args: pytest.fail("hosted verification bridge must not be called"),
    )

    assert verification_gate.run_gate(loop_run, retry_allowed=True) == verification_gate.NO_GATE_ACTION


def test_hosted_assembly_does_not_offer_synthetic_tool_search() -> None:
    deferred = CanonicalToolDescriptor(
        name="mcp__untrusted__search",
        description="deferred",
        input_schema={"type": "object"},
        side_effecting=False,
        read_only=True,
        source_kind="mcp",
        surfaces=(MANAGED_SIDECAR_SURFACE,),
        availability=CanonicalToolAvailability(defer_eligible=True),
    )
    tool_search = CanonicalToolDescriptor(
        name="tool_search",
        description="search",
        input_schema={"type": "object"},
        side_effecting=False,
        read_only=True,
        source_kind="synthetic",
        surfaces=(MANAGED_SIDECAR_SURFACE,),
    )
    resolution_context = ToolResolutionContext(
        deferred_names=frozenset({deferred.name}),
        un_deferred_names=set(),
        search_index=object(),
    )

    contract = assemble_tool_contract(
        (deferred, tool_search),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config=_host_config(),
            engine_supports_tool_calling=True,
            mode="assist",
            resolution_context=resolution_context,
            workspace_root_present=True,
            include_deferred_tools=True,
        ),
    )

    assert contract.entry("tool_search") is None


def test_hosted_forged_tool_search_does_not_mutate_resolution_or_payload(monkeypatch) -> None:
    call = ToolCallRequest("tool_search", {"query": "secret"}, call_id="search-1")
    state = {"searched": False, "built": False}

    class Runtime:
        streaming = False
        remaining_tool_calls = 1

        def raise_if_interrupted(self):
            return None

    class Kernel:
        _config = _host_runtime_config()

        def _execute_tool_search(self, *_args, **_kwargs):
            state["searched"] = True
            raise AssertionError("hosted tool_search must be denied before mutation")

        def _build_tool_payload(self, *_args, **_kwargs):
            state["built"] = True
            raise AssertionError("hosted tool_search must not disclose schemas")

        def _update_read_snapshot_cache(self, *_args, **_kwargs):
            return None

        _assistant_tool_call_message = staticmethod(lambda *_args: {})
        _tool_result_message = staticmethod(lambda *_args: {})

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.loop_event_emit.emit_tool_executing",
        lambda *_args: call.call_id,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.loop_event_emit.emit_tool_result",
        lambda *_args: None,
    )

    outcomes: list[object] = []
    payload = [{"name": "should-remain"}]
    execute_tool_calls_sequentially(
        indexed_calls=[(call, 0)],
        runtime=Runtime(),
        kernel=Kernel(),
        result=SimpleNamespace(),
        request_id="request-1",
        session_id="session-1",
        tool_resolution_context=SimpleNamespace(un_deferred_names=set()),
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=payload,
    )

    assert state == {"searched": False, "built": False}
    assert payload == [{"name": "should-remain"}]
    assert outcomes[0].success is False
    assert outcomes[0].error_code == "CMP-TOOL-0039"


def test_hosted_dispatch_rejects_plugin_and_background_before_handlers(monkeypatch) -> None:
    config = _host_runtime_config()
    calls: list[str] = []
    container = SimpleNamespace(
        stack=SimpleNamespace(config=config),
        apply_plugin_runtime=lambda **_kwargs: calls.append("plugin"),
    )
    logger = SimpleNamespace(exception=lambda *_args, **_kwargs: None)

    monkeypatch.setattr(
        request_dispatch,
        "process_background_method",
        lambda *_args: pytest.fail("hosted background handler must not run"),
    )
    background = request_dispatch.process_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "background.run",
            "params": {"accept_version": API_VERSION},
        },
        True,
        brain_container=container,
        logger=logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )
    assert background.response["error"]["data"]["reason"] == "host_method_not_allowed"

    plugin = request_dispatch.process_message(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "initialize",
            "params": {
                "mode": "plugin_runtime",
                "plugin_runtime": {"snapshot": {}, "declarative_content": {}},
            },
        },
        True,
        brain_container=container,
        logger=logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )
    assert plugin.response["error"]["data"]["reason"] == "host_method_not_allowed"
    assert calls == []


def test_hosted_dispatch_allowlist_is_explicit() -> None:
    assert "background.run" not in HOST_ALLOWED_RPC_METHODS
    assert "mcp.inspect" not in HOST_ALLOWED_RPC_METHODS
    assert "harness.inspect" not in HOST_ALLOWED_RPC_METHODS
    assert "chat.send" in HOST_ALLOWED_RPC_METHODS
    assert "models.list" in HOST_ALLOWED_RPC_METHODS


def test_hosted_intent_is_latched_before_initialize_build_and_survives_null_stack(
    monkeypatch,
) -> None:
    container = BrainContainer()

    def fake_initialize_response(*_args, **_kwargs):
        assert container.host_policy_enforced is True
        assert container._stack is None  # noqa: SLF001
        return {"result": {}}

    monkeypatch.setattr(request_dispatch, "initialize_response", fake_initialize_response)
    initialized = request_dispatch.process_message(
        {
            "jsonrpc": "2.0",
            "id": 10,
            "method": "initialize",
            "params": {"accept_version": API_VERSION, "config": _host_config()},
        },
        False,
        brain_container=container,
        logger=logging.getLogger(__name__),
        write_message=lambda _message: None,
        read_message=lambda: {},
    )
    assert initialized.initialized is True

    rejected = request_dispatch.process_message(
        {"jsonrpc": "2.0", "id": 11, "method": "background.run", "params": {}},
        True,
        brain_container=container,
        logger=logging.getLogger(__name__),
        write_message=lambda _message: None,
        read_message=lambda: {},
    )
    assert rejected.response["error"]["data"]["reason"] == "host_method_not_allowed"


def test_desktop_container_policy_latch_stays_open_for_explicit_desktop_config() -> None:
    container = BrainContainer()
    container.latch_host_policy({})
    assert container.host_policy_enforced is False


@pytest.mark.parametrize(
    "container",
    [
        SimpleNamespace(),
        SimpleNamespace(config=None),
        SimpleNamespace(stack=SimpleNamespace(config=None)),
        SimpleNamespace(config={"host_mode": "server"}),
    ],
)
def test_unknown_or_invalid_container_policy_fails_closed(container) -> None:
    assert container_host_policy_is_enforced(container) is True


def test_hosted_latch_cannot_be_relaxed_before_desktop_publication() -> None:
    container = BrainContainer()
    container.latch_host_policy(_host_config())
    container.latch_host_policy({})
    assert container.host_policy_enforced is True


def test_execute_tool_rechecks_host_policy_at_canonical_dispatch(monkeypatch) -> None:
    descriptor = _descriptor("mcp__forged__run")
    descriptor.source_kind = "mcp"
    kernel = SimpleNamespace(
        _config=_host_runtime_config(),
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: descriptor),
    )
    monkeypatch.setattr(
        tool_execution_module,
        "freeze_effective_execution_inputs",
        lambda *_args, **_kwargs: SimpleNamespace(
            visible_tool_arguments={},
            effective_tool_arguments={},
        ),
    )
    monkeypatch.setattr(
        tool_execution_module,
        "_dispatch_tool_call",
        lambda **_kwargs: pytest.fail("denied hosted tool reached its handler"),
    )

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_execution_module.execute_tool(
            kernel,
            ToolCallRequest("mcp__forged__run", {}, call_id="forged-1"),
            request_id="request-1",
            read_snapshot_cache={},
        )

    assert caught.value.code == "CMP-TOOL-0039"
    assert "hosted execution policy" in str(caught.value)


@pytest.mark.parametrize(
    ("tool_id", "descriptor"),
    [
        (
            "mcp__forged__run",
            SimpleNamespace(
                name="mcp__forged__run",
                source_kind="mcp",
                server_name="untrusted",
            ),
        ),
        (
            "run_command",
            SimpleNamespace(
                name="run_command",
                source_kind="builtin",
                server_name="builtin",
            ),
        ),
    ],
)
@pytest.mark.parametrize("config_shape", ["missing", "none"])
def test_execute_tool_denies_indeterminate_policy_before_any_handler_effect(
    monkeypatch,
    tool_id,
    descriptor,
    config_shape,
) -> None:
    kernel_values = {
        "_mcp_client": SimpleNamespace(tool_descriptor=lambda _name: descriptor),
    }
    if config_shape == "none":
        kernel_values["_config"] = None
    kernel = SimpleNamespace(**kernel_values)
    monkeypatch.setattr(
        tool_execution_module,
        "freeze_effective_execution_inputs",
        lambda *_args, **_kwargs: SimpleNamespace(
            visible_tool_arguments={},
            effective_tool_arguments={},
        ),
    )
    dispatched = False

    def record_dispatch(**_kwargs):
        nonlocal dispatched
        dispatched = True
        raise AssertionError("indeterminate policy reached its handler")

    monkeypatch.setattr(tool_execution_module, "_dispatch_tool_call", record_dispatch)

    with pytest.raises(ToolExecutionFailure) as caught:
        tool_execution_module.execute_tool(
            kernel,
            ToolCallRequest(tool_id, {}, call_id="indeterminate-1"),
            request_id="request-1",
            read_snapshot_cache={},
        )

    assert caught.value.code == "CMP-TOOL-0039"
    assert "invalid" in str(caught.value)
    assert dispatched is False


def test_hosted_context_builder_does_not_receive_tool_workspace(tmp_path, monkeypatch) -> None:
    real_builder = container_module.ContextBuilder
    seen: list[object] = []

    class CapturingBuilder:
        def __init__(self, workspace_root, *args, **kwargs):
            seen.append(workspace_root)
            self._real = real_builder(None, *args, **kwargs)

        def __getattr__(self, name):
            return getattr(self._real, name)

    monkeypatch.setattr(container_module, "ContextBuilder", CapturingBuilder)
    container = BrainContainer()
    stack = container.configure(
        {
            **_host_config(),
            "engine_type": "mock",
            "tools_workspace_root": str(tmp_path),
            "memory_db_path": str(tmp_path / "memory.db"),
            "background_runtime_root": str(tmp_path / "background"),
            "operation_ledger_root": str(tmp_path / "ledger"),
        }
    )
    try:
        assert seen == [None]
        assert stack.config.agent_workspace_root == str(tmp_path)
        assert stack.config.tools_workspace_root == str(tmp_path)
        assert container.host_policy_enforced is True
    finally:
        container.close()
    assert container.host_policy_enforced is True
