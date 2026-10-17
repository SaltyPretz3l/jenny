"""Closed outcome reading for ``command.execute_proposal``.

``command_outcome`` is what the application records on the proposal:
``{schema_version, status, exit_code, cleanup}``. Approval denial and policy blocks
are ``denied`` (never a subprocess failure); ``cancelled`` is reported only after
owned-process cleanup is proven, otherwise ``interrupted_unknown`` with cleanup
``uncertain``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from sidecar.ai.error_codes import (
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_COMMAND_ABORTED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_DISABLED,
    CMP_TOOL_PAUSED_UNATTENDED,
    CMP_TOOL_POLICY_DENIED,
)

STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"
STATUS_DENIED = "denied"
STATUS_CANCELLED = "cancelled"
STATUS_UNKNOWN = "interrupted_unknown"
_DENIED_CODES = frozenset(
    {
        CMP_TOOL_COMMAND_BLOCKED,
        CMP_TOOL_POLICY_DENIED,
        CMP_TOOL_DISABLED,
        CMP_MODE_TOOL_BLOCKED,
        CMP_TOOL_PAUSED_UNATTENDED,
    }
)
_DENIED_FLAGS = ("pre_dispatch_blocked", "policy_denied", "host_policy_denied", "hard_blocked")
_DENIED_SANDBOX_REASONS = frozenset(
    {
        "sandbox_approval_denied",
        "sandbox_policy_denied",
        "sandbox_read_only",
    }
)
_TIMEOUT_STATUSES = frozenset({"timeout", "timed_out"})


@dataclass(slots=True)
class CleanupProbe:
    """What the tool-resource lease recorded when the call settled."""

    status: str | None = None
    cleanup: str | None = None


class _ProbedLease:
    """Delegating resource lease that records the settled status and cleanup."""

    def __init__(self, lease: Any, probe: CleanupProbe) -> None:
        self._lease, self._probe = lease, probe

    def settle(self, status: str, cleanup: str) -> Any:
        result = self._lease.settle(status, cleanup)
        self._probe.status, self._probe.cleanup = status, cleanup
        return result

    def __getattr__(self, name: str) -> Any:
        return getattr(self._lease, name)


def probed_admission(admit: Any, probe: CleanupProbe) -> Any:
    """Wrap an operation-admission callback so its leases report to ``probe``."""
    acquire = getattr(admit, "acquire_resource", None)
    if not callable(admit) or not callable(acquire):
        return admit

    def _admit(**kwargs: Any) -> Any:
        return admit(**kwargs)

    _admit.acquire_resource = (  # type: ignore[attr-defined]
        lambda **kwargs: _ProbedLease(acquire(**kwargs), probe)
    )
    return _admit


@dataclass(frozen=True, slots=True)
class CommandOutcome:
    status: str
    exit_code: int | None
    cleanup: str | None

    def to_wire(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "status": self.status,
            "exit_code": self.exit_code,
            "cleanup": self.cleanup,
        }

    @property
    def completed_command(self) -> bool:
        return self.status in {STATUS_SUCCEEDED, STATUS_FAILED}


def denied_outcome() -> CommandOutcome:
    return CommandOutcome(STATUS_DENIED, None, None)


def unknown_outcome() -> CommandOutcome:
    return CommandOutcome(STATUS_UNKNOWN, None, "uncertain")


def _integer(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _cleanup_value(value: Any) -> str | None:
    return value if value in {"confirmed", "uncertain"} else None


def _cleanup(
    metadata: Mapping[str, Any], execution: Mapping[str, Any], probe: CleanupProbe
) -> str | None:
    if probe.cleanup in {"confirmed", "uncertain"}:
        return probe.cleanup
    evidence = metadata.get("resource_cleanup")
    if isinstance(evidence, Mapping) and _cleanup_value(evidence.get("cleanup")):
        return str(evidence["cleanup"])
    flag = execution.get("cleanup_confirmed")
    if isinstance(flag, bool):
        return "confirmed" if flag else "uncertain"
    return None


def classify_outcome(  # noqa: PLR0911 - one verdict per closed outcome class.
    outcome: Any,
    *,
    expected_exit_codes: tuple[int, ...],
    probe: CleanupProbe,
) -> CommandOutcome:
    """Read one finished ``run_command`` outcome (builtin or Electron/Docker)."""
    metadata = outcome.metadata if isinstance(outcome.metadata, Mapping) else {}
    raw_execution = metadata.get("execution")
    execution: Mapping[str, Any] = raw_execution if isinstance(raw_execution, Mapping) else {}
    code = str(outcome.error_code or "")
    cleanup = _cleanup(metadata, execution, probe)
    exit_code = _integer(metadata.get("exit_code"))
    if exit_code is None:
        exit_code = _integer(execution.get("exit_code"))
    cancelled = (
        code == CMP_TOOL_COMMAND_ABORTED
        or execution.get("status") == "cancelled"
        or probe.status == "cancelled"
    )
    if cancelled:
        if cleanup == "confirmed":
            return CommandOutcome(STATUS_CANCELLED, exit_code, "confirmed")
        return CommandOutcome(STATUS_UNKNOWN, exit_code, "uncertain")
    timed_out = metadata.get("timed_out") is True or execution.get("status") in _TIMEOUT_STATUSES
    if timed_out:
        if cleanup == "confirmed":
            return CommandOutcome(STATUS_FAILED, exit_code, "confirmed")
        return CommandOutcome(STATUS_UNKNOWN, exit_code, "uncertain")
    ran = exit_code is not None or bool(execution.get("job_id"))
    denied = not ran and (
        code in _DENIED_CODES
        or any(metadata.get(flag) is True for flag in _DENIED_FLAGS)
        or execution.get("reason") in _DENIED_SANDBOX_REASONS
    )
    if denied:
        return denied_outcome()
    if exit_code is not None:
        status = STATUS_SUCCEEDED if exit_code in expected_exit_codes else STATUS_FAILED
        return CommandOutcome(status, exit_code, cleanup)
    return CommandOutcome(STATUS_SUCCEEDED if outcome.success else STATUS_FAILED, None, cleanup)


def fallback_text(outcome: CommandOutcome) -> str:
    """Fallback ``response_text``; Electron authors the visible completion line."""
    if outcome.status == STATUS_SUCCEEDED:
        return (
            f"Command finished (exit {outcome.exit_code})."
            if outcome.exit_code is not None
            else "Command finished."
        )
    if outcome.status == STATUS_FAILED:
        return (
            f"Command failed (exit {outcome.exit_code})."
            if outcome.exit_code is not None
            else "Command failed."
        )
    if outcome.status == STATUS_DENIED:
        return "Command was denied. Nothing ran."
    if outcome.status == STATUS_CANCELLED:
        return "Command was cancelled."
    return "Command outcome unknown."


__all__ = [
    "CleanupProbe",
    "CommandOutcome",
    "STATUS_CANCELLED",
    "STATUS_DENIED",
    "STATUS_FAILED",
    "STATUS_SUCCEEDED",
    "STATUS_UNKNOWN",
    "classify_outcome",
    "denied_outcome",
    "fallback_text",
    "probed_admission",
    "unknown_outcome",
]
