"""Row 184 W4 (D2): on Auto, Python in the project folder and deletes of turn-written files skip the card."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing import auto_approval_scope
from sidecar.ai.routing.auto_approval_scope import auto_runs_without_card
from sidecar.ai.routing.mutation_change_set_lifecycle import _CURRENT_RUN, _RunAttribution
from sidecar.ai.routing.tool_execution import approval_if_needed
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.workspace_mutation_journal_contract import signature_for_path


class _Store:
    def __init__(self, record: dict[str, Any] | None) -> None:
        self.record = record
        self.loads: list[str] = []

    def load(self, _workspace_id: str, change_set_id: str) -> SimpleNamespace:
        self.loads.append(change_set_id)
        if self.record is None:
            return SimpleNamespace(ok=False, record=None)
        return SimpleNamespace(ok=True, record=self.record)


def _operation(kind: str, path: str, *, file: Path | None = None, status: str = "applied",
               endpoint: str = "destination") -> dict[str, Any]:
    signature = signature_for_path(file).signature.as_dict() if file is not None else {}
    return {
        "kind": kind,
        "status": status,
        "source": {"relative_path": path, "pre_signature": signature} if endpoint == "source" else None,
        "destination": (
            {"relative_path": path, "post_signature": signature}
            if endpoint == "destination" else None
        ),
    }


@pytest.fixture()
def turn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[SimpleNamespace]:
    """A bound turn whose journal record the test fills in."""
    root = tmp_path / "project"
    root.mkdir()
    store = _Store({"session_id": "s1", "turn_id": "t1", "operations": []})
    monkeypatch.setattr(auto_approval_scope, "run_journal_owner", lambda _run: (store, str(root)))
    run = SimpleNamespace(_jenny_change_set_id="cs1")
    token = _CURRENT_RUN.set(_RunAttribution(run=run, turn_id="t1", session_id="s1"))
    try:
        yield SimpleNamespace(root=root, store=store, run=run,
                              context=SimpleNamespace(root_path=str(root)))
    finally:
        _CURRENT_RUN.reset(token)


def _write(root: Path, name: str, text: str = "made this turn\n") -> Path:
    path = root / name
    path.write_text(text, encoding="utf-8")
    return path


# --- Python ---------------------------------------------------------------------------------

def test_python_runs_without_a_card_inside_the_project_folder(tmp_path: Path) -> None:
    context = SimpleNamespace(root_path=str(tmp_path))
    (tmp_path / "sub").mkdir()
    assert auto_runs_without_card("python_execute", {"code": "print(1)"}, context)
    assert auto_runs_without_card("run_temp_script", {"script": "1", "language": "python"}, context)
    assert auto_runs_without_card(
        "run_temp_script", {"script": "1", "language": "python", "cwd": "sub"}, context,
    )


@pytest.mark.parametrize("context", [None, SimpleNamespace(root_path=None),
                                     SimpleNamespace(root_path="")])
def test_python_without_a_project_folder_keeps_its_card(context: object) -> None:
    assert not auto_runs_without_card("python_execute", {"code": "print(1)"}, context)


def test_a_temp_script_outside_the_project_folder_keeps_its_card(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    (tmp_path / "elsewhere").mkdir()
    context = SimpleNamespace(root_path=str(root))
    for cwd in ("../elsewhere", str(tmp_path / "elsewhere"), "missing", "", 7):
        assert not auto_runs_without_card(
            "run_temp_script", {"script": "1", "language": "python", "cwd": cwd}, context,
        ), cwd


# --- delete_file ----------------------------------------------------------------------------

@pytest.mark.parametrize("kind", ["create", "modify"])
def test_deleting_a_file_this_turn_wrote_runs_without_a_card(
    turn: SimpleNamespace, kind: str,
) -> None:
    made = _write(turn.root, "notes.txt")
    turn.store.record["operations"].append(_operation(kind, "notes.txt", file=made))
    assert auto_runs_without_card("delete_file", {"path": "notes.txt"}, turn.context)
    assert auto_runs_without_card("delete_file", {"file_path": "notes.txt"}, turn.context)
    assert turn.store.loads == ["cs1", "cs1"]


def test_a_file_changed_since_the_turn_wrote_it_keeps_its_card(turn: SimpleNamespace) -> None:
    made = _write(turn.root, "notes.txt")
    turn.store.record["operations"].append(_operation("create", "notes.txt", file=made))
    made.write_text("a script rewrote this\n", encoding="utf-8")
    assert not auto_runs_without_card("delete_file", {"path": "notes.txt"}, turn.context)


def test_a_file_the_turn_did_not_write_keeps_its_card(turn: SimpleNamespace) -> None:
    made = _write(turn.root, "notes.txt")
    _write(turn.root, "other.txt")
    turn.store.record["operations"].append(_operation("create", "notes.txt", file=made))
    assert not auto_runs_without_card("delete_file", {"path": "other.txt"}, turn.context)


@pytest.mark.parametrize("later", [
    {"kind": "delete", "endpoint": "source"},
    {"kind": "move", "endpoint": "source"},
    {"kind": "move", "endpoint": "destination"},
])
def test_a_later_move_or_delete_of_the_path_keeps_its_card(
    turn: SimpleNamespace, later: dict[str, str],
) -> None:
    made = _write(turn.root, "notes.txt")
    turn.store.record["operations"] += [
        _operation("create", "notes.txt", file=made),
        _operation(later["kind"], "notes.txt", file=made, endpoint=later["endpoint"]),
    ]
    assert not auto_runs_without_card("delete_file", {"path": "notes.txt"}, turn.context)


def test_an_unapplied_write_keeps_its_card(turn: SimpleNamespace) -> None:
    made = _write(turn.root, "notes.txt")
    turn.store.record["operations"].append(
        _operation("create", "notes.txt", file=made, status="planned"),
    )
    assert not auto_runs_without_card("delete_file", {"path": "notes.txt"}, turn.context)


def test_a_recursive_or_directory_delete_keeps_its_card(turn: SimpleNamespace) -> None:
    made = _write(turn.root, "notes.txt")
    (turn.root / "folder").mkdir()
    turn.store.record["operations"] += [
        _operation("create", "notes.txt", file=made),
        _operation("create", "folder", file=turn.root / "folder"),
    ]
    assert not auto_runs_without_card(
        "delete_file", {"path": "notes.txt", "recursive": True}, turn.context,
    )
    assert not auto_runs_without_card("delete_file", {"path": "folder"}, turn.context)


def test_another_turns_change_set_keeps_its_card(turn: SimpleNamespace) -> None:
    made = _write(turn.root, "notes.txt")
    turn.store.record["operations"].append(_operation("create", "notes.txt", file=made))
    turn.store.record["turn_id"] = "an-earlier-turn"
    assert not auto_runs_without_card("delete_file", {"path": "notes.txt"}, turn.context)


def test_no_change_set_or_an_unreadable_journal_keeps_its_card(turn: SimpleNamespace) -> None:
    _write(turn.root, "notes.txt")
    turn.store.record = None
    assert not auto_runs_without_card("delete_file", {"path": "notes.txt"}, turn.context)
    turn.run._jenny_change_set_id = ""
    assert not auto_runs_without_card("delete_file", {"path": "notes.txt"}, turn.context)


def test_a_path_outside_the_project_folder_keeps_its_card(turn: SimpleNamespace) -> None:
    outside = _write(turn.root.parent, "outside.txt")
    turn.store.record["operations"].append(_operation("create", "../outside.txt", file=outside))
    assert not auto_runs_without_card("delete_file", {"path": "../outside.txt"}, turn.context)
    assert not auto_runs_without_card("delete_file", {"path": str(outside)}, turn.context)


def test_other_tools_are_never_scoped(turn: SimpleNamespace) -> None:
    made = _write(turn.root, "notes.txt")
    turn.store.record["operations"].append(_operation("create", "notes.txt", file=made))
    for tool in ("move_file", "worktree_delete", "run_command"):
        assert not auto_runs_without_card(tool, {"path": "notes.txt"}, turn.context)


# --- approval_if_needed ---------------------------------------------------------------------

class _Contract:
    def __init__(self, descriptor: object) -> None:
        self._descriptor = descriptor

    def entry(self, tool_name: str) -> object | None:
        if tool_name != self._descriptor.name:
            return None
        return SimpleNamespace(available=True, descriptor=self._descriptor)


def _approval(  # noqa: PLR0913 - the scenario's knobs, spelled out.
    tool: str, arguments: dict[str, object], *, context: object, family: str = "python",
    approval_mode: str = "auto_run", safety_mode: str = "normal",
    feature_flags: dict[str, bool] | None = None,
) -> object | None:
    descriptor = SimpleNamespace(
        name=tool, side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        source_kind="builtin", tool_family=family, server_name="builtin",
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode=safety_mode, tools_shell_enabled=True,
                              feature_flags=feature_flags or {}),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    return approval_if_needed(
        kernel,
        (ToolCallRequest(tool_id=tool, arguments=arguments, call_id="call"),),
        mode="assist", mode_allows_side_effecting=True, require_approval=True,
        approvals_pre_granted=False, resolution_context=None,
        tool_contract=_Contract(descriptor), approval_mode=approval_mode,
        execution_context=context,
    )


def test_auto_runs_python_in_the_project_folder_without_a_card(tmp_path: Path) -> None:
    context = SimpleNamespace(root_path=str(tmp_path))
    assert _approval("python_execute", {"code": "print(1)"}, context=context) is None
    assert _approval(
        "run_temp_script", {"script": "print(1)", "language": "python"},
        context=context, family="shell",
    ) is None


@pytest.mark.parametrize(("approval_mode", "safety_mode", "flags"), [
    ("prompt", "normal", {}),
    ("auto_run", "paranoid", {}),
    ("auto_run", "normal", {"strict_auto_run": True}),
])
def test_ask_paranoid_and_strict_auto_keep_the_python_card(
    tmp_path: Path, approval_mode: str, safety_mode: str, flags: dict[str, bool],
) -> None:
    approval = _approval(
        "python_execute", {"code": "print(1)"}, context=SimpleNamespace(root_path=str(tmp_path)),
        approval_mode=approval_mode, safety_mode=safety_mode, feature_flags=flags,
    )
    assert approval is not None
    assert "always requires approval" in approval.reason.lower()


def test_auto_deletes_a_turn_written_file_without_a_card(turn: SimpleNamespace) -> None:
    made = _write(turn.root, "notes.txt")
    _write(turn.root, "kept.txt")
    turn.store.record["operations"].append(_operation("create", "notes.txt", file=made))
    assert _approval(
        "delete_file", {"path": "notes.txt"}, context=turn.context, family="filesystem",
    ) is None
    kept = _approval("delete_file", {"path": "kept.txt"}, context=turn.context, family="filesystem")
    assert kept is not None
    assert ".jenny/trash" in kept.reason
    asked = _approval("delete_file", {"path": "notes.txt"}, context=turn.context,
                      family="filesystem", approval_mode="prompt")
    assert asked is not None
