"""Rule sources and approval copy carved out of ``sidecar.ai.tools.policy``."""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.config_models import ToolPolicyRule, ToolPolicyRuleMatch, ToolPolicySnapshot
from sidecar.ai.tools import policy, policy_rules


def _rule(rule_id: str, decision: str, **match: object) -> ToolPolicyRule:
    return ToolPolicyRule(
        id=rule_id, decision=decision, reason=rule_id, match=ToolPolicyRuleMatch(**match)
    )


def test_policy_reexports_the_carved_out_names_unchanged() -> None:
    assert policy._DEFAULT_TOOL_DEFAULTS is policy_rules._DEFAULT_TOOL_DEFAULTS
    assert policy.POLICY_DECISION_DENY is policy_rules.POLICY_DECISION_DENY


def test_path_prefix_matching_normalizes_windows_and_posix_paths() -> None:
    assert policy_rules._path_prefix_matches("C:\\Repo\\src\\a.py", "c:/repo/src")
    assert not policy_rules._path_prefix_matches("C:/Repo/srcx/a.py", "C:/Repo/src")
    assert policy_rules._path_prefix_matches("//etc", "/etc")  # POSIX double slash collapses
    assert policy_rules._path_prefix_matches("/anything", "/")
    assert not policy_rules._path_prefix_matches("", "/etc")


def test_first_rule_hit_prefers_deny_then_auto_then_ask() -> None:
    descriptor = SimpleNamespace(name="write_file", tool_family="filesystem")
    ask = _rule("ask", "ask", tool_id="write_file")
    auto = _rule("auto", "auto", tool_id="write_file")
    deny = _rule("deny", "deny", path_prefix="/secret")
    rules = (ask, auto, deny)
    args = {"path": "/secret/key"}
    hit = policy_rules._first_rule_hit(rules, descriptor=descriptor, arguments=args, mode="assist")
    assert hit is deny
    hit = policy_rules._first_rule_hit(
        rules, descriptor=descriptor, arguments={"path": "/ok"}, mode="assist"
    )
    assert hit is auto


def test_command_rules_only_match_run_command() -> None:
    rule = _rule("git", "auto", command_prefix="git status")
    shell = SimpleNamespace(name="run_command")
    other = SimpleNamespace(name="run_temp_script")
    args = {"command": "git status --short"}
    assert policy_rules._rule_matches(rule, descriptor=shell, arguments=args, mode="assist")
    assert not policy_rules._rule_matches(rule, descriptor=other, arguments=args, mode="assist")


def test_legacy_policy_lookup_takes_the_strictest_delegate_alias() -> None:
    snapshot = ToolPolicySnapshot(legacy_policies=(("subagent_run", "auto"), ("delegate", "deny")))
    assert policy_rules._legacy_policy_for_descriptor(snapshot, "delegate") == ("delegate", "deny")
    assert policy_rules._legacy_policy_for_descriptor(snapshot, "read_file") is None
