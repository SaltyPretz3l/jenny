"""Process-local settings for filesystem tool handlers."""

from __future__ import annotations

DEFAULT_MAX_EDIT_FILE_BYTES = 2_097_152

_FILESYSTEM_SETTINGS: dict[str, int | bool] = {
    "max_edit_file_bytes": DEFAULT_MAX_EDIT_FILE_BYTES,
    "image_read_enabled": False,
    "rich_files_enabled": False,
}


def _extract_positive_int(config: object, key: str, *, default: int) -> int:
    if isinstance(config, dict):
        value = config.get(key)
    else:
        value = getattr(config, key, None)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        candidate = int(value)
        return candidate if candidate > 0 else default
    return default


def configure_filesystem_tools(config: object | None) -> None:
    max_edit_file_bytes = DEFAULT_MAX_EDIT_FILE_BYTES
    image_read_enabled = False
    rich_files_enabled = False
    if config is not None:
        max_edit_file_bytes = _extract_positive_int(
            config,
            "tools_max_edit_file_bytes",
            default=DEFAULT_MAX_EDIT_FILE_BYTES,
        )
        if isinstance(config, dict):
            image_read_enabled = bool(config.get("tools_image_read_enabled", False))
            rich_files_enabled = bool(config.get("tools_rich_files_enabled", False))
        else:
            image_read_enabled = bool(getattr(config, "tools_image_read_enabled", False))
            rich_files_enabled = bool(
                getattr(config, "tools_rich_files_enabled", False)
            )
    _FILESYSTEM_SETTINGS["max_edit_file_bytes"] = max_edit_file_bytes
    _FILESYSTEM_SETTINGS["image_read_enabled"] = image_read_enabled
    _FILESYSTEM_SETTINGS["rich_files_enabled"] = rich_files_enabled
