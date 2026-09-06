"""Tests for the Python-side ToolPolicySnapshot dataclass + normalizer.

The Electron caller produces the JSON payload via
``services/tools/tool-permission-store.js`` ``getSnapshot()``; sidecar
re-hydrates it through ``parse_runtime_config`` so retries, subagents, and
automations share an immutable per-run snapshot.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from types import SimpleNamespace

import pytest

from sidecar.ai.config import (
    RuntimeConfig,
    ToolPolicyRule,
    ToolPolicyRuleMatch,
    ToolPolicySnapshot,
    _normalize_tool_policy_snapshot,
    parse_runtime_config,
)
from sidecar.ai.tools.policy import evaluate_tool_policy


def test_empty_snapshot_factory() -> None:
    empty = ToolPolicySnapshot.empty()
    assert empty.version == 1
    assert empty.legacy_policies == ()
    assert empty.rules == ()


def test_normalizer_returns_none_for_non_dict() -> None:
    assert _normalize_tool_policy_snapshot(None) is None
    assert _normalize_tool_policy_snapshot([]) is None
    assert _normalize_tool_policy_snapshot("flat string") is None


def test_normalizer_accepts_legacy_policies_only() -> None:
    snapshot = _normalize_tool_policy_snapshot(
        {"version": 1, "legacy_policies": {"read_file": "auto", "write_file": "ask"}}
    )
    assert snapshot is not None
    assert snapshot.version == 1
    assert dict(snapshot.legacy_policies) == {"read_file": "auto", "write_file": "ask"}
    assert snapshot.rules == ()


def test_normalizer_accepts_legacy_flat_map() -> None:
    snapshot = _normalize_tool_policy_snapshot({"read_file": "auto", "write_file": "ask"})

    assert snapshot is not None
    assert snapshot.version == 1
    assert dict(snapshot.legacy_policies) == {"read_file": "auto", "write_file": "ask"}
    assert snapshot.rules == ()


def test_normalizer_drops_invalid_legacy_decisions() -> None:
    snapshot = _normalize_tool_policy_snapshot(
        {
            "version": 1,
            "legacy_policies": {"good": "auto", "bad": "yolo", "alsobad": 42},
        }
    )
    assert snapshot is not None
    assert dict(snapshot.legacy_policies) == {"good": "auto"}


def test_normalizer_accepts_full_rule_list() -> None:
    snapshot = _normalize_tool_policy_snapshot(
        {
            "version": 2,
            "legacy_policies": {"read_file": "auto"},
            "rules": [
                {
                    "id": "deny-shell",
                    "decision": "deny",
                    "reason": "no shell in autonomous mode",
                    "match": {
                        "tool_id": "run_command",
                        "mode": ["autonomous"],
                    },
                },
                {
                    "id": "auto-fs",
                    "decision": "auto",
                    "reason": "trusted workspace",
                    "match": {
                        "tool_family": "filesystem",
                        "path_prefix": "src/",
                    },
                },
            ],
        }
    )
    assert snapshot is not None
    assert snapshot.version == 2
    assert len(snapshot.rules) == 2
    deny = snapshot.rules[0]
    assert isinstance(deny, ToolPolicyRule)
    assert deny.id == "deny-shell"
    assert deny.decision == "deny"
    assert deny.match == ToolPolicyRuleMatch(
        tool_id="run_command",
        mode=("autonomous",),
    )
    allow = snapshot.rules[1]
    assert allow.match == ToolPolicyRuleMatch(
        tool_family="filesystem",
        path_prefix="src/",
    )


def test_blanket_auto_approve_payload_threads_to_auto_decision() -> None:
    """The Electron store's blanket rule survives the dict → snapshot →
    evaluator path end-to-end: a side-effecting tool resolves to AUTO."""
    snapshot = _normalize_tool_policy_snapshot(
        {
            "version": 1,
            "legacy_policies": {},
            "rules": [
                {
                    "id": "blanket_auto_approve",
                    "decision": "auto",
                    "reason": "Blanket auto-approve enabled in Settings",
                    "match": {},
                }
            ],
        }
    )
    assert snapshot is not None

    decision = evaluate_tool_policy(
        descriptor=SimpleNamespace(
            name="write_file",
            side_effecting=True,
            source_kind="mcp",
            tool_family="filesystem",
            server_name="tools",
        ),
        arguments={"path": "notes.md"},
        mode="assist",
        snapshot=snapshot,
    )
    assert decision.decision == "auto"
    assert decision.matched_rule_id == "blanket_auto_approve"


def test_normalizer_drops_rules_missing_id_or_decision() -> None:
    snapshot = _normalize_tool_policy_snapshot(
        {
            "version": 1,
            "legacy_policies": {},
            "rules": [
                {"decision": "deny", "match": {}},  # no id
                {"id": "   ", "decision": "deny", "match": {}},  # blank id
                {"id": "bad", "decision": "yolo", "match": {}},  # invalid decision
                {"id": "good", "decision": "auto", "match": {}},
            ],
        }
    )
    assert snapshot is not None
    assert len(snapshot.rules) == 1
    assert snapshot.rules[0].id == "good"


def test_normalizer_handles_malformed_version_field() -> None:
    snapshot = _normalize_tool_policy_snapshot(
        {"version": "not-a-number", "legacy_policies": {"read_file": "auto"}}
    )
    assert snapshot is not None
    assert snapshot.version == 1


def test_runtime_config_carries_policy_snapshot() -> None:
    raw = {
        "tool_policy_snapshot": {
            "version": 1,
            "legacy_policies": {"read_file": "auto", "run_command": "deny"},
            "rules": [
                {
                    "id": "deny-write",
                    "decision": "deny",
                    "reason": "no writes",
                    "match": {"tool_id": "write_file"},
                }
            ],
        }
    }
    config = parse_runtime_config(raw)
    assert isinstance(config, RuntimeConfig)
    assert config.tool_policy_snapshot is not None
    assert config.tool_policy_snapshot.legacy_decision_for("read_file") == "auto"
    assert config.tool_policy_snapshot.legacy_decision_for("run_command") == "deny"
    assert config.tool_policy_snapshot.legacy_decision_for("nothing") is None
    assert len(config.tool_policy_snapshot.rules) == 1
    assert config.tool_policy_snapshot.rules[0].id == "deny-write"


def test_runtime_config_snapshot_is_none_when_payload_missing() -> None:
    config = parse_runtime_config({})
    assert config.tool_policy_snapshot is None


def test_snapshot_dataclass_is_immutable() -> None:
    snapshot = ToolPolicySnapshot(
        version=1,
        legacy_policies=(("read_file", "auto"),),
        rules=(),
    )
    with pytest.raises(FrozenInstanceError):
        snapshot.version = 5  # type: ignore[misc]
