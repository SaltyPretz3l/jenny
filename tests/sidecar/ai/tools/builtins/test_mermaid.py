from __future__ import annotations

import json

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_MERMAID_UNSUPPORTED_TYPE,
    CMP_TOOL_MERMAID_VALIDATION,
)
from sidecar.ai.tools.builtins.mermaid import mermaid_generate_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _workspace() -> WorkspaceGuard:
    return WorkspaceGuard(None)


def test_mermaid_generate_returns_deterministic_output_for_same_input() -> None:
    arguments = {
        "prompt": "Map user request to a generated flow.",
        "diagram_type": "flowchart",
        "title": "Request Flow",
        "render_hint": "compact",
    }

    first = mermaid_generate_tool(arguments, _workspace())
    second = mermaid_generate_tool(arguments, _workspace())

    assert first.output == second.output
    assert first.metadata.get("request_hash") == second.metadata.get("request_hash")

    payload = json.loads(first.output)
    assert payload["diagram_type"] == "flowchart"
    assert isinstance(payload["mermaid"], str)
    assert payload["mermaid"].startswith("flowchart")


def test_mermaid_generate_rejects_empty_prompt() -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        mermaid_generate_tool({"prompt": "   "}, _workspace())

    assert excinfo.value.code == CMP_TOOL_MERMAID_VALIDATION
    payload = json.loads(excinfo.value.message)
    assert payload["reason"] == "prompt must not be empty"
    assert payload["field"] == "prompt"


def test_mermaid_generate_rejects_unsupported_diagram_type() -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        mermaid_generate_tool(
            {"prompt": "Generate a diagram.", "diagram_type": "sankey"},
            _workspace(),
        )

    assert excinfo.value.code == CMP_TOOL_MERMAID_UNSUPPORTED_TYPE
    payload = json.loads(excinfo.value.message)
    assert payload["reason"] == "unsupported diagram_type"
    assert payload["diagram_type"] == "sankey"


def test_mermaid_generate_preserves_pasted_graph_source_verbatim() -> None:
    # `graph TD` is the classic Mermaid flowchart header. It must be recognized as
    # Mermaid source and kept verbatim, NOT rebuilt into a 2-node placeholder
    # flowchart (which would discard the user's real diagram).
    source = "graph TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Go]\n  B -->|no| D[Wait]"
    result = mermaid_generate_tool(
        {"prompt": source, "diagram_type": "flowchart"},
        _workspace(),
    )

    payload = json.loads(result.output)
    assert payload["mermaid"].startswith("graph TD")
    assert not payload["mermaid"].startswith("flowchart")
    assert "B -->|yes| C[Go]" in payload["mermaid"]


def test_mermaid_generate_preserves_indented_mindmap_source_verbatim() -> None:
    source = "mindmap\n  root((Plan))\n    Child A\n      Grandchild"

    result = mermaid_generate_tool(
        {"prompt": source, "diagram_type": "mindmap"},
        _workspace(),
    )

    assert json.loads(result.output)["mermaid"] == source


def test_mermaid_generate_emits_renderable_mmd_artifact(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    result = mermaid_generate_tool(
        {
            "_jenny_session_id": "session-mermaid",
            "prompt": "graph TD\n  A[Start] --> B[Done]",
            "diagram_type": "flowchart",
            "title": "Flow",
        },
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.generated_artifacts
    metadata = result.generated_artifacts[0]
    assert metadata["language"] == "mermaid"
    assert metadata["file_name"].endswith(".mmd")
    assert metadata["display_path"].startswith(".jenny/artifacts/session-mermaid/")
    assert metadata["artifact_kind"] == "document"

    target_path = (
        workspace_root / ".jenny" / "artifacts" / "session-mermaid" / metadata["file_name"]
    )
    written = target_path.read_text(encoding="utf-8")
    assert written.startswith("graph TD")
    # The JSON output stays the source of truth and matches the persisted artifact.
    assert json.loads(result.output)["mermaid"] == written


def test_mermaid_generate_read_only_renders_without_writing_artifact(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    result = mermaid_generate_tool(
        {
            "_jenny_session_id": "session-mermaid",
            "_jenny_read_only": True,
            "prompt": "graph TD\n  A[Start] --> B[Done]",
            "diagram_type": "flowchart",
            "title": "Flow",
        },
        WorkspaceGuard(str(workspace_root)),
    )

    payload = json.loads(result.output)
    assert payload["mermaid"].startswith("graph TD")
    assert payload["note"] == "Artifact save skipped in this read-only turn."
    assert result.generated_artifacts == ()
    assert list(workspace_root.rglob("*.mmd")) == []


def test_mermaid_generate_omits_artifact_without_session_or_workspace() -> None:
    # No _jenny_session_id and a root-less workspace -> the best-effort artifact is
    # skipped and the JSON-only output contract is preserved (backward compatible).
    result = mermaid_generate_tool(
        {"prompt": "graph TD\n  A --> B", "diagram_type": "flowchart"},
        _workspace(),
    )

    assert result.generated_artifacts == ()
    assert json.loads(result.output)["mermaid"].startswith("graph TD")
