"""A resumed call refuses to run under a mode the turn no longer has (tool review C5 #2).

Restored inputs are never recomputed (test_restored_tool_inputs pins that); the
frozen mode keys are compared against the current request instead.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import CMP_MODE_TOOL_BLOCKED
from sidecar.ai.routing.tool_restored_inputs import (
    refuse_restored_mode_drift as _refuse_restored_mode_drift,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.plan_artifact_policy import PLAN_ARTIFACT_WRITE_ARG


def _restored(**effective):
    payload = {"read_only": effective.pop("payload_read_only", False)}
    return SimpleNamespace(effective_tool_arguments=effective, execution_context_payload=payload)


def test_unchanged_mode_passes() -> None:
    _refuse_restored_mode_drift(
        _restored(_jenny_read_only=False, path="a.txt"),
        read_only=False,
        approved_plan=None,
        trusted_plan_artifact_write=False,
    )


def test_turn_that_became_read_only_refuses_the_replayed_write() -> None:
    with pytest.raises(ToolExecutionFailure) as raised:
        _refuse_restored_mode_drift(
            _restored(_jenny_read_only=False),
            read_only=True,
            approved_plan=None,
            trusted_plan_artifact_write=False,
        )
    assert raised.value.code == CMP_MODE_TOOL_BLOCKED
    assert raised.value.retryable is False


def test_context_payload_read_only_drift_refuses() -> None:
    with pytest.raises(ToolExecutionFailure):
        _refuse_restored_mode_drift(
            _restored(payload_read_only=False),
            read_only=True,
            approved_plan=None,
            trusted_plan_artifact_write=False,
        )


def test_revoked_plan_artifact_grant_refuses() -> None:
    with pytest.raises(ToolExecutionFailure):
        _refuse_restored_mode_drift(
            _restored(**{PLAN_ARTIFACT_WRITE_ARG: True}),
            read_only=False,
            approved_plan=None,
            trusted_plan_artifact_write=False,
        )


def test_changed_approved_plan_refuses() -> None:
    with pytest.raises(ToolExecutionFailure):
        _refuse_restored_mode_drift(
            _restored(_jenny_approved_plan={"title": "old"}),
            read_only=False,
            approved_plan={"title": "new"},
            trusted_plan_artifact_write=False,
        )


def test_calls_without_mode_keys_are_not_judged() -> None:
    _refuse_restored_mode_drift(
        SimpleNamespace(effective_tool_arguments={"path": "a"}, execution_context_payload={}),
        read_only=True,
        approved_plan={"title": "x"},
        trusted_plan_artifact_write=False,
    )
