"""Shared leaf for the workspace context builder: dataclasses, constants, and module helpers."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, cast

from sidecar.ai.context.runtime_message_markers import (
    CONTEXT_PRESSURE_ADVISORY_HEADING,
    MEMORY_RECALL_HEADING,
    RUNTIME_SYSTEM_MESSAGE_HEADINGS,
)
from sidecar.ai.error_codes import CMP_CTX_SKILL_INVALID
from sidecar.ai.tools import argument_coercion as _argument_coercion
from sidecar.ai.tools import contracts as _tool_contracts
from sidecar.ai.tools import schema_examples as _schema_examples
from sidecar.ai.tools import tool_families as _tool_families

parse_bool = _argument_coercion.parse_bool
ToolExecutionFailure = _tool_contracts.ToolExecutionFailure
format_tool_arguments_example = _schema_examples.format_tool_arguments_example
format_tool_call_example = _schema_examples.format_tool_call_example
requested_tool_families = _tool_families.requested_tool_families
status_matches_tool_family = _tool_families.status_matches_tool_family

BOOTSTRAP_DIRNAME = "BOOTSTRAP"
BOOTSTRAP_FILES = ("IDENTITY.md", "SOUL.md", "USER.md")
WORKSPACE_INSTRUCTION_FILENAME = "agentj.md"
MAX_WORKSPACE_INSTRUCTION_BYTES = 8192
MAX_WORKSPACE_CONTEXT_PROMPT_BYTES = 96 * 1024
MAX_BOOTSTRAP_FILE_BYTES = 24 * 1024
MAX_BOOTSTRAP_PROMPT_BYTES = 48 * 1024
# A loaded skill must fit the canonical 16,000-character tool-result envelope
# with room for a bounded truncation marker and multibyte normalization.
MAX_SKILL_FILE_BYTES = 15 * 1024
MAX_SKILL_FRONTMATTER_BYTES = 16 * 1024
MAX_SKILL_FRONTMATTER_TOKENS = 256
MAX_SKILL_PROMPT_BYTES = 64 * 1024
MAX_SKILL_FILES = 128
MAX_SKILL_DISCOVERY_ENTRIES = 2_048
MAX_SKILL_DEPTH = 8
MAX_SKILL_DISCOVERY_SECONDS = 0.5
SKILL_CACHE_TTL_SECONDS = 1.0
LOGGER = logging.getLogger("sidecar.ai.context.builder")
TOOL_NAME_ALIASES = {
    "bash": "run_command",
    "glob": "glob_files",
    "grep": "grep_search",
}
_CURRENT_INFO_REQUEST_RE = re.compile(
    r"\b("
    r"weather|temperature|forecast|current conditions|humidity|rain|snow|"
    r"breaking news|latest news|headlines|live score|stock price|share price|"
    r"exchange rate|traffic|flight status"
    r")\b",
    re.IGNORECASE,
)
_CURRENT_INFO_TOPIC_RE = re.compile(
    r"\b("
    r"news|headline|headlines|score|scores|stock|stocks|share|shares|"
    r"price|prices|traffic|flight"
    r")\b",
    re.IGNORECASE,
)
_CURRENT_INFO_TEMPORAL_RE = re.compile(
    r"\b("
    r"current|currently|latest|recent|today|tonight|tomorrow|live|"
    r"breaking|right now|now"
    r")\b",
    re.IGNORECASE,
)
_SOURCE_ARCHITECTURE_REQUEST_RE = re.compile(
    r"\b("
    r"repo|repository|source|source[- ]?code|codebase|architecture|"
    r"module|modules|file|files|trace|streaming|reducer|pipeline|"
    r"implementation|call chain|data flow"
    r")\b",
    re.IGNORECASE,
)
_FILESYSTEM_TOOL_NAMES = frozenset({"read_file", "grep_search", "glob_files", "list_dir"})


def _sanitize_bootstrap_content(content: str, *, source_name: str) -> str:
    sanitization = cast(Any, import_module("sidecar.ai.personality.sanitization"))
    return str(sanitization.sanitize_bootstrap(content, source_name=source_name))


@dataclass(frozen=True)
class SkillEntry:
    scope: str
    name: str
    description: str
    command: str
    when_to_use: str
    allowed_tools: tuple[str, ...]
    always: bool
    body: str
    rel_path: str


@dataclass(frozen=True)
class SkillScope:
    scope: str
    root: Path
    enabled: bool = True


@dataclass(frozen=True)
class WorkspaceStatus:
    root: str | None
    exists: bool
    skills_loaded: int
    bootstrap_loaded: int
    instruction_file_name: str | None = None
    instruction_file_present: bool = False


@dataclass(frozen=True)
class LearnedLesson:
    title: str
    lesson_text: str
    confidence: float
    lesson_kind: str


@dataclass(frozen=True)
class RecalledMemory:
    title: str
    lesson_text: str
    confidence: float
    lesson_kind: str
    source_excerpt: str = ""


@dataclass(frozen=True)
class RuntimeToolStatus:
    name: str
    display_name: str
    available: bool
    reason: str | None = None
    description: str = ""
    source_kind: str | None = None
    tool_family: str | None = None
    server_name: str | None = None
    input_schema: dict[str, Any] | None = None
    applicable: bool = True
    unmet_preconditions: tuple[str, ...] = ()



def _split_frontmatter(content: str) -> tuple[str, str]:
    if not content.startswith("---\n"):
        return "", content
    closing = content.find("\n---\n", 4)
    if closing == -1:
        return "", content
    frontmatter = content[4:closing]
    body = content[closing + 5 :]
    return frontmatter, body


def _normalize_tool_list(value: Any) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(
            normalized for item in value if (normalized := normalize_tool_name(item)) is not None
        )
    if isinstance(value, str) and value.strip():
        normalized = normalize_tool_name(value)
        return (normalized,) if normalized is not None else ()
    return ()


def normalize_tool_name(value: Any) -> str | None:
    if not isinstance(value, (str, int, float)):
        return None
    token = str(value).strip()
    if not token:
        return None
    lowered = token.lower()
    return TOOL_NAME_ALIASES.get(lowered, token)


def looks_like_current_info_request(value: str) -> bool:
    text = str(value or "")
    if not text:
        return False
    if _CURRENT_INFO_REQUEST_RE.search(text):
        return True
    return bool(_CURRENT_INFO_TOPIC_RE.search(text) and _CURRENT_INFO_TEMPORAL_RE.search(text))


def looks_like_source_architecture_request(value: str) -> bool:
    text = str(value or "")
    if not text:
        return False
    return bool(_SOURCE_ARCHITECTURE_REQUEST_RE.search(text))


def _extract_frontmatter(  # noqa: C901, PLR0912
    frontmatter: str,
    *,
    skill_path: Path,
) -> tuple[str, str, str, str, tuple[str, ...], bool]:
    name = "Unnamed Skill"
    description = ""
    command = skill_path.parent.name.strip().lower().replace("_", "-")
    if re.fullmatch(r"[a-z][a-z0-9-]{0,31}", command) is None:
        command = ""
    when_to_use = ""
    allowed_tools: tuple[str, ...] = ()
    always = False

    if not frontmatter.strip():
        return name, description, command, when_to_use, allowed_tools, always

    # PyYAML costs ~90ms to import and this module is pulled into the
    # builtin-tools subprocess graph the sidecar blocks on during `initialize`.
    # Only skills with frontmatter need it, so it is resolved on first use.
    from yaml import YAMLError, safe_load, scan  # type: ignore[import-untyped] # noqa: PLC0415
    from yaml.tokens import AliasToken, AnchorToken  # type: ignore[import-untyped] # noqa: PLC0415

    try:
        if len(frontmatter.encode("utf-8", errors="replace")) > MAX_SKILL_FRONTMATTER_BYTES:
            raise ToolExecutionFailure(
                code=CMP_CTX_SKILL_INVALID,
                message=f"skill frontmatter exceeds byte budget in '{skill_path}'",
                retryable=False,
            )
        tokens = list(scan(frontmatter))
        if len(tokens) > MAX_SKILL_FRONTMATTER_TOKENS:
            raise ToolExecutionFailure(
                code=CMP_CTX_SKILL_INVALID,
                message=f"skill frontmatter exceeds structure budget in '{skill_path}'",
                retryable=False,
            )
        if any(isinstance(token, (AliasToken, AnchorToken)) for token in tokens):
            raise ToolExecutionFailure(
                code=CMP_CTX_SKILL_INVALID,
                message=f"skill frontmatter aliases are not allowed in '{skill_path}'",
                retryable=False,
            )
        payload = safe_load(frontmatter) or {}
    except YAMLError as error:
        raise ToolExecutionFailure(
            code=CMP_CTX_SKILL_INVALID,
            message=f"invalid YAML frontmatter in '{skill_path}': {error}",
            retryable=False,
        ) from error
    if not isinstance(payload, dict):
        raise ToolExecutionFailure(
            code=CMP_CTX_SKILL_INVALID,
            message=f"invalid YAML frontmatter in '{skill_path}': expected an object",
            retryable=False,
        )

    raw_name = payload.get("name")
    if isinstance(raw_name, str) and raw_name.strip():
        name = raw_name.strip()

    raw_description = payload.get("description")
    if isinstance(raw_description, str):
        description = raw_description.strip()

    raw_command = payload.get("command")
    if isinstance(raw_command, str):
        explicit_command = raw_command.strip().lower()
        if re.fullmatch(r"[a-z][a-z0-9-]{0,31}", explicit_command) is not None:
            command = explicit_command

    raw_when_to_use = (
        payload.get("whenToUse") or payload.get("when_to_use") or payload.get("when-to-use")
    )
    if isinstance(raw_when_to_use, str):
        when_to_use = raw_when_to_use.strip()

    allowed_tools = _normalize_tool_list(
        payload.get("allowedTools") or payload.get("allowed_tools") or payload.get("allowed-tools")
    )

    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        # "nanobot" is a compatibility alias for third-party skill packs.
        always_metadata = metadata.get("jenny", metadata.get("nanobot"))
        if isinstance(always_metadata, dict):
            always = parse_bool(always_metadata.get("always"))
    return name, description, command, when_to_use, allowed_tools, always


def _skill_dedupe_key(skill_path: Path) -> tuple[Any, ...]:
    try:
        stats = skill_path.stat()
    except OSError:
        return ("path", skill_path.resolve())
    inode = getattr(stats, "st_ino", 0)
    device = getattr(stats, "st_dev", 0)
    if inode:
        return ("inode", device, inode)
    try:
        return ("path", skill_path.resolve())
    except OSError:
        return ("path", skill_path)
