"""Import site for the owned-process transport's Windows containment.

The first two halves below live outside this package on purpose, and this module
re-exports them so callers (`owned_process.py`, `sidecar/__main__.py`, and their tests)
still have one place to import from. `windows_bootstrap_command` is the one name
defined here: it prefers the native launcher and falls back to the Python child.

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

The native half -- resolving and health-probing `jenny-launch.exe`, the Rust
build of the bootstrap child -- lives in
`sidecar/ai/tools/builtins/owned_process_native.py`.
"""

from __future__ import annotations

# Stdlib-only by contract on both sides -- see each module's docstring.
from sidecar._owned_process_bootstrap import (
    encode_windows_bootstrap_payload,
    release_windows_bootstrap_target,
    run_windows_owned_process_bootstrap,
)
from sidecar._owned_process_bootstrap import windows_bootstrap_command as _python_bootstrap_command
from sidecar.runtime.process_job import WindowsJobObject, windows_process_is_alive


def windows_bootstrap_command() -> list[str]:
    """Return the trusted child that receives the target.

    The native launcher when it is healthy, else the Python child.
    """
    # Imported here so the sidecar's start-up import graph does not grow.
    from sidecar.ai.tools.builtins.owned_process_native import native_launcher_command

    return native_launcher_command() or _python_bootstrap_command()


__all__ = [
    "WindowsJobObject",
    "encode_windows_bootstrap_payload",
    "release_windows_bootstrap_target",
    "run_windows_owned_process_bootstrap",
    "windows_bootstrap_command",
    "windows_process_is_alive",
]
