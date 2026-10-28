"""Process-local settings for Git tool handlers."""

from __future__ import annotations

from sidecar.ai.tools.config_utils import config_value

GIT_TIMEOUT_SECONDS = 20.0
MAX_GIT_TIMEOUT_SECONDS = 120.0

_timeout_seconds = GIT_TIMEOUT_SECONDS


def _configured_git_timeout_seconds(config: object | None) -> float:
    value = config_value(config or {}, "tools_git_timeout_seconds")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return GIT_TIMEOUT_SECONDS
    return min(max(1.0, float(value)), MAX_GIT_TIMEOUT_SECONDS)


def configure_git_tools(config: object | None) -> None:
    global _timeout_seconds  # noqa: PLW0603 - process-local tool setting.
    _timeout_seconds = _configured_git_timeout_seconds(config)


def git_timeout_seconds() -> float:
    return _timeout_seconds
