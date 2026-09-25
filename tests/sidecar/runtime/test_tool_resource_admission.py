from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_RESOURCE_EXCEEDED, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.routing.tool_resource_deferral import ToolResourceDeferred
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.operation_admission import build_operation_admission_callback
from sidecar.runtime.tool_resource_admission import (
    RuntimeToolResourceRequest,
    acquire_tool_resource,
)


class _Reader:
    def __init__(self, response: Any) -> None:
        self._response = response
        self.closed = False
        self.timeouts: list[float] = []

    def __call__(self, timeout: float) -> dict[str, Any]:
        self.timeouts.append(timeout)
        return self._response() if callable(self._response) else self._response

    def close(self) -> None:
        self.closed = True


def _request(
    sent: list[dict[str, Any]], factory: Any, *, cancel_handle: Any = None,
    arguments: dict[str, Any] | None = None,
    continuation_enabled: Any = False,
) -> RuntimeToolResourceRequest:
    return RuntimeToolResourceRequest(
        request_id="request_1",
        session_id="session_1",
        authority_revision="authority_1",
        operation_id="call_7",
        tool_name="read_file",
        arguments=arguments if arguments is not None else {"path": "a.txt"},
        write_message=sent.append,
        response_reader_factory=factory,
        continuation_enabled=continuation_enabled,
        cancel_handle=cancel_handle,
    )


def test_resource_lease_uses_exact_admit_and_settle_wire() -> None:
    sent: list[dict[str, Any]] = []
    factory_kwargs: list[dict[str, Any]] = []
    readers: list[_Reader] = []
    cancel_handle = SimpleNamespace(cancelled=False)

    def factory(rpc_id: int, **kwargs: Any) -> _Reader:
        factory_kwargs.append(kwargs)

        def response() -> dict[str, Any]:
            params = sent[-1]["params"]
            return {"id": rpc_id, "result": {
                "schema_version": 1,
                "operation_id": params["operation_id"],
                "status": "granted" if params["phase"] == "admit" else "settled",
            }}

        reader = _Reader(response)
        readers.append(reader)
        return reader

    lease = acquire_tool_resource(_request(
        sent, factory, cancel_handle=cancel_handle,
    ))
    cancel_handle.cancelled = True
    lease.settle("succeeded", "confirmed")
    lease.settle("succeeded", "confirmed")

    assert len(sent) == 2
    assert set(sent[0]) == {"jsonrpc", "api_version", "id", "method", "params"}
    assert sent[0]["jsonrpc"] == "2.0"
    assert sent[0]["api_version"] == "2026-08-17"
    assert sent[0]["method"] == "runtime.operation"
    assert sent[0]["params"] == {
        "api_version": "2026-08-17",
        "schema_version": 1,
        "kind": "tool",
        "request_id": "request_1",
        "session_id": "session_1",
        "authority_revision": "authority_1",
        "operation_id": "call_7",
        "phase": "admit",
        "tool_name": "read_file",
        "arguments": {"path": "a.txt"},
    }
    assert sent[1]["params"] == {
        "api_version": "2026-08-17",
        "schema_version": 1,
        "kind": "tool",
        "request_id": "request_1",
        "session_id": "session_1",
        "authority_revision": "authority_1",
        "operation_id": "call_7",
        "phase": "settle",
        "status": "succeeded",
        "cleanup": "confirmed",
    }
    assert factory_kwargs == [{"cancel_handle": cancel_handle}, {"cancel_handle": None}]
    assert all(reader.closed for reader in readers)
    assert readers[1].timeouts and readers[1].timeouts[0] <= 5.0


@pytest.mark.parametrize(
    ("status", "error_code"),
    [
        ("waiting", CMP_RESOURCE_EXCEEDED),
        ("rejected", CMP_TOOL_EXECUTION_FAILED),
    ],
)
def test_waiting_and_rejected_resource_admission_return_no_lease(
    status: str, error_code: str,
) -> None:
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        return _Reader(lambda: {"id": rpc_id, "result": {
            "schema_version": 1,
            "operation_id": "call_7",
            "status": status,
            "reason": f"capacity_{status}",
        }})

    with pytest.raises(ToolExecutionFailure, match=f"capacity_{status}") as caught:
        acquire_tool_resource(_request(sent, factory))
    assert caught.value.code == error_code
    assert len(sent) == 1


def test_opted_wait_raises_typed_deferral_without_wire_self_enable() -> None:
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        return _Reader({"id": rpc_id, "result": {
            "schema_version": 1,
            "operation_id": "call_7",
            "status": "waiting",
            "reason": "native_capacity",
            "resource_class": "native_processes",
            "dependency_id": None,
        }})

    with pytest.raises(ToolResourceDeferred) as caught:
        acquire_tool_resource(_request(sent, factory, continuation_enabled=True))

    assert caught.value.prepared is None
    assert caught.value.wait.operation_id == "call_7"
    assert caught.value.wait.resource_class == "native_processes"
    assert caught.value.wait.dependency_id is None
    assert caught.value.wait.reason == "native_capacity"
    assert "continuation_enabled" not in sent[0]["params"]


def test_opted_legacy_wait_without_metadata_remains_retryable_failure() -> None:
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        return _Reader({"id": rpc_id, "result": {
            "schema_version": 1,
            "operation_id": "call_7",
            "status": "waiting",
            "reason": "legacy_capacity",
        }})

    with pytest.raises(ToolExecutionFailure, match="legacy_capacity") as caught:
        acquire_tool_resource(_request(sent, factory, continuation_enabled=True))
    assert caught.value.code == CMP_RESOURCE_EXCEEDED
    assert caught.value.retryable is True


@pytest.mark.parametrize("result", [
    {"schema_version": True, "operation_id": "call_7", "status": "granted"},
    {"schema_version": 1, "operation_id": "wrong", "status": "granted"},
    {
        "schema_version": 1,
        "operation_id": "call_7",
        "status": "granted",
        "authority_revision": "forged",
    },
    {"schema_version": 1, "operation_id": "call_7", "status": "settled"},
    {
        "schema_version": 1,
        "operation_id": "call_7",
        "status": "waiting",
        "reason": "x" * 201,
    },
])
def test_resource_admission_rejects_malformed_or_cross_identity_result(
    result: dict[str, Any],
) -> None:
    with pytest.raises(ToolExecutionFailure, match="response_malformed"):
        acquire_tool_resource(_request(
            [], lambda rpc_id, **_kwargs: _Reader({"id": rpc_id, "result": result}),
        ))


@pytest.mark.parametrize(
    ("continuation_enabled", "result"),
    [
        (False, {
            "schema_version": 1, "operation_id": "call_7", "status": "waiting",
            "resource_class": "filesystem", "dependency_id": None,
        }),
        (True, {
            "schema_version": 1, "operation_id": "call_7", "status": "waiting",
            "resource_class": "filesystem",
        }),
        (True, {
            "schema_version": 1, "operation_id": "call_7", "status": "waiting",
            "resource_class": "gpu", "dependency_id": None,
        }),
        (True, {
            "schema_version": 1, "operation_id": "call_7", "status": "waiting",
            "resource_class": "filesystem", "dependency_id": "future_dependency",
        }),
        (True, {
            "schema_version": 1, "operation_id": "call_7", "status": "granted",
            "resource_class": "filesystem", "dependency_id": None,
        }),
        (True, {
            "schema_version": 1, "operation_id": "call_7", "status": "rejected",
            "resource_class": "filesystem", "dependency_id": None,
        }),
    ],
)
def test_wait_metadata_is_exact_opted_and_waiting_only(
    continuation_enabled: bool,
    result: dict[str, Any],
) -> None:
    with pytest.raises(ToolExecutionFailure, match="response_malformed"):
        acquire_tool_resource(_request(
            [],
            lambda rpc_id, **_kwargs: _Reader({"id": rpc_id, "result": result}),
            continuation_enabled=continuation_enabled,
        ))


def test_continuation_enablement_is_a_strict_internal_boolean() -> None:
    with pytest.raises(ToolExecutionFailure, match="continuation_enabled_invalid"):
        acquire_tool_resource(_request([], lambda _rpc_id, **_kwargs: _Reader({}),
                                                continuation_enabled=1))

    with pytest.raises(TypeError, match="must be a bool"):
        build_operation_admission_callback(
            request_id="request_1",
            session_id="session_1",
            execution_context=None,
            write_message=None,
            response_reader_factory=None,
            cancel_handle=None,
            continuation_enabled=1,  # type: ignore[arg-type]
        )


def test_callback_builder_propagates_trusted_continuation_enablement() -> None:
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        return _Reader({"id": rpc_id, "result": {
            "schema_version": 1,
            "operation_id": "call_7",
            "status": "waiting",
            "resource_class": "tool_operations",
            "dependency_id": None,
        }})

    callback = build_operation_admission_callback(
        request_id="request_1",
        session_id="session_1",
        execution_context=SimpleNamespace(authority_revision="authority_1"),  # type: ignore[arg-type]
        write_message=sent.append,
        response_reader_factory=factory,
        cancel_handle=None,
        continuation_enabled=True,
    )
    assert callback is not None
    with pytest.raises(ToolResourceDeferred):
        callback.acquire_resource(  # type: ignore[attr-defined]
            operation_id="call_7", tool_name="read_file", arguments={"path": "a.txt"}
        )
    assert "continuation_enabled" not in sent[0]["params"]


def test_resource_request_size_is_bounded_before_transport() -> None:
    sent: list[dict[str, Any]] = []
    factory_called = False

    def factory(_rpc_id: int, **_kwargs: Any) -> _Reader:
        nonlocal factory_called
        factory_called = True
        return _Reader({})

    with pytest.raises(ToolExecutionFailure, match="request_too_large"):
        acquire_tool_resource(_request(
            sent, factory, arguments={"path": "x" * (1024 * 1024)},
        ))
    assert sent == []
    assert factory_called is False


def test_resource_identity_grammar_is_rejected_before_transport() -> None:
    sent: list[dict[str, Any]] = []
    request = _request(sent, lambda _rpc_id, **_kwargs: _Reader({}))
    malformed = RuntimeToolResourceRequest(
        request_id=request.request_id,
        session_id=request.session_id,
        authority_revision=request.authority_revision,
        operation_id="call 7",
        tool_name=request.tool_name,
        arguments=request.arguments,
        write_message=request.write_message,
        response_reader_factory=request.response_reader_factory,
    )
    with pytest.raises(ToolExecutionFailure, match="operation_id_invalid"):
        acquire_tool_resource(malformed)
    assert sent == []


def test_resource_timeout_must_be_finite_before_write() -> None:
    sent: list[dict[str, Any]] = []
    request = _request(sent, lambda _rpc_id, **_kwargs: _Reader({}))
    invalid = RuntimeToolResourceRequest(
        request_id=request.request_id,
        session_id=request.session_id,
        authority_revision=request.authority_revision,
        operation_id=request.operation_id,
        tool_name=request.tool_name,
        arguments=request.arguments,
        write_message=request.write_message,
        response_reader_factory=request.response_reader_factory,
        timeout_seconds=float("nan"),
    )
    with pytest.raises(ToolExecutionFailure, match="timeout_invalid"):
        acquire_tool_resource(invalid)
    assert sent == []


def test_resource_settlement_rejects_invalid_outcome_before_transport() -> None:
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        return _Reader(lambda: {"id": rpc_id, "result": {
            "schema_version": 1, "operation_id": "call_7", "status": "granted",
        }})

    lease = acquire_tool_resource(_request(sent, factory))
    with pytest.raises(ToolExecutionFailure, match="settlement_invalid"):
        lease.settle("unknown", "confirmed")
    assert len(sent) == 1


@pytest.mark.parametrize(
    "settled_result",
    [
        {
            "schema_version": 1,
            "operation_id": "call_7",
            "status": "settled",
            "resource_class": "filesystem",
            "dependency_id": None,
        },
        {"schema_version": True, "operation_id": "call_7", "status": "settled"},
    ],
)
def test_settled_response_rejects_wait_metadata_and_boolean_schema(
    settled_result: dict[str, Any],
) -> None:
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        def response() -> dict[str, Any]:
            if sent[-1]["params"]["phase"] == "settle":
                return {"id": rpc_id, "result": settled_result}
            return {"id": rpc_id, "result": {
                "schema_version": 1, "operation_id": "call_7", "status": "granted",
            }}

        return _Reader(response)

    lease = acquire_tool_resource(_request(sent, factory, continuation_enabled=True))
    with pytest.raises(ToolExecutionFailure, match="response_malformed"):
        lease.settle("succeeded", "confirmed")


def test_resource_settlement_can_retry_after_lost_ack() -> None:
    sent: list[dict[str, Any]] = []
    settle_reads = 0

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        def response() -> dict[str, Any]:
            nonlocal settle_reads
            params = sent[-1]["params"]
            if params["phase"] == "settle":
                settle_reads += 1
                if settle_reads == 1:
                    raise TimeoutError("ack lost")
            return {"id": rpc_id, "result": {
                "schema_version": 1,
                "operation_id": params["operation_id"],
                "status": "granted" if params["phase"] == "admit" else "settled",
            }}

        return _Reader(response)

    lease = acquire_tool_resource(_request(sent, factory))
    with pytest.raises(ToolExecutionFailure, match="authority_incomplete"):
        lease.settle("failed", "uncertain")
    lease.settle("failed", "uncertain")
    assert [message["params"]["phase"] for message in sent] == [
        "admit", "settle", "settle",
    ]


def test_resource_settlement_allows_only_monotonic_cleanup_confirmation() -> None:
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        return _Reader(lambda: {"id": rpc_id, "result": {
            "schema_version": 1,
            "operation_id": "call_7",
            "status": "granted" if sent[-1]["params"]["phase"] == "admit" else "settled",
        }})

    lease = acquire_tool_resource(_request(sent, factory))
    lease.settle("cancelled", "uncertain")
    lease.settle("cancelled", "uncertain")
    lease.settle("cancelled", "confirmed")
    with pytest.raises(ToolExecutionFailure, match="settlement_conflict"):
        lease.settle("cancelled", "uncertain")
    assert [message["params"].get("cleanup") for message in sent] == [
        None, "uncertain", "confirmed",
    ]
