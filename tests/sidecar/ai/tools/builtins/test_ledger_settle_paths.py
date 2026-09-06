"""Red-first: per-tool settle stories (W5, spec §3.5).

write_file is content-addressed, so a crash between os.replace and settle is
PROVABLE: reconciliation hashes the file and upgrades pending → committed on
a match. create_artifact picks unique filenames, so a replay would DUPLICATE
— there, and only there, the ledger decides before naming instead of merely
recording. apply_patch already models rollback; its honest `indeterminate`
must finally reach the ledger.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.operation_ledger import (
    LEDGER_OPERATIONS_DIR,
    OperationLedger,
    ledger_status_for_rollback,
    reconcile_content_addressed_pending,
)

WRITE_KEY = "idem_aaaaaaaaaaaaaaaaaaaaaaaa"
ARTIFACT_KEY = "idem_bbbbbbbbbbbbbbbbbbbbbbbb"


@pytest.fixture()
def ledger_root(tmp_path: Path):
    root = tmp_path / "ledger-root"
    builtin_server.configure_operation_ledger(root)
    yield root
    builtin_server.configure_operation_ledger(None)


def _server_call(name: str, arguments: dict, workspace_root: Path) -> dict:
    tools = builtin_server._default_tools()  # noqa: SLF001
    return builtin_server._handle_tools_call(  # noqa: SLF001
        f"{name}-call",
        tools,
        WorkspaceGuard(str(workspace_root)),
        {"name": name, "arguments": arguments},
    )


def _receipt(root: Path, operation_id: str) -> dict:
    return json.loads(
        (root / LEDGER_OPERATIONS_DIR / f"{operation_id}.json").read_text(encoding="utf-8")
    )


class TestWriteFile:
    def test_committed_receipt_carries_content_evidence(self, ledger_root, tmp_path) -> None:
        workspace_root = tmp_path / "workspace"
        workspace_root.mkdir()
        content = "hello ledger\n"
        response = _server_call(
            "write_file",
            {
                "path": "notes/out.txt",
                "content": content,
                "create_dirs": True,
                "_jenny_idempotency_key": WRITE_KEY,
            },
            workspace_root,
        )
        assert "result" in response
        receipt = _receipt(ledger_root, WRITE_KEY)
        assert receipt["status"] == "committed"
        evidence = receipt["evidence"]
        assert evidence["relative_path"] == "notes/out.txt"
        assert evidence["content_sha256"] == hashlib.sha256(content.encode("utf-8")).hexdigest()

    def test_reconcile_proves_committed_by_hashing(self, ledger_root, tmp_path) -> None:
        # Simulate the crash window: pending receipt with content evidence, the
        # file already replaced on disk, process died before settle.
        workspace_root = tmp_path / "workspace"
        (workspace_root / "src").mkdir(parents=True)
        content = "written then crashed\n"
        (workspace_root / "src" / "a.py").write_text(content, encoding="utf-8")

        ledger = OperationLedger(ledger_root)
        ledger.create_pending(
            operation_id=WRITE_KEY,
            request_fingerprint="fp_wf",
            generation_id="gen_dead",
            now_iso="2026-08-28T12:00:00Z",
            evidence={
                "tool": "write_file",
                "relative_path": "src/a.py",
                "content_sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            },
        )
        outcome = reconcile_content_addressed_pending(
            _receipt(ledger_root, WRITE_KEY), workspace_root=workspace_root
        )
        assert outcome == "committed"

    def test_reconcile_mismatch_stays_indeterminate(self, ledger_root, tmp_path) -> None:
        workspace_root = tmp_path / "workspace"
        (workspace_root / "src").mkdir(parents=True)
        (workspace_root / "src" / "a.py").write_text("different bytes", encoding="utf-8")

        ledger = OperationLedger(ledger_root)
        ledger.create_pending(
            operation_id=WRITE_KEY,
            request_fingerprint="fp_wf",
            generation_id="gen_dead",
            now_iso="2026-08-28T12:00:00Z",
            evidence={
                "tool": "write_file",
                "relative_path": "src/a.py",
                "content_sha256": hashlib.sha256(b"intended bytes").hexdigest(),
            },
        )
        outcome = reconcile_content_addressed_pending(
            _receipt(ledger_root, WRITE_KEY), workspace_root=workspace_root
        )
        assert outcome == "indeterminate"


class TestCreateArtifactDecidesBeforeNaming:
    def test_replay_returns_recorded_path_without_a_second_file(
        self, ledger_root, tmp_path
    ) -> None:
        workspace_root = tmp_path / "workspace"
        workspace_root.mkdir()
        arguments = {
            "_jenny_session_id": "session-ledger",
            "_jenny_idempotency_key": ARTIFACT_KEY,
            "artifact_kind": "document",
            "title": "Ledger Plan",
            "content": "# Plan",
            "language": "markdown",
        }
        first = _server_call("create_artifact", dict(arguments), workspace_root)
        assert "result" in first
        artifact_dir = workspace_root / ".jenny" / "artifacts" / "session-ledger"
        first_files = sorted(p.name for p in artifact_dir.iterdir())
        assert len(first_files) == 1

        second = _server_call("create_artifact", dict(arguments), workspace_root)
        assert "result" in second
        second_files = sorted(p.name for p in artifact_dir.iterdir())
        assert second_files == first_files  # no duplicate: the ledger decided pre-naming
        assert second["result"]["metadata"]["effects"] == "committed"


class TestApplyPatchMapping:
    def test_rollback_status_maps_to_honest_ledger_status(self) -> None:
        # RollbackStatus literals from apply_patch_executor.py:39.
        assert ledger_status_for_rollback("not_needed") == "committed"
        assert ledger_status_for_rollback("restored") == "failed"
        assert ledger_status_for_rollback("partial") == "indeterminate"
        assert ledger_status_for_rollback("failed") == "indeterminate"
        # Unknown/unexpected states downgrade certainty, never upgrade it.
        assert ledger_status_for_rollback("???") == "indeterminate"
