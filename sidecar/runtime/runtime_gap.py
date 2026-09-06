"""Versioned runtime-gap candidate notifications for Electron review."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from sidecar.ai.error_codes import (
    CMP_CFG_WORKSPACE_MISSING,
    CMP_CTX_SKILL_INVALID,
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_LOOP_MAX_ITERATIONS,
    CMP_MCP_CONFIG_INVALID,
    CMP_MCP_SSE_DISABLED,
    CMP_MCP_TOOL_NOT_FOUND,
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_DISABLED,
)
from sidecar.protocol import RUNTIME_GAP_CANDIDATE_METHOD
from sidecar.runtime.chat import ChatRequestError
from sidecar.runtime.rpc import notification
from sidecar.runtime.runtime_gap_schema import RUNTIME_GAP_SCHEMA_VERSION

RUNTIME_GAP_FINGERPRINT_VERSION = 1
RUNTIME_GAP_SOURCE_KIND = "deterministic"
RUNTIME_GAP_CATEGORY = "runtime_gap"
_MAX_SAFE_MESSAGE_CHARS = 280

_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{8,}")
_SECRETISH_RE = re.compile(r"\b[A-Za-z0-9_\-]{24,}\b")
_WINDOWS_PATH_RE = re.compile(
    r'(?:"[A-Za-z]:\\[^"\r\n]+"|\'[A-Za-z]:\\[^\'\r\n]+\'|'
    r'\b[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+(?: [^\s\\/:*?"<>|]+)*\\)*'
    r'[^\s\\/:*?"<>|]+)'
)
_UNIX_PATH_RE = re.compile(
    r'(?:"/(?:Users|home|var|tmp|private)/[^"\r\n]+"|'
    r"'/(?:Users|home|var|tmp|private)/[^'\r\n]+'|"
    r'(?<!\w)/(?:Users|home|var|tmp|private)/'
    r'(?:[^\r\n/"\']+/)*[^\s/"\']+)'
)


@dataclass(frozen=True)
class _GapMapping:
    detector_id: str
    feature_area: str
    confidence: float


_GAP_ALLOWLIST: dict[str, _GapMapping] = {
    CMP_MCP_CONFIG_INVALID: _GapMapping(
        detector_id="runtime.mcp.config_invalid",
        feature_area="mcp",
        confidence=0.98,
    ),
    CMP_MCP_SSE_DISABLED: _GapMapping(
        detector_id="runtime.mcp.sse_disabled",
        feature_area="mcp",
        confidence=0.99,
    ),
    CMP_MCP_TOOL_NOT_FOUND: _GapMapping(
        detector_id="runtime.mcp.tool_not_found",
        feature_area="mcp",
        confidence=0.95,
    ),
    CMP_CTX_SKILL_INVALID: _GapMapping(
        detector_id="runtime.context.skill_invalid",
        feature_area="context",
        confidence=0.93,
    ),
    CMP_CFG_WORKSPACE_MISSING: _GapMapping(
        detector_id="runtime.config.workspace_missing",
        feature_area="config",
        confidence=0.97,
    ),
    CMP_MODE_TOOL_BLOCKED: _GapMapping(
        detector_id="runtime.tools.mode_blocked",
        feature_area="tools",
        confidence=0.92,
    ),
    CMP_TOOL_DISABLED: _GapMapping(
        detector_id="runtime.tools.disabled",
        feature_area="tools",
        confidence=0.94,
    ),
    CMP_LOOP_INVALID_TOOL_CALL: _GapMapping(
        detector_id="runtime.agent_loop.invalid_tool_call",
        feature_area="agent_loop",
        confidence=0.94,
    ),
    CMP_LOOP_MAX_ITERATIONS: _GapMapping(
        detector_id="runtime.agent_loop.max_iterations",
        feature_area="agent_loop",
        confidence=0.9,
    ),
}


def build_runtime_gap_candidate_notification(
    error: ChatRequestError,
) -> dict[str, Any] | None:
    mapping = _GAP_ALLOWLIST.get(error.code)
    if mapping is None:
        return None

    occurred_at = _utc_now().isoformat()
    thread_id = error.session_id or error.request_id
    turn_id = error.request_id
    session_id = f"{thread_id}:{turn_id}"
    local_message = error.message.strip()
    safe_message = _redact_for_issue(local_message)
    subject = _subject_for_fingerprint(error.code, local_message)
    semantic_fingerprint = _build_semantic_fingerprint(
        detector_id=mapping.detector_id,
        reason_code=error.code,
        feature_area=mapping.feature_area,
        subject=subject,
    )

    return notification(
        RUNTIME_GAP_CANDIDATE_METHOD,
        {
            "schema_version": RUNTIME_GAP_SCHEMA_VERSION,
            "occurrence_id": f"gap-{uuid4()}",
            "semantic_fingerprint": semantic_fingerprint,
            "fingerprint_version": RUNTIME_GAP_FINGERPRINT_VERSION,
            "reason_code": error.code,
            "detector_id": mapping.detector_id,
            "source_kind": RUNTIME_GAP_SOURCE_KIND,
            "category": RUNTIME_GAP_CATEGORY,
            "confidence": mapping.confidence,
            "feature_area": mapping.feature_area,
            "first_seen_at": occurred_at,
            "last_seen_at": occurred_at,
            "thread_id": thread_id,
            "turn_id": turn_id,
            "session_id": session_id,
            "evidence_local": {
                "message": local_message,
                "request_id": error.request_id,
                "trace_id": error.trace_id,
                "session_id": error.session_id,
            },
            "evidence_issue_safe": {
                "message": safe_message,
                "reason_code": error.code,
                "feature_area": mapping.feature_area,
                "detector_id": mapping.detector_id,
            },
        },
    )


def _build_semantic_fingerprint(
    *,
    detector_id: str,
    reason_code: str,
    feature_area: str,
    subject: str | None,
) -> str:
    canonical_payload = {
        "category": RUNTIME_GAP_CATEGORY,
        "detector_id": detector_id,
        "feature_area": feature_area,
        "reason_code": reason_code,
        "subject": subject,
        "version": RUNTIME_GAP_FINGERPRINT_VERSION,
    }
    encoded = json.dumps(canonical_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _subject_for_fingerprint(reason_code: str, message: str) -> str | None:
    normalized = message.strip().lower()
    if not normalized:
        return None

    quoted = re.search(r"'([^']+)'", message)
    if quoted and quoted.group(1).strip():
        return _normalize_subject(quoted.group(1))

    double_quoted = re.search(r'"([^"]+)"', message)
    if double_quoted and double_quoted.group(1).strip():
        return _normalize_subject(double_quoted.group(1))

    if reason_code == CMP_LOOP_MAX_ITERATIONS:
        return "max_iterations"
    if reason_code == CMP_CFG_WORKSPACE_MISSING:
        return "workspace_missing"
    if reason_code == CMP_MCP_SSE_DISABLED:
        return "sse_disabled"

    return _normalize_subject(normalized)


def _normalize_subject(value: str) -> str:
    collapsed = re.sub(r"\s+", " ", value.strip().lower())
    safe = _redact_for_issue(collapsed)
    return safe[:80]


def _redact_for_issue(value: str) -> str:
    redacted = _EMAIL_RE.sub("[redacted-email]", value)
    redacted = _BEARER_RE.sub("Bearer [redacted-token]", redacted)
    redacted = _WINDOWS_PATH_RE.sub("[redacted-path]", redacted)
    redacted = _UNIX_PATH_RE.sub("[redacted-path]", redacted)
    redacted = _SECRETISH_RE.sub(_replace_secretish, redacted)
    if len(redacted) > _MAX_SAFE_MESSAGE_CHARS:
        return f"{redacted[: _MAX_SAFE_MESSAGE_CHARS - 3].rstrip()}..."
    return redacted


def _replace_secretish(match: re.Match[str]) -> str:
    token = match.group(0)
    if token.lower().startswith("cmp-"):
        return token
    if token.lower().startswith("req_") or token.lower().startswith("trace_"):
        return token
    return "[redacted-token]"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)
