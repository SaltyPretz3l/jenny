"""The logical-request quota owner survives fresh physical runtimes."""
from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from sidecar.ai.routing import tool_quota_state
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.quota_runtime import (
    freeze_runtime_quota,
    initialize_runtime_quota,
    restore_runtime_quota,
)
from sidecar.ai.routing.tool_quota_state import decode_quota_state, encode_quota_state
from sidecar.ai.tools.models import ToolCallRequest


def test_decode_quota_state_normalizes_once(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = LoopRuntime(request_id="first")
    initialize_runtime_quota(runtime, SimpleNamespace(), enabled=True)
    state = freeze_runtime_quota(runtime, SimpleNamespace())
    normalize = tool_quota_state.normalize_quota_state
    calls = 0

    def count_normalizations(value):
        nonlocal calls
        calls += 1
        return normalize(value)

    monkeypatch.setattr(tool_quota_state, "normalize_quota_state", count_normalizations)

    assert tool_quota_state.decode_quota_state(state)["enabled"] is True
    assert calls == 1


def test_fresh_runtime_keeps_admissions_refunds_and_original_session_baseline():
    config = SimpleNamespace(max_web_tool_calls_per_turn=2, max_tool_calls_per_session=5)
    runtime = LoopRuntime(request_id="first")
    context = SimpleNamespace(session_tool_call_count=2)
    quota = initialize_runtime_quota(runtime, config, enabled=True, request_context=context)
    calls = (ToolCallRequest(call_id="failed", tool_id="web_search", arguments={"query": "x"}),
             ToolCallRequest(call_id="pending", tool_id="read_file", arguments={"path": "x"}))
    quota.filter_calls(calls, tool_contract=None)
    assert initialize_runtime_quota(runtime, config, enabled=True,
        request_context=SimpleNamespace(session_tool_call_count=99)) is quota
    failed = SimpleNamespace(call_id="failed", tool_name="web_search", success=False)
    state = freeze_runtime_quota(runtime, config, outcomes=(failed,), tool_contract=None)
    fresh = LoopRuntime(request_id="second")
    restore_runtime_quota(fresh, config, state)
    restored = initialize_runtime_quota(fresh, config, enabled=True,
        request_context=SimpleNamespace(session_tool_call_count=100))
    restored.validate_pending_admissions(calls[1:], tool_contract=None)
    assert restored.session_tool_call_count == 4
    again = decode_quota_state(freeze_runtime_quota(fresh, config, outcomes=(failed,)))
    assert again["session_baseline"] == 2
    assert again["admissions"] == decode_quota_state(state)["admissions"]
    last = ToolCallRequest(call_id="last", tool_id="web_search", arguments={"query": "last"})
    assert restored.filter_calls((last,), tool_contract=None).allowed == (last,)
    assert restored.filter_calls((replace(last, call_id="over"),), tool_contract=None).blocked[0].reason == "session_tool_budget"


def test_disabled_proof_and_policy_drift_remain_explicit():
    config = SimpleNamespace(feature_flags={"resource_discipline": False})
    runtime = LoopRuntime(request_id="disabled")
    assert freeze_runtime_quota(runtime, config) is None
    initialize_runtime_quota(runtime, config, enabled=False)
    state = freeze_runtime_quota(runtime, config)
    assert decode_quota_state(state)["enabled"] is False
    restore_runtime_quota(LoopRuntime(request_id="restored"), config, state)
    with pytest.raises(ValueError, match="policy_changed"):
        restore_runtime_quota(LoopRuntime(request_id="enabled"), SimpleNamespace(), state)
    with pytest.raises(ValueError, match="discipline_changed"):
        initialize_runtime_quota(runtime, config, enabled=True)


def test_state_encoding_rejects_noncanonical_duplicate_or_extra_fields():
    runtime = LoopRuntime(request_id="first")
    initialize_runtime_quota(runtime, SimpleNamespace(), enabled=True)
    state = freeze_runtime_quota(runtime, SimpleNamespace())
    assert encode_quota_state(decode_quota_state(state)) == state
    with pytest.raises(ValueError, match="encoding_invalid"):
        decode_quota_state(json.dumps(json.loads(state), indent=2).encode())
    duplicate = state.replace(b'{', b'{"schema_version":1,', 1)
    with pytest.raises(ValueError, match="encoding_invalid"):
        decode_quota_state(duplicate)
    invalid = json.loads(state)
    invalid["provider_cooldowns"] = []
    with pytest.raises(ValueError, match="shape_invalid"):
        encode_quota_state(invalid)
