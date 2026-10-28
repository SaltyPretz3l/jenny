from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.mcp.client_support import descriptor_from_payload, extract_tool_output


def test_extract_tool_output_ignores_nonboolean_success_override() -> None:
    extracted = extract_tool_output(
        {
            "content": [{"type": "text", "text": "failed"}],
            "isError": True,
            "success": "false",
        }
    )

    assert extracted["success"] is False


_READ_ONLY = {"readOnlyHint": True}


@pytest.mark.parametrize(("payload", "auto_allow", "side_effecting"), [
    ({"annotations": _READ_ONLY}, False, True),
    ({"annotations": _READ_ONLY}, True, False),
    ({"annotations": {**_READ_ONLY, "openWorldHint": False, "destructiveHint": False}}, True, False),
    ({"annotations": {**_READ_ONLY, "destructiveHint": True}}, True, True),
    ({"annotations": {**_READ_ONLY, "openWorldHint": True}}, True, True),
    ({"annotations": {"readOnlyHint": "true"}}, True, True),
    ({"annotations": ["readOnlyHint"]}, True, True),
    ({}, True, True),
    # A declared write action keeps the scalar side-effecting whatever the claim.
    ({"annotations": _READ_ONLY, "actions": {"write": {"side_effecting": True}}}, True, True),
])
def test_read_only_auto_allow_maps_only_a_qualifying_claim(
    payload: dict[str, Any], auto_allow: bool, side_effecting: bool,
) -> None:
    descriptor = descriptor_from_payload(
        "rea", {"name": "list_unknowns", **payload}, read_only_auto_allow=auto_allow,
    )
    assert descriptor is not None
    assert descriptor.side_effecting is side_effecting


def test_read_only_auto_allow_honours_the_claim_on_an_approved_digest_row() -> None:
    from sidecar.ai.mcp.tool_surface import summarize_tools

    rows = summarize_tools([{"name": "list_unknowns", "annotations": _READ_ONLY}, {"name": "open_binary"}])
    descriptors = {
        row["name"]: descriptor_from_payload("rea", row, read_only_auto_allow=True) for row in rows
    }
    assert descriptors["list_unknowns"] is not None and descriptors["list_unknowns"].side_effecting is False
    assert descriptors["open_binary"] is not None and descriptors["open_binary"].side_effecting is True
