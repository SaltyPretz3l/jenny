"""Red-first: W6 adversarial-review hardening (findings F1/F2/F5).

Three containment holes in the (tool, action) re-keying, each confirmed
against source before these pins were written:

- F1: downstream enforcement (mode gates, coerced-argument validation, the
  operation ledger, envelope effects) still keys on the descriptor SCALAR
  ``side_effecting``. A mixed descriptor with scalar False and a declared
  write action would bypass all of it. Invariant: no descriptor construction
  seam may emit a read scalar while any declared action writes — the scalar
  is coerced to True at parse (manifest, runtime normalize, MCP payload).
- F2: an actioned descriptor whose call carries a missing / non-string /
  undeclared action is unclassifiable, yet the permissive lanes (raw rules,
  plain legacy grants, built-in defaults) still fired. Unresolvable actions
  must fail closed to ask; deny rules and deny grants still apply. A rule
  whose ``action`` matcher is present but malformed must be rejected whole,
  never silently widened tool-wide.
- F5: ``tool:action`` composite keys are not injective — a colon inside
  either segment forges a different grant's key. Action names are a bounded
  colon-free grammar at declaration; colon-named tools never enter the
  composite lane.
"""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.config import _normalize_tool_policy_snapshot
from sidecar.ai.config_models import ToolPolicySnapshot
from sidecar.ai.mcp.client_support import descriptor_from_payload
from sidecar.ai.tools.catalog import (
    ToolActionSpec,
    _manifest_descriptor,
    normalize_runtime_descriptor,
    parse_tool_actions,
)
from sidecar.ai.tools.policy import evaluate_tool_policy


def _descriptor(name: str = "worktree", *, side_effecting: bool = True, actions=None):
    return SimpleNamespace(
        name=name,
        tool_family="workspace",
        source_kind="builtin",
        server_name=None,
        side_effecting=side_effecting,
        actions=actions,
    )


_WORKTREE_ACTIONS = {
    "list": ToolActionSpec(side_effecting=False),
    "delete": ToolActionSpec(side_effecting=True),
}


def _evaluate(descriptor, arguments, snapshot):
    return evaluate_tool_policy(
        descriptor=descriptor,
        arguments=arguments,
        mode="agent",
        snapshot=snapshot,
    )


class TestScalarCoercion:
    """F1: a write action forces the scalar True at every construction seam."""

    def test_manifest_seam_coerces_scalar_when_any_action_writes(self) -> None:
        descriptor = _manifest_descriptor(
            {
                "name": "worktree",
                "side_effecting": False,
                "read_only": True,
                "actions": {
                    "list": {"side_effecting": False},
                    "delete": {"side_effecting": True},
                },
            },
            config=None,
        )
        assert descriptor.side_effecting is True
        assert descriptor.read_only is False

    def test_manifest_seam_keeps_read_scalar_for_read_pure_actions(self) -> None:
        descriptor = _manifest_descriptor(
            {
                "name": "worktree",
                "side_effecting": False,
                "actions": {"list": {"side_effecting": False}},
            },
            config=None,
        )
        assert descriptor.side_effecting is False
        assert descriptor.read_only is True

    def test_runtime_seam_coerces_scalar_when_any_action_writes(self) -> None:
        descriptor = normalize_runtime_descriptor(
            SimpleNamespace(
                name="worktree",
                side_effecting=False,
                input_schema={"type": "object"},
                server_name=None,
                actions=dict(_WORKTREE_ACTIONS),
            )
        )
        assert descriptor.side_effecting is True
        assert descriptor.read_only is False

    def test_mcp_seam_coerces_scalar_when_any_action_writes(self) -> None:
        descriptor = descriptor_from_payload(
            "docs",
            {
                "name": "worktree",
                "input_schema": {"type": "object"},
                "side_effecting": False,
                "actions": {
                    "list": {"side_effecting": False},
                    "delete": {"side_effecting": True},
                },
            },
        )
        assert descriptor is not None
        assert descriptor.side_effecting is True


class TestUnresolvableActionFailsClosed:
    """F2: unclassifiable calls never consume a permissive grant or default."""

    def test_undeclared_action_ignores_a_plain_auto_grant(self) -> None:
        snapshot = ToolPolicySnapshot(legacy_policies=(("worktree", "auto"),))
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert _evaluate(descriptor, {"action": "explode"}, snapshot).decision == "ask"

    def test_missing_action_ignores_a_plain_auto_grant(self) -> None:
        snapshot = ToolPolicySnapshot(legacy_policies=(("worktree", "auto"),))
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert _evaluate(descriptor, {}, snapshot).decision == "ask"

    def test_non_string_action_ignores_a_plain_auto_grant(self) -> None:
        snapshot = ToolPolicySnapshot(legacy_policies=(("worktree", "auto"),))
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert _evaluate(descriptor, {"action": 7}, snapshot).decision == "ask"

    def test_undeclared_action_still_honors_a_plain_deny(self) -> None:
        snapshot = ToolPolicySnapshot(legacy_policies=(("worktree", "deny"),))
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert _evaluate(descriptor, {"action": "explode"}, snapshot).decision == "deny"

    def test_undeclared_action_ignores_an_auto_rule(self) -> None:
        snapshot = _normalize_tool_policy_snapshot(
            {
                "version": 3,
                "legacy_policies": {},
                "rules": [
                    {
                        "id": "rule-worktree-auto",
                        "decision": "auto",
                        "reason": "trusted tool",
                        "match": {"tool_id": "worktree"},
                    }
                ],
            }
        )
        assert snapshot is not None
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert _evaluate(descriptor, {"action": "explode"}, snapshot).decision == "ask"

    def test_undeclared_action_still_honors_a_deny_rule(self) -> None:
        snapshot = _normalize_tool_policy_snapshot(
            {
                "version": 3,
                "legacy_policies": {},
                "rules": [
                    {
                        "id": "rule-worktree-deny",
                        "decision": "deny",
                        "reason": "blocked tool",
                        "match": {"tool_id": "worktree"},
                    }
                ],
            }
        )
        assert snapshot is not None
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert _evaluate(descriptor, {"action": "explode"}, snapshot).decision == "deny"

    def test_undeclared_action_ignores_builtin_auto_defaults(self) -> None:
        # read_file has a built-in auto default; an unclassifiable call on an
        # actioned read_file must not inherit it.
        descriptor = _descriptor(name="read_file", actions=_WORKTREE_ACTIONS)
        decision = _evaluate(descriptor, {"action": "explode"}, ToolPolicySnapshot.empty())
        assert decision.decision == "ask"

    def test_declared_action_still_uses_the_permissive_lanes(self) -> None:
        # Guard: the fail-closed path is scoped to UNRESOLVABLE actions only.
        snapshot = ToolPolicySnapshot(legacy_policies=(("worktree", "auto"),))
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        assert _evaluate(descriptor, {"action": "delete"}, snapshot).decision == "auto"


class TestMalformedActionMatcherRejectsTheRule:
    """F2: a present-but-invalid action matcher must never widen tool-wide."""

    def _snapshot(self, action_matcher):
        return _normalize_tool_policy_snapshot(
            {
                "version": 3,
                "legacy_policies": {},
                "rules": [
                    {
                        "id": "rule-bad-action",
                        "decision": "auto",
                        "reason": "scoped grant",
                        "match": {"tool_id": "worktree", "action": action_matcher},
                    }
                ],
            }
        )

    def test_non_string_action_matcher_drops_the_rule(self) -> None:
        snapshot = self._snapshot(7)
        assert snapshot is None or len(snapshot.rules) == 0

    def test_empty_action_matcher_drops_the_rule(self) -> None:
        snapshot = self._snapshot("")
        assert snapshot is None or len(snapshot.rules) == 0

    def test_dropped_rule_never_fires_tool_wide(self) -> None:
        snapshot = self._snapshot(7)
        descriptor = _descriptor(actions=_WORKTREE_ACTIONS)
        decision = _evaluate(descriptor, {"action": "delete"}, snapshot)
        assert decision.decision == "ask"
        assert decision.matched_rule_id != "rule-bad-action"


class TestCompositeKeyGrammar:
    """F5: composite keys stay injective — no colons in either segment."""

    def test_action_names_with_colons_are_never_declared(self) -> None:
        assert parse_tool_actions({"del:ete": {"side_effecting": False}}) is None

    def test_oversized_action_names_are_never_declared(self) -> None:
        assert parse_tool_actions({"a" * 65: {"side_effecting": False}}) is None

    def test_action_names_with_interior_whitespace_are_never_declared(self) -> None:
        assert parse_tool_actions({"del ete": {"side_effecting": False}}) is None

    def test_valid_sibling_survives_an_invalid_action_name(self) -> None:
        actions = parse_tool_actions(
            {"del:ete": {"side_effecting": False}, "list": {"side_effecting": False}}
        )
        assert actions is not None
        assert set(actions) == {"list"}

    def test_colon_named_tool_never_enters_the_composite_lane(self) -> None:
        # A grant keyed "we:ird:x" must not be addressable as (tool "we:ird",
        # action "x") — the key is ambiguous, so the composite lane refuses it
        # and the write action falls through to the ask default.
        snapshot = ToolPolicySnapshot(legacy_policies=(("we:ird:x", "auto"),))
        descriptor = _descriptor(
            name="we:ird",
            actions={"x": ToolActionSpec(side_effecting=True)},
        )
        assert _evaluate(descriptor, {"action": "x"}, snapshot).decision == "ask"
