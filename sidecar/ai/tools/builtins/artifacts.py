"""Scratch artifact tool helpers."""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from pathlib import Path

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
)
from sidecar.ai.tools.builtins.filesystem import encode_utf8_text
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_store import (
    GuardedWorkspaceStore,
    StoredObject,
    StoreRef,
    WorkspaceStoreKind,
)

MAX_EDITABLE_BYTES = 512 * 1024
EXTENSION_PATTERN = re.compile(r"\.[a-z0-9]+(?:[._-][a-z0-9]+)*$")


@dataclass(frozen=True)
class BinaryArtifactSpec:
    artifact_kind: str
    title: str
    content: bytes
    mime_type: str
    file_name: str = ""
    metadata_extra: dict[str, object] | None = None


def _string_arg(arguments: dict[str, object], key: str, *, required: bool = False) -> str:
    value = arguments.get(key)
    if value is None:
        if required:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=f"tool argument '{key}' must be a non-empty string",
                retryable=False,
            )
        return ""
    if not isinstance(value, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument '{key}' must be a string",
            retryable=False,
        )
    normalized = value.strip()
    if required and not normalized:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument '{key}' must be a non-empty string",
            retryable=False,
        )
    return normalized


def _normalize_session_id(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value or "").strip())
    normalized = re.sub(r"-+", "-", normalized).strip("-")
    if not normalized:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="artifact creation requires a valid session context",
            retryable=False,
        )
    return normalized


def _slugify(value: str, fallback: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower())
    normalized = normalized.strip("-")
    return normalized or fallback


def _normalize_artifact_kind(value: str) -> str:
    normalized = str(value or "").strip().lower()
    return "script" if normalized == "script" else "document"


def _normalize_language(value: str) -> str:
    aliases = {
        "md": "markdown",
        "mmd": "mermaid",
        "plain": "text",
        "plain_text": "text",
        "plaintext": "text",
        "txt": "text",
        "js": "javascript",
        "ts": "typescript",
        "py": "python",
        "ps1": "powershell",
        "sh": "shell",
        "yml": "yaml",
    }
    normalized = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return aliases.get(normalized, normalized)


def _normalize_extension(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return ""
    candidate = normalized if normalized.startswith(".") else f".{normalized}"
    if not EXTENSION_PATTERN.fullmatch(candidate):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'extension' must be a simple file extension",
            retryable=False,
        )
    return candidate


def _extension_for(
    artifact_kind: str, language: str, requested_file_name: str, extension: str
) -> str:
    explicit = _normalize_extension(extension)
    if explicit:
        return explicit
    suffix = Path(requested_file_name).suffix.lower()
    if suffix:
        return suffix
    mapping = {
        "markdown": ".md",
        "mermaid": ".mmd",
        "text": ".txt",
        "javascript": ".js",
        "typescript": ".ts",
        "python": ".py",
        "powershell": ".ps1",
        "shell": ".sh",
        "json": ".json",
        "yaml": ".yml",
        "csv": ".csv",
        "html": ".html",
        "css": ".css",
        "sql": ".sql",
    }
    if language in mapping:
        return mapping[language]
    return ".txt" if artifact_kind == "script" else ".md"


def _extension_for_mime_type(mime_type: str) -> str:
    mapping = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/bmp": ".bmp",
        "image/tiff": ".tiff",
    }
    return mapping.get(str(mime_type or "").strip().lower(), ".bin")


def _artifact_parent(
    workspace: WorkspaceGuard,
    session_id: str,
) -> tuple[GuardedWorkspaceStore, StoreRef]:
    store = GuardedWorkspaceStore(workspace.require_root())
    return store, store.resolve(WorkspaceStoreKind.ARTIFACTS, session_id)


def _infer_language(file_name: str, fallback: str) -> str:
    if fallback:
        return fallback
    suffix = Path(file_name).suffix.lower()
    mapping = {
        ".md": "markdown",
        ".js": "javascript",
        ".ts": "typescript",
        ".py": "python",
        ".ps1": "powershell",
        ".sh": "shell",
        ".json": "json",
        ".yml": "yaml",
        ".yaml": "yaml",
        ".html": "html",
        ".css": "css",
        ".sql": "sql",
    }
    return mapping.get(suffix, "")


def create_binary_artifact(
    *,
    workspace: WorkspaceGuard,
    session_id: str,
    spec: BinaryArtifactSpec,
) -> ToolHandlerResult:
    normalized_session_id = _normalize_session_id(session_id)
    normalized_kind = str(spec.artifact_kind or "").strip().lower()
    if normalized_kind != "image":
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="binary artifact helper currently supports image artifacts only",
            retryable=False,
        )
    normalized_title = str(spec.title or "").strip()
    if not normalized_title:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="binary artifact creation requires a non-empty title",
            retryable=False,
        )
    if not isinstance(spec.content, bytes) or not spec.content:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="binary artifact content must be non-empty bytes",
            retryable=False,
        )
    normalized_mime_type = str(spec.mime_type or "").strip().lower() or "application/octet-stream"
    requested_file_name = str(spec.file_name or "").strip()
    requested_path = Path(requested_file_name) if requested_file_name else Path()
    file_stem = _slugify(requested_path.stem if requested_file_name else normalized_title, "preview")
    suffix = requested_path.suffix if requested_file_name else ""
    file_extension = _normalize_extension(suffix or _extension_for_mime_type(normalized_mime_type))
    store, artifact_parent = _artifact_parent(workspace, normalized_session_id)
    target = _write_unique_artifact_bytes(
        store,
        artifact_parent,
        file_stem,
        file_extension,
        spec.content,
    )
    relative_path = target.display_path
    metadata: dict[str, object] = {
        "artifact_id": (
            "artifact_file_"
            f"{normalized_session_id}_{_slugify(target.name, 'file')}_{secrets.token_hex(4)}"
        ),
        "artifact_kind": normalized_kind,
        "title": normalized_title,
        "file_name": target.name,
        "display_path": relative_path,
        "absolute_path": target.absolute_path,
        "mime_type": normalized_mime_type,
        "editable": False,
        "status": "available",
    }
    if spec.metadata_extra:
        for key, value in spec.metadata_extra.items():
            if str(key) == "absolute_path":
                continue
            metadata[str(key)] = value
    return ToolHandlerResult(
        output=f'Created {normalized_kind} "{normalized_title}" at {relative_path}',
        success=True,
        generated_artifacts=(metadata,),
    )


def _write_unique_artifact_bytes(
    store: GuardedWorkspaceStore,
    parent: StoreRef,
    file_stem: str,
    file_extension: str,
    encoded_content: bytes,
) -> StoredObject:
    return store.write_unique_bytes(
        parent,
        file_stem=file_stem,
        file_extension=file_extension,
        content=encoded_content,
    )


def build_text_artifact_metadata(  # noqa: PLR0913 - stable shared artifact facade.
    *,
    workspace: WorkspaceGuard,
    session_id: str,
    title: str,
    content: str,
    language: str,
    file_extension: str,
    artifact_kind: str = "document",
    stem_fallback: str = "artifact",
) -> dict[str, object]:
    """Persist UTF-8 ``content`` as a session-scoped artifact file and return its
    ``generated_artifacts`` metadata.

    Shared by builtins (e.g. ``mermaid_generate``) that want a first-class
    generated_file artifact -- rendered directly in the artifacts panel -- instead
    of a JSON tool-output blob the user has to hunt for. Mirrors
    ``create_artifact_tool``'s metadata shape so the renderer projection
    (renderer-artifacts-projection.js) routes it through the generated-file render
    path. Raises ``ToolExecutionFailure`` on an invalid session/extension or an IO
    failure -- callers that treat artifact persistence as best-effort should catch
    it and degrade gracefully.
    """
    normalized_session_id = _normalize_session_id(session_id)
    normalized_kind = (
        "script" if str(artifact_kind or "").strip().lower() == "script" else "document"
    )
    encoded_content = encode_utf8_text(content)
    normalized_extension = _normalize_extension(file_extension)
    store, artifact_parent = _artifact_parent(workspace, normalized_session_id)
    target = _write_unique_artifact_bytes(
        store,
        artifact_parent,
        _slugify(title, stem_fallback),
        normalized_extension,
        encoded_content,
    )
    relative_path = target.display_path
    return {
        "artifact_id": (
            "artifact_file_"
            f"{normalized_session_id}_{_slugify(target.name, 'file')}_{secrets.token_hex(4)}"
        ),
        "artifact_kind": normalized_kind,
        "title": str(title or "").strip() or Path(target.name).stem,
        "file_name": target.name,
        "display_path": relative_path,
        "absolute_path": target.absolute_path,
        "language": str(language or "").strip().lower(),
        "editable": len(encoded_content) <= MAX_EDITABLE_BYTES,
        "status": "available",
    }


def create_artifact_tool(
    arguments: dict[str, object], workspace: WorkspaceGuard
) -> ToolHandlerResult:
    session_id = _normalize_session_id(_string_arg(arguments, "_jenny_session_id", required=True))
    artifact_kind = _normalize_artifact_kind(_string_arg(arguments, "artifact_kind"))
    title = _string_arg(arguments, "title", required=True)
    content = arguments.get("content")
    if not isinstance(content, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'content' must be a string",
            retryable=False,
        )
    try:
        encoded_content = encode_utf8_text(content)
    except ToolExecutionFailure as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=error.message,
            retryable=False,
        ) from error
    requested_file_name = _string_arg(arguments, "file_name")
    language = _normalize_language(_string_arg(arguments, "language"))
    extension = _string_arg(arguments, "extension")
    file_stem = _slugify(
        Path(requested_file_name).stem if requested_file_name else title,
        "scratch-doc" if artifact_kind == "document" else "scratch-script",
    )
    file_extension = _extension_for(artifact_kind, language, requested_file_name, extension)
    store, artifact_parent = _artifact_parent(workspace, session_id)

    target = _write_unique_artifact_bytes(
        store,
        artifact_parent,
        file_stem,
        file_extension,
        encoded_content,
    )

    relative_path = target.display_path
    file_language = _infer_language(target.name, language)
    is_editable = len(encoded_content) <= MAX_EDITABLE_BYTES
    metadata = {
        "artifact_id": f"artifact_file_{session_id}_{_slugify(target.name, 'file')}_{secrets.token_hex(4)}",
        "artifact_kind": artifact_kind,
        "title": title,
        "file_name": target.name,
        "display_path": relative_path,
        "absolute_path": target.absolute_path,
        "language": file_language,
        "editable": is_editable,
        "status": "available",
    }
    return ToolHandlerResult(
        output=f'Created {artifact_kind} "{title}" at {relative_path}',
        success=True,
        generated_artifacts=(metadata,),
    )
