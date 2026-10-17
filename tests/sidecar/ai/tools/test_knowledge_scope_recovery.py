"""Invalid file scopes retain rejection and describe a working correction."""
from __future__ import annotations

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.builtins.knowledge import knowledge_search_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from tests.sidecar.ai.tools.test_knowledge import (
    _WORKSPACE,
    _payload,
    _reset_knowledge_state,  # noqa: F401 - autouse fixture
)
from tests.sidecar.ai.tools.test_knowledge import (
    corpus as corpus,  # noqa: PLC0414 - pytest fixture re-export
)


@pytest.mark.parametrize("scope", [
    {"root": "project-x/spec.md"},
    {"root": "project-x", "path": "project-x/spec.md"},
])
def test_file_scope_error_explains_path_only_recovery(corpus, scope):
    with pytest.raises(ToolExecutionFailure) as raised:
        knowledge_search_tool({"query": "needle", **scope}, _WORKSPACE)
    assert raised.value.code == CMP_TOOL_INVALID_PATH
    assert "omit root" in raised.value.message
    assert "path" in raised.value.message
    assert raised.value.effects == "none"
    assert "retry once" in raised.value.remediation
    # The suggested correction must still run through the real scoped reader.
    result = _payload(knowledge_search_tool(
        {"query": "needle", "path": "project-x/spec.md"}, _WORKSPACE))
    assert [source["path"] for source in result["sources"]] == ["project-x/spec.md"]
