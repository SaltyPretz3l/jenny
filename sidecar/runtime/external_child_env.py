"""Prepare environments for processes launched outside the sidecar.

PyInstaller adjusts ``LD_LIBRARY_PATH`` so its frozen process loads bundled libraries.
External children need the pre-PyInstaller value to use their system libraries safely.
Only a copied child environment is restored; the sidecar's own environment is untouched.
"""

from __future__ import annotations

import os
import sys
from typing import Mapping


def external_child_environment(
    base: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return a fresh child environment with frozen POSIX library paths restored."""
    child_env = dict(os.environ if base is None else base)
    if os.name != "nt" and getattr(sys, "frozen", False):
        original_library_path = child_env.pop("LD_LIBRARY_PATH_ORIG", None)
        if original_library_path:
            child_env["LD_LIBRARY_PATH"] = original_library_path
        else:
            child_env.pop("LD_LIBRARY_PATH", None)
    return child_env
