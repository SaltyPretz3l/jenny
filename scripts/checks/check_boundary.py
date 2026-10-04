"""Fail if sidecar/ai imports UI-layer modules."""
from __future__ import annotations

import ast
from importlib.util import resolve_name
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "sidecar" / "ai"
FORBIDDEN_ROOTS = {"electron", "renderer", "services", "main"}


def main() -> int:
    violations: list[str] = []
    for file_path in TARGET.rglob("*.py"):
        rel = file_path.relative_to(ROOT)
        try:
            text = file_path.read_text(encoding="utf-8")
            tree = ast.parse(text, filename=str(rel))
        except (OSError, UnicodeError, SyntaxError) as error:
            violations.append(f"{rel}: cannot scan imports: {error}")
            continue
        package = ".".join(rel.parent.parts)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if node.level:
                    try:
                        module = resolve_name("." * node.level + module, package)
                    except ImportError:
                        violations.append(
                            f"{rel}:{node.lineno}: relative import escapes the package"
                        )
                        continue
                modules = [module]
            else:
                continue
            if any(module.split(".")[0].lower() in FORBIDDEN_ROOTS for module in modules):
                line = text.splitlines()[node.lineno - 1].strip()
                violations.append(f"{rel}:{node.lineno}: {line}")

    if violations:
        print("FAIL: sidecar/ai contains illegal imports or could not be scanned")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: boundary check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
