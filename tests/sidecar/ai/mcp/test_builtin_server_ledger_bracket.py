"""Red-first: the ledger bracket in _handle_tools_call (W5, spec §3.4).

Doctrine under test: over-reporting `committed` is worse than having no
ledger at all. Every pin proves the bracket cannot claim more certainty than
its receipt evidence, and that a degraded ledger downgrades certainty
(fail-open, `effects: unknown`) instead of blocking work.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.builtin_server import BuiltinTool
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.operation_ledger import LEDGER_OPERATIONS_DIR, OperationLedger

KEY = "idem_0123456789abcdef01234567"


@pytest.fixture()
def ledger_root(tmp_path: Path):
    root = tmp_path / "ledger-root"
    builtin_server.configure_operation_ledger(root)
    yield root
    builtin_server.configure_operation_ledger(None)


def _tool(handler, *, side_effecting: bool = True, name: str = "probe_write") -> BuiltinTool:
    return BuiltinTool(
        name=name,
        description="ledger bracket probe",
        side_effecting=side_effecting,
        input_schema={"type": "object", "properties": {}, "additionalProperties": True},
        handler=handler,
    )


def _call(tool: BuiltinTool, workspace_root: Path, arguments: dict | None = None) -> dict:
    return builtin_server._handle_tools_call(  # noqa: SLF001
        "ledger-call",
        {tool.name: tool},
        WorkspaceGuard(str(workspace_root)),
        {"name": tool.name, "arguments": arguments or {}},
    )


def _receipt(root: Path, operation_id: str = KEY) -> dict:
    path = root / LEDGER_OPERATIONS_DIR / f"{operation_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_pending_receipt_exists_before_the_handler_runs(ledger_root, tmp_path) -> None:
    seen: dict = {}

    def handler(_arguments, _workspace):
        seen["receipt_at_execute"] = _receipt(ledger_root)
        return "done"

    response = _call(_tool(handler), tmp_path, {"_jenny_idempotency_key": KEY})
    assert "result" in response
    assert seen["receipt_at_execute"]["status"] == "pending"
    assert seen["receipt_at_execute"]["generation_id"] == builtin_server.SERVER_GENERATION_ID


def test_success_settles_committed_and_asserts_effects(ledger_root, tmp_path) -> None:
    response = _call(
        _tool(lambda _a, _w: ToolHandlerResult(output="ok", metadata={})),
        tmp_path,
        {"_jenny_idempotency_key": KEY},
    )
    assert _receipt(ledger_root)["status"] == "committed"
    assert response["result"]["metadata"]["effects"] == "committed"


def test_failure_without_effects_assertion_settles_indeterminate(ledger_root, tmp_path) -> None:
    def handler(_arguments, _workspace):
        raise ToolExecutionFailure(code="CMP-TEST-0002", message="boom", retryable=False)

    response = _call(_tool(handler), tmp_path, {"_jenny_idempotency_key": KEY})
    assert _receipt(ledger_root)["status"] == "indeterminate"
    assert response["error"]["data"]["effects"] == "unknown"


def test_failure_asserting_no_effects_settles_failed(ledger_root, tmp_path) -> None:
    def handler(_arguments, _workspace):
        raise ToolExecutionFailure(
            code="CMP-TEST-0002",
            message="rejected before any write",
            retryable=False,
            error_details={"effects": "none"},
        )

    response = _call(_tool(handler), tmp_path, {"_jenny_idempotency_key": KEY})
    assert _receipt(ledger_root)["status"] == "failed"
    assert response["error"]["data"]["effects"] == "none"


def test_join_pending_never_executes(ledger_root, tmp_path) -> None:
    def handler(_arguments, _workspace):
        raise AssertionError("a joined pending operation must not re-execute")

    tool = _tool(handler)
    ledger = OperationLedger(ledger_root)
    ledger.create_pending(
        operation_id=KEY,
        request_fingerprint=builtin_server.ledger_request_fingerprint(
            tool_name=tool.name, arguments={}
        ),
        generation_id=builtin_server.SERVER_GENERATION_ID,
        now_iso="2026-08-28T12:00:00Z",
    )
    response = _call(tool, tmp_path, {"_jenny_idempotency_key": KEY})
    assert "error" in response
    assert response["error"]["data"]["effects"] == "unknown"


def test_recorded_committed_outcome_replays_without_executing(ledger_root, tmp_path) -> None:
    def handler(_arguments, _workspace):
        raise AssertionError("a committed operation must not re-execute")

    tool = _tool(handler)
    ledger = OperationLedger(ledger_root)
    ledger.create_pending(
        operation_id=KEY,
        request_fingerprint=builtin_server.ledger_request_fingerprint(
            tool_name=tool.name, arguments={}
        ),
        generation_id=builtin_server.SERVER_GENERATION_ID,
        now_iso="2026-08-28T12:00:00Z",
    )
    ledger.settle(
        operation_id=KEY,
        status="committed",
        terminal_result_digest="sha256:beef",
        now_iso="2026-08-28T12:00:01Z",
    )
    response = _call(tool, tmp_path, {"_jenny_idempotency_key": KEY})
    assert "result" in response
    metadata = response["result"]["metadata"]
    assert metadata["effects"] == "committed"
    assert metadata["terminal_result_digest"] == "sha256:beef"


def test_fingerprint_mismatch_fails_closed(ledger_root, tmp_path) -> None:
    def handler(_arguments, _workspace):
        raise AssertionError("a fingerprint mismatch must not execute")

    tool = _tool(handler)
    OperationLedger(ledger_root).create_pending(
        operation_id=KEY,
        request_fingerprint="fp_someone_else",
        generation_id="gen_other",
        now_iso="2026-08-28T12:00:00Z",
    )
    response = _call(tool, tmp_path, {"_jenny_idempotency_key": KEY})
    assert "error" in response


def test_read_only_tools_never_touch_the_ledger(ledger_root, tmp_path) -> None:
    response = _call(
        _tool(lambda _a, _w: "fine", side_effecting=False, name="probe_read"),
        tmp_path,
        {"_jenny_idempotency_key": KEY},
    )
    assert "result" in response
    assert not (ledger_root / LEDGER_OPERATIONS_DIR / f"{KEY}.json").exists()


def test_side_effecting_without_key_runs_uncovered_as_unknown(ledger_root, tmp_path) -> None:
    response = _call(_tool(lambda _a, _w: "done"), tmp_path, {})
    assert "result" in response
    assert response["result"]["metadata"].get("effects") in (None, "unknown")
    assert list((ledger_root / LEDGER_OPERATIONS_DIR).glob("*.json")) == []


class TestDegradedLedgerFailOpen:
    def test_degraded_ledger_executes_but_never_claims_certainty(self, tmp_path) -> None:
        blocker = tmp_path / "blocked-root"
        blocker.write_text("file blocks the directory", encoding="utf-8")
        builtin_server.configure_operation_ledger(blocker)
        try:
            executed: list[bool] = []

            def handler(_arguments, _workspace):
                executed.append(True)
                return "done"

            response = _call(_tool(handler), tmp_path, {"_jenny_idempotency_key": KEY})
            assert executed == [True]
            assert "result" in response
            effects = response["result"]["metadata"].get("effects")
            assert effects in (None, "unknown")
            assert effects not in ("none", "committed")
        finally:
            builtin_server.configure_operation_ledger(None)

    def test_degraded_ledger_failure_keeps_handler_asserted_none(self, tmp_path) -> None:
        blocker = tmp_path / "blocked-root2"
        blocker.write_text("file blocks the directory", encoding="utf-8")
        builtin_server.configure_operation_ledger(blocker)
        try:
            def handler(_arguments, _workspace):
                raise ToolExecutionFailure(
                    code="CMP-TEST-0002",
                    message="rejected before any write",
                    retryable=False,
                    error_details={"effects": "none"},
                )

            response = _call(_tool(handler), tmp_path, {"_jenny_idempotency_key": KEY})
            # The handler's own no-effect assertion survives; the ledger being
            # degraded must not upgrade OR erase it.
            assert response["error"]["data"]["effects"] == "none"
        finally:
            builtin_server.configure_operation_ledger(None)
