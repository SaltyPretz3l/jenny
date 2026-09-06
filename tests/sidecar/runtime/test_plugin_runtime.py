from __future__ import annotations

import hashlib
import json
import logging
from types import SimpleNamespace

from sidecar.ai.container import BrainContainer
from sidecar.ai.mode_policy import policy_for_mode
from sidecar.protocol import API_VERSION
from sidecar.runtime import request_dispatch
from sidecar.runtime import request_dispatch_chat_support as chat_support
from sidecar.runtime.chat_models import ChatResponse
from sidecar.runtime.request_dispatch_chat import process_chat_send_request


def _runtime_envelope() -> tuple[dict[str, object], list[dict[str, str]]]:
    content = {
        "content_schema_version": 1,
        "publisher_id": "jenny-official",
        "plugin_id": "starter",
        "contribution_id": "skill-main",
        "payload": {"kind": "skill", "instructions": "Keep {input} verbatim."},
    }
    exact = json.dumps(content, separators=(",", ":"))
    digest = hashlib.sha256(exact.encode("utf-8")).hexdigest()
    snapshot = {
        "kind": "plugin_runtime_snapshot",
        "registry_revision": 1,
        "dependency_graph_hash": "a" * 64,
        "commit_epoch": 1,
        "active_generation_id": "gen-active",
        "declarative_content": {
            "skill_scopes": [{
                "publisher_id": "jenny-official",
                "plugin_id": "starter",
                "contribution_id": "skill-main",
                "artifact_digest": "b" * 64,
                "content_digest": digest,
            }],
            "prompts": [],
            "themes": [],
            "settings_schemas": [],
            "commands": [],
            "workflows": [],
            "mcp_descriptors": [],
        },
    }
    return snapshot, [{"content_digest": digest, "content_json": exact}]


def _fake_stack() -> SimpleNamespace:
    return SimpleNamespace(
        engine=object(),
        config=SimpleNamespace(
            feature_flags={}, tools_enabled=False, tools_workspace_root=None,
            agent_workspace_root=None, engine_type="replay", model="test-model",
        ),
        memory_store=object(),
        mcp_client=object(),
        monitor_manager=object(),
        router=object(),
    )


def test_core_only_admission_keeps_plugin_registry_lazy() -> None:
    container = BrainContainer()
    admission = container.admit_plugin_runtime({"mode": "core_only"})
    assert container._plugin_runtime_registry is None  # noqa: SLF001
    with admission.bind() as generation:
        assert generation is None
    admission.release()


def test_plugin_only_apply_preserves_stack_and_binds_verbatim_overlays() -> None:
    container = BrainContainer()
    stack = _fake_stack()
    container._stack = stack  # noqa: SLF001
    snapshot, content = _runtime_envelope()

    attestation = container.apply_plugin_runtime(
        snapshot=snapshot,
        declarative_content=content,
    )

    assert container._stack is stack  # noqa: SLF001
    assert attestation["registry_revision"] == 1
    assert [proof["resource_kind"] for proof in attestation["reused_resource_proofs"]] == [
        "engine",
        "model",
        "memory",
        "mcp",
        "monitor",
        "tool",
    ]
    admission = container.admit_plugin_runtime({
        "mode": "plugin",
        "registry_revision": 1,
        "dependency_graph_hash": "a" * 64,
        "commit_epoch": 1,
        "active_generation_id": "gen-active",
    })
    with admission.bind():
        overlays = container._plugin_runtime_overlay_provider()  # noqa: SLF001
        assert len(overlays) == 1
        assert "Keep {input} verbatim." in overlays[0]
    admission.release()


def test_replacing_full_stack_does_not_replace_plugin_registry_owner() -> None:
    container = BrainContainer()
    container._stack = _fake_stack()  # noqa: SLF001
    snapshot, content = _runtime_envelope()
    container.apply_plugin_runtime(snapshot=snapshot, declarative_content=content)
    registry = container._plugin_runtime_registry  # noqa: SLF001

    container._stack = _fake_stack()  # noqa: SLF001

    assert container._plugin_runtime_registry is registry  # noqa: SLF001


def test_stale_plugin_authority_is_rejected_before_chat_output() -> None:
    container = BrainContainer()
    container._stack = _fake_stack()  # noqa: SLF001
    snapshot, content = _runtime_envelope()
    container.apply_plugin_runtime(snapshot=snapshot, declarative_content=content)

    outcome = process_chat_send_request(
        message_id=7,
        params={
            "plugin_runtime_authority": {
                "mode": "plugin",
                "registry_revision": 99,
                "dependency_graph_hash": "a" * 64,
                "commit_epoch": 1,
                "active_generation_id": "gen-active",
            },
        },
        initialized=True,
        interactive_approval=False,
        brain_container=container,
        logger=logging.getLogger("test.plugin_runtime"),
        write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert outcome.notifications == []
    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-PLUGIN-0011"


def _command_runtime_envelope() -> tuple[dict[str, object], list[dict[str, str]]]:
    rows = [{
        "content_schema_version": 2, "publisher_id": "jenny-official",
        "plugin_id": "starter", "contribution_id": "prompt-main",
        "payload": {
            "kind": "prompt", "template": "Summarize {{subject}}; keep {{suffix}}",
            "placeholders": ["subject", "suffix"],
        },
    }, {
        "content_schema_version": 2, "publisher_id": "jenny-official",
        "plugin_id": "starter", "contribution_id": "command-main",
        "payload": {
            "kind": "command", "target_kind": "prompt",
            "target_contribution_id": "prompt-main",
            "inputs": [{
                "type": "string", "key": "subject", "label": "Subject",
                "default": "Jenny", "max_length": 64,
            }, {
                "type": "string", "key": "suffix", "label": "Suffix",
                "default": "literal", "max_length": 64,
            }],
        },
    }]
    envelope: list[dict[str, str]] = []
    refs: dict[str, list[dict[str, object]]] = {
        name: [] for name in (
            "skill_scopes", "prompts", "themes", "settings_schemas", "commands",
            "workflows", "mcp_descriptors",
        )
    }
    for row, array_name in zip(rows, ("prompts", "commands"), strict=True):
        exact = json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        digest = hashlib.sha256(exact.encode()).hexdigest()
        envelope.append({"content_digest": digest, "content_json": exact})
        refs[array_name].append({
            "publisher_id": "jenny-official", "plugin_id": "starter",
            "contribution_id": row["contribution_id"], "artifact_digest": "b" * 64,
            "content_digest": digest, "content_schema_version": 2,
        })
    return ({
        "kind": "plugin_runtime_snapshot", "runtime_schema_version": 2,
        "registry_revision": 3, "dependency_graph_hash": "a" * 64,
        "commit_epoch": 3, "active_generation_id": "gen-command",
        "declarative_content": refs, "workflow_tool_bindings": [],
        "settings_states": [],
    }, envelope)


def test_prompt_command_resolves_leased_authority_and_substitutes_once(monkeypatch) -> None:
    container = BrainContainer()
    stack = _fake_stack()
    container._stack = stack  # noqa: SLF001
    container._stack_generations.publish(stack)  # noqa: SLF001
    snapshot, content = _command_runtime_envelope()
    container.apply_plugin_runtime(snapshot=snapshot, declarative_content=content)
    seen: list[dict[str, object]] = []

    def build_response(_message_id: object, params: dict[str, object], **_kwargs: object) -> ChatResponse:
        seen.append(params)
        return ChatResponse(
            request_id="req-command",
            result={"request_id": "req-command", "status": "completed"},
            notifications=[], approval_request=None,
        )

    monkeypatch.setattr(request_dispatch, "build_chat_send_response", build_response)
    outcome = process_chat_send_request(
        message_id=8,
        params={
            "accept_version": API_VERSION, "request_id": "req-command",
            "session_id": "session-command", "mode": "chat",
            "messages": [{"role": "user", "content": "renderer text is not authority"}],
            "plugin_runtime_authority": {
                "mode": "plugin", "registry_revision": 3,
                "dependency_graph_hash": "a" * 64, "commit_epoch": 3,
                "active_generation_id": "gen-command",
            },
            "plugin_command_invocation": {
                "invocation_schema_version": 2, "publisher_id": "jenny-official",
                "plugin_id": "starter", "command_id": "command-main",
                "observed_generation_id": "gen-command", "observed_registry_revision": 3,
                "inputs": [
                    {"type": "string", "key": "subject", "value": "{{suffix}}"},
                    {"type": "string", "key": "suffix", "value": "DONE"},
                ],
            },
        },
        initialized=True, interactive_approval=False, brain_container=container,
        logger=logging.getLogger("test.plugin_command"), write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert outcome.response is not None and "result" in outcome.response
    assert seen[0]["messages"][-1]["content"] == "Summarize {{suffix}}; keep DONE"


def test_workflow_prompt_node_forces_the_existing_tool_suppressed_chat_mode(monkeypatch) -> None:
    seen: list[dict[str, object]] = []

    def build_response(**kwargs: object) -> ChatResponse:
        params = kwargs["params"]
        assert isinstance(params, dict)
        seen.append(params)
        return ChatResponse(
            request_id="wf-node", result={"response_text": "bounded"},
            notifications=[], approval_request=None,
        )

    monkeypatch.setattr(chat_support, "_build_chat_response", build_response)
    bridge = chat_support._PluginWorkflowBridge(  # noqa: SLF001
        brain_container=SimpleNamespace(stack=SimpleNamespace()),
        params={"mode": "assist", "plugin_command_invocation": {}},
        request_id="req-workflow", trace_id="trace-workflow", session_id="session-workflow",
        write_message=lambda _message: None, read_message=lambda: {}, stream_notifications=False,
        approval_response_reader=None, approval_response_waiter_factory=None,
        approval_timeout_seconds=30.0, cancel_handle=None,
        logger=logging.getLogger("test.plugin_workflow_prompt"),
    )

    outcome = bridge.prompt_runner("Summarize safely", 1_000)

    assert outcome.ok is True and outcome.output == "bounded"
    assert seen[0]["mode"] == "chat"
    assert policy_for_mode(str(seen[0]["mode"])).allow_tools is False
    assert "plugin_command_invocation" not in seen[0]


def _usage_bridge(monkeypatch) -> object:
    def build_response(**_kwargs: object) -> ChatResponse:
        return ChatResponse(
            request_id="wf-node",
            result={"response_text": "bounded"},
            notifications=[
                {
                    "jsonrpc": "2.0",
                    "method": "chat.done",
                    "params": {
                        "usage": {
                            "input_tokens": 120,
                            "output_tokens": 30,
                            "total_tokens": 150,
                        }
                    },
                }
            ],
            approval_request=None,
        )

    monkeypatch.setattr(chat_support, "_build_chat_response", build_response)
    return chat_support._PluginWorkflowBridge(  # noqa: SLF001
        brain_container=SimpleNamespace(stack=SimpleNamespace()),
        params={"mode": "assist", "plugin_command_invocation": {}},
        request_id="req-workflow", trace_id="trace-workflow", session_id="session-workflow",
        write_message=lambda _message: None, read_message=lambda: {},
        stream_notifications=False,
        approval_response_reader=None, approval_response_waiter_factory=None,
        approval_timeout_seconds=30.0, cancel_handle=None,
        logger=logging.getLogger("test.plugin_workflow_usage"),
    )


def test_workflow_prompt_usage_accumulates_across_nodes(monkeypatch) -> None:
    # W2-35-F04: model-backed prompt nodes must not vanish from turn usage.
    bridge = _usage_bridge(monkeypatch)

    bridge.prompt_runner("First node", 1_000)
    bridge.prompt_runner("Second node", 1_000)

    assert bridge.aggregate_prompt_usage() == {
        "input_tokens": 240,
        "output_tokens": 60,
        "total_tokens": 300,
    }


def test_workflow_without_prompt_nodes_reports_no_aggregate(monkeypatch) -> None:
    bridge = _usage_bridge(monkeypatch)

    assert bridge.aggregate_prompt_usage() is None


def test_workflow_usage_payload_prefers_aggregated_prompt_usage() -> None:
    aggregated = {"input_tokens": 240, "output_tokens": 60, "total_tokens": 300}
    stub = SimpleNamespace(aggregate_prompt_usage=lambda: aggregated)

    assert chat_support._workflow_usage_payload(stub, 7) == aggregated  # noqa: SLF001


def test_workflow_usage_payload_retains_zero_input_estimate_without_prompts() -> None:
    stub = SimpleNamespace(aggregate_prompt_usage=lambda: None)

    assert chat_support._workflow_usage_payload(stub, 7) == {  # noqa: SLF001
        "input_tokens": 0,
        "output_tokens": 7,
        "total_tokens": 7,
    }
