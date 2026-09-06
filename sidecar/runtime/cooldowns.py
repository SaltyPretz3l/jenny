"""Small in-memory cooldown registry for transient runtime backoff."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class CooldownStatus:
    namespace: str
    name: str
    active: bool
    remaining_seconds: float = 0.0
    reason: str = ""


@dataclass(frozen=True)
class _CooldownEntry:
    until_seconds: float
    reason: str


class CooldownRegistry:
    """Track provider/tool/MCP cooldowns without binding callers to one policy."""

    def __init__(self, *, clock: Callable[[], float] | None = None) -> None:
        self._clock = clock or time.monotonic
        self._entries: dict[tuple[str, str], _CooldownEntry] = {}

    def mark(
        self,
        namespace: str,
        name: str,
        *,
        duration_seconds: float,
        reason: str = "",
    ) -> None:
        normalized_namespace = _normalize_token(namespace)
        normalized_name = _normalize_token(name)
        if not normalized_namespace or not normalized_name:
            return
        duration = max(float(duration_seconds or 0.0), 0.0)
        if duration <= 0.0:
            self.clear(normalized_namespace, normalized_name)
            return
        self._entries[(normalized_namespace, normalized_name)] = _CooldownEntry(
            until_seconds=self._clock() + duration,
            reason=str(reason or "").strip(),
        )

    def clear(self, namespace: str, name: str) -> None:
        self._entries.pop((_normalize_token(namespace), _normalize_token(name)), None)

    def clear_namespace(self, namespace: str) -> None:
        normalized_namespace = _normalize_token(namespace)
        for key_namespace, key_name in list(self._entries):
            if key_namespace == normalized_namespace:
                self._entries.pop((key_namespace, key_name), None)

    def status(self, namespace: str, name: str) -> CooldownStatus:
        normalized_namespace = _normalize_token(namespace)
        normalized_name = _normalize_token(name)
        entry = self._entries.get((normalized_namespace, normalized_name))
        if entry is None:
            return CooldownStatus(
                namespace=normalized_namespace,
                name=normalized_name,
                active=False,
            )
        remaining = max(entry.until_seconds - self._clock(), 0.0)
        if remaining <= 0.0:
            self._entries.pop((normalized_namespace, normalized_name), None)
            return CooldownStatus(
                namespace=normalized_namespace,
                name=normalized_name,
                active=False,
            )
        return CooldownStatus(
            namespace=normalized_namespace,
            name=normalized_name,
            active=True,
            remaining_seconds=round(remaining, 3),
            reason=entry.reason,
        )

    def snapshot(self, *, namespace: str | None = None) -> tuple[CooldownStatus, ...]:
        normalized_namespace = _normalize_token(namespace) if namespace is not None else None
        statuses: list[CooldownStatus] = []
        for key in list(self._entries):
            key_namespace, key_name = key
            if normalized_namespace is not None and key_namespace != normalized_namespace:
                continue
            status = self.status(key_namespace, key_name)
            if status.active:
                statuses.append(status)
        return tuple(sorted(statuses, key=lambda item: (item.namespace, item.name)))


def _normalize_token(value: object) -> str:
    return str(value or "").strip().lower()
