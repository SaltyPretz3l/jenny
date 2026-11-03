"""Row 103: command_prefix / command_exact rules in the sidecar policy.

Mirrors ``tests/tool-policy-evaluator-command-rules.test.js``: a scoped
"Always allow" on run_command covers one program + subcommand (or one exact
command), a malformed rule never widens to the whole tool, and the keys
survive every place the snapshot is re-serialized.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.config_parsing import _normalize_tool_policy_snapshot
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.tools.policy import evaluate_tool_policy
from sidecar.runtime.execution_context import _policy_to_wire
from sidecar.runtime.headless_policy import constrain_automatic_tool_policy


def _descriptor(name: str = "run_command") -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name=name,
        description=f"{name} test tool",
        input_schema={"type": "object"},
        side_effecting=True,
        server_name="",
        source_kind="builtin",
        tool_family="shell",
    )


def _snapshot(*rules: dict[str, Any]) -> dict[str, Any]:
    return {"version": 3, "legacy_policies": {}, "rules": list(rules)}


def _decide(command: object, snapshot: Any, name: str = "run_command") -> Any:
    return evaluate_tool_policy(
        descriptor=_descriptor(name),
        arguments={"command": command},
        mode="assist",
        snapshot=snapshot,
    )


_NPM_TEST = {
    "id": "grant:npm-test",
    "decision": "auto",
    "match": {"tool_id": "run_command", "command_prefix": "npm test"},
}


def test_prefix_rule_covers_prefix_with_any_arguments_only() -> None:
    snapshot = _snapshot(_NPM_TEST)
    assert _decide("npm test", snapshot).decision == "auto"
    assert _decide("npm test -- --watch", snapshot).matched_rule_id == "grant:npm-test"
    assert _decide("npm testx", snapshot).decision == "ask"
    assert _decide("npm run build", snapshot).decision == "ask"
    assert _decide("npm test && echo x", snapshot).decision == "ask"
    assert _decide("npm test\nrm -rf x", snapshot).decision == "ask"
    assert _decide(None, snapshot).decision == "ask"


def test_exact_rule_matches_only_identical_trimmed_text() -> None:
    snapshot = _snapshot(
        {
            "id": "grant:build-py",
            "decision": "auto",
            "match": {"tool_id": "run_command", "command_exact": "python build.py"},
        }
    )
    assert _decide(" python build.py ", snapshot).decision == "auto"
    assert _decide("python build.py --fast", snapshot).decision == "ask"
    assert _decide("python  build.py", snapshot).decision == "ask"


def test_command_rules_never_match_another_tool() -> None:
    assert _decide("npm test", _snapshot(_NPM_TEST), name="monitor").matched_rule_id is None


def test_command_deny_rule_outranks_broader_auto_rule() -> None:
    snapshot = _snapshot(
        {"id": "shell-auto", "decision": "auto", "match": {"tool_id": "run_command"}},
        {
            "id": "no-push",
            "decision": "deny",
            "match": {"tool_id": "run_command", "command_prefix": "git push"},
        },
    )
    assert _decide("git push --force", snapshot).decision == "deny"
    assert _decide("git pull", snapshot).decision == "auto"


def test_malformed_command_rules_never_widen_to_the_whole_tool() -> None:
    malformed = [
        {"tool_id": "run_command", "command_prefix": "npm test", "command_exact": "npm test"},
        {"tool_id": "run_command", "command_prefix": "npm test -x"},
        {"tool_id": "run_command", "command_prefix": "bash -c"},
        {"tool_id": "run_command", "command_exact": "a && b"},
        {"tool_id": "run_command", "command_prefix": 7},
        {"tool_id": "run_command", "command_prefix": ""},
        {"tool_id": "run_command", "command_exact": "   "},
        {"tool_id": "write_file", "command_prefix": "npm test"},
        {"command_prefix": "npm test"},
    ]
    for match in malformed:
        snapshot = _snapshot({"id": "bad", "decision": "auto", "match": match})
        for command in ("npm test -x", "bash -c ls", "a && b", "npm test", "rm -rf x"):
            assert _decide(command, snapshot).decision == "ask", (match, command)


def test_command_keys_survive_parse_wire_and_headless_rewrites() -> None:
    parsed = _normalize_tool_policy_snapshot(
        _snapshot(
            _NPM_TEST,
            {
                "id": "grant:ls",
                "decision": "auto",
                "match": {"tool_id": "run_command", "command_exact": "ls -la"},
            },
        )
    )
    assert parsed is not None
    assert parsed.rules[0].match.command_prefix == "npm test"
    assert parsed.rules[1].match.command_exact == "ls -la"

    wire = _policy_to_wire(parsed)
    assert wire["rules"][0]["match"] == {"tool_id": "run_command", "command_prefix": "npm test"}
    assert wire["rules"][1]["match"] == {"tool_id": "run_command", "command_exact": "ls -la"}
    assert _decide("npm test --ci", wire).decision == "auto"

    headless = constrain_automatic_tool_policy(
        {"tool_policy_snapshot": wire}, mode="auto-tools"
    )["tool_policy_snapshot"]
    assert headless["rules"][0]["match"]["command_prefix"] == "npm test"
    assert _decide("npm run build", headless).matched_rule_id == "headless-per-call"
