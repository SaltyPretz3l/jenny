from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig, parse_runtime_config
from sidecar.protocol import CHAT_TOKEN_METHOD, TOOL_RESULT_METHOD
from sidecar.runtime import automation_runner
from sidecar.runtime.chat_models import ChatResponse


def _automation_payload(tmp_path, *, config: dict[str, object] | None = None) -> dict[str, object]:
    runtime_root = tmp_path / "runtime"
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    raw_config: dict[str, object] = {
        "background_runtime_root": str(runtime_root),
        "tools_workspace_root": str(workspace_root),
        "tools_automations_enabled": True,
        "electron_tool_bridge_enabled": True,
        "tools_worktree_enabled": True,
        "tools_edit_file_enabled": True,
        "tools_workspace_manifest_enabled": True,
        "feature_flags": {"tools_automations_enabled": True},
    }
    if config:
        raw_config.update(config)
    return {
        "config": raw_config,
        "result_path": str(
            runtime_root / "automations" / "automation_project_health" / "run_123.result.json"
        ),
        "automation": {
            "version": 1,
            "run_id": "run_123",
            "automation_id": "automation:project_health",
            "task": "project_health",
            "task_spec": "Run a read-only project health check.",
            "tool_grants": ["filesystem", "git"],
            "isolation": {"mode": "read_only"},
            "workspace_root": str(workspace_root),
            "started_at": "2026-05-19T11:00:00.000Z",
            "runtime_budget_ms": 300000,
            "result_ref": "automation_project_health/run_123.result.json",
        },
    }


class _FakeBrainContainer:
    instances: list["_FakeBrainContainer"] = []

    def __init__(self) -> None:
        self.configured: list[dict[str, object]] = []
        self.configured_secrets: list[dict[str, object]] = []
        self.closed = False
        self.stack = SimpleNamespace(config=parse_runtime_config({}))
        self.__class__.instances.append(self)

    def configure(self, raw_config: object, *, secrets: object = None):
        normalized = dict(raw_config) if isinstance(raw_config, dict) else {}
        self.configured.append(normalized)
        self.configured_secrets.append(dict(secrets) if isinstance(secrets, dict) else {})
        self.stack = SimpleNamespace(config=parse_runtime_config(normalized))
        return self.stack

    def close(self) -> None:
        self.closed = True


def test_resolve_result_path_rejects_paths_outside_automation_runtime(tmp_path) -> None:
    config = RuntimeConfig(background_runtime_root=str(tmp_path / "runtime"))

    with pytest.raises(ValueError, match="result_path must be inside"):
        automation_runner.resolve_automation_result_path(
            str(tmp_path / "outside" / "run.json"),
            config,
        )


def test_enabled_tools_for_grants_uses_read_only_sidecar_owned_descriptors(tmp_path) -> None:
    config = RuntimeConfig(
        tools_workspace_root=str(tmp_path),
        tools_edit_file_enabled=True,
        tools_workspace_manifest_enabled=True,
    )

    enabled_tools = automation_runner.enabled_tools_for_grants(
        config,
        {"filesystem", "git"},
    )

    assert "read_file" in enabled_tools
    assert "list_dir" in enabled_tools
    assert "grep_search" in enabled_tools
    assert "git_status" in enabled_tools
    assert "git_diff" in enabled_tools
    assert "workspace_manifest_read" in enabled_tools
    assert "write_file" not in enabled_tools
    assert "edit_file" not in enabled_tools
    assert "worktree_create" not in enabled_tools


def test_run_automation_worker_writes_completed_result_from_chat_notifications(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeBrainContainer.instances = []
    payload = _automation_payload(tmp_path)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(automation_runner, "BrainContainer", _FakeBrainContainer)

    def _fake_chat_response(*args, **kwargs) -> ChatResponse:
        calls.append({"args": args, "kwargs": kwargs})
        return ChatResponse(
            request_id="automation:run_123",
            result={"request_id": "automation:run_123", "status": "completed"},
            notifications=[
                {
                    "jsonrpc": "2.0",
                    "method": TOOL_RESULT_METHOD,
                    "params": {
                        "tool_name": "git_status",
                        "success": True,
                        "generated_artifacts": [
                            {
                                "artifact_id": "artifact_project_health",
                                "kind": "report",
                                "title": "Project Health",
                                "path": "G:/Secret/report.md",
                            }
                        ],
                    },
                },
                {
                    "jsonrpc": "2.0",
                    "method": CHAT_TOKEN_METHOD,
                    "params": {"delta": "Project "},
                },
                {
                    "jsonrpc": "2.0",
                    "method": CHAT_TOKEN_METHOD,
                    "params": {"delta": "healthy."},
                },
            ],
            approval_request=None,
        )

    monkeypatch.setattr(automation_runner, "build_chat_send_response", _fake_chat_response)

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "completed"
    assert result["summary"] == "Project healthy."
    assert isinstance(result["budget"]["runtime_ms"], int)
    assert result["budget"]["tool_calls"] == 1
    assert result["artifacts"] == [
        {"artifact_id": "artifact_project_health", "kind": "report", "title": "Project Health"}
    ]
    result_path = payload["result_path"]
    with open(result_path, encoding="utf-8") as result_file:
        persisted = json.loads(result_file.read())
    assert persisted["status"] == "completed"
    assert persisted["summary"] == "Project healthy."
    assert persisted["artifacts"] == [
        {"artifact_id": "artifact_project_health", "kind": "report", "title": "Project Health"}
    ]
    assert calls[0]["kwargs"]["approvals_pre_granted"] is False
    params = calls[0]["args"][1]
    assert params["tool_preferences"]["enabled_tools"]
    assert "read_file" in params["tool_preferences"]["enabled_tools"]
    assert "write_file" not in params["tool_preferences"]["enabled_tools"]
    configured = _FakeBrainContainer.instances[0].configured[-1]
    assert configured["electron_tool_bridge_enabled"] is False
    assert configured["tools_worktree_enabled"] is False
    assert configured["tools_automations_enabled"] is False
    assert _FakeBrainContainer.instances[0].closed is True


def test_run_automation_worker_forces_low_reasoning_effort(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _automation_payload(tmp_path, config={"reasoning_effort": "high"})
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(automation_runner, "BrainContainer", _FakeBrainContainer)

    def _fake_chat_response(*args, **kwargs) -> ChatResponse:
        calls.append({"args": args, "kwargs": kwargs})
        return ChatResponse(
            request_id="automation:run_123",
            result={"request_id": "automation:run_123", "status": "completed"},
            notifications=[],
            approval_request=None,
        )

    monkeypatch.setattr(automation_runner, "build_chat_send_response", _fake_chat_response)

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "completed"
    assert calls[0]["args"][1]["reasoning_effort"] == "low"


def test_run_automation_worker_keeps_stdin_secrets_out_of_config_and_results(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # H1: the worker merges the token for RuntimeConfig parsing only. It must
    # not reach raw_config (which the nested stack could re-serialize), the
    # returned dict, or the persisted result file.
    _FakeBrainContainer.instances = []
    sentinel = "sentinel-bearer-token-value"
    payload = _automation_payload(tmp_path)
    payload["secrets"] = {"chatgpt_access_token": sentinel}
    monkeypatch.setattr(automation_runner, "BrainContainer", _FakeBrainContainer)
    monkeypatch.setattr(
        automation_runner,
        "build_chat_send_response",
        lambda *_args, **_kwargs: ChatResponse(
            request_id="automation:run_123",
            result={"request_id": "automation:run_123", "status": "completed"},
            notifications=[
                {"jsonrpc": "2.0", "method": CHAT_TOKEN_METHOD, "params": {"delta": "Done."}}
            ],
            approval_request=None,
        ),
    )

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "completed"
    assert sentinel not in json.dumps(result)
    persisted = Path(payload["result_path"]).read_text(encoding="utf-8")
    assert sentinel not in persisted
    container = _FakeBrainContainer.instances[0]
    assert "chatgpt_access_token" not in container.configured[-1]
    assert sentinel not in json.dumps(container.configured[-1])
    # ...but it IS threaded onward, so a nested spawn can still authenticate.
    assert container.configured_secrets[-1] == {"chatgpt_access_token": sentinel}


def test_run_automation_worker_fails_when_model_requests_approval(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeBrainContainer.instances = []
    payload = _automation_payload(tmp_path)
    monkeypatch.setattr(automation_runner, "BrainContainer", _FakeBrainContainer)

    def _approval_response(*_args, **_kwargs) -> ChatResponse:
        return ChatResponse(
            request_id="automation:run_123",
            result={"request_id": "automation:run_123", "status": "awaiting_approval"},
            notifications=[],
            approval_request={"tool_name": "write_file"},
        )

    monkeypatch.setattr(automation_runner, "build_chat_send_response", _approval_response)

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "failed"
    assert result["reason"] == "approval_required"


def test_run_automation_worker_skips_when_workspace_missing(tmp_path) -> None:
    payload = _automation_payload(
        tmp_path,
        config={
            "tools_workspace_root": "",
        },
    )
    payload["automation"]["workspace_root"] = ""

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "skipped"
    assert result["reason"] == "missing_workspace"
    with open(payload["result_path"], encoding="utf-8") as result_file:
        assert json.loads(result_file.read())["status"] == "skipped"


def test_run_automation_worker_writes_failed_result_for_malformed_snapshot(tmp_path) -> None:
    payload = _automation_payload(tmp_path)
    del payload["automation"]["task_spec"]

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "failed"
    assert result["reason"] == "invalid_payload"
    with open(payload["result_path"], encoding="utf-8") as result_file:
        persisted = json.loads(result_file.read())
    assert persisted["status"] == "failed"
    assert persisted["reason"] == "invalid_payload"
    assert persisted["run_id"] == "run_123"


def test_run_automation_worker_writes_failed_result_when_container_creation_fails(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _automation_payload(tmp_path)

    class _BrokenBrainContainer:
        def __init__(self) -> None:
            raise RuntimeError("container boom")

    monkeypatch.setattr(automation_runner, "BrainContainer", _BrokenBrainContainer)

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "failed"
    assert result["reason"] == "runtime_error"
    with open(payload["result_path"], encoding="utf-8") as result_file:
        persisted = json.loads(result_file.read())
    assert persisted["status"] == "failed"
    assert persisted["reason"] == "runtime_error"


def test_write_json_atomic_removes_temp_file_when_replace_fails(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result_path = tmp_path / "run.result.json"
    original_replace = Path.replace

    def _broken_replace(self: Path, target: Path):
        if self.name.startswith(".run.result.json."):
            raise OSError("replace boom")
        return original_replace(self, target)

    monkeypatch.setattr(Path, "replace", _broken_replace)

    with pytest.raises(OSError, match="replace boom"):
        automation_runner._write_json_atomic(result_path, {"status": "completed"})

    assert list(tmp_path.glob("*.tmp")) == []
