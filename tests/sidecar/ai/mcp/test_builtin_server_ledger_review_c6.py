"""Builtin MCP server ledger review C6: surrogate-safe settles, session-scoped
operation_status, workspace-bound reconcile, cached ledger/store, background
compaction and a bound operation_id on early failures."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_request_scope, builtin_server, builtin_server_ledger
from sidecar.ai.mcp.builtin_server import BuiltinTool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.operation_ledger import (
    LEDGER_OPERATIONS_DIR,
    OperationLedger,
    reconcile_content_addressed_pending,
    workspace_evidence_marker,
)

KEY = "idem_0123456789abcdef01234567"
NOW = "2026-08-28T12:00:00Z"


@pytest.fixture()
def ledger_root(tmp_path: Path):
    root = tmp_path / "ledger-root"
    builtin_server.configure_operation_ledger(root)
    yield root
    builtin_server.configure_operation_ledger(None)


def _tool(handler, *, name: str = "probe_write") -> BuiltinTool:
    return BuiltinTool(
        name=name,
        description="ledger review probe",
        side_effecting=True,
        input_schema={"type": "object", "properties": {}, "additionalProperties": True},
        handler=handler,
    )


def _call(tool: BuiltinTool, workspace_root: Path, arguments: dict) -> dict:
    return builtin_server._handle_tools_call(
        "ledger-review", {tool.name: tool}, WorkspaceGuard(str(workspace_root)),
        {"name": tool.name, "arguments": arguments},
    )


def _receipt(root: Path, operation_id: str = KEY) -> dict:
    path = root / LEDGER_OPERATIONS_DIR / f"{operation_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_lone_surrogate_output_settles_instead_of_killing_the_server(
    ledger_root: Path, tmp_path: Path,
) -> None:
    response = _call(_tool(lambda _a, _w: "done x\ud800"), tmp_path,
                     {"_jenny_idempotency_key": KEY})
    assert "result" in response
    assert _receipt(ledger_root)["status"] == "committed"


def test_early_failure_reports_an_unbound_operation_id_as_none(
    ledger_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(*_args: object, **_kwargs: object) -> object:
        raise ToolExecutionFailure(code="CMP-TOOL-0004", message="bad scope")

    monkeypatch.setattr(builtin_server, "_prepare_call_arguments", refuse)
    response = _call(_tool(lambda _a, _w: "never"), tmp_path, {})
    assert response["error"]["data"]["operation_id"] is None


def _pending(ledger: OperationLedger, operation_id: str, **evidence: str) -> None:
    assert ledger.create_pending(
        operation_id=operation_id, request_fingerprint="fp", generation_id="gen_dead",
        now_iso=NOW, evidence={"tool": "write_file", **evidence},
    )["ok"]


def _status(workspace_root: Path, arguments: dict) -> str:
    result = builtin_server_ledger.operation_status_tool(
        arguments, WorkspaceGuard(str(workspace_root)), generation_id="gen_live"
    )
    return result.output


def test_operation_status_lists_only_the_calling_sessions_receipts(
    ledger_root: Path, tmp_path: Path,
) -> None:
    (tmp_path / "ws").mkdir()
    ledger = OperationLedger(ledger_root)
    _pending(ledger, "idem_aaaaaaaaaaaaaaaaaaaaaaaa", session_id="sess_mine")
    _pending(ledger, "idem_bbbbbbbbbbbbbbbbbbbbbbbb", session_id="sess_other")
    _pending(ledger, "idem_cccccccccccccccccccccccc")  # unattributed legacy receipt
    mine = _status(tmp_path / "ws", {"_jenny_session_id": "sess_mine"})
    assert "idem_aaaa" in mine
    assert "idem_bbbb" not in mine and "idem_cccc" not in mine
    # Without a session the tool keeps listing every pending receipt.
    everything = _status(tmp_path / "ws", {})
    assert all(f"idem_{c * 4}" in everything for c in "abc")


def test_reconcile_never_proves_a_receipt_from_another_workspace(
    ledger_root: Path, tmp_path: Path,
) -> None:
    content = "same bytes\n"
    digest = hashlib.sha256(content.encode()).hexdigest()
    for name in ("ws_a", "ws_b"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "out.txt").write_text(content, encoding="utf-8")
    ledger = OperationLedger(ledger_root)
    _pending(ledger, KEY, relative_path="out.txt", content_sha256=digest,
             workspace_sha256=workspace_evidence_marker(tmp_path / "ws_a"))
    receipt = _receipt(ledger_root)
    assert reconcile_content_addressed_pending(receipt, workspace_root=tmp_path / "ws_b") == (
        "indeterminate"
    )
    assert _status(tmp_path / "ws_b", {}).count(KEY) == 1
    assert _receipt(ledger_root)["status"] == "pending"
    assert reconcile_content_addressed_pending(receipt, workspace_root=tmp_path / "ws_a") == (
        "committed"
    )


def test_write_file_evidence_records_the_workspace_marker(
    ledger_root: Path, tmp_path: Path,
) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    evidence = builtin_server_ledger._pending_evidence(
        "write_file", {"path": "a.txt", "content": "x"}, WorkspaceGuard(str(workspace))
    )
    assert evidence["workspace_sha256"] == workspace_evidence_marker(
        workspace
    )


def test_current_ledger_is_reused_per_root_and_rebuilt_when_the_root_changes(
    ledger_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    built: list[Path] = []
    real = builtin_server_ledger.OperationLedger

    def counting(root: Path) -> OperationLedger:
        built.append(Path(root))
        return real(root)

    monkeypatch.setattr(builtin_server_ledger, "OperationLedger", counting)
    first = builtin_server_ledger.current_operation_ledger()
    assert builtin_server_ledger.current_operation_ledger() is first
    assert len(built) == 1
    builtin_server.configure_operation_ledger(tmp_path / "other-root")
    other = builtin_server_ledger.current_operation_ledger()
    assert other is not first and len(built) == 2


def test_cached_ledger_rebuilds_after_its_directory_is_replaced(
    ledger_root: Path,
) -> None:
    first = builtin_server_ledger.current_operation_ledger()
    assert first is not None
    operations = ledger_root / LEDGER_OPERATIONS_DIR
    operations.rmdir()
    rebuilt = builtin_server_ledger.current_operation_ledger()
    assert rebuilt is not None and rebuilt is not first
    assert operations.is_dir()


def test_compaction_runs_on_a_background_thread(ledger_root: Path) -> None:
    thread = builtin_server_ledger.start_background_compaction()
    assert thread is not None and thread.name == "operation-ledger-compact"
    assert thread.daemon is False
    thread.join(timeout=10)
    assert not thread.is_alive()


def test_compaction_without_a_ledger_starts_nothing() -> None:
    builtin_server.configure_operation_ledger(None)
    assert builtin_server_ledger.start_background_compaction() is None


def test_journal_store_is_reused_per_recovery_and_workspace_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    recovery = str(tmp_path / "recovery" / "v1")
    built: list[str] = []
    store_cls = builtin_request_scope._workspace_mutation_journal_store.WorkspaceMutationJournalStore
    real = store_cls.from_version_root

    def counting(root: str):
        built.append(root)
        return real(root)

    monkeypatch.setattr(store_cls, "from_version_root", staticmethod(counting))
    monkeypatch.setattr(builtin_request_scope, "_JOURNAL_STORES", {})
    a, b = tmp_path / "ws_a", tmp_path / "ws_b"
    assert builtin_request_scope._journal_store(recovery, a) is (
        builtin_request_scope._journal_store(recovery, a)
    )
    assert builtin_request_scope._journal_store(recovery, b) is not (
        builtin_request_scope._journal_store(recovery, a)
    )
    assert len(built) == 2
