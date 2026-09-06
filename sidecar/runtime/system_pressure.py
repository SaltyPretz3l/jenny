"""Best-effort system pressure snapshots for runtime diagnostics."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:  # pragma: no cover - exercised through monkeypatched module in tests.
    import psutil  # type: ignore[import-not-found, import-untyped]
except Exception:  # pragma: no cover - fail-open when optional probe is unavailable.
    psutil = None  # type: ignore[assignment]

DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_MIN_FREE_RATIO = 0.08
SEVERE_MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024
DEFAULT_CPU_PRESSURE_PERCENT = 90.0
DEFAULT_MEMORY_PRESSURE_PERCENT = 90.0
DEFAULT_MEMORY_MIN_AVAILABLE_RATIO = 0.10


@dataclass(frozen=True)
class DiskPressureSnapshot:
    path: str
    total_bytes: int
    used_bytes: int
    free_bytes: int
    free_ratio: float
    pressured: bool
    reason: str = ""

    def to_payload(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "total_bytes": self.total_bytes,
            "used_bytes": self.used_bytes,
            "free_bytes": self.free_bytes,
            "free_ratio": round(self.free_ratio, 6),
            "pressured": self.pressured,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class CpuPressureSnapshot:
    percent: float | None
    pressured: bool
    reason: str = ""

    def to_payload(self) -> dict[str, Any]:
        return {
            "percent": None if self.percent is None else round(self.percent, 3),
            "pressured": self.pressured,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class MemoryPressureSnapshot:
    total_bytes: int
    used_bytes: int
    available_bytes: int
    percent: float | None
    available_ratio: float
    pressured: bool
    reason: str = ""

    def to_payload(self) -> dict[str, Any]:
        return {
            "total_bytes": self.total_bytes,
            "used_bytes": self.used_bytes,
            "available_bytes": self.available_bytes,
            "percent": None if self.percent is None else round(self.percent, 3),
            "available_ratio": round(self.available_ratio, 6),
            "pressured": self.pressured,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class SystemPressureSnapshot:
    disk: DiskPressureSnapshot
    cpu: CpuPressureSnapshot
    memory: MemoryPressureSnapshot
    warnings: tuple[str, ...] = ()

    @property
    def status(self) -> str:
        if self.warnings:
            return "pressured"
        if (
            self.disk.total_bytes <= 0
            and self.cpu.percent is None
            and self.memory.percent is None
        ):
            return "unknown"
        return "ok"

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "disk": self.disk.to_payload(),
            "cpu": self.cpu.to_payload(),
            "memory": self.memory.to_payload(),
            "warnings": list(self.warnings),
        }


def build_system_pressure_snapshot(  # noqa: PLR0913 - threshold knobs are explicit.
    *,
    root: str | Path | None,
    min_free_bytes: int = DEFAULT_MIN_FREE_BYTES,
    min_free_ratio: float = DEFAULT_MIN_FREE_RATIO,
    cpu_pressure_percent: float = DEFAULT_CPU_PRESSURE_PERCENT,
    memory_pressure_percent: float = DEFAULT_MEMORY_PRESSURE_PERCENT,
    memory_min_available_ratio: float = DEFAULT_MEMORY_MIN_AVAILABLE_RATIO,
) -> SystemPressureSnapshot:
    disk = _disk_pressure_snapshot(
        root=root,
        min_free_bytes=min_free_bytes,
        min_free_ratio=min_free_ratio,
    )
    cpu = _cpu_pressure_snapshot(cpu_pressure_percent=cpu_pressure_percent)
    memory = _memory_pressure_snapshot(
        memory_pressure_percent=memory_pressure_percent,
        memory_min_available_ratio=memory_min_available_ratio,
    )
    warnings = _pressure_warnings(disk.reason, cpu.reason, memory.reason)
    return SystemPressureSnapshot(disk=disk, cpu=cpu, memory=memory, warnings=warnings)


def _pressure_warnings(*reasons: str) -> tuple[str, ...]:
    return tuple(
        reason
        for reason in reasons
        if reason and (reason.endswith("_low") or reason.endswith("_high"))
    )


def _cpu_pressure_snapshot(*, cpu_pressure_percent: float) -> CpuPressureSnapshot:
    if psutil is None:
        return CpuPressureSnapshot(percent=None, pressured=False, reason="cpu_probe_unavailable")
    try:
        raw_percent = psutil.cpu_percent(interval=None)
    except Exception as error:  # noqa: BLE001
        return CpuPressureSnapshot(
            percent=None,
            pressured=False,
            reason=f"cpu_probe_unavailable:{type(error).__name__}",
        )
    try:
        percent = float(raw_percent)
    except (TypeError, ValueError):
        return CpuPressureSnapshot(percent=None, pressured=False, reason="cpu_probe_invalid")
    pressured = percent >= max(float(cpu_pressure_percent), 0.0)
    return CpuPressureSnapshot(
        percent=percent,
        pressured=pressured,
        reason="cpu_saturation_high" if pressured else "",
    )


def _memory_pressure_snapshot(
    *,
    memory_pressure_percent: float,
    memory_min_available_ratio: float,
) -> MemoryPressureSnapshot:
    if psutil is None:
        return MemoryPressureSnapshot(
            total_bytes=0,
            used_bytes=0,
            available_bytes=0,
            percent=None,
            available_ratio=0.0,
            pressured=False,
            reason="memory_probe_unavailable",
        )
    try:
        memory = psutil.virtual_memory()
    except Exception as error:  # noqa: BLE001
        return MemoryPressureSnapshot(
            total_bytes=0,
            used_bytes=0,
            available_bytes=0,
            percent=None,
            available_ratio=0.0,
            pressured=False,
            reason=f"memory_probe_unavailable:{type(error).__name__}",
        )
    total = max(int(getattr(memory, "total", 0) or 0), 0)
    available = max(int(getattr(memory, "available", 0) or 0), 0)
    used = max(int(getattr(memory, "used", total - available) or 0), 0)
    percent_value = getattr(memory, "percent", None)
    try:
        percent = None if percent_value is None else float(percent_value)
    except (TypeError, ValueError):
        percent = None
    available_ratio = (available / total) if total > 0 else 0.0
    threshold = max(float(memory_pressure_percent), 0.0)
    min_available_ratio = max(float(memory_min_available_ratio), 0.0)
    percent_pressure = percent is not None and percent >= threshold
    available_pressure = total > 0 and available_ratio <= min_available_ratio
    pressured = percent_pressure or available_pressure
    reason = "memory_available_low" if pressured else ""
    return MemoryPressureSnapshot(
        total_bytes=total,
        used_bytes=used,
        available_bytes=available,
        percent=percent,
        available_ratio=available_ratio,
        pressured=pressured,
        reason=reason,
    )


def _disk_pressure_snapshot(
    *,
    root: str | Path | None,
    min_free_bytes: int,
    min_free_ratio: float,
) -> DiskPressureSnapshot:
    target = _nearest_existing_path(root)
    try:
        usage = shutil.disk_usage(target)
    except OSError as error:
        return DiskPressureSnapshot(
            path=str(target),
            total_bytes=0,
            used_bytes=0,
            free_bytes=0,
            free_ratio=0.0,
            pressured=False,
            reason=f"disk_usage_unavailable:{type(error).__name__}",
        )
    total = max(int(usage.total), 0)
    free = max(int(usage.free), 0)
    used = max(int(usage.used), 0)
    free_ratio = (free / total) if total > 0 else 0.0
    bytes_low = free < max(int(min_free_bytes), 0)
    ratio_low = free_ratio < max(float(min_free_ratio), 0.0)
    pressured = bytes_low or ratio_low
    # The 10 GiB floor only grades an already-pressured disk (severe vs mild);
    # it must not widen what counts as pressured in the first place.
    severe = pressured and free < max(int(min_free_bytes), SEVERE_MIN_FREE_BYTES)
    reason = "disk_free_bytes_low" if severe else "disk_free_ratio_low" if pressured else ""
    return DiskPressureSnapshot(
        path=str(target),
        total_bytes=total,
        used_bytes=used,
        free_bytes=free,
        free_ratio=free_ratio,
        pressured=pressured,
        reason=reason,
    )


def _nearest_existing_path(root: str | Path | None) -> Path:
    candidate = Path(root).expanduser() if root else Path.home()
    try:
        candidate = candidate.resolve(strict=False)
    except OSError:
        pass
    while not candidate.exists() and candidate.parent != candidate:
        candidate = candidate.parent
    return candidate if candidate.exists() else Path.home()
