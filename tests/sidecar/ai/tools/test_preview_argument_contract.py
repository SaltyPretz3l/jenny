from __future__ import annotations

import pytest

from sidecar.ai.tools.catalog import manifest_descriptors
from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments


def schema():
    return next(item.input_schema for item in manifest_descriptors() if item.name == "preview_test")


@pytest.mark.parametrize("extra", [
    {"interactions": [{"type": "click", "target": "#start"}]},
    {"viewprot": "mobile"},
    {"events": [{"action": "type", "selector": "#name", "value": "lost"}]},
])
def test_preview_rejects_unknown_argument_fields(extra):
    with pytest.raises(ToolExecutionFailure):
        validate_tool_arguments(tool_name="preview_test", arguments={"path": "index.html", **extra}, input_schema=schema())


def test_preview_preserves_every_supported_parameter():
    arguments = {
        "path": "index.html", "viewport": "mobile", "wait_ms": 0, "screenshot": True,
        "events": [{"action": "type", "selector": "#name", "text": "night", "press_enter": False},
                   {"action": "click", "selector": "#start"}],
    }
    assert validate_tool_arguments(tool_name="preview_test", arguments=arguments, input_schema=schema()) == arguments
