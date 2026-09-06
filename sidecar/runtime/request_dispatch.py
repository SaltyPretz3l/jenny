"""JSON-RPC method dispatch helpers for sidecar server runtime."""

from __future__ import annotations

import logging
from time import perf_counter
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.engines.catalog import models_for_engine, resolve_ollama_base_url
from sidecar.ai.engines.ollama_model_info import resolve_ollama_model_blob
from sidecar.ai.error_codes import (
    CMP_CHAT_INVALID_PARAMS,
    CMP_PLUGIN_FEATURE_DISABLED,
    CMP_PLUGIN_OUTCOME_INDETERMINATE,
    CMP_PROTO_VERSION_MISMATCH,
    CMP_SRV_INITIALIZE_FAILED,
)
from sidecar.ai.feature_flags import is_feature_flag_enabled  # noqa: F401
from sidecar.ai.mode_policy import policy_for_mode  # noqa: F401
from sidecar.ai.tools.catalog import build_tool_catalog  # noqa: F401
from sidecar.protocol import (
    API_VERSION,
    CHAT_SEND_METHOD,
    HARDWARE_PROFILE_METHOD,
    HARDWARE_VRAM_USAGE_METHOD,
    INITIALIZE_METHOD,
    JSONRPC_VERSION,
    MODELS_LIST_METHOD,
    MODELS_OLLAMA_BLOB_METHOD,
    MODELS_RESIDENT_METHOD,
    MODELS_UNLOAD_METHOD,
    PLUGIN_RUNTIME_APPLIED_METHOD,
    RUNTIME_PROGRESS_METHOD,
    SHUTDOWN_METHOD,
)
from sidecar.runtime.approval import request_tool_approval  # noqa: F401
from sidecar.runtime.approval_plan import ApprovalPlanCache
from sidecar.runtime.capabilities import initialize_response, models_list_result
from sidecar.runtime.chat import (
    build_chat_send_response,  # noqa: F401
    resume_chat_send_response_from_approval_plan,  # noqa: F401
)
from sidecar.runtime.diagnostics import (
    apply_logging_preferences,
    correlation_from_params,
    diagnostics_context,
    emit_startup_audit_mark,
    log_event,
)
from sidecar.runtime.initialize_mode import PLUGIN_RUNTIME_MODE, resolve_initialize_mode
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.request_dispatch_background import process_background_method
from sidecar.runtime.request_dispatch_commit import process_commit_method
from sidecar.runtime.request_dispatch_compact import process_compact_method
from sidecar.runtime.request_dispatch_harness import process_harness_method
from sidecar.runtime.request_dispatch_inline import process_inline_method
from sidecar.runtime.request_dispatch_mcp import process_mcp_method
from sidecar.runtime.request_dispatch_memory import process_memory_method
from sidecar.runtime.request_dispatch_suggestions import process_suggestions_method
from sidecar.runtime.rpc import (
    error_response,
    notification,
    result_response,
    validate_accept_version,
    validate_method_version,
)
from sidecar.runtime.telemetry import configure_telemetry, telemetry_status
from sidecar.runtime.turn_retry import (
    InnerRetryableTurnError,  # noqa: F401
)
from sidecar.runtime.turn_state import (  # noqa: F401
    TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
    TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
    TURN_STATE_CANCELLED,
    TURN_STATE_PREEMPTED,
    TURN_STATE_RUNTIME_ERROR,
    TURN_STATE_TIMEOUT,
)

NOT_INITIALIZED_CODE = -32002
METHOD_NOT_FOUND_CODE = -32601
INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
INITIALIZE_FAILED = CMP_SRV_INITIALIZE_FAILED
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH
MAX_REASON_CODE_LENGTH = 64
_PLUGIN_RUNTIME_SCHEMA_V6 = 6
_APPROVAL_PLAN_CACHE = ApprovalPlanCache()

# Re-export the chat-send cluster moved out to the sibling modules so that
# ``from sidecar.runtime.request_dispatch import X`` and the
# ``sidecar.runtime.request_dispatch.X`` monkeypatch targets tests rely on keep
# resolving on this hub. The moved code late-binds these (and the patch anchors
# above) through ``import sidecar.runtime.request_dispatch as _rd_hub`` so a patch
# set here is honored at call time. Import direction: support <- chat <- hub.
from sidecar.runtime.request_dispatch_chat import process_chat_send_request  # noqa: E402,F401
from sidecar.runtime.request_dispatch_chat_support import (  # noqa: E402,F401
    _approval_terminal_log_fields,
    _build_chat_response,
    _chat_unexpected_failure_outcome,
    _emit_canonical_notification,
    _emit_phase_notification,
    _normalize_approval_resolution,
    _post_approval_retryable_terminal_outcome,
    _request_tool_preference_set,
    _validate_chat_send_semantics,
    _workspace_required_tool_names,
    _workspace_root_configured,
)


def _resolve_resident_models_engine(brain_container: Any) -> Any:
    """Pick the OllamaEngine to query for `/api/ps` residency data.

    Prefers the active stack engine when it is already an OllamaEngine (no
    extra daemon round-trip / duplicate instance); otherwise falls back to a
    transient Ollama engine against the app-managed daemon, same as the FIM
    completion menu's live-loaded indicator (see
    sidecar.runtime.inline_completion._build_ollama_fallback_engine). Returns
    None if neither is available.
    """
    try:
        from sidecar.ai.engines.ollama import OllamaEngine  # noqa: PLC0415

        stack = getattr(brain_container, "stack", None)
        engine = getattr(stack, "engine", None)
        if isinstance(engine, OllamaEngine):
            return engine
    except Exception:  # noqa: BLE001
        pass
    try:
        from sidecar.runtime.inline_completion import (  # noqa: PLC0415
            _build_ollama_fallback_engine,
        )

        return _build_ollama_fallback_engine()
    except Exception:  # noqa: BLE001
        return None


def _build_models_resident_payload(brain_container: Any) -> dict[str, Any]:
    """Build the `models.resident` RPC result.

    ``{"available": bool, "reason": str, "models": [...]}``. Never raises --
    any failure to reach Ollama degrades to ``available: false`` with a reason
    string so the caller (electron-side model-fit observer) can skip cleanly.
    """
    engine = _resolve_resident_models_engine(brain_container)
    lister = getattr(engine, "list_resident_models", None)
    if not callable(lister):
        return {"available": False, "reason": "ollama_engine_unavailable", "models": []}
    try:
        models = lister()
    except Exception as error:  # noqa: BLE001
        return {"available": False, "reason": str(error) or "list_resident_models_failed", "models": []}
    return {"available": True, "reason": "", "models": models}


def _unload_engine_model(stack: Any) -> str:
    """Evict the stack's bound chat model and return the tag that was unloaded.

    The tag is passed EXPLICITLY to ``unload_model``. An operator-initiated
    ``models.unload`` is an intentional eviction, and the engine's shared-daemon
    residency refcount deliberately suppresses a redundant ``keep_alive: 0``
    when another generation still holds the model -- passing the tag bypasses
    that suppression so a user-visible unload is never silently skipped.
    An empty tag keeps the no-arg form, whose blank-target branch still resets
    the engine's loaded-state bookkeeping.
    """
    engine = stack.engine
    unloaded_model = str(getattr(engine, "model_name", "") or "")
    if unloaded_model:
        engine.unload_model(unloaded_model)
    else:
        engine.unload_model()
    return unloaded_model


def _unload_failure_category(error: BaseException) -> str | None:
    """Return "timeout" when the eviction timed out, so callers can tell it apart.

    An eviction that timed out leaves GPU residency UNKNOWN, while a refused
    connection means nothing is resident. Electron's engine switch aborts on the
    first and proceeds on the second, so the distinction has to survive the wire:
    without it every unload failure arrives as a generic CMP-SIDECAR-0005 and the
    switch double-loads the GPU. The engine wraps the socket timeout in
    GenerationError, so walk the cause chain rather than the outermost type.
    """
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, TimeoutError):
            return "timeout"
        current = current.__cause__ or current.__context__
    return None


def _unload_stack_engine_under_lease(brain_container: Any) -> str:
    """Read the model tag and unload it against ONE stack generation.

    Without the lease, the tag read and the unload call could straddle a
    ``configure()`` publish: the reported ``unloaded_model`` would name the old
    generation's model while the eviction hit the new one's engine.
    """
    lease = getattr(brain_container, "stack_lease", None)
    if not callable(lease):
        return _unload_engine_model(brain_container.stack)
    with lease() as leased_stack:
        return _unload_engine_model(leased_stack)


def _apply_telemetry_config(params: Any) -> dict[str, Any]:
    if not isinstance(params, dict):
        return telemetry_status()
    config = params.get("config")
    if not isinstance(config, dict):
        return telemetry_status()
    secrets = params.get("secrets")
    dsn = ""
    if isinstance(secrets, dict) and secrets.get("telemetry_dsn") is not None:
        dsn = str(secrets.get("telemetry_dsn", ""))
    else:
        dsn = str(config.get("telemetry_dsn", ""))
    configure_telemetry(
        dsn=dsn,
        consent="opt_in" if config.get("crash_reporting_opt_in") else "opt_out",
        app_version=str(params.get("client_version", "")),
    )
    return telemetry_status()


def _plugin_runtime_initialize_error(
    message_id: Any,
    *,
    code: str,
    reason: str,
    rejected_contributions: object = (),
) -> dict[str, Any]:
    safe_reason = (
        reason
        if reason.replace("_", "").isalnum() and len(reason) <= MAX_REASON_CODE_LENGTH
        else "runtime_apply_failed"
    )
    data: dict[str, Any] = {"code": code, "reason": safe_reason, "retryable": False}
    if isinstance(rejected_contributions, (list, tuple)) and rejected_contributions:
        data["rejected_contributions"] = list(rejected_contributions)[:16]
    return error_response(
        message_id,
        code=INVALID_PARAMS_CODE,
        message="plugin runtime initialize rejected",
        data=data,
    )


def _process_plugin_runtime_initialize(
    *,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> ProcessOutcome:
    if not initialized:
        return ProcessOutcome(
            initialized=False,
            shutdown_requested=False,
            response=_plugin_runtime_initialize_error(
                message_id,
                code=CMP_PLUGIN_FEATURE_DISABLED,
                reason="plugin_runtime_requires_full_initialization",
            ),
            notifications=[],
        )
    runtime = params.get("plugin_runtime") if isinstance(params, dict) else None
    snapshot = runtime.get("snapshot") if isinstance(runtime, dict) else None
    is_v6 = isinstance(snapshot, dict) and snapshot.get("runtime_schema_version") == _PLUGIN_RUNTIME_SCHEMA_V6
    expected_runtime_keys = (
        {"snapshot", "declarative_content", "operation"}
        if is_v6 else {"snapshot", "declarative_content"}
    )
    operation = runtime.get("operation") if isinstance(runtime, dict) else None
    if (
        not isinstance(params, dict)
        or set(params) != {"mode", "plugin_runtime"}
        or not isinstance(runtime, dict)
        or set(runtime) != expected_runtime_keys
        or (is_v6 and operation not in {"prepare", "commit", "abort", "reconcile"})
    ):
        return ProcessOutcome(
            initialized=True,
            shutdown_requested=False,
            response=_plugin_runtime_initialize_error(
                message_id,
                code=CMP_CHAT_INVALID_PARAMS,
                reason="plugin_runtime_envelope_invalid",
            ),
            notifications=[],
        )

    started_at = perf_counter()
    try:
        apply_args: dict[str, Any] = {
            "snapshot": runtime["snapshot"],
            "declarative_content": runtime["declarative_content"],
        }
        if is_v6:
            apply_args["operation"] = str(operation)
        attestation = brain_container.apply_plugin_runtime(**apply_args)
    except Exception as error:  # noqa: BLE001 - domain errors are shape-normalized below
        code = str(getattr(error, "code", CMP_PLUGIN_OUTCOME_INDETERMINATE))
        if not code.startswith("CMP-PLUGIN-"):
            code = CMP_PLUGIN_OUTCOME_INDETERMINATE
        reason = str(getattr(error, "reason_code", "runtime_apply_failed"))
        log_event(
            logger,
            logging.WARNING,
            component="runtime.request_dispatch",
            event="plugin.runtime.apply_rejected",
            message="Plugin runtime apply was rejected",
            status="rejected",
            data={
                "reason_code": (
                    reason if len(reason) <= MAX_REASON_CODE_LENGTH else "runtime_apply_failed"
                ),
                "latency_ms": round((perf_counter() - started_at) * 1000, 3),
            },
        )
        return ProcessOutcome(
            initialized=True,
            shutdown_requested=False,
            response=_plugin_runtime_initialize_error(
                message_id,
                code=code,
                reason=reason,
                rejected_contributions=getattr(error, "rejected_contributions", ()),
            ),
            notifications=[],
        )

    log_event(
        logger,
        logging.INFO,
        component="runtime.request_dispatch",
        event="plugin.runtime.apply_complete",
        message="Plugin runtime apply completed",
        status="ok",
        data={"latency_ms": round((perf_counter() - started_at) * 1000, 3)},
    )
    return ProcessOutcome(
        initialized=True,
        shutdown_requested=False,
        # PluginRuntimeAttestationV1 is frozen. Keep the result/notification
        # payload exact rather than injecting api_version into the contract.
        response={
            "jsonrpc": JSONRPC_VERSION,
            "id": message_id,
            "api_version": API_VERSION,
            "result": attestation,
        },
        notifications=[{
            "jsonrpc": JSONRPC_VERSION,
            "api_version": API_VERSION,
            "method": PLUGIN_RUNTIME_APPLIED_METHOD,
            "params": attestation,
        }],
    )


def process_message(
    message: dict[str, Any],
    initialized: bool,
    *,
    brain_container: BrainContainer,
    logger: logging.Logger,
    write_message: Callable[[dict[str, Any]], None],
    read_message: Callable[[], dict[str, Any]],
) -> ProcessOutcome:
    method = message.get("method", "")
    message_id = message.get("id")
    params = message.get("params")
    request_context = correlation_from_params(params)

    with diagnostics_context(**request_context):
        if method == INITIALIZE_METHOD:
            initialize_started_at = perf_counter()

            # PLUG-D16 fail-closed guard: resolve/validate `mode` before any
            # state mutation. A rejected mode must not apply logging
            # preferences or validate accept_version -- so this runs first,
            # ahead of both. `initialized=initialized` (the incoming
            # parameter, not a hardcoded False) is intentional: a rejected
            # initialize must preserve whatever state the sidecar was already
            # in, not force it back to uninitialized.
            mode_resolution = resolve_initialize_mode(params)
            if not mode_resolution.ok:
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=error_response(
                        message_id,
                        code=INVALID_PARAMS_CODE,
                        message="initialize mode rejected",
                        data={
                            "reason": mode_resolution.reason,
                            "mode": mode_resolution.rejected_mode,
                        },
                    ),
                    notifications=[],
                )

            if mode_resolution.mode == PLUGIN_RUNTIME_MODE:
                return _process_plugin_runtime_initialize(
                    message_id=message_id,
                    params=params,
                    initialized=initialized,
                    brain_container=brain_container,
                    logger=logger,
                )

            # No secret merge here: initialize_response lifts brokered secrets
            # off params["secrets"] itself and never writes them into the config.
            apply_logging_preferences(params.get("config") if isinstance(params, dict) else {})
            emit_startup_audit_mark(logger, "rpc-initialize-start")
            log_event(
                logger,
                logging.INFO,
                component="runtime.request_dispatch",
                event="sidecar.runtime.initialize.start",
                message="Processing initialize request",
                status="start",
            )
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

            try:
                request_id = (
                    str(params.get("request_id") or "").strip()
                    if isinstance(params, dict)
                    else ""
                )

                def emit_runtime_progress(progress: dict[str, Any]) -> None:
                    if request_id:
                        write_message(
                            notification(
                                RUNTIME_PROGRESS_METHOD,
                                {**progress, "request_id": request_id},
                            )
                        )

                initialize_payload = initialize_response(
                    message_id,
                    params,
                    api_version=API_VERSION,
                    brain_container=brain_container,
                    progress_callback=emit_runtime_progress if request_id else None,
                )
            except Exception as error:  # noqa: BLE001
                logger.exception("initialize failed")
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=error_response(
                        message_id,
                        code=INTERNAL_ERROR_CODE,
                        message="initialize failed",
                        data={"code": INITIALIZE_FAILED, "detail": str(error)},
                    ),
                    notifications=[],
                )

            telemetry_payload = _apply_telemetry_config(params)
            if isinstance(initialize_payload.get("result"), dict):
                initialize_payload["result"]["telemetry"] = telemetry_payload
            log_event(
                logger,
                logging.INFO,
                component="runtime.request_dispatch",
                event="sidecar.runtime.initialize.complete",
                message="initialize request completed",
                status="ok",
            )
            emit_startup_audit_mark(
                logger,
                "rpc-initialize-end",
                duration_ms=(perf_counter() - initialize_started_at) * 1000,
            )
            return ProcessOutcome(
                initialized=True,
                shutdown_requested=False,
                response=initialize_payload,
                notifications=[],
            )

        if method == SHUTDOWN_METHOD:
            log_event(
                logger,
                logging.INFO,
                component="runtime.request_dispatch",
                event="sidecar.runtime.shutdown",
                message="shutdown requested",
                status="start",
            )
            version_error = validate_method_version(
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
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=True,
                response=result_response(
                    message_id,
                    {
                        "status": "shutting_down",
                    },
                ),
                notifications=[],
            )

        if not initialized:
            logger.warning("request before initialize: %s", method)
            if message_id is None:
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=None,
                    notifications=[],
                )
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=error_response(
                    message_id,
                    code=NOT_INITIALIZED_CODE,
                    message="sidecar not initialized",
                ),
                notifications=[],
            )

        if method == MODELS_LIST_METHOD:
            log_event(
                logger,
                logging.DEBUG,
                component="runtime.request_dispatch",
                event="sidecar.runtime.models_list",
                message="Processing models.list request",
                status="start",
            )
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
            models_params: Any = dict(params) if isinstance(params, dict) else {}
            models_params["_runtime_config"] = brain_container.stack.config
            models_params["_plugin_engine_models"] = brain_container._plugin_engine_model_ids()
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=result_response(
                    message_id,
                    models_list_result(models_params, models_for_engine=models_for_engine),
                ),
                notifications=[],
            )

        if method == MODELS_UNLOAD_METHOD:
            log_event(
                logger,
                logging.INFO,
                component="runtime.request_dispatch",
                event="sidecar.runtime.models_unload",
                message="Processing models.unload request",
                status="start",
            )
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
                unloaded_model = _unload_stack_engine_under_lease(brain_container)
            except Exception as error:  # noqa: BLE001
                logger.exception("models.unload failed")
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=error_response(
                        message_id,
                        code=INTERNAL_ERROR_CODE,
                        message="models.unload failed",
                        data={
                            "detail": str(error),
                            **(
                                {"category": category}
                                if (category := _unload_failure_category(error))
                                else {}
                            ),
                        },
                    ),
                    notifications=[],
                )
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=result_response(
                    message_id,
                    {
                        "status": "ok",
                        "model": "",
                        "unloaded_model": unloaded_model,
                    },
                ),
                notifications=[],
            )

        background_outcome = process_background_method(
            method, message_id, params, initialized, brain_container, logger
        )
        if background_outcome is not None:
            return background_outcome

        memory_outcome = process_memory_method(
            method, message_id, params, initialized, brain_container, logger
        )
        if memory_outcome is not None:
            return memory_outcome

        mcp_outcome = process_mcp_method(
            method, message_id, params, initialized, brain_container, logger
        )
        if mcp_outcome is not None:
            return mcp_outcome

        # Lazy: the recovery family drags restore/staging into the import graph and
        # only runs on a user click, so it stays off the sidecar startup path.
        from sidecar.runtime.workspace_recovery_rpc import (  # noqa: PLC0415
            process_workspace_recovery_method,
        )

        recovery_outcome = process_workspace_recovery_method(
            method, message_id, params, initialized, brain_container, logger
        )
        if recovery_outcome is not None:
            return recovery_outcome

        harness_outcome = process_harness_method(
            method,
            message_id,
            params,
            initialized,
            brain_container,
        )
        if harness_outcome is not None:
            return harness_outcome

        suggestions_outcome = process_suggestions_method(
            method, message_id, params, initialized, brain_container, logger
        )
        if suggestions_outcome is not None:
            return suggestions_outcome

        commit_outcome = process_commit_method(
            method, message_id, params, initialized, brain_container, logger
        )
        if commit_outcome is not None:
            return commit_outcome

        compact_outcome = process_compact_method(
            method, message_id, params, initialized, brain_container, logger
        )
        if compact_outcome is not None:
            return compact_outcome

        inline_outcome = process_inline_method(
            method, message_id, params, initialized, brain_container, logger
        )
        if inline_outcome is not None:
            return inline_outcome

        if method == HARDWARE_PROFILE_METHOD:
            log_event(
                logger,
                logging.INFO,
                component="runtime.request_dispatch",
                event="sidecar.runtime.hardware_profile",
                message="Processing hardware.profile request",
                status="start",
            )
            if message_id is None:
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=None,
                    notifications=[],
                )
            version_error = validate_method_version(
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
            try:
                from sidecar.runtime.hardware_profile import get_hardware_profile

                ollama_host = getattr(brain_container.stack.config, "api_url", None)
                model_catalog = params.get("model_catalog") if isinstance(params, dict) else None
                profile = get_hardware_profile(
                    ollama_host=ollama_host, model_catalog=model_catalog
                )
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=result_response(message_id, profile.to_dict()),
                    notifications=[],
                )
            except Exception as error:  # noqa: BLE001
                logger.exception("hardware.profile failed")
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=error_response(
                        message_id,
                        code=INTERNAL_ERROR_CODE,
                        message="hardware.profile failed",
                        data={"detail": str(error)},
                    ),
                    notifications=[],
                )

        if method == HARDWARE_VRAM_USAGE_METHOD:
            log_event(
                logger,
                logging.INFO,
                component="runtime.request_dispatch",
                event="sidecar.runtime.hardware_vram_usage",
                message="Processing hardware.vram_usage request",
                status="start",
            )
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
                from sidecar.runtime.hardware_vram_usage import get_vram_usage

                payload = get_vram_usage()
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=result_response(message_id, payload),
                    notifications=[],
                )
            except Exception:  # noqa: BLE001
                logger.exception("hardware.vram_usage failed")
                return ProcessOutcome(
                    initialized=initialized,
                    shutdown_requested=False,
                    response=result_response(
                        message_id,
                        {
                            "available": False,
                            "used_mb": 0,
                            "total_mb": 0,
                            "util_available": False,
                            "util_percent": 0,
                            "gpu_type": "",
                            "source": "runtime_fallback",
                        },
                    ),
                    notifications=[],
                )

        if method == MODELS_RESIDENT_METHOD:
            log_event(
                logger,
                logging.INFO,
                component="runtime.request_dispatch",
                event="sidecar.runtime.models_resident",
                message="Processing models.resident request",
                status="start",
            )
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
                payload = _build_models_resident_payload(brain_container)
            except Exception:  # noqa: BLE001
                logger.exception("models.resident failed")
                payload = {"available": False, "reason": "internal_error", "models": []}
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=result_response(message_id, payload),
                notifications=[],
            )

        if method == MODELS_OLLAMA_BLOB_METHOD:
            log_event(
                logger,
                logging.DEBUG,
                component="runtime.request_dispatch",
                event="sidecar.runtime.models_ollama_blob",
                message="Processing models.ollama_blob request",
                status="start",
            )
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
            model_id = params.get("model_id") if isinstance(params, dict) else None
            try:
                engine = _resolve_resident_models_engine(brain_container)
                if engine is None:
                    payload = {
                        "model_id": str(model_id or ""),
                        "available": False,
                        "blob_path": "",
                        "mmproj_path": "",
                        "reason": "provider_unavailable",
                    }
                else:
                    payload = resolve_ollama_model_blob(
                        host=resolve_ollama_base_url(getattr(engine, "host", None)),
                        model_id=model_id,
                    )
            except Exception:  # noqa: BLE001
                logger.exception("models.ollama_blob failed")
                payload = {
                    "model_id": str(model_id or ""),
                    "available": False,
                    "blob_path": "",
                    "mmproj_path": "",
                    "reason": "internal_error",
                }
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=result_response(message_id, payload),
                notifications=[],
            )

        if method == CHAT_SEND_METHOD:
            return process_chat_send_request(
                message_id=message_id,
                params=params,
                initialized=initialized,
                interactive_approval=False,
                brain_container=brain_container,
                logger=logger,
                write_message=write_message,
                read_message=read_message,
            )

        if message_id is None:
            return ProcessOutcome(
                initialized=initialized,
                shutdown_requested=False,
                response=None,
                notifications=[],
            )

        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=error_response(
                message_id,
                code=METHOD_NOT_FOUND_CODE,
                message=f"unknown method: {method}",
            ),
            notifications=[],
        )
