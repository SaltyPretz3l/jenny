"""Read-only workspace manifest tool."""

from __future__ import annotations

import json

from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_manifest import get_workspace_manifest_cache


def workspace_manifest_read_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    del arguments

    manifest = get_workspace_manifest_cache().read(workspace.require_root())
    raw_totals = manifest.get("totals")
    totals: dict[str, object] = raw_totals if isinstance(raw_totals, dict) else {}
    return ToolHandlerResult(
        output=json.dumps(manifest, ensure_ascii=False, indent=2),
        metadata={
            "generated_at": manifest.get("generated_at"),
            "truncated": bool(totals.get("truncated", False)),
            "has_error": bool(manifest.get("error")),
        },
    )
