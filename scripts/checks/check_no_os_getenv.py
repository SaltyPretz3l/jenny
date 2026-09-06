"""Fail if process environment access is used outside ConfigManager."""
from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "sidecar"
ALLOWED = (ROOT / "sidecar" / "ai" / "config.py").resolve()


class EnvAccessVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.os_aliases: set[str] = set()
        self.getenv_aliases: set[str] = set()
        self.environ_aliases: set[str] = set()
        self.lines: list[int] = []

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if alias.name == "os":
                self.os_aliases.add(alias.asname or alias.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module != "os":
            self.generic_visit(node)
            return
        for alias in node.names:
            local_name = alias.asname or alias.name
            if alias.name == "getenv":
                self.getenv_aliases.add(local_name)
            elif alias.name == "environ":
                self.environ_aliases.add(local_name)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if self._is_getenv_call(node.func) or self._is_environ_get_call(node.func):
            self.lines.append(node.lineno)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if self._is_environ_reference(node.value):
            self.lines.append(node.lineno)
        self.generic_visit(node)

    def _is_getenv_call(self, node: ast.expr) -> bool:
        if isinstance(node, ast.Name):
            return node.id in self.getenv_aliases
        if not isinstance(node, ast.Attribute) or node.attr != "getenv":
            return False
        return isinstance(node.value, ast.Name) and node.value.id in self.os_aliases

    def _is_environ_get_call(self, node: ast.expr) -> bool:
        if not isinstance(node, ast.Attribute) or node.attr != "get":
            return False
        return self._is_environ_reference(node.value)

    def _is_environ_reference(self, node: ast.expr) -> bool:
        if isinstance(node, ast.Name):
            return node.id in self.environ_aliases
        if not isinstance(node, ast.Attribute) or node.attr != "environ":
            return False
        return isinstance(node.value, ast.Name) and node.value.id in self.os_aliases


def find_getenv_calls(path: Path) -> list[int]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    visitor = EnvAccessVisitor()
    visitor.visit(tree)
    return sorted(set(visitor.lines))


def main() -> int:
    violations: list[str] = []
    for file_path in SIDECAR.rglob("*.py"):
        if file_path.resolve() == ALLOWED:
            continue
        for lineno in find_getenv_calls(file_path):
            violations.append(f"{file_path.relative_to(ROOT)}:{lineno}")

    if violations:
        print("FAIL: environment access used outside sidecar/ai/config.py")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: no forbidden process environment access")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
