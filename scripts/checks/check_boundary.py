"""Fail if sidecar/ai imports UI-layer modules."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "sidecar" / "ai"
PATTERNS = [
    re.compile(r"^\s*from\s+(electron|renderer)(\.|\s+import\b)"),
    re.compile(r"^\s*import\s+(electron|renderer)(\.|$)"),
]


def main() -> int:
    violations: list[str] = []
    for file_path in TARGET.rglob("*.py"):
        for lineno, line in enumerate(file_path.read_text(encoding="utf-8").splitlines(), start=1):
            if any(pattern.search(line) for pattern in PATTERNS):
                rel = file_path.relative_to(ROOT)
                violations.append(f"{rel}:{lineno}: {line.strip()}")

    if violations:
        print("FAIL: sidecar/ai contains illegal renderer/electron imports")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: boundary check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
