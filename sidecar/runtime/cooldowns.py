"""Small in-memory cooldown registry for transient runtime backoff."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any, Callable


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
    expires_at_ms: int | None = None


class CooldownRegistry:
    """Track provider/tool/MCP cooldowns without binding callers to one policy."""

    def __init__(self, *, clock: Callable[[], float] | None = None,
                 wall_clock: Callable[[], float] | None = None) -> None:
        self._clock = clock or time.monotonic
        self._wall_clock = wall_clock or time.time
        self._quota_last_wall_ms: int | None = None
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
            expires_at_ms=(self._quota_wall_now() + math.ceil(duration * 1000)
                           if normalized_namespace == "tool_quota" else None),
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


    def _quota_wall_now(self) -> int:
        value = _wall_ms(self._wall_clock())
        if self._quota_last_wall_ms is not None and value < self._quota_last_wall_ms:
            raise ValueError("quota_cooldown_clock_moved_backwards")
        self._quota_last_wall_ms = value
        return value

    def export_tool_quota(self) -> dict[str, Any]:
        """Persist only the request-owned quota namespace, never provider/MCP timers."""
        captured = self._quota_wall_now()
        entries = []
        for (namespace, name), entry in list(self._entries.items()):
            if namespace != "tool_quota":
                continue
            if entry.until_seconds <= self._clock():
                self.clear(namespace, name)
                continue
            if entry.expires_at_ms is None:
                raise ValueError("quota_cooldown_expiry_unavailable")
            if entry.expires_at_ms > captured:
                entries.append({"name": name, "expires_at_ms": entry.expires_at_ms,
                                "reason": entry.reason})
        return normalize_tool_quota_cooldowns({"schema_version": 1, "namespace": "tool_quota",
            "captured_at_ms": captured, "entries": sorted(entries, key=lambda item: item["name"])})

    def restore_tool_quota(self, value: Any) -> None:
        snapshot = normalize_tool_quota_cooldowns(value)
        now = self._quota_wall_now()
        if now < snapshot["captured_at_ms"]:
            raise ValueError("quota_cooldown_clock_moved_backwards")
        entries = {}
        monotonic = self._clock()
        if not math.isfinite(monotonic):
            raise ValueError("quota_cooldown_clock_invalid")
        for item in snapshot["entries"]:
            remaining_ms = item["expires_at_ms"] - now
            if remaining_ms > 0:
                entries[("tool_quota", item["name"])] = _CooldownEntry(
                    until_seconds=monotonic + remaining_ms / 1000,
                    reason=item["reason"], expires_at_ms=item["expires_at_ms"])
        self.clear_namespace("tool_quota")
        self._entries.update(entries)


_MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
_MAX_COOLDOWNS = 2000
_MAX_COOLDOWN_NAME = 256
_MAX_SAFE_INTEGER = 9007199254740991


def _wall_ms(value: float) -> int:
    if not math.isfinite(value) or not 0 <= value * 1000 <= _MAX_SAFE_INTEGER:
        raise ValueError("quota_cooldown_clock_invalid")
    return math.floor(value * 1000)


def normalize_tool_quota_cooldowns(value: Any) -> dict[str, Any]:
    if (not isinstance(value, dict) or set(value) != {
            "schema_version", "namespace", "captured_at_ms", "entries"}
            or type(value["schema_version"]) is not int or value["schema_version"] != 1
            or value["namespace"] != "tool_quota"
            or type(value["captured_at_ms"]) is not int
            or not 0 <= value["captured_at_ms"] <= _MAX_SAFE_INTEGER
            or not isinstance(value["entries"], list) or len(value["entries"]) > _MAX_COOLDOWNS):
        raise ValueError("quota_cooldown_snapshot_invalid")
    entries = []
    for item in value["entries"]:
        if (not isinstance(item, dict) or set(item) != {"name", "expires_at_ms", "reason"}
                or not isinstance(item["name"], str)
                or not 1 <= len(item["name"]) <= _MAX_COOLDOWN_NAME
                or _normalize_token(item["name"]) != item["name"]
                or type(item["expires_at_ms"]) is not int
                or not 0 < item["expires_at_ms"] - value["captured_at_ms"] <= _MAX_COOLDOWN_MS
                or item["expires_at_ms"] > _MAX_SAFE_INTEGER
                or item["reason"] not in {
                    "web_per_turn", "code_intelligence_per_turn", "session_tool_budget"}):
            raise ValueError("quota_cooldown_entry_invalid")
        entries.append(dict(item))
    if len({item["name"] for item in entries}) != len(entries):
        raise ValueError("quota_cooldown_duplicate")
    return {**value, "entries": sorted(entries, key=lambda item: item["name"])}


def _normalize_token(value: object) -> str:
    return str(value or "").strip().lower()
