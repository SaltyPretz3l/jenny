"""Bounded, display-safe telemetry for sub-agent progress and reports."""

from __future__ import annotations

from typing import Any, Iterable

from sidecar.ai.routing.iteration_limits import (
    parse_sub_agent_report_object as _parse_sub_agent_report_object,
)
from sidecar.ai.tools.sanitization import sanitize_tool_output

MAX_TELEMETRY_IDENTIFIER_CHARS = 96
MAX_TELEMETRY_TOKENS = 2_147_483_647
MAX_DISTINCT_ROUTES = 6


def parse_sub_agent_report_object(response_text: str) -> dict[str, Any]:
    """Expose the canonical report parser through the sub-agent support facade."""

    return _parse_sub_agent_report_object(response_text)


def usage_from_decision(decision: Any | None) -> dict[str, Any] | None:
    """Project normalized scalar usage from a child decision; never expose raw usage."""

    if decision is None:
        return None
    raw_usage = getattr(decision, "usage", None)
    values: dict[str, Any] = {}
    for field in ("input_tokens", "output_tokens", "total_tokens"):
        value = _bounded_token_count(getattr(raw_usage, field, None))
        if value is not None:
            values[field] = value
    input_tokens = values.get("input_tokens")
    output_tokens = values.get("output_tokens")
    estimated = False
    if "total_tokens" not in values and input_tokens is not None and output_tokens is not None:
        values["total_tokens"] = min(input_tokens + output_tokens, MAX_TELEMETRY_TOKENS)
        estimated = True
    latest = _bounded_token_count(getattr(raw_usage, "last_request_input_tokens", None))
    if latest is not None:
        values["last_request_input_tokens"] = latest
    for field in ("context_tokens_estimate", "compact_threshold_tokens"):
        value = _bounded_token_count(getattr(decision, field, None))
        if value is not None:
            values[field] = value
    provider = _safe_identifier(getattr(raw_usage, "provider", None))
    model = _safe_identifier(getattr(raw_usage, "model", None))
    if provider:
        values["provider"] = provider
    if model:
        values["model"] = model
    if not values:
        return None
    values["estimated"] = estimated
    return values


def selected_route(router: Any | None) -> dict[str, str]:
    """Return a bounded best-effort selected route for advisory start progress."""

    engine = getattr(router, "_engine", None)
    config = getattr(router, "_config", None)
    model = _safe_identifier(
        getattr(engine, "model_name", None)
        or getattr(config, "model", None)
        or getattr(config, "model_name", None)
    )
    provider_source = (
        getattr(config, "engine_type", None)
        or getattr(engine, "engine_type", None)
        or (type(engine).__name__.removesuffix("Engine") if engine is not None else None)
    )
    provider = _safe_identifier(provider_source)
    return {key: value for key, value in (("provider", provider), ("model", model)) if value}


def terminal_reason(
    *,
    completion_reason: Any = None,
    status: Any = None,
    invalid_report: bool = False,
    error_message: Any = None,
) -> str | None:
    """Map runtime settlement into the small UI-facing terminal reason allowlist."""

    if invalid_report:
        return "invalid_report"
    reason = str(completion_reason or "").strip().lower()
    allowed = {
        "deadline_exceeded",
        "budget_exhausted",
        "max_iterations_summary",
        "capacity_unavailable",
        "cancelled",
        "runtime_unavailable",
        "rejected",
    }
    if reason in allowed:
        return reason
    state = str(status or "").strip().lower()
    if state in {"cancelled", "rejected"}:
        return state
    message = str(error_message or "").strip().lower()
    derived: str | None = None
    if "runtime" in message and "unavailable" in message:
        derived = "runtime_unavailable"
    elif "capacity" in message or "slot" in message:
        derived = "capacity_unavailable"
    elif "budget" in message or "work limit" in message:
        derived = "budget_exhausted"
    return derived


def aggregate_usage(task_reports: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """Sum bounded task usage and retain bounded distinct route summaries."""

    totals = {field: 0 for field in ("input_tokens", "output_tokens", "total_tokens")}
    seen_counts = {field: False for field in totals}
    providers: list[str] = []
    models: list[str] = []
    estimated = False
    for report in task_reports:
        usage = report.get("usage") if isinstance(report, dict) else None
        if not isinstance(usage, dict):
            continue
        for field, current in totals.items():
            value = _bounded_token_count(usage.get(field))
            if value is not None:
                totals[field] = min(current + value, MAX_TELEMETRY_TOKENS)
                seen_counts[field] = True
        estimated = estimated or usage.get("estimated") is True
        _append_distinct(providers, _safe_identifier(usage.get("provider")))
        _append_distinct(models, _safe_identifier(usage.get("model")))
    result: dict[str, Any] = {
        field: value for field, value in totals.items() if seen_counts[field]
    }
    if providers:
        result["providers"] = providers
    if models:
        result["models"] = models
    if not result:
        return None
    result["estimated"] = estimated
    return result


def _bounded_token_count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return min(value, MAX_TELEMETRY_TOKENS)


def _safe_identifier(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    if any(token in value for token in ("\\", "/", ":\\")):
        return ""
    text = sanitize_tool_output(
        value,
        max_chars=MAX_TELEMETRY_IDENTIFIER_CHARS,
        tool_name="subagent_run",
    ).strip()
    if not text:
        return ""
    return text


def _append_distinct(values: list[str], value: str) -> None:
    if value and value not in values and len(values) < MAX_DISTINCT_ROUTES:
        values.append(value)
