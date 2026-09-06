"""Shared rich-file validation, bounded I/O, result envelopes, and serialization."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import stat as stat_module
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from sidecar.ai.error_codes import (
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING,
    CMP_TOOL_RICH_FILES_MIME_MISMATCH,
    CMP_TOOL_RICH_FILES_TOO_LARGE,
    CMP_TOOL_RICH_FILES_UNSUPPORTED,
)
from sidecar.ai.tools.builtins.filesystem import workspace_relative_path
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.sanitization import sanitize_tool_output
from sidecar.ai.tools.workspace import WorkspaceGuard

# Defaults mirror filesystem_content.py's MAX_MEDIA_FILE_BYTES (25 MiB) so
# rich-file inspect can swap in the existing PDF/image loaders without
# changing user-visible behavior.
DEFAULT_MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_RICH_INSPECT_OUTPUT_CHARS = 12_000
MAX_RICH_INSPECT_STRING_CHARS = 2_000
MAX_RICH_INSPECT_SUMMARY_STRING_CHARS = 512
MAX_RICH_INSPECT_WARNINGS = 8
MAX_RICH_INSPECT_PREVIEWS = 8

RichFileAdapter = Literal[
    "pdf",
    "image",
    "spreadsheet",
    "document",
    "presentation",
    "notebook",
]


@dataclass(frozen=True)
class RichFileSource:
    """A workspace-relative source path that has been validated for inspection."""

    workspace_path: str  # POSIX-style workspace-relative path
    absolute_path: Path
    mime_type: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class RichInspectFailure:
    """Adapter-level structured failure that does not crash the turn."""

    adapter: RichFileAdapter
    reason: str
    error_code: str
    install_hint: str | None = None


@dataclass(frozen=True)
class RichInspectResult:
    """The shared result envelope every rich-file adapter returns.

    Adapters fill ``summary`` and optional ``previews`` per format. Preview
    artifacts are created through ``create_artifact_tool``.
    """

    status: Literal["inspected", "unavailable", "unsupported"]
    adapter: RichFileAdapter
    source: RichFileSource
    summary: dict[str, Any] = field(default_factory=dict)
    previews: tuple[dict[str, Any], ...] = ()
    warnings: tuple[str, ...] = ()
    failure: RichInspectFailure | None = None


@dataclass(frozen=True)
class RichPreviewResult:
    """Preview artifact data returned by adapters after optional generation."""

    previews: tuple[dict[str, object], ...] = ()
    warnings: tuple[str, ...] = ()
    generated_artifacts: tuple[dict[str, object], ...] = ()


class RichSourceValidator:
    """Resolves and validates a rich-file source against a workspace.

    Stateless except for the workspace handle; safe to instantiate per call.
    """

    def __init__(
        self,
        workspace: WorkspaceGuard,
        *,
        max_bytes: int = DEFAULT_MAX_SOURCE_BYTES,
        expected_mime_prefix: str | None = None,
    ) -> None:
        self._workspace = workspace
        self._max_bytes = max_bytes
        self._expected_mime_prefix = expected_mime_prefix

    def validate(self, *, requested_path: str, adapter: RichFileAdapter) -> RichFileSource:
        if not isinstance(requested_path, str) or not requested_path.strip():
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="rich-file inspect requires a non-empty 'path' string",
                retryable=False,
            )
        absolute = self._workspace.resolve_read_path(requested_path)
        try:
            stat_result = absolute.stat()
        except OSError as error:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=f"failed to stat {requested_path}: {error}",
                retryable=False,
            ) from error
        if not stat_module.S_ISREG(stat_result.st_mode):
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=f"path is not a regular file: {requested_path}",
                retryable=False,
            )

        workspace_root = self._workspace.require_root().resolve()
        display_path = workspace_relative_path(absolute, workspace_root)

        size = stat_result.st_size
        if size > self._max_bytes:
            raise ToolExecutionFailure(
                code=CMP_TOOL_RICH_FILES_TOO_LARGE,
                message=(
                    f"file exceeds {self._max_bytes} byte limit "
                    f"({size} bytes): {display_path}"
                ),
                retryable=False,
            )

        mime_type, _ = mimetypes.guess_type(absolute.name)
        if mime_type is None:
            mime_type = ""

        if (
            self._expected_mime_prefix is not None
            and mime_type
            and not mime_type.startswith(self._expected_mime_prefix)
        ):
            raise ToolExecutionFailure(
                code=CMP_TOOL_RICH_FILES_MIME_MISMATCH,
                message=(
                    f"{adapter} adapter expected MIME prefix "
                    f"'{self._expected_mime_prefix}' but got '{mime_type}' for {display_path}"
                ),
                retryable=False,
            )

        if not mime_type and self._expected_mime_prefix is not None:
            raise ToolExecutionFailure(
                code=CMP_TOOL_RICH_FILES_UNSUPPORTED,
                message=(
                    f"could not determine MIME type for {display_path}; "
                    f"{adapter} adapter requires a known MIME"
                ),
                retryable=False,
            )

        sha256 = _sha256_file(absolute, max_bytes=self._max_bytes, display_path=display_path)

        return RichFileSource(
            workspace_path=display_path,
            absolute_path=absolute,
            mime_type=mime_type,
            size_bytes=size,
            sha256=sha256,
        )


def validate_rich_file_source(
    *,
    requested_path: str,
    workspace: WorkspaceGuard,
    adapter: RichFileAdapter,
    max_bytes: int = DEFAULT_MAX_SOURCE_BYTES,
    expected_mime_prefix: str | None = None,
) -> RichFileSource:
    """Convenience wrapper for adapters that only need a one-shot validation."""

    validator = RichSourceValidator(
        workspace,
        max_bytes=max_bytes,
        expected_mime_prefix=expected_mime_prefix,
    )
    return validator.validate(requested_path=requested_path, adapter=adapter)


def string_argument(arguments: dict[str, object], key: str, *, required: bool = False) -> str:
    value = arguments.get(key)
    if value is None:
        if required:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=f"tool argument '{key}' must be a non-empty string",
                retryable=False,
            )
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument '{key}' must be a non-empty string",
            retryable=False,
        )
    return value.strip()


def build_dependency_missing_result(
    *,
    adapter: RichFileAdapter,
    source: RichFileSource,
    dependency: str,
    install_hint: str | None = None,
) -> RichInspectResult:
    """Build an unavailable result for a missing optional dependency."""

    return RichInspectResult(
        status="unavailable",
        adapter=adapter,
        source=source,
        failure=RichInspectFailure(
            adapter=adapter,
            reason=f"{adapter} adapter requires {dependency} which is not installed",
            error_code=CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING,
            install_hint=install_hint,
        ),
    )


def build_unsupported_result(
    *,
    adapter: RichFileAdapter,
    source: RichFileSource,
    reason: str,
) -> RichInspectResult:
    """Helper for format-level rejections that should not crash the turn."""

    return RichInspectResult(
        status="unsupported",
        adapter=adapter,
        source=source,
        failure=RichInspectFailure(
            adapter=adapter,
            reason=reason,
            error_code=CMP_TOOL_RICH_FILES_UNSUPPORTED,
        ),
    )


def rich_source_to_metadata(source: RichFileSource) -> dict[str, object]:
    """Return model-facing source metadata without absolute local paths."""

    return {
        "path": source.workspace_path,
        "mime_type": source.mime_type,
        "size_bytes": source.size_bytes,
        "sha256": source.sha256,
    }


def rich_failure_to_metadata(failure: RichInspectFailure | None) -> dict[str, object] | None:
    if failure is None:
        return None
    payload: dict[str, object] = {
        "adapter": failure.adapter,
        "reason": failure.reason,
        "error_code": failure.error_code,
    }
    if failure.install_hint:
        payload["install_hint"] = failure.install_hint
    return payload


def rich_inspect_result_payload(result: RichInspectResult) -> dict[str, object]:
    """Serialize a rich inspect result into the stable tool output envelope."""

    return {
        "status": result.status,
        "adapter": result.adapter,
        "source": rich_source_to_metadata(result.source),
        "summary": _sanitize_model_payload(result.summary),
        "previews": [
            _sanitize_model_payload(preview)
            for preview in result.previews[:MAX_RICH_INSPECT_PREVIEWS]
            if isinstance(preview, dict)
        ],
        "warnings": _serialize_warnings(result.warnings),
        "failure": rich_failure_to_metadata(result.failure),
    }


def rich_inspect_result_to_tool_result(
    result: RichInspectResult,
    *,
    generated_artifacts: tuple[dict[str, object], ...] = (),
) -> ToolHandlerResult:
    """Convert adapter results into bounded ToolHandlerResult output/metadata."""

    payload = rich_inspect_result_payload(result)
    output, bounded_payload = _bounded_json_output(payload)
    metadata = {
        "result_kind": f"{result.adapter}_inspect",
        **bounded_payload,
    }
    return ToolHandlerResult(
        output=output,
        success=True,
        generated_artifacts=generated_artifacts,
        metadata=metadata,
    )


def preview_artifact_metadata(
    metadata: dict[str, object],
    *,
    extra: dict[str, object] | None = None,
) -> dict[str, object]:
    """Return model-facing preview metadata shared by rich-file adapters."""

    payload = {
        "artifact_id": metadata.get("artifact_id"),
        "display_path": metadata.get("display_path"),
        "file_name": metadata.get("file_name"),
        "mime_type": metadata.get("mime_type"),
    }
    if extra:
        payload.update(extra)
    return payload


def _sanitize_model_payload(value: object) -> object:
    if isinstance(value, dict):
        sanitized: dict[str, object] = {}
        for raw_key, raw_child in value.items():
            key = str(raw_key)
            if key == "absolute_path":
                continue
            sanitized[key] = _sanitize_model_payload(raw_child)
        return sanitized
    if isinstance(value, (list, tuple)):
        return [_sanitize_model_payload(item) for item in value]
    if isinstance(value, Path):
        return value.name
    if isinstance(value, str) and value.lstrip().lower().startswith("data:"):
        return "[data URI omitted]"
    if isinstance(value, str) and len(value) > MAX_RICH_INSPECT_STRING_CHARS:
        return sanitize_tool_output(
            value,
            max_chars=MAX_RICH_INSPECT_STRING_CHARS,
            tool_name="rich_file_inspect",
        )
    return value


def _serialize_warnings(warnings: tuple[str, ...]) -> list[str]:
    serialized = [
        sanitize_tool_output(
            warning,
            max_chars=MAX_RICH_INSPECT_SUMMARY_STRING_CHARS,
            tool_name="rich_file_inspect",
        )
        for warning in warnings[:MAX_RICH_INSPECT_WARNINGS]
    ]
    if len(warnings) > MAX_RICH_INSPECT_WARNINGS:
        serialized.append("additional warnings truncated")
    return serialized


def _bounded_json_output(payload: dict[str, object]) -> tuple[str, dict[str, object]]:
    normalized = json.loads(json.dumps(payload, ensure_ascii=False, default=str))
    raw = _compact_json(normalized)
    if len(raw) <= MAX_RICH_INSPECT_OUTPUT_CHARS:
        return raw, normalized

    normalized["truncated"] = True
    _trim_summary_for_output(normalized.get("summary"))
    warnings = normalized.get("warnings")
    if isinstance(warnings, list):
        normalized["warnings"] = [str(item)[:320] for item in warnings[:5]]
    previews = normalized.get("previews")
    if isinstance(previews, list):
        normalized["previews"] = previews[:5]
    raw = _compact_json(normalized)
    if len(raw) <= MAX_RICH_INSPECT_OUTPUT_CHARS:
        return raw, normalized

    normalized["summary"] = {"truncated": True}
    normalized["previews"] = []
    raw = _compact_json(normalized)
    if len(raw) <= MAX_RICH_INSPECT_OUTPUT_CHARS:
        return raw, normalized

    fallback = {
        "status": normalized.get("status"),
        "adapter": normalized.get("adapter"),
        "source": normalized.get("source"),
        "summary": {"truncated": True},
        "previews": [],
        "warnings": ["rich inspect output truncated to fit model budget"],
        "failure": normalized.get("failure"),
        "truncated": True,
    }
    raw = _compact_json(fallback)
    if len(raw) <= MAX_RICH_INSPECT_OUTPUT_CHARS:
        return raw, fallback

    minimal = {
        "status": normalized.get("status"),
        "adapter": normalized.get("adapter"),
        "summary": {"truncated": True},
        "previews": [],
        "warnings": ["rich inspect output truncated to fit model budget"],
        "failure": normalized.get("failure"),
        "truncated": True,
    }
    return _compact_json(minimal), minimal


def _compact_json(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _trim_summary_for_output(summary: object) -> None:
    if not isinstance(summary, dict):
        return
    pages = summary.get("pages")
    if isinstance(pages, list):
        for page in pages:
            if isinstance(page, dict) and isinstance(page.get("text_excerpt"), str):
                page["text_excerpt"] = sanitize_tool_output(
                    page["text_excerpt"],
                    max_chars=320,
                    tool_name="rich_file_inspect",
                )
    for key, value in list(summary.items()):
        if isinstance(value, str) and len(value) > MAX_RICH_INSPECT_SUMMARY_STRING_CHARS:
            summary[key] = sanitize_tool_output(
                value,
                max_chars=MAX_RICH_INSPECT_SUMMARY_STRING_CHARS,
                tool_name="rich_file_inspect",
            )


def _sha256_file(
    path: Path,
    *,
    chunk_size: int = 65_536,
    max_bytes: int | None = None,
    display_path: str | None = None,
) -> str:
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            total += len(chunk)
            if max_bytes is not None and total > max_bytes:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_RICH_FILES_TOO_LARGE,
                    message=(
                        f"file exceeds {max_bytes} byte limit while hashing: "
                        f"{display_path or path.name}"
                    ),
                    retryable=False,
                )
            digest.update(chunk)
    return digest.hexdigest()


def read_bounded_file_bytes(
    path: Path,
    *,
    max_bytes: int,
    message: str = "preview source changed beyond rich-file size limit",
) -> bytes:
    content = bytearray()
    total = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(65_536)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_RICH_FILES_UNSUPPORTED,
                    message=message,
                    retryable=False,
                )
            content.extend(chunk)
    return bytes(content)
