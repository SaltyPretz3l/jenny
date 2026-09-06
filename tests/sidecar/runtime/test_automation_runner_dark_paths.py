"""Dark-path coverage for sidecar/runtime/automation_runner.py.

Targets uncovered regions: 58, 62, 76, 90, 95, 97, 126-127, 171, 175, 189,
192, 195, 205, 237-238, 270, 299-300, 305-306, 308, 341, 355, 383-385, 412-413.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig, parse_runtime_config
from sidecar.protocol import CHAT_TOKEN_METHOD, TOOL_RESULT_METHOD
from sidecar.runtime import automation_runner
from sidecar.runtime.chat_models import ChatRequestError, ChatResponse


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _make_config(tmp_path: Path) -> RuntimeConfig:
    runtime_root = tmp_path / "runtime"
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    return RuntimeConfig(
        background_runtime_root=str(runtime_root),
        tools_workspace_root=str(workspace),
    )


def _valid_snapshot(tmp_path: Path) -> dict[str, Any]:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    return {
        "run_id": "run_abc",
        "automation_id": "auto_001",
        "task": "health",
        "task_spec": "Check health of the repo.",
        "tool_grants": ["filesystem"],
        "isolation": {"mode": "read_only"},
        "workspace_root": str(workspace),
        "started_at": "2026-05-01T00:00:00.000Z",
        "runtime_budget_ms": 300_000,
        "result_ref": "auto_001/run_abc.json",
    }


def _automation_payload(tmp_path: Path, *, extra_auto: dict | None = None, extra_config: dict | None = None) -> dict[str, Any]:
    runtime_root = tmp_path / "runtime"
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    raw_config: dict[str, Any] = {
        "background_runtime_root": str(runtime_root),
        "tools_workspace_root": str(workspace),
        "tools_edit_file_enabled": True,
        "tools_workspace_manifest_enabled": True,
    }
    if extra_config:
        raw_config.update(extra_config)
    auto: dict[str, Any] = {
        "version": 1,
        "run_id": "run_abc",
        "automation_id": "auto_001",
        "task": "health",
        "task_spec": "Check health of the repo.",
        "tool_grants": ["filesystem"],
        "isolation": {"mode": "read_only"},
        "workspace_root": str(workspace),
        "started_at": "2026-05-01T00:00:00.000Z",
        "runtime_budget_ms": 300_000,
        "result_ref": "auto_001/run_abc.json",
    }
    if extra_auto:
        auto.update(extra_auto)
    return {
        "config": raw_config,
        "result_path": str(
            runtime_root / "automations" / "auto_001" / "run_abc.result.json"
        ),
        "automation": auto,
    }


class _FakeBrainContainer:
    """Minimal fake that records configure/close calls and provides stack.config."""

    instances: list["_FakeBrainContainer"] = []

    def __init__(self) -> None:
        self.configured: list[dict[str, Any]] = []
        self.configured_secrets: list[dict[str, Any]] = []
        self.closed = False
        self.stack = SimpleNamespace(config=parse_runtime_config({}))
        self.__class__.instances.append(self)

    def configure(self, raw_config: Any, *, secrets: Any = None) -> Any:
        normalized = dict(raw_config) if isinstance(raw_config, dict) else {}
        self.configured.append(normalized)
        self.configured_secrets.append(dict(secrets) if isinstance(secrets, dict) else {})
        self.stack = SimpleNamespace(config=parse_runtime_config(normalized))
        return self.stack

    def close(self) -> None:
        self.closed = True


# ---------------------------------------------------------------------------
# resolve_automation_result_path — line 58: empty path raises
# ---------------------------------------------------------------------------


def test_resolve_result_path_raises_when_path_empty(tmp_path: Path) -> None:
    config = _make_config(tmp_path)
    with pytest.raises(ValueError, match="result_path is required"):
        automation_runner.resolve_automation_result_path("", config)


def test_resolve_result_path_raises_when_path_none(tmp_path: Path) -> None:
    config = _make_config(tmp_path)
    with pytest.raises(ValueError, match="result_path is required"):
        automation_runner.resolve_automation_result_path(None, config)


# ---------------------------------------------------------------------------
# resolve_automation_result_path — line 62: relative path raises
# ---------------------------------------------------------------------------


def test_resolve_result_path_raises_when_path_relative(tmp_path: Path) -> None:
    config = _make_config(tmp_path)
    with pytest.raises(ValueError, match="result_path must be absolute"):
        automation_runner.resolve_automation_result_path("relative/path/run.json", config)


# ---------------------------------------------------------------------------
# enabled_tools_for_grants — line 76: empty grants returns empty tuple
# ---------------------------------------------------------------------------


def test_enabled_tools_for_grants_returns_empty_tuple_when_no_grants(tmp_path: Path) -> None:
    config = RuntimeConfig(tools_workspace_root=str(tmp_path))
    result = automation_runner.enabled_tools_for_grants(config, [])
    assert result == ()


def test_enabled_tools_for_grants_returns_empty_tuple_for_blank_grant_strings(tmp_path: Path) -> None:
    config = RuntimeConfig(tools_workspace_root=str(tmp_path))
    # Grants that are all whitespace/empty collapse to empty set → early return
    result = automation_runner.enabled_tools_for_grants(config, ["", "  "])
    assert result == ()


# ---------------------------------------------------------------------------
# _normalize_snapshot — line 90: automation key missing or not a dict
# ---------------------------------------------------------------------------


def test_normalize_snapshot_raises_when_automation_key_missing() -> None:
    with pytest.raises(ValueError, match="automation snapshot is required"):
        automation_runner._normalize_snapshot({})


def test_normalize_snapshot_raises_when_automation_is_not_dict() -> None:
    with pytest.raises(ValueError, match="automation snapshot is required"):
        automation_runner._normalize_snapshot({"automation": "not-a-dict"})


# ---------------------------------------------------------------------------
# _normalize_snapshot — line 95: run_id missing
# ---------------------------------------------------------------------------


def test_normalize_snapshot_raises_when_run_id_missing() -> None:
    with pytest.raises(ValueError, match="automation.run_id is required"):
        automation_runner._normalize_snapshot(
            {
                "automation": {
                    "automation_id": "auto_001",
                    "task_spec": "Do something.",
                }
            }
        )


# ---------------------------------------------------------------------------
# _normalize_snapshot — line 97: automation_id missing
# ---------------------------------------------------------------------------


def test_normalize_snapshot_raises_when_automation_id_missing() -> None:
    with pytest.raises(ValueError, match="automation.automation_id is required"):
        automation_runner._normalize_snapshot(
            {
                "automation": {
                    "run_id": "run_abc",
                    "task_spec": "Do something.",
                }
            }
        )


# ---------------------------------------------------------------------------
# _normalize_runtime_budget_ms — lines 126-127: fallback on non-numeric input
# ---------------------------------------------------------------------------


def test_normalize_runtime_budget_ms_fallback_on_none() -> None:
    result = automation_runner._normalize_runtime_budget_ms(None)
    # Default fallback is 300_000; clamp is [30_000, 1_800_000]
    assert result == 300_000


def test_normalize_runtime_budget_ms_fallback_on_string_garbage() -> None:
    result = automation_runner._normalize_runtime_budget_ms("not-a-number")
    assert result == 300_000


def test_normalize_runtime_budget_ms_clamps_below_minimum() -> None:
    result = automation_runner._normalize_runtime_budget_ms(1_000)
    assert result == 30_000


def test_normalize_runtime_budget_ms_clamps_above_maximum() -> None:
    result = automation_runner._normalize_runtime_budget_ms(9_000_000)
    assert result == 1_800_000


# ---------------------------------------------------------------------------
# _summary_from_notifications — line 171: skips notification with empty delta
# ---------------------------------------------------------------------------


def test_summary_from_notifications_skips_empty_delta() -> None:
    notifications = [
        {"method": CHAT_TOKEN_METHOD, "params": {"delta": ""}},
        {"method": CHAT_TOKEN_METHOD, "params": {"delta": "hello"}},
    ]
    result = automation_runner._summary_from_notifications(notifications)
    # Only "hello" contributed — the empty delta was skipped
    assert result == "hello"


# ---------------------------------------------------------------------------
# _summary_from_notifications — line 175: stops when budget exhausted
# ---------------------------------------------------------------------------


def test_summary_from_notifications_stops_at_budget() -> None:
    limit = automation_runner.MAX_SUMMARY_LENGTH
    # Two chunks that together exceed the limit
    chunk1 = "A" * limit
    chunk2 = "B" * limit
    notifications = [
        {"method": CHAT_TOKEN_METHOD, "params": {"delta": chunk1}},
        {"method": CHAT_TOKEN_METHOD, "params": {"delta": chunk2}},
    ]
    result = automation_runner._summary_from_notifications(notifications)
    assert len(result) == limit
    assert result == "A" * limit


# ---------------------------------------------------------------------------
# _artifacts_from_notifications — line 189: skips when generated_artifacts not a list
# ---------------------------------------------------------------------------


def test_artifacts_from_notifications_skips_non_list_generated() -> None:
    notifications = [
        {
            "method": TOOL_RESULT_METHOD,
            "params": {"generated_artifacts": "not-a-list"},
        }
    ]
    result = automation_runner._artifacts_from_notifications(notifications)
    assert result == []


# ---------------------------------------------------------------------------
# _artifacts_from_notifications — line 192: skips non-dict artifact entries
# ---------------------------------------------------------------------------


def test_artifacts_from_notifications_skips_non_dict_artifact() -> None:
    notifications = [
        {
            "method": TOOL_RESULT_METHOD,
            "params": {
                "generated_artifacts": [
                    "this-is-a-string-not-a-dict",
                    {"artifact_id": "art_1", "kind": "report", "title": "Report"},
                ]
            },
        }
    ]
    result = automation_runner._artifacts_from_notifications(notifications)
    assert len(result) == 1
    assert result[0]["artifact_id"] == "art_1"


# ---------------------------------------------------------------------------
# _artifacts_from_notifications — line 195: skips duplicate artifact_id
# ---------------------------------------------------------------------------


def test_artifacts_from_notifications_deduplicates_by_artifact_id() -> None:
    notifications = [
        {
            "method": TOOL_RESULT_METHOD,
            "params": {
                "generated_artifacts": [
                    {"artifact_id": "art_dup", "kind": "report", "title": "First"},
                    {"artifact_id": "art_dup", "kind": "report", "title": "Second"},
                ]
            },
        }
    ]
    result = automation_runner._artifacts_from_notifications(notifications)
    assert len(result) == 1
    assert result[0]["title"] == "First"


# ---------------------------------------------------------------------------
# _artifacts_from_notifications — line 205: early return at MAX_ARTIFACTS
# ---------------------------------------------------------------------------


def test_artifacts_from_notifications_caps_at_max_artifacts() -> None:
    limit = automation_runner.MAX_ARTIFACTS
    artifacts = [
        {"artifact_id": f"art_{i}", "kind": "report", "title": f"Report {i}"}
        for i in range(limit + 5)
    ]
    notifications = [
        {
            "method": TOOL_RESULT_METHOD,
            "params": {"generated_artifacts": artifacts},
        }
    ]
    result = automation_runner._artifacts_from_notifications(notifications)
    assert len(result) == limit
    # The cap was enforced via early return, not a truncation slice
    assert result[0]["artifact_id"] == "art_0"
    assert result[-1]["artifact_id"] == f"art_{limit - 1}"


# ---------------------------------------------------------------------------
# _write_json_atomic — lines 237-238: OSError on unlink is swallowed
# ---------------------------------------------------------------------------


def test_write_json_atomic_swallows_oserror_on_temp_unlink(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result_path = tmp_path / "run.result.json"
    original_replace = Path.replace

    def _broken_replace(self: Path, target: Path) -> Any:
        if self.name.startswith(".run.result.json."):
            raise OSError("replace boom")
        return original_replace(self, target)

    original_unlink = Path.unlink

    unlink_calls: list[str] = []

    def _failing_unlink(self: Path, missing_ok: bool = False) -> None:
        unlink_calls.append(str(self))
        raise OSError("unlink boom")

    monkeypatch.setattr(Path, "replace", _broken_replace)
    monkeypatch.setattr(Path, "unlink", _failing_unlink)

    # The outer OSError from replace must propagate; the OSError from unlink is swallowed
    with pytest.raises(OSError, match="replace boom"):
        automation_runner._write_json_atomic(result_path, {"status": "completed"})

    # unlink was attempted at least once (line 236 branch)
    assert len(unlink_calls) >= 1


# ---------------------------------------------------------------------------
# _result_from_chat_response — line 270: non-completed status maps to failed
# ---------------------------------------------------------------------------


def test_result_from_chat_response_maps_non_completed_status_to_failed() -> None:
    snapshot = {
        "run_id": "run_abc",
        "automation_id": "auto_001",
        "started_at": "2026-05-01T00:00:00.000Z",
        "result_ref": "",
    }
    response = ChatResponse(
        request_id="automation:run_abc",
        result={"request_id": "automation:run_abc", "status": "stalled"},
        notifications=[],
        approval_request=None,
    )
    result = automation_runner._result_from_chat_response(snapshot, response, runtime_ms=42)
    assert result["status"] == "failed"
    assert result["reason"] == "stalled"
    assert result["budget"]["runtime_ms"] == 42


def test_result_from_chat_response_maps_empty_status_to_tool_loop_failed() -> None:
    snapshot = {
        "run_id": "run_abc",
        "automation_id": "auto_001",
        "started_at": "2026-05-01T00:00:00.000Z",
        "result_ref": "",
    }
    response = ChatResponse(
        request_id="automation:run_abc",
        result={"request_id": "automation:run_abc", "status": ""},
        notifications=[],
        approval_request=None,
    )
    result = automation_runner._result_from_chat_response(snapshot, response, runtime_ms=0)
    assert result["status"] == "failed"
    assert result["reason"] == "tool_loop_failed"


# ---------------------------------------------------------------------------
# run_automation_worker — lines 299-300: bad result_path swallowed (result_path=None)
# ---------------------------------------------------------------------------


def test_run_automation_worker_swallows_bad_result_path_in_first_resolve(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When result_path is outside the automation root the first resolve is swallowed;
    the second resolve (after snapshot parse) also raises so the worker falls back
    to invalid_payload with result_path=None (no file written)."""
    _FakeBrainContainer.instances = []
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime_root = tmp_path / "runtime"

    payload: dict[str, Any] = {
        "config": {
            "background_runtime_root": str(runtime_root),
            "tools_workspace_root": str(workspace),
        },
        # Deliberately point outside the automations subtree so both resolves fail
        "result_path": str(tmp_path / "outside" / "run.json"),
        "automation": {
            "run_id": "run_abc",
            "automation_id": "auto_001",
            "task": "health",
            "task_spec": "Check health.",
            "tool_grants": ["filesystem"],
            "isolation": {"mode": "read_only"},
            "workspace_root": str(workspace),
            "started_at": "2026-05-01T00:00:00.000Z",
            "runtime_budget_ms": 300_000,
            "result_ref": "auto_001/run_abc.json",
        },
    }

    result = automation_runner.run_automation_worker(payload)

    # The snapshot was valid but result_path was bad — falls into the outer except
    # (result_path is None because both resolves failed), so no file is written.
    assert result["status"] == "failed"
    assert result["reason"] == "invalid_payload"


# ---------------------------------------------------------------------------
# run_automation_worker — lines 305-306: workspace_root from snapshot propagated
#   to raw_config and config re-parsed
# ---------------------------------------------------------------------------


def test_run_automation_worker_propagates_workspace_root_from_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When snapshot.workspace_root is set but raw_config.tools_workspace_root is
    empty, the worker copies the value into raw_config and re-parses config."""
    _FakeBrainContainer.instances = []

    runtime_root = tmp_path / "runtime"
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    payload: dict[str, Any] = {
        "config": {
            "background_runtime_root": str(runtime_root),
            # Intentionally leave tools_workspace_root empty
            "tools_workspace_root": "",
            "tools_edit_file_enabled": True,
            "tools_workspace_manifest_enabled": True,
        },
        "result_path": str(
            runtime_root / "automations" / "auto_001" / "run_abc.result.json"
        ),
        "automation": {
            "run_id": "run_abc",
            "automation_id": "auto_001",
            "task": "health",
            "task_spec": "Check health.",
            "tool_grants": ["filesystem"],
            "isolation": {"mode": "read_only"},
            # workspace_root comes from the snapshot, not from raw_config
            "workspace_root": str(workspace),
            "started_at": "2026-05-01T00:00:00.000Z",
            "runtime_budget_ms": 300_000,
            "result_ref": "auto_001/run_abc.json",
        },
    }

    chat_calls: list[dict[str, Any]] = []

    def _fake_chat(*args: Any, **kwargs: Any) -> ChatResponse:
        chat_calls.append({"args": args, "kwargs": kwargs})
        return ChatResponse(
            request_id="automation:run_abc",
            result={"request_id": "automation:run_abc", "status": "completed"},
            notifications=[],
            approval_request=None,
        )

    monkeypatch.setattr(automation_runner, "BrainContainer", _FakeBrainContainer)
    monkeypatch.setattr(automation_runner, "build_chat_send_response", _fake_chat)

    result = automation_runner.run_automation_worker(payload)

    # Worker must reach the chat call and succeed — NOT bail out to "skipped"
    # (a skipped/missing_workspace result would mean propagation never happened).
    assert result["status"] == "completed"
    # The brain container must have been configured exactly once, and the
    # raw_config it received must carry the workspace_root copied from the
    # snapshot (lines 305-306). If that propagation is removed, the configured
    # tools_workspace_root stays empty and this assertion fails.
    assert len(_FakeBrainContainer.instances) == 1
    configured = _FakeBrainContainer.instances[0].configured
    assert len(configured) == 1
    assert configured[0]["tools_workspace_root"] == str(workspace)
    # The chat call must actually have been reached.
    assert len(chat_calls) == 1


# ---------------------------------------------------------------------------
# run_automation_worker — line 308: second resolve raises (result_path still None)
# ---------------------------------------------------------------------------


def test_run_automation_worker_second_resolve_raises_invalid_payload(
    tmp_path: Path,
) -> None:
    """If result_path is invalid/absent the second attempt also raises,
    producing an invalid_payload result with no file written."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime_root = tmp_path / "runtime"

    payload: dict[str, Any] = {
        "config": {
            "background_runtime_root": str(runtime_root),
            "tools_workspace_root": str(workspace),
        },
        # No result_path key at all → both resolves raise ValueError("result_path is required")
        "result_path": None,
        "automation": {
            "run_id": "run_abc",
            "automation_id": "auto_001",
            "task": "health",
            "task_spec": "Check health.",
            "tool_grants": ["filesystem"],
            "isolation": {"mode": "read_only"},
            "workspace_root": str(workspace),
            "started_at": "2026-05-01T00:00:00.000Z",
            "runtime_budget_ms": 300_000,
            "result_ref": "auto_001/run_abc.json",
        },
    }

    result = automation_runner.run_automation_worker(payload)

    # result_path was None throughout — the outer except produced invalid_payload with no file
    assert result["status"] == "failed"
    assert result["reason"] == "invalid_payload"
    # No result file was written anywhere under runtime_root (result_path is None).
    # Unconditional: if any *.json appears the swallow-and-None branch failed to keep
    # result_path None, or a write happened it should not have.
    written = list(runtime_root.glob("**/*.json")) if runtime_root.exists() else []
    assert written == []


# ---------------------------------------------------------------------------
# run_automation_worker — line 341: unsupported isolation mode → skipped
# ---------------------------------------------------------------------------


def test_run_automation_worker_skips_unsupported_isolation_mode(tmp_path: Path) -> None:
    payload = _automation_payload(tmp_path, extra_auto={"isolation": {"mode": "write"}})

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "skipped"
    assert result["reason"] == "unsupported_isolation"
    # Result file written
    with open(payload["result_path"], encoding="utf-8") as f:
        persisted = json.loads(f.read())
    assert persisted["status"] == "skipped"
    assert persisted["reason"] == "unsupported_isolation"


# ---------------------------------------------------------------------------
# run_automation_worker — line 355: no enabled tools → skipped
# ---------------------------------------------------------------------------


def test_run_automation_worker_skips_when_no_enabled_tools(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Monkeypatch enabled_tools_for_grants to return () so the 'no_read_only_tools'
    early-return branch is exercised."""
    _FakeBrainContainer.instances = []
    payload = _automation_payload(tmp_path)

    monkeypatch.setattr(automation_runner, "BrainContainer", _FakeBrainContainer)
    monkeypatch.setattr(
        automation_runner,
        "enabled_tools_for_grants",
        lambda *_args, **_kwargs: (),
    )

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "skipped"
    assert result["reason"] == "no_read_only_tools"
    # Brain container was created and closed
    assert len(_FakeBrainContainer.instances) == 1
    assert _FakeBrainContainer.instances[0].closed is True


# ---------------------------------------------------------------------------
# run_automation_worker — lines 383-385: ChatRequestError → failed with code
# ---------------------------------------------------------------------------


def test_run_automation_worker_handles_chat_request_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeBrainContainer.instances = []
    payload = _automation_payload(tmp_path)

    monkeypatch.setattr(automation_runner, "BrainContainer", _FakeBrainContainer)

    def _raise_chat_error(*_args: Any, **_kwargs: Any) -> ChatResponse:
        raise ChatRequestError(
            request_id="automation:run_abc",
            trace_id=None,
            session_id=None,
            code="model_not_found",
            message="Model is unavailable",
            rpc_code=-32603,
            retryable=False,
        )

    monkeypatch.setattr(automation_runner, "build_chat_send_response", _raise_chat_error)

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "failed"
    assert result["reason"] == "model_not_found"
    assert result["summary"] == "Model is unavailable"
    # File written
    with open(payload["result_path"], encoding="utf-8") as f:
        persisted = json.loads(f.read())
    assert persisted["reason"] == "model_not_found"
    # Container was closed
    assert _FakeBrainContainer.instances[0].closed is True


def test_run_automation_worker_uses_chat_invalid_params_fallback_when_error_code_none(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ChatRequestError with code=None falls back to CHAT_INVALID_PARAMS."""
    _FakeBrainContainer.instances = []
    from sidecar.runtime.chat import CHAT_INVALID_PARAMS

    payload = _automation_payload(tmp_path)
    monkeypatch.setattr(automation_runner, "BrainContainer", _FakeBrainContainer)

    def _raise_no_code(*_args: Any, **_kwargs: Any) -> ChatResponse:
        raise ChatRequestError(
            request_id="automation:run_abc",
            trace_id=None,
            session_id=None,
            code=None,
            message="bad params",
            rpc_code=-32602,
            retryable=False,
        )

    monkeypatch.setattr(automation_runner, "build_chat_send_response", _raise_no_code)

    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "failed"
    assert result["reason"] == CHAT_INVALID_PARAMS


# ---------------------------------------------------------------------------
# run_automation_worker — lines 412-413: brain_container.close() exception swallowed
# ---------------------------------------------------------------------------


def test_run_automation_worker_swallows_close_exception(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An exception raised in brain_container.close() must be swallowed; the
    result dict (status=completed) must still be returned."""

    class _BoomCloseBrainContainer(_FakeBrainContainer):
        def close(self) -> None:
            raise RuntimeError("close-boom-example")

    _FakeBrainContainer.instances = []
    _BoomCloseBrainContainer.instances = []

    payload = _automation_payload(tmp_path)
    monkeypatch.setattr(automation_runner, "BrainContainer", _BoomCloseBrainContainer)

    def _ok_chat(*_args: Any, **_kwargs: Any) -> ChatResponse:
        return ChatResponse(
            request_id="automation:run_abc",
            result={"request_id": "automation:run_abc", "status": "completed"},
            notifications=[],
            approval_request=None,
        )

    monkeypatch.setattr(automation_runner, "build_chat_send_response", _ok_chat)

    # Must not raise even though close() raises
    result = automation_runner.run_automation_worker(payload)

    assert result["status"] == "completed"
    # File was written
    with open(payload["result_path"], encoding="utf-8") as f:
        persisted = json.loads(f.read())
    assert persisted["status"] == "completed"
