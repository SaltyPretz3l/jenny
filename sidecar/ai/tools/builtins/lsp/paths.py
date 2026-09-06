"""Workspace-contained target resolution for LSP tools."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.builtins.filesystem import workspace_relative_path
from sidecar.ai.tools.builtins.lsp.manager import (
    _EXTENSION_LANGUAGE_MAP,
    LSPLanguage,
    resolve_language_for_path,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_LSP_POSITION_VALUE = 2_147_483_647


@dataclass(frozen=True)
class LSPTarget:
    absolute_path: Path
    relative_path: str
    uri: str
    language: LSPLanguage


def parse_lsp_position(arguments: dict[str, object]) -> dict[str, int]:
    return {
        "line": _required_nonnegative_int(arguments.get("line"), "line"),
        "character": _required_nonnegative_int(arguments.get("character"), "character"),
    }


def resolve_lsp_target(arguments: dict[str, object], workspace: WorkspaceGuard) -> LSPTarget:
    raw_path = arguments.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'path' must be a non-empty string",
            retryable=False,
        )
    resolved = workspace.resolve_read_path(raw_path)
    if not resolved.is_file():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="path must point to a file",
            retryable=False,
        )
    language = resolve_language_for_path(resolved)
    if language is None:
        suffix = resolved.suffix.lower()
        unsupported = (
            f"lsp does not support {suffix} files."
            if suffix
            else "lsp does not support files without an extension."
        )
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                f"{unsupported} Supported: {', '.join(_EXTENSION_LANGUAGE_MAP)}. "
                "For other file types use read_file, grep_search, or edit_file instead."
            ),
            retryable=False,
        )
    return LSPTarget(
        absolute_path=resolved,
        relative_path=workspace_relative_path(resolved, workspace.root),
        uri=resolved.as_uri(),
        language=language,
    )


def server_language_for_target(language: LSPLanguage) -> LSPLanguage:
    if language == "javascript":
        return "typescript"
    return language


def _file_uri_path(uri: object) -> Path | None:
    if not isinstance(uri, str) or not uri.strip():
        return None
    parsed = urlparse(uri.strip())
    invalid_uri = (
        parsed.scheme.lower() != "file"
        or bool(parsed.netloc and parsed.netloc.lower() != "localhost")
        or not parsed.path
    )
    if invalid_uri:
        return None
    candidate = Path(url2pathname(parsed.path))
    return candidate if candidate.is_absolute() else None


def workspace_relative_file_uri(uri: object, workspace: WorkspaceGuard) -> str | None:
    candidate = _file_uri_path(uri)
    if candidate is None:
        return None
    try:
        root = workspace.require_root()
        resolved = workspace.ensure_within_root(candidate)
        if not resolved.is_file():
            return None
    except (OSError, ValueError, ToolExecutionFailure):
        return None
    return workspace_relative_path(resolved, root)


def _required_nonnegative_int(value: object, field_name: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > MAX_LSP_POSITION_VALUE
    ):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                f"tool argument '{field_name}' must be a non-negative integer "
                f"no greater than {MAX_LSP_POSITION_VALUE}"
            ),
            retryable=False,
        )
    return value
