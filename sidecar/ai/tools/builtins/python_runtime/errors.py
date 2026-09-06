"""Typed failures for the managed Python runtime.

Split out of ``interpreter`` so the pip-bootstrap module can raise them
without importing the interpreter module back (a cycle). ``interpreter``
re-exports every name here, so ``interpreter.PythonRuntimeError`` and friends
keep resolving to these exact classes.
"""

from __future__ import annotations


class PythonRuntimeError(RuntimeError):
    """Base class for typed managed Python runtime failures."""

    def __init__(
        self,
        *args: object,
        failed_phase: str | None = None,
        remediation: str | None = None,
    ) -> None:
        super().__init__(*args)
        self.failed_phase = failed_phase
        self.remediation = remediation


class PythonRuntimeWheelhouseIntegrityError(PythonRuntimeError):
    """Raised when the offline wheelhouse fails checksum/content verification.

    Callers must fail closed on this error: never fall back to a network
    install when a wheelhouse is present but untrustworthy.
    """


class PythonRuntimeOfflineInstallError(PythonRuntimeError):
    """Raised when no offline wheelhouse is available and installing the
    managed runtime's packages over the network also failed or was
    unavailable."""
