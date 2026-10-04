"""HB-029: the build-turn floor predicate (which typed tools must survive budget pressure)."""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.tools.build_turn_tools import BUILD_TURN_FLOOR, build_turn_floor_names
from sidecar.runtime.chat_models import ChatRequestContext

_PLAN = {"title": "Reconcile the bank export", "steps": ["Edit matching.py"]}
_CODING_TEXT = "fix the failing test in matching.py"


def _request(**overrides: Any) -> ChatRequestContext:
    fields: dict[str, Any] = {
        "request_id": "req-floor",
        "trace_id": None,
        "session_id": "session-floor",
        "mode": "assist",
        "approvals_pre_granted": False,
    }
    fields.update(overrides)
    return ChatRequestContext(**fields)


def test_floor_is_the_typed_file_tools_plus_run_command() -> None:
    assert BUILD_TURN_FLOOR == ("read_file", "edit_file", "write_file", "run_command")


@pytest.mark.parametrize(
    "overrides",
    [
        {"approved_plan": _PLAN},
        {"plan_approved_in_turn": True},
        {"approved_plan": _PLAN, "mode": "autonomous"},
    ],
)
def test_approved_plan_gets_the_floor_and_todo_write(overrides: dict[str, Any]) -> None:
    assert build_turn_floor_names(_request(**overrides), "proceed") == (
        *BUILD_TURN_FLOOR,
        "todo_write",
    )


def test_coding_prompt_with_workspace_root_gets_the_floor() -> None:
    names = build_turn_floor_names(_request(workspace_root_present=True), _CODING_TEXT)

    assert names == BUILD_TURN_FLOOR


@pytest.mark.parametrize(
    ("overrides", "text"),
    [
        ({"workspace_root_present": False}, _CODING_TEXT),
        ({"workspace_root_present": True}, "what a lovely morning"),
        ({}, "proceed"),
    ],
)
def test_no_plan_and_no_coding_workspace_gets_no_floor(
    overrides: dict[str, Any], text: str
) -> None:
    assert build_turn_floor_names(_request(**overrides), text) == ()


@pytest.mark.parametrize(
    "overrides",
    [
        {"plan_mode": True, "read_only": True},
        {"plan_mode": True},
        {"read_only": True},
        {"mode": "chat"},
        {"mode": "not-a-mode"},
    ],
)
def test_plan_mode_read_only_or_side_effect_free_mode_gets_no_floor(
    overrides: dict[str, Any],
) -> None:
    request = _request(approved_plan=_PLAN, workspace_root_present=True, **overrides)

    assert build_turn_floor_names(request, _CODING_TEXT) == ()
