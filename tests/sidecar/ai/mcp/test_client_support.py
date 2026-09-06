from __future__ import annotations

from sidecar.ai.mcp.client_support import extract_tool_output


def test_extract_tool_output_ignores_nonboolean_success_override() -> None:
    extracted = extract_tool_output(
        {
            "content": [{"type": "text", "text": "failed"}],
            "isError": True,
            "success": "false",
        }
    )

    assert extracted["success"] is False
