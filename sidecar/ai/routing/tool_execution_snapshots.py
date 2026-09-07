"""Read-snapshot caching, mutation-path resolution, and frozen execution inputs.

Must not import ``tool_execution`` because the hub imports this module.
"""

from __future__ import annotations

import posixpath
from pathlib import Path
from typing import Any

from sidecar.ai.tools.contracts import canonicalize_tool_arguments
from sidecar.ai.tools.plan_artifact_policy import (
    PLAN_ARTIFACT_WRITE_ARG,
    is_plan_artifact_write_eligible,
)
from sidecar.runtime.approval_plan import (
    SIDECAR_INJECTED_ARG_KEYS,
    FrozenExecutionInputs,
    stable_hash,
)
from sidecar.runtime.tool_execution_support import (
    READ_SNAPSHOT_SCOPE_FULL,
    ToolCallRequest,
    read_snapshot_from_metadata,
)


def normalize_snapshot_lookup_path(kernel: Any, raw_path: object) -> str | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    candidate_text = raw_path.strip()
    candidate_path = Path(candidate_text)
    if candidate_path.is_absolute():
        try:
            normalized_candidate = candidate_path.resolve(strict=False)
        except OSError:
            normalized_candidate = candidate_path
        root_text = str(kernel._config.tools_workspace_root or "").strip()
        if root_text:
            try:
                root_path = Path(root_text).resolve(strict=False)
                return normalized_candidate.relative_to(root_path).as_posix()
            except (OSError, ValueError):
                return normalized_candidate.as_posix()
        return normalized_candidate.as_posix()
    normalized = posixpath.normpath(candidate_text.replace("\\", "/"))
    return normalized if normalized != "." else candidate_text.replace("\\", "/")


# ---------------------------------------------------------------------------
# update_read_snapshot_cache
# ---------------------------------------------------------------------------


def update_read_snapshot_cache(
    kernel: Any,
    cache: dict[str, dict[str, object]],
    *,
    tool_name: str,
    success: bool,
    metadata: dict[str, object],
) -> None:
    if not metadata:
        return
    if tool_name == "read_file":
        if success:
            _update_read_file_snapshot(kernel, cache, metadata)
        return
    if tool_name not in {"write_file", "edit_file", "delete_file", "move_file"}:
        return
    for raw_path in _successful_mutation_paths(tool_name, success, metadata):
        normalized_path = normalize_snapshot_lookup_path(kernel, raw_path)
        if normalized_path is not None:
            cache.pop(normalized_path, None)


def _successful_mutation_paths(
    tool_name: str,
    success: bool,
    metadata: dict[str, object],
) -> set[str]:
    if tool_name != "move_file":
        raw_path = metadata.get("path")
        return {raw_path} if success and isinstance(raw_path, str) else set()
    paths: set[str] = set()
    moves = metadata.get("moves")
    if not isinstance(moves, list):
        return paths
    for move in moves:
        if not isinstance(move, dict) or move.get("status") != "moved":
            continue
        for key in ("source", "destination"):
            path = move.get(key)
            if isinstance(path, str):
                paths.add(path)
    return paths


def _update_read_file_snapshot(
    kernel: Any,
    cache: dict[str, dict[str, object]],
    metadata: dict[str, object],
) -> None:
    snapshot = read_snapshot_from_metadata(metadata.get("read_snapshot"))
    if snapshot is None:
        return
    normalized_path = normalize_snapshot_lookup_path(kernel, snapshot.path)
    if normalized_path is None:
        return
    if snapshot.scope == READ_SNAPSHOT_SCOPE_FULL:
        cache[normalized_path] = snapshot.to_metadata()
        return
    current_full = read_snapshot_from_metadata(cache.get(normalized_path))
    if current_full is not None and (
        current_full.size_bytes != snapshot.size_bytes
        or current_full.mtime_ns != snapshot.mtime_ns
    ):
        cache.pop(normalized_path, None)


# ---------------------------------------------------------------------------
# rebuild_read_snapshot_cache
# ---------------------------------------------------------------------------


def rebuild_read_snapshot_cache(
    kernel: Any,
    canonical_session_messages: list[dict[str, object]] | None,
) -> dict[str, dict[str, object]]:
    cache: dict[str, dict[str, object]] = {}
    for message in canonical_session_messages or []:
        if not isinstance(message, dict):
            continue
        tool_result = message.get("tool_result")
        if not isinstance(tool_result, dict):
            continue
        tool_name = str(tool_result.get("tool_name") or "").strip()
        metadata = tool_result.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        update_read_snapshot_cache(
            kernel,
            cache,
            tool_name=tool_name,
            success=tool_result.get("is_error") is not True,
            metadata=metadata,
        )
    return cache


# ---------------------------------------------------------------------------
# inject_expected_read_snapshot
# ---------------------------------------------------------------------------


# Path-argument aliases each mutation tool accepts, in priority order. These MUST
# mirror the tool bodies so the injector and the tools cannot drift: write_file remaps
# file_path -> path (filesystem.py:write_file_tool), so a model may legitimately call it
# with either key; edit_file only ever reads file_path. Resolving the lookup path
# through the same aliases is what lets a write_file(file_path=...) call still get its
# read snapshot auto-injected instead of failing the read-before-write gate.
_MUTATION_PATH_ARG_KEYS: dict[str, tuple[str, ...]] = {
    "write_file": ("path",),
    "edit_file": ("file_path",),
}


def effective_mutation_path_arg(tool_name: str, tool_arguments: dict[str, Any]) -> object:
    """Return the first non-empty path argument a mutation tool would actually use."""
    for key in _MUTATION_PATH_ARG_KEYS.get(tool_name, ()):
        value = tool_arguments.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def inject_expected_read_snapshot(
    kernel: Any,
    *,
    tool_name: str,
    tool_arguments: dict[str, Any],
    read_snapshot_cache: dict[str, dict[str, object]],
) -> dict[str, Any]:
    if tool_name not in _MUTATION_PATH_ARG_KEYS:
        return tool_arguments
    if "expected_read_snapshot" in tool_arguments:
        return tool_arguments
    raw_path = effective_mutation_path_arg(tool_name, tool_arguments)
    normalized_path = normalize_snapshot_lookup_path(kernel, raw_path)
    if normalized_path is None:
        return tool_arguments
    snapshot = read_snapshot_cache.get(normalized_path)
    if snapshot is None:
        return tool_arguments
    return {
        **tool_arguments,
        "expected_read_snapshot": dict(snapshot),
    }


def freeze_effective_execution_inputs(  # noqa: C901, PLR0913 - authoritative turn context seam
    kernel: Any,
    call: ToolCallRequest,
    *,
    session_id: str | None,
    read_snapshot_cache: dict[str, dict[str, object]],
    tool_contract: Any | None = None,
    plan_mode: bool = False,
    read_only: bool = False,
    approved_plan: dict[str, object] | None = None,
    trusted_plan_artifact_write: bool | None = None,
    turn_id: str | None = None,
) -> FrozenExecutionInputs:
    canonical_arguments, _aliases = canonicalize_tool_arguments(
        tool_name=call.tool_id,
        arguments=call.arguments,
    )
    canonical_arguments.pop("_jenny_read_only", None)
    canonical_arguments.pop("_jenny_approved_plan", None)
    canonical_arguments.pop(PLAN_ARTIFACT_WRITE_ARG, None)
    # Typed as the callee's Mapping[str, object]: mypy 2.x (CI installs the
    # newest) infers a Literal-keyed dict from the comprehension, and Mapping is
    # key-invariant.
    attribution_arguments: dict[str, object] = {
        key: canonical_arguments.pop(key)
        for key in ("_jenny_turn_id", "_jenny_tool_call_id", "_jenny_change_set_id")
        if key in canonical_arguments
    }
    for key in tuple(canonical_arguments):
        if str(key).startswith("_jenny_"):
            canonical_arguments.pop(key)
    visible_tool_arguments = {str(key): value for key, value in canonical_arguments.items()}
    effective_tool_arguments = inject_expected_read_snapshot(
        kernel,
        tool_name=call.tool_id,
        tool_arguments=dict(canonical_arguments),
        read_snapshot_cache=read_snapshot_cache,
    )
    injected_arg_keys: list[str] = []
    contract_entry_lookup = getattr(tool_contract, "entry", None)
    contract_entry = (
        contract_entry_lookup(call.tool_id) if callable(contract_entry_lookup) else None
    )
    descriptor = getattr(contract_entry, "descriptor", None)
    if descriptor is None:
        mcp_client = getattr(kernel, "_mcp_client", None)
        descriptor_lookup = getattr(mcp_client, "tool_descriptor", None)
        descriptor = descriptor_lookup(call.tool_id) if callable(descriptor_lookup) else None
    plan_artifact_write = (
        bool(trusted_plan_artifact_write)
        if trusted_plan_artifact_write is not None
        else is_plan_artifact_write_eligible(
            descriptor,
            call.tool_id,
            canonical_arguments,
            plan_mode=plan_mode,
            read_only=read_only,
        )
    )
    if plan_artifact_write:
        effective_tool_arguments[PLAN_ARTIFACT_WRITE_ARG] = True
        injected_arg_keys.append(PLAN_ARTIFACT_WRITE_ARG)
    if "expected_read_snapshot" in effective_tool_arguments and (
        "expected_read_snapshot" not in visible_tool_arguments
    ):
        injected_arg_keys.append("expected_read_snapshot")
    normalized_session_id = str(session_id or "").strip()
    from sidecar.ai.routing.mutation_change_set_lifecycle import (  # noqa: PLC0415
        inject_tool_attribution,
    )

    attribution = inject_tool_attribution(
        tool_name=call.tool_id,
        tool_call_id=str(call.call_id or "").strip(),
        session_id=normalized_session_id,
        explicit_turn_id=turn_id,
        existing=attribution_arguments,
    )
    effective_tool_arguments.update(attribution)
    injected_arg_keys.extend(attribution)
    if (
        call.tool_id
        in {
            "read_file",
            "write_file",
            "edit_file",
            "delete_file",
            "move_file",
            "run_command",
            "run_temp_script",
            "workspace_change_baseline",
            "workspace_change_delta",
            "create_artifact",
            "todo_write",
            "todo_read",
            "mermaid_generate",
        }
        and normalized_session_id
    ):
        effective_tool_arguments["_jenny_session_id"] = normalized_session_id
        if "_jenny_session_id" not in visible_tool_arguments:
            injected_arg_keys.append("_jenny_session_id")
    if call.tool_id == "mermaid_generate":
        effective_tool_arguments["_jenny_read_only"] = bool(read_only)
        injected_arg_keys.append("_jenny_read_only")
    if call.tool_id == "todo_read" and isinstance(approved_plan, dict):
        effective_tool_arguments["_jenny_approved_plan"] = approved_plan
        injected_arg_keys.append("_jenny_approved_plan")
    filtered_injected_arg_keys = tuple(
        key for key in sorted(set(injected_arg_keys)) if key in SIDECAR_INJECTED_ARG_KEYS
    )
    execution_context_payload: dict[str, Any] = {
        "session_id": normalized_session_id,
    }
    execution_context_payload.update(attribution)
    if call.tool_id == "mermaid_generate":
        execution_context_payload["read_only"] = bool(read_only)
    if plan_artifact_write:
        execution_context_payload["plan_artifact_write"] = True
    if "expected_read_snapshot" in effective_tool_arguments:
        execution_context_payload["expected_read_snapshot"] = effective_tool_arguments[
            "expected_read_snapshot"
        ]
    return FrozenExecutionInputs(
        call_id=str(call.call_id or "").strip(),
        tool_name=call.tool_id,
        visible_tool_arguments=visible_tool_arguments,
        effective_tool_arguments=effective_tool_arguments,
        injected_arg_keys=filtered_injected_arg_keys,
        effective_args_fingerprint=stable_hash(effective_tool_arguments),
        execution_context_payload=execution_context_payload,
    )
