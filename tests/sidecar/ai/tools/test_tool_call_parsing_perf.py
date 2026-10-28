"""Degenerate model output parses in linear time (tool review C4 #G and #H).

Each input below took between half a second and five seconds before the
scanners stopped retrying the rest of the text from every unclosed opener and
the healer stopped scanning every string span per character. The budget is
generous for a slow CI host; the fixed code finishes each in milliseconds.
"""

from __future__ import annotations

import time
from typing import Callable

import pytest

from sidecar.ai.tools.inband_parser import extract_inband_tool_calls_detailed
from sidecar.ai.tools.text_tool_calls import find_text_tool_calls, strip_text_tool_calls
from sidecar.ai.tools.tool_call_healing import (
    _remove_trailing_commas,
    _strip_fences,
    configure_tool_call_healing,
    repair_json_payload,
)

_BUDGET_SECONDS = 0.5
_KNOWN = frozenset({"read_file", "write_file"})


@pytest.fixture(autouse=True)
def _healing_on():
    configure_tool_call_healing({"tool_call_reliability_net_enabled": True})
    yield
    configure_tool_call_healing(None)


def _elapsed(work: Callable[[], object]) -> float:
    started = time.perf_counter()
    work()
    return time.perf_counter() - started


_MANY_MEMBERS = "{" + ",".join('"k%d": "v%d"' % (i, i) for i in range(12000)) + ",}"


@pytest.mark.parametrize(
    "work",
    [
        lambda: find_text_tool_calls("<function=read_file>" + "<parameter=a>x" * 8000, _KNOWN),
        lambda: find_text_tool_calls("<tool_call>{" * 8000 + "</tool_call>", _KNOWN),
        lambda: find_text_tool_calls("<tool_call>{" + " " * 40000, _KNOWN),
        lambda: strip_text_tool_calls("<function=read_file>" * 8000, _KNOWN),
        lambda: find_text_tool_calls("<function=" * 8000, _KNOWN),
        lambda: extract_inband_tool_calls_detailed("<tool_call>{" * 8000, _KNOWN),
        lambda: extract_inband_tool_calls_detailed("read_file({ " * 8000, _KNOWN),
        lambda: extract_inband_tool_calls_detailed("<tool_call>{" + " " * 40000, _KNOWN),
        lambda: extract_inband_tool_calls_detailed("```json\n{" * 8000, _KNOWN),
        lambda: extract_inband_tool_calls_detailed("<tool_call>" * 8000, _KNOWN),
        lambda: _strip_fences(" " * 20000 + "x"),
        lambda: repair_json_payload("<tool_call>{" + " " * 40000),
        lambda: _remove_trailing_commas(_MANY_MEMBERS),
        lambda: repair_json_payload(_MANY_MEMBERS),
    ],
    ids=[
        "qwen-unclosed-parameters",
        "json-envelopes-one-close",
        "json-envelope-whitespace-tail",
        "qwen-repeated-openers",
        "qwen-unterminated-name",
        "inband-xml-openers",
        "inband-func-openers",
        "inband-xml-whitespace-tail",
        "inband-fence-openers",
        "inband-bare-envelope-tags",
        "heal-fence-whitespace",
        "heal-debris-whitespace",
        "heal-trailing-commas",
        "heal-many-members",
    ],
)
def test_degenerate_input_finishes_quickly(work: Callable[[], object]) -> None:
    assert _elapsed(work) < _BUDGET_SECONDS


def test_trailing_comma_pass_is_still_string_aware() -> None:
    assert _remove_trailing_commas('{"a": "x,}", "b": [1,],}') == '{"a": "x,}", "b": [1]}'
