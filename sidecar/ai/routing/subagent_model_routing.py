"""Request-local model selection for same-provider read-only delegates."""

from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from dataclasses import dataclass, replace
from typing import Any, Iterator

from sidecar.ai.config import normalize_chatgpt_model_catalog
from sidecar.ai.config_models import normalize_subagent_routing
from sidecar.ai.engines.chatgpt_subscription import (
    CHATGPT_MODEL_CONTEXT_LENGTHS,
    CHATGPT_MODEL_REASONING_PROFILES,
)
from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED, CMP_TOOL_SUBAGENT_INVALID_PROMPT
from sidecar.ai.routing.delegate_contracts import DelegateTask
from sidecar.ai.routing.sub_agent_invocation import SubAgentInvocationResult
from sidecar.ai.tools.contracts import ToolExecutionFailure

logger = logging.getLogger(__name__)
_EFFORT_ORDER = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

_CLOUD_PROVIDERS = frozenset({"chatgpt", "codex-cli"})
_LOCAL_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})
_CODEX_EFFORTS = ("default", "none", "minimal", "low", "medium", "high", "xhigh")


@dataclass(frozen=True)
class SubagentModelRoute:
    provider: str
    model: str
    reasoning_effort: str | None
    context_length: int | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "reasoning_effort": self.reasoning_effort,
        }


def invoke_routed_task(  # noqa: PLR0913 - explicit scheduler/invocation boundary.
    *,
    router: Any,
    parent_context: Any,
    task: DelegateTask,
    identity: Any,
    invoke: Any,
    invocation_kwargs: dict[str, Any],
    on_task_started: Any = None,
    on_task_event: Any = None,
    route: SubagentModelRoute,
) -> tuple[Any, SubagentModelRoute]:
    with subagent_router_for_route(router, route) as child_router:
        if on_task_started is not None:
            on_task_started(task, identity, route.to_payload())
        if on_task_event is not None:
            invocation_kwargs["event_sink"] = lambda event: on_task_event(task, identity, event)
        context = replace(parent_context, reasoning_effort=route.reasoning_effort)
        return invoke(router=child_router, parent_context=context, **invocation_kwargs), route


def _model_id(provider: str, model: str) -> str:
    if provider == "codex-cli" and not model.startswith("codex-cli/"):
        return f"codex-cli/{model}"
    return model


def subagent_failure_result(
    identity: Any,
    *,
    code: str = CMP_TOOL_EXECUTION_FAILED,
    message: str = "Sub-agent execution failed.",
    completion_reason: str | None = None,
) -> SubAgentInvocationResult:
    return SubAgentInvocationResult(
        status="cancelled" if completion_reason == "cancelled" else "failed",
        agent_id=identity.agent_id,
        parent_agent_id=identity.parent_agent_id,
        error_code=code,
        error_message=message,
        error_retryable=completion_reason == "capacity_unavailable",
        completion_reason=completion_reason,
    )


def subagent_model_catalog(config: Any, engine: Any = None) -> tuple[dict[str, Any], ...]:
    provider = str(getattr(config, "engine_type", "") or "").lower()
    if provider == "chatgpt":
        # A live host refresh can update the engine overlay before the next config rebuild.
        live = getattr(engine, "_catalog_profiles", None)
        raw_catalog: Any = getattr(config, "chatgpt_model_catalog", ())
        if isinstance(live, dict) and live:
            raw_catalog = list(live.values())
        overlay = normalize_chatgpt_model_catalog(raw_catalog)
        if overlay:
            return overlay
        return tuple(
            {"id": model, "context_length": context, **CHATGPT_MODEL_REASONING_PROFILES[model]}
            for model, context in CHATGPT_MODEL_CONTEXT_LENGTHS.items()
        )
    if provider == "codex-cli":
        models = ["codex-cli/default", *getattr(config, "codex_cli_models", ())]
        current = str(getattr(config, "model", "") or "").strip()
        if current:
            models.append(_model_id(provider, current))
        return tuple(
            {
                "id": model,
                "reasoning_efforts": list(_CODEX_EFFORTS),
                "default_reasoning_effort": "default",
                "context_length": None,
            }
            for model in dict.fromkeys(models)
        )
    return ()


def resolve_subagent_model_route(
    router: Any, parent_context: Any, task: DelegateTask
) -> SubagentModelRoute:
    config = getattr(router, "_config", None)
    provider = str(getattr(config, "engine_type", "") or "").lower()
    engine = getattr(router, "_engine", None)
    current_model = _current_model(router, provider)
    inherited_effort = getattr(parent_context, "reasoning_effort", None)
    if inherited_effort is None:
        inherited_effort = getattr(config, "reasoning_effort", None)
    if provider not in _CLOUD_PROVIDERS:
        if task.model is not None and task.model != current_model:
            raise _route_failure("Local delegation must use the loaded model")
        applies = getattr(engine, "applies_reasoning_effort", None)
        if task.reasoning_effort is not None and (
            task.reasoning_effort not in _LOCAL_EFFORTS
            or (callable(applies) and not applies(task.reasoning_effort))
        ):
            raise _route_failure("Requested reasoning effort is unavailable for the loaded model")
        effort = task.reasoning_effort or inherited_effort
        if effort is not None and callable(applies) and not applies(effort):
            # The adapter degrades it to automatic; never report it as applied.
            _soft_fallback("effort")
            effort = None
        return SubagentModelRoute(provider, current_model, effort)
    preferences = normalize_subagent_routing(
        getattr(parent_context, "subagent_routing", None)
    ).get(provider, {})
    catalog = subagent_model_catalog(config, engine)
    model = _model_id(provider, task.model or preferences.get("defaultModel") or current_model)
    profile = next((row for row in catalog if row["id"] == model), None)
    if profile is None:
        if task.model:
            raise _route_failure(
                "Requested subagent model is unavailable in the active provider catalog"
            )
        _soft_fallback("model")
        model = current_model
        profile = next((row for row in catalog if row["id"] == model), None)
        if profile is None:
            # Account catalogs may omit a parent that is already running. Reuse
            # that engine; its provider resolves the automatic effort.
            profile = {"id": model, "reasoning_efforts": [], "default_reasoning_effort": None}
    allowed = {_model_id(provider, item) for item in preferences.get("allowedModels", [])}
    if allowed and model not in allowed:
        if task.model:
            raise _route_failure(
                "Requested subagent model is outside the allowed models in Settings"
            )
        profile = next((row for row in catalog if row["id"] in allowed), None)
        if profile is None:
            raise _route_failure(
                "No allowed subagent model is available in the active provider catalog"
            )
        model = profile["id"]
        _soft_fallback("allowed_model")
    effort = _resolve_effort(
        task, preferences, profile, current_model, inherited_effort=inherited_effort
    )
    return SubagentModelRoute(provider, model, effort, profile.get("context_length"))


def _resolve_effort(
    task: DelegateTask, preferences: dict[str, Any], profile: dict[str, Any],
    current_model: str, *, inherited_effort: Any,
) -> str | None:
    model = profile["id"]
    default_model = preferences.get("defaultModel") or current_model
    provider = "codex-cli" if model.startswith("codex-cli/") else "chatgpt"
    effort = (task.reasoning_effort
              or (preferences.get("defaultEffort")
                  if model == _model_id(provider, default_model) else None)
              or (inherited_effort if model == current_model else None)
              or profile["default_reasoning_effort"])
    supported = profile["reasoning_efforts"]
    if effort not in supported:
        if task.reasoning_effort:
            raise _route_failure(
                "Requested subagent reasoning effort is unavailable for the selected model"
            )
        _soft_fallback("effort")
        effort = profile["default_reasoning_effort"]
    maximum = preferences.get("maxEffort")
    if maximum and (effort not in _EFFORT_ORDER
                    or _EFFORT_ORDER.index(effort) > _EFFORT_ORDER.index(maximum)):
        if task.reasoning_effort and task.reasoning_effort != "default":
            raise _route_failure(
                "Requested subagent reasoning effort exceeds the maximum in Settings"
            )
        bounded = [item for item in supported if item in _EFFORT_ORDER
                   and _EFFORT_ORDER.index(item) <= _EFFORT_ORDER.index(maximum)]
        if not bounded:
            raise _route_failure(
                "The selected model cannot honor the maximum subagent effort in Settings"
            )
        effort = max(bounded, key=_EFFORT_ORDER.index)
        _soft_fallback("maximum_effort")
    return effort


def _soft_fallback(field: str) -> None:
    logger.info("subagent.routing.soft_fallback field=%s", field)


def _current_model(router: Any, provider: str) -> str:
    config = getattr(router, "_config", None)
    engine = getattr(router, "_engine", None)
    model = str(getattr(engine, "model_name", None) or getattr(engine, "_loaded_model", None)
                or getattr(config, "model", "") or "").strip()
    return _model_id(provider, model) if model else model


@contextmanager
def subagent_router_for_route(router: Any, route: SubagentModelRoute) -> Iterator[Any]:
    config = getattr(router, "_config", None)
    current_model = _current_model(router, route.provider)
    same_model = route.model == _model_id(route.provider, current_model)
    if same_model and (route.provider not in _CLOUD_PROVIDERS
                       or not getattr(config, "fallback_models", ())):
        yield router
        return
    creator = getattr(router, "create_subagent_router", None)
    if config is None or route.provider not in _CLOUD_PROVIDERS or not callable(creator):
        raise _route_failure("Subagent model routing is unavailable")
    child_config = replace(
        config,
        model=route.model,
        reasoning_effort=route.reasoning_effort,
        context_length=(getattr(config, "context_length", None)
                        if same_model else route.context_length),
        context_length_override=(getattr(config, "context_length_override", None)
                                 if same_model else None),
        fallback_models=(),
        chatgpt_model_catalog=(
            subagent_model_catalog(config, getattr(router, "_engine", None))
            if route.provider == "chatgpt" else config.chatgpt_model_catalog
        ),
    )
    child_router = creator(child_config)
    try:
        yield child_router
    finally:
        close_subagent_engine(getattr(child_router, "_engine", None))


def close_subagent_engine(engine: Any) -> None:
    for name in ("unload_model", "close"):
        cleanup = getattr(engine, name, None)
        if callable(cleanup):
            try:
                cleanup()
            except Exception:  # noqa: BLE001 - cleanup must preserve child settlement.
                pass


def render_subagent_model_guidance(
    config: Any, engine: Any = None, subagent_routing: Any = None
) -> str:
    catalog = subagent_model_catalog(config, engine)
    if not catalog:
        return "Local delegates reuse the loaded model and run sequentially."
    provider = str(getattr(config, "engine_type", ""))
    preferences = normalize_subagent_routing(subagent_routing).get(provider, {})
    rows = [
        {key: row[key] for key in ("id", "reasoning_efforts", "default_reasoning_effort")}
        for row in catalog
    ]
    return (
        "Choose each task's model and reasoning_effort only from the active provider catalog. "
        "Honor the user's explicit model and effort instructions for each task. "
        "Use economical models and low effort for bounded lookup or simple evidence collection; "
        "reserve stronger models and higher effort for ambiguity, difficult reasoning, or review. "
        "Preferred models are soft preferences; choose another available model when warranted. "
        "Omitting model uses the configured subagent default, then the parent model. "
        "Omitting effort uses an applicable default, then the parent's same-model effort, "
        "otherwise the selected model's catalog default. "
        "Unavailable explicit choices fail that task; "
        "stale defaults and inherited effort fall back automatically. "
        "Allowed models and maximum effort "
        "are enforced Settings limits that task instructions cannot override.\n"
        f"Active provider: {provider}\nCatalog: {json.dumps(rows, separators=(',', ':'))}\n"
        f"Subagent preferences: {json.dumps(preferences, separators=(',', ':'))}"
    )


def _route_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_SUBAGENT_INVALID_PROMPT, message=message, retryable=False
    )
