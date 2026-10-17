"""The sidecar server import graph must stay bounded and provider-lazy.

Every sidecar spawn pays this import cost in a fresh interpreter, so anything
reachable from ``sidecar.server`` at module scope is on the launch path.

Recorded on 2026-09-03, measured the same way this test measures (a count of
loaded ``sidecar.*`` names after ``import sidecar.server`` in a clean
interpreter), before and after making the six provider engines lazy:

    sidecar.* modules   365 -> 345
    total sys.modules   598 -> 578

Every module shed is a ``sidecar.*`` module -- the two deltas are both 20, so
no third-party package leaves the graph. Wall clock is deliberately NOT recorded
here: the only honest way to measure it is to run the before-tree from a
different directory, which changes the .pyc cache and the disk it is read from,
and the answer moves between roughly 40ms and 130ms depending on the method. The
module counts are deterministic; the timings are not.

Note the units, which have been got wrong twice: an early note recorded "562"
(a *delta* of total ``sys.modules`` against an interpreter baseline, not the
``sidecar.*`` count asserted here), and a later correction recorded "633" for
the before-total, which does not reproduce -- it is 598. Measure with
``import sidecar.server`` in a clean interpreter, and count the two sets
separately.

These tests assert the import GRAPH, never wall-clock timings, so they stay
deterministic on a loaded CI box.
"""

from __future__ import annotations

import json
import subprocess
import sys

# 2026-09-05: 352 after the workspace recovery program (mutation journal
# lifecycle + task_board/connections policy mirrors on the tool-loop path);
# the recovery RPC family itself is lazy in request_dispatch.py.
# 2026-09-10: 345 after deferring MCP transport construction/inspection to
# request use. Runtime admission/continuation modules are included in this count.
# 2026-09-23: 353 (bisected; one per landing, no single eager regression):
# pipe_stdin (server stdio gate), media_site (optional PDF add-on check),
# pdf_text (PDF reader, used at filesystem_content module scope), and two
# file-size splits (builder_workspace_files, phase_trace).
# 2026-09-30: 359. The ChatGPT model catalog (sidecar/ai/engines/chatgpt_model_catalog.py and
# sidecar/runtime/chatgpt_model_catalog.py) is read by config_parsing and capabilities at startup;
# the prefix-stability meter is imported per request in generation_diagnostics.py instead.
# 2026-10-01: 365 (one per landing, no single eager regression). Dogfood batches: write_progress,
# build_turn_tools, text_tool_calls, plan_presentation and compaction_diagnostics, all imported by
# the tool loop and context modules that were already eager. Settings cohesion: request_safety,
# read by tool_execution at module scope. The count sat at the 364 cap before the last one.
# 2026-10-15: 374 (row 58 W1). The schema v9 memory store split into six mixin
# modules imported by store.py at class-definition time (store_v9_migration,
# store_operations, store_write_support, store_writes, store_undo, store_lifecycle);
# the same wave deleted families, store_project_move and memory_suggestions. The
# memory tool handler (tool_execution_memory) loads on first use, not at startup.
# 2026-10-15: 378 (row 59 cp5a-1). Four new modules, each imported by an already-eager
# seam: context_rows and session_handoff (messages/token_budget/compaction context-row
# dispatch), turn_boundary (router and chat_decision_render), handoff_preparation
# (chat.send param parsing and tool-contract restriction).
# 2026-10-15: 401 at the landing of rows 58 W2-W4, 59 and 60 on main (each program stayed
# under its own cap; the union crossed it at the merge). Row 58 W2-W4 +17, reached from the
# memory service and request dispatch at import time: memory reflection (memory_reflection,
# request_dispatch_memory_reflection, store_reflection, reflection_checks, reflection_epochs),
# hybrid recall (hybrid_recall, recall_pipeline, recall_scoring, store_vectors, vector_index,
# sidecar.ai.semantic.vectors) and store_v10_migration. Row 59 cp5b/cp6 +7: context_rows,
# session_handoff, session_messages, turn_boundary, handoff_preparation,
# chat_workspace_capabilities, command_proposal_worker. Row 60 +4: compaction_micro,
# heuristic_fires, tool_recall, builtins.shell_harness. prefill_progress left the graph (-1).
# Open follow-up: an eager-import diet for the memory service (reflection and recall are
# request-time features).
# 2026-10-15: 390 after that diet (-11). Now loaded on first request: memory reflection
# (runtime.memory_reflection, request_dispatch_memory_reflection behind a method gate,
# reflection_checks), the hybrid vector leg (hybrid_recall, vector_index), recall_scoring
# (first recall), sidecar.ai.semantic + semantic.vectors (first embed step), and the
# migration steps store_project_migration, store_v9_migration and store_v10_migration
# (only a database below SCHEMA_VERSION runs them). Still eager by construction: the
# store_reflection and store_vectors mixins (MemoryStore bases), recall_pipeline and
# reflection_epochs (built with MemoryService when the container opens the store).
_MEASURED_SIDECAR_MODULES = 390
_MAX_SIDECAR_MODULES = _MEASURED_SIDECAR_MODULES + 5
# Floored as well as capped: without a lower bound, a later graph reduction to
# (say) 320 would leave this recorded 345 stale and silently widen the slack to
# 30, so the next regression would have to be six times larger to trip the cap.
_MIN_SIDECAR_MODULES = _MEASURED_SIDECAR_MODULES - 5
_DEFERRED_PROVIDER_MODULES = {
    "sidecar.ai.engines.codex_cli",
    "sidecar.ai.engines.ollama",
    "sidecar.ai.engines.openai_compatible",
    "sidecar.ai.engines.replay",
    "sidecar.ai.engines.responses_descriptor",
    "sidecar.ai.engines.vllm_engine",
}


def _sidecar_modules_after_server_import() -> set[str]:
    code = (
        "import json, sys\n"
        "import sidecar.server\n"
        "print(json.dumps(sorted("
        "n for n in sys.modules if n == 'sidecar' or n.startswith('sidecar.')"
        ")))\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=True,
    )
    return set(json.loads(completed.stdout))


def test_server_import_graph_stays_within_module_budget() -> None:
    loaded = _sidecar_modules_after_server_import()

    assert loaded.isdisjoint({
        "sidecar.ai.routing.preview_vision",
        "sidecar.ai.tools.preview_image",
    }), "Preview helpers must load on use rather than during server startup"
    assert loaded.isdisjoint({
        "sidecar.ai.mcp.client",
        "sidecar.ai.mcp.inspection",
        "sidecar.runtime.chat_continuation_resume",
        "sidecar.runtime.chat_resume_admission",
        "sidecar.runtime.chat_resume_snapshots",
        "sidecar.runtime.decision_checkpoint",
        "sidecar.runtime.owned_process_tracking",
        "sidecar.runtime.owned_process_ledger",
        "sidecar.runtime.owned_process_identity",
        "sidecar.ai.tools.workspace_mutation_journal_store",
        "sidecar.ai.tools.workspace_retention",
    }), "MCP transports, resume execution and journal storage must load on request use"
    assert len(loaded) <= _MAX_SIDECAR_MODULES, (
        f"importing sidecar.server loaded {len(loaded)} sidecar modules; "
        f"the limit is {_MAX_SIDECAR_MODULES}. Investigate the new eager import "
        "that expanded the startup graph rather than simply raising the limit."
    )
    assert len(loaded) >= _MIN_SIDECAR_MODULES, (
        f"importing sidecar.server loaded only {len(loaded)} sidecar modules, below "
        f"the recorded floor of {_MIN_SIDECAR_MODULES}. The graph shrank -- re-record "
        "_MEASURED_SIDECAR_MODULES so the budget keeps its original tightness."
    )


def test_server_import_defers_provider_engines() -> None:
    loaded = _sidecar_modules_after_server_import()

    assert loaded.isdisjoint(_DEFERRED_PROVIDER_MODULES), (
        "importing sidecar.server eagerly loaded provider engines: "
        f"{sorted(loaded & _DEFERRED_PROVIDER_MODULES)}"
    )
