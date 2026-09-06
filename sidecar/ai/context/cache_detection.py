"""Prompt-cache break detection for cache-aware routing."""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass
from time import time
from typing import Any

from sidecar.ai.context.prompt_cache import StructuredSystemPrompt


def stable_hash(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PromptSnapshot:
    system_hash: str
    tools_hash: str
    per_tool_hashes: dict[str, str]
    call_count: int
    timestamp: float


@dataclass(frozen=True)
class CacheBreakResult:
    detected: bool
    reason: str
    changed_categories: tuple[str, ...]


@dataclass
class _DetectorState:
    current_snapshot: PromptSnapshot | None = None
    previous_snapshot: PromptSnapshot | None = None
    previous_cache_read_tokens: int | None = None
    baseline_reset_reason: str | None = None


CACHE_TTL_5MIN_SECONDS = 5 * 60
CACHE_TTL_1HOUR_SECONDS = 60 * 60


def _normalize_system_prompt(value: Any) -> Any:
    if isinstance(value, StructuredSystemPrompt):
        return {
            "session_start_date": value.session_start_date,
            "current_date": value.current_date,
            "sections": [
                {
                    "name": section.name,
                    "content": section.content,
                    "cacheable": section.cacheable,
                }
                for section in value.sections
            ],
        }
    return str(value or "")


class CacheBreakDetector:
    """Detect large prompt-cache read regressions across sequential model calls."""

    def __init__(self, max_entries: int = 10) -> None:
        self._max_entries = max(1, int(max_entries))
        self._states: OrderedDict[str, _DetectorState] = OrderedDict()
        self._lock = threading.RLock()

    def record_prompt_state(
        self,
        source_key: str,
        system_prompt: Any,
        tool_schemas: list[dict[str, Any]],
    ) -> None:
        key = str(source_key or "").strip()
        if not key:
            return
        per_tool_hashes = {
            str(tool.get("name") or "").strip(): stable_hash(tool)
            for tool in tool_schemas
            if isinstance(tool, dict) and str(tool.get("name") or "").strip()
        }
        with self._lock:
            state = self._states.pop(key, _DetectorState())
            call_count = (
                state.current_snapshot.call_count if state.current_snapshot is not None else 0
            ) + 1
            state.previous_snapshot = state.current_snapshot
            state.current_snapshot = PromptSnapshot(
                system_hash=stable_hash(_normalize_system_prompt(system_prompt)),
                tools_hash=stable_hash(tool_schemas),
                per_tool_hashes=per_tool_hashes,
                call_count=call_count,
                timestamp=time(),
            )
            self._states[key] = state
            while len(self._states) > self._max_entries:
                self._states.popitem(last=False)

    def reset_baseline(self, source_key: str, *, reason: str) -> None:
        key = str(source_key or "").strip()
        if not key:
            return
        with self._lock:
            state = self._states.get(key)
            if state is None:
                return
            state.previous_cache_read_tokens = None
            state.baseline_reset_reason = str(reason or "").strip() or "manual_reset"

    def check_response_for_cache_break(
        self,
        source_key: str,
        cache_read_tokens: int,
    ) -> CacheBreakResult:
        key = str(source_key or "").strip()
        with self._lock:
            state = self._states.get(key)
            if state is None:
                return CacheBreakResult(
                    detected=False,
                    reason="missing_prompt_state",
                    changed_categories=(),
                )

            current_cache_read = max(int(cache_read_tokens or 0), 0)
            previous_cache_read = state.previous_cache_read_tokens
            state.previous_cache_read_tokens = current_cache_read
            baseline_reset_reason = state.baseline_reset_reason
            state.baseline_reset_reason = None
            previous_snapshot = state.previous_snapshot
            current_snapshot = state.current_snapshot
        if baseline_reset_reason is not None:
            return CacheBreakResult(
                detected=False,
                reason=f"baseline_reset:{baseline_reset_reason}",
                changed_categories=(),
            )
        if previous_cache_read is None or previous_cache_read <= 0:
            return CacheBreakResult(
                detected=False,
                reason="insufficient_history",
                changed_categories=(),
            )

        token_drop = previous_cache_read - current_cache_read
        if current_cache_read >= previous_cache_read * 0.95 or token_drop < 2000:
            return CacheBreakResult(
                detected=False,
                reason="within_threshold",
                changed_categories=(),
            )

        changed: list[str] = []
        if previous_snapshot is not None and current_snapshot is not None:
            elapsed = max(current_snapshot.timestamp - previous_snapshot.timestamp, 0.0)
            if elapsed >= CACHE_TTL_1HOUR_SECONDS:
                return CacheBreakResult(
                    detected=False,
                    reason="ttl_window_1h",
                    changed_categories=(),
                )
            if elapsed >= CACHE_TTL_5MIN_SECONDS:
                return CacheBreakResult(
                    detected=False,
                    reason="ttl_window_5m",
                    changed_categories=(),
                )
            if previous_snapshot.system_hash != current_snapshot.system_hash:
                changed.append("system_prompt")
            if previous_snapshot.tools_hash != current_snapshot.tools_hash:
                all_tool_names = sorted(
                    set(previous_snapshot.per_tool_hashes) | set(current_snapshot.per_tool_hashes)
                )
                for tool_name in all_tool_names:
                    if previous_snapshot.per_tool_hashes.get(
                        tool_name
                    ) != current_snapshot.per_tool_hashes.get(tool_name):
                        changed.append(tool_name)
                if not changed or changed == ["system_prompt"]:
                    changed.append("tools")

        return CacheBreakResult(
            detected=True,
            reason="cache_read_drop" if changed else "cache_read_drop_unattributed",
            changed_categories=tuple(changed),
        )
