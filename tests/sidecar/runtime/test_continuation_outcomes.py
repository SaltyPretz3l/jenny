from __future__ import annotations

import hashlib
import json

import pytest

from sidecar.runtime.chat_continuation_resume import HydratedBeforeToolDispatchResume
from sidecar.runtime.continuation_codec import encode_continuation_checkpoint
from tests.sidecar.runtime.test_chat_continuation_resume import _canonical
from tests.sidecar.runtime.test_dependency_continuation_resume import dependency_artifacts


def artifacts(*, mixed=False, mutate=None):
    source = dependency_artifacts()
    checkpoint = json.loads(source["checkpoint_body"])
    receipt = {"root_run_id": "root_1", "child_work_id": "child_1",
               "session_id": "child_session", "turn_id": "child_turn"}
    # Raw provider bytes deliberately differ from normalized child-receipt bytes.
    output = json.dumps(receipt, indent=2)
    checkpoint["completed_spawn_refs"][0]["result_sha256"] = hashlib.sha256(
        _canonical(receipt)).hexdigest()
    event = {"event_id": "stream_a:canonical:3", "turn_id": checkpoint["identity"]["turn_id"],
             "kind": "tool_result", "tool_call_id": "spawn_1", "payload": {
                 "tool_name": "session_spawn", "success": True, "tool_output_summary": output,
                 "tool_input": {"task": "Read"}, "metadata": {"effects": "unknown"}}}
    events = [event]
    if mixed:
        checkpoint.update(base_schema_version=5, completed_wait_refs=[], prior_checkpoint_ref=None,
                          prior_effect_count=0, completed_effect_refs=[{
                              "call_id": "spawn_1", "tool_id": "session_spawn", "success": True,
                              "result_sha256": hashlib.sha256(output.encode()).hexdigest()}])
    if mutate:
        mutate(checkpoint, events)
    body = _canonical(events)
    checkpoint["canonical_refs"]["turn_ref"]["sha256"] = hashlib.sha256(body).hexdigest()
    encoded = encode_continuation_checkpoint(checkpoint)
    source.update(checkpoint_body=encoded.body, checkpoint_sha256=encoded.sha256,
                  canonical_events_bytes=body, allow_dependency=True)
    source["checkpoint_ref"].update(sha256=encoded.sha256, bytes=len(encoded.body))
    return source


@pytest.mark.parametrize("mixed", [False, True])
def test_dependency_hydrates_exact_outputs_separately_from_child_receipt_hash(mixed):
    source = artifacts(mixed=mixed)
    hydrated = HydratedBeforeToolDispatchResume.from_artifacts(**source)
    outcome, = hydrated.completed_outcomes()
    assert outcome.output == json.loads(source["canonical_events_bytes"])[0]["payload"]["tool_output_summary"]
    assert outcome.metadata == {"effects": "unknown"}
    assert outcome.call_id == "spawn_1"


def test_mixed_dependency_requires_canonical_outcome_carrier():
    source = artifacts(mixed=True)
    del source["canonical_events_bytes"]
    with pytest.raises(ValueError, match="decision_canonical_events_missing"):
        HydratedBeforeToolDispatchResume.from_artifacts(**source)


@pytest.mark.parametrize("mixed", [False, True])
@pytest.mark.parametrize("change", ["result", "missing", "duplicate", "mutation", "attachment"])
def test_dependency_refuses_inconsistent_or_unsupported_outcome_evidence(mixed, change):
    def mutate(_checkpoint, events):
        payload = events[0]["payload"]
        if change == "result":
            payload["tool_output_summary"] = '{}'
        elif change == "missing":
            events.clear()
        elif change == "duplicate":
            events.append(events[0])
        elif change == "mutation":
            payload["metadata"]["workspace_change_set"] = {}
        else:
            payload["trusted_attachment_refs"] = [{"id": "unrestored"}]
    with pytest.raises(ValueError):
        HydratedBeforeToolDispatchResume.from_artifacts(**artifacts(mixed=mixed, mutate=mutate))
