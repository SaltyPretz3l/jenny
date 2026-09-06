"""Fail if the canonical turn-event taxonomy drifts across the JS/Python boundary.

This check fails fast in CI when:
  - A kind appears in `LIVE_CAPTURED_KINDS` (JS) that is NOT in
    `ALLOWED_TURN_EVENT_KINDS` (Python). This is the high-risk direction:
    the Electron collector would persist a kind that no fixture / replay test
    can describe.
  - A live-capture-mappable notification method (`tool.executing`,
    `tool.result`, `tool.request_approval`) loses its corresponding live
    kind on the JS side.

The check intentionally does NOT require every Python `ALLOWED_TURN_EVENT_KINDS`
entry to be in `LIVE_CAPTURED_KINDS`. Most kinds are synthesized by the
Electron collector or the chat-send result projection, not live-captured.

Exits 0 on agreement, 1 with a human-readable diff on drift.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# The taxonomy Sets live in the collector's normalization sibling, not the
# collector itself — they moved there when the collector was split for line-cap
# headroom. Both `LIVE_CAPTURED_KINDS` and the `TOOL_RELATED_KINDS` it spreads
# are in this one file, which is what `_extract_js_set_entries` needs.
JS_COLLECTOR_PATH = ROOT / "services" / "backend" / "canonical-turn-event-collector-normalize.js"
PY_FIXTURE_FORMAT_PATH = ROOT / "tests" / "sidecar" / "replay" / "fixture_format.py"
PY_PROTOCOL_PATH = ROOT / "sidecar" / "protocol.py"

# Notification methods that the Electron collector turns into live-captured
# turn-event kinds. The mapping mirrors `chat-stream-tool-handling.js` and
# `chat-stream-bridge.js` in the Electron path. Update this table when the
# wire-to-kind translation changes.
NOTIFICATION_METHOD_TO_LIVE_KIND: dict[str, str] = {
    "tool.executing": "tool_executing",
    "tool.result": "tool_result",
    "tool.request_approval": "approval_requested",
}


def _extract_js_set_entries(source: str, set_name: str) -> set[str]:
    """Parse a `const NAME = new Set([...])` literal from the JS collector.

    The collector also has `LIVE_CAPTURED_KINDS = new Set([...TOOL_RELATED_KINDS, 'reasoning_phase', 'plan_object'])`
    so we resolve `...TOOL_RELATED_KINDS` by recursing once.
    """
    pattern = re.compile(
        rf"const\s+{re.escape(set_name)}\s*=\s*new\s+Set\(\s*\[(?P<body>[^\]]*?)\]\s*\)\s*;",
        re.DOTALL,
    )
    match = pattern.search(source)
    if not match:
        raise ValueError(f"could not locate `{set_name}` Set literal in JS source")
    body = match.group("body")

    entries: set[str] = set()
    for raw in body.split(","):
        token = raw.strip()
        if not token:
            continue
        if token.startswith("//"):
            continue
        spread_match = re.match(r"\.\.\.([A-Za-z_][A-Za-z0-9_]*)", token)
        if spread_match:
            referenced = spread_match.group(1)
            entries.update(_extract_js_set_entries(source, referenced))
            continue
        literal_match = re.match(r"['\"]([^'\"]+)['\"]", token)
        if literal_match:
            entries.add(literal_match.group(1))
            continue
        # Skip inline comments embedded mid-array (handled by the leading // check
        # for line-style comments; `/* */` block comments would need a stripping
        # pass, but the collector does not use them today).
    return entries


def _extract_python_frozenset_entries(path: Path, name: str) -> set[str]:
    """Parse `NAME: frozenset[str] = frozenset({...})` and return the literal entries.

    Supports both direct string literals and constant-reference references; the
    fixture_format.py case uses string literals only, but `ALLOWED_NOTIFICATION_METHODS`
    in protocol.py uses `CHAT_TOKEN_METHOD`-style constants, so we resolve those
    against the file's other top-level assignments.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    string_constants: dict[str, str] = {}
    target_call: ast.Call | None = None

    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id == name and isinstance(node.value, ast.Call):
                target_call = node.value
                continue
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name):
                if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    string_constants[target.id] = node.value.value

    if target_call is None:
        raise ValueError(f"could not locate `{name}` annotated assignment in {path}")
    if not target_call.args:
        raise ValueError(f"`{name}` frozenset has no arguments in {path}")

    inner = target_call.args[0]
    if not isinstance(inner, ast.Set):
        raise ValueError(f"`{name}` frozenset argument is not a set literal in {path}")

    entries: set[str] = set()
    for element in inner.elts:
        if isinstance(element, ast.Constant) and isinstance(element.value, str):
            entries.add(element.value)
            continue
        if isinstance(element, ast.Name) and element.id in string_constants:
            entries.add(string_constants[element.id])
            continue
        raise ValueError(
            f"unexpected element {ast.dump(element)} in `{name}` frozenset; "
            "drift gate cannot resolve it"
        )
    return entries


def main() -> int:
    js_source = JS_COLLECTOR_PATH.read_text(encoding="utf-8")
    live_kinds_js = _extract_js_set_entries(js_source, "LIVE_CAPTURED_KINDS")
    fixture_kinds_py = _extract_python_frozenset_entries(
        PY_FIXTURE_FORMAT_PATH, "ALLOWED_TURN_EVENT_KINDS"
    )
    notification_methods_py = _extract_python_frozenset_entries(
        PY_PROTOCOL_PATH, "ALLOWED_NOTIFICATION_METHODS"
    )

    failures: list[str] = []

    # 1. Every JS LIVE_CAPTURED_KINDS entry must be in Python ALLOWED_TURN_EVENT_KINDS.
    js_only = sorted(live_kinds_js - fixture_kinds_py)
    if js_only:
        failures.append(
            "Kinds in JS `LIVE_CAPTURED_KINDS` but missing from Python "
            "`ALLOWED_TURN_EVENT_KINDS`:\n  " + ", ".join(js_only)
        )

    # 2. Every notification method that maps to a live kind must (a) be in the
    #    Python notification allow-list and (b) have its mapped kind in JS
    #    LIVE_CAPTURED_KINDS.
    for method, expected_kind in NOTIFICATION_METHOD_TO_LIVE_KIND.items():
        if method not in notification_methods_py:
            failures.append(
                f"Notification method `{method}` is in the drift-gate mapping "
                f"but missing from Python `ALLOWED_NOTIFICATION_METHODS`."
            )
        if expected_kind not in live_kinds_js:
            failures.append(
                f"Notification method `{method}` should produce live-captured "
                f"kind `{expected_kind}`, but that kind is missing from JS "
                f"`LIVE_CAPTURED_KINDS`."
            )

    if failures:
        sys.stderr.write(
            "Event-taxonomy drift detected between Electron collector and sidecar "
            "fixture / protocol contracts:\n\n"
        )
        for failure in failures:
            sys.stderr.write(f"- {failure}\n\n")
        sys.stderr.write(
            "Resolve by updating the smaller side (or the mapping in this "
            "check) so JS LIVE_CAPTURED_KINDS, Python ALLOWED_TURN_EVENT_KINDS, "
            "and Python ALLOWED_NOTIFICATION_METHODS agree.\n"
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
