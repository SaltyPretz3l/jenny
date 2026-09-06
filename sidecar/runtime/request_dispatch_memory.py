"""Memory method dispatch helpers extracted from request_dispatch.py.

Extracted from request_dispatch.py to keep that file under the 800-line hard limit.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_MEMORY_FAILED, CMP_PROTO_VERSION_MISMATCH
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.unavailable import UnavailableMemoryStore
from sidecar.exceptions import MemoryStoreError
from sidecar.protocol import (
    MEMORY_DELETE_METHOD,
    MEMORY_LIST_METHOD,
    MEMORY_PENDING_DELETE_METHOD,
    MEMORY_PENDING_LIST_METHOD,
    MEMORY_RECALL_METHOD,
    MEMORY_RECALL_RECENT_METHOD,
    MEMORY_SAVE_METHOD,
    MEMORY_STATUS_METHOD,
    MEMORY_SUGGEST_METHOD,
    MEMORY_UPDATE_METHOD,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.memory import (
    delete_memory,
    delete_pending_memory,
    list_memories_page,
    list_pending_memories_page,
    memory_error_payload,
    recall_memories,
    recall_recent_memories,
    save_memory_candidate,
    serialize_approved_memory,
    suggest_memories,
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


def process_memory_method(
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    """Dispatch memory.* JSON-RPC methods.  Returns None if method is not a memory method."""

    if method == MEMORY_STATUS_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            status = brain_container.stack.memory_service.status()
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
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(message_id, status),
            notifications=[],
        )

    if method == MEMORY_SUGGEST_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            session_id = params.get("session_id") if isinstance(params, dict) else None
            messages = params.get("messages") if isinstance(params, dict) else None
            suggestions = suggest_memories(
                session_id=session_id,
                messages=messages,
                memory_store=_require_memory_service(brain_container.stack),
            )
        except ValueError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message="memory.suggest invalid params",
                    data=memory_error_payload(str(error)),
                ),
                notifications=[],
            )
        except MemoryStoreError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INTERNAL_ERROR_CODE,
                    message="memory.suggest failed",
                    data=memory_error_payload(error),
                ),
                notifications=[],
            )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                {"suggestions": suggestions},
            ),
            notifications=[],
        )

    if method == MEMORY_SAVE_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            session_id = params.get("session_id") if isinstance(params, dict) else None
            candidate = params.get("candidate") if isinstance(params, dict) else None
            save_result = save_memory_candidate(
                session_id=session_id,
                candidate=candidate,
                memory_store=_require_memory_service(brain_container.stack),
            )
        except ValueError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message="memory.save invalid params",
                    data=memory_error_payload(str(error)),
                ),
                notifications=[],
            )
        except MemoryStoreError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INTERNAL_ERROR_CODE,
                    message="memory.save failed",
                    data=memory_error_payload(error),
                ),
                notifications=[],
            )
        if save_result.warning_code and save_result.warning_detail:
            emit_log_event(
                logger,
                logging.WARNING,
                component="runtime.request_dispatch",
                event="sidecar.runtime.memory_save.family_unresolved",
                message="Saved gated memory with unresolved family_key",
                status="warn",
                data={
                    "code": save_result.warning_code,
                    "detail": save_result.warning_detail,
                    "lesson_kind": save_result.memory.lesson_kind,
                    "memory_id": save_result.memory.id,
                },
            )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                {
                    "created": save_result.created,
                    "memory": serialize_approved_memory(save_result.memory),
                },
            ),
            notifications=[],
        )

    if method == MEMORY_LIST_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            page = list_memories_page(
                cursor=params.get("cursor"),
                limit=params.get("limit"),
                memory_store=_require_memory_service(brain_container.stack),
            )
        except ValueError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message=str(error)[:240],
                ),
                notifications=[],
            )
        except MemoryStoreError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INTERNAL_ERROR_CODE,
                    message="memory.list failed",
                    data=memory_error_payload(error),
                ),
                notifications=[],
            )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                page,
            ),
            notifications=[],
        )

    if method == MEMORY_PENDING_LIST_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            page = list_pending_memories_page(
                cursor=params.get("cursor"),
                limit=params.get("limit"),
                memory_store=_require_memory_service(brain_container.stack),
            )
        except ValueError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message=str(error)[:240],
                ),
                notifications=[],
            )
        except MemoryStoreError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INTERNAL_ERROR_CODE,
                    message="memory.pending.list failed",
                    data=memory_error_payload(error),
                ),
                notifications=[],
            )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                page,
            ),
            notifications=[],
        )

    if method == MEMORY_UPDATE_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            memory_id = params.get("memory_id") if isinstance(params, dict) else None
            patch = params.get("patch") if isinstance(params, dict) else None
            updated_memory = update_memory(
                memory_id=memory_id,
                patch=patch,
                memory_store=_require_memory_service(brain_container.stack),
            )
        except ValueError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message="memory.update invalid params",
                    data=memory_error_payload(str(error)),
                ),
                notifications=[],
            )
        except MemoryStoreError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INTERNAL_ERROR_CODE,
                    message="memory.update failed",
                    data=memory_error_payload(error),
                ),
                notifications=[],
            )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                {
                    "updated": True,
                    "memory": serialize_approved_memory(updated_memory),
                },
            ),
            notifications=[],
        )

    if method == MEMORY_DELETE_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            memory_id = params.get("memory_id") if isinstance(params, dict) else None
            deleted = delete_memory(
                memory_id=memory_id,
                memory_store=_require_memory_service(brain_container.stack),
            )
        except ValueError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message="memory.delete invalid params",
                    data=memory_error_payload(str(error)),
                ),
                notifications=[],
            )
        except MemoryStoreError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INTERNAL_ERROR_CODE,
                    message="memory.delete failed",
                    data=memory_error_payload(error),
                ),
                notifications=[],
            )
        resolved_memory_id = params.get("memory_id") if isinstance(params, dict) else None
        response_memory_id = (
            resolved_memory_id
            if isinstance(resolved_memory_id, int) and not isinstance(resolved_memory_id, bool)
            else None
        )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                {"deleted": deleted, "memory_id": response_memory_id if deleted else None},
            ),
            notifications=[],
        )

    if method == MEMORY_PENDING_DELETE_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            session_id = params.get("session_id") if isinstance(params, dict) else None
            content_fingerprint = (
                params.get("content_fingerprint") if isinstance(params, dict) else None
            )
            deleted = delete_pending_memory(
                session_id=session_id,
                content_fingerprint=content_fingerprint,
                memory_store=_require_memory_service(brain_container.stack),
            )
        except ValueError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message="memory.pending.delete invalid params",
                    data=memory_error_payload(str(error)),
                ),
                notifications=[],
            )
        except MemoryStoreError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INTERNAL_ERROR_CODE,
                    message="memory.pending.delete failed",
                    data=memory_error_payload(error),
                ),
                notifications=[],
            )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                {"deleted": deleted},
            ),
            notifications=[],
        )

    if method == MEMORY_RECALL_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            query = params.get("query") if isinstance(params, dict) else None
            limit = params.get("limit") if isinstance(params, dict) else None
            memories = recall_memories(
                query=query,
                limit=limit,
                memory_store=_require_memory_service(brain_container.stack),
            )
        except ValueError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message="memory.recall invalid params",
                    data=memory_error_payload(str(error)),
                ),
                notifications=[],
            )
        except MemoryStoreError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INTERNAL_ERROR_CODE,
                    message="memory.recall failed",
                    data=memory_error_payload(error),
                ),
                notifications=[],
            )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                {"memories": memories},
            ),
            notifications=[],
        )

    if method == MEMORY_RECALL_RECENT_METHOD:
        version_error = validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=version_error,
                notifications=[],
            )
        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )
        try:
            lesson_kind = params.get("lesson_kind") if isinstance(params, dict) else None
            limit = params.get("limit") if isinstance(params, dict) else None
            memories = recall_recent_memories(
                lesson_kind=lesson_kind,
                limit=limit,
                memory_store=_require_memory_service(brain_container.stack),
            )
        except ValueError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message="memory.recall_recent invalid params",
                    data=memory_error_payload(str(error)),
                ),
                notifications=[],
            )
        except MemoryStoreError as error:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=INTERNAL_ERROR_CODE,
                    message="memory.recall_recent failed",
                    data=memory_error_payload(error),
                ),
                notifications=[],
            )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(
                message_id,
                {"memories": memories},
            ),
            notifications=[],
        )

    return None
