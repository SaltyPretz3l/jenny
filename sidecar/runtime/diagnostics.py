"""Structured diagnostics logging for the sidecar runtime."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import sys
import threading
from contextlib import contextmanager
from contextvars import ContextVar, Token
from copy import copy
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import islice
from logging.handlers import QueueHandler
from pathlib import Path
from time import monotonic, perf_counter
from typing import Any, Callable, Iterator, TextIO

from sidecar.ai.config import read_environment_value
from sidecar.runtime.diagnostics_queue import (
    DIRECT_WRITE,
    BoundedDiagnosticsListener,
    BoundedDiagnosticsQueue,
)
from sidecar.runtime.diagnostics_stream import (
    DiagnosticsFanoutHandler,
    DiagnosticsStreamHandler,
)

SCHEMA_VERSION = 1
SEGMENT_MAX_BYTES = 5 * 1024 * 1024
ROTATION_RETRY_BYTES = 256 * 1024
ROTATION_RETRY_SECONDS = 5.0
# While rotation is blocked the active segment may overrun up to this many
# segment sizes; past that, records are dropped until rotation succeeds.
BLOCKED_ROTATION_SEGMENT_MULTIPLE = 4
PER_LAYER_CAP_BYTES = 50 * 1024 * 1024
GLOBAL_CAP_BYTES = 200 * 1024 * 1024
GLOBAL_PRUNE_TARGET_BYTES = 150 * 1024 * 1024
RETENTION_DAYS = 14

_CAPTURE_MODE: str = "redacted"
_CONTEXT: ContextVar[dict[str, Any]] = ContextVar("sidecar_diagnostics_context", default={})
_STATE: "DiagnosticsState | None" = None
_STARTUP_AUDIT_TRUE_VALUES = {"1", "true", "yes", "on"}
_SENSITIVE_KEY_PARTS = {
    "authorization",
    "bearer",
    "cookie",
    "credential",
    "credentials",
    "dsn",
    "password",
    "passwd",
    "setcookie",
    "secret",
    "token",
}
_SENSITIVE_KEY_PAIRS = {
    ("access", "key"),
    ("api", "key"),
    ("auth", "token"),
    ("private", "key"),
    ("session", "key"),
}
_SENSITIVE_COMPACT_KEYS = {
    "apikey",
    "api-key",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
    "authtoken",
    "setcookie",
}
_SENSITIVE_ASSIGNMENT_KEY_PATTERN = (
    r"authorization|(?:[a-z0-9]+[_-])?api[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"client[_-]?secret|auth[_-]?token|id[_-]?token|password|passwd|secret|token|cookie|set-cookie|dsn"
)
_SENSITIVE_ASSIGNMENT_RE = re.compile(
    rf"(?i)\b(?P<key>{_SENSITIVE_ASSIGNMENT_KEY_PATTERN})"
    r"(?P<sep>\s*[:=]\s*)"
    r"(?:\"[^\"]*\"|'[^']*'|[^,\s;&]+)"
)
_COOKIE_HEADER_RE = re.compile(
    r"(?im)\b(?P<key>set-cookie|cookie)(?P<sep>\s*:\s*)[^\r\n]*"
)
_AUTHORIZATION_HEADER_RE = re.compile(
    rf"(?im)\b(?P<key>authorization)(?P<sep>\s*:\s*)[^\r\n]+?"
    rf"(?=(?:\s+\b(?:{_SENSITIVE_ASSIGNMENT_KEY_PATTERN})\s*[:=])|\s+data:|\r?\n|$)"
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
_DATA_URL_RE = re.compile(r"(?i)data:[^\s,;]+(?:;[^\s,;]+)*;base64,[A-Za-z0-9+/=]{16,}")
_SECRET_SHAPE_RE = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{8,}|(?:sk|pk|tok|gh[pousr])_[A-Za-z0-9_-]{8,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|xox[baprs][-_][A-Za-z0-9-]{10,}|"
    r"AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{8,}|"
    r"eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]{8,})\b"
)
_CREDENTIAL_URL_RE = re.compile(
    r"(?i)\b(?:(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^\s'\"<>]+|"
    r"https?://[^:\s'\"<>/]+:[^@\s'\"<>/]+@[^\s'\"<>]+)"
)
# Hide space-bearing path tails conservatively; stop before diagnostic fields.
_PATH_BODY = (
    r"[^\r\n\t'\"`<>|]+?(?=  |\s+[\w-]+[:=]|"
    r"\s+(?:is|was|does|failed|exited)\b|$|['\"`<>|\r\n\t])"
)
_PRIVATE_PATH_RE = re.compile(
    r"(?:\b[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._$-]+\\|"
    r"(?<![^\s(\"':=,])/+(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)/)"
    + _PATH_BODY
)
# Numbered segments plus a segment staged mid-rotation (``.rotating-<pid>``),
# which a crash or a failed shift can strand; retention must still see it.
_NUMERIC_LOG_ROTATION_RE = re.compile(r"\.log\.(?:rotating-)?[0-9]+\Z")
_STAGED_SEGMENT_INDEX = 1_000_000


def _redact_key_value(match: re.Match[str]) -> str:
    return f"{match.group('key')}{match.group('sep')}[redacted]"


def _sanitize_text(value: str, *, limit: int = 512) -> str:
    sanitized = _PRIVATE_PATH_RE.sub("[redacted:path]", value)
    sanitized = _CREDENTIAL_URL_RE.sub("[redacted:dsn]", sanitized)
    sanitized = _DATA_URL_RE.sub("data:[redacted]", sanitized)
    sanitized = _COOKIE_HEADER_RE.sub(_redact_key_value, sanitized)
    sanitized = _AUTHORIZATION_HEADER_RE.sub(_redact_key_value, sanitized)
    sanitized = _BEARER_RE.sub("bearer [redacted]", sanitized)
    sanitized = _SENSITIVE_ASSIGNMENT_RE.sub(_redact_key_value, sanitized)
    sanitized = _SECRET_SHAPE_RE.sub("[redacted]", sanitized)
    normalized = " ".join(sanitized.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: max(0, limit - 3)]}..."


def _hash_text(value: str) -> str:
    # surrogatepass: JSON can carry lone surrogates; hashing must never raise into a tool reply.
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()[:16]


def _is_sensitive_key(key: Any) -> bool:
    raw = str(key or "").strip().lower()
    if not raw:
        return False
    compact = re.sub(r"[^a-z0-9]+", "", raw)
    if (
        compact in _SENSITIVE_COMPACT_KEYS
        or compact in {"contentpreview", "email"}
        or compact.endswith(("token", "secret", "password", "dsn", "email", "credential"))
    ):
        return True
    parts = [part for part in re.split(r"[^a-z0-9]+", raw) if part]
    if any(part in _SENSITIVE_KEY_PARTS for part in parts):
        return True
    return any(pair in _SENSITIVE_KEY_PAIRS for pair in zip(parts, parts[1:], strict=False))


_MEASUREMENT_UNITS = {"ms", "count", "chars", "bytes"}


def _is_numeric_measurement(key: str | None, value: Any) -> bool:
    # time_to_first_token_ms or token_count name a measurement, not a credential; only a
    # number under a unit-suffixed key passes, so a secret string there is still redacted.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    parts = [part for part in re.split(r"[^a-z0-9]+", str(key or "").lower()) if part]
    return bool(parts) and parts[-1] in _MEASUREMENT_UNITS


def _sanitize_value(value: Any, *, key: str | None = None, depth: int = 0) -> Any:
    if _is_sensitive_key(key) and not _is_numeric_measurement(key, value):
        return "[redacted]"
    if value is None or isinstance(value, (int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return _sanitize_text(value, limit=256)
    if isinstance(value, dict):
        if depth >= 3:
            return {
                "keys": [str(entry_key) for entry_key in islice(value.keys(), 12)],
                "key_count": len(value),
            }
        return {
            str(entry_key): _sanitize_value(
                entry,
                key=str(entry_key),
                depth=depth + 1,
            )
            for entry_key, entry in islice(value.items(), 20)
            if str(entry_key).strip()
        }
    if isinstance(value, (list, tuple, set)):
        if depth >= 3:
            return {"item_count": len(value)}
        return [_sanitize_value(entry, depth=depth + 1) for entry in islice(value, 8)]
    if isinstance(value, BaseException):
        return {"type": value.__class__.__name__, "message": _sanitize_text(str(value), limit=256)}
    return _sanitize_text(str(value), limit=128)


def sanitize_diagnostic_text(value: str, *, limit: int = 512) -> str:
    """Return terminal-safe text for logs and JSON-RPC error surfaces."""
    return _sanitize_text(value, limit=limit)


def sanitize_diagnostic_value(value: Any) -> Any:
    """Return a recursively redacted JSON-ish value for terminal error payloads."""
    return _sanitize_value(value)


def _safe_data(record: logging.LogRecord) -> dict[str, Any]:
    raw_data = getattr(record, "data", {})
    data = _sanitize_value(raw_data)
    if not isinstance(data, dict):
        data = {"value": data}
    exception_snapshot = getattr(record, "diagnostics_exception", None)
    if isinstance(exception_snapshot, dict):
        exc_type = exception_snapshot.get("type")
        exc_value = exception_snapshot.get("message")
        data["error_type"] = exc_type if isinstance(exc_type, str) else "Exception"
        data["error_message"] = (
            _sanitize_text(exc_value, limit=256) if isinstance(exc_value, str) else "unknown"
        )
    elif record.exc_info:
        exc_type = record.exc_info[0]
        exc_value = record.exc_info[1]
        data["error_type"] = exc_type.__name__ if exc_type else "Exception"
        data["error_message"] = (
            _sanitize_text(str(exc_value), limit=256) if exc_value else "unknown"
        )
    return data


# Mirrors Electron ingress (renderer/shared/log-contract-utils.js): an identifier or status
# that is not a plain token, or that the secret redactor would change, never reaches a sink.
_IDENTIFIER_RE = re.compile(r"[A-Za-z0-9._:/@-]{1,160}")
_STATUS_RE = re.compile(r"[a-z][a-z0-9_]{0,39}")


def _plain_token(value: str, pattern: re.Pattern[str]) -> bool:
    return pattern.fullmatch(value) is not None and _sanitize_text(value, limit=256) == value


def _coerce_status(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    status = value.strip()
    return status if _plain_token(status, _STATUS_RE) else "unknown"


def _coerce_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        identifier = value.strip()
        return identifier if _plain_token(identifier, _IDENTIFIER_RE) else None
    return None


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    return None


def _coerce_float(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        candidate = float(value)
        return candidate if math.isfinite(candidate) else None
    return None


class StructuredLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        context = {**_CONTEXT.get(), **getattr(record, "diagnostics_context", {})}
        payload = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname.upper(),
            "layer": getattr(record, "layer", "sidecar"),
            "component": getattr(record, "component", record.name),
            "event": getattr(record, "event", "sidecar.log"),
            "message": _sanitize_text(record.getMessage(), limit=256),
            "trace_id": _coerce_str(getattr(record, "trace_id", context.get("trace_id"))),
            "request_id": _coerce_str(getattr(record, "request_id", context.get("request_id"))),
            "session_id": _coerce_str(getattr(record, "session_id", context.get("session_id"))),
            "agent_id": _coerce_str(getattr(record, "agent_id", context.get("agent_id"))),
            "tool_call_id": _coerce_str(
                getattr(record, "tool_call_id", context.get("tool_call_id"))
            ),
            "approval_id": _coerce_int(getattr(record, "approval_id", context.get("approval_id"))),
            "rpc_id": _coerce_int(getattr(record, "rpc_id", context.get("rpc_id"))),
            "status": _coerce_status(getattr(record, "status", None)),
            "duration_ms": _coerce_float(getattr(record, "duration_ms", None)),
            "data": _safe_data(record),
            "redaction_mode": _CAPTURE_MODE,
            "schema_version": SCHEMA_VERSION,
        }
        return json.dumps(payload, ensure_ascii=True, allow_nan=False)


class ContextQueueHandler(QueueHandler):
    def __init__(
        self,
        queue: BoundedDiagnosticsQueue,
        direct_sink: logging.Handler,
    ) -> None:
        super().__init__(queue)  # type: ignore[arg-type]
        self._diagnostics_queue = queue
        self._direct_sink = direct_sink

    def prepare(self, record: logging.LogRecord) -> logging.LogRecord:
        prepared = copy(record)
        prepared.diagnostics_context = dict(_CONTEXT.get())
        if record.exc_info:
            exc_type = record.exc_info[0]
            exc_value = record.exc_info[1]
            prepared.diagnostics_exception = {
                "type": exc_type.__name__ if exc_type else "Exception",
                "message": str(exc_value) if exc_value else "unknown",
            }
        prepared.message = prepared.getMessage()
        prepared.msg = prepared.message
        prepared.args = None
        prepared.exc_info = None
        prepared.exc_text = None
        prepared.stack_info = None
        return prepared

    def enqueue(self, record: logging.LogRecord) -> None:
        admission = self._diagnostics_queue.enqueue(record)
        if admission != DIRECT_WRITE:
            return
        self._diagnostics_queue.record_external_drop(record)

    def handleError(self, record: logging.LogRecord) -> None:
        # QueueHandler.emit calls this for preparation/admission failures.
        # Never give stdlib the original diagnostic record for stderr output.
        self._diagnostics_queue.record_external_drop(record)


class NdjsonRollingFileHandler(logging.Handler):
    def __init__(self, path: Path, *, clock: Callable[[], float] = monotonic) -> None:
        super().__init__()
        self._path = path
        self._lock = threading.Lock()
        self._stream: TextIO | None = None
        self._formatter = StructuredLogFormatter()
        self._bytes_since_prune = 0
        self._rotation_retry_bytes = 0
        self._clock = clock
        self._last_rotation_failure: float | None = None
        self._failure_count = 0
        self._rotation_blocked_over_ceiling = False
        self._prune_failure_count = 0
        self._prune_failure_streak = 0
        self._closed = False

    @property
    def failure_count(self) -> int:
        """Accepted records that could not be persisted, including ceiling drops."""
        with self._lock:
            return self._failure_count

    @property
    def prune_failure_count(self) -> int:
        return self._prune_failure_count

    def emit(self, record: logging.LogRecord) -> None:
        try:
            line = f"{self._formatter.format(record)}\n"
            encoded = line.encode("utf-8")
            with self._lock:
                if self._closed:
                    # Reject, never lazily reopen: a straggler emit after close
                    # used to reopen the stream and leak the fd for good.
                    return
                self._path.parent.mkdir(parents=True, exist_ok=True)
                rotated = self._rotate_if_needed(len(encoded))
                if self._rotation_blocked_over_ceiling:
                    # Retention never trims the active segment, so a rotation
                    # blocked for good must not let it grow without bound.
                    self._failure_count += 1
                    return
                stream = self._ensure_stream()
                stream.write(line)
                stream.flush()
                self._bytes_since_prune += len(encoded)
                if rotated or self._bytes_since_prune >= 1_048_576:
                    self._attempt_prune_locked(context="rotation" if rotated else "size")
                    self._bytes_since_prune = 0
        except Exception:  # noqa: BLE001 - never expose a failed record via stderr.
            with self._lock:
                self._failure_count += 1

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._attempt_prune_locked(context="shutdown")
            if self._stream is not None:
                self._stream.close()
                self._stream = None
        super().close()

    def _ensure_stream(self) -> TextIO:
        if self._stream is None or self._stream.closed:
            self._stream = self._path.open("a", encoding="utf-8")
        return self._stream

    def _rotate_if_needed(self, incoming_bytes: int) -> bool:
        try:
            active = self._path.stat()
        except FileNotFoundError:
            active = None
        self._drop_stream_if_replaced(active)
        current_size = active.st_size if active is not None else 0
        self._rotation_blocked_over_ceiling = False
        if current_size + incoming_bytes <= SEGMENT_MAX_BYTES:
            return False
        retry_due = (
            self._last_rotation_failure is not None
            and self._clock() - self._last_rotation_failure >= ROTATION_RETRY_SECONDS
        )
        if self._rotation_retry_bytes > incoming_bytes and not retry_due:
            self._note_blocked_rotation(current_size + incoming_bytes)
            self._rotation_retry_bytes -= incoming_bytes
            return False
        if self._stream is not None:
            self._stream.close()
            self._stream = None
        # Claim the active segment before shifting anything. The main sidecar
        # and background workers share this file; on Windows another holder's
        # open handle makes the rename fail, and shifting first used to delete
        # one old segment and drop the record on every blocked attempt.
        # Retry after bounded growth or time, even if ceiling drops stop growth.
        staged = self._path.with_name(f"{self._path.name}.rotating-{os.getpid()}")
        try:
            self._path.rename(staged)
        except OSError:
            self._last_rotation_failure = self._clock()
            self._rotation_retry_bytes = ROTATION_RETRY_BYTES
            self._note_blocked_rotation(current_size + incoming_bytes)
            return False
        self._rotation_retry_bytes = 0
        self._last_rotation_failure = None
        for index in range(32, 1, -1):
            source = self._path.with_name(f"{self._path.name}.{index - 1}")
            target = self._path.with_name(f"{self._path.name}.{index}")
            if target.exists():
                target.unlink(missing_ok=True)
            if source.exists():
                source.rename(target)
        staged.rename(self._path.with_name(f"{self._path.name}.1"))
        return True

    def _note_blocked_rotation(self, projected_size: int) -> None:
        self._rotation_blocked_over_ceiling = (
            projected_size > SEGMENT_MAX_BYTES * BLOCKED_ROTATION_SEGMENT_MULTIPLE
        )

    def _drop_stream_if_replaced(self, active: os.stat_result | None) -> None:
        # Another process rotated the segment out from under this handle
        # (possible where renaming an open file succeeds): reopen, or every
        # later record lands in a rotated segment that is eventually deleted.
        if self._stream is None or self._stream.closed:
            return
        held = os.fstat(self._stream.fileno())
        if active is None or (active.st_dev, active.st_ino) != (held.st_dev, held.st_ino):
            self._stream.close()
            self._stream = None

    def _list_layer_files(self) -> list[Path]:
        if not self._path.parent.exists():
            return []
        indexed: list[tuple[int, Path]] = []
        prefix = f"{self._path.name}."
        for entry in self._path.parent.iterdir():
            if not entry.is_file():
                continue
            if entry.name == self._path.name:
                indexed.append((0, entry))
                continue
            if not entry.name.startswith(prefix):
                continue
            suffix = entry.name[len(prefix) :]
            if re.fullmatch(r"rotating-[0-9]+", suffix):
                # Stranded mid-rotation: sort as the oldest so caps trim it first.
                indexed.append((_STAGED_SEGMENT_INDEX, entry))
                continue
            if not re.fullmatch(r"[0-9]+", suffix):
                continue
            indexed.append((int(suffix), entry))
        return [entry for _index, entry in sorted(indexed, key=lambda item: item[0])]

    def prune(self) -> None:
        with self._lock:
            self._attempt_prune_locked(context="explicit")
            self._bytes_since_prune = 0

    def _prune(self) -> None:
        self.prune()

    def _prune_locked(self) -> None:
        if not self._path.parent.exists():
            return
        cutoff = datetime.now(UTC) - timedelta(days=RETENTION_DAYS)
        files = self._list_layer_files()
        total_layer_bytes = 0
        for path in files:
            stat = path.stat()
            if path.name != self._path.name and datetime.fromtimestamp(stat.st_mtime, UTC) < cutoff:
                path.unlink(missing_ok=True)
                continue
            total_layer_bytes += stat.st_size
        if total_layer_bytes > PER_LAYER_CAP_BYTES:
            for path in reversed(self._list_layer_files()):
                if total_layer_bytes <= PER_LAYER_CAP_BYTES or path.name == self._path.name:
                    break
                size = path.stat().st_size
                path.unlink(missing_ok=True)
                total_layer_bytes -= size

        all_logs = sorted(
            [
                entry
                for entry in self._path.parent.iterdir()
                if entry.is_file()
                and (
                    entry.name.endswith(".log")
                    or _NUMERIC_LOG_ROTATION_RE.search(entry.name) is not None
                )
            ],
            key=lambda candidate: candidate.stat().st_mtime,
        )
        total_global_bytes = sum(path.stat().st_size for path in all_logs)
        for path in all_logs:
            if total_global_bytes <= GLOBAL_CAP_BYTES:
                break
            if path.name.endswith(".log"):
                continue
            size = path.stat().st_size
            path.unlink(missing_ok=True)
            total_global_bytes -= size
            if total_global_bytes <= GLOBAL_PRUNE_TARGET_BYTES:
                break

    def _attempt_prune_locked(self, *, context: str) -> bool:
        try:
            self._prune_locked()
        except Exception as error:  # noqa: BLE001 - retention failure is degraded, not fatal.
            self._record_prune_failure_locked(error, context=context)
            return False
        if self._prune_failure_streak:
            self._write_prune_record_locked(
                event="sidecar.runtime.diagnostics_prune_recovered",
                level=logging.INFO,
                status="ok",
                data={
                    "failure_count": self._prune_failure_streak,
                    "failure_total": self._prune_failure_count,
                    "context": context,
                },
            )
            self._prune_failure_streak = 0
        return True

    def _record_prune_failure_locked(self, error: Exception, *, context: str) -> None:
        self._prune_failure_count += 1
        self._prune_failure_streak += 1
        if self._prune_failure_streak != 1:
            return
        self._write_prune_record_locked(
            event="sidecar.runtime.diagnostics_prune_failed",
            level=logging.WARNING,
            status="degraded",
            data={
                "failure_count": self._prune_failure_streak,
                "failure_total": self._prune_failure_count,
                "error_type": type(error).__name__,
                "context": context,
            },
        )

    def _write_prune_record_locked(
        self,
        *,
        event: str,
        level: int,
        status: str,
        data: dict[str, Any],
    ) -> None:
        record = logging.LogRecord(
            name="sidecar.runtime.diagnostics",
            level=level,
            pathname="",
            lineno=0,
            msg="Diagnostics log retention degraded" if level >= logging.WARNING else (
                "Diagnostics log retention recovered"
            ),
            args=(),
            exc_info=None,
        )
        record.component = "runtime.diagnostics"
        record.event = event
        record.status = status
        record.data = data
        line = f"{self._formatter.format(record)}\n"
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            stream = self._ensure_stream()
            stream.write(line)
            stream.flush()
        except Exception:  # noqa: BLE001 - count remains observable in memory.
            self._failure_count += 1
            try:
                sys.stderr.write(line)
                sys.stderr.flush()
            except Exception:  # noqa: BLE001 - no remaining safe sink exists.
                pass


@dataclass
class DiagnosticsState:
    queue_handler: ContextQueueHandler
    listener: BoundedDiagnosticsListener
    file_handler: NdjsonRollingFileHandler
    sink_handler: logging.Handler


def _coerce_log_level(value: Any) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "debug":
            return logging.DEBUG
        if normalized == "info":
            return logging.INFO
        if normalized in {"warn", "warning"}:
            return logging.WARNING
        if normalized == "error":
            return logging.ERROR
    return logging.INFO


def _runtime_preference(raw_config: Any, key: str, default: str) -> str:
    if isinstance(raw_config, dict):
        value = raw_config.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return default


def configure_sidecar_logging(
    path: Path,
    *,
    log_level: str = "info",
    capture_mode: str = "redacted",
    mirror_to_stderr: bool = False,
) -> None:
    global _STATE, _CAPTURE_MODE
    if _STATE is not None:
        shutdown_sidecar_logging()
    _CAPTURE_MODE = "sanitized_snippets" if capture_mode == "sanitized_snippets" else "redacted"
    file_handler = NdjsonRollingFileHandler(path)
    file_handler.prune()
    sink_handler: logging.Handler = file_handler
    if mirror_to_stderr:
        sink_handler = DiagnosticsFanoutHandler(
            file_handler,
            DiagnosticsStreamHandler(StructuredLogFormatter()),
        )
    queue = BoundedDiagnosticsQueue()
    queue_handler = ContextQueueHandler(queue, sink_handler)
    listener = BoundedDiagnosticsListener(queue, sink_handler)
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(queue_handler)
    root.setLevel(_coerce_log_level(log_level))
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    listener.start()
    _STATE = DiagnosticsState(
        queue_handler=queue_handler,
        listener=listener,
        file_handler=file_handler,
        sink_handler=sink_handler,
    )


def shutdown_sidecar_logging(
    *,
    timeout_seconds: float = 2.0,
    shutdown_started_at: float | None = None,
    shutdown_deadline: float | None = None,
    shutdown_confirmed: bool = True,
) -> dict[str, int | bool | float]:
    global _STATE
    if _STATE is None:
        return {"drained": True, "timed_out": False, "discarded": 0, "duration_ms": 0.0}
    state = _STATE
    _STATE = None
    flush_started_at = perf_counter()
    root = logging.getLogger()
    root.removeHandler(state.queue_handler)
    drain_result = state.listener.stop(timeout_seconds=max(float(timeout_seconds), 0.0))
    duration_ms = max((perf_counter() - flush_started_at) * 1000.0, 0.0)
    drain_timed_out = drain_result.get("drained") is not True

    def emit_final_stage(stage: str, status: str, stage_duration_ms: float) -> None:
        if drain_timed_out:
            # The live listener still owns the sink; contend with neither its
            # writes nor its disposal — report the stage on stderr, bounded.
            sys.stderr.write(
                f"sidecar shutdown stage {stage}: {status} "
                f"({stage_duration_ms:.0f}ms; diagnostics drain timed out)\n"
            )
            return
        now = perf_counter()
        remaining_budget_ms = (
            max((shutdown_deadline - now) * 1000.0, 0.0)
            if shutdown_deadline is not None
            else 0.0
        )
        record = logging.getLogger(__name__).makeRecord(
            __name__,
            logging.INFO if status == "ok" else logging.WARNING,
            __file__,
            0,
            "sidecar shutdown stage completed",
            (),
            None,
            extra={
                "layer": "sidecar",
                "component": "runtime.shutdown",
                "event": "sidecar.runtime.shutdown_stage",
                "status": status,
                "duration_ms": stage_duration_ms,
                "data": {
                    "stage": stage,
                    "remaining_budget_ms": remaining_budget_ms,
                    "forced": False,
                    "confirmed": status == "ok",
                    "discarded_count": min(
                        max(int(drain_result.get("discarded", 0)), 0), 100_000
                    ),
                },
            },
        )
        state.sink_handler.handle(record)

    if shutdown_started_at is not None:
        emit_final_stage(
            "diagnostics_flush",
            "ok" if drain_result.get("drained") is True else "timeout",
            duration_ms,
        )
        emit_final_stage(
            "total",
            (
                "ok"
                if shutdown_confirmed and drain_result.get("drained") is True
                else "bounded"
            ),
            max((perf_counter() - shutdown_started_at) * 1000.0, 0.0),
        )
    # Single-owner disposal: while the listener is still draining it owns the
    # sink, so its exit path closes the handler (post-close emits are rejected,
    # never lazily reopened — that reopen leaked the fd across reconfigures).
    # When the listener has already exited, or refuses the transfer, close here.
    if not (
        drain_timed_out and state.listener.transfer_sink_close(state.file_handler.close)
    ):
        state.file_handler.close()
    return {**drain_result, "duration_ms": duration_ms}


def apply_logging_preferences(raw_config: Any) -> None:
    global _CAPTURE_MODE
    log_level = _runtime_preference(raw_config, "diagnostics_log_level", "info")
    capture_mode = _runtime_preference(raw_config, "diagnostics_capture_mode", "redacted")
    _CAPTURE_MODE = "sanitized_snippets" if capture_mode == "sanitized_snippets" else "redacted"
    logging.getLogger().setLevel(_coerce_log_level(log_level))


def correlation_from_params(params: Any) -> dict[str, Any]:
    if not isinstance(params, dict):
        return {}
    return {
        "trace_id": _coerce_str(params.get("trace_id")),
        "request_id": _coerce_str(params.get("request_id")),
        "session_id": _coerce_str(params.get("session_id")),
        "agent_id": _coerce_str(params.get("agent_id")),
    }


@contextmanager
def diagnostics_context(**context: Any) -> Iterator[None]:
    merged = {
        **_CONTEXT.get(),
        **{key: value for key, value in context.items() if value is not None},
    }
    token: Token[dict[str, Any]] = _CONTEXT.set(merged)
    try:
        yield
    finally:
        _CONTEXT.reset(token)


def log_event(
    logger: logging.Logger,
    level: int,
    *,
    component: str,
    event: str,
    message: str,
    status: str | None = None,
    duration_ms: float | None = None,
    data: dict[str, Any] | None = None,
    **context: Any,
) -> None:
    logger.log(
        level,
        message,
        extra={
            "layer": "sidecar",
            "component": component,
            "event": event,
            "status": status,
            "duration_ms": duration_ms,
            "data": data or {},
            **context,
        },
    )


def emit_startup_audit_mark(
    logger: logging.Logger,
    mark: str,
    *,
    status: str | None = "ok",
    duration_ms: float | None = None,
    data: dict[str, Any] | None = None,
    **context: Any,
) -> None:
    if read_environment_value("JENNY_COLD_START_AUDIT").lower() not in _STARTUP_AUDIT_TRUE_VALUES:
        return
    normalized_mark = str(mark or "").strip()
    if not normalized_mark:
        return
    payload = {
        "audit_run_id": read_environment_value("JENNY_COLD_START_AUDIT_RUN_ID"),
        "mark": normalized_mark,
        "perf_counter_ms": round(perf_counter() * 1000, 3),
    }
    if data:
        payload.update(data)
    log_event(
        logger,
        logging.INFO,
        component="startup.audit",
        event="startup.audit.mark",
        message=f"Startup audit mark: {normalized_mark}",
        status=status,
        duration_ms=duration_ms,
        data=payload,
        **context,
    )


def _tool_argument_projection(arguments: dict[str, Any] | None) -> dict[str, Any]:
    projection: dict[str, Any] = {}
    # Match the formatter's mapping bound; never traverse nested arguments.
    for key, value in islice((arguments or {}).items(), 20):
        safe_key = _sanitize_text(str(key), limit=64)
        if not safe_key or _is_sensitive_key(key):
            continue
        if isinstance(value, str):
            metadata = {"type": "string", "size": len(value), "hash": _hash_text(value)}
        elif isinstance(value, (dict, list)):
            metadata = {
                "type": "object" if isinstance(value, dict) else "array", "size": len(value)
            }
        elif value is None:
            metadata = {"type": "null"}
        elif isinstance(value, bool):
            metadata = {"type": "boolean"}
        elif isinstance(value, (int, float)):
            metadata = {"type": "number"}
        else:
            # Non-JSON inputs carry no content or user-defined type names.
            metadata = {"type": "unknown"}
        projection[safe_key] = metadata
    return projection


def log_tool_execution(
    logger: logging.Logger,
    *,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    duration_ms: float | None = None,
    result_size: int | None = None,
    tool_output: str | None = None,
    success: bool = True,
    error_code: str | None = None,
    cancelled: bool = False,
    level: int | None = None,
) -> None:
    """Log a structured tool execution trace event."""
    if level is None:
        if not success and error_code:
            level = logging.ERROR
        elif not success:
            level = logging.WARNING
        else:
            level = logging.DEBUG

    if not logger.isEnabledFor(level):
        return

    data: dict[str, Any] = {
        "tool_name": tool_name,
        "arguments": _tool_argument_projection(arguments),
        "success": success,
        "cancelled": cancelled,
    }
    if duration_ms is not None:
        data["duration_ms"] = duration_ms
    if result_size is not None:
        data["result_size"] = result_size
    if error_code:
        data["error_code"] = error_code
    if tool_output:
        # Three 160-character snippet fields total at most 480, below the 512-char cap.
        for key, value in build_redacted_snippet_data(tool_output=tool_output).items():
            data.setdefault(key, value)

    status = "cancelled" if cancelled else ("success" if success else "failure")

    log_event(
        logger,
        level,
        component="ai.tools",
        event="ai.tools.execution",
        message=f"Tool execution: {tool_name}",
        status=status,
        duration_ms=duration_ms,
        data=data,
    )


def build_redacted_snippet_data(
    *, prompt: str | None = None, response: str | None = None, tool_output: str | None = None
) -> dict[str, Any]:
    data: dict[str, Any] = {}
    if prompt:
        data["prompt_chars"] = len(prompt)
        data["prompt_hash"] = _hash_text(prompt)
    if response:
        data["response_chars"] = len(response)
        data["response_hash"] = _hash_text(response)
    if tool_output:
        data["tool_output_chars"] = len(tool_output)
        data["tool_output_hash"] = _hash_text(tool_output)
    if _CAPTURE_MODE == "sanitized_snippets":
        snippets: dict[str, str] = {}
        for key, value in (
            ("prompt_snippet", prompt),
            ("response_snippet", response),
            ("tool_output_snippet", tool_output),
        ):
            if not value:
                continue
            snippets[key] = _sanitize_text(value, limit=160)
        if snippets:
            data.update(snippets)
    return data
