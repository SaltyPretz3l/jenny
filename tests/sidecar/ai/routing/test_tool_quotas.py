from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.routing.tool_quotas import (
    ToolQuotaPolicy,
    ToolQuotaRegistry,
    count_session_tool_results,
    policy_from_config,
)
from sidecar.ai.tools.models import ToolCallRequest


def _call(tool_id: str, *, call_id: str = "", arguments: dict[str, object] | None = None):
    return ToolCallRequest(
        tool_id=tool_id,
        call_id=call_id or tool_id,
        arguments=arguments or {},
    )


def test_tool_quota_registry_caps_web_tool_calls_per_turn() -> None:
    registry = ToolQuotaRegistry(
        ToolQuotaPolicy(max_web_tool_calls_per_turn=2),
        session_tool_call_count=0,
    )
    calls = [_call("web_search", call_id=f"web-{index}") for index in range(3)]

    decision = registry.filter_calls(calls, tool_contract=None)

    assert [call.call_id for call in decision.allowed] == ["web-0", "web-1"]
    assert [blocked.call.call_id for blocked in decision.blocked] == ["web-2"]
    assert decision.blocked[0].metadata["quota_scope"] == "web_per_turn"
    assert decision.blocked[0].metadata["cap"] == 2


def test_tool_quota_registry_caps_code_intelligence_calls_per_turn() -> None:
    registry = ToolQuotaRegistry(
        ToolQuotaPolicy(max_code_intelligence_tool_calls_per_turn=2),
        session_tool_call_count=0,
    )
    calls = [
        _call("lsp", call_id="lsp-0", arguments={"action": "definition"}),
        _call("lsp", call_id="lsp-1", arguments={"action": "references"}),
        _call("lsp", call_id="lsp-2", arguments={"action": "symbols"}),
    ]

    decision = registry.filter_calls(calls, tool_contract=None)

    assert [call.call_id for call in decision.allowed] == ["lsp-0", "lsp-1"]
    assert [blocked.call.call_id for blocked in decision.blocked] == ["lsp-2"]
    assert decision.blocked[0].metadata["quota_scope"] == "code_intelligence_per_turn"
    assert decision.blocked[0].metadata["cap"] == 2


def test_tool_quota_registry_enforces_session_tool_budget() -> None:
    registry = ToolQuotaRegistry(
        ToolQuotaPolicy(max_tool_calls_per_session=3),
        session_tool_call_count=2,
    )

    decision = registry.filter_calls(
        [_call("read_file", call_id="read-1"), _call("glob_files", call_id="glob-1")],
        tool_contract=None,
    )

    assert [call.call_id for call in decision.allowed] == ["read-1"]
    assert [blocked.call.call_id for blocked in decision.blocked] == ["glob-1"]
    assert decision.blocked[0].metadata["quota_scope"] == "session_tool_budget"
    assert decision.blocked[0].metadata["used"] == 3


def test_tool_quota_registry_uses_tool_cooldown_after_quota_block() -> None:
    registry = ToolQuotaRegistry(
        ToolQuotaPolicy(max_web_tool_calls_per_turn=1, tool_cooldown_seconds=30),
        session_tool_call_count=0,
    )

    decision = registry.filter_calls(
        [
            _call("web_search", call_id="web-1"),
            _call("web_search", call_id="web-2"),
            _call("web_search", call_id="web-3"),
        ],
        tool_contract=None,
    )

    assert [call.call_id for call in decision.allowed] == ["web-1"]
    assert [blocked.metadata["quota_scope"] for blocked in decision.blocked] == [
        "web_per_turn",
        "tool_cooldown",
    ]
    assert decision.blocked[1].metadata["cooldown_remaining_seconds"] > 0


def test_count_session_tool_results_reads_canonical_history() -> None:
    assert count_session_tool_results(
        [
            {"kind": "tool_result", "tool_result": {"call_id": "call-1"}},
            {"role": "tool", "tool_call_id": "call-2"},
            {"kind": "assistant", "content": "not a tool"},
        ]
    ) == 2


def test_tool_quota_policy_from_config_fails_open_on_malformed_values() -> None:
    config = SimpleNamespace(
        max_web_tool_calls_per_turn="not-an-int",
        max_code_intelligence_tool_calls_per_turn=10_000,
        max_tool_calls_per_session=10_000,
    )

    policy = policy_from_config(config)

    assert policy.max_web_tool_calls_per_turn == 10
    assert policy.max_code_intelligence_tool_calls_per_turn == 16
    assert policy.max_tool_calls_per_session == 200


def test_tool_quota_policy_from_config_uses_the_local_profile_by_default() -> None:
    policy = policy_from_config(parse_runtime_config({}))

    assert policy.max_web_tool_calls_per_turn == 10
    assert policy.max_tool_calls_per_session == 200
    assert policy.max_code_intelligence_tool_calls_per_turn == 16


def test_tool_quota_policy_from_config_widens_web_and_session_quotas_for_cloud_engines() -> None:
    policy = policy_from_config(parse_runtime_config({"engine_type": "chatgpt"}))

    assert policy.max_web_tool_calls_per_turn == 30
    assert policy.max_tool_calls_per_session == 2_000
    # The code-intelligence cap is profile-independent.
    assert policy.max_code_intelligence_tool_calls_per_turn == 16


def test_tool_quota_policy_from_config_returns_local_quotas_when_flag_is_off() -> None:
    policy = policy_from_config(
        parse_runtime_config(
            {"engine_type": "codex-cli", "feature_flags": {"cloud_loop_profile": False}}
        )
    )

    assert policy.max_web_tool_calls_per_turn == 10
    assert policy.max_tool_calls_per_session == 200


def test_refund_web_call_releases_budget() -> None:
    registry = ToolQuotaRegistry(
        ToolQuotaPolicy(max_web_tool_calls_per_turn=2),
        session_tool_call_count=0,
    )
    decision = registry.filter_calls(
        [_call("web_search", call_id="web-0"), _call("web_search", call_id="web-1")],
        tool_contract=None,
    )
    assert len(decision.allowed) == 2
    assert registry._web_calls == 2

    # Refund a failed web call → a slot frees up (no block, so no cooldown side effect).
    assert registry.refund_web_call(_call("web_search"), tool_contract=None) is True
    assert registry._web_calls == 1

    allowed = registry.filter_calls([_call("web_search", call_id="web-2")], tool_contract=None)
    assert [call.call_id for call in allowed.allowed] == ["web-2"]
    assert not allowed.blocked


def test_refund_clears_web_quota_cooldown_after_mixed_batch() -> None:
    registry = ToolQuotaRegistry(
        ToolQuotaPolicy(max_web_tool_calls_per_turn=2, tool_cooldown_seconds=30),
        session_tool_call_count=0,
    )
    first = registry.filter_calls(
        [
            _call("web_search", call_id="web-a"),
            _call("web_search", call_id="web-b"),
            _call("web_search", call_id="web-blocked"),
        ],
        tool_contract=None,
    )
    assert [call.call_id for call in first.allowed] == ["web-a", "web-b"]
    assert [blocked.metadata["quota_scope"] for blocked in first.blocked] == [
        "web_per_turn"
    ]

    assert registry.refund_web_call_for_outcome(
        SimpleNamespace(tool_name="web_search", success=False, call_id="web-a"),
        tool_contract=None,
    )

    retry = registry.filter_calls(
        [_call("web_search", call_id="web-retry")],
        tool_contract=None,
    )
    assert [call.call_id for call in retry.allowed] == ["web-retry"]
    assert not retry.blocked


def test_refund_web_call_never_below_zero() -> None:
    registry = ToolQuotaRegistry(ToolQuotaPolicy(max_web_tool_calls_per_turn=4))

    assert registry._web_calls == 0
    assert registry.refund_web_call(_call("web_search"), tool_contract=None) is False
    assert registry._web_calls == 0


def test_refund_non_web_call_is_noop() -> None:
    registry = ToolQuotaRegistry(ToolQuotaPolicy(max_web_tool_calls_per_turn=4))
    registry.filter_calls([_call("web_search", call_id="w0")], tool_contract=None)
    assert registry._web_calls == 1

    assert registry.refund_web_call(_call("read_file"), tool_contract=None) is False
    assert registry._web_calls == 1


def test_refund_web_call_keeps_session_count() -> None:
    registry = ToolQuotaRegistry(
        ToolQuotaPolicy(max_web_tool_calls_per_turn=4),
        session_tool_call_count=0,
    )
    registry.filter_calls([_call("web_search", call_id="w0")], tool_contract=None)
    assert registry.session_tool_call_count == 1
    assert registry._web_calls == 1

    registry.refund_web_call(_call("web_search"), tool_contract=None)

    assert registry._web_calls == 0
    # The coarse per-session runaway breaker still counts the attempt.
    assert registry.session_tool_call_count == 1


def test_refund_web_call_for_outcome_matches_by_tool_name() -> None:
    registry = ToolQuotaRegistry(ToolQuotaPolicy(max_web_tool_calls_per_turn=4))
    registry.filter_calls(
        [_call("web_search", call_id="w0"), _call("fetch_url", call_id="f0")],
        tool_contract=None,
    )
    assert registry._web_calls == 2

    web_outcome = SimpleNamespace(tool_name="web_search", success=False, call_id="w0")
    fetch_outcome = SimpleNamespace(tool_name="fetch_url", success=False, call_id="f0")
    non_web_outcome = SimpleNamespace(tool_name="read_file", success=False, call_id="r0")

    assert registry.refund_web_call_for_outcome(web_outcome, tool_contract=None) is True
    assert registry.refund_web_call_for_outcome(fetch_outcome, tool_contract=None) is True
    assert registry.refund_web_call_for_outcome(non_web_outcome, tool_contract=None) is False
    assert registry._web_calls == 0


def test_only_successful_web_calls_count_toward_cap() -> None:
    registry = ToolQuotaRegistry(
        ToolQuotaPolicy(max_web_tool_calls_per_turn=2),
        session_tool_call_count=0,
    )

    # Two web calls fail → both refunded, so they consume no budget.
    first = registry.filter_calls(
        [_call("web_search", call_id="w0"), _call("web_search", call_id="w1")],
        tool_contract=None,
    )
    assert len(first.allowed) == 2
    for call_id in ("w0", "w1"):
        registry.refund_web_call_for_outcome(
            SimpleNamespace(tool_name="web_search", success=False, call_id=call_id),
            tool_contract=None,
        )
    assert registry._web_calls == 0

    # Two web calls succeed (no refund) → budget now at the cap.
    second = registry.filter_calls(
        [_call("web_search", call_id="w2"), _call("web_search", call_id="w3")],
        tool_contract=None,
    )
    assert len(second.allowed) == 2
    assert registry._web_calls == 2

    # The next web call is blocked at the per-turn cap.
    third = registry.filter_calls([_call("web_search", call_id="w4")], tool_contract=None)
    assert [blocked.metadata["quota_scope"] for blocked in third.blocked] == ["web_per_turn"]
