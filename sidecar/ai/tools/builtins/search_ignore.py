"""Gitignore pruning for the grep_search and glob_files walks.

Git stays the authority on ignore rules: the filter is git's own bounded
inventory (tracked plus unignored untracked paths) of the search root. Any
doubt -- no repository, git failing or over budget, hosted mode, a search root
git does not index (an explicit path into an ignored folder) -- yields no
filter and the plain filesystem walk.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from sidecar.ai.tools.hosted_file_io import hosted_file_io_enabled
from sidecar.ai.tools.workspace_manifest_policy import (
    GIT_INVENTORY_MAX_SECONDS,
    inventory_key,
    read_covering_git_inventory,
)

# A root that yielded no filter (over the path budget, git slow or failing, not
# indexed) is remembered briefly so a large repository does not pay git's full
# timeout on every call. A usable inventory is never cached: a file the model
# just wrote must be searchable on the next call.
_NO_FILTER_TTL_SECONDS = 30.0
_NO_FILTER_MAX_ROOTS = 16
_no_filter_until: dict[str, float] = {}


class SearchIgnoreFilter:
    """Decides, per walked entry below ``root``, whether git would list it."""

    def __init__(self, root: Path, files: frozenset[str], directories: frozenset[str]) -> None:
        self.root = root
        self._files = files
        self._directories = directories
        # A directory git lists as a path (a submodule or nested repository):
        # git does not see inside it, so its subtree is searched unfiltered.
        self._opaque: set[str] = set()
        self._skipped: set[str] = set()

    @property
    def skipped_directories(self) -> int:
        return len(self._skipped)

    def allows_directory(self, path: Path) -> bool:
        key = self._key(path)
        if key is None or key in self._directories or self._under_opaque(key):
            return True
        if key in self._files:
            self._opaque.add(key)
            return True
        self._skipped.add(key)
        return False

    def allows_directory_chain(self, path: Path) -> bool:
        """``allows_directory`` for ``path`` and every ancestor below ``root``."""
        try:
            parts = path.relative_to(self.root).parts
        except ValueError:
            return True
        current = self.root
        for part in parts:
            current = current / part
            if not self.allows_directory(current):
                return False
        return True

    def allows_file(self, path: Path) -> bool:
        key = self._key(path)
        return key is None or key in self._files or self._under_opaque(key)

    def _key(self, path: Path) -> str | None:
        try:
            relative = path.relative_to(self.root).as_posix()
        except ValueError:
            return None
        if relative in {"", "."}:
            return None
        return inventory_key(relative)

    def _under_opaque(self, key: str) -> bool:
        return bool(self._opaque) and any(key.startswith(f"{prefix}/") for prefix in self._opaque)


def ignored_directories_note(count: int) -> str:
    """The result line that tells the model how to search what was pruned."""
    noun = "directory" if count == 1 else "directories"
    return f"Skipped {count} gitignored {noun}; pass a path inside one to search it."


def load_search_ignore_filter(search_root: Path) -> SearchIgnoreFilter | None:
    """The filter for a directory search root, or None to walk everything as before."""
    if hosted_file_io_enabled() or not search_root.is_dir():
        return None
    key = os.path.normcase(str(search_root))
    now = time.monotonic()
    if _no_filter_until.get(key, 0.0) > now:
        return None
    try:
        inventory = read_covering_git_inventory(
            search_root, timeout_seconds=GIT_INVENTORY_MAX_SECONDS
        )
    except Exception:  # noqa: BLE001 - the inventory is an optimization; never fail the search.
        inventory = None
    if inventory is None:
        _no_filter_until.pop(key, None)
        if len(_no_filter_until) >= _NO_FILTER_MAX_ROOTS:
            _no_filter_until.pop(next(iter(_no_filter_until)))
        _no_filter_until[key] = now + _NO_FILTER_TTL_SECONDS
        return None
    return SearchIgnoreFilter(search_root, inventory.files, inventory.directories)
