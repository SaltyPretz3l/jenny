from __future__ import annotations

import math
from typing import Any


def coerce_optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return None


def coerce_non_negative_int(value: Any) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(parsed, 0)


def coerce_positive_finite_float(value: Any) -> float:
    if isinstance(value, bool):
        return 0
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0
    return parsed if math.isfinite(parsed) and parsed > 0 else 0
