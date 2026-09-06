"""Process-local feature settings for shell tool handlers."""

from __future__ import annotations

_FEATURE_FLAGS: dict[str, bool] = {}


def configure_shell_security(flags: dict[str, bool]) -> None:
    """Inject feature flags for shell security and git tracking."""

    _FEATURE_FLAGS.update(flags)
