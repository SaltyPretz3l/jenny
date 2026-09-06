"""Detached read-only automation runner for Electron-owned schedules."""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

from sidecar.ai.config import RuntimeConfig, parse_runtime_config, resolve_background_runtime_root
from sidecar.ai.container import BrainContainer
from sidecar.ai.tools.catalog import infer_tool_family
from sidecar.ai.tools.registry import build_default_registry
from sidecar.protocol import CHAT_TOKEN_METHOD, TOOL_RESULT_METHOD
from sidecar.runtime.chat import CHAT_INVALID_PARAMS, build_chat_send_response
from sidecar.runtime.chat_models import ChatRequestError, ChatResponse
from sidecar.runtime.worker_secrets import merge_config_secrets

logger = logging.getLogger(__name__)

RESULT_VERSION = 1
MAX_SUMMARY_LENGTH = 2_000
MAX_TEXT_LENGTH = 4_000
MAX_TOKEN_LENGTH = 128
MAX_ARTIFACTS = 20


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def bounded_text(value: Any, limit: int = MAX_TOKEN_LENGTH) -> str:
    return str(value or "").strip()[:limit]


def sanitize_automation_worker_config(raw_config: Any) -> dict[str, Any]:
    source = dict(raw_config) if isinstance(raw_config, dict) else {}
    source["electron_tool_bridge_enabled"] = False
    source["tools_worktree_enabled"] = False
    source["tools_automations_enabled"] = False
    return source


def _is_path_within_root(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


def resolve_automation_result_path(raw_path: Any, config: RuntimeConfig) -> Path:
    token = str(raw_path or "").strip()
    if not token:
        raise ValueError("result_path is required")
    root = (resolve_background_runtime_root(config) / "automations").expanduser().resolve()
    candidate = Path(token).expanduser()
    if not candidate.is_absolute():
        raise ValueError("result_path must be absolute")
    resolved = candidate.resolve(strict=False)
    if not _is_path_within_root(resolved, root):
        raise ValueError("result_path must be inside background_runtime_root/automations")
    return resolved


def enabled_tools_for_grants(config: RuntimeConfig, grants: Iterable[str]) -> tuple[str, ...]:
    granted_families = {
        str(grant or "").strip().lower()
        for grant in grants
        if str(grant or "").strip()
    }
    if not granted_families:
        return ()
    registry = build_default_registry(config=config)
    enabled: list[str] = []
    for name, definition in sorted(registry.items()):
        if definition.side_effecting:
            continue
        if infer_tool_family(name) in granted_families:
            enabled.append(name)
    return tuple(enabled)


def _normalize_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    snapshot = payload.get("automation")
    if not isinstance(snapshot, dict):
        raise ValueError("automation snapshot is required")
    run_id = bounded_text(snapshot.get("run_id") or payload.get("run_id"))
    automation_id = bounded_text(snapshot.get("automation_id") or payload.get("automation_id"))
    task_spec = bounded_text(snapshot.get("task_spec"), MAX_TEXT_LENGTH)
    if not run_id:
        raise ValueError("automation.run_id is required")
    if not automation_id:
        raise ValueError("automation.automation_id is required")
    if not task_spec:
        raise ValueError("automation.task_spec is required")
    raw_grants = snapshot.get("tool_grants")
    tool_grants = [
        bounded_text(item).lower()
        for item in (raw_grants if isinstance(raw_grants, list) else [])
        if bounded_text(item)
    ][:20]
    raw_isolation = snapshot.get("isolation")
    isolation: dict[str, Any] = raw_isolation if isinstance(raw_isolation, dict) else {}
    return {
        "version": 1,
        "run_id": run_id,
        "automation_id": automation_id,
        "task": bounded_text(snapshot.get("task")).lower(),
        "task_spec": task_spec,
        "tool_grants": tool_grants,
        "isolation": {"mode": bounded_text(isolation.get("mode")).lower() or "read_only"},
        "workspace_root": str(snapshot.get("workspace_root") or "").strip(),
        "started_at": bounded_text(snapshot.get("started_at") or payload.get("started_at")),
        "runtime_budget_ms": _normalize_runtime_budget_ms(snapshot.get("runtime_budget_ms")),
        "result_ref": bounded_text(snapshot.get("result_ref") or payload.get("result_ref"), 256),
    }


def _normalize_runtime_budget_ms(value: Any) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        parsed = 300_000
    return min(max(parsed, 30_000), 1_800_000)


def _base_result(  # noqa: PLR0913 - mirrors the bounded automation result contract.
    snapshot: dict[str, Any],
    *,
    status: str,
    reason: str,
    started_at: str | None = None,
    completed_at: str | None = None,
    summary: str = "",
    runtime_ms: int = 0,
    tool_calls: int = 0,
    artifacts: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    return {
        "version": RESULT_VERSION,
        "run_id": bounded_text(snapshot["run_id"], 256),
        "automation_id": bounded_text(snapshot["automation_id"], 256),
        "status": bounded_text(status).lower(),
        "reason": bounded_text(reason),
        "started_at": started_at or snapshot.get("started_at") or utc_now_iso(),
        "completed_at": completed_at or utc_now_iso(),
        "summary": summary[:MAX_SUMMARY_LENGTH],
        "budget": {
            "runtime_ms": max(0, int(runtime_ms)),
            "tool_calls": max(0, int(tool_calls)),
        },
        "artifacts": list(artifacts or [])[:MAX_ARTIFACTS],
        "result_ref": bounded_text(snapshot.get("result_ref"), 256),
    }


def _summary_from_notifications(notifications: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    remaining = MAX_SUMMARY_LENGTH
    for item in notifications:
        if item.get("method") != CHAT_TOKEN_METHOD:
            continue
        raw_params = item.get("params")
        params: dict[str, Any] = raw_params if isinstance(raw_params, dict) else {}
        delta = str(params.get("delta") or "")
        if not delta:
            continue
        parts.append(delta[:remaining])
        remaining -= len(parts[-1])
        if remaining <= 0:
            break
    return "".join(parts).strip()[:MAX_SUMMARY_LENGTH]


def _artifacts_from_notifications(notifications: list[dict[str, Any]]) -> list[dict[str, str]]:
    artifacts: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in notifications:
        if item.get("method") != TOOL_RESULT_METHOD:
            continue
        raw_params = item.get("params")
        params: dict[str, Any] = raw_params if isinstance(raw_params, dict) else {}
        generated = params.get("generated_artifacts")
        if not isinstance(generated, list):
            continue
        for artifact in generated:
            if not isinstance(artifact, dict):
                continue
            artifact_id = bounded_text(artifact.get("artifact_id") or artifact.get("id"))
            if not artifact_id or artifact_id in seen:
                continue
            seen.add(artifact_id)
            artifacts.append(
                {
                    "artifact_id": artifact_id,
                    "kind": bounded_text(artifact.get("kind")) or "artifact",
                    "title": bounded_text(artifact.get("title"), 200),
                }
            )
            if len(artifacts) >= MAX_ARTIFACTS:
                return artifacts
    return artifacts


def _tool_result_count(notifications: list[dict[str, Any]]) -> int:
    return sum(1 for item in notifications if item.get("method") == TOOL_RESULT_METHOD)


def _automation_messages(snapshot: dict[str, Any]) -> list[dict[str, str]]:
    grants = ", ".join(snapshot.get("tool_grants") or ())
    content = (
        "Run this scheduled automation as a read-only background task.\n\n"
        f"Automation id: {snapshot['automation_id']}\n"
        f"Task: {snapshot.get('task') or 'automation'}\n"
        f"Granted read-only tool families: {grants or 'none'}\n\n"
        "Automation task specification:\n"
        f"{snapshot['task_spec']}"
    )
    return [{"role": "user", "content": content}]


def _write_json_atomic(result_path: Path, payload: dict[str, Any]) -> None:
    result_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = result_path.with_name(
        f".{result_path.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp"
    )
    try:
        temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        temp_path.replace(result_path)
    except Exception:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise


def _write_result(result_path: Path | None, result: dict[str, Any]) -> dict[str, Any]:
    if result_path is not None:
        _write_json_atomic(result_path, result)
    return result


def _result_from_chat_response(
    snapshot: dict[str, Any],
    response: ChatResponse,
    *,
    runtime_ms: int,
) -> dict[str, Any]:
    notifications = list(response.notifications or [])
    summary = _summary_from_notifications(notifications)
    tool_calls = _tool_result_count(notifications)
    artifacts = _artifacts_from_notifications(notifications)
    if response.approval_request is not None:
        return _base_result(
            snapshot,
            status="failed",
            reason="approval_required",
            summary=summary,
            runtime_ms=runtime_ms,
            tool_calls=tool_calls,
            artifacts=artifacts,
        )
    status = str(response.result.get("status") or "").strip().lower()
    if status != "completed":
        return _base_result(
            snapshot,
            status="failed",
            reason=status or "tool_loop_failed",
            summary=summary,
            runtime_ms=runtime_ms,
            tool_calls=tool_calls,
            artifacts=artifacts,
        )
    return _base_result(
        snapshot,
        status="completed",
        reason="ok",
        summary=summary,
        runtime_ms=runtime_ms,
        tool_calls=tool_calls,
        artifacts=artifacts,
    )


def _worker_secrets(source: dict[str, Any]) -> dict[str, Any]:
    """Read the out-of-band secrets the background worker attached in memory."""
    raw_secrets = source.get("secrets")
    return dict(raw_secrets) if isinstance(raw_secrets, dict) else {}


def run_automation_worker(payload: dict[str, Any]) -> dict[str, Any]:  # noqa: PLR0911
    source = payload if isinstance(payload, dict) else {}
    # Secrets arrive out-of-band over stdin; raw_config itself stays secret-free
    # so it can be re-serialized (and re-spawned from) without leaking.
    secrets = _worker_secrets(source)
    raw_config = sanitize_automation_worker_config(source.get("config"))
    config = parse_runtime_config(merge_config_secrets(raw_config, secrets))
    result_path: Path | None = None
    snapshot: dict[str, Any]
    started = time.monotonic()
    try:
        result_path = resolve_automation_result_path(source.get("result_path"), config)
    except Exception:  # noqa: BLE001
        result_path = None
    try:
        snapshot = _normalize_snapshot(source)
        raw_workspace_root = str(raw_config.get("tools_workspace_root") or "").strip()
        if snapshot.get("workspace_root") and not raw_workspace_root:
            raw_config["tools_workspace_root"] = snapshot["workspace_root"]
            config = parse_runtime_config(merge_config_secrets(raw_config, secrets))
        if result_path is None:
            result_path = resolve_automation_result_path(source.get("result_path"), config)
    except Exception as error:  # noqa: BLE001
        raw_snapshot = source.get("automation")
        snapshot_source = raw_snapshot if isinstance(raw_snapshot, dict) else {}
        fallback_run_id = source.get("run_id") or snapshot_source.get("run_id")
        fallback_started_at = source.get("started_at") or snapshot_source.get("started_at")
        fallback = {
            "run_id": bounded_text(fallback_run_id) or "unknown",
            "automation_id": bounded_text(
                source.get("automation_id") or snapshot_source.get("automation_id")
            )
            or "unknown",
            "started_at": bounded_text(fallback_started_at) or utc_now_iso(),
            "result_ref": bounded_text(
                source.get("result_ref") or snapshot_source.get("result_ref"),
                256,
            ),
        }
        return _write_result(
            result_path,
            _base_result(fallback, status="failed", reason="invalid_payload", summary=str(error)),
        )

    workspace_root = (
        snapshot.get("workspace_root")
        or str(config.tools_workspace_root or "").strip()
    )
    if not workspace_root:
        return _write_result(
            result_path,
            _base_result(snapshot, status="skipped", reason="missing_workspace"),
        )
    if snapshot.get("isolation", {}).get("mode") != "read_only":
        return _write_result(
            result_path,
            _base_result(snapshot, status="skipped", reason="unsupported_isolation"),
        )

    brain_container: BrainContainer | None = None
    try:
        brain_container = BrainContainer()
        # Threaded so "no raw_config anywhere holds a secret" holds recursively:
        # this nested stack can itself spawn a background worker.
        brain_container.configure(raw_config, secrets=secrets)
        enabled_tools = enabled_tools_for_grants(
            brain_container.stack.config,
            snapshot.get("tool_grants", ()),
        )
        if not enabled_tools:
            return _write_result(
                result_path,
                _base_result(snapshot, status="skipped", reason="no_read_only_tools"),
            )
        response = build_chat_send_response(
            f"automation:{snapshot['run_id']}",
            {
                "request_id": f"automation:{snapshot['run_id']}",
                "session_id": f"automation:{snapshot['automation_id']}",
                "messages": _automation_messages(snapshot),
                "canonical_session_messages": [],
                "session_title": f"Automation {snapshot['automation_id']}",
                "agent_id": f"automation:{snapshot['automation_id']}:{snapshot['run_id']}",
                "agent_surface": "automation",
                "reasoning_effort": "low",
                "tool_preferences": {"enabled_tools": list(enabled_tools)},
                "debug_options": {"lean_context": True},
            },
            approvals_pre_granted=False,
            brain_container=brain_container,
            invalid_params_code=-32602,
            stream_notifications=False,
        )
        runtime_ms = int((time.monotonic() - started) * 1000)
        return _write_result(
            result_path,
            _result_from_chat_response(snapshot, response, runtime_ms=runtime_ms),
        )
    except ChatRequestError as error:
        runtime_ms = int((time.monotonic() - started) * 1000)
        reason = error.code or CHAT_INVALID_PARAMS
        return _write_result(
            result_path,
            _base_result(
                snapshot,
                status="failed",
                reason=reason,
                summary=error.message,
                runtime_ms=runtime_ms,
            ),
        )
    except Exception as error:  # noqa: BLE001
        logger.exception("automation worker failed")
        runtime_ms = int((time.monotonic() - started) * 1000)
        return _write_result(
            result_path,
            _base_result(
                snapshot,
                status="failed",
                reason="runtime_error",
                summary=str(error),
                runtime_ms=runtime_ms,
            ),
        )
    finally:
        if brain_container is not None:
            try:
                brain_container.close()
            except Exception:  # noqa: BLE001
                logger.debug("automation worker container close failed", exc_info=True)
