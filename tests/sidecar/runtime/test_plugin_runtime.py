from __future__ import annotations

import hashlib
import json
import logging
from types import SimpleNamespace

from sidecar.ai.container import BrainContainer
from sidecar.protocol import API_VERSION
from sidecar.runtime import request_dispatch
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
    assert container._plugin_runtime_registry is None
    with admission.bind() as generation:
        assert generation is None
    admission.release()


def test_plugin_only_apply_preserves_stack_and_binds_verbatim_overlays() -> None:
    container = BrainContainer()
    stack = _fake_stack()
    container._stack = stack
    snapshot, content = _runtime_envelope()

    attestation = container.apply_plugin_runtime(
        snapshot=snapshot,
        declarative_content=content,
    )

    assert container._stack is stack
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
        overlays = container._plugin_runtime_overlay_provider()
        assert len(overlays) == 1
        assert "Keep {input} verbatim." in overlays[0]
    admission.release()


def test_replacing_full_stack_does_not_replace_plugin_registry_owner() -> None:
    container = BrainContainer()
    container._stack = _fake_stack()
    snapshot, content = _runtime_envelope()
    container.apply_plugin_runtime(snapshot=snapshot, declarative_content=content)
    registry = container._plugin_runtime_registry

    container._stack = _fake_stack()

    assert container._plugin_runtime_registry is registry


def test_stale_plugin_authority_is_rejected_before_chat_output() -> None:
    container = BrainContainer()
    container._stack = _fake_stack()
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


def test_plugin_command_invocation_is_not_a_chat_send_input(monkeypatch) -> None:
    # Plugin commands and workflows are retired: a stray invocation field is
    # ignored like any unknown param and never resolves, rewrites or refuses.
    container = BrainContainer()
    stack = _fake_stack()
    container._stack = stack
    container._stack_generations.publish(stack)
    snapshot, content = _runtime_envelope()
    container.apply_plugin_runtime(snapshot=snapshot, declarative_content=content)
    seen: list[dict[str, object]] = []

    def build_response(_message_id: object, params: dict[str, object], **_kwargs: object) -> ChatResponse:
        seen.append(params)
        return ChatResponse(
            request_id="req-retired",
            result={"request_id": "req-retired", "status": "completed"},
            notifications=[], approval_request=None,
        )

    monkeypatch.setattr(request_dispatch, "build_chat_send_response", build_response)
    outcome = process_chat_send_request(
        message_id=9,
        params={
            "accept_version": API_VERSION, "request_id": "req-retired",
            "session_id": "session-retired", "mode": "chat",
            "messages": [{"role": "user", "content": "plain user text"}],
            "plugin_runtime_authority": {
                "mode": "plugin", "registry_revision": 1,
                "dependency_graph_hash": "a" * 64, "commit_epoch": 1,
                "active_generation_id": "gen-active",
            },
            "plugin_command_invocation": {"not": "a command"},
        },
        initialized=True, interactive_approval=False, brain_container=container,
        logger=logging.getLogger("test.plugin_command_retired"),
        write_message=lambda _message: None, read_message=lambda: {},
    )

    assert outcome.response is not None and "result" in outcome.response
    assert seen[0]["messages"][-1]["content"] == "plain user text"


def test_workflow_interpreter_modules_are_removed() -> None:
    import importlib.util

    assert importlib.util.find_spec("sidecar.ai.plugins.workflow_interpreter") is None
    assert importlib.util.find_spec("sidecar.runtime.plugin_workflow_bridge") is None
