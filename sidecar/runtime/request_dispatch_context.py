"""Desktop-only, content-free context.preview RPC. Does not admit inference."""

from __future__ import annotations

import json
from typing import Any

from sidecar.ai.context.preview import preview_context
from sidecar.ai.context.prompt_cache import resolve_current_date
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.protocol import CONTEXT_PREVIEW_METHOD
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.chat_normalization import (
    normalize_context_blocks,
    normalize_tool_preferences,
    session_start_date_from_params,
)
from sidecar.runtime.execution_context import execution_context_from_params
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

MAX_ID_CHARS = 128

_FIELDS = {
    "accept_version",
    "request_id",
    "session_id",
    "execution_context",
    "messages",
    "tool_preferences",
    "context_blocks",
    "run_mode",
    "session_start_date",
    "preferred_model",
}


def process_context_preview(
    message_id: Any, params: Any, initialized: bool, container: Any
) -> ProcessOutcome:
    version_error = validate_accept_version(
        method=CONTEXT_PREVIEW_METHOD,
        message_id=message_id,
        params=params,
        invalid_params_code=-32602,
        version_mismatch_code=CMP_PROTO_VERSION_MISMATCH,
    )
    if version_error is not None:
        return ProcessOutcome(initialized, False, version_error, [])
    try:
        if (
            not isinstance(params, dict)
            or set(params) - _FIELDS
            or len(json.dumps(params).encode()) > 8 * 1024 * 1024
        ):
            raise ValueError("invalid preview request")
        for key in ("request_id", "session_id"):
            if not isinstance(params.get(key), str) or not 0 < len(params[key]) <= MAX_ID_CHARS:
                raise ValueError("invalid preview identity")
        execution = execution_context_from_params(params)
        if execution is None:
            raise ValueError("preview requires session authority")
        history = params.get("messages")
        if not isinstance(history, list) or any(not isinstance(row, dict) for row in history):
            raise ValueError("invalid preview history")
        mode = params.get("run_mode")
        if mode not in {"ask", "auto", "plan", "propose"}:
            raise ValueError("invalid preview mode")
        kernel = container.stack.router
        requested_model = params.get("preferred_model")
        request = None
        if not requested_model or requested_model == kernel._config.model:
            request = ChatRequestContext(
                request_id=params["request_id"],
                trace_id=None,
                session_id=params["session_id"],
                mode="plan" if mode == "plan" else "assist",
                approvals_pre_granted=False,
                execution_context=execution,
                plan_mode=mode == "plan",
                propose_mode=mode == "propose",
                read_only=mode in {"plan", "propose"},
                approval_mode="auto_run" if mode == "auto" else "prompt",
                session_start_date=session_start_date_from_params(params),
                current_date=resolve_current_date(),
                tool_preferences=normalize_tool_preferences(params.get("tool_preferences")),
                context_blocks=tuple(normalize_context_blocks(params.get("context_blocks"))),
                workspace_root_present=execution.workspace_root_present,
            )
    except (ValueError, TypeError):
        response = error_response(
            message_id, code=-32602, message="Invalid context preview request"
        )
        return ProcessOutcome(initialized, False, response, [])
    # Assembly errors are internal, not invalid params: they take the worker's
    # standard internal-error path.
    result = (
        preview_context(kernel, request, history)
        if request is not None
        else {"status": "unavailable", "reason": "model_not_active"}
    )
    return ProcessOutcome(initialized, False, result_response(message_id, result), [])
