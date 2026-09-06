"""Rich-file suffix dispatch for read_file (W7a-S3 inspect fold).

read_file delegates rich suffixes to the surviving inspect adapter handlers
with a whitelisted argument dict — never create_preview or injected keys.
Adapter imports stay lazy: the modules carry optional third-party
dependencies, and tests monkeypatch the handler symbols on their modules.
"""

from __future__ import annotations

from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

RICH_FILE_SUFFIXES = {
    ".docx": "document",
    ".xlsx": "spreadsheet",
    ".xlsm": "spreadsheet",
    ".pptx": "presentation",
    ".ipynb": "notebook",
    ".pdf": "pdf",
}


def read_rich_file(
    *,
    kind: str,
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    delegated_arguments = {"path": arguments["path"]}
    if kind == "pdf":
        from sidecar.ai.tools.builtins.rich_files.pdf import (  # noqa: PLC0415
            pdf_inspect_tool,
        )

        if "pages" in arguments:
            delegated_arguments["pages"] = arguments["pages"]
        return pdf_inspect_tool(delegated_arguments, workspace)
    if kind == "document":
        from sidecar.ai.tools.builtins.rich_files.document import (  # noqa: PLC0415
            document_inspect_tool,
        )

        return document_inspect_tool(delegated_arguments, workspace)
    if kind == "spreadsheet":
        from sidecar.ai.tools.builtins.rich_files.spreadsheet import (  # noqa: PLC0415
            spreadsheet_inspect_tool,
        )

        return spreadsheet_inspect_tool(delegated_arguments, workspace)
    if kind == "presentation":
        from sidecar.ai.tools.builtins.rich_files.presentation import (  # noqa: PLC0415
            presentation_inspect_tool,
        )

        return presentation_inspect_tool(delegated_arguments, workspace)
    from sidecar.ai.tools.builtins.rich_files.notebook import (  # noqa: PLC0415
        notebook_inspect_tool,
    )

    return notebook_inspect_tool(delegated_arguments, workspace)
