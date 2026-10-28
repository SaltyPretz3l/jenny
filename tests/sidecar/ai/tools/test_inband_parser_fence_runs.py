"""The result-lead scan after a call stays linear on fence runs (tool review C4 #1).

The regex it replaced backtracked exponentially: eighteen bare fences after a
valid call took 20 s+ on the sidecar thread.
"""

from __future__ import annotations

import time

import pytest

from sidecar.ai.tools.inband_parser import _result_lead_end, extract_inband_tool_calls_detailed
from sidecar.ai.tools.tool_call_healing import configure_tool_call_healing

KNOWN = frozenset({"read_file"})


@pytest.fixture(autouse=True)
def _reset_healing():
    configure_tool_call_healing(None)
    yield
    configure_tool_call_healing(None)


def test_fence_runs_after_a_call_do_not_backtrack() -> None:
    text = '```json\n{"name": "read_file", "arguments": {}}\n```' + "```" * 40 + "x"
    started = time.perf_counter()

    result = extract_inband_tool_calls_detailed(text, KNOWN)

    assert time.perf_counter() - started < 2.0
    assert [call.tool_id for call in result.calls] == ["read_file"]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("  \n```\n  {", 9),
        ("```json {", 8),
        ("~~~\n~~~\n{", 8),
        ("{", 0),
        ("```json\nprose {", None),
        ("   x", None),
        ("```", None),
        ("", None),
    ],
)
def test_result_lead_end_matches_whitespace_and_fence_lines_only(
    text: str, expected: int | None
) -> None:
    assert _result_lead_end(text, 0) == expected
