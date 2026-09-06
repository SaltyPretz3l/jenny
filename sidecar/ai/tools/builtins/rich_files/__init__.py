"""Rich-file inspection and rendering adapters.

Preview artifacts go through ``create_artifact_tool``. Optional media
dependencies load on demand and degrade to structured unavailable results.
"""

from sidecar.ai.tools.builtins.rich_files.base import (
    RichFileSource,
    RichInspectFailure,
    RichInspectResult,
    RichPreviewResult,
    RichSourceValidator,
    build_unsupported_result,
    preview_artifact_metadata,
    read_bounded_file_bytes,
    rich_inspect_result_to_tool_result,
    string_argument,
    validate_rich_file_source,
)
from sidecar.ai.tools.builtins.rich_files.document import document_inspect_tool
from sidecar.ai.tools.builtins.rich_files.notebook import notebook_inspect_tool
from sidecar.ai.tools.builtins.rich_files.presentation import presentation_inspect_tool

__all__ = [
    "RichFileSource",
    "RichInspectFailure",
    "RichInspectResult",
    "RichPreviewResult",
    "RichSourceValidator",
    "build_unsupported_result",
    "document_inspect_tool",
    "notebook_inspect_tool",
    "preview_artifact_metadata",
    "presentation_inspect_tool",
    "read_bounded_file_bytes",
    "rich_inspect_result_to_tool_result",
    "string_argument",
    "validate_rich_file_source",
]
