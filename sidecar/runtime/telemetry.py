"""Opt-in Sentry crash reporting for the sidecar process.

Receives DSN and consent via the `initialize` RPC params from electron.
Only initializes sentry_sdk when consent is "opt_in".
Uses the same sanitization patterns as diagnostics.py for beforeSend.
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import urlparse

from sidecar.runtime.diagnostics import _is_sensitive_key, _sanitize_text

logger = logging.getLogger(__name__)

_sentry_initialized = False
_MAX_TELEMETRY_SANITIZE_DEPTH = 4
_ALLOWED_DSN_EXACT_HOSTS = {"sentry.io"}
_ALLOWED_DSN_HOST_SUFFIXES = (
    ".ingest.sentry.io",
    ".ingest.us.sentry.io",
    ".ingest.eu.sentry.io",
)
_PATH_TRAIL_PATTERN = r"[^\s,;'\"{}]+"
_WINDOWS_PATH_PATTERN = (
    rf"(?<![A-Za-z0-9_.-])[A-Za-z]:[\\/]{_PATH_TRAIL_PATTERN}"
)
_POSIX_PATH_PATTERN = (
    rf"(?<![A-Za-z0-9_.-])/(?:Users|home|var|tmp|workspace|mnt|Volumes)/{_PATH_TRAIL_PATTERN}"
)
_PATH_PATTERN = re.compile(rf"(?:{_WINDOWS_PATH_PATTERN}|{_POSIX_PATH_PATTERN})")


@dataclass(frozen=True)
class TelemetryStatus:
    initialized: bool = False
    consent: str = "opt_out"
    status: str = "disabled"
    failure_reason: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return asdict(self)


_last_status = TelemetryStatus()


def configure_telemetry(
    *,
    dsn: str,
    consent: str,
    app_version: str = "",
) -> None:
    """Initialize or teardown Sentry based on consent.

    Called during the sidecar `initialize` RPC handler.
    """
    global _last_status, _sentry_initialized  # noqa: PLW0603

    if consent != "opt_in" or not dsn:
        if _sentry_initialized:
            _teardown()
        _last_status = TelemetryStatus(
            initialized=False,
            consent=consent,
            status="disabled",
            failure_reason=None if consent != "opt_in" else "telemetry_dsn_missing",
        )
        return

    validation_error = _validate_dsn(dsn)
    if validation_error is not None:
        if _sentry_initialized:
            _teardown()
        logger.warning("telemetry DSN rejected: %s", validation_error)
        _last_status = TelemetryStatus(
            initialized=False,
            consent=consent,
            status="invalid_dsn",
            failure_reason=validation_error,
        )
        return

    if _sentry_initialized:
        _last_status = TelemetryStatus(initialized=True, consent=consent, status="initialized")
        return

    try:
        import sentry_sdk  # type: ignore[import-not-found]

        sentry_sdk.init(
            dsn=dsn,
            release=app_version or None,
            environment="production",
            before_send=_before_send,
            max_breadcrumbs=20,
            auto_session_tracking=False,
            default_integrations=False,
        )
        _sentry_initialized = True
        _last_status = TelemetryStatus(initialized=True, consent=consent, status="initialized")
        logger.info("Sentry telemetry initialized (consent=opt_in)")
    except Exception as error:  # noqa: BLE001
        _last_status = TelemetryStatus(
            initialized=False,
            consent=consent,
            status="init_failed",
            failure_reason=type(error).__name__,
        )
        logger.info("telemetry disabled after init failure", exc_info=True)


def telemetry_status() -> dict[str, Any]:
    return _last_status.to_payload()


def capture_exception(error: Exception, context: dict[str, Any] | None = None) -> None:
    """Report an exception to Sentry if initialized."""
    if not _sentry_initialized:
        return
    try:
        import sentry_sdk  # type: ignore[import-not-found]

        sanitized = _sanitize_context(context) if context else None
        sentry_sdk.capture_exception(error, extra=sanitized)
    except Exception:  # noqa: BLE001
        pass


def _teardown() -> None:
    global _sentry_initialized  # noqa: PLW0603
    if not _sentry_initialized:
        return
    try:
        import sentry_sdk  # type: ignore[import-not-found]

        client = sentry_sdk.get_client()
        if client:
            client.close(timeout=2.0)
    except Exception:  # noqa: BLE001
        pass
    _sentry_initialized = False


def _before_send(
    event: dict[str, Any],
    hint: dict[str, Any],  # noqa: ARG001
) -> dict[str, Any] | None:
    """Redact secrets from Sentry event payloads before transmission."""
    event.pop("user", None)
    event.pop("request", None)
    for key in ("message", "transaction"):
        if isinstance(event.get(key), str):
            event[key] = _sanitize_telemetry_text(event[key])
    if "fingerprint" in event:
        event["fingerprint"] = _sanitize_telemetry_value(event["fingerprint"])
    for key in ("breadcrumbs", "tags", "contexts", "threads"):
        if key in event:
            event[key] = _sanitize_telemetry_value(event[key])
    _sanitize_exception_info(event)
    _sanitize_extra(event)
    return event


def _sanitize_exception_info(event: dict[str, Any]) -> None:
    exception_info = event.get("exception")
    if isinstance(exception_info, dict):
        values = exception_info.get("values")
        if isinstance(values, list):
            for exc in values:
                if isinstance(exc, dict):
                    val = exc.get("value")
                    if isinstance(val, str):
                        exc["value"] = _sanitize_telemetry_text(val)
                    if "stacktrace" in exc:
                        exc["stacktrace"] = _sanitize_telemetry_value(exc["stacktrace"])


def _sanitize_extra(event: dict[str, Any]) -> None:
    extra = event.get("extra")
    if isinstance(extra, dict):
        event["extra"] = _sanitize_context(extra)


def _validate_dsn(dsn: str) -> str | None:
    parsed = urlparse(str(dsn or "").strip())
    if parsed.scheme != "https":
        return "telemetry_dsn_scheme_not_allowed"
    hostname = str(parsed.hostname or "").lower()
    if not hostname:
        return "telemetry_dsn_host_missing"
    if hostname in _ALLOWED_DSN_EXACT_HOSTS:
        return None
    if not any(hostname.endswith(suffix) for suffix in _ALLOWED_DSN_HOST_SUFFIXES):
        return "telemetry_dsn_host_not_allowed"
    return None


def _sanitize_telemetry_text(value: str, *, limit: int = 256) -> str:
    sanitized = _sanitize_text(value, limit=limit)
    return _PATH_PATTERN.sub("[redacted:path]", sanitized)


def _sanitize_telemetry_value(value: Any, *, depth: int = 0) -> Any:
    if isinstance(value, str):
        return _sanitize_telemetry_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, dict):
        return _sanitize_telemetry_mapping(value, depth=depth)
    if isinstance(value, (list, tuple, set)):
        return _sanitize_telemetry_sequence(value, depth=depth)
    return _sanitize_telemetry_text(str(value))


def _sanitize_telemetry_mapping(value: dict[Any, Any], *, depth: int) -> dict[str, Any]:
    if depth >= _MAX_TELEMETRY_SANITIZE_DEPTH:
        return {"key_count": len(value)}
    return {
        str(key): (
            "[redacted]"
            if _is_sensitive_key(key)
            else _sanitize_telemetry_value(entry, depth=depth + 1)
        )
        for key, entry in value.items()
    }


def _sanitize_telemetry_sequence(
    value: list[Any] | tuple[Any, ...] | set[Any],
    *,
    depth: int,
) -> list[Any] | dict[str, int]:
    if depth >= _MAX_TELEMETRY_SANITIZE_DEPTH:
        return {"item_count": len(value)}
    return [_sanitize_telemetry_value(entry, depth=depth + 1) for entry in value]


def _sanitize_context(data: dict[str, Any]) -> dict[str, Any]:
    return _sanitize_telemetry_mapping(data, depth=0)
