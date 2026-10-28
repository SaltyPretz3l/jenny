"""Shared settled-effect ledger and observable capture skips (review C5-B/C5-C/C5-H)."""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.routing import tool_resource_progress as progress
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.runtime import decision_checkpoint


def _outcome(call_id: str, tool: str = "read_file") -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name=tool, output="ok", success=True, tool_input={"path": "a"}, call_id=call_id
    )


def _loop(outcomes: list[ToolExecutionOutcome], records: dict, emitted: set) -> Any:
    return SimpleNamespace(
        request_context=SimpleNamespace(),
        outcomes=outcomes,
        tool_contract=None,
        runtime=SimpleNamespace(emitted_tool_calls=records, tool_result_emitted_call_ids=emitted),
    )


@pytest.fixture
def predecessor(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    state: dict[str, Any] = {"previous": [], "predecessor": None}
    monkeypatch.setattr(decision_checkpoint, "_assert_supported", lambda _plan: None)
    monkeypatch.setattr(
        decision_checkpoint, "_previous",
        lambda _context: (state["previous"], state["predecessor"]),
    )
    return state


def test_settled_effects_reports_the_canonical_checkpoint_fields(predecessor: dict) -> None:
    first, second = _outcome("call_1"), _outcome("call_2")
    predecessor["previous"] = progress.outcome_refs([first])
    predecessor["predecessor"] = {"sha256": "b" * 64, "checkpoint_id": "cp_1", "bytes": 3}
    records = {"call_2": {"tool_name": "read_file", "arguments": {"path": "a"}}}
    settled = progress.settled_effects(
        _loop([first, second], records, {"call_2"}), quota_state_json=None
    )
    assert settled is not None
    fields = settled.checkpoint_fields()
    assert json.loads(fields["completed_effects_json"]) == progress.outcome_refs([first, second])
    # One canonical dump for every subclass (progress used plain json.dumps before).
    assert fields["prior_checkpoint_json"] == (
        b'{"bytes":3,"checkpoint_id":"cp_1","sha256":"' + b"b" * 64 + b'"}'
    )
    assert (fields["prior_effect_count"], fields["current_execution_count"]) == (1, 1)


def test_settled_effects_is_none_while_a_current_execution_is_unsettled(
    predecessor: dict,
) -> None:
    records = {"call_1": {"tool_name": "read_file", "arguments": {"path": "a"}}}
    loop = _loop([_outcome("call_1")], records, set())
    assert progress.settled_effects(loop, quota_state_json=None) is None


def test_settled_effects_rejects_changed_predecessor_effects(predecessor: dict) -> None:
    predecessor["previous"] = progress.outcome_refs([_outcome("call_9")])
    with pytest.raises(ValueError, match="continuation_effects_changed"):
        progress.settled_effects(_loop([_outcome("call_1")], {}, set()), quota_state_json=None)


def test_mixed_dependency_raises_when_settled_effects_are_unsettled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sidecar.ai.routing import tool_mixed_dependency_wait as mixed

    monkeypatch.setattr(mixed, "settled_effects", lambda *_a, **_k: None)
    monkeypatch.setattr(mixed, "_freeze_loop_quota", lambda _loop: None)
    loop = SimpleNamespace(
        request_context=SimpleNamespace(runtime_continuation_resume=None),
        runtime=SimpleNamespace(dependency_resume=None),
        outcomes=[_outcome("call_1", "session_wait")],
    )
    with pytest.raises(ValueError, match="mixed_dependency_execution_unsettled"):
        mixed.mixed_dependency_state(loop)


def test_suspend_logs_a_skipped_capture(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def broken(*_args: Any) -> Any:
        raise TypeError("bad loop shape")

    monkeypatch.setattr(progress, "_capture", broken)
    with caplog.at_level(logging.WARNING, logger=progress.__name__):
        assert progress._suspend(SimpleNamespace(), 1, object(), ()) is None
    record = next(r for r in caplog.records if r.name == progress.__name__)
    assert record.levelno == logging.WARNING
    assert getattr(record, "event", "") == "ai.router.resource_progress_capture_skipped"
    assert record.data == {"error_type": "TypeError"}
