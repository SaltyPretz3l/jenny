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
_PLAN_EDITS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "minItems": 1,
    "maxItems": 20,
    "description": "Exact search-and-replace pairs applied in order; all or nothing.",
    "items": {
        "type": "object",
        "properties": {
            "old_string": {"type": "string", "minLength": 1},
            "new_string": {"type": "string"},
        },
        "required": ["old_string", "new_string"],
        "additionalProperties": False,
    },
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


def _utf8_size(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError:
        return None


def _payload_is_bounded(arguments: dict[Any, Any]) -> bool:
    """Full ``content``, or (revisions only) well-formed ``edits``, within the cap.

    The handler re-checks the revised file against the same 512 KiB limit."""

    if "edits" not in arguments:
        size = _utf8_size(arguments.get("content"))
        return size is not None and size <= MAX_PLAN_ARTIFACT_BYTES
    edits = arguments.get("edits")
    if "content" in arguments or "replaces" not in arguments:
        return False
    if not isinstance(edits, list) or not edits:
        return False
    total = 0
    for item in edits:
        if not isinstance(item, dict):
            return False
        old_size = _utf8_size(item.get("old_string"))
        new_size = _utf8_size(item.get("new_string"))
        if old_size is None or new_size is None:
            return False
        total += new_size
    return total <= MAX_PLAN_ARTIFACT_BYTES


def _replaces_extension(arguments: dict[Any, Any]) -> str | None:
    """A revision is classified by the replaced file's own suffix, which must be inert."""

    if "replaces" not in arguments:
        return ""
    suffix = _filename_extension(arguments.get("replaces"))
    return suffix or None


def is_safe_plan_document(
    arguments: object,
) -> bool:
    """Return whether a create_artifact call is inert and internally consistent."""

    if not isinstance(arguments, dict):
        return False
    if str(arguments.get("artifact_kind") or "").strip().lower() != "document":
        return False
    title = arguments.get("title")
    if not isinstance(title, str) or not title.strip() or not _payload_is_bounded(arguments):
        return False

    language = _normalized_language(arguments.get("language", ""))
    extension = _normalized_extension(arguments.get("extension", ""))
    filename_extension = _filename_extension(arguments.get("file_name", ""))
    replaces_extension = _replaces_extension(arguments)
    if (
        language is None
        or extension is None
        or filename_extension is None
        or replaces_extension is None
    ):
        return False

    classifiers = {
        classifier
        for classifier in (
            language or None,
            _EXTENSION_FAMILIES.get(extension) if extension else None,
            _EXTENSION_FAMILIES.get(filename_extension) if filename_extension else None,
            _EXTENSION_FAMILIES.get(replaces_extension) if replaces_extension else None,
        )
        if classifier
    }
    if len(classifiers) > 1:
        return False

    resolved_extension = (
        replaces_extension
        or extension
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
    # The todo list is in-memory session state, never a workspace write.
    if normalized_name == "todo_write":
        return True
    # Plan Mode may add a memory; correcting or forgetting one waits for the build.
    if normalized_name == "memory":
        return isinstance(arguments, dict) and arguments.get("action") == "remember"
    return normalized_name == "create_artifact" and is_safe_plan_document(arguments)


# Arguments a model should never fill (row 129): old spellings the argument check still
# accepts, and the read snapshot the runtime attaches itself. They stay in the descriptor
# schema, so a call that sends one is still valid; only the model-facing copy drops them.
MODEL_HIDDEN_ARGUMENTS: dict[str, frozenset[str]] = {
    "write_file": frozenset({"file_path", "file_content", "expected_read_snapshot"}),
    "edit_file": frozenset({"expected_read_snapshot"}),
}


def hide_runtime_arguments(name: str, parameters: dict[str, Any]) -> dict[str, Any]:
    """Drop *name*'s hidden arguments from an already-copied schema."""

    hidden = MODEL_HIDDEN_ARGUMENTS.get(name)
    properties = parameters.get("properties")
    if not hidden or not isinstance(properties, dict):
        return parameters
    parameters["properties"] = {
        key: value for key, value in properties.items() if key not in hidden
    }
    required = [key for key in parameters.get("required") or [] if key not in hidden]
    branches = parameters.get("anyOf")
    if isinstance(branches, list):
        kept = [
            branch
            for branch in branches
            if not (isinstance(branch, dict) and hidden.intersection(branch.get("required") or []))
        ]
        if len(kept) == 1 and isinstance(kept[0], dict) and set(kept[0]) == {"required"}:
            # One way left to satisfy the call: say it as plain required arguments.
            required += [key for key in kept[0]["required"] if key not in required]
            del parameters["anyOf"]
        elif kept:
            parameters["anyOf"] = kept
        else:
            del parameters["anyOf"]
    if required or "required" in parameters:
        parameters["required"] = required
    return parameters


def model_facing_parameters(descriptor: Any) -> dict[str, Any]:
    """A copy of the descriptor's schema without the arguments the model is not shown."""

    parameters = deepcopy(getattr(descriptor, "input_schema", None) or {})
    return hide_runtime_arguments(str(getattr(descriptor, "name", "") or ""), parameters)


def prompt_schema_for_context(
    descriptor: Any,
    *,
    plan_mode: bool,
    read_only: bool,
) -> dict[str, Any]:
    """Return the model-facing schema, narrowed before token-budget filtering."""

    parameters = model_facing_parameters(descriptor)
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
                        "512 KiB. Required unless revising with replaces and edits."
                    ),
                },
                "replaces": {
                    "type": "string",
                    "description": (
                        "Path of an inert document you created this session, to revise "
                        "it in place."
                    ),
                },
                "edits": deepcopy(_PLAN_EDITS_SCHEMA),
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
            "required": ["artifact_kind", "title"],
            "additionalProperties": False,
        }
        description = (
            "Create one inert, session-scoped Plan Mode document under .jenny/artifacts. "
            "Only Markdown, plain text, Mermaid, JSON, YAML, and CSV classifiers are allowed. "
            "To revise a document you created, pass replaces=<its path> and edits "
            "(or full content)."
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
    "hide_runtime_arguments",
    "is_plan_artifact_write_eligible",
    "is_safe_plan_document",
    "model_facing_parameters",
    "plan_artifact_mode_exemption",
    "prompt_schema_for_context",
    "strip_plan_artifact_write_arg",
)
