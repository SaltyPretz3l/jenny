"""GPU VRAM usage telemetry helpers for sidecar JSON-RPC methods."""

from __future__ import annotations

import logging
import subprocess
from datetime import datetime, timezone
from typing import Any

_LOGGER = logging.getLogger(__name__)

_VRAM_PROBE_TIMEOUT_SECONDS = 1.0
_NVIDIA_SMI_QUERY_ARGS = [
    "nvidia-smi",
    "--query-gpu=memory.used,memory.total,utilization.gpu",
    "--format=csv,noheader,nounits",
]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _unavailable_vram_usage(
    *,
    source: str = "nvidia-smi",
    gpu_type: str = "",
    sampled_at: str | None = None,
) -> dict[str, Any]:
    return {
        "available": False,
        "used_mb": 0,
        "total_mb": 0,
        "util_available": False,
        "util_percent": 0,
        "gpu_type": gpu_type,
        "source": source,
        "sampled_at": sampled_at or _utc_now_iso(),
    }


def _parse_nvidia_memory_csv(stdout: str) -> tuple[int, int, int | None] | None:
    lines = [line.strip() for line in str(stdout or "").splitlines() if line.strip()]
    if not lines:
        return None

    total_used = 0
    total_capacity = 0
    max_util_percent: int | None = None
    for line in lines:
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2:
            return None
        try:
            used_mb = int(float(parts[0]))
            total_mb = int(float(parts[1]))
        except ValueError:
            return None
        if len(parts) >= 3:
            try:
                util_percent = int(float(parts[2]))
            except (OverflowError, ValueError):
                pass
            else:
                max_util_percent = max(max_util_percent or 0, util_percent)
        if total_mb <= 0:
            continue
        total_used += max(used_mb, 0)
        total_capacity += total_mb

    if total_capacity <= 0:
        return None
    return total_used, total_capacity, max_util_percent


def _probe_nvidia_smi() -> dict[str, Any]:
    sampled_at = _utc_now_iso()
    try:
        proc = subprocess.run(
            _NVIDIA_SMI_QUERY_ARGS,
            capture_output=True,
            text=True,
            timeout=_VRAM_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except Exception as exc:
        # Expected when nvidia-smi is absent (non-NVIDIA / no driver); DEBUG so it
        # is diagnosable without spamming CPU/AMD machines. Still returns unavailable.
        _LOGGER.debug("nvidia-smi VRAM probe failed (%s): %s", type(exc).__name__, exc)
        return _unavailable_vram_usage(source="nvidia-smi", gpu_type="", sampled_at=sampled_at)

    if proc.returncode != 0:
        return _unavailable_vram_usage(source="nvidia-smi", gpu_type="", sampled_at=sampled_at)

    parsed = _parse_nvidia_memory_csv(proc.stdout)
    if parsed is None:
        return _unavailable_vram_usage(source="nvidia-smi", gpu_type="", sampled_at=sampled_at)

    used_mb, total_mb, util_percent = parsed
    clamped_used = max(min(used_mb, total_mb), 0)
    return {
        "available": True,
        "used_mb": clamped_used,
        "total_mb": total_mb,
        "util_available": util_percent is not None,
        "util_percent": max(min(util_percent or 0, 100), 0),
        "gpu_type": "cuda",
        "source": "nvidia-smi",
        "sampled_at": sampled_at,
    }


def get_vram_usage() -> dict[str, Any]:
    """Return best-effort VRAM usage payload for JSON-RPC transport."""
    payload = _probe_nvidia_smi()
    if payload.get("available") is True:
        return payload
    return _unavailable_vram_usage(
        source=str(payload.get("source") or "nvidia-smi"),
        gpu_type=str(payload.get("gpu_type") or ""),
        sampled_at=str(payload.get("sampled_at") or _utc_now_iso()),
    )


_NVIDIA_SMI_STATIC_ARGS = [
    "nvidia-smi",
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
]


def _parse_nvidia_static_csv(stdout: str) -> tuple[str, int] | None:
    """Parse the first GPU's ``name, memory.total`` row.

    Unlike :func:`_parse_nvidia_memory_csv` (which sums VRAM across GPUs for
    telemetry), this returns a single GPU's capacity — what matters for "which
    model fits on my GPU".
    """
    lines = [line.strip() for line in str(stdout or "").splitlines() if line.strip()]
    if not lines:
        return None
    parts = [part.strip() for part in lines[0].split(",")]
    if len(parts) < 2:
        return None
    name = parts[0]
    try:
        total_mb = int(float(parts[-1]))
    except ValueError:
        return None
    if total_mb <= 0:
        return None
    return name, total_mb


def get_gpu_static_info() -> dict[str, Any]:
    """Best-effort GPU name + total VRAM (MB) via nvidia-smi, with no torch.

    Used by the hardware profile to recover VRAM/name in packaged builds where
    torch is excluded.  Returns ``available: False`` when nvidia-smi is missing
    or reports no usable GPU.
    """
    sampled_at = _utc_now_iso()
    unavailable = {
        "available": False,
        "name": "",
        "total_mb": 0,
        "gpu_type": "",
        "source": "nvidia-smi",
        "sampled_at": sampled_at,
    }
    try:
        proc = subprocess.run(
            _NVIDIA_SMI_STATIC_ARGS,
            capture_output=True,
            text=True,
            timeout=_VRAM_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except Exception as exc:
        # Expected when nvidia-smi is absent (non-NVIDIA / no driver); DEBUG so it
        # is diagnosable without spamming CPU/AMD machines. Still returns unavailable.
        _LOGGER.debug("nvidia-smi static probe failed (%s): %s", type(exc).__name__, exc)
        return unavailable

    if proc.returncode != 0:
        return unavailable

    parsed = _parse_nvidia_static_csv(proc.stdout)
    if parsed is None:
        return unavailable

    name, total_mb = parsed
    return {
        "available": True,
        "name": name,
        "total_mb": total_mb,
        "gpu_type": "cuda",
        "source": "nvidia-smi",
        "sampled_at": sampled_at,
    }
