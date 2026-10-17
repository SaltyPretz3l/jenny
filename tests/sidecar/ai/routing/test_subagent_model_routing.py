"""Per-task catalog selection, child isolation, and resource ownership."""

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import FallbackModelConfig, parse_runtime_config
from sidecar.ai.context.builder import ContextBuilder, RuntimeToolStatus
from sidecar.ai.engines.factory import EngineSelection
from sidecar.ai.routing import subagent_scheduler as scheduler
from sidecar.ai.routing.delegate_contracts import DelegateTask, validate_delegate_arguments
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import AgentKernel, ChatDecision
from sidecar.ai.routing.subagent_model_routing import (
    normalize_subagent_routing,
    render_subagent_model_guidance,
    resolve_subagent_model_route,
    subagent_router_for_route,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.subagent_slots import SubAgentSlotAllocator


def _config(**kwargs: Any) -> Any:
    return parse_runtime_config({"engine_type": "chatgpt", "model": "gpt-6.1-sol", **kwargs})


def _context(**kwargs: Any) -> ChatRequestContext:
    return ChatRequestContext(
        request_id="parent", session_id="session", agent_id="main@parent",
        trace_id="trace", approvals_pre_granted=False,
        mode="assist", reasoning_effort="high", workspace_root_present=True, **kwargs,
    )


def _preferences(model: str = "gpt-6-luna", effort: str = "low") -> dict[str, Any]:
    return {"chatgpt": {"defaultModel": model, "defaultEffort": effort,
                        "preferredModels": ["gpt-6-luna"]}}


@pytest.mark.parametrize(
    ("task", "preferences", "model", "effort"),
    [
        (DelegateTask(1, "inspect"), {}, "gpt-6.1-sol", "high"),
        (DelegateTask(1, "inspect"), _preferences(), "gpt-6-luna", "low"),
        (DelegateTask(1, "inspect", model="gpt-5.6-sol"),
         _preferences(), "gpt-5.6-sol", "low"),
        (DelegateTask(1, "inspect", model="gpt-6.1-sol", reasoning_effort="medium"),
         _preferences(), "gpt-6.1-sol", "medium"),
    ],
)
def test_route_precedence_and_different_model_default(
    task: DelegateTask, preferences: dict[str, Any], model: str, effort: str,
) -> None:
    router = SimpleNamespace(_config=_config())
    route = resolve_subagent_model_route(router, _context(subagent_routing=preferences), task)
    assert (route.provider, route.model, route.reasoning_effort) == ("chatgpt", model, effort)


@pytest.mark.parametrize(
    ("task", "preferences"),
    [
        (DelegateTask(1, "inspect", model="unavailable"), {}),
        (DelegateTask(1, "inspect", model="gpt-5.4-mini", reasoning_effort="max"), {}),
    ],
)
def test_unavailable_explicit_route_fails_closed(
    task: DelegateTask, preferences: dict[str, Any],
) -> None:
    router = SimpleNamespace(_config=_config())
    with pytest.raises(ToolExecutionFailure, match="unavailable"):
        resolve_subagent_model_route(router, _context(subagent_routing=preferences), task)


def test_request_snapshot_overrides_global_preferences_and_guidance() -> None:
    config = _config()
    context = _context(subagent_routing={})
    route = resolve_subagent_model_route(SimpleNamespace(_config=config), context, DelegateTask(1, "x"))
    assert route.model == config.model
    assert 'Subagent preferences: {}' in render_subagent_model_guidance(config, subagent_routing={})


def test_codex_catalog_accepts_same_provider_slug_and_checks_effort() -> None:
    config = _config(engine_type="codex-cli", model="codex-cli/gpt-6.1-sol",
                     codex_cli_models=["gpt-6.1-sol", "gpt-6-luna"])
    router = SimpleNamespace(_config=config)
    route = resolve_subagent_model_route(router, _context(),
                                        DelegateTask(1, "x", model="gpt-6-luna"))
    assert route.model == "codex-cli/gpt-6-luna"
    assert route.reasoning_effort == "default"
    with pytest.raises(ToolExecutionFailure, match="unavailable"):
        resolve_subagent_model_route(router, _context(),
                                    DelegateTask(1, "x", model="gpt-6-luna", reasoning_effort="max"))


def test_local_route_refuses_model_switch() -> None:
    router = SimpleNamespace(_config=_config(engine_type="ollama", model="local-loaded"))
    with pytest.raises(ToolExecutionFailure, match="loaded model"):
        resolve_subagent_model_route(router, _context(), DelegateTask(1, "x", model="another"))


def test_task_route_validation_is_independent_and_keeps_legacy_aliases() -> None:
    request = validate_delegate_arguments({"tasks": [
        {"task": "one", "model": "gpt-6-luna", "reasoning_effort": "low"},
        {"prompt": "two", "model": None}, "three",
    ]})
    assert request.tasks[0].model == "gpt-6-luna"
    assert request.tasks[0].reasoning_effort == "low"
    assert request.tasks[1].error is not None
    assert request.tasks[2].prompt == "three"
    with pytest.raises(ToolExecutionFailure, match="aggregate"):
        validate_delegate_arguments({"tasks": [
            {"prompt": "x" * 16_000, "model": "gpt-6-luna"},
            {"prompt": "y" * 16_000}, "z",
        ]})


def test_local_delegate_reuses_loaded_engine_but_never_falls_back() -> None:
    from sidecar.ai.routing.generation_runtime import _try_fallback

    config = _config(engine_type="ollama", model="loaded", fallback_models=[
        {"engine_type": "ollama", "model": "other"},
    ])
    parent = SimpleNamespace(_config=config)
    assert config.fallback_models
    route = resolve_subagent_model_route(parent, _context(), DelegateTask(1, "x"))
    with subagent_router_for_route(parent, route) as child:
        assert child is parent
        assert _try_fallback(
            child, RuntimeError("unavailable"), latest_user_content="inspect",
            working_messages=[], reasoning_effort=None, prompt_cache_enabled=False,
            system_prompt="", tool_schemas=[], attempt_event_types=set(),
            runtime=SimpleNamespace(request_context=SimpleNamespace(agent_depth=1)),
        ) is None
    assert parent._config is config


class _Engine:
    def __init__(self, model: str) -> None:
        self.model_name = model
        self.closed = 0
        self.unloaded = 0
        self.provider_descriptor = {"provider": "fixture"}
        self._authority_check = lambda: True
        self._turn_diagnostics_store = object()

    def set_turn_diagnostics_store(self, store: Any) -> None:
        self._turn_diagnostics_store = store

    def unload_model(self) -> None:
        self.unloaded += 1

    def close(self) -> None:
        self.closed += 1


def _kernel() -> AgentKernel:
    return AgentKernel(config=_config(context_length=272_000, context_length_override=150_000),
                       engine=_Engine("gpt-6.1-sol"), mcp_client=SimpleNamespace(),
                       context_builder=ContextBuilder(None))


@pytest.mark.parametrize("failure", [None, RuntimeError("provider failed"),
                                     TerminalChatStateError(status="cancelled", message="cancel")])
def test_owned_kernel_uses_selected_context_and_closes_on_all_exits(
    monkeypatch: pytest.MonkeyPatch, failure: Exception | None,
) -> None:
    parent = _kernel()
    created: list[_Engine] = []

    def factory(config: Any, **kwargs: Any) -> EngineSelection:
        assert kwargs["provider_authority_check"] is parent._engine._authority_check
        child_engine = _Engine(config.model)
        created.append(child_engine)
        return EngineSelection(child_engine, config.engine_type, config.model)

    monkeypatch.setattr("sidecar.ai.engines.factory.create_engine", factory)
    route = resolve_subagent_model_route(parent, _context(),
                                        DelegateTask(1, "x", model="gpt-5.3-codex-spark"))
    def run() -> None:
        with subagent_router_for_route(parent, route) as child:
            assert child is not parent and child._config.model == route.model
            assert child._config.context_length == 128_000
            assert child._config.context_length_override is None
            assert child._context_builder is not parent._context_builder
            assert child._tokenizer_lock is not parent._tokenizer_lock
            assert child._compaction_breakers is not parent._compaction_breakers
            assert child._engine._turn_diagnostics_store is parent._engine._turn_diagnostics_store
            if failure:
                raise failure
    if failure:
        with pytest.raises(type(failure)):
            run()
    else:
        run()
    assert created[0].closed == created[0].unloaded == 1
    assert parent._engine.closed == parent._engine.unloaded == 0
    assert parent._config.model == "gpt-6.1-sol" and parent._config.context_length == 272_000


def test_child_factory_receives_refreshed_catalog(monkeypatch: pytest.MonkeyPatch) -> None:
    parent = _kernel()
    profile = {"id": "new-model", "label": "New model", "vision": False, "context_length": 128_000,
               "reasoning_efforts": ["low"], "default_reasoning_effort": "low"}
    parent._engine._catalog_profiles = {"new-model": profile}

    def factory(config: Any, **kwargs: Any) -> EngineSelection:
        assert config.chatgpt_model_catalog[0]["id"] == "new-model"
        return EngineSelection(_Engine(config.model), config.engine_type, config.model)

    monkeypatch.setattr("sidecar.ai.engines.factory.create_engine", factory)
    route = resolve_subagent_model_route(parent, _context(), DelegateTask(1, "x", model="new-model"))
    with subagent_router_for_route(parent, route) as child:
        assert child._config.context_length == 128_000
    assert not parent._config.chatgpt_model_catalog


def test_factory_fallback_is_closed_without_running_child(monkeypatch: pytest.MonkeyPatch) -> None:
    parent = _kernel()
    fallback = _Engine("mock-v1")
    monkeypatch.setattr("sidecar.ai.engines.factory.create_engine",
                        lambda *args, **kwargs: EngineSelection(fallback, "mock", "mock-v1"))
    route = resolve_subagent_model_route(parent, _context(), DelegateTask(1, "x", model="gpt-6-luna"))
    with pytest.raises(RuntimeError, match="selected model"):
        with subagent_router_for_route(parent, route):
            pytest.fail("fallback cannot run a child")
    assert fallback.closed == fallback.unloaded == 1


def test_same_model_with_parent_fallbacks_owns_engine_and_disables_substitution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent = _kernel()
    parent._config = replace(parent._config, fallback_models=(FallbackModelConfig("mock", "mock-v1"),))
    child_engine = _Engine(parent._config.model)
    captured: list[Any] = []
    def factory(config: Any, **kwargs: Any) -> EngineSelection:
        captured.append(config)
        return EngineSelection(child_engine, config.engine_type, config.model)
    monkeypatch.setattr("sidecar.ai.engines.factory.create_engine", factory)
    route = resolve_subagent_model_route(parent, _context(), DelegateTask(1, "x"))
    with subagent_router_for_route(parent, route) as child:
        assert child is not parent and child._config.fallback_models == ()
        assert child._config.context_length_override == parent._config.context_length_override
    assert captured[0].fallback_models == ()
    assert parent._config.fallback_models and parent._engine.closed == 0
    assert child_engine.closed == child_engine.unloaded == 1


def test_scheduler_runs_real_child_invocation_with_resolved_context_and_grants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent = _kernel()
    created: list[_Engine] = []
    def factory(config: Any, **kwargs: Any) -> EngineSelection:
        engine = _Engine(config.model)
        created.append(engine)
        return EngineSelection(engine, config.engine_type, config.model)
    monkeypatch.setattr("sidecar.ai.engines.factory.create_engine", factory)
    observed: list[tuple[Any, Any]] = []
    def decision(kernel: Any, **kwargs: Any) -> ChatDecision:
        observed.append((kernel._config, kwargs["request_context"]))
        return ChatDecision(None, "bounded evidence", None, ())
    monkeypatch.setattr(AgentKernel, "build_chat_decision", decision)
    context = _context()
    runtime = LoopRuntime(request_id="parent", trace_id="trace", session_id="session",
                          request_context=context,
                          sub_agent_slot_allocator=SubAgentSlotAllocator(
                              max_active_sub_agents=3, max_sub_agents_per_parent=3))
    schedule = scheduler.schedule_delegate_tasks(
        router=parent, parent_context=context, runtime=runtime,
        request=validate_delegate_arguments({"tasks": [
            {"prompt": "inspect", "model": "gpt-5.3-codex-spark", "reasoning_effort": "low"},
        ]}), parent_request_id="parent", call_id="call", parent_agent_id="main@parent",
    )
    assert schedule.invocations[0].result.status == "completed"
    child_config, child_context = observed[0]
    assert child_config.model == "gpt-5.3-codex-spark" and child_config.context_length == 128_000
    assert child_context.read_only and not child_context.approvals_pre_granted
    assert child_context.agent_depth == 1 and child_context.reasoning_effort == "low"
    assert "delegate" in child_context.tool_preferences["disabled_tools"]
    assert "shell" in child_context.tool_preferences["disabled_tool_families"]
    assert created[0].closed == created[0].unloaded == 1
    assert context.reasoning_effort == "high" and parent._config.model == "gpt-6.1-sol"
    assert runtime.sub_agent_slot_allocator.snapshot()["active_sub_agents"] == 0


def test_scheduler_isolates_unavailable_model_and_reports_actual_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = _context()
    runtime = LoopRuntime(request_id="parent", trace_id="trace", session_id="session",
                          request_context=context,
                          sub_agent_slot_allocator=SubAgentSlotAllocator(
                              max_active_sub_agents=3, max_sub_agents_per_parent=3))
    captures: list[dict[str, Any]] = []
    def invoke(**kwargs: Any) -> Any:
        captures.append(kwargs)
        return SimpleNamespace(status="completed", response_text="answer")
    monkeypatch.setattr(scheduler, "invoke_sub_agent", invoke)
    started: list[dict[str, Any]] = []
    schedule = scheduler.schedule_delegate_tasks(
        router=SimpleNamespace(_config=_config()), parent_context=context, runtime=runtime,
        request=validate_delegate_arguments({"tasks": [
            {"prompt": "one", "model": "unavailable"}, "two",
        ]}), parent_request_id="parent", call_id="call", parent_agent_id="main@parent",
        on_task_started=lambda task, identity, route: started.append(route),
        on_task_event=lambda task, identity, event: None,
    )
    assert [item.result.status for item in schedule.invocations] == ["failed", "completed"]
    assert not schedule.invocations[0].started
    assert schedule.invocations[0].result.completion_reason == "rejected"
    assert schedule.invocations[1].model == "gpt-6.1-sol"
    assert schedule.invocations[1].reasoning_effort == "high"
    assert started == [{"provider": "chatgpt", "model": "gpt-6.1-sol", "reasoning_effort": "high"}]
    assert captures[0]["parent_context"] is not context
    assert captures[0]["parent_context"].reasoning_effort == "high"
    assert "event_sink" in captures[0]
    assert runtime.sub_agent_slot_allocator.snapshot()["active_sub_agents"] == 0


def test_parent_context_renders_catalog_only_when_delegate_is_available() -> None:
    kernel = _kernel()
    status = RuntimeToolStatus(name="delegate", display_name="Delegate", available=True, reason=None)
    text = kernel._context_builder._render_subagent_selection_guidance([status])
    assert "gpt-6-luna" in text and "economical" in text and "Catalog:" in text
    assert kernel._context_builder._render_subagent_selection_guidance([]) == ""


def test_runtime_config_bounds_preferences_without_mutating_input() -> None:
    raw = _preferences()
    raw["chatgpt"]["preferredModels"].append("gpt-6-luna")
    normalized = normalize_subagent_routing(raw)
    assert normalized["chatgpt"]["preferredModels"] == ["gpt-6-luna"]
    assert len(raw["chatgpt"]["preferredModels"]) == 2
    assert normalize_subagent_routing(_preferences(model="../../escape")) == {}


@pytest.mark.parametrize("raw", [None, [], "bad", {"chatgpt": None},
    {"chatgpt": {"unknown": True}}, {"chatgpt": {"defaultEffort": 3}},
    {"chatgpt": {"preferredModels": ["luna"] * 17}},
    {"chatgpt": {"allowedModels": ["luna"] * 17}},
    {"chatgpt": {"maxEffort": "default"}},
    {"chatgpt": {"defaultModel": "codex-cli/luna"}}])
def test_malformed_routing_rows_are_dropped(raw):
    assert normalize_subagent_routing(raw) == {}


def test_codex_prefix_and_valid_sibling_row_survive_normalization():
    raw = {"chatgpt": {"bad": True}, "codex-cli": {"allowedModels": ["codex-cli/luna"], "maxEffort": "low"}}
    assert normalize_subagent_routing(raw) == {"codex-cli": {"defaultModel": "", "defaultEffort": "", "preferredModels": [], "allowedModels": ["codex-cli/luna"], "maxEffort": "low"}}


@pytest.mark.parametrize(("preferences", "expected"), [
    (_preferences(model="unavailable"), ("gpt-6.1-sol", "high")),
    (_preferences(effort="none"), ("gpt-6-luna", "medium")),
    ({"chatgpt": {"allowedModels": ["gpt-6-luna"], "maxEffort": "low"}}, ("gpt-6-luna", "low")),
    ({"chatgpt": {"defaultModel": "missing", "allowedModels": ["gpt-6-luna"], "maxEffort": "low"}}, ("gpt-6-luna", "low")),
])
def test_soft_defaults_and_inheritance_respect_owner_limits(preferences, expected):
    route = resolve_subagent_model_route(SimpleNamespace(_config=_config()), _context(subagent_routing=preferences), DelegateTask(1, "x"))
    assert (route.model, route.reasoning_effort) == expected


@pytest.mark.parametrize(("preferences", "task", "message"), [
    ({"chatgpt": {"allowedModels": ["gpt-6-luna"]}}, DelegateTask(1, "x", model="gpt-6.1-sol"), "allowed"),
    ({"chatgpt": {"maxEffort": "low"}}, DelegateTask(1, "x", reasoning_effort="high"), "maximum"),
    ({"chatgpt": {"allowedModels": ["unavailable"]}}, DelegateTask(1, "x"), "No allowed"),
    ({"chatgpt": {"maxEffort": "none"}}, DelegateTask(1, "x"), "cannot honor"),
])
def test_explicit_and_impossible_routes_fail_with_actionable_owner_limit(preferences, task, message):
    with pytest.raises(ToolExecutionFailure, match=message):
        resolve_subagent_model_route(SimpleNamespace(_config=_config()), _context(subagent_routing=preferences), task)


def test_parallel_mixed_owned_engines_close_and_release_success_failure_cancel(monkeypatch):
    import threading
    parent = _kernel()
    created = []
    rendezvous = threading.Barrier(3)
    def factory(config, **kwargs):
        engine = _Engine(config.model)
        created.append(engine)
        return EngineSelection(engine, config.engine_type, config.model)
    monkeypatch.setattr("sidecar.ai.engines.factory.create_engine", factory)
    def decision(kernel, **kwargs):
        rendezvous.wait(timeout=5)
        if kernel._config.model == "gpt-5.6-sol":
            raise RuntimeError("fixture provider failed")
        if kernel._config.model == "gpt-5.3-codex-spark":
            raise TerminalChatStateError(status="cancelled", message="fixture child cancelled")
        return ChatDecision(None, "evidence", None, ())
    monkeypatch.setattr(AgentKernel, "build_chat_decision", decision)
    context = _context()
    runtime = LoopRuntime(request_id="parent", session_id="session", request_context=context,
        sub_agent_slot_allocator=SubAgentSlotAllocator(max_active_sub_agents=3, max_sub_agents_per_parent=3))
    schedule = scheduler.schedule_delegate_tasks(router=parent, parent_context=context, runtime=runtime,
        request=validate_delegate_arguments({"tasks": [{"prompt": "x", "model": model} for model in
            ["gpt-6-luna", "gpt-5.6-sol", "gpt-5.3-codex-spark"]]}),
        parent_request_id="parent", call_id="call", parent_agent_id="main@parent")
    assert [item.result.status for item in schedule.invocations] == ["completed", "failed", "cancelled"]
    assert len(created) == 3 and all(engine.closed == engine.unloaded == 1 for engine in created)
    assert parent._engine.closed == parent._engine.unloaded == 0
    assert runtime.sub_agent_slot_allocator.snapshot()["active_sub_agents"] == 0


@pytest.mark.parametrize("explicit", [None, "default"])
def test_codex_provider_default_cannot_bypass_low_maximum(explicit):
    config = _config(engine_type="codex-cli", model="codex-cli/default")
    context = replace(_context(subagent_routing={"codex-cli": {"maxEffort": "low", "defaultEffort": "default"}}), reasoning_effort="default")
    route = resolve_subagent_model_route(SimpleNamespace(_config=config), context, DelegateTask(1, "x", reasoning_effort=explicit))
    assert route.reasoning_effort == "low"


def _ollama_router(model_name: str) -> Any:
    import threading

    from sidecar.ai.engines.ollama import OllamaEngine

    engine = object.__new__(OllamaEngine)
    engine.host = "http://localhost:11434"
    engine.model_name = model_name
    engine._ready = True
    engine._thinking = True
    engine._thinking_capability_source = "capabilities"
    engine._request_context_lock = threading.Lock()
    return SimpleNamespace(_config=_config(engine_type="ollama", model=model_name), _engine=engine)


def test_local_explicit_effort_the_loaded_model_ignores_is_rejected() -> None:
    router = _ollama_router("qwen3.5:9b")
    assert router._engine._build_think_value("high") is True, "the adapter degrades high to automatic"
    with pytest.raises(ToolExecutionFailure, match="unavailable for the loaded model"):
        resolve_subagent_model_route(
            router, _context(), DelegateTask(1, "x", reasoning_effort="high")
        )
    route = resolve_subagent_model_route(
        router, _context(), DelegateTask(1, "x", reasoning_effort="none")
    )
    assert route.reasoning_effort == "none"


def test_local_graded_model_accepts_and_reports_the_applied_effort() -> None:
    router = _ollama_router("qwen3.8:27b-q3-k-s")
    route = resolve_subagent_model_route(
        router, _context(), DelegateTask(1, "x", reasoning_effort="low")
    )
    assert route.reasoning_effort == "low"
    assert router._engine._build_think_value(route.reasoning_effort) == "low"


def test_local_inherited_effort_the_model_ignores_is_not_reported_as_applied() -> None:
    router = _ollama_router("qwen3.5:9b")
    route = resolve_subagent_model_route(router, _context(), DelegateTask(1, "x"))
    assert route.reasoning_effort is None
