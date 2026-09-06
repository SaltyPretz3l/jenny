"""Shared local-engine request-context wiring."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class _RequestBinding:
    engine: Any
    context: dict[str, Any]
    diagnostics_store: Any | None


_ACTIVE_REQUEST_BINDING: ContextVar[_RequestBinding | None] = ContextVar(
    "sidecar_active_local_engine_request",
    default=None,
)


def _current_binding(engine: Any) -> _RequestBinding | None:
    binding = _ACTIVE_REQUEST_BINDING.get()
    if binding is None or binding.engine is not engine:
        return None
    return binding


def build_app_profile_behavior(runtime_config: Any) -> dict[str, Any]:
    return {
        "family": getattr(runtime_config, "resolved_app_profile_family", None),
        "variant": getattr(runtime_config, "resolved_app_profile_variant", None),
        "temperature": getattr(runtime_config, "resolved_app_profile_temperature", None),
        "top_k": getattr(runtime_config, "resolved_app_profile_top_k", None),
        "top_p": getattr(runtime_config, "resolved_app_profile_top_p", None),
        "min_p": getattr(runtime_config, "resolved_app_profile_min_p", None),
        "presence_penalty": getattr(
            runtime_config,
            "resolved_app_profile_presence_penalty",
            None,
        ),
        "repeat_penalty": getattr(
            runtime_config,
            "resolved_app_profile_repeat_penalty",
            None,
        ),
        "reasoning_parser_start": getattr(
            runtime_config,
            "resolved_app_profile_reasoning_parser_start",
            None,
        ),
        "reasoning_parser_end": getattr(
            runtime_config,
            "resolved_app_profile_reasoning_parser_end",
            None,
        ),
        "thinking_sampler": getattr(
            runtime_config,
            "resolved_app_profile_thinking_sampler",
            None,
        ),
        "instruct_sampler": getattr(
            runtime_config,
            "resolved_app_profile_instruct_sampler",
            None,
        ),
        "max_output_tokens": getattr(
            runtime_config,
            "resolved_app_profile_max_output_tokens",
            None,
        ),
        "thinking_token_headroom": getattr(
            runtime_config,
            "resolved_app_profile_thinking_token_headroom",
            None,
        ),
    }


def install_request_context(
    engine: Any,
    *,
    request_id: str,
    trace_id: str | None = None,
    diagnostics_store: Any | None = None,
    debug_options: dict[str, Any] | None = None,
    mode: str | None = None,
    agent_id: str | None = None,
    agent_depth: int = 0,
    app_profile_behavior: dict[str, Any] | None = None,
    tracked_flags: Iterable[str] = (),
) -> None:
    context: dict[str, Any] = {
        "request_id": str(request_id or "").strip(),
        "trace_id": str(trace_id or "").strip() or None,
        "debug_options": dict(debug_options) if isinstance(debug_options, dict) else {},
        "mode": str(mode or "").strip() or None,
        "agent_id": str(agent_id or "").strip() or None,
        "agent_depth": max(0, int(agent_depth or 0)),
        "app_profile_behavior": (
            dict(app_profile_behavior) if isinstance(app_profile_behavior, dict) else {}
        ),
    }
    for flag in tracked_flags:
        token = str(flag or "").strip()
        if token:
            context[token] = False
    _ACTIVE_REQUEST_BINDING.set(
        _RequestBinding(
            engine=engine,
            context=context,
            diagnostics_store=diagnostics_store,
        )
    )


def clear_request_context(engine: Any, *, request_id: str | None = None) -> None:
    normalized = str(request_id or "").strip()
    binding = _current_binding(engine)
    if binding is None:
        return
    current_request_id = str(binding.context.get("request_id") or "").strip()
    if normalized and current_request_id and current_request_id != normalized:
        return
    _ACTIVE_REQUEST_BINDING.set(None)


def current_request_context(engine: Any) -> dict[str, Any] | None:
    binding = _current_binding(engine)
    if binding is not None:
        return binding.context
    return None


def current_diagnostics_store(engine: Any) -> Any | None:
    binding = _current_binding(engine)
    if binding is not None and binding.diagnostics_store is not None:
        return binding.diagnostics_store
    return getattr(engine, "_turn_diagnostics_store", None)


def request_id(engine: Any) -> str:
    context = current_request_context(engine)
    if context is None:
        return ""
    return str(context.get("request_id") or "").strip()


def debug_option_enabled(engine: Any, key: str) -> bool:
    context = current_request_context(engine)
    if context is None:
        return False
    debug_options = context.get("debug_options")
    return isinstance(debug_options, dict) and debug_options.get(key) is True


def current_app_profile_behavior(engine: Any) -> dict[str, Any]:
    context = current_request_context(engine)
    if context is None:
        return {}
    behavior = context.get("app_profile_behavior")
    return dict(behavior) if isinstance(behavior, dict) else {}


def effective_temperature(engine: Any, requested_temperature: float) -> float:
    behavior = current_app_profile_behavior(engine)
    override = behavior.get("temperature")
    if isinstance(override, (int, float)):
        return float(override)
    return requested_temperature


def effective_top_k(engine: Any) -> int | None:
    behavior = current_app_profile_behavior(engine)
    override = behavior.get("top_k")
    if isinstance(override, (int, float)):
        candidate = int(override)
        if candidate > 0:
            return candidate
    return None


def _bounded_float_from_behavior(
    engine: Any,
    key: str,
    *,
    min_value: float,
    max_value: float,
    exclusive_min: bool = False,
) -> float | None:
    behavior = current_app_profile_behavior(engine)
    override = behavior.get(key)
    if not isinstance(override, (int, float)):
        return None
    candidate = float(override)
    if exclusive_min:
        if not (min_value < candidate <= max_value):
            return None
    elif not (min_value <= candidate <= max_value):
        return None
    return candidate


def effective_top_p(engine: Any) -> float | None:
    return _bounded_float_from_behavior(
        engine,
        "top_p",
        min_value=0.0,
        max_value=1.0,
    )


def effective_min_p(engine: Any) -> float | None:
    return _bounded_float_from_behavior(
        engine,
        "min_p",
        min_value=0.0,
        max_value=1.0,
    )


def effective_presence_penalty(engine: Any) -> float | None:
    return _bounded_float_from_behavior(
        engine,
        "presence_penalty",
        min_value=-2.0,
        max_value=2.0,
    )


def effective_repeat_penalty(engine: Any) -> float | None:
    return _bounded_float_from_behavior(
        engine,
        "repeat_penalty",
        min_value=0.0,
        max_value=2.0,
        exclusive_min=True,
    )


def effective_sampler(
    engine: Any,
    requested_temperature: float,
    *,
    thinking: bool,
) -> dict[str, float | int | None]:
    """Resolve a mode preset, falling back to the legacy per-field behavior."""

    behavior = current_app_profile_behavior(engine)
    preset_key = "thinking_sampler" if thinking else "instruct_sampler"
    preset = behavior.get(preset_key)
    if isinstance(preset, dict):
        return {
            "temperature": preset.get("temperature", requested_temperature),
            "top_k": preset.get("top_k"),
            "top_p": preset.get("top_p"),
            "min_p": preset.get("min_p"),
            "presence_penalty": preset.get("presence_penalty"),
            "repeat_penalty": preset.get("repeat_penalty"),
        }
    return {
        "temperature": effective_temperature(engine, requested_temperature),
        "top_k": effective_top_k(engine),
        "top_p": effective_top_p(engine),
        "min_p": effective_min_p(engine),
        "presence_penalty": effective_presence_penalty(engine),
        "repeat_penalty": effective_repeat_penalty(engine),
    }


def bind_chat_request_context(
    engine: Any,
    *,
    request_context: Any,
    runtime_config: Any,
    diagnostics_store: Any | None = None,
) -> None:
    if not hasattr(engine, "begin_request_context"):
        return
    engine.begin_request_context(
        request_id=str(getattr(request_context, "request_id", "") or "").strip(),
        trace_id=str(getattr(request_context, "trace_id", "") or "").strip() or None,
        diagnostics_store=diagnostics_store,
        debug_options=getattr(request_context, "debug_options", None),
        mode=getattr(request_context, "mode", None),
        agent_id=getattr(request_context, "agent_id", None),
        agent_depth=getattr(request_context, "agent_depth", 0),
        app_profile_behavior=build_app_profile_behavior(runtime_config),
    )


def clear_chat_request_context(engine: Any, *, request_id: str) -> None:
    if not hasattr(engine, "clear_request_context"):
        return
    engine.clear_request_context(request_id=request_id)


@contextmanager
def scoped_chat_request_context(
    engine: Any,
    *,
    request_context: Any,
    runtime_config: Any,
    diagnostics_store: Any | None = None,
):
    """Bind a nested engine context and restore the previous binding exactly."""

    previous = _ACTIVE_REQUEST_BINDING.get()
    bind_chat_request_context(
        engine,
        request_context=request_context,
        runtime_config=runtime_config,
        diagnostics_store=diagnostics_store,
    )
    try:
        yield
    finally:
        clear_chat_request_context(
            engine,
            request_id=str(getattr(request_context, "request_id", "") or "").strip(),
        )
        _ACTIVE_REQUEST_BINDING.set(previous)
