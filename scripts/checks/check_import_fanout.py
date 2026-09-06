"""Fail if leaf sidecar modules import too many sibling modules."""
from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "sidecar" / "ai"
MAX_IMPORTS = 6
EXEMPT = {
    (ROOT / "sidecar" / "server.py").resolve(),
    (ROOT / "sidecar" / "ai" / "container.py").resolve(),
    (ROOT / "sidecar" / "ai" / "routing" / "router.py").resolve(),
    (ROOT / "sidecar" / "ai" / "routing" / "tool_loop.py").resolve(),
    (ROOT / "sidecar" / "ai" / "mcp" / "builtin_server.py").resolve(),
    (ROOT / "sidecar" / "ai" / "tools" / "registry.py").resolve(),
    (ROOT / "sidecar" / "ai" / "mcp" / "client.py").resolve(),
    (ROOT / "sidecar" / "ai" / "tools" / "policy.py").resolve(),
    (ROOT / "sidecar" / "ai" / "tools" / "builtins" / "lsp" / "tools.py").resolve(),
    (ROOT / "sidecar" / "ai" / "tools" / "builtins" / "rich_files" / "pdf.py").resolve(),
    # read_file's rich-suffix dispatch leaf (W7a-S3): five of its seven imports
    # are function-level lazy imports of the optional-dependency inspect
    # adapters — deliberately deferred so importing filesystem tools never pulls
    # fitz/openpyxl/defusedxml at startup, and so tests can monkeypatch the
    # handler symbols on their modules. The counter cannot tell a deferred
    # optional-dependency import from top-level breadth.
    (ROOT / "sidecar" / "ai" / "tools" / "builtins" / "filesystem_rich.py").resolve(),
    # Top-level shell tool orchestrator: wires optional flag-gated tool-output
    # distillation (redaction + omission store + orchestrator) on top of its
    # existing security/background/git-tracking fan-in. Joins the other complex
    # builtins above rather than hiding the wiring behind indirection.
    (ROOT / "sidecar" / "ai" / "tools" / "builtins" / "shell.py").resolve(),
    # These two crossed the budget by exactly the one import that makes them
    # CHEAPER at startup: their configure_* entry point and its mutable settings
    # container moved into a *_settings.py sibling so sidecar.ai.tools.registry can
    # apply configuration without importing the handler graph (219 -> 129 modules
    # on the registry import). The counter measures sibling breadth, which does not
    # distinguish a heavy dependency from a settings leaf, so the +1 here is the
    # intended cost of removing these modules from the startup path -- not a module
    # growing into a hub.
    (ROOT / "sidecar" / "ai" / "tools" / "builtins" / "filesystem.py").resolve(),
    (ROOT / "sidecar" / "ai" / "tools" / "builtins" / "grep_search.py").resolve(),
    # The tool-event emit choke point sits at 7 because two of its imports are
    # function-level cycle-breakers, not breadth: router (which imports this
    # module transitively, so ToolExecutionOutcome must be imported late) and
    # tool_execution_results (whose derived-envelope annotation must run inside
    # emit_tool_result, BEFORE the notification copies outcome metadata, so the
    # persisted fields match what the turn rendered). The counter cannot tell a
    # deferred cycle-breaker from a top-level dependency.
    (ROOT / "sidecar" / "ai" / "routing" / "loop_event_emit.py").resolve(),
    # Crossed the budget by exactly the one import that keeps it under the
    # 600-line ratchet: the interruption-overlay cluster moved to
    # interruption_overlay.py (W8-S3) and this module re-exports the names so
    # import sites and monkeypatch targets survive. The counter cannot tell an
    # extraction facade from a module growing into a hub.
    (ROOT / "sidecar" / "ai" / "context" / "runtime_overlays.py").resolve(),
    # Crossed the budget (6 -> 7) by exactly the one import that keeps it under
    # the 1015-line ratchet: the mid-stream tool-call announcement builder moved
    # to ollama_tool_call_announce.py (tool-activity-row program, 2026-08-31)
    # because the runtime sat at 1014 of 1015 lines. Same extraction-not-hub
    # shape as runtime_overlays.py above.
    (ROOT / "sidecar" / "ai" / "engines" / "ollama_runtime.py").resolve(),
    # Both crossed the budget (6 -> 7) by exactly the one import that keeps a
    # sibling under its size ratchet (BENCH-3D silent-stop fix, 2026-08-31):
    # ollama.py gained ollama_stream_thinking.py (thinking-delta feed/emit moved
    # out of the at-cap runtime pair) and vllm_engine_generation.py gained
    # vllm_sse_stream.py (cancel-aware SSE line iteration). Same
    # extraction-not-hub shape as ollama_runtime.py above.
    (ROOT / "sidecar" / "ai" / "engines" / "ollama.py").resolve(),
    (ROOT / "sidecar" / "ai" / "engines" / "vllm_engine_generation.py").resolve(),
    # Crossed the budget (6 -> 8) through two sibling extractions that keep it
    # under the 1015-line ratchet: bootstrap phase telemetry moved to
    # bootstrap_telemetry.py, then the bootstrap lock moved to bootstrap_lock.py
    # (python-runtime headroom slices, 2026-09-04). Same extraction-not-hub shape
    # as ollama_runtime.py above; interpreter.py re-exports both clusters so
    # existing import sites remain stable.
    (ROOT / "sidecar" / "ai" / "tools" / "builtins" / "python_runtime" / "interpreter.py").resolve(),
    # Sits at 7 because two of its imports are function-level cycle-breakers
    # (file_history and trash_maintenance import the retention hooks back), and
    # the seventh is the canonical error-code constant that check_error_codes
    # requires in place of an inline literal (recovery program, 2026-09-05).
    # Same deferred-cycle-breaker shape as loop_event_emit.py above.
    (ROOT / "sidecar" / "ai" / "tools" / "workspace_retention.py").resolve(),
}


def count_internal_imports(path: Path) -> int:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level > 0:
                module_name = "." * node.level + (node.module or "")
                imported.add(module_name)
            elif node.module and node.module.startswith("sidecar.ai"):
                imported.add(node.module)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("sidecar.ai"):
                    imported.add(alias.name)
    return len(imported)


def main() -> int:
    violations: list[str] = []
    for file_path in TARGET.rglob("*.py"):
        if file_path.name == "__init__.py" or file_path.resolve() in EXEMPT:
            continue
        import_count = count_internal_imports(file_path)
        if import_count > MAX_IMPORTS:
            violations.append(
                f"{file_path.relative_to(ROOT)} imports {import_count} sibling/internal modules"
            )

    if violations:
        print("FAIL: leaf import fan-out exceeded")
        for item in violations:
            print(f"  - {item}")
        return 1

    print("PASS: import fan-out check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
