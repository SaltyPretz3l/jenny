"""Run a gate script under the repo venv whenever the checkout has one.

`python scripts/checks/run_all.py` (the pre-commit hook), `npm run check:all` and an
agent's `python scripts/checks/run_ci.py` all resolve a bare `python` through PATH, which
on this host can be the system interpreter. The first version re-ran only when a listed
module was missing, and that list kept trailing the checks: the gate died on a missing
psutil (2026-11-01), then, once the system interpreter had psutil, on httpx inside
check_sidecar_packaging (2026-11-04). The gate's dependencies are the venv's, so whenever
the checkout has `.venv` and the invoking interpreter is not it, the script re-runs itself
under the venv interpreter with the same arguments and exits with its code. Without a venv
(a worktree made with -NoInstall, a bare CI runner) nothing changes.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Set on the re-run so a venv interpreter that reports another path cannot loop.
REEXEC_ENV = "JENNY_GATE_VENV_REEXEC"


def venv_python(root: Path = ROOT) -> Path:
    if sys.platform.startswith("win"):
        return root / ".venv" / "Scripts" / "python.exe"
    return root / ".venv" / "bin" / "python"


def _same_file(left: Path, right: Path) -> bool:
    try:
        return left.resolve() == right.resolve()
    except OSError:
        return False


def ensure_repo_venv(
    *,
    root: Path = ROOT,
    run: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
) -> None:
    """Return when already under ``.venv`` (or there is none); else re-run under it and exit."""
    if os.environ.get(REEXEC_ENV):
        return
    target = venv_python(root)
    if not target.is_file() or _same_file(Path(sys.executable), target):
        return
    print(f"NOTE: re-running under {target} (invoked with {sys.executable})", flush=True)
    env = {**os.environ, REEXEC_ENV: "1"}
    result = run([str(target), *sys.argv], env=env, check=False)
    raise SystemExit(result.returncode)
