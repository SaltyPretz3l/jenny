"""Reflection RPC bodies: memory.reflect, memory.apply, memory.reflection_state,
memory.policy_epoch (row 58 W2, "Jenny takes notes").

``memory.reflect`` runs one local inference over an Electron-built window and
returns checked, add-only proposals plus a short recap; it writes nothing.
``memory.apply`` performs the store's one-transaction apply behind the epoch
and cursor fence. Parameter errors raise ``ValueError`` (JSON-RPC -32602).
Logs carry counts and ids only, never conversation or memory text.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from typing import Any

from sidecar.ai.engines.admitted import InferenceAdmissionError
from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.feature_flags import FEATURE_PROMPT_CACHE, is_feature_flag_enabled
from sidecar.ai.memory.contracts import (
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_MESSAGE_ID_CHARS,
    require_project_id,
)
from sidecar.ai.memory.reflection_checks import (
    DEDUPE_ROW_LIMIT,
    MAX_PROPOSALS,
    MAX_RECAP_CHARS,
    REFLECTION_MAX_TOKENS,
    REFLECTION_SCHEMA,
    REFLECTION_SYSTEM_PROMPT,
    build_reflection_prompt,
    check_reflection_output,
    numbered_new_user_messages,
)
from sidecar.ai.memory.reflection_epochs import PolicyEpochFence
from sidecar.ai.memory.service import approved_memory_api, pending_memory_api
from sidecar.ai.memory.store_operations import require_operation_id
from sidecar.ai.memory.store_reflection import (
    REFLECTION_CAPTURE_MODES,
    ReflectionCursor,
    ReflectionItem,
    recap_operation_id,
    reflection_operation_id,
)
from sidecar.ai.routing.retry import (
    QUERY_SOURCE_BACKGROUND_CLASSIFIER,
    execute_with_provider_retry,
)
from sidecar.exceptions import MemoryStoreError
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.inference_admission import bound_auxiliary_cancel_handle

MAX_WINDOW_MESSAGES = 24
MAX_NEW_USER_IDS = 8
MAX_USER_MESSAGE_CHARS = 2_000
MAX_ASSISTANT_MESSAGE_CHARS = 600
MAX_WINDOW_CHARS = 12_000
MAX_EPOCH_SOURCE_CHARS = 64
MAX_TOKEN_CHARS = 256
REFLECTION_TEMPERATURE = 0.2
REFLECTION_INFERENCE_FAILED = "reflection_inference_failed"
REFLECTION_OUTPUT_INVALID = "reflection_output_invalid"
_FINGERPRINT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ROLE_CAPS = {"user": MAX_USER_MESSAGE_CHARS, "assistant": MAX_ASSISTANT_MESSAGE_CHARS}


class ReflectionInferenceError(RuntimeError):
    """The engine failed (not a cancel or admission refusal); ``reason`` names how."""

    reason = REFLECTION_INFERENCE_FAILED


class ReflectionOutputInvalid(ReflectionInferenceError):
    """The answer was not the schema's JSON: the run fails so Electron never applies.

    Applying an empty result would advance the cursor past messages nothing read.
    """

    reason = REFLECTION_OUTPUT_INVALID


# --- small validators ----------------------------------------------------------


def _text(params: dict[str, Any], key: str, max_chars: int = MAX_TOKEN_CHARS) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > max_chars:
        raise ValueError(f"{key} must be a non-empty string of at most {max_chars} chars")
    return value


def _count(params: dict[str, Any], key: str) -> int:
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


def _session_id(params: dict[str, Any]) -> str:
    return _text(params, "session_id", MAX_SESSION_ID_CHARS).strip()


def _fingerprint(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not _FINGERPRINT_RE.fullmatch(value):
        raise ValueError(f"{key} must be a sha256:<64 hex> window fingerprint")
    return value


# --- memory.reflect ------------------------------------------------------------


@dataclass(frozen=True)
class ReflectRequest:
    request_id: str
    session_id: str
    project_id: str
    messages: tuple[dict[str, str], ...]
    new_user_ids: tuple[str, ...]
    window_fingerprint: str


def _window_messages(value: Any) -> tuple[dict[str, str], ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_WINDOW_MESSAGES:
        raise ValueError(f"messages must be a list of 1..{MAX_WINDOW_MESSAGES} entries")
    messages: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in value:
        if not isinstance(entry, dict):
            raise ValueError("messages[] must be objects")
        message_id = _text(entry, "id", MAX_SOURCE_MESSAGE_ID_CHARS)
        role, content = entry.get("role"), entry.get("content")
        if role not in _ROLE_CAPS or not isinstance(content, str):
            raise ValueError("messages[] need role user|assistant and string content")
        if len(content) > _ROLE_CAPS[role] or message_id in seen:
            raise ValueError("messages[] content is over its cap or an id repeats")
        seen.add(message_id)
        messages.append({"id": message_id, "role": role, "content": content})
    if sum(len(message["content"]) for message in messages) > MAX_WINDOW_CHARS:
        raise ValueError(f"messages exceed the {MAX_WINDOW_CHARS}-char window")
    return tuple(messages)


def parse_reflect_request(params: Any) -> ReflectRequest:
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    messages = _window_messages(params.get("messages"))
    new_ids = params.get("new_user_ids")
    user_ids = {message["id"] for message in messages if message["role"] == "user"}
    if (
        not isinstance(new_ids, list)
        or not 1 <= len(new_ids) <= MAX_NEW_USER_IDS
        or any(not isinstance(item, str) or item not in user_ids for item in new_ids)
        or len(set(new_ids)) != len(new_ids)
    ):
        raise ValueError(
            f"new_user_ids must list 1..{MAX_NEW_USER_IDS} distinct user message ids"
        )
    return ReflectRequest(
        request_id=_text(params, "request_id"),
        session_id=_session_id(params),
        project_id=require_project_id(params.get("project_id")),
        messages=messages,
        new_user_ids=tuple(new_ids),
        window_fingerprint=_text(params, "window_fingerprint"),
    )


def reflect_memories(  # noqa: PLR0913 - keyword-only request ports
    *,
    stack: Any,
    backend: Any,
    request: ReflectRequest,
    logger: logging.Logger,
    inference_admission: Any | None = None,
    cancel_handle: Any | None = None,
) -> dict[str, Any]:
    """One reflection inference plus the deterministic checks. Writes nothing.

    A cancel (``cancel_handle``, default the auxiliary worker's bound handle)
    and an admission refusal propagate; any other engine failure raises
    :class:`ReflectionInferenceError`; an unparseable answer is an empty result.
    """

    if cancel_handle is None:
        cancel_handle = bound_auxiliary_cancel_handle()
    cancel_kwargs = {} if cancel_handle is None else {"cancel_handle": cancel_handle}
    approved = approved_memory_api(backend)
    pending = pending_memory_api(backend)
    prompt = build_reflection_prompt(request.messages, request.new_user_ids)
    prompt_cache_enabled = is_feature_flag_enabled(
        stack.config.feature_flags or {}, FEATURE_PROMPT_CACHE
    )
    started = time.monotonic()
    try:
        raw = execute_with_provider_retry(
            operation=lambda context: stack.engine.generate(
                prompt=prompt,
                max_tokens=context.max_tokens,
                temperature=REFLECTION_TEMPERATURE,
                # Background work must never think (see runtime/suggestions.py).
                reasoning_effort="low",
                prompt_cache_enabled=prompt_cache_enabled,
                system=REFLECTION_SYSTEM_PROMPT,
                response_format=ResponseFormat(
                    type="json_object", json_schema=REFLECTION_SCHEMA
                ),
                **cancel_kwargs,
            ),
            logger=logger,
            component="runtime.memory_reflection",
            event_prefix="runtime.memory_reflection.retry",
            request_source=QUERY_SOURCE_BACKGROUND_CLASSIFIER,
            provider=stack.config.engine_type,
            model=stack.config.model,
            initial_max_tokens=REFLECTION_MAX_TOKENS,
            feature_flags=stack.config.feature_flags,
            request_id=request.request_id,
            # Electron admits memory.reflect session-scoped, so the attempt must be too.
            session_id=request.session_id,
            inference_admission=inference_admission,
            cancel_handle=cancel_handle,
        )
    except InferenceAdmissionError:
        raise
    except Exception as error:  # noqa: BLE001 - boundary
        if cancel_handle is not None and cancel_handle.cancelled:
            raise
        raise ReflectionInferenceError(type(error).__name__) from error
    checked = check_reflection_output(
        str(raw or ""),
        new_user_messages=numbered_new_user_messages(request.messages, request.new_user_ids),
        is_suppressed=lambda digest: pending.is_memory_suppressed(
            digest, project_id=request.project_id
        ),
        existing_rows=approved.reflection_dedupe_rows(
            project_id=request.project_id, limit=DEDUPE_ROW_LIMIT,
            scope_session_id=request.session_id,
        ),
    )
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if checked.parse_failed:
        raise ReflectionOutputInvalid("unparseable")
    log_event(
        logger,
        logging.INFO,
        component="runtime.memory_reflection",
        event="memory.reflect.completed",
        message="Reflection finished.",
        data={
            "proposals": len(checked.proposals),
            "has_recap": bool(checked.recap),
            "dropped": dict(checked.dropped),
            "elapsed_ms": elapsed_ms,
        },
    )
    return {
        "proposals": [proposal.to_wire() for proposal in checked.proposals],
        "recap": checked.recap,
        "window_fingerprint": request.window_fingerprint,
        "dropped": dict(checked.dropped),
        "model": str(stack.config.model or ""),
        "elapsed_ms": elapsed_ms,
    }


# --- memory.reflection_state / memory.policy_epoch -------------------------------


def reflection_state_result(params: dict[str, Any], backend: Any) -> dict[str, Any]:
    return dict(approved_memory_api(backend).reflection_state(_session_id(params)))


def policy_epoch_result(params: dict[str, Any], fence: PolicyEpochFence) -> dict[str, Any]:
    epoch = _count(params, "policy_epoch")
    source = _text(params, "epoch_source", MAX_EPOCH_SOURCE_CHARS)
    return {"latest": fence.observe(source, epoch)}


# --- memory.apply --------------------------------------------------------------


def _cursor(value: Any) -> ReflectionCursor:
    if not isinstance(value, dict):
        raise ValueError("cursor must be an object")
    return ReflectionCursor(
        message_count=_count(value, "message_count"),
        last_message_id=_text(value, "last_message_id", MAX_SOURCE_MESSAGE_ID_CHARS),
        window_fingerprint=_fingerprint(value, "window_fingerprint"),
        session_incarnation=_text(value, "session_incarnation"),
        turn_generation=_count(value, "turn_generation"),
    )


def _items(value: Any) -> tuple[ReflectionItem, ...]:
    if not isinstance(value, list) or len(value) > MAX_PROPOSALS:
        raise ValueError(f"proposals must be a list of at most {MAX_PROPOSALS} items")
    items: list[ReflectionItem] = []
    for entry in value:
        if not isinstance(entry, dict):
            raise ValueError("proposals[] must be objects")
        text, kind = entry.get("text"), entry.get("kind")
        if not isinstance(text, str) or not isinstance(kind, str):
            raise ValueError("proposals[] need string text and kind")
        scope = entry.get("scope", "project")
        if scope not in ("project", "chat"):
            raise ValueError("proposals[] scope must be project or chat")
        items.append(ReflectionItem(
            text=text,
            kind=kind,
            scope=scope,
            source_message_id=_text(entry, "source_message_id", MAX_SOURCE_MESSAGE_ID_CHARS),
        ))
    return tuple(items)


def apply_reflection_result(
    params: dict[str, Any], backend: Any, fence: PolicyEpochFence
) -> dict[str, Any]:
    session_id = _session_id(params)
    project_id = require_project_id(params.get("project_id"))
    epoch = _count(params, "policy_epoch")
    source = _text(params, "epoch_source", MAX_EPOCH_SOURCE_CHARS)
    capture = params.get("capture")
    if capture not in REFLECTION_CAPTURE_MODES:
        raise ValueError("capture must be 'auto' or 'ask'")
    expected = params.get("expected_fingerprint")
    if expected is not None and not isinstance(expected, str):
        raise ValueError("expected_fingerprint must be a string or null")
    cursor = _cursor(params.get("cursor"))
    proposals = _items(params.get("proposals"))
    recap = params.get("recap", "")
    if not isinstance(recap, str) or len(recap) > MAX_RECAP_CHARS:
        raise ValueError(f"recap must be a string of at most {MAX_RECAP_CHARS} chars")
    try:
        require_operation_id(recap_operation_id(session_id, cursor.window_fingerprint))
        require_operation_id(
            reflection_operation_id(session_id, cursor.window_fingerprint, MAX_PROPOSALS)
        )
    except MemoryStoreError as error:
        raise ValueError("session_id cannot form a reflection operation id") from error
    # The apply's own epoch counts as seen, so a later lower epoch is stale too.
    fence.observe(source, epoch)
    return dict(approved_memory_api(backend).apply_reflection(
        session_id=session_id,
        project_id=project_id,
        capture=capture,
        expected_fingerprint=expected,
        cursor=cursor,
        proposals=proposals,
        recap=recap,
        is_policy_stale=lambda: fence.is_stale(source, epoch),
    ))


__all__ = [
    "REFLECTION_INFERENCE_FAILED",
    "REFLECTION_OUTPUT_INVALID",
    "ReflectionOutputInvalid",
    "ReflectRequest",
    "ReflectionInferenceError",
    "apply_reflection_result",
    "parse_reflect_request",
    "policy_epoch_result",
    "reflect_memories",
    "reflection_state_result",
]
