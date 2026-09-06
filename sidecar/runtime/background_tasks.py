"""Internal background automation dispatch for Electron-owned scheduler hooks."""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.runtime.automation_runner import (
    _normalize_runtime_budget_ms,
    bounded_text,
    resolve_automation_result_path,
)

AUTOMATION_RUN_TASK_NAME = "automation_run"
logger = logging.getLogger(__name__)


def _automation_task_key(params: dict[str, Any]) -> str:
    run_id = bounded_text(params.get("run_id"), 200)
    return f"automation:{run_id or 'unknown'}"


def _start_automation_worker(  # noqa: PLR0911
    *,
    params: dict[str, Any],
    config: RuntimeConfig,
    raw_config: dict[str, Any],
    subprocess_manager: Any,
    secrets: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not bool(getattr(config, "tools_automations_enabled", False)):
        return {
            "status": "skipped",
            "task": AUTOMATION_RUN_TASK_NAME,
            "reason": "feature_disabled",
        }
    if subprocess_manager is None:
        return {
            "status": "skipped",
            "task": AUTOMATION_RUN_TASK_NAME,
            "reason": "manager_unavailable",
        }
    if not isinstance(params, dict):
        return {
            "status": "skipped",
            "task": AUTOMATION_RUN_TASK_NAME,
            "reason": "invalid_payload",
        }
    snapshot = params.get("automation")
    if not isinstance(snapshot, dict):
        return {
            "status": "skipped",
            "task": AUTOMATION_RUN_TASK_NAME,
            "reason": "invalid_payload",
        }
    run_id = bounded_text(params.get("run_id") or snapshot.get("run_id"), 200)
    if not run_id:
        return {
            "status": "skipped",
            "task": AUTOMATION_RUN_TASK_NAME,
            "reason": "invalid_payload",
        }
    try:
        result_path = resolve_automation_result_path(params.get("result_path"), config)
    except ValueError:
        return {
            "status": "skipped",
            "task": AUTOMATION_RUN_TASK_NAME,
            "reason": "invalid_result_path",
        }
    task_key = _automation_task_key({"run_id": run_id})
    if subprocess_manager.is_task_running(task_key):
        return {
            "status": "started",
            "task": AUTOMATION_RUN_TASK_NAME,
            "reason": "already_running",
            "run_id": run_id,
            "started_at": bounded_text(params.get("started_at"), 200),
            "result_ref": bounded_text(params.get("result_ref"), 200),
        }
    budget_ms = _normalize_runtime_budget_ms(snapshot.get("runtime_budget_ms"))
    normalized_snapshot = dict(snapshot)
    normalized_snapshot["runtime_budget_ms"] = budget_ms
    payload = {
        "config": dict(raw_config) if isinstance(raw_config, dict) else {},
        "task_name": AUTOMATION_RUN_TASK_NAME,
        "run_id": run_id,
        "started_at": bounded_text(params.get("started_at"), 200),
        "result_path": str(result_path),
        "result_ref": bounded_text(params.get("result_ref"), 200),
        "automation": normalized_snapshot,
    }
    try:
        subprocess_manager.spawn_json_worker(
            AUTOMATION_RUN_TASK_NAME,
            payload,
            payload_dir=result_path.parent,
            task_key=task_key,
            secrets=secrets,
            timeout_seconds=budget_ms / 1000,
        )
    except Exception:
        logger.exception("failed to start automation worker")
        return {
            "status": "failed",
            "task": AUTOMATION_RUN_TASK_NAME,
            "reason": "spawn_failed",
        }
    return {
        "status": "started",
        "task": AUTOMATION_RUN_TASK_NAME,
        "run_id": run_id,
        "started_at": bounded_text(params.get("started_at"), 200),
        "result_ref": bounded_text(params.get("result_ref"), 200),
    }


def run_background_task(  # noqa: PLR0913 - one flat dispatch seam, all keyword-only.
    *,
    task: str,
    params: dict[str, Any],
    config: RuntimeConfig,
    raw_config: dict[str, Any],
    subprocess_manager: Any,
    secrets: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_task = str(task or "").strip().lower()
    if normalized_task == AUTOMATION_RUN_TASK_NAME:
        return _start_automation_worker(
            params=params,
            config=config,
            raw_config=raw_config,
            subprocess_manager=subprocess_manager,
            secrets=secrets,
        )
    return {"status": "skipped", "task": normalized_task, "reason": "unknown_task"}


__all__ = ["AUTOMATION_RUN_TASK_NAME", "run_background_task"]
