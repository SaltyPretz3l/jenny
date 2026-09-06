"""Typed exception hierarchy for Companion sidecar."""


class CompanionError(Exception):
    """Base class for all Companion errors."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        preserved: bool | None = None,
    ):
        self.code = code
        self.message = message
        self.retryable = retryable
        self.preserved = preserved
        super().__init__(f"[{code}] {message}")


class MemoryStoreError(CompanionError):
    """Raised by memory subsystem components."""
