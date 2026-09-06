"""Red-first: effects honesty must survive the persistence seam (W5 review).

`_derive_effects` protects the LIVE envelope, but `annotate_derived_envelope_fields`
is the copy Electron persists and the next turn's history re-frame reads. A forged
external claim that survives into that copy resurfaces as history — so the seam,
not just the renderer, must enforce the §3.4 hard rule. Same doctrine for the
bracket: once the ledger has settled a receipt, the response metadata must match
the receipt, never a handler's contradictory assertion.
"""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_execution_results import annotate_derived_envelope_fields
from sidecar.runtime.operation_ledger import OperationLedger, OperationLedgerCall

NOW = "2026-08-28T12:00:00Z"


def _outcome(tool: str, metadata: dict) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name=tool,
        output="done",
        success=True,
        tool_input={},
        error_code=None,
        metadata=metadata,
        call_id="call_1",
    )


class TestAnnotateSeamHardRule:
    def test_forged_external_committed_is_overwritten_at_the_seam(self) -> None:
        outcome = _outcome("mcp__ext__deploy", {"effects": "committed"})
        annotate_derived_envelope_fields(outcome)
        assert outcome.metadata["effects"] == "unknown"

    def test_forged_external_none_is_overwritten_at_the_seam(self) -> None:
        outcome = _outcome("mcp__ext__deploy", {"effects": "none"})
        annotate_derived_envelope_fields(outcome)
        assert outcome.metadata["effects"] == "unknown"

    def test_builtin_assertion_stays_authoritative_at_the_seam(self) -> None:
        outcome = _outcome("write_file", {"effects": "committed"})
        annotate_derived_envelope_fields(outcome)
        assert outcome.metadata["effects"] == "committed"


class TestSettledReceiptWinsOverMetadata:
    def _bracket(self, tmp_path: Path) -> tuple[OperationLedger, OperationLedgerCall]:
        ledger = OperationLedger(tmp_path / "ledger-root")
        key = "idem_eeeeeeeeeeeeeeeeeeeeeeee"
        created = ledger.create_pending(
            operation_id=key,
            request_fingerprint="fp_seam",
            generation_id="gen_live",
            now_iso=NOW,
        )
        assert created["ok"]
        return ledger, OperationLedgerCall(ledger, key, {"tool": "write_file"}, key)

    def test_failed_handler_cannot_keep_a_committed_claim(self, tmp_path: Path) -> None:
        _, bracket = self._bracket(tmp_path)
        metadata: dict[str, object] = {"effects": "committed"}
        bracket.settle_result(
            tool_name="write_file",
            success=False,
            output_text="io exploded mid-write",
            metadata=metadata,
            generated_artifacts=(),
        )
        # The receipt settled indeterminate; the response must say so.
        assert metadata["effects"] == "unknown"

    def test_successful_settle_overwrites_a_stray_none_claim(self, tmp_path: Path) -> None:
        _, bracket = self._bracket(tmp_path)
        metadata: dict[str, object] = {"effects": "none"}
        bracket.settle_result(
            tool_name="write_file",
            success=True,
            output_text="written",
            metadata=metadata,
            generated_artifacts=(),
        )
        assert metadata["effects"] == "committed"
