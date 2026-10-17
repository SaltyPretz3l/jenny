"""Memory method dispatch extracted from request_dispatch.py.

Every memory.* request shares one guard ladder: version check, notification
short-circuit, then the handler. A ``ValueError`` is a JSON-RPC invalid-params
error and a ``MemoryStoreError`` an internal error, both with a coded payload;
v9 refusals and conflicts are successful results. Logs carry methods, codes
and reasons only, never memory text.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_MEMORY_FAILED, CMP_PROTO_VERSION_MISMATCH
from sidecar.ai.memory.contracts import (
    GENERAL_PROJECT_ID,
    MAX_SESSION_ID_CHARS,
    normalize_positive_limit,
    require_bounded_text,
    require_project_id,
)
from sidecar.ai.memory.reflection_epochs import PolicyEpochFence
from sidecar.ai.memory.service import MemoryService, approved_memory_api
from sidecar.ai.memory.store_session_transfer import MAX_CHAT_SESSIONS, MAX_TRANSFER_NOTES
from sidecar.ai.memory.unavailable import UnavailableMemoryStore
from sidecar.exceptions import MemoryStoreError
from sidecar.protocol import (
    MEMORY_APPLY_METHOD,
    MEMORY_ARCHIVE_PROJECT_METHOD,
    MEMORY_CHAT_SESSIONS_METHOD,
    MEMORY_CLEAR_SUPPRESSIONS_METHOD,
    MEMORY_DELETE_METHOD,
    MEMORY_EMBED_STEP_METHOD,
    MEMORY_ERASE_METHOD,
    MEMORY_EXPORT_SESSION_METHOD,
    MEMORY_IMPORT_SESSION_METHOD,
    MEMORY_LIST_METHOD,
    MEMORY_OPERATIONS_METHOD,
    MEMORY_PENDING_ACCEPT_METHOD,
    MEMORY_PENDING_DELETE_METHOD,
    MEMORY_PENDING_LIST_METHOD,
    MEMORY_POLICY_EPOCH_METHOD,
    MEMORY_PURGE_SESSION_METHOD,
    MEMORY_RECALL_METHOD,
    MEMORY_REFLECTION_STATE_METHOD,
    MEMORY_RESTORE_METHOD,
    MEMORY_SAVE_METHOD,
    MEMORY_STATUS_METHOD,
    MEMORY_UNDO_METHOD,
    MEMORY_UPDATE_METHOD,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.memory import (
    UPDATE_FIELDS,
    accept_pending_memory,
    archive_project_memories,
    clear_memory_suppressions,
    delete_memory,
    delete_pending_memory,
    list_memories_page,
    list_pending_memories_page,
    memory_error_payload,
    parse_memory_id,
    purge_session_memories,
    recall_memories,
    restore_memory,
    save_memory_candidate,
    serialize_write_result,
    undo_memory_operation,
    update_memory,
)
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH


def emit_log_event(logger: logging.Logger, level: int, **kwargs: Any) -> None:
    request_dispatch_module = sys.modules.get("sidecar.runtime.request_dispatch")
    log_event_fn = getattr(request_dispatch_module, "log_event", log_event)
    log_event_fn(logger, level, **kwargs)


def _require_memory_service(stack: Any) -> Any:
    """Prefer the service while retaining older/fake stack compatibility.

    An UnavailableMemoryStore raises this exact MemoryStoreError on first method
    access anyway (see its __getattr__); raising here keeps that behavior while
    letting the runtime.memory helpers keep their precise MemoryStore signature.
    Every caller is inside an `except MemoryStoreError` handler that converts
    this into the coded error response.
    """
    service = getattr(stack, "memory_service", None)
    store = (
        service.store_compat
        if isinstance(service, MemoryService)
        else getattr(stack, "memory_store", None)
    )
    if isinstance(store, UnavailableMemoryStore):
        raise MemoryStoreError(
            store.reason_code,
            "memory is unavailable; explicit repair is required",
        )
    if store is None:
        raise MemoryStoreError(
            CMP_MEMORY_FAILED,
            "memory is unavailable; explicit repair is required",
        )
    return service if isinstance(service, MemoryService) else store


def _request_project_id(params: dict[str, Any]) -> str:
    if "project_id" not in params:
        return GENERAL_PROJECT_ID
    return require_project_id(params["project_id"])


def _request_list_scope(params: dict[str, Any]) -> tuple[str, bool]:
    scope = params.get("scope", "project")
    if scope not in {"project", "all"}:
        raise ValueError("scope must be 'project' or 'all'")
    all_projects = scope == "all"
    return (GENERAL_PROJECT_ID if all_projects else _request_project_id(params), all_projects)


def _request_include_general(params: dict[str, Any]) -> bool:
    value = params.get("include_general", False)
    if not isinstance(value, bool):
        raise ValueError("include_general must be a boolean")
    return value


def _memory(brain_container: BrainContainer) -> Any:
    return _require_memory_service(brain_container.stack)


def _policy_epochs(brain_container: BrainContainer) -> PolicyEpochFence:
    """The service's in-process epoch fence; it outlives an unavailable store."""

    service = getattr(brain_container.stack, "memory_service", None)
    if not isinstance(service, MemoryService):
        raise MemoryStoreError(
            CMP_MEMORY_FAILED, "memory is unavailable; explicit repair is required"
        )
    return service.policy_epochs


# --- handlers: (params, brain_container) -> result payload ----------------------


def _save(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id = _request_project_id(params)
    result = save_memory_candidate(
        session_id=params.get("session_id"),
        candidate=params.get("candidate"),
        memory_store=_memory(brain),
        project_id=project_id,
        scope_session_id=params.get("scope_session_id"),
        always_on=params.get("always_on"),
        operation_id=params.get("operation_id"),
    )
    created = result.status == "saved" and not result.duplicate
    return {"created": created, **serialize_write_result(result)}


def _update(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    if "patch" in params:
        raise ValueError("memory.update takes flat fields; patch is not supported")
    project_id = _request_project_id(params)
    return serialize_write_result(
        update_memory(
            memory_id=params.get("memory_id"),
            changes={field: params[field] for field in UPDATE_FIELDS if field in params},
            memory_store=_memory(brain),
            project_id=project_id,
            expected_revision=params.get("expected_revision"),
            operation_id=params.get("operation_id"),
        )
    )


def _delete(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id = _request_project_id(params)
    result = delete_memory(
        memory_id=params.get("memory_id"),
        memory_store=_memory(brain),
        project_id=project_id,
        expected_revision=params.get("expected_revision"),
        operation_id=params.get("operation_id"),
    )
    return {"deleted": result.status == "saved", **serialize_write_result(result)}


def _undo(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id = _request_project_id(params)
    return serialize_write_result(
        undo_memory_operation(
            operation_id=params.get("operation_id"),
            undo_operation_id=params.get("undo_operation_id"),
            memory_store=_memory(brain),
            project_id=project_id,
        )
    )


def _restore(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id = _request_project_id(params)
    target = params.get("target_project_id")
    return serialize_write_result(
        restore_memory(
            memory_id=params.get("memory_id"),
            memory_store=_memory(brain),
            project_id=project_id,
            operation_id=params.get("operation_id"),
            target_project_id=None if target is None else require_project_id(target),
        )
    )


def _archive_project(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id = _request_project_id(params)
    return archive_project_memories(memory_store=_memory(brain), project_id=project_id)


def _purge_session(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    return purge_session_memories(session_id=params.get("session_id"), memory_store=_memory(brain))


# Row 58 W3 chat memory transfer: export, import under a new chat id, and the
# list of chats that still hold chat memory or sourced shared notes (Electron's
# purge reconciliation).
def _transfer_session_id(params: dict[str, Any]) -> str:
    session_id = params.get("session_id")
    if not isinstance(session_id, str):
        raise ValueError("session_id must be a string")
    return require_bounded_text(session_id, field="session_id", max_chars=MAX_SESSION_ID_CHARS)


def _export_session(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    return approved_memory_api(_memory(brain)).export_session(_transfer_session_id(params))


def _import_session(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    session = _transfer_session_id(params)
    project = require_project_id(params.get("project_id"))
    notes, recap = params.get("notes"), params.get("recap")
    if not isinstance(notes, list) or len(notes) > MAX_TRANSFER_NOTES:
        raise ValueError("notes must be a list of at most 200 objects")
    for note in notes:
        if not isinstance(note, dict) or not all(
            isinstance(note.get(key), str) for key in ("text", "kind")
        ):
            raise ValueError("notes entries need text and kind strings")
        if "origin" in note and not isinstance(note["origin"], str):
            raise ValueError("notes origin must be a string")
    if recap is not None and not isinstance(recap, str):
        raise ValueError("recap must be a string or null")
    return approved_memory_api(_memory(brain)).import_session(
        session_id=session, project_id=project, notes=notes, recap=recap
    )


def _chat_sessions(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    limit = normalize_positive_limit(
        params.get("limit"), default=MAX_CHAT_SESSIONS, maximum=MAX_CHAT_SESSIONS
    )
    return approved_memory_api(_memory(brain)).chat_sessions(limit=limit)


# Row 58 W4 Settings reads and the vector index step.
def erase_memory(*, memory_id: Any, memory_store: Any, project_id: Any) -> dict[str, object]:
    """memory.erase: hard-delete one row of *project_id* (any status); not undoable."""

    erased = approved_memory_api(memory_store).erase(
        project_id=require_project_id(project_id), memory_id=parse_memory_id(memory_id)
    )
    return {"status": "erased" if erased else "not_found"}


# memory.operations: the content-free ledger fields Settings shows.
_OPERATION_FIELDS = (
    "operation_id", "op", "origin", "memory_id", "result_revision", "created_at",
    "expires_at", "undone_at", "undoable",
)
MAX_OPERATIONS_PAGE = 50


def list_memory_operations(
    *, memory_store: Any, project_id: Any, limit: Any
) -> dict[str, object]:
    """memory.operations: recent operations of one project, newest first."""

    safe_limit = normalize_positive_limit(
        limit, default=MAX_OPERATIONS_PAGE, maximum=MAX_OPERATIONS_PAGE
    )
    rows = approved_memory_api(memory_store).list_operations(
        project_id=require_project_id(project_id), limit=safe_limit
    )
    return {"operations": [{key: row.get(key) for key in _OPERATION_FIELDS} for row in rows]}


def embed_step_params(params: dict[str, Any]) -> dict[str, Any]:
    """memory.embed_step bounds: budget_seconds 0.1..5.0, batch 1..32."""

    # The vector index loads with its first request, off the sidecar startup path.
    from sidecar.ai.memory.vector_index import (
        DEFAULT_EMBED_BATCH,
        DEFAULT_EMBED_BUDGET_SECONDS,
        MAX_EMBED_BATCH,
        MAX_EMBED_BUDGET_SECONDS,
        MIN_EMBED_BUDGET_SECONDS,
    )

    budget = params.get("budget_seconds", DEFAULT_EMBED_BUDGET_SECONDS)
    if isinstance(budget, bool) or not isinstance(budget, int | float):
        raise ValueError("budget_seconds must be a number")
    if not MIN_EMBED_BUDGET_SECONDS <= float(budget) <= MAX_EMBED_BUDGET_SECONDS:
        raise ValueError(
            f"budget_seconds must be between {MIN_EMBED_BUDGET_SECONDS} "
            f"and {MAX_EMBED_BUDGET_SECONDS}"
        )
    batch = params.get("batch", DEFAULT_EMBED_BATCH)
    if isinstance(batch, bool) or not isinstance(batch, int):
        raise ValueError("batch must be an integer")
    if not 1 <= batch <= MAX_EMBED_BATCH:
        raise ValueError(f"batch must be between 1 and {MAX_EMBED_BATCH}")
    return {"budget_seconds": float(budget), "batch": batch}


def _erase(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    return erase_memory(
        memory_id=params.get("memory_id"),
        memory_store=_memory(brain),
        project_id=params.get("project_id"),
    )


def _operations(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    return list_memory_operations(
        memory_store=_memory(brain),
        project_id=params.get("project_id"),
        limit=params.get("limit"),
    )


def _embed_step(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    """memory.embed_step (worker family ``memory_index``); content-free counts."""

    bounds = embed_step_params(params)
    service = _memory(brain)
    if not isinstance(service, MemoryService):
        return {"ok": True, "embedded": 0, "remaining": 0, "reason": "hybrid_off"}
    return service.embed_step(**bounds)


def _clear_suppressions(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id = _request_project_id(params) if "project_id" in params else None
    return clear_memory_suppressions(memory_store=_memory(brain), project_id=project_id)


def _list(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id, all_projects = _request_list_scope(params)
    return list_memories_page(
        cursor=params.get("cursor"),
        limit=params.get("limit"),
        memory_store=_memory(brain),
        project_id=project_id,
        all_projects=all_projects,
        status=params.get("status"),
        scope_session_id=params.get("scope_session_id"),
    )


def _pending_list(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id, all_projects = _request_list_scope(params)
    return list_pending_memories_page(
        cursor=params.get("cursor"),
        limit=params.get("limit"),
        memory_store=_memory(brain),
        project_id=project_id,
        all_projects=all_projects,
    )


def _pending_delete(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id = _request_project_id(params)
    deleted = delete_pending_memory(
        session_id=params.get("session_id"),
        content_fingerprint=params.get("content_fingerprint"),
        memory_store=_memory(brain),
        project_id=project_id,
    )
    return {"deleted": deleted}


def _pending_accept(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id = _request_project_id(params)
    result = accept_pending_memory(
        session_id=params.get("session_id"),
        content_fingerprint=params.get("content_fingerprint"),
        memory_store=_memory(brain),
        project_id=project_id,
        operation_id=params.get("operation_id"),
    )
    return {"accepted": result.status == "saved", **serialize_write_result(result)}


def _recall(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    project_id = _request_project_id(params)
    include_general = _request_include_general(params)
    memories = recall_memories(
        query=params.get("query"),
        limit=params.get("limit"),
        memory_store=_memory(brain),
        project_id=project_id,
        include_general=include_general,
        scope_session_id=params.get("scope_session_id"),
    )
    return {"memories": memories}


# The reflection handlers load sidecar.runtime.memory_reflection on first use: it is
# request-time only and stays off the sidecar startup path.


def _reflection_state(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    from sidecar.runtime.memory_reflection import reflection_state_result

    return reflection_state_result(params, _memory(brain))


def _policy_epoch(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    from sidecar.runtime.memory_reflection import policy_epoch_result

    return policy_epoch_result(params, _policy_epochs(brain))


def _apply(params: dict[str, Any], brain: BrainContainer) -> dict[str, object]:
    from sidecar.runtime.memory_reflection import apply_reflection_result

    return apply_reflection_result(params, _memory(brain), _policy_epochs(brain))


_HANDLERS: dict[str, Callable[[dict[str, Any], BrainContainer], dict[str, object]]] = {
    MEMORY_SAVE_METHOD: _save,
    MEMORY_LIST_METHOD: _list,
    MEMORY_PENDING_LIST_METHOD: _pending_list,
    MEMORY_PENDING_DELETE_METHOD: _pending_delete,
    MEMORY_PENDING_ACCEPT_METHOD: _pending_accept,
    MEMORY_UPDATE_METHOD: _update,
    MEMORY_DELETE_METHOD: _delete,
    MEMORY_RECALL_METHOD: _recall,
    MEMORY_UNDO_METHOD: _undo,
    MEMORY_RESTORE_METHOD: _restore,
    MEMORY_ARCHIVE_PROJECT_METHOD: _archive_project,
    MEMORY_PURGE_SESSION_METHOD: _purge_session,
    MEMORY_CLEAR_SUPPRESSIONS_METHOD: _clear_suppressions,
    MEMORY_EXPORT_SESSION_METHOD: _export_session,
    MEMORY_IMPORT_SESSION_METHOD: _import_session,
    MEMORY_CHAT_SESSIONS_METHOD: _chat_sessions,
    # Row 58 W4: hard erase and the content-free ledger run inline; embed_step
    # runs on its own auxiliary worker (family memory_index).
    MEMORY_ERASE_METHOD: _erase,
    MEMORY_OPERATIONS_METHOD: _operations,
    MEMORY_EMBED_STEP_METHOD: _embed_step,
    # Reflection (row 58 W2); memory.reflect is an auxiliary inference instead
    # (sidecar/runtime/request_dispatch_memory_reflection.py).
    MEMORY_REFLECTION_STATE_METHOD: _reflection_state,
    MEMORY_POLICY_EPOCH_METHOD: _policy_epoch,
    MEMORY_APPLY_METHOD: _apply,
}


def _outcome(initialized: bool, response: Any) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=response,
        notifications=[],
    )


def process_memory_method(  # mirrors the dispatcher boundary.
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    """Dispatch memory.* JSON-RPC methods.  Returns None if method is not a memory method."""
    handler = _HANDLERS.get(method)
    if handler is None and method != MEMORY_STATUS_METHOD:
        return None
    version_error = validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
    )
    if version_error is not None:
        return _outcome(initialized, version_error)
    if message_id is None:
        return _outcome(initialized, None)
    request = params if isinstance(params, dict) else {}
    if handler is None:
        return _outcome(initialized, _status_response(message_id, request, brain_container, logger))
    try:
        payload = handler(request, brain_container)
    except ValueError as error:
        return _outcome(
            initialized,
            error_response(
                message_id,
                code=INVALID_PARAMS_CODE,
                message=f"{method} invalid params",
                data=memory_error_payload(error),
            ),
        )
    except MemoryStoreError as error:
        return _outcome(
            initialized,
            error_response(
                message_id,
                code=INTERNAL_ERROR_CODE,
                message=f"{method} failed",
                data=memory_error_payload(error),
            ),
        )
    if payload.get("status") in {"refused", "conflict"}:
        emit_log_event(
            logger,
            logging.INFO,
            component="runtime.request_dispatch",
            event="sidecar.runtime.memory_write.refused",
            message="Memory write returned a refusal or conflict result.",
            status="refused",
            data={
                "method": method,
                "status": payload.get("status"),
                "reason": payload.get("reason"),
                "code": payload.get("code"),
            },
        )
    return _outcome(initialized, result_response(message_id, payload))


def _status_response(
    message_id: Any,
    params: dict[str, Any],
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> dict[str, Any]:
    """memory.status: content-free health that degrades instead of failing."""

    try:
        project_id, all_projects = _request_list_scope(params)
        status = brain_container.stack.memory_service.status(
            project_id=project_id, all_projects=all_projects
        )
    except ValueError as error:
        return error_response(
            message_id,
            code=INVALID_PARAMS_CODE,
            message="memory.status invalid params",
            data=memory_error_payload(error),
        )
    except Exception as error:  # noqa: BLE001 - status must be fail-soft.
        code = error.code if isinstance(error, MemoryStoreError) else CMP_MEMORY_FAILED
        emit_log_event(
            logger,
            logging.WARNING,
            component="runtime.request_dispatch",
            event="sidecar.runtime.memory_status.degraded",
            message="Memory status degraded without terminating the sidecar.",
            status="degraded",
            data={"code": code, "error_type": type(error).__name__},
        )
        status = {
            "available": False,
            "schema_version": None,
            "recall_index": "unavailable",
            "counts": {},
            "storage": {"state": "unavailable"},
            "maintenance": {"state": "unavailable"},
            "preserved": False,
            "repair_required": True,
            "degraded_reasons": [code],
        }
    return result_response(message_id, status)
