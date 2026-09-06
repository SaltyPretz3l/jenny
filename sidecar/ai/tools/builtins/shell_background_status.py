"""Bounded, versioned codec for persisted background-shell job status."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import NoReturn

from sidecar.runtime.diagnostics import log_event

MAX_INLINE_OUTPUT_CHARS = 20_000
MAX_STATUS_FILE_BYTES = 262_144
JOB_STATUS_SCHEMA_VERSION = 1
LEGACY_JOB_STATUS_SCHEMA_VERSION = 0
MAX_STATUS_OUTPUT_CHARS = MAX_INLINE_OUTPUT_CHARS + len("\n...[truncated]")
MAX_STATUS_ERROR_CHARS = 2_048
MAX_STATUS_PATH_CHARS = 4_096
MAX_REPORTED_SCHEMA_VERSION = (2**31) - 1
MAX_STATUS_PID = (2**32) - 1
MIN_STATUS_EXIT_CODE = -(2**31)
MAX_STATUS_EXIT_CODE = (2**32) - 1
MAX_STATUS_OUTPUT_BYTE_COUNT = (2**63) - 1

JOB_ID_PATTERN = re.compile(r"^[0-9a-f]{12}$")
_STATUS_STATES = frozenset({"running", "completed", "failed"})
_STATUS_KEYS = frozenset(
    {
        "schema_version",
        "job_id",
        "state",
        "pid",
        "exit_code",
        "stdout",
        "stderr",
        "error",
        "full_output_path",
        "full_output_complete",
        "output_counters",
        "output_file_truncated",
        "output_size_exceeded",
        "output_truncated",
    }
)
_RUNNING_STATUS_KEYS = frozenset({"schema_version", "job_id", "state", "pid"})
_TERMINAL_STATUS_KEYS = _STATUS_KEYS - {"pid"}

logger = logging.getLogger(__name__)


class _JobStatusRejected(Exception):
    def __init__(
        self,
        message: str,
        reason_code: str,
        *,
        schema_version: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.reason_code = reason_code
        self.schema_version = schema_version


def is_valid_job_id(job_id: str) -> bool:
    """Return whether *job_id* has the exact canonical persisted shape."""
    return JOB_ID_PATTERN.fullmatch(job_id) is not None


def parse_job_status(
    job_id: str,
    raw_bytes: bytes,
    *,
    expected_output_path: str | None = None,
) -> dict[str, object]:
    """Decode, validate, and sanitize one bounded status payload."""
    try:
        parsed = _decode_job_status(raw_bytes)
        schema_version = _parse_job_status_schema(parsed)
        state = _validate_job_status_identity(parsed, job_id, schema_version)
        sanitized: dict[str, object] = {
            "schema_version": schema_version,
            "job_id": job_id,
            "state": state,
        }
        if state == "running":
            _parse_running_job_status(parsed, sanitized, schema_version)
        else:
            _parse_terminal_job_status(parsed, sanitized, schema_version)
        _parse_job_status_metadata(
            parsed,
            sanitized,
            schema_version,
            expected_output_path=expected_output_path,
        )
        return sanitized
    except _JobStatusRejected as error:
        return job_status_error(
            job_id,
            error.message,
            error.reason_code,
            schema_version=error.schema_version,
        )


def validate_job_status_for_write(status: dict[str, object]) -> dict[str, object] | None:
    """Return a sanitized v1 status or ``None`` when a producer shape is invalid."""
    persisted = dict(status)
    persisted["schema_version"] = JOB_STATUS_SCHEMA_VERSION
    job_id = persisted.get("job_id")
    if not isinstance(job_id, str) or not is_valid_job_id(job_id):
        return None
    output_path = persisted.get("full_output_path")
    expected_output_path = output_path if isinstance(output_path, str) else None
    try:
        raw_bytes = json.dumps(persisted, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError):
        return None
    if len(raw_bytes) > MAX_STATUS_FILE_BYTES:
        return None
    parsed = parse_job_status(
        job_id,
        raw_bytes,
        expected_output_path=expected_output_path,
    )
    return parsed if parsed.get("state") in _STATUS_STATES else None


def _reject_job_status(
    message: str,
    reason_code: str,
    *,
    schema_version: int | None = None,
) -> NoReturn:
    raise _JobStatusRejected(
        message,
        reason_code,
        schema_version=schema_version,
    )


def _decode_job_status(raw_bytes: bytes) -> dict[str, object]:
    try:
        parsed = json.loads(
            raw_bytes.decode("utf-8"),
            object_pairs_hook=_job_status_object,
        )
    except (UnicodeDecodeError, ValueError, RecursionError):
        _reject_job_status("job status file is corrupt", "corrupt_json")
    if not isinstance(parsed, dict):
        _reject_job_status("job status file is corrupt", "invalid_top_level")
    return parsed


def _job_status_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    parsed: dict[str, object] = {}
    for key, value in pairs:
        if key in parsed:
            _reject_job_status(
                "job status file contains duplicate fields",
                "duplicate_field",
            )
        parsed[key] = value
    return parsed


def _parse_job_status_schema(parsed: dict[str, object]) -> int:
    if "schema_version" not in parsed:
        return LEGACY_JOB_STATUS_SCHEMA_VERSION
    raw_schema = parsed["schema_version"]
    if not isinstance(raw_schema, int) or isinstance(raw_schema, bool):
        _reject_job_status("job status schema is invalid", "invalid_schema_version")
    if not 0 <= raw_schema <= MAX_REPORTED_SCHEMA_VERSION:
        _reject_job_status("job status schema is invalid", "invalid_schema_version")
    if raw_schema != JOB_STATUS_SCHEMA_VERSION:
        _reject_job_status(
            "job status schema is unsupported",
            "unsupported_schema_version",
            schema_version=raw_schema,
        )
    return raw_schema


def _validate_job_status_identity(
    parsed: dict[str, object],
    job_id: str,
    schema_version: int,
) -> str:
    if any(not isinstance(key, str) or key not in _STATUS_KEYS for key in parsed):
        _reject_job_status(
            "job status file contains unexpected fields",
            "unexpected_field",
            schema_version=schema_version,
        )
    if parsed.get("job_id") != job_id:
        _reject_job_status(
            "job status identity does not match",
            "job_id_mismatch",
            schema_version=schema_version,
        )
    state = parsed.get("state")
    if not isinstance(state, str) or state not in _STATUS_STATES:
        _reject_job_status(
            "job status state is invalid",
            "invalid_state",
            schema_version=schema_version,
        )
    return state


def _parse_running_job_status(
    parsed: dict[str, object],
    sanitized: dict[str, object],
    schema_version: int,
) -> None:
    if not set(parsed) <= _RUNNING_STATUS_KEYS:
        _reject_job_status(
            "running job status contains terminal fields",
            "unexpected_field",
            schema_version=schema_version,
        )
    pid = parsed.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or not 1 <= pid <= MAX_STATUS_PID:
        _reject_job_status(
            "running job status pid is invalid",
            "invalid_pid",
            schema_version=schema_version,
        )
    sanitized["pid"] = pid


def _parse_terminal_job_status(
    parsed: dict[str, object],
    sanitized: dict[str, object],
    schema_version: int,
) -> None:
    if not set(parsed) <= _TERMINAL_STATUS_KEYS:
        _reject_job_status(
            "terminal job status contains running fields",
            "unexpected_field",
            schema_version=schema_version,
        )
    legacy_launch_failure = (
        schema_version == LEGACY_JOB_STATUS_SCHEMA_VERSION
        and parsed.get("state") == "failed"
        and "exit_code" not in parsed
        and set(parsed) <= {"job_id", "state", "error"}
    )
    if not legacy_launch_failure:
        _parse_terminal_job_result(parsed, sanitized, schema_version)
    _parse_status_error(parsed, sanitized, schema_version)
    if legacy_launch_failure and "error" not in sanitized:
        _reject_job_status(
            "legacy failed status is incomplete",
            "missing_field",
            schema_version=schema_version,
        )


def _parse_terminal_job_result(
    parsed: dict[str, object],
    sanitized: dict[str, object],
    schema_version: int,
) -> None:
    if any(field not in parsed for field in ("exit_code", "stdout", "stderr")):
        _reject_job_status(
            "terminal job status is incomplete",
            "missing_field",
            schema_version=schema_version,
        )
    exit_code = parsed["exit_code"]
    if (
        not isinstance(exit_code, int)
        or isinstance(exit_code, bool)
        or not MIN_STATUS_EXIT_CODE <= exit_code <= MAX_STATUS_EXIT_CODE
    ):
        _reject_job_status(
            "terminal job exit code is invalid",
            "invalid_exit_code",
            schema_version=schema_version,
        )
    if (parsed.get("state") == "completed") != (exit_code == 0):
        _reject_job_status(
            "terminal job state does not match its exit code",
            "inconsistent_terminal_state",
            schema_version=schema_version,
        )
    sanitized["exit_code"] = exit_code
    for field in ("stdout", "stderr"):
        value = parsed[field]
        if not isinstance(value, str) or len(value) > MAX_STATUS_OUTPUT_CHARS:
            _reject_job_status(
                "terminal job output is invalid",
                f"invalid_{field}",
                schema_version=schema_version,
            )
        sanitized[field] = value


def _parse_status_error(
    parsed: dict[str, object],
    sanitized: dict[str, object],
    schema_version: int,
) -> None:
    if "error" not in parsed:
        return
    if parsed.get("state") == "completed":
        _reject_job_status(
            "completed job status cannot contain an error",
            "inconsistent_terminal_state",
            schema_version=schema_version,
        )
    error = parsed["error"]
    if not isinstance(error, str) or not error or len(error) > MAX_STATUS_ERROR_CHARS:
        _reject_job_status(
            "job status error text is invalid",
            "invalid_error",
            schema_version=schema_version,
        )
    sanitized["error"] = error


def _parse_job_status_metadata(
    parsed: dict[str, object],
    sanitized: dict[str, object],
    schema_version: int,
    *,
    expected_output_path: str | None,
) -> None:
    if "full_output_path" in parsed:
        _parse_full_output_path(
            parsed["full_output_path"],
            sanitized,
            schema_version,
            expected_output_path=expected_output_path,
        )
    for field in ("output_file_truncated", "output_size_exceeded", "output_truncated"):
        if field not in parsed:
            continue
        value = parsed[field]
        if not isinstance(value, bool):
            _reject_job_status(
                "job output flag is invalid",
                "invalid_output_flag",
                schema_version=schema_version,
            )
        sanitized[field] = value
    if "full_output_complete" in parsed:
        value = parsed["full_output_complete"]
        if not isinstance(value, bool):
            _reject_job_status(
                "job output completeness flag is invalid",
                "invalid_output_flag",
                schema_version=schema_version,
            )
        if "full_output_path" not in sanitized:
            _reject_job_status(
                "job output completeness requires a full output path",
                "inconsistent_output_metadata",
                schema_version=schema_version,
            )
        sanitized["full_output_complete"] = value
    if "output_counters" in parsed:
        sanitized["output_counters"] = _parse_output_counters(
            parsed["output_counters"],
            schema_version,
        )


def _parse_output_counters(value: object, schema_version: int) -> dict[str, int]:
    expected_keys = {
        "stdout_bytes",
        "stderr_bytes",
        "captured_bytes",
        "discarded_bytes",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        _reject_job_status(
            "job output counters are invalid",
            "invalid_output_counters",
            schema_version=schema_version,
        )
    counters: dict[str, int] = {}
    for field in expected_keys:
        counter = value[field]
        if (
            not isinstance(counter, int)
            or isinstance(counter, bool)
            or not 0 <= counter <= MAX_STATUS_OUTPUT_BYTE_COUNT
        ):
            _reject_job_status(
                "job output counters are invalid",
                "invalid_output_counters",
                schema_version=schema_version,
            )
        counters[field] = counter
    total_bytes = counters["stdout_bytes"] + counters["stderr_bytes"]
    if (
        total_bytes > MAX_STATUS_OUTPUT_BYTE_COUNT
        or counters["captured_bytes"] > total_bytes
        or counters["discarded_bytes"] != total_bytes - counters["captured_bytes"]
    ):
        _reject_job_status(
            "job output counters are inconsistent",
            "inconsistent_output_counters",
            schema_version=schema_version,
        )
    return counters


def _parse_full_output_path(
    output_path: object,
    sanitized: dict[str, object],
    schema_version: int,
    *,
    expected_output_path: str | None,
) -> None:
    canonical_output_path = (
        os.path.normpath(output_path)
        if isinstance(output_path, str)
        and output_path
        and len(output_path) <= MAX_STATUS_PATH_CHARS
        and os.path.isabs(output_path)
        else ""
    )
    trusted_output_path = (
        os.path.abspath(expected_output_path)
        if isinstance(expected_output_path, str) and expected_output_path
        else ""
    )
    same_identity = (
        canonical_output_path
        and output_path == canonical_output_path
        and os.path.normcase(canonical_output_path) == os.path.normcase(trusted_output_path)
    )
    if not same_identity:
        _reject_job_status(
            "job output path is invalid",
            "invalid_full_output_path",
            schema_version=schema_version,
        )
    sanitized["full_output_path"] = trusted_output_path


def job_status_error(
    job_id: str,
    message: str,
    reason_code: str,
    *,
    schema_version: int | None = None,
) -> dict[str, object]:
    """Create and emit the bounded rejection contract."""
    data: dict[str, object] = {"reason_code": reason_code}
    if schema_version is not None:
        data["schema_version"] = schema_version
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.shell_background",
        event="ai.tools.shell_background.status_rejected",
        message="Background job status was rejected.",
        data=data,
    )
    result: dict[str, object] = {
        "job_id": job_id,
        "state": "unknown",
        "error": message,
        "reason_code": reason_code,
    }
    if schema_version is not None:
        result["schema_version"] = schema_version
    return result


__all__ = [
    "JOB_STATUS_SCHEMA_VERSION",
    "LEGACY_JOB_STATUS_SCHEMA_VERSION",
    "MAX_INLINE_OUTPUT_CHARS",
    "MAX_STATUS_ERROR_CHARS",
    "MAX_STATUS_FILE_BYTES",
    "MAX_STATUS_OUTPUT_CHARS",
    "is_valid_job_id",
    "job_status_error",
    "parse_job_status",
    "validate_job_status_for_write",
]
