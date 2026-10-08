"""Keep a project's ``.jenny`` state folder self-ignoring for Git.

Like ``.venv`` or ``.pytest_cache``, Jenny drops ``.jenny/.gitignore`` = ``*``
whenever it creates or writes into a project's ``.jenny`` folder, so the folder
never shows as untracked in Source Control and cannot be committed by accident.

Contract (kept in sync with ``services/jenny-project-dir.js``):

* only a directory literally named ``.jenny`` is touched;
* an existing ``.jenny/.gitignore`` is never overwritten (exclusive create,
  which also refuses a link planted at that name);
* a ``.jenny`` that is a link/reparse point or not a directory is left alone;
* best-effort: every failure is swallowed so the caller's operation proceeds.

Callers pass the ``.jenny`` path they already built behind their own
workspace-root containment checks; this module adds no other path inputs.
"""

from __future__ import annotations

import os
import stat as stat_module
from pathlib import Path

JENNY_STATE_DIR_NAME = ".jenny"
JENNY_GITIGNORE_NAME = ".gitignore"
JENNY_GITIGNORE_CONTENT = "# Created by Jenny: this folder holds Jenny's local state.\n*\n"
_WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400


def _is_plain_directory(path: Path) -> bool:
    info = os.lstat(path)
    if not stat_module.S_ISDIR(info.st_mode):
        return False
    attributes = int(getattr(info, "st_file_attributes", 0) or 0)
    return not attributes & _WINDOWS_REPARSE_POINT_ATTRIBUTE


def ensure_jenny_dir_gitignore(jenny_dir: Path | str) -> bool:
    """Create ``<jenny_dir>/.gitignore`` = ``*`` if absent; return whether it wrote."""

    try:
        directory = Path(jenny_dir)
        if directory.name != JENNY_STATE_DIR_NAME or not _is_plain_directory(directory):
            return False
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        fd = os.open(directory / JENNY_GITIGNORE_NAME, flags, 0o644)
        try:
            os.write(fd, JENNY_GITIGNORE_CONTENT.encode("utf-8"))
        finally:
            os.close(fd)
        return True
    except (OSError, ValueError, TypeError):
        return False


__all__ = [
    "JENNY_GITIGNORE_CONTENT",
    "JENNY_STATE_DIR_NAME",
    "ensure_jenny_dir_gitignore",
]
