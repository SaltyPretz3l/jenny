"""Polling, wait, and terminal-status-dir pruning surface for MonitorManager."""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.monitor_manager_shared import (
    MAX_MONITOR_TIMEOUT_MS,
    _ActiveMonitor,
    _canonical_monitor_id,
)
from sidecar.runtime.monitor_status import MonitorStatusError, MonitorStatusStore

logger = logging.getLogger(__name__)


class _MonitorPollingMixin:
    # Host state owned by ``MonitorManager.__init__`` (the hub). These bare
    # annotations have zero runtime effect; they only tell mypy the concrete
    # instance will carry these attributes, since the mixin is type-checked
    # independently of the hub that assigns them.
    _active: dict[str, _ActiveMonitor]
    _active_lock: threading.Lock
    _status_store: MonitorStatusStore

    if TYPE_CHECKING:
        # Implemented on the sibling streaming mixin. TYPE_CHECKING is False at
        # runtime, so this stub never executes and cannot shadow the real
        # implementation resolved through the MRO.
        def _read_status(self, monitor_id: str) -> dict[str, object] | None: ...

    def poll_monitor(
        self,
        monitor_id: str,
        *,
        since_sequence: Any = 0,
        wait_ms: Any = 0,
    ) -> dict[str, object]:
        """Return a gated, incremental digest of monitor events past *since_sequence*.

        Serves still-running monitors from in-memory state and terminated ones from
        the persisted status record. ``wait_ms`` optionally blocks (up to the timeout
        ceiling) for new events or terminal state; default 0 returns immediately.
        """
        mid = _canonical_monitor_id(monitor_id)
        since = self._coerce_non_negative_int(since_sequence)
        wait_seconds = min(
            self._coerce_non_negative_int(wait_ms) / 1000.0,
            MAX_MONITOR_TIMEOUT_MS / 1000.0,
        )
        active = self._active.get(mid)
        if active is None:
            return self._poll_terminal_digest(mid, since)
        deadline = time.monotonic() + wait_seconds
        while True:
            with active.lock:
                digest = self._build_poll_digest_locked(active, since)
            if digest["new_event_count"] or digest["terminal"]:
                return digest
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return digest
            active.terminal_event.wait(timeout=min(0.05, remaining))

    @staticmethod
    def _coerce_non_negative_int(value: Any) -> int:
        if isinstance(value, bool) or value is None:
            return 0
        try:
            number = int(value)
        except (TypeError, ValueError):
            return 0
        return max(0, number)

    def _build_poll_digest_locked(
        self, active: _ActiveMonitor, since_sequence: int
    ) -> dict[str, object]:
        new_events = [
            dict(event)
            for event in active.events
            if int(cast("int", event.get("sequence", 0))) > since_sequence
        ]
        return self._poll_digest(
            monitor_id=active.monitor_id,
            state=active.state,
            terminal=active.terminal_status is not None,
            since_sequence=since_sequence,
            cursor=active.sequence,
            new_events=new_events,
            event_count=active.event_count,
            suppressed=active.suppressed_event_count,
            dropped=active.dropped_event_count,
            exit_code=active.exit_code,
            success=active.success,
            terminal_reason=active.terminal_reason,
            salience_gate_disabled=active.salience_gate_disabled,
            salience_gate_disabled_reason=active.salience_gate_disabled_reason,
        )

    def _poll_terminal_digest(
        self, monitor_id: str, since_sequence: int
    ) -> dict[str, object]:
        record = self._read_status(monitor_id)
        if record is None:
            return self._poll_digest(
                monitor_id=monitor_id,
                state="not_found",
                terminal=True,
                since_sequence=since_sequence,
                cursor=since_sequence,
                new_events=[],
                event_count=0,
                suppressed=0,
                dropped=0,
                exit_code=None,
                success=False,
                terminal_reason="not_found",
                salience_gate_disabled=False,
                salience_gate_disabled_reason=None,
            )
        events = [
            event
            for event in cast("list[object]", record.get("events") or [])
            if isinstance(event, dict)
        ]
        new_events = [
            dict(event)
            for event in events
            if int(event.get("sequence", 0) or 0) > since_sequence
        ]
        cursor = max(
            (int(event.get("sequence", 0) or 0) for event in events),
            default=since_sequence,
        )
        return self._poll_digest(
            monitor_id=monitor_id,
            state=str(record.get("state", "unknown")),
            terminal=True,
            since_sequence=since_sequence,
            cursor=cursor,
            new_events=new_events,
            event_count=int(cast("int", record.get("event_count", 0) or 0)),
            suppressed=int(cast("int", record.get("suppressed_event_count", 0) or 0)),
            dropped=int(cast("int", record.get("dropped_event_count", 0) or 0)),
            exit_code=cast("int | None", record.get("exit_code")),
            success=bool(record.get("success")),
            terminal_reason=cast("str | None", record.get("terminal_reason")),
            salience_gate_disabled=bool(record.get("salience_gate_disabled")),
            salience_gate_disabled_reason=cast(
                "str | None", record.get("salience_gate_disabled_reason")
            ),
        )

    @staticmethod
    def _poll_digest(  # noqa: PLR0913 - flat digest schema mirrors the model-facing payload
        *,
        monitor_id: str,
        state: str,
        terminal: bool,
        since_sequence: int,
        cursor: int,
        new_events: list[dict[str, object]],
        event_count: int,
        suppressed: int,
        dropped: int,
        exit_code: int | None,
        success: bool | None,
        terminal_reason: str | None,
        salience_gate_disabled: bool,
        salience_gate_disabled_reason: str | None,
    ) -> dict[str, object]:
        return {
            "monitor_id": monitor_id,
            "state": state,
            "terminal": terminal,
            "since_sequence": since_sequence,
            "cursor": cursor,
            "new_events": new_events,
            "new_event_count": len(new_events),
            "event_count": event_count,
            "suppressed_event_count": suppressed,
            "dropped_event_count": dropped,
            "exit_code": exit_code,
            "success": success,
            "terminal_reason": terminal_reason,
            "salience_gate_disabled": salience_gate_disabled,
            "salience_gate_disabled_reason": salience_gate_disabled_reason,
        }

    def _prune_terminal_status_dirs(self) -> None:
        import sidecar.runtime.monitor_manager as _mm_hub

        limit = max(0, int(_mm_hub.MAX_MONITOR_TERMINAL_STATUS_DIRS))
        if limit <= 0:
            return
        monitor_dirs = self._monitor_record_dirs()
        active_ids = self._snapshot_active_monitor_ids()
        if active_ids is None:
            return
        candidates = self._terminal_status_prune_candidates(monitor_dirs, active_ids)
        if len(candidates) <= limit:
            return
        candidates.sort(key=lambda item: (item[0], item[1]))
        for _, monitor_id, _monitor_dir in candidates[: len(candidates) - limit]:
            try:
                self._status_store.delete_record(monitor_id)
            except MonitorStatusError:
                _mm_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="runtime.monitor",
                    event="monitor.status_prune_failed",
                    message="Failed to prune monitor status directory.",
                    status="failure",
                    data={"monitor_id": monitor_id},
                )

    def _monitor_record_dirs(self) -> list[Path]:
        try:
            return [
                self._status_store.record_path(monitor_id)
                for monitor_id in self._status_store.list_record_ids()
            ]
        except (MonitorStatusError, ValueError):
            return []

    def _snapshot_active_monitor_ids(self) -> set[str] | None:
        acquired = self._active_lock.acquire(blocking=False)
        if not acquired:
            return None
        try:
            return set(self._active.keys())
        finally:
            self._active_lock.release()

    def _terminal_status_prune_candidates(
        self,
        monitor_dirs: list[Path],
        active_ids: set[str],
    ) -> list[tuple[float, str, Path]]:
        candidates: list[tuple[float, str, Path]] = []
        for monitor_dir in monitor_dirs:
            candidate = self._terminal_status_prune_candidate(monitor_dir, active_ids)
            if candidate is not None:
                candidates.append(candidate)
        return candidates

    def _terminal_status_prune_candidate(
        self,
        monitor_dir: Path,
        active_ids: set[str],
    ) -> tuple[float, str, Path] | None:
        try:
            monitor_id = _canonical_monitor_id(monitor_dir.name)
            if (
                monitor_dir != self._status_store.record_path(monitor_id)
                or monitor_id in active_ids
            ):
                return None
            stored = self._status_store.read_with_mtime(monitor_id)
            if stored is None:
                return None
            status_payload, status_mtime = stored
            if not self._is_terminal_status_payload(status_payload):
                return None
            return (status_mtime, monitor_id, monitor_dir)
        except (MonitorStatusError, OSError, ToolExecutionFailure, ValueError):
            return None

    def _is_terminal_status_payload(self, status_payload: dict[str, object] | None) -> bool:
        if status_payload is None:
            return False
        if status_payload.get("state") != "running":
            return True
        return status_payload.get("terminal") is True
