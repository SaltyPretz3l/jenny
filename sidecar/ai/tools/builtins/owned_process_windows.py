"""Import site for the owned-process transport's Windows containment.

Both halves live outside this package on purpose, and this module re-exports
them so callers (`owned_process.py`, `sidecar/__main__.py`, and their tests)
still have one place to import from.

The bootstrap half -- the wire contract plus the child-side entry point -- lives
in `sidecar/_owned_process_bootstrap.py`. It was moved out because every
owned-process spawn imports the child-side entry in a fresh interpreter, and
reaching it through this package charged that spawn ~270ms of unrelated
`sidecar.ai.tools.builtins` tool-runtime import. See that module's docstring for
the budgets it silently starved.

The Job Object half lives in `sidecar/runtime/process_job.py`. It was moved out
when image-gen provisioning needed the same containment: a second ctypes copy
would have been a third implementation in this repo, and Job handles are exactly
the kind of primitive where duplicates drift into correctness bugs.
"""

from __future__ import annotations

# Stdlib-only by contract on both sides -- see each module's docstring.
from sidecar._owned_process_bootstrap import (
    encode_windows_bootstrap_payload,
    release_windows_bootstrap_target,
    run_windows_owned_process_bootstrap,
    windows_bootstrap_command,
)
from sidecar.runtime.process_job import WindowsJobObject, windows_process_is_alive

__all__ = [
    "WindowsJobObject",
    "encode_windows_bootstrap_payload",
    "release_windows_bootstrap_target",
    "run_windows_owned_process_bootstrap",
    "windows_bootstrap_command",
    "windows_process_is_alive",
]
