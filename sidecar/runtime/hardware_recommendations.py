"""Hardware-aware ranking helpers for the local-model catalog.

Discovery stays in :mod:`hardware_profile`; this module owns the policy that
turns normalized fit records into one deterministic recommendation.
"""

from __future__ import annotations

import math
import re
from dataclasses import replace
from typing import Any

MAX_MODEL_SIZE_MB = 2_147_483_647


def disk_required_mb(download_size_mb: Any) -> int:
    """Return download size plus bounded unpack/cache headroom."""
    try:
        if isinstance(download_size_mb, int):
            size = min(max(download_size_mb, 0), MAX_MODEL_SIZE_MB)
        else:
            parsed = float(download_size_mb or 0)
            size = (
                min(max(int(parsed), 0), MAX_MODEL_SIZE_MB)
                if math.isfinite(parsed)
                else 0
            )
    except (TypeError, ValueError, OverflowError):
        size = 0
    if size == 0:
        return 0
    return min(size + max(2000, math.ceil(size * 0.10)), MAX_MODEL_SIZE_MB)


def _params_to_billions(value: Any) -> float:
    match = re.search(r"(\d+(?:\.\d+)?)", str(value or ""))
    if not match:
        return 0.0
    try:
        parsed = float(match.group(1))
        return parsed if math.isfinite(parsed) else 0.0
    except (TypeError, ValueError, OverflowError):
        return 0.0


def rank_model_recommendations(
    recommendations: list[Any],
    *,
    gpu_name: str,
    vram_mb: int,
    unified_budget_mb: int,
    available_ram_mb: int,
) -> list[Any]:
    """Rank accelerator fits first, preferring curated entries within each fit bucket."""
    if not recommendations:
        return recommendations

    # Sort by accelerator/VRAM fit, CPU fit, preferred, params, then quant.
    recommendations.sort(
        key=lambda rec: (
            bool(rec.fits_in_vram or rec.fits_in_accelerator),
            bool(rec.fits_on_cpu),
            bool(rec.preferred),
            _params_to_billions(rec.params),
            rec.quant,
        ),
        reverse=True,
    )
    pick_index = next((i for i, rec in enumerate(recommendations) if rec.fits), None)
    if pick_index is None:
        pick_index = min(
            range(len(recommendations)),
            key=lambda i: _params_to_billions(recommendations[i].params),
        )

    chosen = recommendations[pick_index]
    if chosen.fits_in_accelerator:
        label = gpu_name or "accelerator"
        reason = (
            f"Best fit for your {label} "
            f"({round(unified_budget_mb / 1024)}GB unified-memory model budget)."
        )
    elif chosen.fits_in_vram:
        label = gpu_name or "GPU"
        reason = f"Best fit for your {label} ({round(vram_mb / 1024)}GB VRAM)."
    elif chosen.fits_on_cpu:
        ram_gb = round(max(available_ram_mb, 0) / 1024)
        reason = (
            f"Strongest catalog model that fits {ram_gb}GB of available RAM. "
            "CPU inference will be slower."
        )
    else:
        reason = "Closest match, but may exceed your memory — expect slow performance."
    recommendations[pick_index] = replace(chosen, recommended=True, reason=reason)
    return recommendations
