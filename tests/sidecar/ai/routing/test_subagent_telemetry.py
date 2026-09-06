from types import SimpleNamespace

from sidecar.ai.routing.subagent_telemetry import (
    MAX_TELEMETRY_TOKENS,
    aggregate_usage,
    selected_route,
    terminal_reason,
    usage_from_decision,
)


def test_usage_from_decision_projects_only_bounded_normalized_scalars() -> None:
    usage = SimpleNamespace(
        input_tokens=120,
        output_tokens=30,
        total_tokens=None,
        last_request_input_tokens=40,
        provider="ollama",
        model="qwen3.5:35b",
        raw_usage={"prompt": "must not escape"},
    )
    decision = SimpleNamespace(
        usage=usage,
        context_tokens_estimate=8_000,
        compact_threshold_tokens=24_000,
    )

    assert usage_from_decision(decision) == {
        "input_tokens": 120,
        "output_tokens": 30,
        "total_tokens": 150,
        "last_request_input_tokens": 40,
        "context_tokens_estimate": 8_000,
        "compact_threshold_tokens": 24_000,
        "provider": "ollama",
        "model": "qwen3.5:35b",
        "estimated": True,
    }


def test_usage_from_decision_drops_malformed_values_and_route_paths() -> None:
    usage = SimpleNamespace(
        input_tokens=-1,
        output_tokens=1.5,
        total_tokens=True,
        last_request_input_tokens=None,
        provider=r"C:\provider\secret",
        model="/tmp/model",
    )
    assert usage_from_decision(SimpleNamespace(usage=usage)) is None


def test_aggregate_usage_clamps_counts_and_bounds_distinct_routes() -> None:
    reports = [
        {"usage": {
            "input_tokens": MAX_TELEMETRY_TOKENS,
            "output_tokens": index,
            "total_tokens": MAX_TELEMETRY_TOKENS,
            "provider": f"provider-{index}",
            "model": f"model-{index}",
        }}
        for index in range(9)
    ]
    result = aggregate_usage(reports)
    assert result is not None
    assert result["input_tokens"] == MAX_TELEMETRY_TOKENS
    assert result["total_tokens"] == MAX_TELEMETRY_TOKENS
    assert len(result["providers"]) == 6
    assert len(result["models"]) == 6


def test_selected_route_and_terminal_reason_use_small_display_contracts() -> None:
    router = SimpleNamespace(
        _config=SimpleNamespace(engine_type="ollama", model="gemma3:12b"),
        _engine=None,
    )
    assert selected_route(router) == {"provider": "ollama", "model": "gemma3:12b"}
    assert terminal_reason(completion_reason="deadline_exceeded") == "deadline_exceeded"
    assert terminal_reason(invalid_report=True) == "invalid_report"
    assert terminal_reason(error_message="No subagent slot is available") == "capacity_unavailable"
