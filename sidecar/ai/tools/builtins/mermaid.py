"""Deterministic Mermaid diagram generation builtin."""

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
    if _looks_like_mermaid_source(value):
        return value

    normalized_lines = [_normalize_line_text(line, max_chars=320) for line in value.splitlines()]
    normalized = "\n".join(line for line in normalized_lines if line)
    normalized = normalized.strip()
    if not normalized:
        raise _machine_error(
            code=CMP_TOOL_MERMAID_VALIDATION,
            reason="prompt must not be empty",
            details={"field": "prompt"},
        )
    return normalized


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


def _mermaid_safe(value: str, *, max_chars: int) -> str:
    sanitized = _normalize_line_text(value, max_chars=max_chars)
    return sanitized.replace('"', "'").replace("`", "'")


_MERMAID_SOURCE_LEADING_KEYWORDS: Final[frozenset[str]] = frozenset(
    [
        "flowchart",
        # `graph` is the classic Mermaid flowchart header (e.g. `graph TD`); without
        # it, pasted real flowchart source is not recognized as Mermaid and gets
        # rebuilt into a trivial 2-node placeholder diagram.
        "graph",
        "sequencediagram",
        "classdiagram",
        "statediagram",
        "erdiagram",
        "journey",
        "gantt",
        "pie",
        "mindmap",
        "timeline",
        "gitgraph",
        "quadrantchart",
    ]
)


def _looks_like_mermaid_source(value: str) -> bool:
    """Return True when the value already contains full Mermaid syntax."""
    first = value.split(maxsplit=1)[0].rstrip(":").lower() if value.split() else ""
    return first in _MERMAID_SOURCE_LEADING_KEYWORDS


def _build_mermaid(
    *,
    diagram_type: str,
    prompt: str,
    title: str | None,
) -> str:
    safe_title = _mermaid_safe(title or "Prompt Diagram", max_chars=120)
    prompt_inline = _mermaid_safe(prompt.replace("\n", " / "), max_chars=280)

    if diagram_type == "flowchart":
        return "\n".join(
            (
                "flowchart TD",
                f'    A["{safe_title}"]',
                f'    B["{prompt_inline}"]',
                "    A --> B",
            )
        )
    if diagram_type == "sequence":
        return "\n".join(
            (
                "sequenceDiagram",
                "    participant User",
                "    participant Jenny",
                f"    User->>Jenny: {prompt_inline}",
                f"    Jenny-->>User: {safe_title}",
            )
        )
    if diagram_type == "class":
        return "\n".join(
            (
                "classDiagram",
                "    class PromptContext {",
                "      +summary",
                "    }",
                f"    PromptContext : {prompt_inline}",
            )
        )
    if diagram_type == "state":
        return "\n".join(
            (
                "stateDiagram-v2",
                "    [*] --> Prompt",
                f"    Prompt : {prompt_inline}",
                "    Prompt --> [*]",
            )
        )
    if diagram_type == "er":
        return "\n".join(
            (
                "erDiagram",
                "    PROMPT {",
                "      string text",
                "      string title",
                "    }",
            )
        )
    if diagram_type == "journey":
        return "\n".join(
            (
                "journey",
                f"    title {safe_title}",
                "    section Prompt",
                f"      {prompt_inline}: 5: Jenny",
            )
        )
    if diagram_type == "gantt":
        return "\n".join(
            (
                "gantt",
                f"    title {safe_title}",
                "    dateFormat YYYY-MM-DD",
                "    section Plan",
                "    Prompt synthesis :done, p1, 2026-01-01, 1d",
            )
        )
    if diagram_type == "pie":
        return "\n".join(
            (
                f"pie title {safe_title}",
                '    "Prompt focus" : 100',
            )
        )
    if diagram_type == "mindmap":
        return "\n".join(
            (
                "mindmap",
                f"  root(({safe_title}))",
                f"    {prompt_inline}",
            )
        )
    if diagram_type == "timeline":
        return "\n".join(
            (
                "timeline",
                f"    title {safe_title}",
                f"    Prompt : {prompt_inline}",
            )
        )
    if diagram_type == "gitGraph":
        commit_label = _mermaid_safe(f"{safe_title} seed", max_chars=64)
        return "\n".join(
            (
                "gitGraph",
                '    commit id: "start"',
                f'    commit id: "{commit_label}"',
            )
        )
    if diagram_type == "quadrantChart":
        return "\n".join(
            (
                "quadrantChart",
                f"    title {safe_title}",
                "    x-axis Low --> High",
                "    y-axis Low --> High",
                "    quadrant-1 Act",
                "    quadrant-2 Explore",
                "    quadrant-3 Avoid",
                "    quadrant-4 Monitor",
                "    Prompt Context: [0.6, 0.6]",
            )
        )

    raise _machine_error(
        code=CMP_TOOL_MERMAID_UNSUPPORTED_TYPE,
        reason="unsupported diagram_type",
        details={
            "diagram_type": diagram_type,
            "supported_types": list(SUPPORTED_DIAGRAM_TYPES),
        },
    )


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
    """Generate deterministic Mermaid syntax from a bounded natural-language prompt."""
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

        if _looks_like_mermaid_source(prompt):
            mermaid = prompt
        else:
            mermaid = _build_mermaid(
                diagram_type=diagram_type,
                prompt=prompt,
                title=title,
            )
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
    except Exception as error:  # noqa: BLE001
        raise _machine_error(
            code=CMP_TOOL_MERMAID_INTERNAL,
            reason="internal mermaid generation failure",
            details={"error_type": type(error).__name__},
        ) from error
