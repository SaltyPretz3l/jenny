"""Fail if print() is used in sidecar runtime code."""
from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "sidecar"


def has_print_call(source: str) -> list[int]:
    tree = ast.parse(source)
    lines: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id == "print":
            lines.append(node.lineno)
    return sorted(set(lines))


def main() -> int:
    violations: list[str] = []
    for file_path in TARGET.rglob("*.py"):
        if "tests" in file_path.parts:
            continue
        lines = has_print_call(file_path.read_text(encoding="utf-8"))
        for lineno in lines:
            violations.append(f"{file_path.relative_to(ROOT)}:{lineno}")

    if violations:
        print("FAIL: print() usage found in sidecar runtime code")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: no print() in sidecar runtime code")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
