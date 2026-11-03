"""Run a gate script under the repo venv when the invoking interpreter lacks its deps.

`python scripts/checks/run_all.py` (the pre-commit hook), `npm run check:all` and an
agent's `python scripts/checks/run_ci.py` all resolve a bare `python` through PATH. On a
host whose first `python` is the system interpreter, that one has no psutil, and the
policy gate died at wave 0 with `ModuleNotFoundError` (2026-11-01). When a required
module is missing and the checkout has `.venv`, the script re-runs itself under the venv
interpreter with the same arguments and exits with its code. Without a venv nothing
changes: the import fails with its own message, as before.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from importlib.util import find_spec
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Set on the re-run so a venv that also lacks the module cannot loop.
REEXEC_ENV = "JENNY_GATE_VENV_REEXEC"


def venv_python(root: Path = ROOT) -> Path:
    if sys.platform.startswith("win"):
        return root / ".venv" / "Scripts" / "python.exe"
    return root / ".venv" / "bin" / "python"


def ensure_repo_venv(
    required: Sequence[str] = ("psutil",),
    *,
    root: Path = ROOT,
    run: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
) -> None:
    """Return when every ``required`` module imports; otherwise re-run under ``.venv`` and exit."""
    missing = [name for name in required if find_spec(name) is None]
    if not missing or os.environ.get(REEXEC_ENV):
        return
    target = venv_python(root)
    if not target.is_file() or Path(sys.executable).resolve() == target.resolve():
        return
    print(
        f"NOTE: {sys.executable} has no {', '.join(missing)}; re-running under {target}",
        flush=True,
    )
    env = {**os.environ, REEXEC_ENV: "1"}
    result = run([str(target), *sys.argv], env=env, check=False)
    raise SystemExit(result.returncode)
