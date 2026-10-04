"""Process-local feature settings for shell tool handlers."""

from __future__ import annotations

_FEATURE_FLAGS: dict[str, bool] = {}


def configure_shell_security(flags: dict[str, bool]) -> None:
    """Inject feature flags for shell security and git tracking.

    Replaces, never merges: a flag dropped from a config refresh must fall back
    to its default rather than keep the value an earlier config set. The dict
    object is mutated in place because ``shell`` imports it by reference.
    """

    _FEATURE_FLAGS.clear()
    _FEATURE_FLAGS.update(flags)
