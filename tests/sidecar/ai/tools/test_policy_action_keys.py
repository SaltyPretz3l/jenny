"""Red-first: (tool, action) re-keying for side-effect class, approval, policy (W6).

The containment prerequisite for every W7 family merge (spec §6.3): a merged
tool spans both side-effect classes, so `side_effecting`, approval
presentation, and policy resolution must resolve per (tool, action) BEFORE any
merge — otherwise a read-only listing silently becomes non-retryable and its
approval coarsens. No shipped tool declares actions yet; these pins are the
machinery contract. Fail-closed rule: an actioned tool with a missing or
undeclared action value is treated as side-effecting.
"""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.config import _normalize_tool_policy_snapshot
from sidecar.ai.config_models import ToolPolicySnapshot
from sidecar.ai.tools.catalog import (
    ToolActionSpec,
    effective_side_effecting,
    parse_tool_actions,
)
from sidecar.ai.tools.policy import (
    approval_presentation_for_call,
    approval_presentation_for_descriptor,
    evaluate_tool_policy,
)


def _descriptor(
    name: str = "worktree",
    *,
    side_effecting: bool = True,
    read_only: bool | None = None,
    actions=None,
):
    return SimpleNamespace(
        name=name,
        tool_family="workspace",
        source_kind="builtin",
        server_name=None,
        side_effecting=side_effecting,
        read_only=not side_effecting if read_only is None else read_only,
        actions=actions,
    )


_WORKTREE_ACTIONS = {
    "list": ToolActionSpec(side_effecting=False),
    "delete": ToolActionSpec(side_effecting=True),
}

_TASK_BOARD_ACTIONS = {
    "list": ToolActionSpec(side_effecting=False),
    "add": ToolActionSpec(side_effecting=True),
    "update": ToolActionSpec(side_effecting=True),
    "complete": ToolActionSpec(side_effecting=True),
}


class TestEffectiveSideEffecting:
    def test_tool_without_actions_passes_through(self) -> None:
        assert effective_side_effecting(_descriptor(side_effecting=True), {}) is True
        assert effective_side_effecting(_descriptor(side_effecting=False), {}) is False

    def test_declared_read_action_narrows_a_side_effecting_tool(self) -> None:
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert effective_side_effecting(descriptor, {"action": "list"}) is False

    def test_declared_write_action_stays_side_effecting(self) -> None:
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert effective_side_effecting(descriptor, {"action": "delete"}) is True

    def test_unknown_action_fails_closed(self) -> None:
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert effective_side_effecting(descriptor, {"action": "explode"}) is True

    def test_missing_action_argument_fails_closed(self) -> None:
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert effective_side_effecting(descriptor, {}) is True

    def test_non_string_action_fails_closed(self) -> None:
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert effective_side_effecting(descriptor, {"action": 7}) is True


class TestParseToolActions:
    def test_parses_manifest_shape(self) -> None:
        actions = parse_tool_actions(
            {"list": {"side_effecting": False}, "delete": {"side_effecting": True}}
        )
        assert actions is not None
        assert actions["list"].side_effecting is False
        assert actions["delete"].side_effecting is True

    def test_rejects_non_dict_payloads(self) -> None:
        assert parse_tool_actions(None) is None
        assert parse_tool_actions(["list"]) is None
        assert parse_tool_actions("list") is None

    def test_malformed_entry_fails_closed_to_side_effecting(self) -> None:
        # A declared action with a garbage side_effecting value must not
        # silently become read-only.
        actions = parse_tool_actions({"list": {"side_effecting": "nope"}})
        assert actions is not None
        assert actions["list"].side_effecting is True


class TestApprovalPresentationPerCall:
    def test_read_action_presents_a_read_consequence(self) -> None:
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        presentation = approval_presentation_for_call(descriptor, {"action": "list"})
        assert presentation.policy_consequence == "May read data in this scope."

    def test_write_action_presents_a_write_consequence(self) -> None:
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        presentation = approval_presentation_for_call(descriptor, {"action": "delete"})
        assert presentation.policy_consequence == "May change data in this scope."

    def test_unknown_action_presents_the_write_consequence(self) -> None:
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        presentation = approval_presentation_for_call(descriptor, {"action": "explode"})
        assert presentation.policy_consequence == "May change data in this scope."

    def test_unactioned_tool_matches_descriptor_presentation(self) -> None:
        descriptor = _descriptor(actions=None)
        assert approval_presentation_for_call(descriptor, {"path": "a.txt"}) == (
            approval_presentation_for_descriptor(descriptor)
        )


def _evaluate(descriptor, arguments, snapshot):
    return evaluate_tool_policy(
        descriptor=descriptor,
        arguments=arguments,
        mode="agent",
        snapshot=snapshot,
    )


class TestCompositeLegacyGrants:
    def test_composite_grant_wins_for_its_action(self) -> None:
        snapshot = ToolPolicySnapshot(
            legacy_policies=(("worktree:delete", "ask"), ("worktree", "auto")),
        )
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert _evaluate(descriptor, {"action": "delete"}, snapshot).decision == "ask"

    def test_plain_grant_covers_the_other_actions(self) -> None:
        snapshot = ToolPolicySnapshot(
            legacy_policies=(("worktree:delete", "ask"), ("worktree", "auto")),
        )
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert _evaluate(descriptor, {"action": "list"}, snapshot).decision == "auto"

    def test_composite_grant_never_bleeds_across_actions(self) -> None:
        # A deny scoped to one action must not deny a sibling action; with no
        # plain grant the read action falls through to the action-aware
        # default (read action -> auto).
        snapshot = ToolPolicySnapshot(legacy_policies=(("worktree:delete", "deny"),))
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        decision = _evaluate(descriptor, {"action": "list"}, snapshot)
        assert decision.decision == "auto"

    def test_undeclared_action_never_matches_a_composite_grant(self) -> None:
        # The composite lane keys on DECLARED actions only: an arbitrary
        # argument string cannot address a grant, and the undeclared action
        # fails closed to the side-effecting default (ask).
        snapshot = ToolPolicySnapshot(legacy_policies=(("worktree:explode", "auto"),))
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        decision = _evaluate(descriptor, {"action": "explode"}, snapshot)
        assert decision.decision == "ask"

    def test_decision_metadata_records_the_declared_action(self) -> None:
        snapshot = ToolPolicySnapshot(legacy_policies=(("worktree", "auto"),))
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        decision = _evaluate(descriptor, {"action": "list"}, snapshot)
        assert decision.action == "list"
        assert decision.to_metadata().get("action") == "list"


def test_task_board_first_pass_defaults_are_action_aware() -> None:
    descriptor = _descriptor(name="task_board", actions=_TASK_BOARD_ACTIONS)

    def first_pass(action: str):
        return evaluate_tool_policy(
            descriptor=descriptor,
            arguments={"action": action},
            mode="assist",
            snapshot=None,
        )

    listed = first_pass("list")
    assert listed.decision == "auto"
    assert listed.reason == "read-only action defaults to auto"

    for action in ("add", "update", "complete"):
        mutated = first_pass(action)
        assert mutated.decision == "auto"
        assert mutated.reason == "built-in default for task_board"

    unknown = first_pass("unknown")
    assert unknown.decision == "ask"
    assert unknown.reason == "action not declared by tool; failing closed to ask"


def test_builtin_and_read_only_precedence_matches_electron_policy_mirror() -> None:
    empty = ToolPolicySnapshot.empty()
    exit_plan_mode = _evaluate(
        _descriptor(name="exit_plan_mode", side_effecting=False, read_only=True),
        {},
        empty,
    )
    task_board_list = _evaluate(
        _descriptor(name="task_board", actions=_TASK_BOARD_ACTIONS, read_only=False),
        {"action": "list"},
        empty,
    )
    read_file = _evaluate(
        _descriptor(name="read_file", side_effecting=False, read_only=True),
        {"path": "notes.txt"},
        empty,
    )

    assert (exit_plan_mode.decision, exit_plan_mode.reason) == (
        "ask",
        "built-in default for exit_plan_mode",
    )
    assert (task_board_list.decision, task_board_list.reason) == (
        "auto",
        "read-only action defaults to auto",
    )
    assert (read_file.decision, read_file.reason) == (
        "auto",
        "built-in default for read_file",
    )


class TestRuleActionMatcher:
    def _snapshot(self) -> ToolPolicySnapshot | None:
        return _normalize_tool_policy_snapshot(
            {
                "version": 3,
                "legacy_policies": {},
                "rules": [
                    {
                        "id": "rule-delete-ask",
                        "decision": "ask",
                        "reason": "deletions always confirm",
                        "match": {"tool_id": "worktree", "action": "delete"},
                    }
                ],
            }
        )

    def test_action_rule_hits_only_matching_calls(self) -> None:
        snapshot = self._snapshot()
        assert snapshot is not None
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        delete_decision = _evaluate(descriptor, {"action": "delete"}, snapshot)
        assert delete_decision.decision == "ask"
        assert delete_decision.matched_rule_id == "rule-delete-ask"
        # The read action misses the rule and lands on the action-aware
        # read default instead.
        assert _evaluate(descriptor, {"action": "list"}, snapshot).decision == "auto"

    def test_read_action_default_is_auto_and_write_default_is_ask(self) -> None:
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        empty = ToolPolicySnapshot.empty()
        assert _evaluate(descriptor, {"action": "list"}, empty).decision == "auto"
        assert _evaluate(descriptor, {"action": "delete"}, empty).decision == "ask"
        assert _evaluate(descriptor, {}, empty).decision == "ask"

    def test_normalizer_parses_the_action_matcher(self) -> None:
        snapshot = self._snapshot()
        assert snapshot is not None
        assert snapshot.rules[0].match.action == "delete"
