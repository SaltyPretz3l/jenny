"""Bounds the change review an Electron tool hands back through the bridge (row 106).

The bridge drops every metadata key that names a path, because Electron results are untrusted and an
absolute path must not travel with them. A synced sandbox run's ``diffs`` and
``scripted_change_review`` are the exception: their workspace-relative paths are what the Changed
files rows, Undo and the refused list are made of. Only the fields of that shape keep a path, and
only a relative one; Electron's persisted-metadata sanitizer checks each one again.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable
from typing import Any

CHANGE_REVIEW_METADATA_KEYS = frozenset({"diffs", "scripted_change_review"})

# Above MAX_DIFF_LINES (200, services/tools/structured-diff.js), the longest list in the shape.
_MAX_ITEMS = 256
_MAX_DEPTH = 6
_MAX_PATH_CHARS = 4096
_PATH_KEY = "path"
_PATH_LIST_KEYS = frozenset({"changed_paths", "host_run_paths"})
_PATH_ENTRY_LIST_KEYS = frozenset({"refused_paths"})
_PATH_COUNT_KEYS = frozenset({"changed_path_count"})


def _is_relative_path(value: str) -> bool:
    # The same rule as normalizeRelativePath in tool-result-diff-metadata.js.
    if not value or len(value) > _MAX_PATH_CHARS or "\x00" in value or ":" in value:
        return False
    normalized = value.replace("\\", "/")
    return not normalized.startswith("/") and ".." not in normalized.split("/")


class _ReviewCleaner:
    def __init__(
        self, scalar: Callable[[Any], Any], is_path_key: Callable[[Any], bool], omit: object,
    ) -> None:
        self._scalar = scalar
        self._is_path_key = is_path_key
        self._omit = omit

    def path(self, value: Any) -> str | None:
        # A value the scalar rule would rewrite (a secret shape, an oversized string) is not a path.
        if not isinstance(value, str) or self._scalar(value) != value:
            return None
        return value if _is_relative_path(value) else None

    def _paths(self, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        cleaned = (self.path(item) for item in value[:_MAX_ITEMS])
        return [item for item in cleaned if item is not None]

    def _path_entries(self, value: Any, depth: int) -> list[Any]:
        if not isinstance(value, list) or depth >= _MAX_DEPTH:
            return []
        entries = [item for item in value[:_MAX_ITEMS] if isinstance(item, dict)]
        cleaned = [self.mapping(item, depth + 1) for item in entries]
        return [entry for entry in cleaned if _PATH_KEY in entry]

    def mapping(self, value: dict[Any, Any], depth: int) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for raw_key, item in itertools.islice(value.items(), _MAX_ITEMS):
            key = str(raw_key)
            cleaned: Any
            if key == _PATH_KEY:
                cleaned = self.path(item)
                if cleaned is None:
                    continue
            elif key in _PATH_LIST_KEYS:
                cleaned = self._paths(item)
            elif key in _PATH_ENTRY_LIST_KEYS:
                cleaned = self._path_entries(item, depth)
            elif self._is_path_key(key) and key not in _PATH_COUNT_KEYS:
                continue
            else:
                cleaned = self.value(item, depth + 1)
                if cleaned is self._omit:
                    continue
            output[key] = cleaned
        return output

    def value(self, value: Any, depth: int) -> Any:
        scalar = self._scalar(value)
        if scalar is not self._omit:
            return scalar
        if depth >= _MAX_DEPTH:
            return self._omit
        if isinstance(value, list | tuple):
            items = (self.value(item, depth + 1) for item in value[:_MAX_ITEMS])
            return [item for item in items if item is not self._omit]
        if isinstance(value, dict):
            return self.mapping(value, depth)
        return self._omit


def sanitize_change_review(
    value: Any, scalar: Callable[[Any], Any], is_path_key: Callable[[Any], bool], omit: object,
) -> Any:
    """One ``diffs`` or ``scripted_change_review`` value, or ``omit`` when it is not a container."""
    if not isinstance(value, list | dict):
        return omit
    return _ReviewCleaner(scalar, is_path_key, omit).value(value, 0)
