"""PATH lookup that never resolves an executable from the process cwd.

On Windows ``shutil.which`` searches the current directory before PATH, so a
launcher planted in the sidecar's cwd (the repo root in a dev checkout, the
install directory when packaged) would win. Shared by the shell tool, the
temporary-script interpreters and language-server detection.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def which_on_explicit_path(name: str, *, path: str) -> str | None:
    """Ignore cwd fallback and relative/empty PATH entries on every Python version."""
    if Path(name).is_absolute():
        return shutil.which(name, path=path)
    for raw in path.split(os.pathsep):
        directory = Path(raw.strip('"'))
        if not raw or not directory.is_absolute():
            continue
        # On Windows shutil.which prepends the cwd unless "." is already listed; listing it
        # last keeps a cwd copy from shadowing this directory (its hit fails the parent check).
        resolved = shutil.which(name, path=os.pathsep.join((str(directory), os.curdir)))
        if resolved is not None and os.path.normcase(str(Path(resolved).absolute().parent)) == (
                os.path.normcase(str(directory.absolute()))):
            return resolved
    return None
