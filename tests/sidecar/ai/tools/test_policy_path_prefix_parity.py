"""Leading-slash runs match a posix ``path_prefix`` rule as in the JS evaluator (C1 #7).

``posixpath.normpath`` keeps exactly two leading slashes while
``path.posix.normalize`` collapses them, so ``//etc`` escaped a ``/etc`` deny
rule on the sidecar side only.
"""

from __future__ import annotations

import pytest

from sidecar.ai.config import ToolPolicyRule, ToolPolicyRuleMatch, ToolPolicySnapshot
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.tools.policy import evaluate_tool_policy

_SNAPSHOT = ToolPolicySnapshot(
    version=5,
    rules=(
        ToolPolicyRule(
            id="deny-etc",
            decision="deny",
            reason="system files",
            match=ToolPolicyRuleMatch(tool_id="write_file", path_prefix="/etc"),
        ),
    ),
)


def _write_file() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="write_file",
        description="write_file test tool",
        input_schema={"type": "object"},
        side_effecting=True,
        server_name="",
        source_kind="builtin",
        tool_family="filesystem",
    )


@pytest.mark.parametrize("path", ["/etc/passwd", "//etc", "///etc/passwd"])
def test_leading_slash_runs_collapse_for_posix_prefix_rules(path: str) -> None:
    decision = evaluate_tool_policy(
        descriptor=_write_file(),
        arguments={"file_path": path},
        mode="assist",
        snapshot=_SNAPSHOT,
    )

    assert decision.decision == "deny"
    assert decision.matched_rule_id == "deny-etc"


def test_unrelated_posix_path_does_not_match() -> None:
    decision = evaluate_tool_policy(
        descriptor=_write_file(),
        arguments={"file_path": "/etcetera/notes.txt"},
        mode="assist",
        snapshot=_SNAPSHOT,
    )

    assert decision.matched_rule_id != "deny-etc"
