"""Runtime-native monitor tool process manager."""

from __future__ import annotations

import logging
import os as os
import re
import shutil as shutil
import threading
from pathlib import Path
from typing import Any, Callable, NoReturn

from sidecar.ai.error_codes import (
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_EXECUTION_FAILED,
)
from sidecar.ai.tools.builtins.regex_safety import compile_safe_pattern
from sidecar.ai.tools.builtins.shell_background import (
    ManagedBackgroundProcess,
    release_managed_background_process,  # noqa: F401 -- reached via the hub by _MonitorStreamingMixin
    spawn_managed_background_process,
    terminate_managed_background_process,
)
from sidecar.ai.tools.builtins.shell_security import find_blocked_pattern
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.protocol import MONITOR_EVENT_METHOD
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.monitor_manager_polling import _MonitorPollingMixin
from sidecar.runtime.monitor_manager_shared import (
    DEFAULT_MONITOR_TIMEOUT_MS as DEFAULT_MONITOR_TIMEOUT_MS,
)
from sidecar.runtime.monitor_manager_shared import (
    MAX_ACTIVE_MONITORS,
    MonitorStartResult,
    NotificationWriter,
    _ActiveMonitor,
    _clip_text,
    _coerce_timeout_ms,
    _redacted_shell_argv,
    _resolve_cwd,
    _shell_argv,
    _utc_now_iso,
)
from sidecar.runtime.monitor_manager_shared import (
    MAX_MONITOR_EVENT_CHARS as MAX_MONITOR_EVENT_CHARS,
)
from sidecar.runtime.monitor_manager_shared import (
    MAX_MONITOR_EVENTS as MAX_MONITOR_EVENTS,
)
from sidecar.runtime.monitor_manager_shared import (
    MAX_MONITOR_OUTPUT_BATCH as MAX_MONITOR_OUTPUT_BATCH,
)
from sidecar.runtime.monitor_manager_shared import (
    MAX_MONITOR_TERMINAL_STATUS_DIRS as MAX_MONITOR_TERMINAL_STATUS_DIRS,
)
from sidecar.runtime.monitor_manager_shared import (
    MAX_MONITOR_TIMEOUT_MS as MAX_MONITOR_TIMEOUT_MS,
)
from sidecar.runtime.monitor_manager_shared import (
    MIN_MONITOR_TIMEOUT_MS as MIN_MONITOR_TIMEOUT_MS,
)
from sidecar.runtime.monitor_manager_streaming import _MonitorStreamingMixin
from sidecar.runtime.monitor_salience import (
    MONITOR_SALIENCE_BUDGET_SECONDS as MONITOR_SALIENCE_BUDGET_SECONDS,
)
from sidecar.runtime.monitor_salience import (
    MonitorSalienceWorker,
)
from sidecar.runtime.monitor_status import MonitorStatusError, MonitorStatusStore
from sidecar.runtime.rpc import notification
from sidecar.runtime.runtime_ids import new_monitor_id

logger = logging.getLogger(__name__)


def _default_salience_worker_factory(active: _ActiveMonitor) -> MonitorSalienceWorker:
    """Build the spawned salience worker for *active* (tests override this hook)."""
    return MonitorSalienceWorker(
        ignore_specs=[(regex.pattern, regex.flags) for regex in active.ignore_patterns],
        match_specs=[(regex.pattern, regex.flags) for regex in active.match_patterns],
    )


class MonitorManager(_MonitorStreamingMixin, _MonitorPollingMixin):
    """Start and track bounded shell-snippet monitors."""

    def __init__(self, *, runtime_root: Path | str) -> None:
        self._runtime_root = Path(runtime_root).expanduser()
        self._status_store = MonitorStatusStore(self._runtime_root)
        self._active: dict[str, _ActiveMonitor] = {}
        self._active_lock = threading.Lock()
        self._starting_count = 0
        self._closed = False
        self._salience_worker_factory: Callable[[_ActiveMonitor], Any] = (
            _default_salience_worker_factory
        )
        self._prune_terminal_status_dirs()

    def start_monitor(  # noqa: PLR0913
        self,
        *,
        command: str,
        description: str,
        timeout_ms: Any = None,
        persistent: bool = False,
        cwd: Any = None,
        workspace_root: Any = None,
        match_patterns: Any = None,
        ignore_patterns: Any = None,
        dedupe: bool = False,
        request_id: str,
        trace_id: str,
        session_id: str,
        tool_call_id: str,
        notification_writer: NotificationWriter | None,
    ) -> MonitorStartResult:
        self._raise_if_closed()
        active = self._build_active_monitor(
            command=command,
            description=description,
            timeout_ms=timeout_ms,
            persistent=persistent,
            cwd=cwd,
            workspace_root=workspace_root,
            match_patterns=match_patterns,
            ignore_patterns=ignore_patterns,
            dedupe=dedupe,
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            tool_call_id=tool_call_id,
            notification_writer=notification_writer,
        )
        self._reserve_monitor_start(active)
        active.job = self._spawn_monitor_process(active)
        self._activate_started_monitor(active)
        self._start_monitor_thread(active)
        self._log_monitor_started(active)
        return self._monitor_start_result(active)

    def _build_active_monitor(  # noqa: PLR0913
        self,
        *,
        command: str,
        description: str,
        timeout_ms: Any,
        persistent: bool,
        cwd: Any,
        workspace_root: Any,
        match_patterns: Any = None,
        ignore_patterns: Any = None,
        dedupe: bool = False,
        request_id: str,
        trace_id: str,
        session_id: str,
        tool_call_id: str,
        notification_writer: NotificationWriter | None,
    ) -> _ActiveMonitor:
        normalized_command = str(command or "").strip()
        if not normalized_command:
            raise ToolExecutionFailure(
                code=CMP_TOOL_EXECUTION_FAILED,
                message="monitor command must be a non-empty string",
                retryable=False,
            )
        blocked_pattern = find_blocked_pattern(normalized_command)
        if blocked_pattern:
            raise ToolExecutionFailure(
                code=CMP_TOOL_COMMAND_BLOCKED,
                message=f"command blocked by security classifier: {blocked_pattern}",
                retryable=False,
            )
        compiled_match = self._compile_monitor_patterns(
            match_patterns, field_name="match_patterns"
        )
        compiled_ignore = self._compile_monitor_patterns(
            ignore_patterns, field_name="ignore_patterns"
        )
        normalized_timeout_ms = _coerce_timeout_ms(timeout_ms)
        resolved_cwd = _resolve_cwd(cwd, workspace_root)
        monitor_id = new_monitor_id()
        return _ActiveMonitor(
            monitor_id=monitor_id,
            description=_clip_text(description, limit=240)
            or "Monitor shell command",
            timeout_ms=normalized_timeout_ms,
            persistent=bool(persistent),
            cwd=resolved_cwd,
            request_id=str(request_id or ""),
            trace_id=str(trace_id or request_id or ""),
            session_id=str(session_id or ""),
            tool_call_id=str(tool_call_id or ""),
            notification_writer=notification_writer,
            shell_argv=_shell_argv(normalized_command),
            match_patterns=compiled_match,
            ignore_patterns=compiled_ignore,
            dedupe=bool(dedupe),
        )

    @staticmethod
    def _compile_monitor_patterns(raw: Any, *, field_name: str) -> list[re.Pattern[str]]:
        if raw is None:
            return []
        if not isinstance(raw, (list, tuple)):
            raise ToolExecutionFailure(
                code=CMP_TOOL_EXECUTION_FAILED,
                message=f"monitor {field_name} must be a list of regex strings",
                retryable=False,
            )
        compiled: list[re.Pattern[str]] = []
        for item in raw:
            if item is None:
                continue
            text = str(item).strip()
            if not text:
                continue
            compiled.append(
                compile_safe_pattern(
                    text, ignore_case=True, error_code=CMP_TOOL_EXECUTION_FAILED
                )
            )
        return compiled

    def _reserve_monitor_start(self, active: _ActiveMonitor) -> None:
        with self._active_lock:
            if self._closed:
                self._raise_start_closed(active)
            if len(self._active) + self._starting_count >= MAX_ACTIVE_MONITORS:
                self._raise_active_limit(active)
            self._starting_count += 1

    def _raise_start_closed(self, active: _ActiveMonitor) -> NoReturn:
        self._mark_start_failed(active, terminal_reason="shutdown")
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="monitor manager is closed",
            retryable=False,
        )

    def _raise_active_limit(self, active: _ActiveMonitor) -> NoReturn:
        self._mark_start_failed(active, terminal_reason="active_limit")
        log_event(
            logger,
            logging.WARNING,
            component="runtime.monitor",
            event="monitor.active_limit_reached",
            message="Monitor active limit reached.",
            status="failure",
            data={"active_count": len(self._active), "limit": MAX_ACTIVE_MONITORS},
            request_id=active.request_id,
            session_id=active.session_id,
        )
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="active monitor limit reached",
            retryable=True,
        )

    def _mark_start_failed(self, active: _ActiveMonitor, *, terminal_reason: str) -> None:
        active.state = "failed"
        active.terminal_reason = terminal_reason
        active.success = False
        active.terminal_status = self._terminal_status(active)
        active.terminal_event.set()
        self._safe_write_status(active)

    def _spawn_monitor_process(self, active: _ActiveMonitor) -> ManagedBackgroundProcess:
        self._safe_write_status(active)
        try:
            return spawn_managed_background_process(
                active.shell_argv,
                cwd=active.cwd,
            )
        except Exception as error:
            with self._active_lock:
                self._starting_count = max(0, self._starting_count - 1)
            self._mark_start_failed(active, terminal_reason="spawn_failed")
            raise ToolExecutionFailure(
                code=CMP_TOOL_EXECUTION_FAILED,
                message=f"monitor command failed to start: {type(error).__name__}",
                retryable=True,
            ) from error

    def _activate_started_monitor(self, active: _ActiveMonitor) -> None:
        with self._active_lock:
            self._starting_count = max(0, self._starting_count - 1)
            if self._closed:
                self._terminate_closed_start(active)
            self._active[active.monitor_id] = active

    def _terminate_closed_start(self, active: _ActiveMonitor) -> NoReturn:
        if active.job is not None:
            terminate_managed_background_process(active.job, timeout_seconds=1.0)
            active.exit_code = active.job.process.returncode
        self._mark_start_failed(active, terminal_reason="shutdown")
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="monitor manager is closed",
            retryable=False,
        )

    def _start_monitor_thread(self, active: _ActiveMonitor) -> None:
        thread = threading.Thread(
            target=self._run_monitor,
            args=(active,),
            name=f"monitor-{active.monitor_id}",
            daemon=True,
        )
        try:
            thread.start()
        except Exception as error:  # noqa: BLE001 - normalized at the tool boundary
            self._terminate_active(active, reason="process_error")
            raise ToolExecutionFailure(
                code=CMP_TOOL_EXECUTION_FAILED,
                message=f"monitor runner failed to start: {type(error).__name__}",
                retryable=True,
            ) from error

    def _log_monitor_started(self, active: _ActiveMonitor) -> None:
        log_event(
            logger,
            logging.INFO,
            component="runtime.monitor",
            event="monitor.started",
            message="Monitor started.",
            status="success",
            data={
                "monitor_id": active.monitor_id,
                "timeout_ms": active.timeout_ms,
                "persistent": active.persistent,
                "shell_argv": _redacted_shell_argv(active.shell_argv),
            },
            request_id=active.request_id,
            session_id=active.session_id,
        )

    def _monitor_start_result(self, active: _ActiveMonitor) -> MonitorStartResult:
        metadata = self._metadata(active)
        return MonitorStartResult(
            monitor_id=active.monitor_id,
            output=(
                f"Monitor started (monitor_id {active.monitor_id}, timeout "
                f"{active.timeout_ms}ms). You will be notified on each event."
            ),
            metadata={"monitor": metadata},
        )

    def recover_stale_monitors(self) -> int:
        recovered = 0
        try:
            monitor_ids = self._status_store.list_record_ids()
        except MonitorStatusError:
            return 0
        for monitor_id in monitor_ids:
            try:
                status = self._status_store.read(monitor_id)
            except MonitorStatusError:
                log_event(
                    logger,
                    logging.WARNING,
                    component="runtime.monitor",
                    event="monitor.stale_record_invalid",
                    message="Skipped an invalid persisted monitor record.",
                    status="failure",
                    data={"monitor_id": monitor_id},
                )
                continue
            if status is None:
                continue
            if (
                status.get("state") == "running"
                and status.get("persistent") is True
            ):
                status["state"] = "stale"
                status["success"] = False
                status["terminal"] = True
                status["terminal_reason"] = "stale_recovery"
                status["updated_at"] = _utc_now_iso()
                try:
                    self._status_store.write(monitor_id, status)
                    recovered += 1
                except MonitorStatusError:
                    log_event(
                        logger,
                        logging.WARNING,
                        component="runtime.monitor",
                        event="monitor.stale_recovery_failed",
                        message="Failed to mark stale monitor record.",
                        status="failure",
                        data={"monitor_id": monitor_id},
                    )
        if recovered:
            self._prune_terminal_status_dirs()
        return recovered

    def has_active_monitors(self) -> bool:
        """Return whether this process currently owns any live monitor."""

        with self._active_lock:
            return bool(self._active)

    def close(self) -> None:
        with self._active_lock:
            self._closed = True
            active_monitors = list(self._active.values())
        for active in active_monitors:
            self._terminate_active(active, reason="shutdown")

    def _notify(self, active: _ActiveMonitor, event: dict[str, object]) -> None:
        writer = active.notification_writer
        if writer is None:
            return
        params = {
            "request_id": active.request_id,
            "trace_id": active.trace_id,
            "session_id": active.session_id,
            "tool_call_id": active.tool_call_id,
            "monitor_id": active.monitor_id,
            "state": active.state,
            "terminal": False,
            **event,
        }
        try:
            writer(notification(MONITOR_EVENT_METHOD, params))
        except Exception:  # noqa: BLE001
            log_event(
                logger,
                logging.WARNING,
                component="runtime.monitor",
                event="monitor.notification_failed",
                message="Monitor notification sink failed.",
                status="failure",
                data={"monitor_id": active.monitor_id},
                request_id=active.request_id,
                session_id=active.session_id,
            )
