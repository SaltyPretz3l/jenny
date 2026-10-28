"""Electron bridge results are bounded untrusted input (review C6-G)."""

from __future__ import annotations

import pytest

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.runtime import electron_tool_bridge as bridge


def _artifact(index: int) -> dict:
    return {
        "artifact_id": f"art_{index}", "title": "T", "file_name": "a.md",
        "display_path": f"artifacts/a{index}.md", "artifact_kind": "document",
    }


def test_generated_artifacts_are_capped_at_the_metadata_item_limit() -> None:
    result = bridge._normalize_result_payload(
        {"success": True, "generated_artifacts": [_artifact(i) for i in range(250)]},
        fallback_tool_name="create_artifact",
    )
    assert len(result.generated_artifacts) == bridge._MAX_METADATA_ITEMS


def test_oversized_output_is_truncated_and_flagged() -> None:
    result = bridge._normalize_result_payload(
        {"success": True, "output": "x" * (bridge._MAX_BRIDGE_OUTPUT_CHARS + 10)},
        fallback_tool_name="session_message",
    )
    assert len(result.output) == bridge._MAX_BRIDGE_OUTPUT_CHARS
    assert result.metadata["output_truncated"] is True


def test_small_output_and_ui_payload_pass_through() -> None:
    result = bridge._normalize_result_payload(
        {"success": True, "output": "ok", "content_type": "mcp_ui", "ui_payload": {"a": 1}},
        fallback_tool_name="session_message",
    )
    assert (result.output, result.ui_payload) == ("ok", {"a": 1})
    assert "output_truncated" not in result.metadata


@pytest.mark.parametrize(
    "ui_payload",
    [
        {"blob": "y" * (bridge._MAX_BRIDGE_UI_PAYLOAD_BYTES + 1)},
        {"not_finite": float("nan")},
        ["not", "a", "dict"],
    ],
)
def test_oversized_or_non_json_ui_payload_is_dropped(ui_payload: object) -> None:
    result = bridge._normalize_result_payload(
        {"success": True, "content_type": "mcp_ui", "ui_payload": ui_payload},
        fallback_tool_name="session_message",
    )
    assert result.ui_payload is None


@pytest.mark.parametrize("code", ["not-a-code", "CMP-tool-0001", "CMP-TOOL-1", 42, None, ""])
def test_bridge_error_with_a_foreign_code_maps_to_execution_failed(code: object) -> None:
    with pytest.raises(MCPError) as caught:
        bridge._raise_bridge_response_error(
            {"error": {"message": "m" * 5000, "data": {"code": code}}}
        )
    assert caught.value.code == CMP_TOOL_EXECUTION_FAILED
    assert len(str(caught.value.message)) == bridge._MAX_BRIDGE_ERROR_MESSAGE_CHARS


def test_bridge_error_keeps_a_well_formed_project_code() -> None:
    with pytest.raises(MCPError) as caught:
        bridge._raise_bridge_response_error(
            {"error": {"message": "denied", "data": {"code": "CMP-TOOL-0002", "retryable": False}}}
        )
    assert caught.value.code == "CMP-TOOL-0002"
    assert caught.value.retryable is False
