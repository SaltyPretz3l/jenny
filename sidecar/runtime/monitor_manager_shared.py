"""Shared constants, dataclasses, and helpers for the runtime monitor manager."""

from __future__ import annotations

import os
import re
import shutil
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
)
from sidecar.ai.tools.builtins.shell_background import (
    ManagedBackgroundProcess,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.runtime_ids import RuntimeIdError, parse_monitor_id

DEFAULT_MONITOR_TIMEOUT_MS = 180_000
MAX_MONITOR_TIMEOUT_MS = 3_600_000
MIN_MONITOR_TIMEOUT_MS = 100
MAX_MONITOR_EVENTS = 100
MAX_MONITOR_EVENT_CHARS = 2_000
MAX_ACTIVE_MONITORS = 8
MAX_MONITOR_OUTPUT_BATCH = 20
MONITOR_OUTPUT_FLUSH_INTERVAL_SECONDS = 0.25
MONITOR_RECORD_VERSION = 1
MAX_MONITOR_TERMINAL_STATUS_DIRS = 200

NotificationWriter = Callable[[dict[str, Any]], None]


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class MonitorStartResult:
    monitor_id: str
    output: str
    metadata: dict[str, object]


@dataclass
class _ActiveMonitor:
    monitor_id: str
    description: str
    timeout_ms: int
    persistent: bool
    cwd: Path
    request_id: str
    trace_id: str
    session_id: str
    tool_call_id: str
    notification_writer: NotificationWriter | None
    shell_argv: list[str]
    started_at: float = field(default_factory=time.monotonic)
    started_at_iso: str = field(default_factory=_utc_now_iso)
    sequence: int = 0
    event_count: int = 0
    dropped_event_count: int = 0
    suppressed_event_count: int = 0
    match_patterns: list[re.Pattern[str]] = field(default_factory=list)
    ignore_patterns: list[re.Pattern[str]] = field(default_factory=list)
    dedupe: bool = False
    # Budgeted regex-evaluation state for the salience gate. ``salience_lock``
    # guards the worker handle plus the budget counters and is INDEPENDENT of
    # ``lock``: the worker IPC must never be held under the lock that status and
    # poll readers contend on.
    salience_gate_disabled: bool = False
    salience_gate_disabled_reason: str | None = None
    salience_budget_spent_seconds: float = 0.0
    salience_worker: Any = None
    salience_lock: Any = field(default_factory=threading.Lock)
    last_emitted_text: dict[str, str] = field(default_factory=dict)
    events: list[dict[str, object]] = field(default_factory=list)
    state: str = "running"
    terminal_reason: str | None = None
    exit_code: int | None = None
    success: bool | None = None
    terminal_event: threading.Event = field(default_factory=threading.Event)
    terminal_status: dict[str, object] | None = None
    job: ManagedBackgroundProcess | None = None
    pending_output_events: list[dict[str, object]] = field(default_factory=list)
    output_flush_timer: threading.Timer | None = None
    lock: Any = field(default_factory=threading.RLock)


def _clip_text(value: Any, *, limit: int = MAX_MONITOR_EVENT_CHARS) -> str:
    text = str(value or "")
    text = text.rstrip("\r\n")
    if len(text) <= limit:
        return text
    return f"{text[: max(0, limit - 14)]}...[truncated]"


def _coerce_timeout_ms(value: Any) -> int:
    if value is None:
        return DEFAULT_MONITOR_TIMEOUT_MS
    if isinstance(value, bool):
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="monitor timeout_ms must be an integer",
            retryable=False,
        )
    try:
        timeout_ms = int(value)
    except (TypeError, ValueError) as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="monitor timeout_ms must be an integer",
            retryable=False,
        ) from error
    if timeout_ms < MIN_MONITOR_TIMEOUT_MS:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=f"monitor timeout_ms must be at least {MIN_MONITOR_TIMEOUT_MS}",
            retryable=False,
        )
    if timeout_ms > MAX_MONITOR_TIMEOUT_MS:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=f"monitor timeout_ms must be at most {MAX_MONITOR_TIMEOUT_MS}",
            retryable=False,
        )
    return timeout_ms


def _canonical_monitor_id(value: object) -> str:
    try:
        return parse_monitor_id(value)
    except RuntimeIdError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="monitor_id must match mon_[0-9a-f]{12}",
            retryable=False,
        ) from error


def _resolve_cwd(cwd: Any, workspace_root: Any) -> Path:
    guard = WorkspaceGuard(str(workspace_root) if workspace_root is not None else None)
    root = guard.require_root()
    raw_cwd = str(cwd).strip() if cwd is not None else ""
    if not raw_cwd:
        return root
    return guard.resolve_list_path(raw_cwd)


def _shell_argv(command: str) -> list[str]:
    if os.name == "nt":
        return [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ]
    shell = shutil.which("bash") or shutil.which("sh") or "sh"
    return [shell, "-lc", command]


def _redacted_shell_argv(argv: list[str]) -> list[str]:
    if not argv:
        return []
    if os.name == "nt":
        return argv[:4] + ["<command>"]
    return argv[:2] + ["<command>"]
