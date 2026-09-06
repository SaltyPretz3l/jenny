"""Mechanize the plugin-platform boundary invariants that hold at every stage.

Enforced rules (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md):

1. Invariant 1 direction guard: sidecar core never imports the sidecar plugin
   package, and Electron core (outside the allowlisted composition seams) never
   requires the plugin control plane. Plugin *package* code is never imported
   anywhere by construction (packages are data under userData, not repo code);
   this check pins the repo-side seams so that stays true.
2. PLUG-D06: no preload module may live under the plugin trees — the only
   preloads are the Jenny-owned bundles produced by scripts/build.
3. Program size rule: every hand-written file under the plugin trees (production
   and test) stays at or under 600 raw lines, so the shared complexity-ratchet
   baseline never moves for plugin work. Generated contract artifacts are
   exempt here and capped by check_file_size.py instead.

Seams that later stages legitimately open are added to the explicit allowlists
below in the same commit that opens them — never widened speculatively.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ACORN_PATH = ROOT / "node_modules" / "acorn"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks.bounded_process import resolve_executable, run_bounded  # noqa: E402

# This check runs under the blocking pre-commit gate (scripts/checks/run_all.py)
# and its inspect_javascript() is imported by check_plugin_stage5_budgets.py,
# check_plugin_stage8_boundary.py, and tests/sidecar/test_policy_checks.py, so an
# unbounded Node probe can hang a commit or a test run with no error to read. The
# whole check is ~3.5s end to end; the ceiling only has to sit far enough above
# that to never fire on a loaded machine.
NODE_PROBE_TIMEOUT_SECONDS = 120

PLUGIN_TREES = ("services/plugins", "sidecar/ai/plugins")
PLUGIN_TEST_PREFIXES = (
    "tests/plugin-",
    "tests/plugins-",
    # Directory form. The two bare prefixes above glob "tests/plugin-*" and
    # "tests/plugins-*", neither of which matches the DIRECTORY "tests/plugins",
    # so per-packet suites under tests/plugins/<topic>/ escaped the size ratchet
    # entirely until this entry was added.
    "tests/plugins/",
    "tests/helpers/plugins/",
    "tests/sidecar/ai/plugins/",
)
MAX_PLUGIN_FILE_LINES = 600
GENERATED_NAME_MARKERS = ("generated-plugin-", "generated_plugin_")

# JS_CORE_ALLOWLIST names exact Electron-to-plugin composition seams; every
# addition requires explicit boundary review.
JS_CORE_ALLOWLIST: frozenset[str] = frozenset({
    "services/backend/local-engine-requests.js",
    "services/main/plugin-view-controller.js",
    "services/main/plugins-ipc-registration.js",
    "services/main/plugins-developer-profile.js",
    "services/main/plugin-stage8-registration.js",
})
# Sidecar files allowed to import sidecar.ai.plugins. Stage 4A opened the
# plugin-only initialize seam; Stage 4B adds command/workflow admission and the
# existing tool-dispatch recheck. Keeping the exact callers here makes the
# cross-layer seam reviewable rather than allowing an entire directory.
PY_CORE_ALLOWLIST: frozenset[str] = frozenset({
    "sidecar/ai/container.py",
    "sidecar/runtime/plugin_workflow_bridge.py",
    "sidecar/runtime/request_dispatch_chat.py",
    "sidecar/runtime/request_dispatch_chat_support.py",
})

# Match module-resolution forms only (require/import specifiers), not prose or
# comments — a doc comment naming the path is legitimate (bug class: raw text
# checks matching comments).
PY_REFERENCE = re.compile(
    r"(?:^|\n)\s*(?:from\s+sidecar\.ai\.plugins|import\s+sidecar\.ai\.plugins)"
)
EXCLUDED_DIR_NAMES = {
    ".git", ".venv", ".tmp", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", "node_modules", "dist", "build", "out", "coverage", "vendor",
}

_JAVASCRIPT_FACTS_PROBE = r"""
const fs = require('node:fs');
const acorn = require(process.argv[1]);

function propertyName(node) {
  if (!node) return null;
  if (!node.computed && node.key?.type === 'Identifier') return node.key.name;
  if (node.key?.type === 'Literal') return String(node.key.value);
  return null;
}

function calleeName(node) {
  if (!node) return null;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression') return null;
  const object = calleeName(node.object);
  const property = node.computed
    ? (node.property?.type === 'Literal' ? String(node.property.value) : null)
    : node.property?.name;
  return object && property ? `${object}.${property}` : null;
}

function evaluate(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((item) => item.value.cooked).join('');
  }
  if (node.type === 'ArrayExpression') {
    return node.elements.map((item) => evaluate(item) ?? null);
  }
  if (node.type === 'ObjectExpression') {
    const value = {};
    for (const property of node.properties) {
      if (property.type !== 'Property') return undefined;
      const key = propertyName(property);
      const item = evaluate(property.value);
      if (key === null) return undefined;
      value[key] = item ?? null;
    }
    return value;
  }
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator)) {
    const argument = evaluate(node.argument);
    if (typeof argument !== 'number') return undefined;
    return node.operator === '-' ? -argument : argument;
  }
  if (node.type === 'BinaryExpression') {
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    if (typeof left !== 'number' || typeof right !== 'number') return undefined;
    if (node.operator === '+') return left + right;
    if (node.operator === '-') return left - right;
    if (node.operator === '*') return left * right;
    if (node.operator === '/') return left / right;
    return undefined;
  }
  if (node.type === 'CallExpression') {
    const callee = calleeName(node.callee);
    if (callee === 'Object.freeze' && node.arguments.length === 1) {
      return evaluate(node.arguments[0]);
    }
    const args = node.arguments.map(evaluate);
    if (callee && !args.some((value) => value === undefined)) {
      return { $call: callee, args };
    }
  }
  return undefined;
}

function patternNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name];
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) => (
      property.type === 'Property' ? patternNames(property.value) : []
    ));
  }
  return [];
}

function functionLabel(node, parent, current) {
  const functionTypes = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'];
  if (!functionTypes.includes(node.type)) {
    return current;
  }
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (parent?.type === 'MethodDefinition' || parent?.type === 'Property') {
    return propertyName(parent) || current;
  }
  return current;
}

function inspect(source) {
  let tree;
  try {
    tree = acorn.parse(source, {
      ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true,
    });
  } catch (_scriptError) {
    tree = acorn.parse(source, {
      ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true,
    });
  }
  const facts = {
    imports: [], declarations: {}, functions: [], calls: [], members: [], properties: [],
    literals: [],
  };

  function visit(node, parent = null, currentFunction = null) {
    if (!node || typeof node.type !== 'string') return;
    const activeFunction = functionLabel(node, parent, currentFunction);
    if (activeFunction !== currentFunction && activeFunction) facts.functions.push(activeFunction);

    if (node.type === 'ImportDeclaration') {
      facts.imports.push({
        source: String(node.source.value),
        names: node.specifiers.map((specifier) => specifier.local.name),
      });
    }
    if (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      facts.imports.push({ source: String(node.source.value), names: [] });
    }
    if (node.type === 'ImportExpression' && node.source.type === 'Literal') {
      facts.imports.push({ source: String(node.source.value), names: [] });
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      const value = evaluate(node.init);
      if (value !== undefined) facts.declarations[node.id.name] = value;
    }
    if (node.type === 'Literal') {
      facts.literals.push({ function: activeFunction, value: node.value });
    }
    if (node.type === 'CallExpression') {
      const callee = calleeName(node.callee);
      const args = node.arguments.map(evaluate);
      facts.calls.push({ callee, function: activeFunction, args });
      if (callee === 'require' && typeof args[0] === 'string') {
        const names = parent?.type === 'VariableDeclarator' ? patternNames(parent.id) : [];
        facts.imports.push({ source: args[0], names });
      }
    }
    if (node.type === 'MemberExpression') {
      facts.members.push({
        function: activeFunction,
        object: calleeName(node.object),
        property: node.computed && node.property.type === 'Literal'
          ? String(node.property.value) : node.property.name || null,
      });
    }
    if (node.type === 'Property') {
      const value = evaluate(node.value);
      facts.properties.push({ function: activeFunction, key: propertyName(node), value });
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child, node, activeFunction);
      } else if (value && typeof value.type === 'string') {
        visit(value, node, activeFunction);
      }
    }
  }

  visit(tree);
  return facts;
}

const paths = JSON.parse(fs.readFileSync(0, 'utf8'));
const output = {};
for (const filename of paths) {
  output[filename] = inspect(fs.readFileSync(filename, 'utf8'));
}
process.stdout.write(JSON.stringify(output));
"""


def inspect_javascript(root: Path, paths: list[Path]) -> dict[str, dict[str, object]]:
    if not paths:
        return {}
    completed = run_bounded(
        [
            resolve_executable("node", needed_for="the plugin JavaScript AST probe"),
            "-e",
            _JAVASCRIPT_FACTS_PROBE,
            str(ACORN_PATH),
        ],
        label="Plugin boundary JavaScript AST probe",
        timeout_seconds=NODE_PROBE_TIMEOUT_SECONDS,
        cwd=root,
        input_text=json.dumps([str(path.resolve()) for path in paths]),
        errors="replace",
    )
    if completed.returncode != 0:
        detail = (
            completed.stderr.strip()
            or completed.stdout.strip()
            or "unknown Node probe failure"
        )
        raise RuntimeError(f"JavaScript AST inspection failed: {detail}")
    payload = json.loads(completed.stdout)
    if not isinstance(payload, dict):
        raise RuntimeError("JavaScript AST inspection returned a non-object result")
    return payload


def _specifier_targets_plugin_tree(root: Path, importer: Path, specifier: str) -> bool:
    normalized = specifier.replace("\\", "/")
    if normalized.startswith("services/plugins/"):
        return True
    if not normalized.startswith("."):
        return False
    resolved = (importer.parent / normalized).resolve()
    try:
        resolved.relative_to((root / "services" / "plugins").resolve())
    except ValueError:
        return False
    return True


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _iter_files(base: Path, suffixes: tuple[str, ...]) -> list[Path]:
    if not base.exists():
        return []
    found: list[Path] = []
    for candidate in base.rglob("*"):
        if not candidate.is_file() or candidate.suffix not in suffixes:
            continue
        if any(part in EXCLUDED_DIR_NAMES for part in candidate.parts):
            continue
        found.append(candidate)
    return found


def _line_count(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for _ in handle)


def _check_size_rule() -> list[str]:
    violations: list[str] = []
    targets: list[Path] = []
    for tree in PLUGIN_TREES:
        targets.extend(_iter_files(ROOT / tree, (".js", ".py")))
    for prefix in PLUGIN_TEST_PREFIXES:
        base = ROOT / prefix
        if prefix.endswith("/"):
            targets.extend(_iter_files(base, (".js", ".py")))
        else:
            parent = base.parent
            if parent.exists():
                for candidate in parent.glob(base.name + "*"):
                    if candidate.is_file() and candidate.suffix in (".js", ".py"):
                        targets.append(candidate)
    for path in targets:
        name = path.name
        if any(marker in name for marker in GENERATED_NAME_MARKERS):
            continue
        count = _line_count(path)
        if count > MAX_PLUGIN_FILE_LINES:
            violations.append(
                f"{_rel(path)} has {count} lines "
                f"(plugin-tree cap {MAX_PLUGIN_FILE_LINES}; split it)"
            )
    return violations


def _check_no_preload_in_plugin_trees() -> list[str]:
    violations: list[str] = []
    for tree in PLUGIN_TREES:
        base = ROOT / tree
        if not base.exists():
            continue
        for candidate in base.rglob("*preload*"):
            if candidate.is_file():
                violations.append(
                    f"{_rel(candidate)}: preload modules must not live under plugin trees "
                    "(PLUG-D06)"
                )
    return violations


def _check_js_core_references() -> list[str]:
    violations: list[str] = []
    roots = [ROOT / "renderer", ROOT / "services", ROOT / "scripts" / "build"]
    singles = [ROOT / "main.js", ROOT / "preload.js"]
    candidates: list[Path] = list(filter(Path.exists, singles))
    for base in roots:
        candidates.extend(_iter_files(base, (".js",)))
    try:
        facts_by_path = inspect_javascript(ROOT, candidates)
    except (OSError, RuntimeError, ValueError) as error:
        return [str(error)]
    for path in candidates:
        rel = _rel(path)
        if rel.startswith("services/plugins/") or rel in JS_CORE_ALLOWLIST:
            continue
        facts = facts_by_path.get(str(path.resolve()), {})
        imports = facts.get("imports", []) if isinstance(facts, dict) else []
        if any(
            isinstance(item, dict)
            and isinstance(item.get("source"), str)
            and _specifier_targets_plugin_tree(ROOT, path, item["source"])
            for item in imports
        ):
            violations.append(
                f"{rel} references services/plugins/ "
                "(core seam not allowlisted; see JS_CORE_ALLOWLIST)"
            )
    return violations


def _check_py_core_references() -> list[str]:
    violations: list[str] = []
    for path in _iter_files(ROOT / "sidecar", (".py",)):
        rel = _rel(path)
        if rel.startswith("sidecar/ai/plugins/") or rel in PY_CORE_ALLOWLIST:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if PY_REFERENCE.search(text):
            violations.append(
                f"{rel} imports sidecar.ai.plugins "
                "(core seam not allowlisted; see PY_CORE_ALLOWLIST)"
            )
    return violations


def _self_test() -> list[str]:
    """Guard PY_REFERENCE against the raw-text-matches-comments bug class."""
    cases = (
        ("from sidecar.ai.plugins import policy", True),
        ("import sidecar.ai.plugins", True),
        ("    from sidecar.ai.plugins import policy", True),
        ("# see from sidecar.ai.plugins import policy", False),
        ("#\n# import sidecar.ai.plugins", False),
        ('"""Docs: import sidecar.ai.plugins for the algebra."""', False),
        ('MSG = "import sidecar.ai.plugins"', False),
        # Known false positive: accepted because avoiding it requires Python AST parsing.
        ('"""Example usage:\n\nimport sidecar.ai.plugins\n"""', True),
    )
    failures: list[str] = []
    for sample, should_match in cases:
        if bool(PY_REFERENCE.search(sample)) is not should_match:
            verb = "failed to match" if should_match else "wrongly matched"
            failures.append(f"PY_REFERENCE self-test: {verb} {sample!r}")
    return failures


def main() -> int:
    self_test_failures = _self_test()
    if self_test_failures:
        print("FAIL: plugin boundary check (PY_REFERENCE self-test)")
        for item in self_test_failures:
            print(f"  - {item}")
        return 1
    violations = (
        _check_size_rule()
        + _check_no_preload_in_plugin_trees()
        + _check_js_core_references()
        + _check_py_core_references()
    )
    if violations:
        print("FAIL: plugin boundary check")
        for item in violations:
            print(f"  - {item}")
        return 1
    print("PASS: plugin boundary check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
