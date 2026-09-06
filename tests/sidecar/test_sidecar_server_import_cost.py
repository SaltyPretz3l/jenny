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
_MEASURED_SIDECAR_MODULES = 352
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
