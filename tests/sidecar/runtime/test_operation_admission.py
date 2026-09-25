from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.mcp.exceptions import MCPError
from sidecar.runtime.execution_context import execution_context_from_params
from sidecar.runtime.operation_admission import (
    RuntimeOperationRequest,
    admit_runtime_operation,
    build_operation_admission_callback,
)


def _context(root: Path):
    return execution_context_from_params({"execution_context": {
        "schema_version": 1, "authority_revision": "rev_1",
        "project_id": "project_alpha", "root_path": str(root),
        "root_id": "root_1234567890abcdef12345678", "root_revision": 1,
        "device_id": None, "inode": None,
        "tool_policy_snapshot": {"version": 1}, "knowledge_roots": [],
    }})


class _Reader:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.closed = False

    def __call__(self, _timeout: float) -> dict[str, Any]:
        return self.response

    def close(self) -> None:
        self.closed = True


def test_runtime_operation_uses_tool_call_identity_and_visible_arguments(tmp_path: Path) -> None:
    context = _context(tmp_path.resolve())
    assert context is not None
    sent: list[dict[str, Any]] = []
    reader: _Reader | None = None

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        nonlocal reader
        reader = _Reader({"id": rpc_id, "result": {
            "schema_version": 1, "status": "granted", "operation_id": "call_7",
        }})
        return reader

    admit_runtime_operation(RuntimeOperationRequest(
        request_id="request_1", session_id="session_1", execution_context=context,
        operation_id="call_7", tool_name="read_file", arguments={"path": "a.txt"},
        write_message=sent.append, response_reader_factory=factory,
    ))
    params = sent[0]["params"]
    assert params["operation_id"] == "call_7"
    assert params["api_version"] == "2026-08-17"
    assert params["arguments"] == {"path": "a.txt"}
    assert "root_path" not in params
    assert reader is not None and reader.closed


@pytest.mark.parametrize("result", [
    {"schema_version": 1, "status": "granted", "operation_id": "wrong"},
    {"schema_version": 1, "status": "waiting", "operation_id": "call_7"},
    {
        "schema_version": 1,
        "status": "granted",
        "operation_id": "call_7",
        "authority_revision": "forged",
    },
])
def test_runtime_operation_rejects_malformed_or_stale_result(
    tmp_path: Path, result: dict[str, Any]
) -> None:
    context = _context(tmp_path.resolve())
    assert context is not None
    with pytest.raises(MCPError, match="malformed"):
        admit_runtime_operation(RuntimeOperationRequest(
            request_id="request_1", session_id="session_1", execution_context=context,
            operation_id="call_7", tool_name="read_file", arguments={"path": "a.txt"},
            write_message=lambda _message: None,
            response_reader_factory=lambda rpc_id, **_kwargs: _Reader({"id": rpc_id, "result": result}),
        ))


def test_runtime_operation_surfaces_closed_rejection(tmp_path: Path) -> None:
    context = _context(tmp_path.resolve())
    assert context is not None
    with pytest.raises(MCPError, match="stale authority"):
        admit_runtime_operation(RuntimeOperationRequest(
            request_id="request_1", session_id="session_1", execution_context=context,
            operation_id="call_7", tool_name="read_file", arguments={"path": "a.txt"},
            write_message=lambda _message: None,
            response_reader_factory=lambda rpc_id, **_kwargs: _Reader({"id": rpc_id, "result": {
                "schema_version": 1, "status": "rejected", "operation_id": "call_7",
                "error": {"code": "CMP-PROJECT-0004", "message": "stale authority"},
            }}),
        ))


def test_operation_callback_preserves_check_and_exposes_internal_resource_acquire(
    tmp_path: Path,
) -> None:
    context = _context(tmp_path.resolve())
    assert context is not None
    sent: list[dict[str, Any]] = []

    def factory(rpc_id: int, **_kwargs: Any) -> _Reader:
        class _DynamicReader(_Reader):
            def __call__(self, _timeout: float) -> dict[str, Any]:
                params = sent[-1]["params"]
                return {"id": rpc_id, "result": {
                    "schema_version": 1,
                    "status": "granted",
                    "operation_id": params["operation_id"],
                }}

        return _DynamicReader({})

    callback = build_operation_admission_callback(
        request_id="request_1",
        session_id="session_1",
        execution_context=context,
        write_message=sent.append,
        response_reader_factory=factory,
        cancel_handle=None,
    )
    assert callback is not None
    envelope = callback(
        operation_id="call_7",
        tool_name="read_file",
        arguments={"path": "a.txt"},
    )
    lease = callback.acquire_resource(  # type: ignore[attr-defined]
        operation_id="call_7",
        tool_name="read_file",
        arguments={"path": "a.txt"},
    )

    assert envelope == context.to_wire()
    assert "kind" not in sent[0]["params"]
    assert sent[0]["params"]["phase"] == "check"
    assert sent[1]["params"]["kind"] == "tool"
    assert sent[1]["params"]["phase"] == "admit"
    assert lease is not None
