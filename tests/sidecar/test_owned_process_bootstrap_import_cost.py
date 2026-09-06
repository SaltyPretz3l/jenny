"""The owned-process bootstrap must stay cheap to import.

This is the regression gate for a silent, cross-cutting performance defect.

Every owned-process spawn re-enters `python -m sidecar --owned-process-bootstrap`
in a FRESH interpreter, so whatever that path imports is paid once per spawned
subprocess. The bootstrap child used to live in
`sidecar/ai/tools/builtins/owned_process_windows.py`, and that package's
`__init__.py` eagerly imports the python-execute tool runtime -- so every `git
rev-parse` paid ~270ms to import a tool runtime it never touched, plus ~90ms for
`multiprocessing` at the entrypoint's module scope.

That overhead is invisible in isolation and had no failing test of its own. It
surfaced only as missing data inside prompt blocks, because it silently starved
every sub-second git budget in the sidecar:

  - `ai/repo_delta/service.py` budgets a few seconds for six sequential spawns.
    The budget ran out mid-sequence, so the `<repository-delta>` block lost its
    commit list and file list and degraded to two opaque SHAs -- and did so
    nondeterministically, depending on which spawn the deadline landed in.
  - `ai/tools/workspace_manifest.py` capped each git command at 0.5s, BELOW the
    per-spawn overhead, so its git snapshot failed unconditionally: git returned
    the right answer and the harness discarded it as a timeout.

A future `from sidecar.<anything> import ...` in the bootstrap module would
re-break both, and neither feature's own tests would fail -- they would just
quietly carry less data. Hence an explicit gate here.

These tests assert the IMPORT GRAPH, not wall-clock timings, so they are
deterministic and safe on a loaded CI box.
"""

from __future__ import annotations

import subprocess
import sys

# Allowed `sidecar.*` modules in a fresh interpreter that has imported only the
# bootstrap. `sidecar` itself is the (empty) package __init__ that must load to
# reach the submodule; nothing else may appear.
_ALLOWED_SIDECAR_MODULES = {"sidecar", "sidecar._owned_process_bootstrap"}


def _sidecar_modules_after(import_statement: str) -> set[str]:
    """Import `import_statement` in a clean interpreter, return loaded `sidecar.*`."""
    code = (
        f"{import_statement}\n"
        "import sys, json\n"
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
    return set(__import__("json").loads(completed.stdout))


def test_bootstrap_module_imports_nothing_else_from_sidecar() -> None:
    loaded = _sidecar_modules_after("import sidecar._owned_process_bootstrap")

    assert loaded <= _ALLOWED_SIDECAR_MODULES, (
        "the owned-process bootstrap pulled in extra sidecar modules: "
        f"{sorted(loaded - _ALLOWED_SIDECAR_MODULES)}. Every owned-process spawn "
        "pays this import cost in a fresh interpreter; keep this module stdlib-only."
    )


def test_bootstrap_module_does_not_import_the_builtins_tool_package() -> None:
    """The specific regression: `sidecar.ai.tools.builtins` costs ~270ms to import."""
    loaded = _sidecar_modules_after("import sidecar._owned_process_bootstrap")

    assert "sidecar.ai.tools.builtins" not in loaded
    assert not any(name.startswith("sidecar.ai") for name in loaded)


def test_entrypoint_bootstrap_dispatch_stays_off_the_heavy_import_path() -> None:
    """`python -m sidecar --owned-process-bootstrap` must not load the tool runtime.

    Covers the whole real spawn path, not just the leaf module: the entrypoint
    could regress by importing something heavy at its own module scope even while
    the bootstrap module itself stays clean.
    """
    code = (
        "import sys, json\n"
        "import sidecar.__main__ as m\n"
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
    loaded = set(__import__("json").loads(completed.stdout))

    assert not any(name.startswith("sidecar.ai") for name in loaded), (
        "importing the sidecar entrypoint pulled in the ai/tool stack: "
        f"{sorted(n for n in loaded if n.startswith('sidecar.ai'))}. That cost is "
        "paid on every owned-process spawn; keep those imports lazy."
    )
    assert "multiprocessing" not in _stdlib_modules_after_entrypoint_import(), (
        "the sidecar entrypoint imported multiprocessing at module scope; it costs "
        "~90ms per owned-process spawn and is only needed for frozen CLI startup"
    )


def _stdlib_modules_after_entrypoint_import() -> set[str]:
    code = (
        "import sys, json\n"
        "import sidecar.__main__\n"
        "print(json.dumps(sorted(sys.modules)))\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=True,
    )
    return set(__import__("json").loads(completed.stdout))
