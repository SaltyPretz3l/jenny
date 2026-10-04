"""Bounded Mermaid source and artifact builtin."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Final

from sidecar.ai.error_codes import (
    CMP_TOOL_MERMAID_FORMAT,
    CMP_TOOL_MERMAID_INTERNAL,
    CMP_TOOL_MERMAID_OUTPUT_TOO_LARGE,
    CMP_TOOL_MERMAID_UNSUPPORTED_TYPE,
    CMP_TOOL_MERMAID_VALIDATION,
)
from sidecar.ai.tools.builtins.artifacts import build_text_artifact_metadata
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_INPUT_CHARS: Final[int] = 4_000
MAX_TITLE_CHARS: Final[int] = 160
MAX_HINT_CHARS: Final[int] = 160
MAX_OUTPUT_CHARS: Final[int] = 12_000

SUPPORTED_DIAGRAM_TYPES: Final[tuple[str, ...]] = (
    "flowchart",
    "sequence",
    "class",
    "state",
    "er",
    "journey",
    "gantt",
    "pie",
    "mindmap",
    "timeline",
    "gitGraph",
    "quadrantChart",
)

_WHITESPACE_RE = re.compile(r"\s+")


def _machine_error(
    *,
    code: str,
    reason: str,
    details: dict[str, object] | None = None,
) -> ToolExecutionFailure:
    payload: dict[str, object] = {"reason": reason}
    if details:
        payload.update(details)
    return ToolExecutionFailure(
        code=code,
        message=json.dumps(payload, sort_keys=True, ensure_ascii=False),
        retryable=False,
    )


def _normalize_line_text(value: str, *, max_chars: int) -> str:
    cleaned = _WHITESPACE_RE.sub(" ", str(value or "")).strip()
    if len(cleaned) > max_chars:
        return cleaned[:max_chars].rstrip()
    return cleaned


def _normalize_prompt(value: object) -> str:
    if not isinstance(value, str):
        raise _machine_error(
            code=CMP_TOOL_MERMAID_VALIDATION,
            reason="prompt must be a string",
            details={"field": "prompt"},
        )
    if len(value) > MAX_INPUT_CHARS:
        raise _machine_error(
            code=CMP_TOOL_MERMAID_VALIDATION,
            reason="prompt exceeds max_input_chars",
            details={"field": "prompt", "max_input_chars": MAX_INPUT_CHARS},
        )
    if not value.strip():
        raise _machine_error(
            code=CMP_TOOL_MERMAID_VALIDATION,
            reason="prompt must not be empty",
            details={"field": "prompt"},
        )
    return value


def _normalize_optional_field(
    value: object,
    *,
    field_name: str,
    max_chars: int,
) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _machine_error(
            code=CMP_TOOL_MERMAID_VALIDATION,
            reason=f"{field_name} must be a string when provided",
            details={"field": field_name},
        )
    normalized = _normalize_line_text(value, max_chars=max_chars)
    return normalized or None


def _normalize_diagram_type(value: object) -> str:
    if value is None:
        return "flowchart"
    if not isinstance(value, str):
        raise _machine_error(
            code=CMP_TOOL_MERMAID_UNSUPPORTED_TYPE,
            reason="diagram_type must be a string",
            details={"supported_types": list(SUPPORTED_DIAGRAM_TYPES)},
        )
    normalized = str(value).strip()
    if normalized not in SUPPORTED_DIAGRAM_TYPES:
        raise _machine_error(
            code=CMP_TOOL_MERMAID_UNSUPPORTED_TYPE,
            reason="unsupported diagram_type",
            details={
                "diagram_type": normalized,
                "supported_types": list(SUPPORTED_DIAGRAM_TYPES),
            },
        )
    return normalized


def _validate_generated_output(*, diagram_type: str, mermaid: str) -> None:
    normalized = str(mermaid or "").strip()
    if not normalized:
        raise _machine_error(
            code=CMP_TOOL_MERMAID_FORMAT,
            reason="generated mermaid output is empty",
            details={"diagram_type": diagram_type},
        )
    if len(normalized) > MAX_OUTPUT_CHARS:
        raise _machine_error(
            code=CMP_TOOL_MERMAID_OUTPUT_TOO_LARGE,
            reason="generated mermaid exceeds max_output_chars",
            details={"max_output_chars": MAX_OUTPUT_CHARS, "diagram_type": diagram_type},
        )


def _build_mermaid_artifacts(
    *,
    workspace: WorkspaceGuard,
    arguments: dict[str, object],
    mermaid: str,
    diagram_type: str,
    title: str | None,
) -> tuple[dict[str, object], ...]:
    """Best-effort: persist the diagram as a first-class ``.mmd`` generated_file
    artifact so the artifacts panel renders it directly instead of burying it in a
    JSON tool-output blob. The JSON output remains the source of truth, so a missing
    workspace/session or any IO failure degrades to no artifact rather than failing
    diagram generation.
    """
    session_id = str(arguments.get("_jenny_session_id") or "").strip()
    if not session_id or workspace is None or workspace.root is None:
        return ()
    try:
        metadata = build_text_artifact_metadata(
            workspace=workspace,
            session_id=session_id,
            title=title or f"{diagram_type} diagram",
            content=mermaid,
            language="mermaid",
            file_extension=".mmd",
            artifact_kind="document",
            stem_fallback=diagram_type or "diagram",
        )
    except ToolExecutionFailure:
        return ()
    return (metadata,)


def mermaid_generate_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    """Return the supplied Mermaid source and optionally save its artifact."""
    try:
        prompt = _normalize_prompt(arguments.get("prompt"))
        diagram_type = _normalize_diagram_type(arguments.get("diagram_type"))
        title = _normalize_optional_field(
            arguments.get("title"),
            field_name="title",
            max_chars=MAX_TITLE_CHARS,
        )
        render_hint = _normalize_optional_field(
            arguments.get("render_hint"),
            field_name="render_hint",
            max_chars=MAX_HINT_CHARS,
        )

        hash_payload = {
            "diagram_type": diagram_type,
            "prompt": prompt,
            "render_hint": render_hint or "",
            "title": title or "",
        }
        request_hash = hashlib.sha256(
            json.dumps(hash_payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        ).hexdigest()

        mermaid = prompt
        _validate_generated_output(diagram_type=diagram_type, mermaid=mermaid)

        output_payload: dict[str, object] = {
            "mermaid": mermaid,
            "diagram_type": diagram_type,
        }
        if title:
            output_payload["title"] = title
        if render_hint:
            output_payload["render_hint"] = render_hint

        if arguments.get("_jenny_read_only") is True:
            output_payload["note"] = "Artifact save skipped in this read-only turn."
            generated_artifacts: tuple[dict[str, object], ...] = ()
        else:
            generated_artifacts = _build_mermaid_artifacts(
                workspace=workspace,
                arguments=arguments,
                mermaid=mermaid,
                diagram_type=diagram_type,
                title=title,
            )

        return ToolHandlerResult(
            output=json.dumps(output_payload, ensure_ascii=False),
            success=True,
            generated_artifacts=generated_artifacts,
            metadata={
                "request_hash": request_hash,
                "diagram_type": diagram_type,
            },
        )
    except ToolExecutionFailure:
        raise
    except Exception as error:
        raise _machine_error(
            code=CMP_TOOL_MERMAID_INTERNAL,
            reason="internal mermaid generation failure",
            details={"error_type": type(error).__name__},
        ) from error
