"""Harness inspection method dispatch helpers."""

from __future__ import annotations

import json
import logging
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import (
    CMP_HARNESS_TURN_NOT_FOUND,
    CMP_PROTO_VERSION_MISMATCH,
)
from sidecar.ai.tools.builtins.web import web_search_tool
from sidecar.protocol import HARNESS_INSPECT_METHOD, HARNESS_TURN_DIAGNOSTIC_METHOD
from sidecar.runtime.diagnostics import correlation_from_params, sanitize_diagnostic_text
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

_LOGGER = logging.getLogger(__name__)

INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
HARNESS_TURN_NOT_FOUND_CODE = -32001
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH


def _probe_web_search_provider() -> dict[str, Any]:
    """Return a bounded, redacted provider check without failing diagnostics."""
    try:
        probe = web_search_tool(
            {"query": "Jenny web provider connectivity test", "timeout_s": 5},
            None,
        )
        try:
            probe_payload = json.loads(str(probe.output or "{}"))
        except (TypeError, ValueError):
            probe_payload = {}
        sources = probe_payload.get("sources")
        return {
            "ok": probe.success is True,
            "provider": str(probe_payload.get("provider") or "")[:32],
            "result_count": min(len(sources) if isinstance(sources, list) else 0, 10),
            "error": sanitize_diagnostic_text(
                str(probe_payload.get("error") or ""), limit=160
            ),
        }
    except Exception as error:  # noqa: BLE001
        _LOGGER.warning(
            "Web search provider connection test failed",
            extra={
                "layer": "sidecar",
                "component": "runtime.request_dispatch_harness",
                "event": "sidecar.harness.web_search_probe.failed",
                "status": "degraded",
                "data": {"error_type": type(error).__name__},
            },
        )
        return {
            "ok": False,
            "provider": "",
            "result_count": 0,
            "error": "Connection test failed.",
        }


def _outcome(response: Any, initialized: bool) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=response,
        notifications=[],
    )


def _correlation_payload(params: Any) -> dict[str, str]:
    return {
        key: value
        for key, value in correlation_from_params(params).items()
        if isinstance(value, str) and value.strip()
    }


def _harness_internal_error_outcome(
    *,
    message_id: Any,
    event: str,
    display_message: str,
    error: Exception,
    correlation: dict[str, str],
    initialized: bool,
) -> ProcessOutcome:
    sanitized_detail = sanitize_diagnostic_text(str(error), limit=256)
    _LOGGER.exception(
        display_message,
        extra={
            "layer": "sidecar",
            "component": "runtime.request_dispatch_harness",
            "event": event,
            "status": "failure",
            "data": {
                "error_type": type(error).__name__,
                "error_message": sanitized_detail,
            },
            **correlation,
        },
    )
    return _outcome(
        error_response(
            message_id,
            code=INTERNAL_ERROR_CODE,
            message=display_message,
            data={"detail": sanitized_detail, **correlation},
        ),
        initialized,
    )


def _harness_precheck(
    *,
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    require_params_dict: bool,
    invalid_params_message: str,
) -> ProcessOutcome | None:
    version_error = validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
    )
    if version_error is not None:
        return _outcome(version_error, initialized)
    if message_id is None:
        return _outcome(None, initialized)
    if require_params_dict:
        if not isinstance(params, dict):
            return _outcome(
                error_response(
                    message_id,
                    code=INVALID_PARAMS_CODE,
                    message=invalid_params_message,
                    data={"detail": "params must be an object with a request_id field."},
                ),
                initialized,
            )
    elif params is not None and not isinstance(params, dict):
        return _outcome(
            error_response(
                message_id,
                code=INVALID_PARAMS_CODE,
                message=invalid_params_message,
                data={"detail": "params must be an object."},
            ),
            initialized,
        )
    return None


def process_harness_method(
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
) -> ProcessOutcome | None:
    if method == HARNESS_INSPECT_METHOD:
        return _process_harness_inspect(
            message_id=message_id,
            params=params,
            initialized=initialized,
            brain_container=brain_container,
        )
    if method == HARNESS_TURN_DIAGNOSTIC_METHOD:
        return _process_harness_turn_diagnostic(
            message_id=message_id,
            params=params,
            initialized=initialized,
            brain_container=brain_container,
        )
    return None


def _process_harness_inspect(
    *,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
) -> ProcessOutcome:
    precheck = _harness_precheck(
        method=HARNESS_INSPECT_METHOD,
        message_id=message_id,
        params=params,
        initialized=initialized,
        require_params_dict=False,
        invalid_params_message="harness.inspect invalid params",
    )
    if precheck is not None:
        return precheck
    try:
        snapshot = brain_container.stack.harness_snapshot_builder.inspect(
            sections=params.get("sections") if isinstance(params, dict) else None,
            include_recent_history=(
                params.get("include_recent_history", True) if isinstance(params, dict) else True
            ),
            recent_history_limit=(
                params.get("recent_history_limit", 5) if isinstance(params, dict) else 5
            ),
            include_disabled=(
                params.get("include_disabled", True) if isinstance(params, dict) else True
            ),
        )
        if isinstance(params, dict) and params.get("web_search_probe") is True:
            snapshot["web_search_probe"] = _probe_web_search_provider()
    except Exception as error:  # noqa: BLE001
        return _harness_internal_error_outcome(
            message_id=message_id,
            event="sidecar.harness.inspect.failed",
            display_message="harness.inspect failed",
            error=error,
            correlation=_correlation_payload(params),
            initialized=initialized,
        )
    return _outcome(result_response(message_id, snapshot), initialized)


def _process_harness_turn_diagnostic(
    *,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
) -> ProcessOutcome:
    precheck = _harness_precheck(
        method=HARNESS_TURN_DIAGNOSTIC_METHOD,
        message_id=message_id,
        params=params,
        initialized=initialized,
        require_params_dict=True,
        invalid_params_message="harness.turn_diagnostic invalid params",
    )
    if precheck is not None:
        return precheck
    request_id = str(params.get("request_id") or "").strip()
    if not request_id:
        return _outcome(
            error_response(
                message_id,
                code=INVALID_PARAMS_CODE,
                message="harness.turn_diagnostic missing request_id",
                data={"detail": "params.request_id is required."},
            ),
            initialized,
        )
    try:
        snapshot = brain_container.stack.turn_diagnostics.get_snapshot_for_request(
            request_id=request_id,
        )
    except Exception as error:  # noqa: BLE001
        return _harness_internal_error_outcome(
            message_id=message_id,
            event="sidecar.harness.turn_diagnostic.failed",
            display_message="harness.turn_diagnostic failed",
            error=error,
            correlation={
                **_correlation_payload(params),
                "request_id": request_id,
            },
            initialized=initialized,
        )
    if snapshot is None:
        return _outcome(
            error_response(
                message_id,
                code=HARNESS_TURN_NOT_FOUND_CODE,
                message="harness.turn_diagnostic: no diagnostics for request_id",
                data={
                    "error_code": CMP_HARNESS_TURN_NOT_FOUND,
                    "request_id": request_id,
                },
            ),
            initialized,
        )
    return _outcome(
        result_response(message_id, {"provider_diagnostics": snapshot}),
        initialized,
    )
