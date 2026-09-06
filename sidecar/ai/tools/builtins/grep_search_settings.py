"""Process-local settings for the workspace search handler."""

from __future__ import annotations

from typing import Any

DEFAULT_MAX_SEARCH_FILE_BYTES = 2_097_152
MIN_CONFIGURED_SEARCH_FILE_BYTES = 1024
MAX_CONFIGURED_SEARCH_FILE_BYTES = 10_485_760

_SEARCH_SETTINGS = {
    "max_search_file_bytes": DEFAULT_MAX_SEARCH_FILE_BYTES,
}


def configure_grep_search(config: Any | None) -> None:
    if isinstance(config, dict):
        value = config.get("tools_max_search_file_bytes")
    else:
        value = getattr(config, "tools_max_search_file_bytes", None)
    if (
        isinstance(value, int)
        and MIN_CONFIGURED_SEARCH_FILE_BYTES <= value <= MAX_CONFIGURED_SEARCH_FILE_BYTES
    ):
        _SEARCH_SETTINGS["max_search_file_bytes"] = value
        return
    _SEARCH_SETTINGS["max_search_file_bytes"] = DEFAULT_MAX_SEARCH_FILE_BYTES
