from __future__ import annotations

import json

import pytest

from sidecar.ai.engines.codex_cli_transport import _structured_result
from sidecar.ai.routing.loop_events import StreamResetEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult
from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing
from tests.sidecar.ai.routing.test_tool_loop import (
    ROUTE_NATIVE_TOOLS,
    _build_router,
    _InbandFallbackEngine,
    _read_file_descriptor,
    _seed_route_profile,
    _StubMCPClient,
    _ToolPlan,
)


@pytest.mark.parametrize(
    ("net_enabled", "parse_failed", "expected_calls"),
    [(True, True, 2), (False, True, 1), (True, False, 1)],
    ids=["structured-repair", "net-off-fallback", "empty-generation-parity"],
)
def test_empty_structured_retry(
    net_enabled: bool, parse_failed: bool, expected_calls: int,
) -> None:
    configure_tool_call_healing({"tool_call_reliability_net_enabled": net_enabled})
    try:
        first_result = GenerationResult()
        if parse_failed:
            first_result = _structured_result(
                [json.dumps({
                    "message": "",
                    "tool_calls": [{"name": "read_file", "arguments_json": '{"path":invalid}'}],
                })],
                ["read_file"],
            )
            assert first_result is not None
            assert first_result.inband_tool_call_parse_failed
        assert not first_result.content
        assert not first_result.tool_calls
        store, _ = _seed_route_profile(route=ROUTE_NATIVE_TOOLS)
        engine = _InbandFallbackEngine(
            plans=[
                _ToolPlan(result=first_result),
                _ToolPlan(result=GenerationResult(content="Recovered.", finish_reason="stop")),
            ],
            store=store,
        )
        router = _build_router(engine=engine, mcp_client=_StubMCPClient((_read_file_descriptor(),)))
        events: list[object] = []
        result = router.build_chat_decision(
            request_id="req_empty_structured_retry",
            messages=[{"role": "user", "content": "read the file"}],
            latest_user_content="read the file",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(
                emit=events.append,
                request_id="req_empty_structured_retry",
                max_iterations=5,
                streaming=True,
            ),
        )
        assert engine.call_count == expected_calls
        if expected_calls == 2:
            assert result.response_text == "Recovered."
        else:
            assert result.response_text == "I could not produce a valid response for that request."
            assert result.completion_source == "deterministic_tool_fallback"
        assert len([
            event for event in events
            if isinstance(event, StreamResetEvent) and event.reason == "reflexive_retry"
        ]) == expected_calls - 1
    finally:
        configure_tool_call_healing(None)
