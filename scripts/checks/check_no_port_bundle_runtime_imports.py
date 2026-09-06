"""Fail if runtime code imports from PORT_BUNDLES references."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_DIRS = ("services", "renderer", "sidecar")
ROOT_RUNTIME_FILES = ("main.js", "preload.js", "start.js")
RUNTIME_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".mjs", ".cjs"}

IMPORT_PATTERNS = [
    re.compile(r'^\s*import\s+.+\s+from\s+["\'][^"\']*PORT_BUNDLES[^"\']*["\']'),
    re.compile(r'^\s*import\s+["\'][^"\']*PORT_BUNDLES[^"\']*["\']'),
    re.compile(r'^\s*export\s+.+\s+from\s+["\'][^"\']*PORT_BUNDLES[^"\']*["\']'),
    re.compile(r'require\(\s*["\'][^"\']*PORT_BUNDLES[^"\']*["\']\s*\)'),
    re.compile(r'import\(\s*["\'][^"\']*PORT_BUNDLES[^"\']*["\']\s*\)'),
    re.compile(r"^\s*from\s+PORT_BUNDLES(\.|$)"),
    re.compile(r"^\s*import\s+PORT_BUNDLES(\.|$)"),
]


def _is_runtime_file(path: Path) -> bool:
    return path.is_file() and path.suffix in RUNTIME_SUFFIXES


def main() -> int:
    violations: list[str] = []
    runtime_files = [ROOT / file_name for file_name in ROOT_RUNTIME_FILES]
    for root_dir in RUNTIME_DIRS:
        base = ROOT / root_dir
        if not base.exists():
            continue
        runtime_files.extend(base.rglob("*"))

    for file_path in runtime_files:
        if not _is_runtime_file(file_path):
            continue
        lines = file_path.read_text(encoding="utf-8").splitlines()
        for lineno, line in enumerate(lines, start=1):
            if any(pattern.search(line) for pattern in IMPORT_PATTERNS):
                rel = file_path.relative_to(ROOT)
                violations.append(f"{rel}:{lineno}: {line.strip()}")

    if violations:
        print("FAIL: runtime code imports from PORT_BUNDLES")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: no runtime imports from PORT_BUNDLES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
