"""Tool handler for python_execute."""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import time
from typing import Any

from sidecar.ai.error_codes import (
    CMP_TOOL_PYTHON_EXECUTION_FAILED,
    CMP_TOOL_PYTHON_NOT_AVAILABLE,
)
from sidecar.ai.tools.builtins.python_runtime.interpreter import (
    bootstrap_phase_label,
    configured_bootstrap_budget_seconds,
    configured_memory_limit_mb,
    configured_timeout_seconds,
    ensure_runtime_venv,
    redact_paths,
)
from sidecar.ai.tools.builtins.python_runtime.output import format_python_output
from sidecar.ai.tools.builtins.python_runtime.sandbox import execute_sandboxed
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import log_event

_PYTHON_RUNTIME_CONFIG: Any = {}
logger = logging.getLogger(__name__)


def configure_python_runtime(config: Any) -> None:
    global _PYTHON_RUNTIME_CONFIG
    _PYTHON_RUNTIME_CONFIG = config or {}


def python_execute_tool(
    arguments: dict[str, object], workspace: WorkspaceGuard
) -> ToolHandlerResult:
    code = arguments.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_PYTHON_EXECUTION_FAILED,
            message="tool argument 'code' must be a non-empty string",
            retryable=False,
        )
    try:
        code.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_PYTHON_EXECUTION_FAILED,
            message="tool argument 'code' contains invalid Unicode text that cannot be encoded as UTF-8",
            retryable=False,
        ) from error
    if sys.platform != "win32":
        raise ToolExecutionFailure(
            code=CMP_TOOL_PYTHON_NOT_AVAILABLE,
            message="python runtime is only available on Windows in this build",
            retryable=False,
        )

    config = _PYTHON_RUNTIME_CONFIG
    sandbox_result = None
    try:
        try:
            deadline_monotonic = time.monotonic() + configured_bootstrap_budget_seconds(
                config
            )
            venv_python = ensure_runtime_venv(
                config,
                deadline_monotonic=deadline_monotonic,
            )
        except subprocess.TimeoutExpired as error:
            # The phase context already stamped which step ran out of time
            # and a redacted detail; a pip timeout is the likeliest bootstrap
            # failure, so this branch must not report the coarsest phase.
            failed_phase = str(getattr(error, "failed_phase", "") or "").strip() or "bootstrap"
            raise ToolExecutionFailure(
                code=CMP_TOOL_PYTHON_EXECUTION_FAILED,
                message=(
                    "python runtime bootstrap timed out during "
                    f"{bootstrap_phase_label(failed_phase)}"
                ),
                retryable=True,
                error_details={
                    "failed_phase": failed_phase,
                    "failure_class": "limit_exceeded",
                    "error_type": type(error).__name__,
                    "error_message": redact_paths(
                        str(getattr(error, "bootstrap_error_message", None) or error)
                    ),
                    "phase_timings_json": getattr(error, "phase_timings_json", "") or "{}",
                },
            ) from error
        workspace_root = workspace.root
        if workspace_root is not None and not workspace_root.is_dir():
            workspace_root = None
        working_directory_kind = (
            "workspace_root" if workspace_root is not None else "scratch_fallback"
        )
        log_event(
            logger,
            logging.INFO,
            component="ai.tools.python_runtime",
            event="ai.tools.python_runtime.execution.started",
            message="Python runtime execution started.",
            status="ok",
            data={"working_directory_kind": working_directory_kind},
        )
        sandbox_result = execute_sandboxed(
            code=code,
            venv_python=venv_python,
            timeout_seconds=configured_timeout_seconds(config),
            memory_limit_mb=configured_memory_limit_mb(config),
            working_directory=workspace_root,
        )
        payload, trusted_attachments = format_python_output(
            sandbox_result.payload,
            sandbox_result.work_dir,
        )
        success = payload.get("error") is None and sandbox_result.returncode == 0
        return ToolHandlerResult(
            output=json.dumps(payload, ensure_ascii=False, indent=2),
            success=bool(success),
            trusted_attachments=trusted_attachments,
        )
    except ToolExecutionFailure:
        raise
    except subprocess.TimeoutExpired as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_PYTHON_EXECUTION_FAILED,
            message=f"python execution timed out after {configured_timeout_seconds(config)}s",
            retryable=True,
        ) from error
    except Exception as error:  # noqa: BLE001
        failed_phase = str(getattr(error, "failed_phase", "") or "").strip()
        phase_label = bootstrap_phase_label(failed_phase)
        # Redact here, not only in the phase context: a lock timeout, a
        # locked-tree OSError or a mkdir failure raises between phases and
        # carries the raw path in str(error).
        error_message = redact_paths(
            str(getattr(error, "bootstrap_error_message", None) or error)
        )
        remediation = str(getattr(error, "remediation", "") or "").strip()
        raise ToolExecutionFailure(
            code=CMP_TOOL_PYTHON_EXECUTION_FAILED,
            message=(
                f"python runtime bootstrap failed during {phase_label}"
                if phase_label
                else "python runtime setup or execution failed before producing a result"
            ),
            retryable=isinstance(error, OSError),
            error_details={
                "failed_phase": failed_phase,
                "error_type": type(error).__name__,
                "error_message": error_message,
                "phase_timings_json": getattr(error, "phase_timings_json", "") or "{}",
                "failure_class": "unavailable" if failed_phase else "",
                **({"remediation": remediation} if remediation else {}),
            },
        ) from error
    finally:
        if sandbox_result is not None:
            try:
                sandbox_result.cleanup()
            except Exception as cleanup_error:  # noqa: BLE001 - preserve primary outcome.
                log_event(
                    logger,
                    logging.WARNING,
                    component="ai.tools.python_runtime",
                    event="ai.tools.python_runtime.cleanup_degraded",
                    message="Python runtime scratch cleanup failed after execution.",
                    status="degraded",
                    data={"error_type": type(cleanup_error).__name__},
                )
