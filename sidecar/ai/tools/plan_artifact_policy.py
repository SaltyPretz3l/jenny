"""Bounded artifact-write capability for read-only Plan Mode turns.

The model never supplies the capability token defined here.  Callers strip it
at every untrusted ingress, then the execution snapshot seam injects it only
after all document classifiers have passed this fail-closed policy.
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import PurePosixPath
from typing import Any

PLAN_ARTIFACT_WRITE_ARG = "_jenny_plan_artifact_write"
MAX_PLAN_ARTIFACT_BYTES = 512 * 1024

SAFE_PLAN_ARTIFACT_EXTENSIONS = frozenset(
    {".md", ".markdown", ".txt", ".mmd", ".mermaid", ".json", ".yaml", ".yml", ".csv"}
)
_LANGUAGE_ALIASES = {
    "md": "markdown",
    "markdown": "markdown",
    "plain": "text",
    "plain_text": "text",
    "plaintext": "text",
    "text": "text",
    "txt": "text",
    "mermaid": "mermaid",
    "mmd": "mermaid",
    "json": "json",
    "yaml": "yaml",
    "yml": "yaml",
    "csv": "csv",
}
_LANGUAGE_SCHEMA_HINTS = frozenset(
    set(_LANGUAGE_ALIASES)
    | {
        "CSV",
        "JSON",
        "Markdown",
        "Mermaid",
        "Plain Text",
        "Plain text",
        "YAML",
        "plain text",
        "plain-text",
    }
)
_EXTENSION_FAMILIES = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".txt": "text",
    ".mmd": "mermaid",
    ".mermaid": "mermaid",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".csv": "csv",
}
_LANGUAGE_EXTENSIONS = {
    "markdown": ".md",
    "text": ".txt",
    "mermaid": ".mmd",
    "json": ".json",
    "yaml": ".yaml",
    "csv": ".csv",
}


def strip_plan_artifact_write_arg(arguments: Any) -> Any:
    """Return a copy with the sidecar-only capability removed.

    Non-dict arguments cannot carry the capability key, so they pass through
    unchanged: coercing them to ``{}`` here would launder malformed model
    calls into valid empty-argument calls before downstream validation sees
    them.
    """

    if not isinstance(arguments, dict):
        return arguments
    sanitized = {str(key): value for key, value in arguments.items()}
    sanitized.pop(PLAN_ARTIFACT_WRITE_ARG, None)
    return sanitized


def descriptor_allows_plan_artifact_write(descriptor: Any | None) -> bool:
    availability = getattr(descriptor, "availability", None)
    return bool(getattr(availability, "plan_mode_artifact_write", False))


def plan_artifact_mode_exemption(
    descriptor: Any | None,
    *,
    plan_mode: bool,
    read_only: bool,
) -> bool:
    return bool(plan_mode and read_only and descriptor_allows_plan_artifact_write(descriptor))


def _normalized_extension(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if not normalized:
        return ""
    candidate = normalized if normalized.startswith(".") else f".{normalized}"
    return candidate if candidate in SAFE_PLAN_ARTIFACT_EXTENSIONS else None


def _filename_extension(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized:
        return ""
    final_name = normalized.replace("\\", "/").rsplit("/", 1)[-1]
    suffix = PurePosixPath(final_name).suffix.lower()
    if not suffix:
        return ""
    return suffix if suffix in SAFE_PLAN_ARTIFACT_EXTENSIONS else None


def _normalized_language(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return ""
    return _LANGUAGE_ALIASES.get(normalized)


def is_safe_plan_document(  # noqa: PLR0911 - explicit fail-closed classifier checks
    arguments: object,
) -> bool:
    """Return whether a create_artifact call is inert and internally consistent."""

    if not isinstance(arguments, dict):
        return False
    if str(arguments.get("artifact_kind") or "").strip().lower() != "document":
        return False
    title = arguments.get("title")
    content = arguments.get("content")
    if not isinstance(title, str) or not title.strip() or not isinstance(content, str):
        return False
    try:
        if len(content.encode("utf-8")) > MAX_PLAN_ARTIFACT_BYTES:
            return False
    except UnicodeEncodeError:
        return False

    language = _normalized_language(arguments.get("language", ""))
    extension = _normalized_extension(arguments.get("extension", ""))
    filename_extension = _filename_extension(arguments.get("file_name", ""))
    if language is None or extension is None or filename_extension is None:
        return False

    classifiers = {
        classifier
        for classifier in (
            language or None,
            _EXTENSION_FAMILIES.get(extension) if extension else None,
            _EXTENSION_FAMILIES.get(filename_extension) if filename_extension else None,
        )
        if classifier
    }
    if len(classifiers) > 1:
        return False

    resolved_extension = (
        extension
        or filename_extension
        or _LANGUAGE_EXTENSIONS.get(language or "")
        or ".md"
    )
    return resolved_extension in SAFE_PLAN_ARTIFACT_EXTENSIONS


def is_plan_artifact_write_eligible(
    descriptor: Any | None,
    tool_name: str,
    arguments: object,
    *,
    plan_mode: bool,
    read_only: bool,
) -> bool:
    if not plan_artifact_mode_exemption(
        descriptor,
        plan_mode=plan_mode,
        read_only=read_only,
    ):
        return False
    normalized_name = str(tool_name or "").strip()
    if normalized_name == "mermaid_generate":
        return True
    return normalized_name == "create_artifact" and is_safe_plan_document(arguments)


def prompt_schema_for_context(
    descriptor: Any,
    *,
    plan_mode: bool,
    read_only: bool,
) -> dict[str, Any]:
    """Return the model-facing schema, narrowed before token-budget filtering."""

    parameters = deepcopy(getattr(descriptor, "input_schema", {}))
    description = str(getattr(descriptor, "description", "") or "")
    if (
        str(getattr(descriptor, "name", "") or "") == "create_artifact"
        and plan_artifact_mode_exemption(descriptor, plan_mode=plan_mode, read_only=read_only)
    ):
        parameters = {
            "type": "object",
            "properties": {
                "artifact_kind": {
                    "type": "string",
                    "enum": ["document"],
                    "description": "Plan Mode may create inert scratch documents only.",
                },
                "title": {"type": "string", "minLength": 1},
                "content": {
                    "type": "string",
                    "maxLength": MAX_PLAN_ARTIFACT_BYTES,
                    "description": (
                        "UTF-8 document content; the encoded payload must be at most "
                        "512 KiB."
                    ),
                },
                "file_name": {
                    "type": "string",
                    "description": (
                        "Optional name whose final suffix is an allowed inert-document "
                        "extension."
                    ),
                },
                "language": {
                    "type": "string",
                    "enum": sorted(_LANGUAGE_SCHEMA_HINTS),
                },
                "extension": {
                    "type": "string",
                    "enum": sorted(SAFE_PLAN_ARTIFACT_EXTENSIONS),
                },
            },
            "required": ["artifact_kind", "title", "content"],
            "additionalProperties": False,
        }
        description = (
            "Create one inert, session-scoped Plan Mode document under .jenny/artifacts. "
            "Only Markdown, plain text, Mermaid, JSON, YAML, and CSV classifiers are allowed."
        )
    return {
        "name": str(getattr(descriptor, "name", "") or ""),
        "description": description,
        "parameters": parameters,
        "side_effecting": bool(getattr(descriptor, "side_effecting", False)),
    }


__all__ = (
    "MAX_PLAN_ARTIFACT_BYTES",
    "PLAN_ARTIFACT_WRITE_ARG",
    "SAFE_PLAN_ARTIFACT_EXTENSIONS",
    "descriptor_allows_plan_artifact_write",
    "is_plan_artifact_write_eligible",
    "is_safe_plan_document",
    "plan_artifact_mode_exemption",
    "prompt_schema_for_context",
    "strip_plan_artifact_write_arg",
)
