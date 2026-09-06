"""Fail on unexpected unreachable sidecar modules.

The sidecar startup graph should be explicit for production behavior.
This check:

- Walks Python imports starting from runtime entrypoints.
- Includes known dynamic subprocess/import boundaries used by runtime.
- Validates that every unreachable module is either intentionally deferred or
  explicitly documented as deferred with a status.
"""

from __future__ import annotations

import ast
from collections import deque
from pathlib import Path
from typing import Dict, List, Set

ROOT = Path(__file__).resolve().parents[2]
SIDE_CAR_ROOT = ROOT / "sidecar"

EXCLUDED_DIR_NAMES = {".venv", ".tmp", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"}

STARTUP_MODULES = {
    "sidecar.__main__",
    "sidecar.server",
}

KNOWN_DYNAMIC_ENTRYPOINT_IMPORTS: Dict[str, Set[str]] = {
    "sidecar.ai.container": {"sidecar.ai.mcp.builtin_server"},
    "sidecar.runtime.subprocess_manager": {"sidecar.runtime.background_worker"},
    "sidecar.ai.tools.builtins.python_runtime.sandbox": {
        "sidecar.ai.tools.builtins.python_runtime._exec_wrapper"
    },
    # provider_registry.__getattr__ resolves each concrete engine on first
    # attribute access so importing the registry does not load every provider.
    "sidecar.ai.engines.provider_registry": {
        "sidecar.ai.engines.codex_cli",
        "sidecar.ai.engines.ollama",
        "sidecar.ai.engines.openai_compatible",
        "sidecar.ai.engines.replay",
        "sidecar.ai.engines.responses_descriptor",
        "sidecar.ai.engines.vllm_engine",
    },
    # registry._lazy_tool_handler resolves each builtin tool handler on first
    # invocation via importlib, so importing sidecar.ai.tools.registry no longer
    # drags the handler graph in at startup (219 -> 129 modules). Declared as
    # dynamic edges rather than added to DEFERRED_MODULE_STATUS deliberately:
    # exempting them would stop this gate walking them at all, whereas a dynamic
    # edge keeps a deleted or renamed handler module failing loudly here.
    # The (module, handler) STRING pair itself is covered by
    # tests/sidecar/ai/tools/test_lazy_tool_bindings.py.
    "sidecar.ai.tools.registry": {
        "sidecar.ai.tools.builtins.artifacts",
        "sidecar.ai.tools.builtins.delete_file",
        "sidecar.ai.tools.builtins.move_file",
        "sidecar.ai.tools.builtins.edit_file",
        "sidecar.ai.tools.builtins.filesystem",
        "sidecar.ai.tools.builtins.filesystem_listing",
        "sidecar.ai.tools.builtins.git_ops",
        "sidecar.ai.tools.builtins.glob_files",
        "sidecar.ai.tools.builtins.grep_search",
        "sidecar.ai.tools.builtins.knowledge",
        "sidecar.ai.tools.builtins.lsp.tools",
        "sidecar.ai.tools.builtins.shell",
        "sidecar.ai.tools.builtins.temp_script",
        "sidecar.ai.tools.builtins.worktree_change_tracking",
    },
}

# Modules intentionally deferred from startup graph (documented explicitly below).
DEFERRED_MODULE_STATUS: Dict[str, str] = {
    "sidecar.ai.plugins.policy": "document-deferred",
    # The delegate V2 facade is the sole model-facing path; the former batch
    # executor remains importable for exact-ID policy and report compatibility.
    "sidecar.ai.routing.subagent_batch": "legacy/gate",
    # Tool-contract W8 (2026-08-29): the W0 failure_taxonomy/phase_trace "wire"
    # rows were removed once W1/W4 landed their consumers, and the apply_patch
    # machinery chain was DELETED per the recorded W8 adjudication criterion
    # (edit_file's `edits` array is the sufficient replacement and no
    # multi-file tool is planned).
}


def module_from_path(path: Path) -> str:
    relative = path.relative_to(ROOT)
    if relative.name == "__init__.py":
        relative = relative.parent
    else:
        relative = relative.with_suffix("")
    return ".".join(relative.parts)


def discover_modules() -> Dict[str, Path]:
    modules: Dict[str, Path] = {}
    for path in SIDE_CAR_ROOT.rglob("*.py"):
        if any(part in EXCLUDED_DIR_NAMES for part in path.parts):
            continue
        modules[module_from_path(path)] = path
    return modules


def resolve_known_module(name: str, known_modules: Set[str]) -> str | None:
    parts = name.split(".")
    for i in range(len(parts), 0, -1):
        candidate = ".".join(parts[:i])
        if candidate in known_modules:
            return candidate
    return None


def read_edges(modules: Dict[str, Path], known_modules: Set[str]) -> Dict[str, Set[str]]:
    edges: Dict[str, Set[str]] = {name: set() for name in modules}

    for importer, path in modules.items():
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue

        def add_import(target: str) -> None:
            resolved = resolve_known_module(target, known_modules)
            if resolved is not None:
                edges[importer].add(resolved)

        def resolve_relative_import(base_module: str, alias_name: str | None) -> str:
            if alias_name is None:
                return base_module
            return f"{base_module}.{alias_name}" if base_module else alias_name

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    add_import(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    base_module = node.module
                else:
                    base_module = importer

                if node.level:
                    importer_parts = importer.split(".")
                    if node.level <= len(importer_parts):
                        base_module = ".".join(importer_parts[:-node.level])
                        if node.module:
                            base_module = (
                                f"{base_module}.{node.module}" if base_module else node.module
                            )
                    else:
                        base_module = ""

                if base_module:
                    add_import(base_module)

                for alias in node.names:
                    if alias.name == "*":
                        continue
                    add_import(resolve_relative_import(base_module, alias.name))

        for extra_target in KNOWN_DYNAMIC_ENTRYPOINT_IMPORTS.get(importer, set()):
            add_import(extra_target)

    return edges


def status_for_module(module_name: str) -> str | None:
    for deferred_module, status in DEFERRED_MODULE_STATUS.items():
        if module_name == deferred_module or module_name.startswith(f"{deferred_module}."):
            return status
    return None


def main() -> int:
    modules = discover_modules()
    if not modules:
        print("FAIL: no sidecar Python modules discovered")
        return 1

    known_modules = set(modules.keys())
    edges = read_edges(modules, known_modules)

    reachable: Set[str] = set()
    queue: deque[str] = deque()

    for start in STARTUP_MODULES:
        if start in known_modules:
            reachable.add(start)
            queue.append(start)

    while queue:
        current = queue.popleft()
        for child in edges[current]:
            if child in reachable:
                continue
            reachable.add(child)
            queue.append(child)

    unreachable: List[str] = []
    for module_name in sorted(modules):
        if modules[module_name].name == "__init__.py":
            continue
        if module_name in reachable:
            continue
        unreachable.append(module_name)

    unexpected: List[str] = []
    undocumented: List[str] = []

    for module_name in unreachable:
        status = status_for_module(module_name)
        if status is None:
            unexpected.append(module_name)
            continue
        if status not in {"document-deferred", "legacy/gate", "wire"}:
            undocumented.append(module_name)

    if unexpected:
        print("FAIL: unexpected unreachable sidecar modules (not documented as deferred/wired)")
        for name in unexpected:
            print(f"  - {name}")
        print(
            "Update DEFERRED_MODULE_STATUS in scripts/checks/check_sidecar_reachability.py"
            " and docs/manifests/sidecar-runtime.md"
        )
        return 1

    if undocumented:
        print("FAIL: deferred modules with unknown status")
        for name in undocumented:
            print(f"  - {name}")
        return 1

    if not unreachable:
        print("PASS: all reachable sidecar modules are linked from startup graph")
        return 0

    print("PASS: sidecar reachability is stable; all unreachable modules are documented intent")
    for name in unreachable:
        status = status_for_module(name)
        if status:
            print(f"  - {name}: {status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
