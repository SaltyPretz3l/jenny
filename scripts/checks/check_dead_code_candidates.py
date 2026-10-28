"""Report JS/HTML files unreachable from the configured entrypoints.

The default is informational and exits 0 while calibration continues. Use
``--strict`` to exit 1 when candidates remain.

Reachability is a breadth-first walk from ``ENTRYPOINTS``, the dynamic entry
globs, and every local file an npm script in ``package.json`` runs. Each
reached file contributes its static ``require``/``import``/``import()`` targets,
``<script src>`` tags, ``path.join(__dirname, ...)`` literals, and app-root
``renderer/...js`` literals (the ``ensureScript`` lazy panes and script-tag
injections resolve against the app root, not the importing file).

``launcher_targets`` adds the roots no import graph reaches: npm ``bin``
entries, tool configs, self-runnable scripts (node shebang or
``require.main === module``), ``scripts/`` tools a test spawns by path, JS paths
named by launcher files (workflows, compose, shell, python, PowerShell, Makefile,
Dockerfile), ``node x.js`` recipes and relative ``[text](x.js)`` links in
non-archived markdown (``archive`` directories and ``docs/history/`` are records),
and the siblings a ``scripts/`` tool names by basename (a tool that mounts its own
directory, e.g. ``/proof/probe.js``). Candidates are limited to tracked files
(``git ls-files``) so gitignored build outputs never appear.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

ENTRYPOINTS = [
    ROOT / "index.html",
    ROOT / "mermaid-frame.html",
    # Hosted browser client: scripts/build-browser.js copies this page and
    # bundles its app.js with esbuild (the page's <script src> names it).
    ROOT / "renderer" / "browser" / "index.html",
    ROOT / "main.js",
    ROOT / "preload.js",
    ROOT / "tests" / "helpers" / "renderer-shell-harness-support.js",
    ROOT / "package.json",
    ROOT / "scripts" / "checks" / "run_all.py",
]

# Files loaded by a computed path no static pattern can follow. Globs are
# relative to ROOT and evaluated at scan time.
DYNAMIC_ENTRY_GLOBS = (
    # renderer/shared/i18n-bootstrap.js document.write()s
    # "locales/<tag>.catalog.js" for the active non-English locale.
    "locales/*.catalog.js",
)

# Tool configs and build inputs discovered by name rather than by import.
CONFIG_ENTRY_FILES = ("eslint.config.mjs", "uninstall-preload.js")

# Top-level directories that hold records (plans, reports, probes, mockups), never shipped source.
RECORD_TOP_DIRS = {"docs", ".jenny-diagnostics"}

# A file that declares itself runnable: node shebang or ``require.main === module``.
RE_SELF_RUNNABLE = re.compile(r"\A#!.*\bnode\b|require\.main\s*===\s*module")
# Repo-relative JS path inside a launcher (workflow, compose, shell, python, powershell, Makefile).
# Both separators are accepted so ``scripts\eval\x.js`` in a .ps1 counts.
_PATH_PART = r"[A-Za-z0-9_.\-]+"
_JS_PATH = rf"{_PATH_PART}(?:[/\\]{_PATH_PART})*\.(?:js|mjs|cjs)\b"
RE_JS_PATH_TOKEN = re.compile(_JS_PATH)
# A documented recipe: ``node scripts/x.js`` / ``electron scripts/x.js``.
RE_DOC_RECIPE = re.compile(rf"\b(?:node|electron)(?:\.exe)?\s+(?:--?\S+\s+)*(?P<ref>{_JS_PATH})")
# A markdown link to a JS file, resolved against the markdown file's directory.
RE_DOC_LINK = re.compile(r"\]\((?P<ref>[^)\s#]+\.(?:js|mjs|cjs))(?:#[^)]*)?\)")
LAUNCHER_SUFFIXES = (".py", ".sh", ".ps1", ".yml", ".yaml", ".cmd", ".bat")
LAUNCHER_NAMES = {"Makefile", "Dockerfile"}
JS_SUFFIXES_ALL = {".js", ".mjs", ".cjs"}

# npm-script tokens that name a local file worth traversing.
PACKAGE_SCRIPT_SUFFIXES = (".js", ".mjs", ".cjs", ".py")

IGNORE_DIRS = {
    ".git",
    ".venv",
    ".tmp",
    ".sidecar-packaging",
    "node_modules",
    "archive",
    "build",
    "vendor",
    "dist",
    "PORT_BUNDLES",
    ".jenny",
    "artifacts",
    "coverage",
    "repomix",
    "prototypes",
    "study",
    "llama_server_extract",
    ".claude",
    ".spec-first",
}

TEST_DIRS = {
    "tests",
    "test",
}

RE_JS = re.compile(
    r"(?:require\s*\(\s*|import\s*\(\s*|import\s+(?:[^;\n]*?\s+from\s+)?)"
    r"(?P<quote>['\"])(?P<ref>[^'\"]+)(?P=quote)"
)
RE_HTML_SCRIPT = re.compile(
    r"<script\b[^>]*\bsrc\s*=\s*(?P<quote>['\"])(?P<ref>[^'\"]+)(?P=quote)"
)
# App-root-relative lazy script paths: ensureScript({ src: 'renderer/...js' }),
# script.src = 'renderer/...js', lazy-pane tables, and './renderer/...' workers.
RE_APP_ROOT_SCRIPT = re.compile(
    r"(?P<quote>['\"])(?:\./)?(?P<ref>renderer/[A-Za-z0-9_./-]+\.js)(?P=quote)"
)
# path.join(__dirname, 'a', 'b.js') / path.resolve(__dirname, '..', 'x.html')
RE_DIRNAME_JOIN = re.compile(
    r"path\.(?:join|resolve)\(\s*__dirname(?P<segments>(?:\s*,\s*['\"][^'\"]+['\"])+)\s*\)"
)
RE_QUOTED = re.compile(r"['\"](?P<value>[^'\"]+)['\"]")


def normalize_ref(raw: str, referencing_file: Path) -> Path | None:
    if "" == raw:
        return None
    if raw.startswith("http://") or raw.startswith("https://"):
        return None
    candidate = raw
    if candidate.startswith("/"):
        candidate = candidate[1:]
        rel = (ROOT / candidate).resolve()
    else:
        rel = (referencing_file.parent / candidate).resolve()

    if rel.is_file():
        return rel

    for suffix in (".js", ".mjs", ".cjs", "/index.js", ".json"):
        target = Path(f"{str(rel)}{suffix}")
        if target.is_file():
            return target
    if rel.with_suffix(".js").is_file():
        return rel.with_suffix(".js")
    return None


def collect_files() -> set[Path]:
    files: set[Path] = set()
    for directory, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [name for name in dirnames if name not in IGNORE_DIRS]
        for filename in filenames:
            path = Path(directory) / filename
            if path.suffix in {".js", ".mjs", ".cjs", ".html"}:
                files.add(path.resolve())
    return files


def collect_python_references(content: str, referencing_file: Path) -> set[Path]:
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return set()

    def resolve_path_expression(node: ast.AST) -> Path | None:
        if isinstance(node, ast.Name) and node.id == "ROOT":
            return ROOT
        if (
            isinstance(node, ast.BinOp)
            and isinstance(node.op, ast.Div)
            and isinstance(node.right, ast.Constant)
            and isinstance(node.right.value, str)
        ):
            parent = resolve_path_expression(node.left)
            if parent is not None:
                return parent / node.right.value
        return None

    refs: set[Path] = set()
    for node in ast.walk(tree):
        target = resolve_path_expression(node)
        if (
            target is not None
            and target.suffix in {".py", ".js", ".mjs", ".cjs"}
            and target.is_file()
        ):
            refs.add(target.resolve())
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value.endswith((".py", ".js", ".mjs", ".cjs")):
                target = normalize_ref(node.value, referencing_file)
                if target is not None:
                    refs.add(target)
    return refs


def collect_js_references(content: str, referencing_file: Path) -> set[Path]:
    targets = {
        target
        for match in RE_JS.finditer(content)
        if (target := normalize_ref(match.group("ref"), referencing_file)) is not None
    }
    for match in RE_APP_ROOT_SCRIPT.finditer(content):
        candidate = (ROOT / match.group("ref")).resolve()
        if candidate.is_file():
            targets.add(candidate)
    for match in RE_DIRNAME_JOIN.finditer(content):
        segments = [m.group("value") for m in RE_QUOTED.finditer(match.group("segments"))]
        candidate = referencing_file.parent.joinpath(*segments).resolve()
        if candidate.is_file():
            targets.add(candidate)
    return targets


def package_script_targets(root: Path) -> set[Path]:
    """Local files that ``package.json`` npm scripts execute (traversed, not just marked)."""
    package_path = root / "package.json"
    if not package_path.is_file():
        return set()
    try:
        data = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    targets: set[Path] = set()
    for cmd in (data.get("scripts", {}) or {}).values():
        if not isinstance(cmd, str):
            continue
        for token in cmd.split():
            if token.endswith(PACKAGE_SCRIPT_SUFFIXES) and (token[0].isalnum() or token[0] == "."):
                target = normalize_ref(token, package_path)
                if target and target.is_file():
                    targets.add(target)
    return targets


def tracked_files() -> list[Path] | None:
    """Tracked files, so gitignored build outputs never become candidates (None outside git)."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True, check=True
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    names = [name for name in proc.stdout.decode("utf-8", "replace").split("\0") if name]
    return [ROOT / name for name in names] or None


def _is_launcher(path: Path) -> bool:
    return (
        path.suffix in LAUNCHER_SUFFIXES
        or path.name in LAUNCHER_NAMES
        or path.name.startswith("Dockerfile")
        or path.parts[-3:-1] == (".github", "workflows")
    )


def _spawned_tool_targets(text: str, test_file: Path) -> set[Path]:
    """``scripts/**`` JS files a test spawns or loads by path (a tool with a test is not dead)."""
    found: set[Path] = set()
    for token in RE_JS_PATH_TOKEN.findall(text):
        ref = token.replace("\\", "/")
        for base in (test_file.parent, ROOT):
            candidate = (base / ref).resolve()
            if not (candidate.is_file() and candidate.is_relative_to(ROOT)):
                continue
            if candidate.relative_to(ROOT).parts[0] == "scripts":
                found.add(candidate)
                break
    return found


def _is_record_markdown(rel_parts: tuple[str, ...]) -> bool:
    """Archived plans and dated history never keep a script alive."""
    return "archive" in rel_parts or rel_parts[:2] == ("docs", "history")


def _mounted_sibling_targets(text: str, tool: Path) -> set[Path]:
    """Siblings a ``scripts/`` tool names by basename (its directory is mounted or copied)."""
    found: set[Path] = set()
    for token in RE_JS_PATH_TOKEN.findall(text):
        sibling = tool.parent / token.replace("\\", "/").rsplit("/", 1)[-1]
        if sibling != tool and sibling.is_file():
            found.add(sibling.resolve())
    return found


def _doc_link_targets(text: str, doc: Path) -> set[Path]:
    found: set[Path] = set()
    for match in RE_DOC_LINK.finditer(text):
        candidate = (doc.parent / match.group("ref")).resolve()
        if candidate.is_file() and candidate.is_relative_to(ROOT):
            found.add(candidate)
    return found


def launcher_targets(files: list[Path]) -> set[Path]:
    """JS files named by launchers, npm ``bin`` entries, node shebangs/main guards and doc references.

    ``files`` is the tracked-file universe to scan (empty when git is unavailable).
    Archived and history markdown is skipped so finished programs do not keep
    scripts alive.
    """
    targets: set[Path] = set()
    try:
        bin_field = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("bin") or {}
    except (OSError, json.JSONDecodeError):
        bin_field = {}
    bins = [bin_field] if isinstance(bin_field, str) else list(bin_field.values())
    bins = [b for b in bins if isinstance(b, str)]
    targets.update(p for b in bins if (p := (ROOT / b).resolve()).is_file())
    targets.update(p.resolve() for name in CONFIG_ENTRY_FILES if (p := ROOT / name).is_file())
    for path in files:
        is_js = path.suffix in JS_SUFFIXES_ALL
        rel_parts = path.relative_to(ROOT).parts
        is_md = path.suffix == ".md" and not _is_record_markdown(rel_parts)
        if not (is_js or is_md or _is_launcher(path)):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if is_js:
            if RE_SELF_RUNNABLE.search(text):
                targets.add(path.resolve())
            if TEST_DIRS.intersection(rel_parts):
                targets.update(_spawned_tool_targets(text, path))
            elif rel_parts[0] == "scripts":
                targets.update(_mounted_sibling_targets(text, path))
            continue
        if is_md:
            targets.update(_doc_link_targets(text, path))
            refs = [m.group("ref") for m in RE_DOC_RECIPE.finditer(text)]
        else:
            refs = RE_JS_PATH_TOKEN.findall(text)
        for ref in refs:
            candidate = (ROOT / ref.replace("\\", "/")).resolve()
            if candidate.is_file():
                targets.add(candidate)
    return targets


def _initial_entries() -> list[Path]:
    entries = {p.resolve() for p in ENTRYPOINTS if p.exists()}
    for pattern in DYNAMIC_ENTRY_GLOBS:
        entries.update(p.resolve() for p in ROOT.glob(pattern) if p.is_file())
    entries.update(package_script_targets(ROOT))
    entries.update(launcher_targets(tracked_files() or []))
    return sorted(entries, key=str)


def collect_references() -> set[Path]:
    entry_queue = _initial_entries()
    visited = set(entry_queue)

    while entry_queue:
        path = entry_queue.pop()
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        if path.suffix == ".py":
            targets = collect_python_references(content, path)
        elif path.suffix == ".html":
            targets = {
                target
                for match in RE_HTML_SCRIPT.finditer(content)
                if (target := normalize_ref(match.group("ref"), path)) is not None
            }
        elif path.suffix == ".json":
            targets = set()
        else:
            targets = collect_js_references(content, path)

        for target in targets:
            if (
                target.is_file()
                and target.is_relative_to(ROOT)
                and not any(part in IGNORE_DIRS for part in target.relative_to(ROOT).parts)
                and target not in visited
            ):
                visited.add(target)
                entry_queue.append(target)

    return visited


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Find likely dead JS/HTML files not referenced from key entrypoints.")
    parser.add_argument("--include-tests", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)

    all_files = {f for f in collect_files() if f.suffix != ".json"}
    tracked = tracked_files()
    if tracked is not None:
        all_files &= {p.resolve() for p in tracked}

    excluded_dirs = set()
    if not args.include_tests:
        for test_dir in TEST_DIRS:
            excluded_dirs.add(test_dir)

    candidate_pool = {
        f for f in all_files
        if all(test_dir not in f.parts for test_dir in excluded_dirs)
        and all(part not in IGNORE_DIRS for part in f.relative_to(ROOT).parts)
        and f.relative_to(ROOT).parts[0] not in RECORD_TOP_DIRS
    }

    refs = collect_references()
    dead = sorted(candidate_pool - refs, key=lambda p: str(p))

    if not dead:
        print("PASS: no obvious dead files found")
        return 0

    print(f"WARN: candidate dead files (active source, non-test): {len(dead)}")
    for path in dead:
        if not path.exists():
            continue
        print(f"  - {path.relative_to(ROOT)}")
    return 1 if args.strict else 0


if __name__ == "__main__":
    raise SystemExit(main())
