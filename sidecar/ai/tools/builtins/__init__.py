"""Builtin tools package."""

from typing import Any

# Re-exported lazily. Importing python_runtime eagerly here pulled ctypes and
# the whole interpreter module into every consumer of this package -- including
# the builtin-tools subprocess the sidecar blocks on during `initialize` -- even
# though python_execute is off by default and its handler is bound behind a flag.
__all__ = [
    "configure_python_runtime",
    "python_execute_tool",
]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from sidecar.ai.tools.builtins import python_runtime  # noqa: PLC0415

        return getattr(python_runtime, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(__all__)
