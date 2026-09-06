"""Shared imports/helpers for ``sidecar.ai.routing.tool_execution``."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sidecar.ai.error_codes import (
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_LOOP_TOOL_INPUT_VALIDATION,
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_DISABLED,
)
from sidecar.ai.feature_flags import FEATURE_SHELL_SECURITY, is_feature_flag_enabled
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.tools.builtins.file_state import (
    READ_SNAPSHOT_SCOPE_FULL,
    read_snapshot_from_metadata,
)
from sidecar.ai.tools.builtins.shell_security import CommandVerdict, classify_command
from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.ai.tools.sanitization import (
    sanitize_tool_output,
    scan_tool_arguments,
    wrap_untrusted_tool_output,
)
from sidecar.ai.tools.tool_search_handler import (
    handle_tool_search,
)

if TYPE_CHECKING:
    from sidecar.ai.routing.router import ApprovalRequest, ToolExecutionOutcome

__all__ = [
    "ApprovalRequest",
    "CMP_LOOP_INVALID_TOOL_CALL",
    "CMP_LOOP_TOOL_INPUT_VALIDATION",
    "CMP_MODE_TOOL_BLOCKED",
    "CMP_TOOL_COMMAND_BLOCKED",
    "CMP_TOOL_DISABLED",
    "CommandVerdict",
    "FEATURE_SHELL_SECURITY",
    "GenerationResult",
    "MCPError",
    "READ_SNAPSHOT_SCOPE_FULL",
    "ToolCallRequest",
    "ToolExecutionFailure",
    "ToolExecutionOutcome",
    "handle_tool_search",
    "classify_command",
    "is_feature_flag_enabled",
    "read_snapshot_from_metadata",
    "sanitize_tool_output",
    "scan_tool_arguments",
    "validate_tool_arguments",
    "wrap_untrusted_tool_output",
]
