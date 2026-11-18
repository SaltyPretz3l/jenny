"""A cloud primary's local delegate child (row 179 P2): helper parse and child config."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_models import (
    SYSTEM_PROMPT_DEFAULT,
    SYSTEM_PROMPT_MINIMAL,
    SYSTEM_PROMPT_PROFILE_COMPANION,
)
from sidecar.ai.routing.subagent_local_engine import (
    local_child_config,
    parse_local_subagent_engine,
)


def _raw(**overrides: Any) -> dict[str, Any]:
    return {
        "base_url": "http://127.0.0.1:8034", "model": "qwen3.8-27b", "provider_kind": "ninfer",
        "context_length": 32768, "ready": True,
        "prefill_progress": False, "json_schema_response_format": False, **overrides,
    }


def _parent() -> Any:
    return parse_runtime_config({
        "engine_type": "api-provider",
        "model": "api-provider/anthropic-api/claude-haiku-5-5",
        "api_provider_key": "sk-parent-cloud-key",
        "chatgpt_access_token": "chatgpt-token",
        "reasoning_effort": "high",
    })


def test_parse_admits_a_ready_loopback_helper_and_keeps_the_key_out_of_repr() -> None:
    helper = parse_local_subagent_engine(_raw(), "local-key")
    assert helper is not None
    assert (helper.base_url, helper.model, helper.provider_kind) == (
        "http://127.0.0.1:8034", "qwen3.8-27b", "ninfer")
    assert helper.api_key == "local-key"
    assert "local-key" not in repr(helper)


@pytest.mark.parametrize("overrides", [
    {"ready": False},
    {"base_url": "http://192.168.1.5:8034"},
    {"base_url": "https://127.0.0.1:8034"},
    {"base_url": "http://127.0.0.1"},
    {"base_url": "http://user:pw@127.0.0.1:8034"},
    {"provider_kind": "ollama"},
    {"model": "../escape"},
    {"context_length": True},
    {"context_length": -1},
    {"prefill_progress": "yes"},
])
def test_parse_refuses_anything_not_a_ready_local_managed_server(overrides: dict[str, Any]) -> None:
    assert parse_local_subagent_engine(_raw(**overrides), "k") is None


def test_parse_refuses_unknown_or_missing_fields() -> None:
    assert parse_local_subagent_engine({**_raw(), "extra": 1}) is None
    raw = _raw()
    del raw["ready"]
    assert parse_local_subagent_engine(raw) is None
    assert parse_local_subagent_engine(None) is None


def test_child_config_points_at_the_helper_and_carries_no_cloud_credential() -> None:
    helper = parse_local_subagent_engine(_raw(), "local-key")
    assert helper is not None
    child = local_child_config(_parent(), helper)
    assert child.engine_type == "openai-compatible"
    assert child.model == "qwen3.8-27b"
    assert child.api_url == "http://127.0.0.1:8034"
    assert child.openai_compatible_api_key == "local-key"
    assert child.api_provider_key is None
    assert child.api_provider_descriptor is None
    assert child.api_provider_model_limits is None
    assert child.chatgpt_access_token is None
    assert child.fallback_models == ()
    assert child.reasoning_effort == ""
    assert child.context_length == 32768
    assert "sk-parent-cloud-key" not in repr(child)
    assert "local-key" not in repr(child)


def test_child_config_resets_the_minimal_prompt_profile_for_the_local_model() -> None:
    parent = _parent()
    assert parent.system_prompt == SYSTEM_PROMPT_MINIMAL
    helper = parse_local_subagent_engine(_raw())
    assert helper is not None
    child = local_child_config(parent, helper)
    assert child.system_prompt_profile == SYSTEM_PROMPT_PROFILE_COMPANION
    assert child.system_prompt.startswith(SYSTEM_PROMPT_DEFAULT.rstrip())


def test_child_prompt_drops_the_parents_model_addendum() -> None:
    parent = replace(
        _parent(), system_prompt="Base persona.\n\nCloud model note.",
        resolved_app_profile_prompt_addendum="Cloud model note.",
    )
    helper = parse_local_subagent_engine(_raw())
    assert helper is not None
    child = local_child_config(parent, helper)
    assert child.system_prompt.startswith("Base persona.")
    assert "Cloud model note." not in child.system_prompt


def test_child_config_resolves_the_local_models_app_profile_not_the_parents() -> None:
    parent = replace(_parent(), resolved_app_profile_temperature=0.01)
    helper = parse_local_subagent_engine(_raw())
    assert helper is not None
    child = local_child_config(parent, helper)
    # The parent's leftover value is gone and Qwen 3.8's own profile applies.
    assert child.resolved_app_profile_temperature != 0.01
    assert child.resolved_app_profile_variant == "27b"
    assert child.resolved_app_profile_max_output_tokens is not None


def test_child_context_is_bounded_by_the_helper_servers_window() -> None:
    # Qwen 3.8's profile allows 131,072; the server was launched with 32,768.
    helper = parse_local_subagent_engine(_raw(context_length=32768))
    assert helper is not None
    assert local_child_config(_parent(), helper).context_length == 32768
    unbounded = parse_local_subagent_engine(_raw(context_length=None))
    assert unbounded is not None
    assert local_child_config(_parent(), unbounded).context_length == 131072


def test_child_config_uses_the_helpers_server_flags() -> None:
    helper = parse_local_subagent_engine(
        _raw(provider_kind="llama-server", prefill_progress=True, json_schema_response_format=True))
    assert helper is not None
    child = local_child_config(_parent(), helper)
    assert child.managed_prefill_progress is True
    assert child.json_schema_response_format is True


def test_a_child_on_another_engine_gets_no_parent_provider_descriptor(monkeypatch) -> None:
    from types import SimpleNamespace

    from sidecar.ai.engines import factory
    from sidecar.ai.routing.router import AgentKernel

    seen: list[dict[str, Any]] = []
    closed: list[str] = []

    def fake_create_engine(config: Any, **kwargs: Any) -> Any:
        seen.append(kwargs)
        engine = SimpleNamespace(close=lambda: closed.append(config.engine_type))
        # A mismatched selection stops before the kernel is built.
        return SimpleNamespace(engine=engine, engine_type="mock", model="", fallback_from="x")

    monkeypatch.setattr(factory, "create_engine", fake_create_engine)
    parent_engine = SimpleNamespace(provider_descriptor={"provider_id": "anthropic-api"},
                                    _authority_check=lambda *_args: True)
    kernel = SimpleNamespace(_config=_parent(), _engine=parent_engine)
    helper = parse_local_subagent_engine(_raw())
    assert helper is not None
    with pytest.raises(RuntimeError, match="failed to initialize"):
        AgentKernel.create_subagent_router(kernel, local_child_config(_parent(), helper))
    with pytest.raises(RuntimeError, match="failed to initialize"):
        AgentKernel.create_subagent_router(kernel, _parent())
    assert seen[0] == {"provider_descriptor": None, "provider_authority_check": None}
    assert seen[1]["provider_descriptor"] == {"provider_id": "anthropic-api"}
    assert closed == ["openai-compatible", "api-provider"]


# -- P4: routing a cloud parent's task with model "local" ----------------------


def _routed_parent(**extra: Any) -> Any:
    return parse_runtime_config({
        "engine_type": "api-provider",
        "model": "api-provider/anthropic-api/claude-haiku-5-5",
        "api_provider_key": "sk-parent-cloud-key",
        "reasoning_effort": "high",
        "local_subagent_engine": _raw(),
        "local_subagent_api_key": "local-key",
        **extra,
    })


def _router(config: Any, created: list[Any] | None = None, fail: bool = False) -> Any:
    from types import SimpleNamespace

    closed: list[str] = []

    def create(child_config: Any) -> Any:
        if fail:
            raise ConnectionError("server down")
        if created is not None:
            created.append(child_config)
        return SimpleNamespace(_engine=SimpleNamespace(close=lambda: closed.append("closed")))

    return SimpleNamespace(_config=config, _engine=SimpleNamespace(model_name=config.model),
                           create_subagent_router=create, closed=closed)


def _context() -> Any:
    from sidecar.runtime.chat_models import ChatRequestContext

    return ChatRequestContext(request_id="parent", session_id="session", agent_id="main@parent",
                              trace_id="trace", approvals_pre_granted=False, mode="assist",
                              reasoning_effort="high", workspace_root_present=True)


def test_config_parses_the_helper_and_keeps_its_key_out_of_repr() -> None:
    config = _routed_parent()
    assert config.local_subagent_engine is not None
    assert config.local_subagent_engine.api_key == "local-key"
    assert "local-key" not in repr(config)
    assert _routed_parent(local_subagent_engine={"ready": False}).local_subagent_engine is None


def test_a_cloud_parents_local_task_routes_to_the_helper_without_the_cloud_effort() -> None:
    from sidecar.ai.routing.delegate_contracts import DelegateTask
    from sidecar.ai.routing.subagent_model_routing import resolve_subagent_model_route

    route = resolve_subagent_model_route(
        _router(_routed_parent()), _context(), DelegateTask(1, "x", model="local"))
    assert (route.local, route.provider, route.model) == (True, "ninfer", "qwen3.8-27b")
    assert route.reasoning_effort is None
    assert route.context_length == 32768


def test_a_local_task_without_a_ready_helper_fails_with_the_reason() -> None:
    from sidecar.ai.routing.delegate_contracts import DelegateTask
    from sidecar.ai.routing.subagent_model_routing import resolve_subagent_model_route
    from sidecar.ai.tools.contracts import ToolExecutionFailure

    config = _routed_parent(local_subagent_engine=None)
    with pytest.raises(ToolExecutionFailure, match="local subagent engine is not ready"):
        resolve_subagent_model_route(_router(config), _context(), DelegateTask(1, "x", model="local"))
    with pytest.raises(ToolExecutionFailure, match="reasoning effort is unavailable"):
        resolve_subagent_model_route(
            _router(_routed_parent()), _context(),
            DelegateTask(1, "x", model="local", reasoning_effort="default"))


def test_a_local_parent_cannot_use_the_local_alias() -> None:
    from sidecar.ai.routing.delegate_contracts import DelegateTask
    from sidecar.ai.routing.subagent_model_routing import resolve_subagent_model_route
    from sidecar.ai.tools.contracts import ToolExecutionFailure

    config = parse_runtime_config({"engine_type": "openai-compatible", "model": "qwen3.8-27b"})
    with pytest.raises(ToolExecutionFailure, match="must use the loaded model"):
        resolve_subagent_model_route(_router(config), _context(), DelegateTask(1, "x", model="local"))


def test_the_helper_child_router_is_built_from_the_helper_and_closed_after() -> None:
    from sidecar.ai.routing.subagent_model_routing import (
        SubagentModelRoute,
        subagent_router_for_route,
    )

    created: list[Any] = []
    router = _router(_routed_parent(), created)
    route = SubagentModelRoute("ninfer", "qwen3.8-27b", "low", 32768, local=True)
    with subagent_router_for_route(router, route):
        assert router.closed == []
    child = created[0]
    assert (child.engine_type, child.model, child.reasoning_effort) == (
        "openai-compatible", "qwen3.8-27b", "low")
    assert child.api_provider_key is None
    assert child.openai_compatible_api_key == "local-key"
    assert router.closed == ["closed"]


def test_a_helper_that_cannot_start_fails_the_task_visibly() -> None:
    from sidecar.ai.routing.subagent_model_routing import (
        SubagentModelRoute,
        subagent_router_for_route,
    )
    from sidecar.ai.tools.contracts import ToolExecutionFailure

    route = SubagentModelRoute("ninfer", "qwen3.8-27b", None, 32768, local=True)
    with pytest.raises(ToolExecutionFailure, match="could not start"):
        with subagent_router_for_route(_router(_routed_parent(), fail=True), route):
            pass


def test_a_helper_task_is_admitted_on_the_local_engine_route() -> None:
    from sidecar.ai.routing.delegate_contracts import DelegateTask
    from sidecar.ai.routing.subagent_model_routing import SubagentModelRoute, invoke_routed_task

    seen: dict[str, Any] = {}

    def invoke(**kwargs: Any) -> str:
        seen.update(kwargs)
        return "done"

    route = SubagentModelRoute("ninfer", "qwen3.8-27b", None, 32768, local=True)
    result, _route = invoke_routed_task(
        router=_router(_routed_parent()), parent_context=_context(),
        task=DelegateTask(1, "x", model="local"), identity=None, invoke=invoke,
        invocation_kwargs={}, route=route)
    assert result == "done"
    assert seen["inference_provider"] == "openai-compatible"
    assert seen["parent_context"].reasoning_effort is None


def test_guidance_offers_the_local_alias_only_to_a_cloud_parent_with_a_helper() -> None:
    from sidecar.ai.routing.subagent_model_routing import render_subagent_model_guidance

    assert 'model "local" runs on qwen3.8-27b' in render_subagent_model_guidance(_routed_parent())
    assert "Local engine" not in render_subagent_model_guidance(
        _routed_parent(local_subagent_engine=None))
    local_parent = parse_runtime_config({
        "engine_type": "openai-compatible", "model": "qwen3.8-27b",
        "local_subagent_engine": _raw(), "local_subagent_api_key": "k"})
    assert "Local engine" not in render_subagent_model_guidance(local_parent)
