"""Strict, bounded persistence for runtime monitor status records."""

from __future__ import annotations

import json
import os
import shutil
import stat as stat_module
import uuid
from pathlib import Path
from typing import Any

from sidecar.runtime.monitor_manager_shared import (
    MAX_MONITOR_EVENT_CHARS,
    MAX_MONITOR_EVENTS,
    MAX_MONITOR_TIMEOUT_MS,
    MIN_MONITOR_TIMEOUT_MS,
    MONITOR_RECORD_VERSION,
)
from sidecar.runtime.runtime_ids import (
    GuardedRuntimeDirectory,
    RuntimeIdError,
    RuntimePathError,
    is_runtime_link_object,
    parse_monitor_id,
)

MAX_MONITOR_STATUS_BYTES = 256 * 1024
MAX_MONITOR_RECORD_SCAN_ENTRIES = 2_048
_MAX_SAFE_INTEGER = (1 << 53) - 1
_MAX_TIMESTAMP_CHARS = 64
_MAX_DESCRIPTION_CHARS = 240
_MAX_TERMINAL_REASON_CHARS = 64
_STATUS_STATES = frozenset(
    {"running", "completed", "failed", "timeout", "cancelled", "stale"}
)
_REQUIRED_STATUS_KEYS = frozenset(
    {
        "version",
        "monitor_id",
        "description",
        "state",
        "persistent",
        "timeout_ms",
        "event_count",
        "dropped_event_count",
        "suppressed_event_count",
        "events",
        "terminal_reason",
        "exit_code",
        "success",
        "started_at",
        "updated_at",
        "terminal",
    }
)
# Additive-optional on read, always written: accepting these as absent is what
# keeps version-1 records produced by older builds readable (and lets a rewrite
# upgrade them in place) without a MONITOR_RECORD_VERSION bump. A downgrade path
# reading a NEW record would reject it; that is acceptable for records that are
# transient runtime state, not durable user data.
_OPTIONAL_STATUS_KEYS = frozenset(
    {"salience_gate_disabled", "salience_gate_disabled_reason"}
)
_REQUIRED_EVENT_KEYS = frozenset(
    {"sequence", "kind", "stream", "text", "timestamp", "elapsed_ms"}
)


class MonitorStatusError(ValueError):
    """A monitor status record is malformed, unsafe, or unsupported."""


class MonitorStatusStore:
    """Guarded operation owner for ``runtime_root/monitors``."""

    def __init__(self, runtime_root: Path | str) -> None:
        trusted_root = GuardedRuntimeDirectory.create_trusted_root(runtime_root)
        monitors_root = trusted_root.child_directory("monitors", create=True)
        if monitors_root is None:  # pragma: no cover - create=True is exhaustive
            raise MonitorStatusError("monitor status root is unavailable")
        self._root = monitors_root

    @property
    def root(self) -> Path:
        return self._root.path

    def record_path(self, monitor_id: object) -> Path:
        canonical_id = parse_monitor_id(monitor_id)
        self._root.validate()
        return self._root.path / canonical_id

    def read(self, monitor_id: object) -> dict[str, object] | None:
        stored = self.read_with_mtime(monitor_id)
        return None if stored is None else stored[0]

    def read_with_mtime(
        self,
        monitor_id: object,
    ) -> tuple[dict[str, object], float] | None:
        canonical_id = parse_monitor_id(monitor_id)
        record = self._record_guard(canonical_id, create=False)
        if record is None:
            return None
        try:
            stored = record.read_bytes(
                "status.json",
                max_bytes=MAX_MONITOR_STATUS_BYTES,
                missing_ok=True,
            )
        except RuntimePathError as error:
            raise MonitorStatusError("monitor status could not be read safely") from error
        if stored is None:
            return None
        return (
            decode_monitor_status(stored.data, expected_monitor_id=canonical_id),
            stored.mtime_ns / 1_000_000_000,
        )

    def write(self, monitor_id: object, payload: dict[str, object]) -> None:
        canonical_id = parse_monitor_id(monitor_id)
        encoded = encode_monitor_status(payload, expected_monitor_id=canonical_id)
        record = self._record_guard(canonical_id, create=True)
        if record is None:  # pragma: no cover - create=True is exhaustive
            raise MonitorStatusError("monitor status directory is unavailable")
        try:
            record.write_bytes_atomic(
                "status.json",
                encoded,
                max_bytes=MAX_MONITOR_STATUS_BYTES,
            )
        except RuntimePathError as error:
            raise MonitorStatusError("monitor status could not be written safely") from error

    def list_record_ids(self) -> list[str]:
        monitor_ids: list[str] = []
        try:
            self._root.validate()
            with os.scandir(self._root.path) as scan:
                for index, entry in enumerate(scan):
                    if index >= MAX_MONITOR_RECORD_SCAN_ENTRIES:
                        break
                    try:
                        monitor_id = parse_monitor_id(entry.name)
                        if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                            continue
                        self._record_guard(monitor_id, create=False)
                    except (OSError, RuntimeIdError, RuntimePathError, MonitorStatusError):
                        continue
                    monitor_ids.append(monitor_id)
        except OSError as error:
            raise MonitorStatusError("monitor status root could not be scanned") from error
        monitor_ids.sort()
        return monitor_ids

    def delete_record(self, monitor_id: object) -> bool:
        canonical_id = parse_monitor_id(monitor_id)
        record = self._record_guard(canonical_id, create=False)
        if record is None:
            return False
        quarantine = self._root.path / f".prune-{uuid.uuid4().hex}"
        try:
            self._root.validate()
            record.validate()
            os.replace(record.path, quarantine)
            self._root.validate()
            value = quarantine.lstat()
            if is_runtime_link_object(quarantine, value):
                quarantine.unlink()
            elif stat_module.S_ISDIR(value.st_mode):
                shutil.rmtree(quarantine)
            else:
                quarantine.unlink()
        except OSError as error:
            raise MonitorStatusError("monitor status record could not be deleted safely") from error
        return True

    def _record_guard(
        self,
        monitor_id: str,
        *,
        create: bool,
    ) -> GuardedRuntimeDirectory | None:
        try:
            return self._root.child_directory(monitor_id, create=create)
        except RuntimePathError as error:
            raise MonitorStatusError("monitor status directory is unsafe") from error


def encode_monitor_status(
    payload: dict[str, object],
    *,
    expected_monitor_id: str | None = None,
) -> bytes:
    normalized = validate_monitor_status(payload, expected_monitor_id=expected_monitor_id)
    try:
        encoded = json.dumps(
            normalized,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeError) as error:
        raise MonitorStatusError("monitor status is not strict JSON") from error
    if len(encoded) > MAX_MONITOR_STATUS_BYTES:
        raise MonitorStatusError("monitor status exceeds its byte limit")
    return encoded


def decode_monitor_status(
    data: bytes,
    *,
    expected_monitor_id: str | None = None,
) -> dict[str, object]:
    if len(data) > MAX_MONITOR_STATUS_BYTES:
        raise MonitorStatusError("monitor status exceeds its byte limit")
    try:
        text = data.decode("utf-8", errors="strict")
        payload = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeError, json.JSONDecodeError, MonitorStatusError) as error:
        raise MonitorStatusError("monitor status is not valid strict JSON") from error
    if not isinstance(payload, dict):
        raise MonitorStatusError("monitor status must be a JSON object")
    return validate_monitor_status(payload, expected_monitor_id=expected_monitor_id)


def validate_monitor_status(
    payload: dict[str, object],
    *,
    expected_monitor_id: str | None = None,
) -> dict[str, object]:
    present_keys = set(payload)
    if not _REQUIRED_STATUS_KEYS <= present_keys or not (
        present_keys - _REQUIRED_STATUS_KEYS
    ) <= _OPTIONAL_STATUS_KEYS:
        raise MonitorStatusError("monitor status fields do not match schema version 1")
    if _strict_int(payload.get("version"), field="version") != MONITOR_RECORD_VERSION:
        raise MonitorStatusError("monitor status version is unsupported")
    try:
        monitor_id = parse_monitor_id(payload.get("monitor_id"))
    except RuntimeIdError as error:
        raise MonitorStatusError("monitor status has an invalid monitor_id") from error
    if expected_monitor_id is not None and monitor_id != parse_monitor_id(expected_monitor_id):
        raise MonitorStatusError("monitor status identity does not match its directory")

    description = _bounded_text(
        payload.get("description"),
        field="description",
        max_chars=_MAX_DESCRIPTION_CHARS,
        allow_empty=False,
    )
    state = _bounded_text(payload.get("state"), field="state", max_chars=32)
    if state not in _STATUS_STATES:
        raise MonitorStatusError("monitor status state is invalid")
    persistent = _strict_bool(payload.get("persistent"), field="persistent")
    timeout_ms = _strict_int(payload.get("timeout_ms"), field="timeout_ms")
    if not MIN_MONITOR_TIMEOUT_MS <= timeout_ms <= MAX_MONITOR_TIMEOUT_MS:
        raise MonitorStatusError("monitor status timeout_ms is out of range")

    event_count = _non_negative_int(payload.get("event_count"), field="event_count")
    dropped = _non_negative_int(
        payload.get("dropped_event_count"), field="dropped_event_count"
    )
    suppressed = _non_negative_int(
        payload.get("suppressed_event_count"), field="suppressed_event_count"
    )
    events = _validate_events(payload.get("events"))
    if event_count != len(events) + dropped + suppressed:
        raise MonitorStatusError("monitor status counters are inconsistent")
    terminal_reason = _optional_text(
        payload.get("terminal_reason"),
        field="terminal_reason",
        max_chars=_MAX_TERMINAL_REASON_CHARS,
    )
    exit_code = _optional_int(payload.get("exit_code"), field="exit_code")
    success = _optional_bool(payload.get("success"), field="success")
    started_at = _bounded_text(
        payload.get("started_at"),
        field="started_at",
        max_chars=_MAX_TIMESTAMP_CHARS,
    )
    updated_at = _bounded_text(
        payload.get("updated_at"),
        field="updated_at",
        max_chars=_MAX_TIMESTAMP_CHARS,
    )
    terminal = _strict_bool(payload.get("terminal"), field="terminal")
    salience_disabled = _strict_bool(
        payload.get("salience_gate_disabled", False),
        field="salience_gate_disabled",
    )
    salience_reason = _optional_text(
        payload.get("salience_gate_disabled_reason"),
        field="salience_gate_disabled_reason",
        max_chars=_MAX_TERMINAL_REASON_CHARS,
    )
    if salience_reason is not None and not salience_disabled:
        raise MonitorStatusError("monitor status salience reason requires a disabled gate")
    if state == "running":
        if terminal or terminal_reason is not None or exit_code is not None or success is not None:
            raise MonitorStatusError("running monitor status has terminal fields")
    elif not terminal or terminal_reason is None or success is None:
        raise MonitorStatusError("terminal monitor status is incomplete")

    return {
        "version": MONITOR_RECORD_VERSION,
        "monitor_id": monitor_id,
        "description": description,
        "state": state,
        "persistent": persistent,
        "timeout_ms": timeout_ms,
        "event_count": event_count,
        "dropped_event_count": dropped,
        "suppressed_event_count": suppressed,
        "salience_gate_disabled": salience_disabled,
        "salience_gate_disabled_reason": salience_reason,
        "events": events,
        "terminal_reason": terminal_reason,
        "exit_code": exit_code,
        "success": success,
        "started_at": started_at,
        "updated_at": updated_at,
        "terminal": terminal,
    }


def _validate_events(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) > MAX_MONITOR_EVENTS:
        raise MonitorStatusError("monitor status events must be a bounded list")
    events: list[dict[str, object]] = []
    previous_sequence = 0
    for raw_event in value:
        if not isinstance(raw_event, dict) or set(raw_event) != _REQUIRED_EVENT_KEYS:
            raise MonitorStatusError("monitor status event fields are invalid")
        sequence = _non_negative_int(raw_event.get("sequence"), field="event.sequence")
        if sequence <= previous_sequence:
            raise MonitorStatusError("monitor status event sequences are not increasing")
        previous_sequence = sequence
        if raw_event.get("kind") != "output":
            raise MonitorStatusError("monitor status event kind is invalid")
        stream = raw_event.get("stream")
        if stream not in {"stdout", "stderr"}:
            raise MonitorStatusError("monitor status event stream is invalid")
        events.append(
            {
                "sequence": sequence,
                "kind": "output",
                "stream": stream,
                "text": _bounded_text(
                    raw_event.get("text"),
                    field="event.text",
                    max_chars=MAX_MONITOR_EVENT_CHARS,
                    allow_empty=False,
                ),
                "timestamp": _bounded_text(
                    raw_event.get("timestamp"),
                    field="event.timestamp",
                    max_chars=_MAX_TIMESTAMP_CHARS,
                ),
                "elapsed_ms": _non_negative_int(
                    raw_event.get("elapsed_ms"), field="event.elapsed_ms"
                ),
            }
        )
    return events


def _strict_int(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise MonitorStatusError(f"monitor status {field} must be an integer")
    if not -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER:
        raise MonitorStatusError(f"monitor status {field} is out of range")
    return value


def _non_negative_int(value: object, *, field: str) -> int:
    parsed = _strict_int(value, field=field)
    if parsed < 0:
        raise MonitorStatusError(f"monitor status {field} must be non-negative")
    return parsed


def _optional_int(value: object, *, field: str) -> int | None:
    if value is None:
        return None
    return _strict_int(value, field=field)


def _strict_bool(value: object, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise MonitorStatusError(f"monitor status {field} must be a boolean")
    return value


def _optional_bool(value: object, *, field: str) -> bool | None:
    if value is None:
        return None
    return _strict_bool(value, field=field)


def _bounded_text(
    value: object,
    *,
    field: str,
    max_chars: int,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str) or len(value) > max_chars:
        raise MonitorStatusError(f"monitor status {field} must be a bounded string")
    if not allow_empty and not value:
        raise MonitorStatusError(f"monitor status {field} must not be empty")
    return value


def _optional_text(value: object, *, field: str, max_chars: int) -> str | None:
    if value is None:
        return None
    return _bounded_text(value, field=field, max_chars=max_chars)


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise MonitorStatusError("monitor status contains duplicate object keys")
        value[key] = item
    return value


def _reject_json_constant(value: str) -> None:
    raise MonitorStatusError(f"monitor status contains non-finite constant: {value}")


__all__ = [
    "MAX_MONITOR_EVENTS",
    "MAX_MONITOR_STATUS_BYTES",
    "MONITOR_RECORD_VERSION",
    "MonitorStatusError",
    "MonitorStatusStore",
    "decode_monitor_status",
    "encode_monitor_status",
    "validate_monitor_status",
]
