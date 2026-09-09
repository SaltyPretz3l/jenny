"""Offline command worker package.

The package deliberately has no application imports: the worker is a small,
stdlib-only PID-1 process that is safe to copy into a restricted image.
"""

from .protocol import PROTOCOL_VERSION

__all__ = ["PROTOCOL_VERSION"]
