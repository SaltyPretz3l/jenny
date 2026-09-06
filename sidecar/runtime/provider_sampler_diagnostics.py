"""Allowlisted provider sampler projection for turn diagnostics."""

from __future__ import annotations

import math
from typing import Any, Mapping

PROVIDER_SAMPLER_FIELDS = (
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "presence_penalty",
    "repeat_penalty",
)


def provider_sampler_diagnostics_payload(
    value: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Return bounded scalar sampler fields, or no diagnostic when uncaptured."""

    if not isinstance(value, Mapping):
        return {}
    sampler: dict[str, int | float | None] = {}
    present: list[str] = []
    for field in PROVIDER_SAMPLER_FIELDS:
        raw = value.get(field)
        normalized: int | float | None = None
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            numeric = float(raw)
            if math.isfinite(numeric):
                normalized = int(raw) if field == "top_k" and numeric.is_integer() else numeric
                present.append(field)
        sampler[field] = normalized
    return {
        "provider_sampler": sampler,
        "provider_sampler_present_keys": present,
    }
