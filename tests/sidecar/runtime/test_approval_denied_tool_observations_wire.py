"""Phase 6 Q19 wire-contract test for the approval-denied turn result.

Audit follow-up Gap B: verifies that when an approval is rejected, the
``KIND_USER_APPROVAL_REJECTED`` audit row written by
``emit_approval_rejection`` is reachable through
``chat_result_with_tool_observations`` and lands on the denied turn
result in the exact shape ``managed-sidecar-chat.js`` (line 753) reads
to drive Q19 promotion.

The test stays at the helper-composition layer rather than spinning up a
full ``BrainContainer`` so the wire contract is asserted in isolation.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.tool_observation import (
    KIND_USER_APPROVAL_REJECTED,
    ToolObservationStore,
)
from sidecar.runtime.chat_helpers import emit_approval_rejection
from sidecar.runtime.chat_tool_observations import chat_result_with_tool_observations
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
    TURN_STATE_DENIED,
    build_turn_result,
)


def _make_stack(store: ToolObservationStore | None) -> Any:
    """Match the duck-typed access pattern in
    ``tool_observations_for_request`` (``getattr(stack, 'tool_observations',
    None)``) without dragging in the production ``BrainContainer``."""
    return SimpleNamespace(tool_observations=store)


def test_denied_turn_result_carries_user_approval_rejected_observation() -> None:
    """End-to-end wire contract: ``emit_approval_rejection`` writes the
    audit row, ``chat_result_with_tool_observations`` ships it, and the
    resulting dict matches what ``managed-sidecar-chat.js`` looks for.
    """
    request_id = "req_denied_wire"
    store = ToolObservationStore()
    store.ensure_turn(request_id=request_id)
    stack = _make_stack(store)

    rejection_notification = emit_approval_rejection(
        runtime=None,
        request_id=request_id,
        trace_id="trace_denied",
        session_id="sess_denied",
        tool_name="write_file",
        tool_call_id="call-denied",
        observation_store=store,
    )
    assert rejection_notification["params"]["code"] == "CMP-APPROVAL-REJECTED"

    turn_result = build_turn_result(
        request_id=request_id,
        status=TURN_STATE_DENIED,
        terminal_subcode=TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
    )
    enriched = chat_result_with_tool_observations(
        turn_result,
        stack,
        request_id=request_id,
    )

    # ``managed-sidecar-chat.js`` reads ``result?.tool_observations``;
    # the renderer/Electron bridge then promotes via
    # ``noteToolObservationPromotions``. Assert both halves of that
    # contract on the wire payload.
    assert enriched["status"] == TURN_STATE_DENIED
    assert enriched["request_id"] == request_id
    observations = enriched.get("tool_observations")
    assert isinstance(observations, list)
    assert len(observations) == 1
    payload = observations[0]
    assert payload["kind"] == KIND_USER_APPROVAL_REJECTED
    assert payload["request_id"] == request_id
    assert payload["tool_call_id"] == "call-denied"
    assert payload["tool_name"] == "write_file"
    assert payload["error_code"] == "CMP-APPROVAL-REJECTED"
    assert payload["sequence"] >= 1


def test_denied_turn_result_omits_observations_when_store_empty() -> None:
    """No store rows ⇒ no ``tool_observations`` key on the wire."""
    request_id = "req_no_obs"
    store = ToolObservationStore()
    store.ensure_turn(request_id=request_id)
    stack = _make_stack(store)

    turn_result = build_turn_result(
        request_id=request_id,
        status=TURN_STATE_DENIED,
        terminal_subcode=TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
    )
    enriched = chat_result_with_tool_observations(
        turn_result,
        stack,
        request_id=request_id,
    )

    assert "tool_observations" not in enriched


def test_denied_turn_result_skips_when_store_missing() -> None:
    """A stack without a ``tool_observations`` attribute is tolerated
    (``tool_observations_for_request`` uses ``getattr(..., None)``)."""
    request_id = "req_no_store"
    stack = SimpleNamespace()
    turn_result = build_turn_result(
        request_id=request_id,
        status=TURN_STATE_DENIED,
        terminal_subcode=TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
    )
    enriched = chat_result_with_tool_observations(
        turn_result,
        stack,
        request_id=request_id,
    )
    assert "tool_observations" not in enriched
