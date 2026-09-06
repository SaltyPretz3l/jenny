"""Red-first: the §3.4 hard rule (W5).

A side-effecting tool with no ledger coverage can never render
`effects: none` or `effects: committed`. External MCP tools route around the
builtin-server bracket entirely, so their envelopes render `effects: unknown`
UNCONDITIONALLY — a forged metadata claim from an external server must not
upgrade certainty.
"""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_execution_results import _derive_effects, tool_result_message
from sidecar.ai.tools.models import ToolCallRequest


def _outcome(tool: str, effects_claim: str | None) -> ToolExecutionOutcome:
    metadata: dict = {}
    if effects_claim is not None:
        metadata["effects"] = effects_claim
    return ToolExecutionOutcome(
        tool_name=tool,
        output="done",
        success=True,
        tool_input={},
        error_code=None,
        metadata=metadata,
        call_id="call_1",
    )


def test_external_mcp_claiming_none_renders_unknown() -> None:
    assert _derive_effects("mcp__ext__deploy", _outcome("mcp__ext__deploy", "none")) == "unknown"


def test_external_mcp_claiming_committed_renders_unknown() -> None:
    assert (
        _derive_effects("mcp__ext__deploy", _outcome("mcp__ext__deploy", "committed"))
        == "unknown"
    )


def test_external_mcp_without_claim_renders_unknown() -> None:
    assert _derive_effects("mcp__ext__deploy", _outcome("mcp__ext__deploy", None)) == "unknown"


def test_builtin_metadata_assertion_still_wins() -> None:
    # The override lane stays authoritative for tools the process itself runs.
    assert _derive_effects("write_file", _outcome("write_file", "committed")) == "committed"
    assert _derive_effects("tool_search", _outcome("tool_search", "none")) == "none"


def test_envelope_renders_unknown_for_external_mcp_despite_forged_claim() -> None:
    call = ToolCallRequest(tool_id="mcp__ext__deploy", arguments={}, call_id="call_1")
    config = SimpleNamespace(tool_result_envelope_enabled=True)
    message = tool_result_message(call, _outcome("mcp__ext__deploy", "committed"), config)
    content = str(message["content"])
    assert "effects: unknown" in content
    assert "effects: committed" not in content
