from __future__ import annotations

from typing import Any


class BoolArgumentError(ValueError):
    def __init__(self, key: str) -> None:
        super().__init__(f"tool argument '{key}' must be a boolean")
        self.key = key


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def bounded_int(
    value: object,
    *,
    default: int,
    minimum: int = 0,
    maximum: int,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    if value < minimum:
        return default
    return min(value, maximum)


def extract_bool_argument(
    arguments: dict[str, object],
    key: str,
    *,
    default: bool = False,
) -> bool:
    value = arguments.get(key, default)
    if isinstance(value, bool):
        return value
    raise BoolArgumentError(key)
