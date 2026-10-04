"""CMC-006: repository delta and the run-end anchor follow the request root.

The builder's ``workspace_root`` is the STARTUP root of a process that serves
several projects. The session-environment overlay already prefers the captured
request root (``None`` when the project has no folder); the repository-delta
block and the run-end anchor refresh now resolve their root the same way, so a
chat in project B is never oriented by (or anchored to) project A's repository.
"""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config_models import ToolPolicySnapshot
from sidecar.ai.context.runtime_overlays import (
    RuntimeOverlayLogContext,
    append_repository_delta_runtime_system_message,
    repo_delta_workspace_root,
)
from sidecar.runtime.chat import _maybe_refresh_repo_anchor, _maybe_run_post_response_tasks
from sidecar.runtime.execution_context import ExecutionContext

_HOSTED = {"host_mode": "server", "host_execution_policy_version": 2}


def _execution(root: Path | None) -> ExecutionContext:
    return ExecutionContext(
        schema_version=1,
        authority_revision="revision",
        project_id="project_audit",
        root_path=str(root) if root else None,
        root_id="root" if root else None,
        root_revision=1 if root else 0,
        device_id=None,
        inode=None,
        tool_policy_snapshot=ToolPolicySnapshot(),
        knowledge_roots=(),
    )


def _config(**overrides: Any) -> SimpleNamespace:
    return SimpleNamespace(repo_delta_resume_enabled=True, **overrides)


def _log_context() -> RuntimeOverlayLogContext:
    return RuntimeOverlayLogContext(
        logger=logging.getLogger("test.repo_delta_root"),
        component="test",
        event="test.failed",
        request_id="request",
        session_id="session",
    )


@pytest.fixture
def service_calls(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[dict[str, Any]]]:
    from sidecar.ai.repo_delta import service

    calls: dict[str, list[dict[str, Any]]] = {"delta": [], "anchor": []}

    def fake_delta(**kwargs: Any) -> str:
        calls["delta"].append(kwargs)
        return "<repository-delta>stub</repository-delta>"

    def fake_anchor(**kwargs: Any) -> None:
        calls["anchor"].append(kwargs)

    monkeypatch.setattr(service, "build_repository_delta_block", fake_delta)
    monkeypatch.setattr(service, "refresh_repo_anchor", fake_anchor)
    return calls


def _append(
    config: Any, builder_root: Path, execution: ExecutionContext | None
) -> list[str]:
    messages: list[str] = []
    append_repository_delta_runtime_system_message(
        messages,
        config=config,
        context_builder=SimpleNamespace(workspace_root=builder_root),
        session_id="session",
        log_context=_log_context(),
        execution_context=execution,
    )
    return messages


def _brain(config: Any, builder_root: Path) -> SimpleNamespace:
    return SimpleNamespace(
        stack=SimpleNamespace(
            config=config,
            router=SimpleNamespace(_context_builder=SimpleNamespace(workspace_root=builder_root)),
        )
    )


def test_resolver_precedence(tmp_path: Path) -> None:
    startup, request = tmp_path / "startup", tmp_path / "request"
    builder = SimpleNamespace(workspace_root=startup)

    assert repo_delta_workspace_root(_config(), builder, _execution(request)) == str(request)
    assert repo_delta_workspace_root(_config(), builder, _execution(None)) is None
    assert repo_delta_workspace_root(_config(), builder, None) == startup
    assert repo_delta_workspace_root(_config(**_HOSTED), builder, _execution(request)) is None
    assert repo_delta_workspace_root(_config(**_HOSTED), builder, None) is None


def test_delta_uses_the_request_root_not_the_startup_root(
    tmp_path: Path, service_calls: dict[str, list[dict[str, Any]]]
) -> None:
    startup, request = tmp_path / "a", tmp_path / "b"

    messages = _append(_config(), startup, _execution(request))

    assert messages == ["<repository-delta>stub</repository-delta>"]
    assert [call["workspace_root"] for call in service_calls["delta"]] == [str(request)]


def test_unbound_request_gets_no_delta_and_no_service_call(
    tmp_path: Path, service_calls: dict[str, list[dict[str, Any]]]
) -> None:
    messages = _append(_config(), tmp_path / "a", _execution(None))

    assert messages == []
    assert service_calls["delta"] == []


def test_no_execution_context_uses_the_builder_root(
    tmp_path: Path, service_calls: dict[str, list[dict[str, Any]]]
) -> None:
    startup = tmp_path / "a"

    _append(_config(), startup, None)

    assert [call["workspace_root"] for call in service_calls["delta"]] == [startup]


def test_hosted_policy_gets_no_delta(
    tmp_path: Path, service_calls: dict[str, list[dict[str, Any]]]
) -> None:
    assert _append(_config(**_HOSTED), tmp_path / "a", _execution(tmp_path / "b")) == []
    assert _append(_config(**_HOSTED), tmp_path / "a", None) == []
    assert service_calls["delta"] == []


def test_anchor_refresh_uses_the_request_root(
    tmp_path: Path, service_calls: dict[str, list[dict[str, Any]]]
) -> None:
    startup, request = tmp_path / "a", tmp_path / "b"

    _maybe_refresh_repo_anchor(
        session_id="session",
        brain_container=_brain(_config(), startup),
        execution_context=_execution(request),
    )

    assert [call["workspace_root"] for call in service_calls["anchor"]] == [str(request)]


def test_anchor_refresh_skips_an_unbound_request(
    tmp_path: Path, service_calls: dict[str, list[dict[str, Any]]]
) -> None:
    _maybe_refresh_repo_anchor(
        session_id="session",
        brain_container=_brain(_config(), tmp_path / "a"),
        execution_context=_execution(None),
    )

    assert service_calls["anchor"] == []


def test_anchor_refresh_without_execution_context_uses_the_builder_root(
    tmp_path: Path, service_calls: dict[str, list[dict[str, Any]]]
) -> None:
    startup = tmp_path / "a"

    _maybe_refresh_repo_anchor(session_id="session", brain_container=_brain(_config(), startup))

    assert [call["workspace_root"] for call in service_calls["anchor"]] == [startup]


def test_anchor_refresh_is_skipped_under_hosted_policy(
    tmp_path: Path, service_calls: dict[str, list[dict[str, Any]]]
) -> None:
    for execution in (None, _execution(tmp_path / "b")):
        _maybe_refresh_repo_anchor(
            session_id="session",
            brain_container=_brain(_config(**_HOSTED), tmp_path / "a"),
            execution_context=execution,
        )

    assert service_calls["anchor"] == []


def test_post_response_tasks_thread_the_execution_context(
    tmp_path: Path, service_calls: dict[str, list[dict[str, Any]]]
) -> None:
    startup, request = tmp_path / "a", tmp_path / "b"

    _maybe_run_post_response_tasks(
        session_id="session",
        brain_container=_brain(_config(), startup),
        execution_context=_execution(request),
    )

    assert [call["workspace_root"] for call in service_calls["anchor"]] == [str(request)]

