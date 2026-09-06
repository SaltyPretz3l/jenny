"""Validate Phase 3 security posture invariants."""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

FALSE_SAFE_EXECUTABLES = frozenset(
    {
        "node",
        "npm",
        "npx",
        "yarn",
        "pnpm",
        "python",
        "python3",
        "pip",
        "pip3",
        "cargo",
        "rustc",
        "go",
        "make",
        "cmake",
        "gcc",
        "g++",
        "javac",
        "java",
        "dotnet",
        "mvn",
        "gradle",
        "curl",
        "wget",
        "patch",
        "tee",
    }
)
AMBIGUOUS_GIT_SUBCOMMANDS = frozenset({"branch", "fetch", "stash", "config"})


def _read(root: Path, rel_path: str) -> str:
    return (root / rel_path).read_text(encoding="utf-8")


def _literal_name_set(text: str, name: str) -> frozenset[str]:
    module = ast.parse(text)
    for node in module.body:
        value: ast.AST
        if isinstance(node, ast.Assign):
            if not any(
                isinstance(target, ast.Name) and target.id == name for target in node.targets
            ):
                continue
            value = node.value
        elif isinstance(node, ast.AnnAssign):
            if not isinstance(node.target, ast.Name) or node.target.id != name:
                continue
            if node.value is None:
                return frozenset()
            value = node.value
        else:
            continue
        if (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Name)
            and value.func.id == "frozenset"
            and value.args
        ):
            literal_value = ast.literal_eval(value.args[0])
            return frozenset(str(item) for item in literal_value)
        literal_value = ast.literal_eval(value)
        return frozenset(str(item) for item in literal_value)
    return frozenset()


def _call_matches(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
    callee: str,
    keyword: str,
    expected_value: ast.AST,
) -> bool:
    for node in ast.walk(function):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name):
            actual_callee = node.func.id
        elif isinstance(node.func, ast.Attribute):
            parts = [node.func.attr]
            owner = node.func.value
            while isinstance(owner, ast.Attribute):
                parts.append(owner.attr)
                owner = owner.value
            if isinstance(owner, ast.Name):
                parts.append(owner.id)
            actual_callee = ".".join(reversed(parts))
        else:
            continue
        if actual_callee != callee:
            continue
        for item in node.keywords:
            if item.arg == keyword and ast.dump(item.value) == ast.dump(expected_value):
                return True
    return False


def _function_has_required_calls(
    module: ast.Module,
    function_name: str,
    calls: tuple[tuple[str, str, ast.AST], ...],
) -> bool:
    function = next(
        (
            node
            for node in module.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == function_name
        ),
        None,
    )
    return function is not None and all(
        _call_matches(function, callee, keyword, expected_value)
        for callee, keyword, expected_value in calls
    )


def _validate_shell_classifier(root: Path) -> list[str]:
    text = _read(root, "sidecar/ai/tools/builtins/shell_security.py")
    safe = _literal_name_set(text, "SAFE_EXECUTABLES")
    approval_required = _literal_name_set(text, "APPROVAL_REQUIRED_EXECUTABLES")
    git_read = _literal_name_set(text, "_GIT_READ_SUBCOMMANDS")
    git_write = _literal_name_set(text, "_GIT_WRITE_SUBCOMMANDS")
    violations: list[str] = []
    false_safe = sorted(FALSE_SAFE_EXECUTABLES & safe)
    if false_safe:
        violations.append(f"false-safe executables remain auto-allowed: {false_safe}")
    missing_approval = sorted(FALSE_SAFE_EXECUTABLES - approval_required)
    if missing_approval:
        violations.append(f"false-safe executables missing approval routing: {missing_approval}")
    ambiguous_read = sorted(AMBIGUOUS_GIT_SUBCOMMANDS & git_read)
    if ambiguous_read:
        violations.append(f"ambiguous git subcommands remain read-only: {ambiguous_read}")
    missing_git_approval = sorted(AMBIGUOUS_GIT_SUBCOMMANDS - git_write)
    if missing_git_approval:
        violations.append(f"ambiguous git subcommands missing approval routing: {missing_git_approval}")
    return violations


def _validate_sanitization(root: Path) -> list[str]:
    text = _read(root, "sidecar/ai/tools/sanitization.py")
    required_tokens = {
        "_DATA_URI_RE": "inline data URI redaction",
        "data_exfiltration": "data-exfiltration prompt pattern",
        "hidden_html_comment": "hidden HTML comment prompt pattern",
        "scan_tool_arguments": "pre-dispatch argument scanner",
        "tool_arguments_flagged": "argument scan audit event",
    }
    return [
        f"sanitization missing {description}"
        for token, description in required_tokens.items()
        if token not in text
    ]


def _validate_source_attribution(root: Path) -> list[str]:
    checks = {
        "sidecar/ai/routing/tool_execution.py": (
            (
                "_build_output_chunk_emitter",
                (
                    (
                        "_loop_events.ToolOutputChunkEvent",
                        "tool_name",
                        ast.Name(id="tool_name", ctx=ast.Load()),
                    ),
                ),
            ),
            (
                "approval_if_needed",
                (
                    (
                        "scan_tool_arguments",
                        "tool_name",
                        ast.Attribute(
                            value=ast.Name(id="call", ctx=ast.Load()),
                            attr="tool_id",
                            ctx=ast.Load(),
                        ),
                    ),
                ),
            ),
            (
                "execute_tool",
                (
                    (
                        "scan_tool_arguments",
                        "tool_name",
                        ast.Attribute(
                            value=ast.Name(id="call", ctx=ast.Load()),
                            attr="tool_id",
                            ctx=ast.Load(),
                        ),
                    ),
                    (
                        "bounded_tool_output",
                        "tool_name",
                        ast.Name(id="result_tool_name", ctx=ast.Load()),
                    ),
                ),
            ),
        ),
        "sidecar/ai/mcp/transport_stdio.py": (
            (
                "_sanitize_mcp_detail",
                (("sanitize_tool_output", "tool_name", ast.Constant(value="mcp_stdio")),),
            ),
        ),
    }
    violations: list[str] = []
    for rel_path, required_functions in checks.items():
        module = ast.parse(_read(root, rel_path), filename=rel_path)
        if not all(
            _function_has_required_calls(module, function_name, calls)
            for function_name, calls in required_functions
        ):
            violations.append(f"{rel_path} missing executable sanitizer attribution")
    return violations


def _validate_web_metadata_filter(root: Path) -> list[str]:
    # DuckDuckGo HTML fallback URL filtering is owned by web_ddg.py.
    text = _read(root, "sidecar/ai/tools/builtins/web_ddg.py")
    match = re.search(
        r"def _extract_ddg_html_results\(.*?^def _ddg_html_search",
        text,
        re.DOTALL | re.MULTILINE,
    )
    if match is None or "_is_safe_metadata_url(url)" not in match.group(0):
        return ["DuckDuckGo HTML fallback does not filter unsafe metadata URLs"]
    return []


def _validate_safety_mode(root: Path) -> list[str]:
    # Safety-mode ownership is split between config_parsing.py and config_models.py.
    checks = {
        "sidecar/ai/config_parsing.py": ("VALID_SAFETY_MODES",),
        "sidecar/ai/config_models.py": ("safety_mode: str = \"normal\"",),
        "sidecar/ai/tools/assembly.py": ("SAFETY_MODE_STRICT_REASON", "disabled_tool_families"),
        "sidecar/ai/routing/tool_execution.py": ("paranoid_mode", "Paranoid safety mode"),
    }
    violations: list[str] = []
    for rel_path, required_fragments in checks.items():
        text = _read(root, rel_path)
        for fragment in required_fragments:
            if fragment not in text:
                violations.append(f"{rel_path} missing safety-mode fragment: {fragment}")
    return violations


def _validate_mcp_phase3a(root: Path) -> list[str]:
    checks = {
        "sidecar/ai/mcp/transport_stdio.py": ("MCPProcessContainment", "popen_kwargs"),
        "sidecar/ai/mcp/process_containment.py": ("memory_limit_mb", "max_processes"),
        "sidecar/ai/mcp/tool_namespace.py": ("mcp__", "namespace_mcp_tool_name"),
        "sidecar/ai/mcp/client.py": ("_resolve_tool_descriptor", "bare_tool_name_compat"),
    }
    violations: list[str] = []
    for rel_path, required_fragments in checks.items():
        text = _read(root, rel_path)
        for fragment in required_fragments:
            if fragment not in text:
                violations.append(f"{rel_path} missing Phase 3A fragment: {fragment}")
    return violations


def validate_phase3_security_invariants(root: Path = ROOT) -> list[str]:
    violations: list[str] = []
    violations.extend(_validate_shell_classifier(root))
    violations.extend(_validate_sanitization(root))
    violations.extend(_validate_source_attribution(root))
    violations.extend(_validate_web_metadata_filter(root))
    violations.extend(_validate_safety_mode(root))
    violations.extend(_validate_mcp_phase3a(root))
    if not (root / "SECURITY.md").exists():
        violations.append("SECURITY.md is missing")
    return violations


def main() -> int:
    try:
        violations = validate_phase3_security_invariants(ROOT)
    except Exception as exc:  # noqa: BLE001 - policy checks should fail with context.
        print(f"FAIL: phase3 security invariant check crashed: {exc}")
        return 1
    if violations:
        print("FAIL: phase3 security invariant drift detected")
        for violation in violations:
            print(f"  - {violation}")
        return 1
    print("PASS: phase3 security invariants")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
