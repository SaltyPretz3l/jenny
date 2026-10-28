"""Conversation index JSON-RPC dispatch (``conversations.*``, row 58 W4).

The store is synced from the live stack config on every call (a no-op unless
the block changed); an absent or disabled block, or a store that cannot be
opened or read, answers ``{ok: false, reason: 'index_unavailable'}``. The
semantic catalog is synced the same way so ``current_embedder()`` reflects the
live embedder (hybrid search, embed steps). Params are validated strictly:
over-limit values are rejected (``-32602``), never clipped; these
methods carry no CMP code (the results' ``reason`` strings are the contract). No query, title or
message text reaches a log. Hosted mode never reaches here: these methods are
not in ``HOST_ALLOWED_RPC_METHODS``.
"""

from __future__ import annotations

import logging
import math
import sqlite3
from collections.abc import Callable
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.conversations import runtime as conversation_runtime
from sidecar.ai.conversations import search as conversation_search
from sidecar.ai.conversations import store as conversation_store
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.ai.semantic import runtime as semantic_runtime
from sidecar.protocol import (
    CONVERSATIONS_EMBED_STEP_METHOD,
    CONVERSATIONS_INDEX_SESSION_METHOD,
    CONVERSATIONS_INDEX_STATE_METHOD,
    CONVERSATIONS_PURGE_METHOD,
    CONVERSATIONS_SEARCH_METHOD,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
MAX_QUERY_CHARS = 500
MAX_EXCLUDED_SESSIONS = 50
MAX_PURGE_IDS = 500
DEFAULT_SEARCH_LIMIT = 5
MAX_SEARCH_LIMIT = 10
DEFAULT_BUDGET_SECONDS = 1.5
MIN_BUDGET_SECONDS = 0.1
MAX_BUDGET_SECONDS = 5.0
DEFAULT_EMBED_BATCH = 16
MAX_EMBED_BATCH = 64
ROLES = frozenset({"user", "assistant"})
UNAVAILABLE: dict[str, Any] = {"ok": False, "reason": "index_unavailable"}
_STORE_ERRORS = (conversation_store.ConversationIndexError, sqlite3.Error, OSError)

ConversationCall = Callable[[conversation_store.ConversationStore], dict[str, Any]]


def _mapping(params: Any) -> dict[str, Any]:
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    return params


def _text(value: Any, *, field: str, maximum: int, required: bool = True) -> str:
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        qualifier = "a non-empty string" if required else "a string"
        raise ValueError(f"{field} must be {qualifier} of at most {maximum} characters")
    return value


def _id(value: Any, *, field: str) -> str:
    return _text(value, field=field, maximum=conversation_store.MAX_ID_CHARS)


def _id_list(value: Any, *, field: str, maximum: int) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f"{field} must be a list of at most {maximum} ids")
    return [_id(item, field=field) for item in value]


def _bounded_int(value: Any, *, field: str, default: int, maximum: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(f"{field} must be an integer between 1 and {maximum}")
    return value


def _seconds(value: Any) -> float:
    if value is None:
        return DEFAULT_BUDGET_SECONDS
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("budget_seconds must be a number")
    seconds = float(value)
    if not math.isfinite(seconds) or not MIN_BUDGET_SECONDS <= seconds <= MAX_BUDGET_SECONDS:
        raise ValueError(
            f"budget_seconds must be between {MIN_BUDGET_SECONDS} and {MAX_BUDGET_SECONDS}")
    return seconds


def _message(value: Any) -> conversation_store.MessageInput:
    if not isinstance(value, dict):
        raise ValueError("each message must be an object")
    role = value.get("role")
    if role not in ROLES:
        raise ValueError("message role must be 'user' or 'assistant'")
    return conversation_store.MessageInput(
        message_id=_id(value.get("message_id"), field="message_id"),
        role=str(role),
        created_at=_text(value.get("created_at", ""), field="created_at",
                         maximum=conversation_store.MAX_TIMESTAMP_CHARS, required=False),
        text=_text(value.get("text"), field="text",
                   maximum=conversation_store.MAX_TEXT_CHARS, required=False),
    )


def _index_session_call(params: dict[str, Any]) -> ConversationCall:
    raw_messages = params.get("messages")
    limit = conversation_store.MAX_MESSAGES_PER_SESSION
    if not isinstance(raw_messages, list) or len(raw_messages) > limit:
        raise ValueError(f"messages must be a list of at most {limit} messages")
    messages = tuple(_message(item) for item in raw_messages)
    if len({message.message_id for message in messages}) != len(messages):
        raise ValueError("message ids must be unique within a session")
    session = conversation_store.SessionInput(
        session_id=_id(params.get("session_id"), field="session_id"),
        project_id=_id(params.get("project_id"), field="project_id"),
        title=_text(params.get("title", ""), field="title",
                    maximum=conversation_store.MAX_TITLE_CHARS, required=False),
        updated_at=_text(params.get("updated_at"), field="updated_at",
                         maximum=conversation_store.MAX_TIMESTAMP_CHARS),
        fingerprint=_id(params.get("fingerprint"), field="fingerprint"),
        messages=messages,
    )

    def call(store: conversation_store.ConversationStore) -> dict[str, Any]:
        indexed = store.replace_session(session)
        if indexed is None:
            return {"ok": False, "reason": "index_full"}
        return {"ok": True, "indexed": indexed}

    return call


def _purge_call(params: dict[str, Any]) -> ConversationCall:
    purge_all = params.get("all", False)
    if purge_all is not True and purge_all is not False:
        raise ValueError("all must be a boolean")
    if purge_all:
        if "session_ids" in params:
            raise ValueError("pass either session_ids or all, not both")
        return lambda store: {"ok": True, "removed": store.purge_all()}
    if "session_ids" not in params:
        raise ValueError("pass session_ids or all")
    ids = _id_list(params.get("session_ids"), field="session_ids", maximum=MAX_PURGE_IDS)
    return lambda store: {"ok": True, "removed": store.purge(ids)}


def _search_call(params: dict[str, Any]) -> ConversationCall:
    query = _text(params.get("query"), field="query", maximum=MAX_QUERY_CHARS)
    project_id = _id(params.get("project_id"), field="project_id")
    # Row 69: the primary chat searches every project; Electron decides who may.
    all_projects = params.get("all_projects", False)
    if all_projects is not True and all_projects is not False:
        raise ValueError("all_projects must be a boolean")
    exclude = _id_list(params.get("exclude_session_ids", []), field="exclude_session_ids",
                       maximum=MAX_EXCLUDED_SESSIONS)
    limit = _bounded_int(params.get("limit"), field="limit", default=DEFAULT_SEARCH_LIMIT,
                         maximum=MAX_SEARCH_LIMIT)
    return lambda store: conversation_search.search_conversations(
        store, query=query, project_id=None if all_projects else project_id,
        exclude_session_ids=exclude, limit=limit,
        embedder=semantic_runtime.current_embedder(),
    )


def _embed_step_call(params: dict[str, Any]) -> ConversationCall:
    budget = _seconds(params.get("budget_seconds"))
    batch = _bounded_int(params.get("batch"), field="batch", default=DEFAULT_EMBED_BATCH,
                         maximum=MAX_EMBED_BATCH)
    return lambda store: conversation_search.embed_step(
        store, semantic_runtime.current_embedder(), budget_seconds=budget, batch=batch)


def _index_state_call(_params: dict[str, Any]) -> ConversationCall:
    return lambda store: {"ok": True, **store.index_state()}


_PARSERS: dict[str, Callable[[dict[str, Any]], ConversationCall]] = {
    CONVERSATIONS_INDEX_STATE_METHOD: _index_state_call,
    CONVERSATIONS_INDEX_SESSION_METHOD: _index_session_call,
    CONVERSATIONS_PURGE_METHOD: _purge_call,
    CONVERSATIONS_SEARCH_METHOD: _search_call,
    CONVERSATIONS_EMBED_STEP_METHOD: _embed_step_call,
}


def _outcome(initialized: bool, response: dict[str, Any] | None) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=initialized, shutdown_requested=False, response=response, notifications=[]
    )


def process_conversations_method(  # noqa: PLR0913 - mirrors the dispatcher boundary.
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    """Dispatch conversations.* JSON-RPC methods.  Returns None for any other method."""
    parser = _PARSERS.get(method)
    if parser is None:
        return None
    version_error = validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=CMP_PROTO_VERSION_MISMATCH,
    )
    if version_error is not None:
        return _outcome(initialized, version_error)
    if message_id is None:
        return _outcome(initialized, None)
    try:
        call = parser(_mapping(params))
    except ValueError as error:
        return _outcome(initialized, error_response(
            message_id,
            code=INVALID_PARAMS_CODE,
            message=f"{method} invalid params",
            data={"detail": str(error)},
        ))
    return _outcome(initialized, _run(method, message_id, call, brain_container, logger))


def _log_failure(logger: logging.Logger, method: str, error: BaseException, status: str) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="runtime.request_dispatch",
        event="sidecar.runtime.conversations.failed",
        message="Conversation index request failed without terminating the sidecar.",
        status=status,
        data={"method": method, "error_type": type(error).__name__},
    )


def _run(
    method: str,
    message_id: Any,
    call: ConversationCall,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> dict[str, Any]:
    config = getattr(brain_container.stack, "config", None) or {}
    try:
        semantic_runtime.configure_semantic_catalog(config)
        store = conversation_runtime.configure_conversation_index(config)
        result = UNAVAILABLE if store is None else call(store)
    except _STORE_ERRORS as error:
        _log_failure(logger, method, error, "unavailable")
        result = UNAVAILABLE
    except Exception as error:  # noqa: BLE001 - an index fault must not end the sidecar.
        _log_failure(logger, method, error, "degraded")
        return error_response(
            message_id,
            code=INTERNAL_ERROR_CODE,
            message=f"{method} failed",
            data={"reason": "index_unavailable", "error_type": type(error).__name__},
        )
    return result_response(message_id, dict(result))
