"""Canonical turn-event contract helpers."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Mapping

from sidecar.ai.routing.generated_chat_lifecycle_contract import (
    SPEC as LIFECYCLE_SPEC,
)
from sidecar.ai.routing.generated_chat_lifecycle_contract import (
    normalize_identifier,
    sanitize_structure,
    truncate_utf8,
    utf8_bytes,
)

CANONICAL_TURN_SCHEMA_VERSION = 1

EVENT_CAPS: dict[str, int] = {
    "id": int(LIFECYCLE_SPEC["identifier"]["max_utf8_bytes"]),
    "type": 64,
    "summary": 240,
    "approval_policy_text": 120,
    "status_text": 1000,
    "text_delta": 8192,
    "reasoning_delta": 4096,
    "tool_input_summary": 8192,
    "tool_output_summary": 16384,
    "event_payload_bytes": 32768,
}

CANONICAL_TURN_COUNTER_FIELDS: tuple[str, ...] = (
    "canonical_events_emitted",
    "legacy_notifications_emitted",
    "canonical_event_bytes",
    "legacy_notification_bytes",
    "sidecar_notification_to_electron_ms",
    "electron_ingest_to_renderer_commit_ms",
    "orphan_tool_repair_count",
    "live_replay_divergence_count",
    "unknown_or_dropped_canonical_event_count",
)

DURABLE_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "turn_started",
        "text_part_completed",
        "reasoning_part_completed",
        "tool_call_requested",
        "tool_execution_started",
        "tool_execution_completed",
        "tool_execution_failed",
        "tool_approval_requested",
        "tool_approval_resolved",
        "status_part",
        "turn_completed",
        "turn_failed",
        "turn_cancelled",
    }
)

EPHEMERAL_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "text_part_started",
        "text_delta",
        "reasoning_part_started",
        "reasoning_delta",
        "tool_input_started",
        "tool_input_delta",
        "tool_input_ended",
        "tool_execution_progress",
    }
)

CANONICAL_EVENT_TYPES: frozenset[str] = DURABLE_EVENT_TYPES | EPHEMERAL_EVENT_TYPES

_PART_KIND_BY_TYPE: dict[str, str] = {
    "text_part_started": "text_part",
    "text_delta": "text_part",
    "text_part_completed": "text_part",
    "reasoning_part_started": "reasoning_part",
    "reasoning_delta": "reasoning_part",
    "reasoning_part_completed": "reasoning_part",
    "tool_input_started": "tool_part",
    "tool_input_delta": "tool_part",
    "tool_input_ended": "tool_part",
    "tool_call_requested": "tool_part",
    "tool_execution_started": "tool_part",
    "tool_execution_progress": "tool_part",
    "tool_execution_completed": "tool_part",
    "tool_execution_failed": "tool_part",
    "tool_approval_requested": "tool_part",
    "tool_approval_resolved": "tool_part",
    "status_part": "status_part",
    "turn_failed": "status_part",
    "turn_cancelled": "status_part",
}

_PART_STATE_BY_TYPE: dict[str, str] = {
    "text_part_started": "started",
    "text_delta": "streaming",
    "text_part_completed": "completed",
    "reasoning_part_started": "started",
    "reasoning_delta": "streaming",
    "reasoning_part_completed": "completed",
    "tool_input_started": "input_started",
    "tool_input_delta": "input_streaming",
    "tool_input_ended": "input_completed",
    "tool_call_requested": "pending",
    "tool_execution_started": "running",
    "tool_execution_progress": "running",
    "tool_execution_completed": "completed",
    "tool_execution_failed": "error",
    "tool_approval_requested": "approval_pending",
    "tool_approval_resolved": "approval_resolved",
    "status_part": "status",
    "turn_failed": "error",
    "turn_cancelled": "cancelled",
}

_PERSISTED_KIND_BY_TYPE: dict[str, str | None] = {
    "text_part_completed": "assistant_text_segment",
    "reasoning_part_completed": "reasoning_phase",
    "tool_call_requested": "tool_use",
    "tool_execution_started": "tool_executing",
    "tool_execution_completed": "tool_result",
    "tool_execution_failed": "tool_result",
    "tool_approval_requested": "approval_requested",
    "tool_approval_resolved": "approval_resolved",
    "turn_failed": "assistant_error",
    "turn_cancelled": "assistant_error",
}

# Durable types that deliberately produce NO persisted timeline row. Every
# DURABLE_EVENT_TYPES member must appear either here or in
# _PERSISTED_KIND_BY_TYPE; the contract tests enforce the partition.
UNPERSISTED_DURABLE_TYPES: frozenset[str] = frozenset(
    {
        # Turn boundary metadata rides the finalized turn envelope; a row would duplicate it.
        "turn_started",
        "turn_completed",
        # Transient status lines never persist; rehydrate has no timeline row to render for them.
        "status_part",
    }
)

_DROPPED_KEYS: frozenset[str] = frozenset(
    {
        "diagnostics",
        "provider_metadata",
        "providermetadata",
        "raw_provider_metadata",
        "rawprovidermetadata",
        "prompt",
        "system_prompt",
        "systemprompt",
        "raw_prompt",
        "rawprompt",
    }
)
_SECRET_KEY_RE = re.compile(r"(api[_-]?key|token|secret|password|credential)", re.I)
_DATA_URI_RE = re.compile(r"data:[a-z0-9.+-]+/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+", re.I)
# Path redaction, ported from the tool-loop rules fixed in 224aa0c6
# (services/backend/tool-loop-input-sanitization.js): the drive-letter rule was
# the only deliberate catch here, so bare POSIX paths rode verbatim into
# persisted turn events on macOS/Linux, while file:// and http(s) URLs were
# mangled by accident (the unguarded rule read the "e:/" inside "file:/").
# Order matters — file URL, drive letter, then POSIX at a delimiter. Quotes
# sit in the delimiter class so JSON-quoted POSIX values match their Windows
# twins. Unlike the tool-loop rules, the POSIX rules here are ROOT-ANCHORED
# (telemetry.py / runtime_gap.py precedent): this sanitizer runs over EVERY
# payload string including assistant text/reasoning deltas, where an
# unanchored rule mangles ordinary code and prose (app.get('/api/users'),
# "GET /api/users") into [redacted:path]. Host filesystem roots are the
# privacy payload; route-shaped slash strings are content.
# Lookbehind rather than \b, whose Unicode semantics differ across the two
# runtimes; these mirrors must stay byte-identical. Behavior table:
# tests/fixtures/canonical-turn-events/cases.json.
# Mirrored by services/backend/canonical-turn-event.js; keep in sync.
_WINDOWS_PATH_RE = re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s\"'<>|]+")
_FILE_URL_RE = re.compile(r"(?<![A-Za-z0-9_])file://[^\s\"'<>|]+", re.I)
_UNIX_PATH_RE = re.compile(
    r"(^|[\s(])/(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)"
    r"(?:/[^\s\"'<>|]+|(?=$|[\s)\"'<>|,]))"
)
_UNIX_PATH_AFTER_DELIMITER_RE = re.compile(
    r"([\"':=,])/(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)"
    r"(?:/[^\s\"'<>|]+|(?=$|[\s)\"'<>|,]))"
)
_SECRET_VALUE_RE = re.compile(r"\b(?:sk|pk|tok|ghp|gho)_[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{8,}")


@dataclass(frozen=True)
class CanonicalTurnEvent:
    v: int
    turn_id: str
    seq: int
    type: str
    event_id: str
    part_id: str
    durability: str
    payload: dict[str, Any]
    stream_id: str = ""
    session_id: str = ""
    tool_call_id: str = ""
    ts: str = ""

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "v": self.v,
            "turn_id": self.turn_id,
            "seq": self.seq,
            "type": self.type,
            "event_id": self.event_id,
            "part_id": self.part_id,
            "durability": self.durability,
            "payload": dict(self.payload),
        }
        if self.stream_id:
            payload["stream_id"] = self.stream_id
        if self.session_id:
            payload["session_id"] = self.session_id
        if self.tool_call_id:
            payload["tool_call_id"] = self.tool_call_id
        if self.ts:
            payload["ts"] = self.ts
        return payload


@dataclass(frozen=True)
class TurnEventValidationResult:
    status: str
    event: CanonicalTurnEvent | None = None
    diagnostics: tuple[dict[str, Any], ...] = ()

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "event": self.event.to_payload() if self.event is not None else None,
            "diagnostics": [dict(item) for item in self.diagnostics],
        }


def _normalize_token(value: Any, *, limit: int | None = None, lower: bool = False) -> str:
    text = " ".join(value.split()) if isinstance(value, str) else ""
    if lower:
        text = text.lower()
    cap = EVENT_CAPS["id"] if limit is None else max(int(limit), 0)
    return truncate_utf8(text, cap)


def _normalize_id(value: Any) -> str:
    ok, normalized, _reason = normalize_identifier(value)
    return normalized if ok else ""


# CTL-015: "positive integer" must mean the same thing here and in the
# JavaScript twin (canonical-turn-event.js coerceSeq/coerceVersion): a
# non-boolean number, finite, integral, within [1, 2^53-1]. Integral floats
# are accepted because a JSON ``5.0`` parses to a float here but to the
# integer-valued Number 5 in JavaScript; strings ("42", "1junk"), booleans,
# fractional and non-finite values are all malformed input. The shared
# fixture table in tests/fixtures/canonical-turn-events/cases.json pins the
# verdicts for both runtimes. Type-checking first also removes the previous
# uncaught ``OverflowError`` from ``int(float("inf"))``.
_MAX_CANONICAL_INT = 2**53 - 1


def _coerce_canonical_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            return None
        value = int(value)
    return value if abs(value) <= _MAX_CANONICAL_INT else None


def _coerce_seq(value: Any) -> int | None:
    seq = _coerce_canonical_int(value)
    return seq if seq is not None and seq >= 1 else None


def _coerce_version(value: Any) -> int | None:
    return _coerce_canonical_int(value)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _diagnostic(code: str, **fields: Any) -> dict[str, Any]:
    result: dict[str, Any] = {"code": _normalize_token(code, limit=64, lower=True)}
    for key, value in fields.items():
        if value is None:
            continue
        if isinstance(value, str):
            result[key] = _normalize_token(value, limit=240)
        elif isinstance(value, (int, float, bool)):
            result[key] = value
    return result


def _sanitize_string(value: str) -> str:
    def redact_file_url(match: re.Match[str]) -> str:
        remainder = match.group(0)[len("file://") :]
        segments = [segment for segment in remainder.split("/") if segment]
        if segments and (re.fullmatch(r"[A-Za-z]:", segments[0]) or not remainder.startswith("/")):
            segments.pop(0)
        if len(segments) <= 1:
            return "file:///[redacted:path]"
        trailing_separator = "/" if match.group(0).endswith("/") else ""
        return f"file:///[redacted:path]/{segments[-1][:80]}{trailing_separator}"

    def redact_windows_path(match: re.Match[str]) -> str:
        matched_path = match.group(0)
        trailing_separator = matched_path[-1] if matched_path[-1] in "\\/" else ""
        path = matched_path[:-1] if trailing_separator else matched_path
        segments = [segment for segment in re.split(r"[\\/]", path[3:]) if segment]
        if len(segments) <= 1:
            return "[redacted:path]"
        separator = path[max(path.rfind("/"), path.rfind("\\"))]
        return f"[redacted:path]{separator}{segments[-1][:80]}{trailing_separator}"

    def redact_unix_path(match: re.Match[str]) -> str:
        prefix = match.group(1)
        path = match.group(0)[len(prefix) :]
        trailing_separator = "/" if path.endswith("/") and len(path) > 1 else ""
        segments = [segment for segment in path.split("/") if segment]
        if len(segments) <= 1:
            return f"{prefix}[redacted:path]"
        return f"{prefix}[redacted:path]/{segments[-1][:80]}{trailing_separator}"

    text = str(value or "")
    text = _DATA_URI_RE.sub("[redacted:data-uri]", text)
    text = _FILE_URL_RE.sub(redact_file_url, text)
    text = _WINDOWS_PATH_RE.sub(redact_windows_path, text)
    text = _UNIX_PATH_RE.sub(redact_unix_path, text)
    text = _UNIX_PATH_AFTER_DELIMITER_RE.sub(redact_unix_path, text)
    text = _SECRET_VALUE_RE.sub("[redacted:secret]", text)
    return text


def _redacted_value_for_key(normalized_key: str) -> str | None:
    compact_key = normalized_key.replace("_", "")
    if compact_key in _DROPPED_KEYS:
        return "[redacted]"
    if _SECRET_KEY_RE.search(normalized_key):
        return "[redacted:secret]"
    return None


# Display-only fields get a visible truncation marker inside the byte cap.
# The fields named here stay unmarked: delta/text chunks concatenate (or
# round-trip) downstream and an injected marker would corrupt the
# reassembled content. Mirrored by services/backend/canonical-turn-event.js;
# keep in sync.
_MARKERLESS_FIELDS = frozenset({"delta", "text", "arguments_delta"})
_TRUNCATION_MARKER = "…"
_TRUNCATION_MARKER_BYTES = len(_TRUNCATION_MARKER.encode("utf-8"))


def _cap_string_field(
    payload: dict[str, Any],
    *,
    key: str,
    limit: int,
    diagnostics: list[dict[str, Any]],
) -> None:
    value = payload.get(key)
    if not isinstance(value, str) or utf8_bytes(value) <= limit:
        return
    if key not in _MARKERLESS_FIELDS and limit > _TRUNCATION_MARKER_BYTES:
        payload[key] = truncate_utf8(value, limit - _TRUNCATION_MARKER_BYTES) + _TRUNCATION_MARKER
    else:
        payload[key] = truncate_utf8(value, limit)
    diagnostics.append(_diagnostic("payload_truncated", field=key, limit=limit))


def _cap_payload_by_event_type(
    event_type: str,
    payload: dict[str, Any],
    diagnostics: list[dict[str, Any]],
) -> None:
    if event_type == "text_delta":
        _cap_string_field(
            payload,
            key="delta",
            limit=EVENT_CAPS["text_delta"],
            diagnostics=diagnostics,
        )
    if event_type in {"reasoning_delta", "reasoning_part_completed"}:
        _cap_string_field(
            payload,
            key="delta",
            limit=EVENT_CAPS["reasoning_delta"],
            diagnostics=diagnostics,
        )
        _cap_string_field(
            payload,
            key="text",
            limit=EVENT_CAPS["reasoning_delta"],
            diagnostics=diagnostics,
        )


def _cap_payload_named_fields(
    payload: dict[str, Any],
    diagnostics: list[dict[str, Any]],
) -> None:
    field_groups = (
        (("summary", "tool_name"), "summary"),
        (("policy_scope", "policy_consequence"), "approval_policy_text"),
        (("status_text", "message"), "status_text"),
        (("tool_input_summary", "arguments_delta"), "tool_input_summary"),
        (("tool_output_summary", "output_summary"), "tool_output_summary"),
    )
    for keys, cap_name in field_groups:
        for key in keys:
            if key in payload:
                _cap_string_field(
                    payload,
                    key=key,
                    limit=EVENT_CAPS[cap_name],
                    diagnostics=diagnostics,
                )


def _cap_payload(
    event_type: str,
    payload: Mapping[str, Any],
) -> tuple[dict[str, Any], tuple[dict[str, Any], ...]]:
    diagnostics: list[dict[str, Any]] = []
    sanitized, structure_reason = sanitize_structure(
        dict(payload),
        sanitize_string=_sanitize_string,
        redact_key=lambda key: _redacted_value_for_key(
            _normalize_token(key, limit=80, lower=True).replace("-", "_")
        ),
    )
    if structure_reason is not None:
        diagnostics.append(
            _diagnostic("structure_budget_exceeded", reason=structure_reason)
        )
    if not isinstance(sanitized, dict):
        sanitized = {}

    _cap_payload_by_event_type(event_type, sanitized, diagnostics)
    _cap_payload_named_fields(sanitized, diagnostics)

    # The generated structural sanitizer guarantees finiteness; allow_nan=False
    # confirms no non-finite float can reach byte measurement.
    encoded = json.dumps(
        sanitized, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    if len(encoded) > EVENT_CAPS["event_payload_bytes"]:
        diagnostics.append(
            _diagnostic(
                "event_payload_truncated",
                limit=EVENT_CAPS["event_payload_bytes"],
            )
        )
        sanitized = {
            "truncated": True,
            "summary": "[truncated:event-payload]",
        }
    return sanitized, tuple(diagnostics)


def _durability_for(event_type: str, payload: Mapping[str, Any]) -> str:
    if event_type == "reasoning_part_completed" and payload.get("persist") is False:
        return "ephemeral"
    if event_type in DURABLE_EVENT_TYPES:
        return "durable"
    return "ephemeral"


def _part_kind_for(event_type: str) -> str:
    return _PART_KIND_BY_TYPE.get(event_type, "")


def _part_id_for(turn_id: str, event_type: str, seq: int, provided: Any = None) -> str:
    explicit = _normalize_id(provided)
    if explicit:
        return explicit
    part_kind = _part_kind_for(event_type)
    return f"{turn_id}:{part_kind}:{seq}" if part_kind else ""


def build_canonical_turn_event(  # noqa: PLR0913 - mirrors canonical event fields.
    *,
    event_type: str,
    turn_id: str,
    seq: int,
    payload: Mapping[str, Any] | None = None,
    stream_id: str = "",
    session_id: str = "",
    event_id: str = "",
    part_id: str = "",
    tool_call_id: str = "",
    ts: str = "",
) -> CanonicalTurnEvent:
    normalized_type = _normalize_token(event_type, limit=EVENT_CAPS["type"], lower=True)
    normalized_turn_id = _normalize_id(turn_id)
    normalized_seq = _coerce_seq(seq) or 1
    sanitized_payload, _diagnostics = _cap_payload(normalized_type, payload or {})
    return CanonicalTurnEvent(
        v=CANONICAL_TURN_SCHEMA_VERSION,
        turn_id=normalized_turn_id,
        stream_id=_normalize_id(stream_id),
        session_id=_normalize_id(session_id),
        seq=normalized_seq,
        type=normalized_type,
        event_id=(
            _normalize_id(event_id)
            or f"{normalized_turn_id}:canonical:{normalized_seq}"
        ),
        part_id=_part_id_for(normalized_turn_id, normalized_type, normalized_seq, part_id),
        tool_call_id=_normalize_id(tool_call_id),
        ts=_normalize_token(ts, limit=64) or _now_iso(),
        durability=_durability_for(normalized_type, sanitized_payload),
        payload=sanitized_payload,
    )


def validate_turn_event(value: Any) -> TurnEventValidationResult:
    if not isinstance(value, Mapping):
        return TurnEventValidationResult(
            status="dropped",
            diagnostics=(_diagnostic("event_not_object"),),
        )
    version = _coerce_version(value.get("v"))
    if version != CANONICAL_TURN_SCHEMA_VERSION:
        return TurnEventValidationResult(
            status="unsupported",
            diagnostics=(
                _diagnostic(
                    "unsupported_version",
                    version=version if version is not None else -1,
                ),
            ),
        )
    turn_id = _normalize_id(value.get("turn_id") or value.get("turnId"))
    if not turn_id:
        return TurnEventValidationResult(
            status="dropped",
            diagnostics=(_diagnostic("missing_turn_id"),),
        )
    seq = _coerce_seq(value.get("seq") or value.get("sequence"))
    if seq is None:
        return TurnEventValidationResult(
            status="dropped",
            diagnostics=(_diagnostic("invalid_seq"),),
        )
    event_type = _normalize_token(
        value.get("type") or value.get("event_type") or value.get("eventType"),
        limit=EVENT_CAPS["type"],
        lower=True,
    )
    if event_type not in CANONICAL_EVENT_TYPES:
        return TurnEventValidationResult(
            status="unsupported",
            diagnostics=(
                _diagnostic("unsupported_event_type", event_type=event_type or "missing"),
            ),
        )
    source_payload = value.get("payload")
    payload = source_payload if isinstance(source_payload, Mapping) else {}
    sanitized_payload, diagnostics = _cap_payload(event_type, payload)
    event = CanonicalTurnEvent(
        v=CANONICAL_TURN_SCHEMA_VERSION,
        turn_id=turn_id,
        stream_id=_normalize_id(value.get("stream_id") or value.get("streamId")),
        session_id=_normalize_id(value.get("session_id") or value.get("sessionId")),
        seq=seq,
        type=event_type,
        event_id=(
            _normalize_id(value.get("event_id") or value.get("eventId"))
            or f"{turn_id}:canonical:{seq}"
        ),
        part_id=_part_id_for(
            turn_id,
            event_type,
            seq,
            value.get("part_id") or value.get("partId"),
        ),
        tool_call_id=_normalize_id(value.get("tool_call_id") or value.get("toolCallId")),
        ts=_normalize_token(value.get("ts"), limit=64) or _now_iso(),
        durability=_durability_for(event_type, sanitized_payload),
        payload=sanitized_payload,
    )
    return TurnEventValidationResult(
        status="accepted",
        event=event,
        diagnostics=diagnostics,
    )


def reduce_to_turn_event_kind(event: CanonicalTurnEvent | Mapping[str, Any]) -> str | None:
    event_type = _normalize_token(
        getattr(event, "type", None)
        if isinstance(event, CanonicalTurnEvent)
        else event.get("type"),
        limit=EVENT_CAPS["type"],
        lower=True,
    )
    durability = (
        getattr(event, "durability", "")
        if isinstance(event, CanonicalTurnEvent)
        else _normalize_token(event.get("durability"), lower=True)
    )
    if durability != "durable":
        return None
    return _PERSISTED_KIND_BY_TYPE.get(event_type)


def reduce_to_semantic_part(event: CanonicalTurnEvent | Mapping[str, Any]) -> dict[str, Any] | None:
    if isinstance(event, CanonicalTurnEvent):
        event_type = event.type
        part_id = event.part_id
        turn_id = event.turn_id
        tool_call_id = event.tool_call_id
        payload = event.payload
        durability = event.durability
    else:
        event_type = _normalize_token(event.get("type"), limit=EVENT_CAPS["type"], lower=True)
        part_id = _normalize_id(event.get("part_id") or event.get("partId"))
        turn_id = _normalize_id(event.get("turn_id") or event.get("turnId"))
        tool_call_id = _normalize_id(event.get("tool_call_id") or event.get("toolCallId"))
        payload_source = event.get("payload")
        payload = dict(payload_source) if isinstance(payload_source, Mapping) else {}
        durability = _normalize_token(event.get("durability"), lower=True)
    part_kind = _part_kind_for(event_type)
    if not part_kind:
        return None
    result: dict[str, Any] = {
        "part_id": part_id,
        "part_kind": part_kind,
        "state": _PART_STATE_BY_TYPE.get(event_type, "unknown"),
        "turn_id": turn_id,
        "durability": durability or _durability_for(event_type, payload),
        "payload": dict(payload),
    }
    if tool_call_id:
        result["tool_call_id"] = tool_call_id
    return result


__all__ = [
    "CANONICAL_EVENT_TYPES",
    "CANONICAL_TURN_COUNTER_FIELDS",
    "CANONICAL_TURN_SCHEMA_VERSION",
    "DURABLE_EVENT_TYPES",
    "EPHEMERAL_EVENT_TYPES",
    "EVENT_CAPS",
    "UNPERSISTED_DURABLE_TYPES",
    "CanonicalTurnEvent",
    "TurnEventValidationResult",
    "build_canonical_turn_event",
    "reduce_to_semantic_part",
    "reduce_to_turn_event_kind",
    "validate_turn_event",
]
