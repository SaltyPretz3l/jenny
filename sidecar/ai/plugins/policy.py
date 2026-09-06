"""Plugin capability/tool policy evaluator -- the single policy algebra.

PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md's "single policy algebra" invariant
requires one authoritative capability/tool decision: this module is it (the
Electron-side JS twins were never reached from production and were removed).
Five-layer order, tie-break rules, reason/stage vocabulary and fail-closed
defaults are pinned by tests/fixtures/plugins/policy-matrix/*.json (loaded by
tests/sidecar/ai/plugins/test_policy*.py); any change here must be re-proven
against those fixtures before it can be considered done.

Deliberately does NOT import sidecar.ai.config_models's ToolPolicySnapshot /
ToolPolicyRule: this module's combine_plugin_and_tool_decision() takes an
already-computed tool decision as a plain mapping.
"""

from __future__ import annotations

from typing import Any, Optional, TypedDict

VALID_DECISIONS = frozenset({"deny", "ask", "auto"})
DECISION_RANK: dict[str, int] = {"deny": 0, "ask": 1, "auto": 2}
MAX_REASON_CHARS = 200
MAX_STAGE_CHARS = 64
MAX_ID_CHARS = 80
MAX_COMBINED_REASON_CHARS = 240

REQUIRED_SNAPSHOT_ARRAYS: tuple[str, ...] = (
    "hard_invariants",
    "machine_ceiling",
    "user_policy",
    "workspace_overrides",
    "manifest_requests",
)


class CapabilityDecision(TypedDict):
    decision: str
    stage: str
    matched_rule_id: Optional[str]
    reason: str


class CombinedDecision(TypedDict):
    decision: str
    winner: str
    reason: str
    plugin_decision: dict[str, str]
    tool_decision: dict[str, str]


def _bounded_text(value: Any, limit: int, fallback: str) -> str:
    text = " ".join(str(value if value is not None else "").split())
    if not text:
        return fallback
    return text[:limit]


def _bounded_rule_id(matched_rule_id: Optional[str]) -> Optional[str]:
    if not matched_rule_id:
        return None
    return _bounded_text(matched_rule_id, MAX_ID_CHARS, "") or None


def _build_decision(
    decision: str, stage: str, matched_rule_id: Optional[str], reason: str
) -> CapabilityDecision:
    return {
        "decision": decision if decision in VALID_DECISIONS else "deny",
        "stage": _bounded_text(stage, MAX_STAGE_CHARS, "unknown"),
        "matched_rule_id": _bounded_rule_id(matched_rule_id),
        "reason": _bounded_text(reason, MAX_REASON_CHARS, "policy evaluation produced no reason"),
    }


def _is_number(value: Any) -> bool:
    """JSON-number test that excludes booleans.

    ``bool`` subclasses ``int`` in Python, so a bare ``isinstance(x, (int, float))``
    accepts ``True`` as a revision number while the JS twin's
    ``typeof x === 'number'`` rejects it -- the two runtimes would then disagree
    about whether a caller is on a stale policy snapshot.
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool)


_MATCH_FIELDS = ("publisher_id", "plugin_id", "capability")


def _matches_request(match: Any, request: dict[str, Any]) -> bool:
    """Fail closed on malformed matchers; see the JS twin for the full rationale.

    A non-dict `match` is malformed policy state and matches NOTHING rather than
    everything, and a present-but-empty field constrains rather than wildcards.
    An absent field is the only "unconstrained" spelling, so ``match: {}`` still
    matches every request.
    """
    if not isinstance(match, dict):
        return False
    for field in _MATCH_FIELDS:
        if field not in match:
            continue
        constraint = match[field]
        if not isinstance(constraint, str) or not constraint:
            return False
        if constraint != request.get(field):
            return False
    return True


def _first_match(rules: Any, request: dict[str, Any]) -> Optional[dict[str, Any]]:
    if not isinstance(rules, list):
        return None
    for rule in rules:
        if isinstance(rule, dict) and _matches_request(rule.get("match"), request):
            return rule
    return None


def _validate_request_shape(request: Any) -> Optional[str]:
    if not isinstance(request, dict):
        return "capability request missing or malformed"
    if not isinstance(request.get("publisher_id"), str) or not request["publisher_id"]:
        return "capability request missing publisher_id"
    if not isinstance(request.get("plugin_id"), str) or not request["plugin_id"]:
        return "capability request missing plugin_id"
    if not isinstance(request.get("capability"), str) or not request["capability"]:
        return "capability request missing capability"
    workspace_id = request.get("workspace_incarnation_id")
    if workspace_id is not None and not isinstance(workspace_id, str):
        return "capability request workspace_incarnation_id must be a string when present"
    expected_revision = request.get("expected_revision")
    if expected_revision is not None and not _is_number(expected_revision):
        return "capability request expected_revision must be a number when present"
    return None


def _validate_snapshot_shape(snapshot: Any) -> Optional[tuple[str, str]]:
    if not isinstance(snapshot, dict):
        return ("malformed_snapshot", "policy snapshot missing or malformed")
    if snapshot.get("policy_schema_version") != 1:
        return (
            "unsupported_snapshot_version",
            f"policy snapshot version {snapshot.get('policy_schema_version')!r} is not supported",
        )
    revision = snapshot.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        return ("malformed_snapshot", "policy snapshot revision must be a positive integer")
    if not isinstance(snapshot.get("canonical_hash"), str) or not snapshot["canonical_hash"]:
        return ("malformed_snapshot", "policy snapshot canonical_hash is missing")
    for field in REQUIRED_SNAPSHOT_ARRAYS:
        if not isinstance(snapshot.get(field), list):
            return ("malformed_snapshot", f"policy snapshot field '{field}' must be an array")
    return None


def evaluate_capability_policy(request: Any, snapshot: Any) -> CapabilityDecision:
    """Evaluate a single plugin-capability request against a compiled
    PluginPolicySnapshotV1. Mirrors the evaluation the Electron control plane
    applies before committing a generation.
    """
    request_error = _validate_request_shape(request)
    if request_error:
        return _build_decision("deny", "malformed_request", None, request_error)

    snapshot_error = _validate_snapshot_shape(snapshot)
    if snapshot_error:
        stage, reason = snapshot_error
        return _build_decision("deny", stage, None, reason)

    expected_revision = request.get("expected_revision")
    if _is_number(expected_revision) and expected_revision != snapshot["revision"]:
        return _build_decision(
            "deny",
            "stale_revision",
            None,
            f"caller expected policy revision {expected_revision} but the snapshot is at revision {snapshot['revision']}",
        )

    # --- Layer 1: hard Jenny safety invariants (terminal) -------------------
    hard_hit = _first_match(snapshot["hard_invariants"], request)
    if hard_hit is not None:
        return _build_decision("deny", "hard_invariant_deny", hard_hit.get("rule_id"), hard_hit.get("reason", ""))

    best: Optional[dict[str, Any]] = None  # {decision, stage, rule_id, reason}

    def update_best(candidate: dict[str, Any]) -> None:
        nonlocal best
        if best is None or DECISION_RANK[candidate["decision"]] < DECISION_RANK[best["decision"]]:
            best = candidate

    # --- Layer 2: machine/admin ceiling (excluding `required`) --------------
    for rule in snapshot["machine_ceiling"]:
        if not isinstance(rule, dict):
            continue
        mode = rule.get("mode")
        if mode == "required" or not _matches_request(rule.get("match"), request):
            continue
        if mode == "allow":
            continue
        if mode == "deny":
            return _build_decision("deny", "machine_ceiling_deny", rule.get("rule_id"), rule.get("reason", ""))
        update_best({"decision": "ask", "stage": "machine_ceiling_ask", "rule_id": rule.get("rule_id"), "reason": rule.get("reason", "")})

    # --- Layer 3: explicit user policy + Electron-owned grants --------------
    layer3_auto_hit: Optional[dict[str, Any]] = None
    for rule in snapshot["user_policy"]:
        if not isinstance(rule, dict) or not _matches_request(rule.get("match"), request):
            continue
        decision = rule.get("decision")
        if decision == "deny":
            return _build_decision("deny", "user_policy", rule.get("rule_id"), rule.get("reason", ""))
        if decision == "auto" and layer3_auto_hit is None:
            layer3_auto_hit = rule
        if decision in ("ask", "auto"):
            update_best({"decision": decision, "stage": "user_policy", "rule_id": rule.get("rule_id"), "reason": rule.get("reason", "")})

    required_rules = [rule for rule in snapshot["machine_ceiling"] if isinstance(rule, dict) and rule.get("mode") == "required"]
    required_hit = _first_match(required_rules, request)
    if required_hit is not None and layer3_auto_hit is None:
        return _build_decision(
            "deny", "machine_ceiling_required_unmet", required_hit.get("rule_id"), required_hit.get("reason", "")
        )

    # --- Layer 4: workspace overrides (reduce-only: deny|ask only) ----------
    workspace_id = request.get("workspace_incarnation_id")
    if isinstance(workspace_id, str) and workspace_id:
        for rule in snapshot["workspace_overrides"]:
            if not isinstance(rule, dict) or rule.get("workspace_incarnation_id") != workspace_id:
                continue
            if not _matches_request(rule.get("match"), request):
                continue
            if rule.get("decision") == "deny":
                return _build_decision("deny", "workspace_override", rule.get("rule_id"), rule.get("reason", ""))
            update_best({"decision": "ask", "stage": "workspace_override", "rule_id": rule.get("rule_id"), "reason": rule.get("reason", "")})

    # --- Layer 5: manifest request is the ceiling of what is even possible --
    manifest_matches = [
        entry
        for entry in snapshot["manifest_requests"]
        if isinstance(entry, dict)
        and entry.get("publisher_id") == request.get("publisher_id")
        and entry.get("plugin_id") == request.get("plugin_id")
    ]
    if len(manifest_matches) > 1:
        return _build_decision(
            "deny", "ambiguous_authority", None, "multiple manifest_requests entries match the same publisher_id/plugin_id"
        )
    manifest_entry = manifest_matches[0] if manifest_matches else None
    requested_capabilities = manifest_entry.get("requested_capabilities") if manifest_entry else None
    if not manifest_entry or not isinstance(requested_capabilities, list) or request["capability"] not in requested_capabilities:
        return _build_decision(
            "deny", "manifest_not_requested", None, "plugin manifest does not request this capability; a request never grants itself"
        )

    if best is None:
        return _build_decision(
            "ask", "default_ask", None, "no rule authorized this capability at any layer; defaulting to ask rather than auto"
        )
    return _build_decision(best["decision"], best["stage"], best.get("rule_id"), best.get("reason", ""))


def _normalize_input_decision(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or value.get("decision") not in VALID_DECISIONS:
        return {"decision": "deny", "reason": "missing or malformed decision input; failing closed"}
    reason = value.get("reason")
    return {
        "decision": value["decision"],
        "reason": reason if isinstance(reason, str) and reason else "no reason supplied",
    }


def combine_plugin_and_tool_decision(plugin_decision: Any, tool_decision: Any) -> CombinedDecision:
    """Combine a plugin-capability decision with Jenny's tool-permission
    decision through the shared deny > ask > auto lattice, taking the more
    restrictive value. Never imports or reimplements
    sidecar.ai.config_models or the JS tools evaluator.
    """
    plugin = _normalize_input_decision(plugin_decision)
    tool = _normalize_input_decision(tool_decision)

    winner = "tie"
    if DECISION_RANK[plugin["decision"]] < DECISION_RANK[tool["decision"]]:
        winner = "plugin"
    elif DECISION_RANK[tool["decision"]] < DECISION_RANK[plugin["decision"]]:
        winner = "tool"

    final_decision = tool["decision"] if winner == "tool" else plugin["decision"]
    source = tool if winner == "tool" else plugin
    label = "plugin and tool policy agree" if winner == "tie" else f"{winner} policy is more restrictive"
    reason = " ".join(f"{label} ({final_decision}): {source['reason']}".split())[:MAX_COMBINED_REASON_CHARS]

    return {
        "decision": final_decision,
        "winner": winner,
        "reason": reason,
        "plugin_decision": plugin,
        "tool_decision": tool,
    }
