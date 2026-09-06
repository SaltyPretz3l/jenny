import pytest

from sidecar.ai.error_codes import CMP_TOOL_SUBAGENT_INVALID_PROMPT
from sidecar.ai.routing.subagent_run import validate_subagent_run_arguments
from sidecar.ai.tools.contracts import ToolExecutionFailure


def test_subagent_run_rejects_isolated_surrogate_as_validation_failure() -> None:
    with pytest.raises(ToolExecutionFailure) as exc_info:
        validate_subagent_run_arguments({"prompt": "inspect \ud800"})

    assert exc_info.value.code == CMP_TOOL_SUBAGENT_INVALID_PROMPT
    assert exc_info.value.retryable is False
    assert "valid UTF-8" in exc_info.value.message
