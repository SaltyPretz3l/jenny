"""A one-use, app-held approval clears exactly its own parked call."""

from __future__ import annotations

import base64
import hashlib
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.approved_call_park as park_module
import sidecar.runtime.chat_continuation_batch as batch
import sidecar.runtime.chat_continuation_resume as resume
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.continuation_codec import (
    decode_continuation_checkpoint,
    encode_continuation_checkpoint,
)
from tests.sidecar.runtime.test_chat_continuation_resume import (
    _artifacts,
    _canonical,
    _descriptor,
    _fresh_request,
    _preflight_run,
)

Hydrated = resume.HydratedBeforeToolDispatchResume


def _resource_artifacts() -> dict[str, Any]:
    artifacts = _artifacts()
    checkpoint = dict(decode_continuation_checkpoint(artifacts["checkpoint_body"]))
    checkpoint.update(
        schema_version=8, completed_effect_refs=[], prior_checkpoint_ref=None, prior_effect_count=0
    )
    events = _canonical([])
    checkpoint["canonical_refs"]["turn_ref"]["sha256"] = hashlib.sha256(events).hexdigest()
    encoded = encode_continuation_checkpoint(checkpoint)
    artifacts["checkpoint_body"] = encoded.body
    artifacts["checkpoint_sha256"] = encoded.sha256
    artifacts["checkpoint_ref"] = {
        **artifacts["checkpoint_ref"], "sha256": encoded.sha256, "bytes": len(encoded.body),
    }
    artifacts["canonical_events_bytes"] = events
    return artifacts


def _approved_call(artifacts: dict[str, Any]) -> dict[str, Any]:
    pending = decode_continuation_checkpoint(artifacts["checkpoint_body"])["pending_call"]
    return {key: pending[key] for key in ("call_id", "tool_id", "effective_args_sha256")}


def _hydrated(*, granted: bool = True) -> Hydrated:
    artifacts = _resource_artifacts()
    grant = _approved_call(artifacts) if granted else None
    return Hydrated.from_artifacts(**artifacts, approved_call=grant)


def test_hydration_binds_the_grant_to_the_pending_call() -> None:
    assert _hydrated().approved_call_id() == "call_1"
    assert _hydrated(granted=False).approved_call_id() == ""


@pytest.mark.parametrize(
    "tamper",
    [
        {"call_id": "call_2"},
        {"tool_id": "write_metric"},
        {"effective_args_sha256": "0" * 64},
        {"approved": True},
    ],
)
def test_hydration_rejects_a_grant_for_anything_else(tamper: dict[str, Any]) -> None:
    artifacts = _resource_artifacts()
    grant = {**_approved_call(artifacts), **tamper}
    with pytest.raises(resume.ContinuationResumeError, match="invalid_approved_call"):
        Hydrated.from_artifacts(**artifacts, approved_call=grant)


def test_hydration_rejects_a_grant_on_a_checkpoint_that_is_not_a_resource_wait() -> None:
    artifacts = _artifacts()
    with pytest.raises(resume.ContinuationResumeError, match="invalid_approved_call"):
        Hydrated.from_artifacts(**artifacts, approved_call=_approved_call(artifacts))


def _approval(call_id: str) -> Any:
    return SimpleNamespace(tool_call_id=call_id)


def _check(
    monkeypatch: pytest.MonkeyPatch, hydrated: Hydrated, verdicts: list[Any],
) -> tuple[list[Any], list[tuple[str, ...]]]:
    run = _preflight_run(monkeypatch, _descriptor())
    run.request_context.runtime_continuation_resume = hydrated
    asked: list[tuple[str, ...]] = []

    def _recovery(_run: Any, generated: Any, **_kwargs: Any) -> tuple[Any, Any]:
        asked.append(tuple(call.call_id for call in generated.tool_calls))
        return verdicts[len(asked) - 1], generated

    monkeypatch.setattr(batch._tool_loop.tool_loop_recovery, "approval_with_recovery", _recovery)
    approvals: list[Any] = []
    result = GenerationResult(content="", tool_calls=hydrated.tool_calls())
    batch._check_approval(run, result, SimpleNamespace(decisions_by_call={}), approvals)
    return approvals, asked


def test_grant_clears_its_call_and_the_rest_still_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    approvals, asked = _check(monkeypatch, _hydrated(), [_approval("call_1"), None])
    assert approvals == [None]
    assert asked == [("call_1", "call_2"), ("call_2",)]


def test_a_later_call_needing_approval_still_raises_a_card(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    later = _approval("call_2")
    approvals, _asked = _check(monkeypatch, _hydrated(), [_approval("call_1"), later])
    assert approvals == [later]


def test_grant_never_clears_a_different_call(monkeypatch: pytest.MonkeyPatch) -> None:
    other = _approval("call_2")
    approvals, asked = _check(monkeypatch, _hydrated(), [other])
    assert approvals == [other]
    assert asked == [("call_1", "call_2")]


def test_without_a_grant_the_wake_asks_again(monkeypatch: pytest.MonkeyPatch) -> None:
    card = _approval("call_1")
    approvals, _asked = _check(monkeypatch, _hydrated(granted=False), [card])
    assert approvals == [card]


def test_a_consent_free_resume_still_stops_on_a_needed_approval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hydrated = Hydrated.from_artifacts(**_artifacts())
    run = _preflight_run(monkeypatch, _descriptor())
    run.request_context.runtime_continuation_resume = hydrated
    monkeypatch.setattr(
        batch._tool_loop.tool_loop_recovery,
        "approval_with_recovery",
        lambda _run, generated, **_kwargs: (_approval("call_1"), generated),
    )
    result = GenerationResult(content="", tool_calls=hydrated.tool_calls())
    with pytest.raises(batch.ToolExecutionFailure) as stopped:
        batch._check_approval(run, result, SimpleNamespace(decisions_by_call={}), None)
    assert stopped.value.to_error_data() == {"failed_phase": "current_approval_required"}


def test_only_a_resource_wait_or_a_saved_card_may_raise_a_new_card() -> None:
    plain = decode_continuation_checkpoint(_artifacts()["checkpoint_body"])
    waited = decode_continuation_checkpoint(_resource_artifacts()["checkpoint_body"])
    assert batch.asks_fresh_consent(plain) is False
    assert batch.asks_fresh_consent(waited) is True


def test_private_wire_decoder_carries_the_grant() -> None:
    from sidecar.runtime.chat_continuation_input import runtime_continuation_resume_from_params

    request, _runtime = _fresh_request()
    artifacts = _resource_artifacts()
    grant = _approved_call(artifacts)
    for key in ("checkpoint_body", "tool_batch_bytes", "frozen_input_bytes", "canonical_events_bytes"):
        artifacts[key] = base64.b64encode(artifacts[key]).decode("ascii")
    wire = {**artifacts, "approved_call": grant}
    hydrated = runtime_continuation_resume_from_params(
        {"runtime_continuation_resume": wire},
        request_id=request.request_id,
        session_id=request.session_id,
        logical_turn_id="turn_1",
        continuation_context=request.continuation_context,
        execution_context=request.execution_context,
    )
    assert hydrated is not None
    assert hydrated.approved_call_id() == "call_1"


def test_only_the_approved_call_parks(monkeypatch: pytest.MonkeyPatch) -> None:
    parked: list[Any] = []
    seen: dict[str, Any] = {}

    def _callback(loop: Any, iteration: int, *, allow_no_effects: bool) -> Any:
        seen.update(loop=loop, iteration=iteration, allow_no_effects=allow_no_effects)
        return lambda deferred, calls: parked.append((deferred, calls))

    monkeypatch.setattr(park_module, "resource_deferral_callback", _callback)
    on_deferral = park_module.approved_call_deferral_callback(
        SimpleNamespace(approved_call_id="call_1", call_id="ignored"),
        runtime=SimpleNamespace(iteration_base=2, max_iterations=3, current_iteration=3),
        kernel=object(), request_context=object(), tool_contract=object(),
        outcomes=[], change_set_id="change_1",
    )
    deferred = object()
    on_deferral(deferred, [SimpleNamespace(call_id="call_2")])
    assert parked == []
    approved = SimpleNamespace(call_id="call_1")
    on_deferral(deferred, [approved])
    assert parked == [(deferred, (approved,))]
    assert seen["iteration"] == 3 and seen["allow_no_effects"] is True
    assert seen["loop"].iteration_total == 5
    assert seen["loop"].approvals_pre_granted is False
