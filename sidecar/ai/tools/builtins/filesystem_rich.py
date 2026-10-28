"""Rich-file suffix dispatch for read_file (W7a-S3 inspect fold).

read_file delegates rich suffixes to the surviving inspect adapter handlers
with a whitelisted argument dict — never create_preview or injected keys.
Adapter imports stay lazy: the modules carry optional third-party
dependencies, and tests monkeypatch the handler symbols on their modules.
"""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

RICH_FILE_SUFFIXES = {
    ".docx": "document",
    ".xlsx": "spreadsheet",
    ".xlsm": "spreadsheet",
    ".pptx": "presentation",
    ".ipynb": "notebook",
    ".pdf": "pdf",
}
_PAGING_HINTS = {
    "pdf": "page a PDF with 'pages' (at most 3 per call) or the 'cursor' a previous read returned",
    "document": (
        "continue a Word document with the 'cursor' (continue_cursor) a previous read returned"
    ),
}


def rich_paging_hint(suffix: str) -> str:
    """How to read further into a file, for argument errors the model sees."""
    kind = RICH_FILE_SUFFIXES.get(suffix.lower())
    if kind is None:
        return "read line windows with 'offset' and 'limit'"
    return _PAGING_HINTS.get(kind, "this file type returns one bounded inspection per read")


def read_rich_file(
    *,
    kind: str,
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    if "offset" in arguments or "limit" in arguments:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool arguments 'offset' and 'limit' are unsupported for this file type; "
            + rich_paging_hint(Path(str(arguments["path"])).suffix),
            retryable=False,
        )
    delegated_arguments = {"path": arguments["path"]}
    if kind == "pdf":
        from sidecar.ai.tools.builtins.rich_files.pdf import (
            pdf_inspect_tool,
        )

        if "pages" in arguments:
            delegated_arguments["pages"] = arguments["pages"]
        if "cursor" in arguments:
            delegated_arguments["cursor"] = arguments["cursor"]
        return pdf_inspect_tool(delegated_arguments, workspace)
    if kind == "document":
        from sidecar.ai.tools.builtins.rich_files.document import (
            document_inspect_tool,
        )

        if "cursor" in arguments:
            delegated_arguments["cursor"] = arguments["cursor"]
        return document_inspect_tool(delegated_arguments, workspace)
    if kind == "spreadsheet":
        from sidecar.ai.tools.builtins.rich_files.spreadsheet import (
            spreadsheet_inspect_tool,
        )

        return spreadsheet_inspect_tool(delegated_arguments, workspace)
    if kind == "presentation":
        from sidecar.ai.tools.builtins.rich_files.presentation import (
            presentation_inspect_tool,
        )

        return presentation_inspect_tool(delegated_arguments, workspace)
    from sidecar.ai.tools.builtins.rich_files.notebook import (
        notebook_inspect_tool,
    )

    return notebook_inspect_tool(delegated_arguments, workspace)
