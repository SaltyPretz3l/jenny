from __future__ import annotations

import logging
from copy import deepcopy
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch as dispatch
from sidecar.ai.routing.tool_resource_deferral import ToolLoopSuspended
from sidecar.protocol import API_VERSION


class _Scope:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *_args: Any) -> bool:
        return False


def _params() -> dict[str, Any]:
    return {
        "accept_version": API_VERSION,
        "request_id": "stream_1",
        "session_id": "session_1",
        "logical_turn_id": "turn_1",
        "messages": [{"role": "user", "content": "continue"}],
        "execution_context": {
            "schema_version": 1,
            "authority_revision": "authority_1",
            "project_id": "project_1",
            "root_path": None,
            "root_id": None,
            "root_revision": 0,
            "device_id": None,
            "inode": None,
            "tool_policy_snapshot": {"version": 3, "legacy_policies": {}},
            "knowledge_roots": [],
        },
        "continuation_context": {
            "schema_version": 1,
            "work_id": "work_1",
            "turn_id": "turn_1",
            "source_attempt": {
                "attempt_id": "attempt_1",
                "stream_id": "stream_1",
                "incarnation": "incarnation_1",
                "authority_revision": "authority_1",
            },
            "authority": {
                "project_id": "project_1",
                "root_id": None,
                "root_revision": 0,
                "sha256": "a" * 64,
            },
            "route": {
                "route_id": "route_1",
                "route_revision": "configuration:4",
                "sha256": "b" * 64,
            },
        },
    }


def _checkpoint_ref() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "checkpoint_id": f"checkpoint_{'c' * 64}",
        "sha256": "d" * 64,
        "bytes": 4096,
        "source_attempt": deepcopy(_params()["continuation_context"]["source_attempt"]),
    }


def _brain() -> SimpleNamespace:
    config = SimpleNamespace(
        tools_workspace_root=None, agent_workspace_root=None,
        tools_enabled=False, feature_flags={},
    )
    return SimpleNamespace(
        stack=SimpleNamespace(config=config),
        request_boundary=lambda *_args, **_kwargs: _Scope(),
    )


def _run(monkeypatch: pytest.MonkeyPatch, params: dict[str, Any], reference: dict[str, Any]):
    monkeypatch.setattr(
        dispatch, "_build_chat_response",
        lambda **_kwargs: (_ for _ in ()).throw(ToolLoopSuspended(reference)),
    )
    return dispatch.process_chat_send_request(
        message_id=7, params=params, initialized=True, interactive_approval=False,
        brain_container=_brain(), logger=logging.getLogger(__name__),
        write_message=lambda _message: None, read_message=lambda: {},
    )


def test_typed_suspension_returns_exact_fresh_pause_result(monkeypatch) -> None:
    reference = _checkpoint_ref()
    outcome = _run(monkeypatch, _params(), reference)

    assert outcome.deliver_after_worker_cleanup is True
    assert outcome.notifications == []
    assert outcome.response == {
        "jsonrpc": "2.0",
        "id": 7,
        "result": {
            "request_id": "stream_1",
            "status": "paused",
            "checkpoint_ref": _checkpoint_ref(),
            "api_version": API_VERSION,
        },
        "api_version": API_VERSION,
    }
    reference["checkpoint_id"] = f"checkpoint_{'e' * 64}"
    assert outcome.response["result"]["checkpoint_ref"] == _checkpoint_ref()


@pytest.mark.parametrize("mutation", ["missing_context", "logical_turn", "source_attempt"])
def test_forged_or_unbound_suspension_fails_closed(
    monkeypatch, mutation: str,
) -> None:
    params = _params()
    reference = _checkpoint_ref()
    if mutation == "missing_context":
        params.pop("continuation_context")
    elif mutation == "logical_turn":
        params["logical_turn_id"] = "turn_other"
    else:
        reference["source_attempt"]["attempt_id"] = "attempt_other"

    outcome = _run(monkeypatch, params, reference)

    assert outcome.deliver_after_worker_cleanup is False
    assert outcome.response is not None
    assert "error" in outcome.response
