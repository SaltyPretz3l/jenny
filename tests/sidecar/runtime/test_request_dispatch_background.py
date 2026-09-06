from __future__ import annotations

import json
import logging
from types import SimpleNamespace

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.error_codes import CMP_BACKGROUND_INVALID_PARAMS
from sidecar.protocol import API_VERSION, BACKGROUND_RUN_METHOD
from sidecar.runtime.request_dispatch_background import process_background_method

_SENTINEL = "sentinel-bearer-token-value"


class _FakeManager:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def is_task_running(self, _task_key: str) -> bool:
        return False

    def spawn_json_worker(  # noqa: PLR0913 - mirrors the production boundary.
        self,
        task_name: str,
        payload: dict[str, object],
        *,
        payload_dir,
        task_key: str,
        secrets: dict[str, object] | None = None,
        timeout_seconds: float | None = None,
    ) -> object:
        self.calls.append(
            {
                "task_name": task_name,
                "payload": payload,
                "payload_dir": payload_dir,
                "task_key": task_key,
                "secrets": secrets,
                "timeout_seconds": timeout_seconds,
            }
        )
        return object()


def _container(tmp_path, manager: _FakeManager | None = None):
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    raw_config = {
        "background_runtime_root": str(tmp_path / "runtime"),
        "tools_workspace_root": str(workspace_root),
        "tools_automations_enabled": True,
        "feature_flags": {"tools_automations_enabled": True},
    }
    return SimpleNamespace(
        stack=SimpleNamespace(
            raw_config=raw_config,
            secrets={"chatgpt_access_token": _SENTINEL},
            config=RuntimeConfig(
                background_runtime_root=raw_config["background_runtime_root"],
                tools_workspace_root=raw_config["tools_workspace_root"],
                tools_automations_enabled=True,
                feature_flags={"tools_automations_enabled": True},
            ),
        ),
        subprocess_manager=manager,
    )


def test_background_run_rejects_missing_task_with_cmp_code(tmp_path) -> None:
    outcome = process_background_method(
        BACKGROUND_RUN_METHOD,
        1,
        {"accept_version": API_VERSION},
        True,
        _container(tmp_path),
        logging.getLogger(__name__),
    )

    assert outcome is not None
    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == CMP_BACKGROUND_INVALID_PARAMS
    assert outcome.response["error"]["data"]["detail"] == "task is required"


def test_background_run_invalid_version_notification_returns_no_response(tmp_path) -> None:
    outcome = process_background_method(
        BACKGROUND_RUN_METHOD,
        None,
        {"accept_version": "incompatible"},
        True,
        _container(tmp_path),
        logging.getLogger(__name__),
    )

    assert outcome is not None
    assert outcome.response is None


def test_background_run_starts_automation_worker_with_snapshot_and_result_path(tmp_path) -> None:
    manager = _FakeManager()
    runtime_root = tmp_path / "runtime"
    result_path = runtime_root / "automations" / "automation_project_health" / "run_123.result.json"
    params = {
        "accept_version": API_VERSION,
        "task": "automation_run",
        "task_id": "automation:project_health",
        "run_id": "run_123",
        "started_at": "2026-05-19T11:00:00.000Z",
        "result_path": str(result_path),
        "result_ref": "automation_project_health/run_123.result.json",
        "automation": {
            "version": 1,
            "run_id": "run_123",
            "automation_id": "automation:project_health",
            "task": "project_health",
            "task_spec": "Run a read-only project health check.",
            "tool_grants": ["filesystem", "git"],
            "isolation": {"mode": "read_only"},
            "workspace_root": str(tmp_path / "workspace"),
            "started_at": "2026-05-19T11:00:00.000Z",
            "runtime_budget_ms": 300000,
            "result_ref": "automation_project_health/run_123.result.json",
        },
    }

    outcome = process_background_method(
        BACKGROUND_RUN_METHOD,
        2,
        params,
        True,
        _container(tmp_path, manager),
        logging.getLogger(__name__),
    )

    assert outcome is not None
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "started"
    assert outcome.response["result"]["task"] == "automation_run"
    assert outcome.response["result"]["run_id"] == "run_123"
    assert outcome.response["result"]["result_ref"] == "automation_project_health/run_123.result.json"
    assert len(manager.calls) == 1
    assert manager.calls[0]["task_name"] == "automation_run"
    assert manager.calls[0]["task_key"] == "automation:run_123"
    assert manager.calls[0]["payload"]["automation"]["task_spec"] == (
        "Run a read-only project health check."
    )
    assert manager.calls[0]["payload"]["result_path"] == str(result_path)
    assert manager.calls[0]["timeout_seconds"] == 300.0


def test_background_run_forwards_stack_secrets_out_of_band_not_in_the_payload(tmp_path) -> None:
    # H1: the payload dict is json-dumped to a plaintext <uuid4>.json file, so
    # the bearer token must reach the worker only through the secrets channel.
    manager = _FakeManager()
    runtime_root = tmp_path / "runtime"
    result_path = runtime_root / "automations" / "automation_project_health" / "run_9.result.json"
    params = {
        "accept_version": API_VERSION,
        "task": "automation_run",
        "run_id": "run_9",
        "result_path": str(result_path),
        "automation": {
            "version": 1,
            "run_id": "run_9",
            "automation_id": "automation:project_health",
            "task": "project_health",
            "task_spec": "Run a read-only project health check.",
            "tool_grants": ["filesystem"],
            "isolation": {"mode": "read_only"},
            "workspace_root": str(tmp_path / "workspace"),
            "started_at": "2026-05-19T11:00:00.000Z",
        },
    }

    process_background_method(
        BACKGROUND_RUN_METHOD,
        3,
        params,
        True,
        _container(tmp_path, manager),
        logging.getLogger(__name__),
    )

    assert len(manager.calls) == 1
    payload = manager.calls[0]["payload"]
    assert "chatgpt_access_token" not in payload["config"]
    assert _SENTINEL not in json.dumps(payload)
    assert manager.calls[0]["secrets"] == {"chatgpt_access_token": _SENTINEL}
