"""Make automatic headless modes consult their policy for every tool call."""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from sidecar.ai.config_parsing import _normalize_tool_policy_snapshot


def constrain_automatic_tool_policy(config: dict[str, Any], *, mode: str) -> dict[str, Any]:
    if mode not in {"auto-readonly", "auto-tools"}:
        return config
    snapshot = _normalize_tool_policy_snapshot(config.get("tool_policy_snapshot"))
    rules: list[dict[str, Any]] = []
    if snapshot is not None:
        for rule in snapshot.rules:
            match = {key: value for key, value in asdict(rule.match).items() if value is not None}
            match["mode"] = list(rule.match.mode)
            rules.append({"id": rule.id, "reason": rule.reason, "match": match,
                          "decision": "deny" if rule.decision == "deny" else "ask"})
        for index, (name, decision) in enumerate(snapshot.legacy_policies):
            tool_id, separator, action = name.partition(":")
            match = {"tool_id": tool_id}
            if separator:
                match["action"] = action
            rules.append({"id": f"headless-legacy-{index}", "match": match,
                          "decision": "deny" if decision == "deny" else "ask",
                          "reason": "Configured headless tool policy"})
    # Built-in read-only defaults include networking; force those calls through
    # the CLI's allowlist too. Deny rules retain precedence over this ask rule.
    rules.append({"id": "headless-per-call", "decision": "ask", "match": {},
                  "reason": "Headless permission mode requires a per-call decision"})
    return {**config, "tool_policy_snapshot": {
        "version": snapshot.version if snapshot else 1, "legacy_policies": {}, "rules": rules,
    }}
