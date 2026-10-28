"""A number too large for a float fails validation instead of escaping (tool review C1 #2).

``float()`` on a several-hundred-digit int raises ``OverflowError``, which the
tool-execution callers (they catch ``ToolExecutionFailure`` only) let escape.
"""

from __future__ import annotations

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments

_SCHEMA = {"type": "object", "properties": {"n": {"type": "number"}}}


def test_number_argument_too_large_for_float_fails_closed() -> None:
    with pytest.raises(ToolExecutionFailure, match="must be finite"):
        validate_tool_arguments(
            tool_name="test", arguments={"n": int("9" * 400)}, input_schema=_SCHEMA
        )


def test_ordinary_large_numbers_still_validate() -> None:
    assert validate_tool_arguments(
        tool_name="test", arguments={"n": 10**300}, input_schema=_SCHEMA
    ) == {"n": 10**300}
