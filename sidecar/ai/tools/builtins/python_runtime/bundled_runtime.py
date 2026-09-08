"""Detection and copying for managed bundled Python distributions."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from sidecar.ai.tools.builtins.python_runtime.errors import PythonRuntimeError

EMBED_MANIFEST_FILENAME = "python-embed-manifest.json"


def bundled_runtime_root(candidate: Path) -> tuple[Path, str] | None:
    """Return the distribution root and creation path for a managed bundle."""
    try:
        if candidate.name.lower() == "python.exe":
            root = candidate.parent
            if (root / EMBED_MANIFEST_FILENAME).is_file() and any(
                root.glob("python*._pth")
            ):
                return root, "bundled_embeddable"

        if candidate.parent.name != "bin":
            return None
        root = candidate.parent.parent
        manifest_path = root / EMBED_MANIFEST_FILENAME
        if not manifest_path.is_file():
            return None
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if isinstance(manifest, dict) and manifest.get("distribution") == (
            "python-build-standalone"
        ):
            return root, "bundled_copy"
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return None


def copy_bundled_runtime(
    base_interpreter: Path, root: Path, staging_dir: Path
) -> Path:
    """Copy an entire managed distribution into its stable user-owned root.

    PBS copies also create the ``bin/python`` alias expected by POSIX readiness.
    """
    source_dir = root.resolve()
    destination = staging_dir.resolve()
    try:
        destination.relative_to(source_dir)
    except ValueError:
        pass
    else:
        raise PythonRuntimeError(
            "Managed Python runtime destination overlaps its bundled source"
        )

    relative_interpreter = base_interpreter.resolve().relative_to(source_dir)
    shutil.copytree(root, staging_dir, symlinks=False)
    staging_python = staging_dir / relative_interpreter
    if not staging_python.is_file():
        raise PythonRuntimeError(
            f"Bundled Python copy did not create an executable at {staging_python}"
        )
    if os.name != "nt" and not os.access(staging_python, os.X_OK):
        raise PythonRuntimeError(
            f"Bundled Python copy is not executable at {staging_python}"
        )
    if relative_interpreter.parent.name == "bin" and relative_interpreter.name != "python":
        alias = staging_dir / "bin" / "python"
        if not (alias.is_symlink() or alias.exists()):
            # PBS bin/python aliases are excluded to avoid 31 MB materialized copies;
            # _venv_python() resolves bin/python on POSIX.
            try:
                os.symlink(staging_python.name, alias)
            except OSError:
                shutil.copy2(staging_python, alias)
    return staging_python


def _is_bundled_embeddable_interpreter(candidate: Path) -> bool:
    """Compatibility seam for established interpreter tests and callers."""
    bundle = bundled_runtime_root(candidate)
    return bundle is not None and bundle[1] == "bundled_embeddable"


def _copy_embeddable_runtime(base_interpreter: Path, staging_dir: Path) -> Path:
    """Compatibility seam using the historical Windows two-argument shape."""
    return copy_bundled_runtime(base_interpreter, base_interpreter.parent, staging_dir)
