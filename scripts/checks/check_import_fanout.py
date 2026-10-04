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
    (ROOT / "sidecar/ai/tools/builtins/python_runtime/interpreter.py").resolve(),
    # Sits at 7 because two of its imports are function-level cycle-breakers
    # (file_history and trash_maintenance import the retention hooks back), and
    # the seventh is the canonical error-code constant that check_error_codes
    # requires in place of an inline literal (recovery program, 2026-09-05).
    # Same deferred-cycle-breaker shape as loop_event_emit.py above.
    (ROOT / "sidecar" / "ai" / "tools" / "workspace_retention.py").resolve(),
    # Crossed the budget (6 -> 7) by exactly the one import that keeps the
    # context-builder hub under the 600-line production ratchet: the
    # BOOTSTRAP/agentj.md loaders moved to builder_workspace_files.py (request-
    # root prompt fix, 2026-09-18; 592 -> 514 lines). Same extraction-not-hub
    # shape as ollama_runtime.py above.
    (ROOT / "sidecar" / "ai" / "context" / "builder.py").resolve(),
    # Crossed the budget (6 -> 7) by exactly the one mixin that keeps the store
    # a composition of per-concern files: the project-delete memory move lives in
    # store_project_move.py (Projects manager, 2026-09-27) beside the approved and
    # pending mixins. Same extraction-not-hub shape as ollama_runtime.py above.
    (ROOT / "sidecar" / "ai" / "memory" / "store.py").resolve(),
}


# Hosted request assembly must combine descriptor owners with independent host
# admission policy. Edit orchestration adds the canonical atomic-write owner to
# existing read/checkpoint/result owners. Keep these explicit edges narrowly capped;
# do not obscure security ownership with forwarding modules or general exemptions.
WIRING_CAPS = {
    # Desktop command sandbox adds one independent execution-policy owner at
    # these configuration/dispatch composition seams (DESKTOP_COMMAND_SANDBOX.md).
    # Exact caps preserve explicit security imports rather than hiding them in facades.
    (ROOT / "sidecar/ai/config.py").resolve(): 7,
    # Combined hosted worker and desktop sandbox integration adds two canonical
    # policy owners (6 -> 8): hosted direct-dispatch fencing and desktop approval
    # routing. Independently reviewed; retain both visible security dependencies.
    (ROOT / "sidecar/ai/routing/tool_execution.py").resolve(): 8,
    (ROOT / "sidecar/ai/tools/assembly.py").resolve(): 8,
    (ROOT / "sidecar/ai/tools/builtins/edit_file.py").resolve(): 7,
    # The tool-loop runner settles its workspace change set on every exit and
    # must recognise the approval-pause suspension type to do so (6 -> 7,
    # session-runtime review 2026-09-13). Reviewed; keep the dependency visible.
    (ROOT / "sidecar/ai/routing/tool_loop_run.py").resolve(): 7,
    # Tool assembly takes the request's safety mode (owner D3, Settings cohesion
    # 2026-09-30) from the request-scoped owner routing/request_safety so a
    # Strict switch blocks web tools from the next message (6 -> 7). Reviewed;
    # keep the safety-policy dependency visible.
    (ROOT / "sidecar/ai/routing/tool_resolution.py").resolve(): 7,
    # Subagent Monitor v2 (2026-09-28): both child-report builders attach the
    # monitor's UI-only steps/answer from one scrub owner (delegate_child_steps).
    # The V1 subagent_run executor was removed (DLG-07, 2026-10-03). Exact caps
    # keep the scrub visible, not forwarded.
    (ROOT / "sidecar/ai/routing/delegate.py").resolve(): 7,
    # MCP transport review (MCP-02/04, 2026-10-03): SSE server error text passes
    # through the shared tool-output sanitizer like stdio does (6 -> 7). Reviewed.
    (ROOT / "sidecar/ai/mcp/transport_sse.py").resolve(): 7,
    # Compaction diagnostics (dogfood FG-008, 2026-09-30): the mid-turn compaction
    # owner describes the window it rebuilt through the one content-free shape
    # owner (compaction_diagnostics), after its own re-pin (6 -> 7). Exact cap
    # keeps that scrub a visible edge rather than a forwarded one.
    (ROOT / "sidecar/ai/routing/tool_loop_compaction.py").resolve(): 7,
    # python_execute reads the per-call cancellation slot so Stop reaches its
    # child process (TEP-003, 2026-10-02; 6 -> 7), the same edge run_command's
    # handler has. Exact cap keeps the cancellation dependency a visible import
    # rather than one forwarded through the sandbox module.
    (ROOT / "sidecar/ai/tools/builtins/python_runtime/tool.py").resolve(): 7,
}


# Concrete-edge baseline (CHK-15, 2026-10-03). The counter used to collapse
# `from sidecar.ai.pkg import a, b, c` into one edge; it now counts each module.
# These modules were already that broad, so they are pinned at the counts
# measured when the counting changed. A pin may only go down; growth needs its
# own reviewed WIRING_CAPS entry.
CONCRETE_EDGE_BASELINE = {
    (ROOT / "sidecar/ai/engines/ollama_generation.py").resolve(): 7,
    (ROOT / "sidecar/ai/mcp/builtin_request_scope.py").resolve(): 9,
    (ROOT / "sidecar/ai/routing/chat_decision.py").resolve(): 15,
    (ROOT / "sidecar/ai/routing/generation_runtime.py").resolve(): 15,
    (ROOT / "sidecar/ai/routing/generation_runtime_stream.py").resolve(): 12,
    (ROOT / "sidecar/ai/routing/route_policy_runtime.py").resolve(): 12,
    (ROOT / "sidecar/ai/routing/sub_agent_invocation.py").resolve(): 7,
    (ROOT / "sidecar/ai/routing/tool_budget_filter.py").resolve(): 9,
    (ROOT / "sidecar/ai/routing/tool_call_execution.py").resolve(): 13,
    (ROOT / "sidecar/ai/routing/tool_execution.py").resolve(): 28,
    (ROOT / "sidecar/ai/routing/tool_loop_calls.py").resolve(): 13,
    (ROOT / "sidecar/ai/routing/tool_loop_finalize.py").resolve(): 8,
    (ROOT / "sidecar/ai/routing/tool_loop_recovery.py").resolve(): 7,
    (ROOT / "sidecar/ai/tools/assembly.py").resolve(): 9,
    (ROOT / "sidecar/ai/tools/workspace_manifest.py").resolve(): 7,
    (ROOT / "sidecar/ai/tools/builtins/file_state.py").resolve(): 8,
    (ROOT / "sidecar/ai/tools/builtins/shell_background.py").resolve(): 7,
}


def count_internal_imports(path: Path) -> int:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    imported: set[str] = set()
    package_parts = path.parent.relative_to(ROOT).parts
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level:
                parts = package_parts[:len(package_parts) - node.level + 1]
                if node.module:
                    parts = (*parts, *node.module.split("."))
                module_name = ".".join(parts)
            elif node.module and node.module.startswith("sidecar.ai"):
                module_name = node.module
            else:
                continue
            base_path = ROOT.joinpath(*module_name.split("."))
            for alias in node.names:
                candidate = base_path / alias.name
                if candidate.with_suffix(".py").is_file() or (candidate / "__init__.py").is_file():
                    imported.add(f"{module_name}.{alias.name}")
                else:
                    imported.add(module_name)
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
        wiring_cap = WIRING_CAPS.get(file_path.resolve(), MAX_IMPORTS)
        pin = CONCRETE_EDGE_BASELINE.get(file_path.resolve(), 0)
        if import_count > max(wiring_cap, pin):
            violations.append(
                f"{file_path.relative_to(ROOT)} imports {import_count} sibling/internal modules"
            )
        elif pin > wiring_cap and import_count < pin:
            # The ratchet: a module that shed edges must not regrow to its old pin.
            violations.append(
                f"{file_path.relative_to(ROOT)} imports {import_count}, below its "
                f"CONCRETE_EDGE_BASELINE pin of {pin}; lower the pin (or drop it at "
                f"{wiring_cap} or fewer)"
            )
    for pinned in CONCRETE_EDGE_BASELINE:
        if not pinned.is_file():
            violations.append(
                f"{pinned.relative_to(ROOT)} is pinned in CONCRETE_EDGE_BASELINE but is gone"
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
