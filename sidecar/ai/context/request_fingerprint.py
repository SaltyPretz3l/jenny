"""Provider-neutral request and tool fingerprint diagnostics.

Computes stable SHA-256 projections of the cacheable system-prompt prefix
and the model-bound tool schema set. The output is purely diagnostic and
surfaces through ``harness.inspect -> runtime.latest_turn_diagnostics``.
No persistence, no protocol additions, no behavior changes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from sidecar.ai.context.cache_detection import stable_hash
from sidecar.ai.context.prompt_cache import StructuredSystemPrompt

_HASH_PREFIX_LEN = 16
PROMPT_VERSION = "jenny-prompt-v4-2026-08-21"


@dataclass(frozen=True)
class RequestFingerprint:
    prompt_version: str
    prefix_hash: str
    tool_schema_hash: str
    per_tool_schema_hashes: dict[str, str]
    prefix_section_count: int
    tool_schema_count: int
    generated_at: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _cacheable_prefix_sections(system_prompt: StructuredSystemPrompt) -> list[Any]:
    sections: list[Any] = []
    for section in system_prompt.sections:
        if not section.content:
            continue
        if not section.cacheable:
            break
        sections.append(section)
    return sections


def _normalize_prefix(system_prompt: Any) -> Any:
    if isinstance(system_prompt, StructuredSystemPrompt):
        return {
            "session_start_date": system_prompt.session_start_date,
            "current_date": system_prompt.current_date,
            "sections": [
                {
                    "name": section.name,
                    "content": section.content,
                    "cacheable": section.cacheable,
                }
                for section in _cacheable_prefix_sections(system_prompt)
            ],
        }
    if system_prompt is None:
        return ""
    return str(system_prompt)


def _prefix_section_count(system_prompt: Any) -> int:
    if isinstance(system_prompt, StructuredSystemPrompt):
        return len(_cacheable_prefix_sections(system_prompt))
    if system_prompt is None:
        return 0
    return 1 if str(system_prompt) else 0


def _now_iso_z() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _schema_name(schema: Mapping[str, Any]) -> str:
    return str(schema.get("name") or "").strip()


def tool_schema_capability_hash(
    schemas: Sequence[Mapping[str, Any]] | None,
) -> str:
    """Return the stable short hash for the model-visible tool schema set."""
    normalized_schemas = sorted(
        (dict(schema) for schema in (schemas or []) if isinstance(schema, Mapping)),
        key=_schema_name,
    )
    return stable_hash(normalized_schemas)[:_HASH_PREFIX_LEN]


def compute_request_fingerprint(
    *,
    system_prompt: Any,
    tool_schemas: Sequence[Mapping[str, Any]] | None,
    prompt_version: str = PROMPT_VERSION,
) -> RequestFingerprint:
    schemas: list[Mapping[str, Any]] = [
        schema for schema in (tool_schemas or []) if isinstance(schema, Mapping)
    ]
    sorted_schemas = sorted(schemas, key=_schema_name)
    per_tool: dict[str, str] = {}
    for schema in sorted_schemas:
        name = _schema_name(schema)
        if not name:
            continue
        per_tool[name] = stable_hash(dict(schema))[:_HASH_PREFIX_LEN]
    return RequestFingerprint(
        prompt_version=str(prompt_version or PROMPT_VERSION).strip() or PROMPT_VERSION,
        prefix_hash=stable_hash(_normalize_prefix(system_prompt))[:_HASH_PREFIX_LEN],
        tool_schema_hash=tool_schema_capability_hash(sorted_schemas),
        per_tool_schema_hashes=per_tool,
        prefix_section_count=_prefix_section_count(system_prompt),
        tool_schema_count=len(schemas),
        generated_at=_now_iso_z(),
    )
