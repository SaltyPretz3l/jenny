"""Require/import-graph source->test EXISTENCE gate for designated directories.

Every non-trivial source file in a designated directory must be reachable from
the test import graph -- i.e. some test (directly or transitively, through
helpers and lazy/inline requires) imports it. This catches source files that
ship with NO discoverable test at all (the "canyon" failure mode), which a
line-coverage number alone hides when integration tests happen to reach a file.

This is deliberately NOT stem-match (does a same-named test file exist):
services/backend is only ~53% stem-match yet ~90%+ reachable through integration
tests, so stem-match produced the audit's bogus "zero coverage" labels (see
docs/process/COVERAGE_BASELINE.md). It is also NOT line coverage (the Phase 3
ratchet owns that). It is a structural reachability check, modeled on
scripts/checks/check_sidecar_reachability.py (AST import graph) for Python and an
equivalent require()/import-literal graph for JavaScript.

Escape hatch: scripts/checks/test_coverage_allowlist.json. Each entry is a
temporary debt marker (path + label + reason + expires_on + plan_doc) and the
list is strictly shrinking -- modeled on check_file_size.LEGACY_SIZE_ALLOWLIST:
  - expired entries fail
  - entries whose file is now reached (or is a shim, or no longer exists) fail
    and must be removed

Trivial re-export shims (a file that only re-exports another module, no logic)
are skipped -- they need no dedicated test.

Runs in the blocking check:policy step (pure stdlib, sub-second). Exit 0 = clean,
exit 1 = an undocumented gap or an invalid/stale allowlist entry.
"""
from __future__ import annotations

import ast
import json
import os
import re
from collections import deque
from dataclasses import dataclass
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLAN_DOC = "docs/plans/TEST_COVERAGE_RATCHET.md"
ALLOWLIST_PATH = ROOT / "scripts" / "checks" / "test_coverage_allowlist.json"

EXCLUDED_DIR_NAMES = {
    ".git", ".venv", ".tmp", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", "node_modules", "dist", "build", "out", "coverage", "vendor",
}

JS_DESIGNATED_DIRS = ["services/main", "services/backend", "services/plugins"]
# routing + runtime are the orchestration core; tools + mcp are the
# high-blast-radius execution surface (filesystem/shell/network/MCP) and get the
# same "every non-trivial file needs a discoverable test" guarantee so a new
# tool/server file cannot ship with no test at all.
PY_DESIGNATED_DIRS = [
    "sidecar/ai/routing",
    "sidecar/runtime",
    "sidecar/ai/tools",
    "sidecar/ai/mcp",
    "sidecar/ai/repo_delta",
    # Plugin-platform authority surfaces: every non-trivial file in the plugin
    # control plane (JS) and its sidecar peers (generated contracts, policy)
    # must be reachable from the test import graph from day one.
    "sidecar/ai/plugins",
]

# Repo subtrees scanned to build the JS require graph. Renderer code runs in a
# separate (browser) process and never requires the main-process services/**
# dirs, so it is left out to keep this check sub-second; the graph still reaches
# every services file through services/** + main entrypoints + tests/**.
JS_GRAPH_DIRS = ["services", "tests"]
JS_GRAPH_ROOT_FILES = ["main.js", "preload.js", "preload-overlay.js", "overlay-window.js", "start.js"]

JS_SUFFIXES = {".js", ".cjs", ".mjs"}
JS_TEST_RE = re.compile(r"\.test\.(c|m)?js$")

# Module-specifier extraction is string- and comment-aware via a single
# left-to-right tokenizer pass (one compiled regex). Comments and string
# literals are matched as whole tokens, so a require()/import written inside a
# comment or a string creates NO edge, and a comment delimiter that appears
# inside a string (e.g. the literal "/*.test.js") cannot eat the real requires
# around it. A specifier is captured only when a string token is ADJACENT to a
# require(/import(/`from`/bare-`import` keyword token (the keyword's \s* consumes
# up to the string), so `x.from; ... 'unrelated'` does not create a phantom edge.
# Lazy/inline requires inside function bodies are still captured -- that is how
# ipc-handler-registration.js reaches session-export-import etc. The leading
# (?<![\w$]) guards against myRequire(...) / reimport(...) false matches.
_JS_TOKEN_RE = re.compile(
    r"(?P<line>//[^\n]*)"
    r"|(?P<block>/\*[\s\S]*?\*/)"
    r"|(?P<dq>\"(?:\\.|[^\"\\])*\")"
    r"|(?P<sq>'(?:\\.|[^'\\])*')"
    r"|(?P<tpl>`(?:\\.|[^`\\])*`)"
    r"|(?P<call>(?<![\w$])(?:require|import)\s*\(\s*)"
    r"|(?P<frm>(?<![\w$])from\s*)"
    r"|(?P<bare>(?<![\w$])import\s+)"
)

# Comment/string-aware "skeleton" used only by the cold-path shim detector
# (called on the few candidate files): comments removed, string literals blanked.
_SENT = "\x00"

JS_LOGIC_MARKERS = (
    "function", "=>", "class ", "if(", "if (", "for(", "for (", "while(",
    "while (", "switch(", "switch (", "try{", "try ", "new ",
)


def _iter_files(base: Path, suffixes: set[str]):
    if not base.exists():
        return
    for path in base.rglob("*"):
        if any(part in EXCLUDED_DIR_NAMES for part in path.parts):
            continue
        if path.is_file() and path.suffix in suffixes:
            yield path


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _js_skeleton(text: str) -> tuple[str, list[str]]:
    """Return (skeleton, strings): comments removed, string literals replaced by
    \\x00<index>\\x00 sentinels. A single char-by-char scan that consumes whole
    string literals (handling escapes) and whole comments, so a comment delimiter
    inside a string and a require()/string inside a comment are both handled
    correctly. Template literals are treated as opaque strings (a static template
    specifier still resolves; an interpolated one is dynamic and resolves to
    nothing, which is correct)."""
    strings: list[str] = []
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            i += 2
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and nxt == "*":
            i += 2
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                i += 1
            i += 2
            out.append(" ")
            continue
        if c in ("'", '"', "`"):
            quote = c
            i += 1
            buf: list[str] = []
            while i < n:
                ch = text[i]
                if ch == "\\":
                    buf.append(ch)
                    if i + 1 < n:
                        buf.append(text[i + 1])
                    i += 2
                    continue
                if ch == quote:
                    i += 1
                    break
                buf.append(ch)
                i += 1
            out.append(f"{_SENT}{len(strings)}{_SENT}")
            strings.append("".join(buf))
            continue
        out.append(c)
        i += 1
    return "".join(out), strings


def _extract_js_specifiers(text: str) -> set[str]:
    out: set[str] = set()
    awaiting = False
    await_end = -1
    for match in _JS_TOKEN_RE.finditer(text):
        kind = match.lastgroup
        if kind in ("line", "block"):
            continue  # comments are transparent (treated like whitespace)
        if kind in ("dq", "sq", "tpl"):
            if awaiting and match.start() == await_end:
                out.add(match.group()[1:-1])  # strip the surrounding quotes
            awaiting = False
            continue
        # require(/import( / `from` / bare `import` keyword: expect an adjacent string next.
        awaiting = True
        await_end = match.end()
    return out


# ---------------------------------------------------------------------------
# JavaScript require graph
# ---------------------------------------------------------------------------

def _discover_js_files() -> dict[str, Path]:
    files: dict[str, Path] = {}
    for rel_dir in JS_GRAPH_DIRS:
        for path in _iter_files(ROOT / rel_dir, JS_SUFFIXES):
            files[_rel(path)] = path
    for name in JS_GRAPH_ROOT_FILES:
        path = ROOT / name
        if path.is_file():
            files[_rel(path)] = path
    return files


def _resolve_js_specifier(importer_key: str, specifier: str, known: set[str]) -> str | None:
    if not (specifier in (".", "..") or specifier.startswith("./") or specifier.startswith("../")):
        return None  # bare specifier -> node_modules / builtin, external
    # Resolve relative to the importer's dir in pure string math. `known` keys are
    # repo-relative POSIX paths, so the candidate keys are too -- and a Path.resolve()
    # syscall per specifier cost ~150ms across the whole graph for no benefit.
    base = os.path.normpath(os.path.join(os.path.dirname(importer_key), specifier)).replace("\\", "/")
    if base in (".", "..") or base.startswith("../"):
        return None  # resolves to / escapes the repo root
    candidates = [base, *(base + ext for ext in (".js", ".cjs", ".mjs", ".json"))]
    candidates += [f"{base}/index{ext}" for ext in (".js", ".cjs", ".mjs")]
    for candidate in candidates:
        if candidate in known:
            return candidate
    return None


def _build_js_edges(files: dict[str, Path]) -> dict[str, set[str]]:
    known = set(files)
    edges: dict[str, set[str]] = {key: set() for key in files}
    for key, path in files.items():
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if "require" not in text and "import" not in text and "from" not in text:
            continue  # no module-specifier keyword -> no edges, skip the scan
        for spec in _extract_js_specifiers(text):
            target = _resolve_js_specifier(key, spec, known)
            if target is not None:
                edges[key].add(target)
    return edges


def _is_js_shim(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    code, _ = _js_skeleton(text)
    lines = [line.strip() for line in code.splitlines() if line.strip()]
    if not lines or len(lines) > 15:
        return False
    joined = " ".join(lines)
    has_reexport = ("require(" in joined or " from " in joined) and (
        "module.exports" in joined or "exports." in joined or joined.startswith("export ")
        or " export " in joined
    )
    if not has_reexport:
        return False
    return not any(marker in joined for marker in JS_LOGIC_MARKERS)


# ---------------------------------------------------------------------------
# Python import graph (mirrors check_sidecar_reachability.read_edges)
# ---------------------------------------------------------------------------

def _py_module_from_path(path: Path) -> str:
    rel = path.relative_to(ROOT)
    rel = rel.parent if rel.name == "__init__.py" else rel.with_suffix("")
    return ".".join(rel.parts)


def _discover_py_modules(base: Path) -> dict[str, Path]:
    modules: dict[str, Path] = {}
    for path in base.rglob("*.py"):
        if any(part in EXCLUDED_DIR_NAMES for part in path.parts):
            continue
        modules[_py_module_from_path(path)] = path
    return modules


def _resolve_py_module(name: str, known: set[str]) -> str | None:
    parts = name.split(".")
    for i in range(len(parts), 0, -1):
        candidate = ".".join(parts[:i])
        if candidate in known:
            return candidate
    return None


def _build_py_edges(modules: dict[str, Path], known: set[str]) -> dict[str, set[str]]:
    edges: dict[str, set[str]] = {name: set() for name in modules}
    for importer, path in modules.items():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        # A package __init__.py maps to the PACKAGE name itself, so `from .x`
        # (level 1) inside it anchors to the package, not its parent -- drop
        # (level - 1) components for packages vs `level` for regular modules.
        is_package = path.name == "__init__.py"

        def add(target: str, _importer: str = importer) -> None:
            resolved = _resolve_py_module(target, known)
            if resolved is not None:
                edges[_importer].add(resolved)

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                base_module = node.module or importer
                if node.level:
                    importer_parts = importer.split(".")
                    drop = node.level - 1 if is_package else node.level
                    keep = len(importer_parts) - drop
                    if keep >= 0:
                        base_module = ".".join(importer_parts[:keep])
                        if node.module:
                            base_module = f"{base_module}.{node.module}" if base_module else node.module
                    else:
                        base_module = ""
                if base_module:
                    add(base_module)
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    add(f"{base_module}.{alias.name}" if base_module else alias.name)
            elif isinstance(node, ast.Call):
                # Dynamic but static-analyzable import edge:
                # importlib.import_module("dotted.path") / import_module("dotted.path").
                # Tests legitimately use this for modules that must be imported only
                # after a dependency is stubbed (e.g. the matplotlib-gated python
                # runtime _exec_wrapper). A string-literal arg is a real edge.
                func = node.func
                is_import_module = (
                    (isinstance(func, ast.Attribute) and func.attr == "import_module")
                    or (isinstance(func, ast.Name) and func.id == "import_module")
                )
                if is_import_module and node.args:
                    first = node.args[0]
                    if isinstance(first, ast.Constant) and isinstance(first.value, str):
                        add(first.value)
    return edges


def _is_py_shim(path: Path) -> bool:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return False
    has_reexport = False
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(getattr(node, "value", None), ast.Constant):
            continue  # module docstring / bare literal
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            has_reexport = True
            continue
        if isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) for t in node.targets):
            continue  # __all__ = [...] / simple alias re-export
        if isinstance(node, ast.AnnAssign):
            continue
        return False  # any def/class/if/for/while/with/try -> real logic
    return has_reexport


# ---------------------------------------------------------------------------
# Reachability + gap computation
# ---------------------------------------------------------------------------

def _reachable(roots, edges: dict[str, set[str]]) -> set[str]:
    seen: set[str] = set()
    queue: deque[str] = deque()
    for root in roots:
        if root in edges and root not in seen:
            seen.add(root)
            queue.append(root)
    while queue:
        current = queue.popleft()
        for nxt in edges.get(current, ()):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return seen


def _js_gaps() -> tuple[list[str], dict[str, int]]:
    files = _discover_js_files()
    edges = _build_js_edges(files)
    # Roots are ONLY runnable test entrypoints: the node runner executes
    # /\.test\.(c|m)?js$/ files. Helpers/fixtures/non-.test.js files under tests/
    # are reached transitively, never seeded as roots -- otherwise a designated
    # file imported only by a never-run helper would be falsely "reached".
    roots = [key for key in files if key.startswith("tests/") and JS_TEST_RE.search(key)]
    reached = _reachable(roots, edges)

    designated = sorted(
        key for key in files
        if any(key.startswith(d + "/") for d in JS_DESIGNATED_DIRS) and not JS_TEST_RE.search(key)
    )
    gaps: list[str] = []
    shim_count = 0
    for key in designated:
        if key in reached:
            continue
        if _is_js_shim(files[key]):
            shim_count += 1
            continue
        gaps.append(key)
    stats = {"designated": len(designated), "reached": sum(1 for k in designated if k in reached), "shims": shim_count}
    return gaps, stats


def _py_gaps() -> tuple[list[str], dict[str, int]]:
    modules: dict[str, Path] = {}
    modules.update(_discover_py_modules(ROOT / "sidecar"))
    modules.update(_discover_py_modules(ROOT / "tests" / "sidecar"))
    known = set(modules)
    edges = _build_py_edges(modules, known)
    # Roots are ONLY runnable pytest entrypoints: test_*.py collected files plus
    # conftest.py (fixtures). Test helpers/fixtures are reached transitively.
    roots = [
        mod for mod, path in modules.items()
        if (mod == "tests.sidecar" or mod.startswith("tests.sidecar."))
        and (path.name.startswith("test_") or path.name == "conftest.py")
    ]
    reached = _reachable(roots, edges)

    designated = sorted(
        (mod, path) for mod, path in modules.items()
        if path.name != "__init__.py"
        and any(_rel(path).startswith(d + "/") for d in PY_DESIGNATED_DIRS)
    )
    gaps: list[str] = []
    reached_count = 0
    shim_count = 0
    for mod, path in designated:
        if mod in reached:
            reached_count += 1
            continue
        if _is_py_shim(path):
            shim_count += 1
            continue
        gaps.append(_rel(path))
    stats = {"designated": len(designated), "reached": reached_count, "shims": shim_count}
    return gaps, stats


# ---------------------------------------------------------------------------
# Allowlist (shrinking debt markers, modeled on check_file_size)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AllowlistEntry:
    path: str
    label: str
    reason: str
    expires_on: str
    plan_doc: str


def _load_allowlist() -> list[AllowlistEntry]:
    if not ALLOWLIST_PATH.exists():
        return []
    try:
        raw = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"FAIL: cannot read {_rel(ALLOWLIST_PATH)}: {error}") from error
    entries_raw = raw.get("entries", []) if isinstance(raw, dict) else raw
    if not isinstance(entries_raw, list):
        raise SystemExit(f"FAIL: {_rel(ALLOWLIST_PATH)}: 'entries' must be a list")
    entries: list[AllowlistEntry] = []
    for index, item in enumerate(entries_raw, start=1):
        if not isinstance(item, dict):
            raise SystemExit(f"FAIL: {_rel(ALLOWLIST_PATH)}: entry {index} must be an object")
        entries.append(AllowlistEntry(
            path=str(item.get("path", "")).replace("\\", "/").strip(),
            label=str(item.get("label", "")).strip(),
            reason=str(item.get("reason", "")).strip(),
            expires_on=str(item.get("expires_on", "")).strip(),
            plan_doc=str(item.get("plan_doc", "")).strip(),
        ))
    return entries


def _validate_allowlist(
    entries: list[AllowlistEntry], gap_set: set[str], today: date
) -> tuple[list[str], list[str]]:
    """Returns (errors, active_warnings). Stale/expired/invalid entries are errors."""
    errors: list[str] = []
    warnings: list[str] = []
    seen_labels: set[str] = set()
    for entry in entries:
        tag = entry.label or entry.path or "<unnamed>"
        if not entry.path:
            errors.append("allowlist entry missing 'path'")
            continue
        if not entry.label:
            errors.append(f"{entry.path}: allowlist entry must define a non-empty label")
        elif entry.label in seen_labels:
            errors.append(f"{entry.path}: duplicate allowlist label '{entry.label}'")
        else:
            seen_labels.add(entry.label)
        if not entry.reason:
            errors.append(f"{entry.path}: allowlist exception '{tag}' is missing a reason")
        if not entry.plan_doc:
            errors.append(f"{entry.path}: allowlist exception '{tag}' is missing a plan_doc")
        elif not (ROOT / entry.plan_doc).exists():
            errors.append(f"{entry.path}: plan_doc for '{tag}' does not exist: {entry.plan_doc}")

        try:
            expires = date.fromisoformat(entry.expires_on)
        except ValueError:
            errors.append(f"{entry.path}: allowlist exception '{tag}' has invalid expires_on: {entry.expires_on!r}")
            expires = None
        if expires is not None and expires < today:
            errors.append(f"{entry.path}: allowlist exception '{tag}' expired on {entry.expires_on}")

        if entry.path not in gap_set:
            errors.append(
                f"{entry.path}: STALE allowlist exception '{tag}' -- the file is now reached by a test "
                f"(or is a shim / was removed). Delete this entry so the allowlist shrinks."
            )
        elif expires is not None:
            warnings.append(f"{entry.path}: allowed until {entry.expires_on} -- {entry.reason}")
    return errors, warnings


def main() -> int:
    today = date.today()
    js_gaps, js_stats = _js_gaps()
    py_gaps, py_stats = _py_gaps()
    gaps = sorted(js_gaps + py_gaps)
    gap_set = set(gaps)

    entries = _load_allowlist()
    allowed_paths = {entry.path for entry in entries}
    allowlist_errors, allowlist_warnings = _validate_allowlist(entries, gap_set, today)

    undocumented = [gap for gap in gaps if gap not in allowed_paths]

    failed = False
    if undocumented:
        failed = True
        print("FAIL: designated source files with no discoverable test (not in the test import graph)")
        for gap in undocumented:
            print(f"  - {gap}")
        print(
            "Add a discoverable test (any test that imports the module, directly or transitively), "
            f"or add a temporary exception to {_rel(ALLOWLIST_PATH)} (label + reason + expires_on + plan_doc)."
        )

    if allowlist_errors:
        failed = True
        print(f"FAIL: {_rel(ALLOWLIST_PATH)} invalid or stale (the allowlist must strictly shrink)")
        for item in allowlist_errors:
            print(f"  - {item}")

    if allowlist_warnings:
        print("WARN: active test-coverage exceptions (temporary debt)")
        for item in allowlist_warnings:
            print(f"  - {item}")

    if failed:
        return 1

    print(
        "PASS: every designated source file is reachable from the test import graph "
        f"(JS {js_stats['reached']}/{js_stats['designated']} reached, {js_stats['shims']} shim; "
        f"PY {py_stats['reached']}/{py_stats['designated']} reached, {py_stats['shims']} shim; "
        f"{len(entries)} allowed)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
