"""Report JS/HTML files unreachable from the configured entrypoints.

The default is informational and exits 0 while calibration continues. Use
``--strict`` to exit 1 when candidates remain.
"""
from __future__ import annotations

import argparse
import ast
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

ENTRYPOINTS = [
    ROOT / "index.html",
    ROOT / "renderer.html",
    ROOT / "overlay.html",
    ROOT / "mermaid-frame.html",
    ROOT / "main.js",
    ROOT / "preload.js",
    ROOT / "tests" / "helpers" / "renderer-shell-harness-support.js",
    ROOT / "package.json",
    ROOT / "scripts" / "checks" / "run_all.py",
]

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
    r"(?:require\s*\(\s*|import\s+(?:[^;\n]*?\s+from\s+)?)"
    r"(?P<quote>['\"])(?P<ref>[^'\"]+)(?P=quote)"
)
RE_HTML_SCRIPT = re.compile(
    r"<script\b[^>]*\bsrc\s*=\s*(?P<quote>['\"])(?P<ref>[^'\"]+)(?P=quote)"
)


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


def collect_references() -> set[Path]:
    refs: set[Path] = set()
    entry_queue = [p for p in ENTRYPOINTS if p.exists()]
    visited = set(entry_queue)

    while entry_queue:
        path = entry_queue.pop()
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        if path.suffix == ".py":
            targets = collect_python_references(content, path)
        else:
            pattern = RE_HTML_SCRIPT if path.suffix == ".html" else RE_JS
            targets = {
                target
                for match in pattern.finditer(content)
                if (target := normalize_ref(match.group("ref"), path)) is not None
            }

        for target in targets:
            if (
                target.is_file()
                and target.is_relative_to(ROOT)
                and not any(part in IGNORE_DIRS for part in target.relative_to(ROOT).parts)
                and target not in visited
            ):
                visited.add(target)
                entry_queue.append(target)

    # include obvious JSON manifest script lists and npm scripts that reference local js
    package_path = ROOT / "package.json"
    if package_path.exists():
        import json

        data = json.loads(package_path.read_text(encoding="utf-8"))
        scripts = data.get("scripts", {}) or {}
        for cmd in scripts.values():
            if isinstance(cmd, str):
                for token in cmd.split():
                    if token.endswith(".js") and token[0].isalnum():
                        target = normalize_ref(token, package_path)
                        if target and target.is_file():
                            refs.add(target)
    return visited | refs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Find likely dead JS/HTML files not referenced from key entrypoints.")
    parser.add_argument("--include-tests", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)

    all_files = {f for f in collect_files() if f.suffix != ".json"}

    excluded_dirs = set()
    if not args.include_tests:
        for test_dir in TEST_DIRS:
            excluded_dirs.add(test_dir)

    candidate_pool = {
        f for f in all_files
        if all(test_dir not in f.parts for test_dir in excluded_dirs)
        and all(part not in IGNORE_DIRS for part in f.relative_to(ROOT).parts)
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
