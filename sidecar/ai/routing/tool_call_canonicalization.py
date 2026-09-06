"""Tool-call normalization shared before dispatch emits."""

from __future__ import annotations

import json
from dataclasses import replace

from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL
from sidecar.ai.routing.provider_tool_limits import (
    MAX_PROVIDER_TOOL_CALLS,
    MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES,
    MAX_TOOL_CALL_ARGUMENT_BYTES,
    safe_unique_tool_call_id,
    serialized_tool_arguments,
    tool_call_id_diagnostic_label,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, canonicalize_tool_arguments
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.plan_artifact_policy import strip_plan_artifact_write_arg

MODEL_TOOL_ID_ALIASES: dict[str, str] = {
    "list_files": "list_dir",
    "mermaid_gen": "mermaid_generate",
    "web:web_search": "web_search",
    "web:fetch_url": "fetch_url",
}
COALESCIBLE_TOOL_IDS = frozenset({"mermaid_generate"})


def _canonical_tool_call_key(call: ToolCallRequest) -> tuple[str, str]:
    return (
        str(call.tool_id or "").strip(),
        json.dumps(call.arguments, sort_keys=True, separators=(",", ":"), default=str),
    )


def _strip_self_prefixed_tool_id(raw_tool_id: str) -> str:
    left, separator, right = raw_tool_id.partition(":")
    normalized_left = left.strip().lower()
    normalized_right = right.strip().lower()
    if separator and normalized_left and normalized_right and normalized_left == normalized_right:
        return right.strip()
    return raw_tool_id


def canonicalize_tool_calls(
    tool_calls: tuple[ToolCallRequest, ...],
    *,
    used_call_ids: set[str] | None = None,
) -> tuple[tuple[ToolCallRequest, ...], list[dict[str, str]], int]:
    """Return canonicalized calls, alias records, and coalesced duplicate count.

    ``used_call_ids`` is the caller-owned de-collision namespace. Callers that
    span more than one generation (the tool loop, which reuses a TURN-scoped
    set) pass their own set so an id-less provider cannot mint the same
    synthetic id on two consecutive iterations. Omitting it keeps the legacy
    per-batch behavior for single-generation callers and tests.
    """

    canonical_calls: list[ToolCallRequest] = []
    aliases: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    used_call_ids = used_call_ids if used_call_ids is not None else set()
    coalesced_count = 0
    raw_count_exceeded = len(tool_calls) > MAX_PROVIDER_TOOL_CALLS
    bounded_calls = tool_calls[: MAX_PROVIDER_TOOL_CALLS + 1]
    for ordinal, call in enumerate(bounded_calls, start=1):
        raw_call_id = str(call.call_id or "").strip()
        canonical_call_id = safe_unique_tool_call_id(
            raw_call_id,
            ordinal=ordinal,
            used_ids=used_call_ids,
        )
        raw_tool_id = str(call.tool_id or "").strip()
        normalized_tool_id = _strip_self_prefixed_tool_id(raw_tool_id)
        canonical_tool_id = MODEL_TOOL_ID_ALIASES.get(normalized_tool_id, normalized_tool_id)
        canonical_call = call
        sanitized_arguments = strip_plan_artifact_write_arg(call.arguments)
        if sanitized_arguments != call.arguments:
            canonical_call = replace(canonical_call, arguments=sanitized_arguments)
        if canonical_call_id != raw_call_id:
            # Synthesizing an id keeps blank/duplicate/id-less calls distinct
            # (H17) but is pure bookkeeping: arguments and target are untouched,
            # so it must NOT mark the call coerced — that rule rejects every
            # side-effecting call from providers that omit call ids.
            canonical_call = replace(
                canonical_call,
                call_id=canonical_call_id,
            )
            aliases.append(
                {
                    "call_id": canonical_call_id,
                    "field": "call_id",
                    "from": tool_call_id_diagnostic_label(raw_call_id),
                    "to": canonical_call_id,
                }
            )
        if canonical_tool_id != raw_tool_id:
            canonical_call = replace(
                canonical_call,
                tool_id=canonical_tool_id,
                coerced=True,
            )
            aliases.append(
                {
                    "call_id": canonical_call_id,
                    "from": raw_tool_id,
                    "to": canonical_tool_id,
                }
            )
        if canonical_tool_id in COALESCIBLE_TOOL_IDS:
            key = _canonical_tool_call_key(canonical_call)
            if not raw_count_exceeded and key in seen:
                coalesced_count += 1
                continue
            seen.add(key)
        canonical_calls.append(canonical_call)
    return tuple(canonical_calls), aliases, coalesced_count


def validate_provider_tool_call_limits(
    tool_calls: tuple[ToolCallRequest, ...],
) -> tuple[
    tuple[ToolCallRequest, ...],
    tuple[tuple[ToolCallRequest, ToolExecutionFailure], ...],
]:
    """Reject over-count and over-byte provider calls before policy or approval."""

    accepted: list[ToolCallRequest] = []
    rejected: list[tuple[ToolCallRequest, ToolExecutionFailure]] = []
    aggregate_bytes = 0
    for ordinal, call in enumerate(tool_calls, start=1):
        if ordinal > MAX_PROVIDER_TOOL_CALLS:
            reason = f"provider tool-call batch exceeds {MAX_PROVIDER_TOOL_CALLS} calls"
        else:
            argument_bytes = len(serialized_tool_arguments(call.arguments))
            if argument_bytes > MAX_TOOL_CALL_ARGUMENT_BYTES:
                reason = (
                    "provider tool-call arguments exceed the "
                    f"{MAX_TOOL_CALL_ARGUMENT_BYTES}-byte per-call limit"
                )
            elif aggregate_bytes + argument_bytes > MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES:
                reason = (
                    "provider tool-call arguments exceed the "
                    f"{MAX_TOOL_CALL_AGGREGATE_ARGUMENT_BYTES}-byte aggregate limit"
                )
            else:
                aggregate_bytes += argument_bytes
                accepted.append(call)
                continue
        rejected.append(
            (
                call,
                ToolExecutionFailure(
                    code=CMP_LOOP_INVALID_TOOL_CALL,
                    message=reason,
                    retryable=False,
                ),
            )
        )
        if ordinal > MAX_PROVIDER_TOOL_CALLS:
            break
    return tuple(accepted), tuple(rejected)


def canonicalize_tool_call_arguments(
    tool_calls: tuple[ToolCallRequest, ...],
) -> tuple[
    tuple[ToolCallRequest, ...],
    list[dict[str, str]],
    tuple[tuple[ToolCallRequest, ToolExecutionFailure], ...],
]:
    """Canonicalize per-tool argument aliases and isolate conflicting calls."""

    canonical_calls: list[ToolCallRequest] = []
    aliases: list[dict[str, str]] = []
    conflicts: list[tuple[ToolCallRequest, ToolExecutionFailure]] = []
    for call in tool_calls:
        if not isinstance(call.arguments, dict):
            canonical_calls.append(call)
            continue
        try:
            arguments, call_aliases = canonicalize_tool_arguments(
                tool_name=str(call.tool_id or "").strip(),
                arguments=strip_plan_artifact_write_arg(call.arguments),
            )
        except ToolExecutionFailure as error:
            conflicts.append((call, error))
            continue
        canonical_call = call
        if arguments != call.arguments:
            canonical_call = replace(call, arguments=arguments)
        canonical_calls.append(canonical_call)
        call_id = str(call.call_id or "").strip()
        aliases.extend({"call_id": call_id, **alias} for alias in call_aliases)
    return tuple(canonical_calls), aliases, tuple(conflicts)


def repair_web_search_query_arguments(
    tool_calls: tuple[ToolCallRequest, ...],
    *,
    latest_user_content: str,
) -> tuple[tuple[ToolCallRequest, ...], list[dict[str, str]]]:
    """Repair empty `web_search` query arguments from the triggering prompt.

    Some local tool-call parsers can emit the correct read-only tool name but
    drop its argument object. For `web_search`, the user's latest request is
    already the intended search query, so repair that narrow shape before
    schema validation rejects it.
    """

    fallback_query = str(latest_user_content or "").strip()
    if not fallback_query:
        return tool_calls, []

    repaired_calls: list[ToolCallRequest] = []
    repairs: list[dict[str, str]] = []
    for call in tool_calls:
        if str(call.tool_id or "").strip() != "web_search":
            repaired_calls.append(call)
            continue
        arguments = dict(call.arguments or {})
        existing_query = arguments.get("query")
        if isinstance(existing_query, str) and existing_query.strip():
            repaired_calls.append(call)
            continue
        arguments["query"] = fallback_query
        repaired_calls.append(replace(call, arguments=arguments))
        repairs.append(
            {
                "call_id": str(call.call_id or "").strip(),
                "tool": "web_search",
                "field": "query",
            }
        )
    return tuple(repaired_calls), repairs


__all__ = [
    "canonicalize_tool_call_arguments",
    "canonicalize_tool_calls",
    "repair_web_search_query_arguments",
    "validate_provider_tool_call_limits",
]
