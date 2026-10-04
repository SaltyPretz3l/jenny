"""Shared trust-boundary limits for provider-emitted tool calls."""

from __future__ import annotations

import json
import re
from typing import Any

MAX_PROVIDER_TOOL_CALLS = 128
MAX_PROVIDER_TOOL_CALL_ID_CHARS = 128
MAX_TOOL_CALL_ARGUMENT_BYTES = 64 * 1024
MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES = 256 * 1024
# Dogfood MQ-033: builtins whose arguments are only paths and flags never need more
# than a few KiB; a call past this is a runaway generation, not real input.
# Explicit allowlist of verified builtin ids: plugin, MCP and unknown tools,
# and every tool that carries content, commands, patterns or patches, keep the
# generic per-call cap. move_file is not here: it takes a batch of up to 100
# source/destination pairs.
PATH_ONLY_TOOL_ARGUMENT_BYTES = 8 * 1024
PATH_ONLY_TOOL_NAMES = frozenset(
    {
        "check_background_job",
        "delete_file",
        "glob_files",
        "list_dir",
        "read_file",
        "stop_background_job",
    }
)

_SAFE_TOOL_CALL_ID_RE = re.compile(
    rf"^[A-Za-z0-9][A-Za-z0-9_.-]{{0,{MAX_PROVIDER_TOOL_CALL_ID_CHARS - 1}}}$"
)


def safe_unique_tool_call_id(
    provider_id: Any,
    *,
    ordinal: int,
    used_ids: set[str],
) -> str:
    """Return one deterministic, bounded, ASCII-safe id for a generation."""

    raw_id = provider_id.strip() if isinstance(provider_id, str) else ""
    if raw_id and _SAFE_TOOL_CALL_ID_RE.fullmatch(raw_id) and raw_id not in used_ids:
        used_ids.add(raw_id)
        return raw_id

    base = f"call_{max(int(ordinal), 1)}"
    candidate = base
    suffix = 2
    while candidate in used_ids:
        candidate = f"{base}_{suffix}"
        suffix += 1
    used_ids.add(candidate)
    return candidate


def tool_call_id_diagnostic_label(provider_id: Any) -> str:
    """Return an ASCII-safe bounded label without echoing hostile ids."""

    raw_id = provider_id.strip() if isinstance(provider_id, str) else ""
    if len(raw_id) > MAX_PROVIDER_TOOL_CALL_ID_CHARS:
        return "[oversized]"
    if raw_id and not _SAFE_TOOL_CALL_ID_RE.fullmatch(raw_id):
        return "[invalid]"
    return raw_id


def tool_argument_byte_cap(tool_name: Any) -> int:
    """The per-call argument byte cap for one tool name."""

    if isinstance(tool_name, str) and tool_name in PATH_ONLY_TOOL_NAMES:
        return PATH_ONLY_TOOL_ARGUMENT_BYTES
    return MAX_TOOL_CALL_ARGUMENT_BYTES


def serialized_tool_arguments(arguments: Any) -> bytes:
    """Serialize provider arguments deterministically for byte-budget checks."""

    return json.dumps(
        arguments,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")


__all__ = [
    "MAX_PROVIDER_TOOL_CALLS",
    "MAX_PROVIDER_TOOL_CALL_ID_CHARS",
    "MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES",
    "MAX_TOOL_CALL_ARGUMENT_BYTES",
    "PATH_ONLY_TOOL_ARGUMENT_BYTES",
    "PATH_ONLY_TOOL_NAMES",
    "safe_unique_tool_call_id",
    "serialized_tool_arguments",
    "tool_argument_byte_cap",
    "tool_call_id_diagnostic_label",
]
