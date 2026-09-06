"""Red-first: operation_status must never report certainty it lacks (W5 review).

Three silence-as-falsehood paths: a current-generation pending left by a failed
settlement was invisible (only other-generation pendings were enumerated); an
unavailable ledger rendered as the definitive "No active operations."; corrupt
receipts were skipped without disclosure. Each must surface as an explicit,
non-authoritative line instead of silence.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.operation_ledger import LEDGER_OPERATIONS_DIR, OperationLedger

NOW = "2026-08-28T12:00:00Z"


@pytest.fixture()
def ledger_root(tmp_path: Path):
    root = tmp_path / "ledger-root"
    builtin_server.configure_operation_ledger(root)
    yield root
    builtin_server.configure_operation_ledger(None)


def _status_text(tmp_path: Path) -> str:
    tools = builtin_server._default_tools()  # noqa: SLF001
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "status-honesty",
        tools,
        WorkspaceGuard(str(tmp_path / "ws")),
        {"name": "operation_status", "arguments": {}},
    )
    assert "result" in response
    return str(response["result"]["content"][0]["text"])


def test_current_generation_pending_is_listed(ledger_root: Path, tmp_path: Path) -> None:
    (tmp_path / "ws").mkdir()
    OperationLedger(ledger_root).create_pending(
        operation_id="idem_b2b2b2b2b2b2b2b2b2b2b2b2",
        request_fingerprint="fp_cur",
        generation_id=builtin_server.SERVER_GENERATION_ID,
        now_iso=NOW,
    )
    text = _status_text(tmp_path)
    assert "idem_b2b2b2b2b2" in text
    assert "No active operations" not in text


def test_unavailable_ledger_never_claims_no_active_operations(tmp_path: Path) -> None:
    (tmp_path / "ws").mkdir()
    blocker = tmp_path / "blocked"
    blocker.write_text("a file where the ledger root must go", encoding="utf-8")
    builtin_server.configure_operation_ledger(blocker / "ledger-root")
    try:
        text = _status_text(tmp_path)
    finally:
        builtin_server.configure_operation_ledger(None)
    assert "No active operations" not in text
    assert "unavailable" in text.lower()


def test_corrupt_receipts_are_disclosed(ledger_root: Path, tmp_path: Path) -> None:
    (tmp_path / "ws").mkdir()
    # Force the ledger root to exist, then poison it with an unreadable receipt.
    OperationLedger(ledger_root)
    operations = ledger_root / LEDGER_OPERATIONS_DIR
    (operations / "idem_c3c3c3c3c3c3c3c3c3c3c3c3.json").write_text(
        "{not json", encoding="utf-8"
    )
    text = _status_text(tmp_path)
    assert "No active operations" not in text
    assert "unreadable" in text.lower() or "corrupt" in text.lower()


def test_other_generation_wording_does_not_claim_interruption() -> None:
    """W8-S3(c): a pending from another generation may belong to an EARLIER
    (interrupted) run OR to another LIVE instance sharing the ledger root.
    The status line must not assert the interpretation it cannot know."""
    from sidecar.runtime.operation_ledger import render_operation_status

    text = render_operation_status(
        [
            {
                "operation_id": "idem_f3f3f3f3f3f3f3f3f3f3f3f3",
                "generation_id": "gen_other",
                "evidence": {"tool": "write_file", "relative_path": "src/y.py"},
            }
        ],
        current_generation_id="gen_live",
        background_job_ids=[],
    )
    assert "interrupted by an earlier process" not in text
    assert "another process" in text
    assert "another live instance" in text
    # The current-process wording is untouched.
    current = render_operation_status(
        [
            {
                "operation_id": "idem_f4f4f4f4f4f4f4f4f4f4f4f4",
                "generation_id": "gen_live",
                "evidence": {"tool": "write_file", "relative_path": "src/z.py"},
            }
        ],
        current_generation_id="gen_live",
        background_job_ids=[],
    )
    assert "current process" in current
