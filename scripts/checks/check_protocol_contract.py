"""Fail if required JSON-RPC protocol constants drift from contract."""
from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL_PATH = ROOT / "sidecar" / "protocol.py"

# Wire vocabulary contract from AGENTS.md: dotted+snake notification methods
# like `tool.executing`, `chat.phase_started`, or `runtime.gap_candidate`.
NOTIFICATION_NAME_RE = re.compile(r"^[a-z]+\.[a-z_]+$")

REQUIRED_CONSTANTS = {
    "INITIALIZE_METHOD": "initialize",
    "CHAT_SEND_METHOD": "chat.send",
    "SHUTDOWN_METHOD": "shutdown",
    "CHAT_TOKEN_METHOD": "chat.token",
    "CHAT_THINKING_METHOD": "chat.thinking",
    "TURN_EVENT_METHOD": "turn.event",
    "TOOL_EXECUTING_METHOD": "tool.executing",
    "TOOL_RESULT_METHOD": "tool.result",
    "CHAT_DONE_METHOD": "chat.done",
    "CHAT_ERROR_METHOD": "chat.error",
    "TOOL_REQUEST_APPROVAL_METHOD": "tool.request_approval",
}


def parse_string_constants(path: Path) -> dict[str, str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    constants: dict[str, str] = {}

    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        if not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str):
            continue
        constants[target.id] = node.value.value

    return constants


def _load_notification_allowlist(path: Path) -> tuple[list[str], list[str]]:
    """Extract literal strings inside the `ALLOWED_NOTIFICATION_METHODS`
    frozenset definition by resolving the referenced constant names against
    the protocol module's top-level assignments."""
    constants = parse_string_constants(path)
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    members: list[str] = []
    violations: list[str] = []
    declarations: list[ast.Assign | ast.AnnAssign] = []
    for node in tree.body:
        if isinstance(node, ast.AnnAssign):
            if (
                isinstance(node.target, ast.Name)
                and node.target.id == "ALLOWED_NOTIFICATION_METHODS"
            ):
                declarations.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "ALLOWED_NOTIFICATION_METHODS"
            for target in node.targets
        ):
            declarations.append(node)
    if len(declarations) != 1:
        return [], [
            "ALLOWED_NOTIFICATION_METHODS must have exactly one supported declaration "
            f"(found {len(declarations)})"
        ]
    declaration = declarations[0]
    value = declaration.value
    if not (
        isinstance(declaration, ast.AnnAssign)
        and isinstance(value, ast.Call)
        and isinstance(value.func, ast.Name)
        and value.func.id == "frozenset"
        and len(value.args) == 1
        and not value.keywords
        and isinstance(value.args[0], ast.Set)
    ):
        return [], ["ALLOWED_NOTIFICATION_METHODS has an unsupported declaration shape"]
    for element in value.args[0].elts:
        if isinstance(element, ast.Name):
            resolved = constants.get(element.id)
            if resolved is None:
                violations.append(
                    f"ALLOWED_NOTIFICATION_METHODS contains unresolved name {element.id!r}"
                )
            else:
                members.append(resolved)
        elif isinstance(element, ast.Constant) and isinstance(element.value, str):
            members.append(element.value)
        else:
            violations.append(
                "ALLOWED_NOTIFICATION_METHODS contains an unsupported member expression"
            )
    return members, violations


def main() -> int:
    constants = parse_string_constants(PROTOCOL_PATH)
    violations: list[str] = []

    for name, expected_value in REQUIRED_CONSTANTS.items():
        actual = constants.get(name)
        if actual != expected_value:
            violations.append(f"{name}: expected {expected_value!r}, got {actual!r}")

    notification_methods, allowlist_violations = _load_notification_allowlist(PROTOCOL_PATH)
    violations.extend(allowlist_violations)
    for method in notification_methods:
        if not NOTIFICATION_NAME_RE.match(method):
            violations.append(
                f"notification method {method!r} violates wire vocabulary contract "
                f"(expected pattern {NOTIFICATION_NAME_RE.pattern})"
            )

    if violations:
        print("FAIL: protocol contract drift detected")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: protocol contract check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

