"""Read-only workspace manifest tool."""

from __future__ import annotations

import json

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
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
    # The cache fails soft with an error payload; that is a failed call, not a manifest.
    has_error = bool(manifest.get("error"))
    return ToolHandlerResult(
        output=json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        success=not has_error,
        error_code=CMP_TOOL_IO_FAILED if has_error else None,
        metadata={
            "generated_at": manifest.get("generated_at"),
            "truncated": bool(totals.get("truncated", False)),
            "has_error": has_error,
        },
    )
