"""Resource-pressure helpers for tool execution."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.feature_flags import is_resource_discipline_enabled
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.system_pressure import build_system_pressure_snapshot

logger = logging.getLogger(__name__)

DEFAULT_WARNING_BACKOFF_SECONDS = 0.1
DEFAULT_SEVERE_BACKOFF_SECONDS = 0.25
_SEVERE_WARNING_REASONS = frozenset(
    {
        "disk_free_space_low",
        "disk_free_bytes_low",
        "memory_available_low",
    }
)
_MILD_WARNING_REASONS = frozenset({"disk_free_ratio_low"})
_MILD_REASON_MEMO_ATTR = "_resource_pressure_mild_reasons_logged"


@dataclass(frozen=True)
class ResourcePressureDecision:
    status: str
    severity: str
    warnings: tuple[str, ...]
    snapshot: dict[str, Any]

    @property
    def pressured(self) -> bool:
        return self.status == "pressured"


@dataclass(frozen=True)
class PressureBackoffDecision:
    should_backoff: bool
    delay_seconds: float
    severity: str
    warnings: tuple[str, ...]
    snapshot: dict[str, Any]


def resource_discipline_enabled(config: Any | None) -> bool:
    flags = getattr(config, "feature_flags", {}) if config is not None else {}
    return is_resource_discipline_enabled(flags)


def build_resource_pressure_decision(
    *,
    config: Any | None,
    root: str | Path | None = None,
) -> ResourcePressureDecision:
    if not resource_discipline_enabled(config):
        return ResourcePressureDecision(
            status="disabled",
            severity="none",
            warnings=(),
            snapshot={"status": "disabled"},
        )
    snapshot = build_system_pressure_snapshot(root=root)
    payload = snapshot.to_payload()
    warnings = tuple(str(item) for item in payload.get("warnings", []) if str(item))
    severity = _pressure_severity(warnings)
    return ResourcePressureDecision(
        status=str(payload.get("status") or "unknown"),
        severity=severity,
        warnings=warnings,
        snapshot=payload,
    )


def _pressure_severity(warnings: tuple[str, ...]) -> str:
    if not warnings:
        return "none"
    if any(reason in _SEVERE_WARNING_REASONS for reason in warnings):
        return "severe"
    if all(reason in _MILD_WARNING_REASONS for reason in warnings):
        return "mild"
    return "warning"


def build_tool_pressure_backoff_decision(
    *,
    config: Any | None,
    root: str | Path | None = None,
) -> PressureBackoffDecision:
    pressure = build_resource_pressure_decision(config=config, root=root)
    if not pressure.pressured:
        return PressureBackoffDecision(
            should_backoff=False,
            delay_seconds=0.0,
            severity=pressure.severity,
            warnings=pressure.warnings,
            snapshot=pressure.snapshot,
        )
    if pressure.severity == "mild":
        return PressureBackoffDecision(
            should_backoff=False,
            delay_seconds=0.0,
            severity=pressure.severity,
            warnings=pressure.warnings,
            snapshot=pressure.snapshot,
        )
    delay = (
        DEFAULT_SEVERE_BACKOFF_SECONDS
        if pressure.severity == "severe"
        else DEFAULT_WARNING_BACKOFF_SECONDS
    )
    return PressureBackoffDecision(
        should_backoff=True,
        delay_seconds=delay,
        severity=pressure.severity,
        warnings=pressure.warnings,
        snapshot=pressure.snapshot,
    )


def apply_tool_pressure_backoff(  # noqa: PLR0913
    *,
    tool_name: str,
    request_id: str,
    session_id: str | None,
    runtime: Any | None,
    decision: PressureBackoffDecision,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    if not decision.should_backoff:
        _log_mild_pressure_once(
            request_id=request_id,
            session_id=session_id,
            runtime=runtime,
            decision=decision,
        )
        return
    if runtime is not None:
        runtime.raise_if_cancelled()
        runtime.audit(
            "tool_pressure_backoff",
            tool_name=str(tool_name or ""),
            summary=f"tool_pressure_backoff {tool_name}",
        )
    log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.tool_pressure_backoff",
        message=f"Delaying tool execution under resource pressure: {tool_name}",
        status="warn",
        data={
            "tool": str(tool_name or ""),
            "severity": decision.severity,
            "warnings": list(decision.warnings),
            "delay_seconds": decision.delay_seconds,
            "system_pressure": decision.snapshot,
        },
        request_id=request_id,
        session_id=session_id,
    )
    sleep(max(float(decision.delay_seconds), 0.0))
    if runtime is not None:
        runtime.raise_if_cancelled()


def _log_mild_pressure_once(
    *,
    request_id: str,
    session_id: str | None,
    runtime: Any | None,
    decision: PressureBackoffDecision,
) -> None:
    mild_reasons = tuple(
        reason for reason in decision.warnings if reason in _MILD_WARNING_REASONS
    )
    if not mild_reasons:
        return
    if runtime is not None:
        logged_reasons = set(getattr(runtime, _MILD_REASON_MEMO_ATTR, ()))
        if logged_reasons.issuperset(mild_reasons):
            return
        setattr(runtime, _MILD_REASON_MEMO_ATTR, logged_reasons.union(mild_reasons))
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.disk_pressure_mild",
        message="Disk free-space ratio is low; absolute free space remains adequate",
        status="info",
        data={
            "severity": decision.severity,
            "warnings": list(decision.warnings),
            "system_pressure": decision.snapshot,
        },
        request_id=request_id,
        session_id=session_id,
    )
