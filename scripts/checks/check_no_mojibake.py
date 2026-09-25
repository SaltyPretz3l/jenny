"""Reject invalid UTF-8 and obvious mojibake in canonical docs and source trees."""
from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CANONICAL_DOCS = (
    "AGENTS.md",
    "README.md",
    "NEXT_STEPS.md",
    "WORKSPACE_MANIFEST.md",
)
CANONICAL_GLOBS = ("docs/manifests/*.md",)
# Source trees swept with SOURCE_MARKERS by the default run; the pre-commit hook
# still names changed files explicitly through --source-files.
SOURCE_TREES = ("sidecar", "services", "renderer", "scripts", "tests")
SOURCE_SUFFIXES = {".py", ".js", ".mjs", ".cjs", ".ts", ".html", ".css"}
SOURCE_SKIP_DIRS = {
    "node_modules", ".venv", "__pycache__", ".git", "locales", "vendor", "dist", "build",
}
MOJIBAKE_MARKERS = ("\u00c3\u00a2\u00e2\u201a\u00ac", "\u00c3", "\ufffd")
# Multi-character signatures avoid treating legitimate accented source text as
# corruption. Keep these escaped so this check can safely inspect itself.
SOURCE_MARKERS = (
    "\u00e2\u20ac\u201d", "\u00e2\u20ac\u201c",
    "\u00e2\u20ac\u2122", "\u00e2\u20ac\u0153",
    "\u00e2\u20ac\u009d", "\u00e2\u20ac\u00a6",
    "\u00c3\u00a2\u00e2\u201a\u00ac",
)


def iter_target_paths() -> list[Path]:
    targets: list[Path] = []
    for relative_path in CANONICAL_DOCS:
        path = ROOT / relative_path
        if path.is_file():
            targets.append(path)
    for pattern in CANONICAL_GLOBS:
        targets.extend(path for path in sorted(ROOT.glob(pattern)) if path.is_file())
    return targets


def iter_source_paths() -> list[Path]:
    targets: list[Path] = []
    for tree in SOURCE_TREES:
        root = ROOT / tree
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if path.suffix not in SOURCE_SUFFIXES or not path.is_file():
                continue
            if SOURCE_SKIP_DIRS.intersection(path.relative_to(ROOT).parts[:-1]):
                continue
            targets.append(path)
    return targets


def find_violations(path: Path, *, source: bool = False) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return [f"{path.relative_to(ROOT)}: invalid UTF-8"]
    except OSError:
        return []

    violations: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        signatures = SOURCE_MARKERS if source else MOJIBAKE_MARKERS
        markers = [ascii(marker)[1:-1] for marker in signatures if marker in line]
        if not markers:
            continue
        joined_markers = ", ".join(markers)
        violations.append(f"{path.relative_to(ROOT)}:{lineno} contains {joined_markers}")
    return violations


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-files", nargs="*", default=None)
    args = parser.parse_args(argv)
    violations: list[str] = []
    source = args.source_files is not None
    if source:
        for name in args.source_files:
            violations.extend(find_violations(ROOT / name, source=True))
    else:
        for path in iter_target_paths():
            violations.extend(find_violations(path))
        for path in iter_source_paths():
            violations.extend(find_violations(path, source=True))

    if violations:
        print("FAIL: invalid UTF-8 or mojibake markers detected")
        for violation in violations:
            print(f"  - {violation}")
        return 1

    print("PASS: no UTF-8 decoding errors or mojibake markers detected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
