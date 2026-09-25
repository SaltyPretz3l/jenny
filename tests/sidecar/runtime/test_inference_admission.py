from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.engines.admitted import (
    InferenceAdmissionDeferred,
    InferenceAdmissionRefused,
    InferenceAttemptContext,
    InferenceAttemptOutcome,
)
from sidecar.runtime.execution_context import execution_context_from_params
from sidecar.runtime.inference_admission import build_inference_admission_callback


def _execution_context(root: Path):
    return execution_context_from_params({"execution_context": {
        "schema_version": 1,
        "authority_revision": "authority_7",
        "project_id": "project_alpha",
        "root_path": str(root),
        "root_id": "root_1234567890abcdef12345678",
        "root_revision": 7,
        "device_id": None,
        "inode": None,
        "tool_policy_snapshot": {"version": 1},
        "knowledge_roots": [],
    }})


def _attempt(*, provider: str = "ollama") -> InferenceAttemptContext:
    return InferenceAttemptContext(
        request_id="request_1",
        session_id="session_1",
        provider=provider,
        model="trusted-model",
        request_source="chat_send",
        attempt=1,
        streaming=True,
    )


class _Reader:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.closed = False

    def __call__(self, _timeout: float) -> dict[str, Any]:
        return self.response

    def close(self) -> None:
        self.closed = True


def _bridge(
    statuses: list[str],
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[_Reader],
    Any,
]:
    sent: list[dict[str, Any]] = []
    factory_kwargs: list[dict[str, Any]] = []
    readers: list[_Reader] = []

    def factory(rpc_id: int, **kwargs: Any) -> _Reader:
        factory_kwargs.append(kwargs)
        status = statuses[len(readers)]

        def response() -> dict[str, Any]:
            params = sent[-1]["params"]
            return {
                "id": rpc_id,
                "result": {
                    "schema_version": 1,
                    "operation_id": params["operation_id"],
                    "status": status,
                },
            }

        class _DeferredReader(_Reader):
            def __call__(self, _timeout: float) -> dict[str, Any]:
                return response()

        reader = _DeferredReader({})
        readers.append(reader)
        return reader

    return sent, factory_kwargs, readers, factory


def _callback(
    tmp_path: Path,
    *,
    statuses: list[str],
    cancel_handle: Any = None,
    require_budget: bool = False,
):
    sent, factory_kwargs, readers, factory = _bridge(statuses)
    callback = build_inference_admission_callback(
        request_id="request_1",
        session_id="session_1",
        execution_context=_execution_context(tmp_path.resolve()),
        engine_type="ollama",
        write_message=sent.append,
        response_reader_factory=factory,
        cancel_handle=cancel_handle,
        require_budget=require_budget,
    )
    assert callback is not None
    return callback, sent, factory_kwargs, readers


def test_granted_attempt_uses_exact_admit_and_settle_contract(tmp_path: Path) -> None:
    cancel_handle = object()
    callback, sent, factory_kwargs, readers = _callback(
        tmp_path,
        statuses=["granted", "settled"],
        cancel_handle=cancel_handle,
    )

    lease = callback(_attempt())
    lease.settle(InferenceAttemptOutcome(status="cancelled", cleanup="uncertain"))
    lease.settle(InferenceAttemptOutcome(status="cancelled", cleanup="uncertain"))

    assert len(sent) == 2
    admit = sent[0]
    assert set(admit) == {"jsonrpc", "api_version", "id", "method", "params"}
    assert admit["jsonrpc"] == "2.0"
    assert admit["api_version"] == "2026-08-17"
    assert admit["method"] == "runtime.operation"
    operation_id = admit["params"]["operation_id"]
    assert operation_id.startswith("inference_")
    assert admit["params"] == {
        "api_version": "2026-08-17",
        "schema_version": 1,
        "kind": "inference",
        "request_id": "request_1",
        "session_id": "session_1",
        "authority_revision": "authority_7",
        "operation_id": operation_id,
        "phase": "admit",
        "engine_type": "ollama",
    }
    assert sent[1]["params"] == {
        "api_version": "2026-08-17",
        "schema_version": 1,
        "kind": "inference",
        "request_id": "request_1",
        "session_id": "session_1",
        "authority_revision": "authority_7",
        "operation_id": operation_id,
        "phase": "settle",
        "status": "cancelled",
        "cleanup": "uncertain",
        "consumption": "unknown",
        "charge_consumption": True,
    }
    assert factory_kwargs == [
        {"cancel_handle": cancel_handle},
        {"cancel_handle": None},
    ]
    assert all(reader.closed for reader in readers)


def test_each_attempt_mints_a_fresh_operation_identity(tmp_path: Path) -> None:
    callback, sent, _factory_kwargs, _readers = _callback(
        tmp_path,
        statuses=["granted", "settled", "granted", "settled"],
    )

    for _index in range(2):
        callback(_attempt()).settle(
            InferenceAttemptOutcome(status="succeeded", cleanup="confirmed")
        )

    operation_ids = [message["params"]["operation_id"] for message in sent]
    assert operation_ids[0] == operation_ids[1]
    assert operation_ids[2] == operation_ids[3]
    assert operation_ids[0] != operation_ids[2]


@pytest.mark.parametrize(
    ("status", "error_type", "reason"),
    [
        ("waiting", InferenceAdmissionDeferred, "capacity_busy"),
        ("rejected", InferenceAdmissionRefused, "route_closed"),
    ],
)
def test_non_granted_admission_is_typed_without_polling(
    tmp_path: Path,
    status: str,
    error_type: type[Exception],
    reason: str,
) -> None:
    sent, _factory_kwargs, _readers, factory = _bridge([status])

    def response_factory(rpc_id: int, **kwargs: Any) -> _Reader:
        reader = factory(rpc_id, **kwargs)
        original = reader.__call__

        class _ReasonReader(_Reader):
            def __call__(self, timeout: float) -> dict[str, Any]:
                response = original(timeout)
                response["result"]["reason"] = reason
                return response

        return _ReasonReader({})

    callback = build_inference_admission_callback(
        request_id="request_1",
        session_id="session_1",
        execution_context=_execution_context(tmp_path.resolve()),
        engine_type="ollama",
        write_message=sent.append,
        response_reader_factory=response_factory,
        cancel_handle=None,
    )
    assert callback is not None

    with pytest.raises(error_type, match=reason):
        callback(_attempt())
    assert len(sent) == 1


def test_route_context_mismatch_refuses_before_transport(tmp_path: Path) -> None:
    callback, sent, _factory_kwargs, _readers = _callback(
        tmp_path,
        statuses=["granted"],
    )

    with pytest.raises(InferenceAdmissionRefused, match="route_context_mismatch"):
        callback(_attempt(provider="untrusted-provider"))
    assert sent == []


def test_child_binding_accepts_child_identity_but_keeps_parent_wire_authority(
    tmp_path: Path,
) -> None:
    callback, sent, _factory_kwargs, _readers = _callback(
        tmp_path,
        statuses=["granted", "settled"],
    )
    bind_request = callback.bind_request  # type: ignore[attr-defined]
    child_callback = bind_request(
        request_id="child-request",
        session_id="session_1",
    )

    lease = child_callback(InferenceAttemptContext(
        request_id="child-request",
        session_id="session_1",
        provider="ollama",
        model="trusted-model",
        request_source="chat_send",
        attempt=1,
        streaming=True,
    ))
    lease.settle(InferenceAttemptOutcome(status="succeeded", cleanup="confirmed"))

    assert [message["params"]["request_id"] for message in sent] == [
        "request_1",
        "request_1",
    ]
    assert sent[0]["params"]["session_id"] == "session_1"


def test_application_authority_is_required_to_build_callback(tmp_path: Path) -> None:
    callback = build_inference_admission_callback(
        request_id="request_1",
        session_id="session_1",
        execution_context=None,
        engine_type="ollama",
        write_message=lambda _message: None,
        response_reader_factory=lambda _rpc_id, **_kwargs: _Reader({}),
        cancel_handle=None,
    )

    assert callback is None


def test_malformed_settlement_response_is_not_silently_accepted(tmp_path: Path) -> None:
    responses = ["granted", "settled"]
    bridge_sent, _factory_kwargs, _readers, bridge_factory = _bridge(responses)
    callback = build_inference_admission_callback(
        request_id="request_1",
        session_id="session_1",
        execution_context=_execution_context(tmp_path.resolve()),
        engine_type="ollama",
        write_message=bridge_sent.append,
        response_reader_factory=bridge_factory,
        cancel_handle=None,
    )
    assert callback is not None
    lease = callback(_attempt())

    responses[1] = "granted"
    with pytest.raises(InferenceAdmissionRefused, match="response_malformed"):
        lease.settle(InferenceAttemptOutcome(status="failed", cleanup="confirmed"))


@pytest.mark.parametrize("ceilings", [(None, None), (0, 1), (1, 0), (True, 1), (1, -1)])
def test_required_budget_refuses_missing_or_invalid_ceilings_before_rpc(tmp_path, ceilings):
    callback, sent, _, _ = _callback(tmp_path, statuses=[], require_budget=True)
    context = replace(_attempt(), input_token_ceiling=ceilings[0], output_token_ceiling=ceilings[1])
    with pytest.raises(InferenceAdmissionRefused, match="ceiling_unavailable"):
        callback(context)
    assert not sent


def test_required_budget_sends_ceilings_and_child_binding_cannot_drop_requirement(tmp_path):
    callback, sent, _, _ = _callback(tmp_path, statuses=["granted", "settled"], require_budget=True)
    child = callback.bind_request(request_id="child_1", session_id="session_1")
    assert child.requires_budget is True
    with pytest.raises(InferenceAdmissionRefused, match="ceiling_unavailable"):
        child(replace(_attempt(), request_id="child_1"))
    lease = child(replace(_attempt(), request_id="child_1", input_token_ceiling=32768,
                          output_token_ceiling=32768))
    assert sent[0]["params"]["maxima"] == {
        "inference_requests": 1, "input_tokens": 32768, "output_tokens": 32768,
    }
    assert sent[0]["params"]["request_id"] == "request_1"
    lease.settle(InferenceAttemptOutcome(status="succeeded", cleanup="confirmed"))
    assert "maxima" not in sent[1]["params"]


def test_required_budget_cannot_use_legacy_absent_execution_authority():
    with pytest.raises(InferenceAdmissionRefused, match="budget_authority_required"):
        build_inference_admission_callback(request_id="request_1", session_id="session_1",
            execution_context=None, engine_type="ollama", write_message=None,
            response_reader_factory=None, cancel_handle=None, require_budget=True)


def test_failed_settlement_exchange_leaves_the_lease_settleable(tmp_path: Path) -> None:
    sent, _factory_kwargs, _readers, factory = _bridge(["granted", "settled", "settled"])
    failures = [True]

    def write_message(message: dict[str, Any]) -> None:
        if message["params"].get("phase") == "settle" and failures:
            failures.pop()
            raise OSError("bridge closed")
        sent.append(message)

    callback = build_inference_admission_callback(
        request_id="request_1",
        session_id="session_1",
        execution_context=_execution_context(tmp_path.resolve()),
        engine_type="ollama",
        write_message=write_message,
        response_reader_factory=factory,
        cancel_handle=None,
    )
    assert callback is not None
    lease = callback(_attempt())
    outcome = InferenceAttemptOutcome(status="failed", cleanup="confirmed")

    with pytest.raises(InferenceAdmissionRefused, match="inference_request_write_failed"):
        lease.settle(outcome)
    # The failed exchange proved nothing, so the retry must reach the authority.
    lease.settle(outcome)
    assert sent[-1]["params"]["phase"] == "settle"
    settled_count = len(sent)
    lease.settle(outcome)
    assert len(sent) == settled_count
