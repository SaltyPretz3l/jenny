"""Prove the plugin platform's current stage posture mechanically.

PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md stages the rollout: Stage 2 lands the
real storage/contract modules as libraries with tests and **no activation
surface**; Stage 3 opens the disabled-only control plane (service facade + IPC);
Stage 4 opens the sidecar plugin-only initialize seam; Stages 5-7 open remote
descriptors, the restricted host, and sandboxed views. The platform is at Stage
8, the privileged adapter stage.

STAGE is flipped forward (only forward) in the same owner-approved commit that
opens the next stage's surfaces.

Each stage defines its OWN fence set. Flipping the stage REPLACES the previous
stage's fences rather than accumulating them. Stage 8's fence set lives entirely
in ``check_plugin_stage8_boundary.py``, and it is the only fence set this file
enforces.

Read that literally, because this docstring used to promise the opposite --
"Flipping the stage narrows fences; it never retires them wholesale... this
checker retains every later execution, network, view, MCP, process, evaluator,
and hook fence explicitly" -- and the code never did it. The stage-8 branch
called ``run_stage8_check(ROOT)`` and forwarded none of the Stage-4B/5/6 fences
that the stage-7 branch forwarded, so those fences stopped running the moment
STAGE moved to 8. Demonstrated rather than argued: with STAGE at 8, an ``eval()``
added to ``services/plugins/stage7-control-plane.js`` -- a file the Stage-7
evaluator fence explicitly covered with "contains an arbitrary JavaScript
evaluator" -- passed both this checker and ``check_plugin_boundary.py``.

Owner decision 2026-08-25 (code-hygiene W6-07-F09/F11): accept the narrowing and
correct the record, rather than re-applying the earlier fences at Stage 8. The
Stage-2..7 fence definitions were deleted in the same commit. So, concretely,
this file does NOT enforce the Stage-2 library-only fence, the Stage-3
composition graph, or the Stage-4B/5/6/7 execution, network, custom-view, MCP,
process-owner, evaluator, and hook fences. Restoring any of them means recovering
the definitions from git history; flipping STAGE backward will not bring them
back.

Direction guards -- which trees may import ``services/plugins/`` at all -- are a
separate mechanism and still live in ``check_plugin_boundary.py``.
"""
from __future__ import annotations

from pathlib import Path

from check_plugin_stage8_boundary import run_stage8_check

ROOT = Path(__file__).resolve().parents[2]

# Current program stage. It moves forward only, in lockstep with
# CONTROL_PLANE_STAGE in services/plugins/lifecycle/stage-gate.js, which
# run_stage8_check verifies structurally rather than by substring.
PRIVILEGED_ADAPTER_STAGE = 8
STAGE = PRIVILEGED_ADAPTER_STAGE


def main() -> int:
    if STAGE == PRIVILEGED_ADAPTER_STAGE:
        return run_stage8_check(ROOT)
    # Fail closed, and keep failing closed. A STAGE with no fence set defined
    # here must never pass: bumping STAGE without landing that stage's fences
    # reds every commit until the fences arrive, which is what makes a forward
    # flip an explicit act rather than a silent retirement of the current one.
    print(
        f"FAIL: plugin stage boundary check (stage {STAGE}; "
        "no explicit fence set and permitted-surface table are defined)"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
