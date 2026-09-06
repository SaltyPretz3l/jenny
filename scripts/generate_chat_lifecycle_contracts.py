"""Generate the cross-runtime Chat Lifecycle v2 contract validators."""

# Embedded JS/Python templates intentionally preserve generated-runtime layout.
# ruff: noqa: E501

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "config" / "chat-lifecycle-v2.schema.json"
JS_PATH = ROOT / "services" / "backend" / "generated-chat-lifecycle-contract.js"
PY_PATH = ROOT / "sidecar" / "ai" / "routing" / "generated_chat_lifecycle_contract.py"
RENDERER_PATH = ROOT / "renderer" / "chat" / "chat-terminal-status-vocabulary.js"

JS_RUNTIME = r'''

const IDENTIFIER_RE = new RegExp(SPEC.identifier.pattern);
const TERMINAL_STATUS_SET = new Set(SPEC.terminal.statuses);
const TERMINAL_STATUSES = new Set(SPEC.terminal.terminal_statuses);
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SENSITIVE_PATH_SEGMENT_RE = /(api[_-]?key|token|secret|password|credential)/i;

function isPlainObject(value) {
  if (!value || typeof value !== 'object'
    || Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (Object.getPrototypeOf(prototype) === null
    && typeof prototype.constructor === 'function'
    && prototype.constructor.name === 'Object');
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function truncateUtf8(value, maxBytes) {
  const limit = Math.max(Number(maxBytes) || 0, 0);
  let result = '';
  let used = 0;
  for (const codePoint of String(value || '')) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (used + size > limit) break;
    result += codePoint;
    used += size;
  }
  return result;
}

function boundDiagnosticPath(path) {
  const normalized = typeof path === 'string' && path.startsWith('$') ? path : '$';
  if (utf8Bytes(normalized) <= SPEC.structure.max_diagnostic_path_utf8_bytes) return normalized;
  return '$.[path-truncated]';
}

function appendDiagnosticPropertyPath(path, key) {
  if (path === '$.[path-truncated]') return path;
  const safeKey = typeof key === 'string'
    && SAFE_PATH_SEGMENT_RE.test(key)
    && !SENSITIVE_PATH_SEGMENT_RE.test(key)
    ? key
    : '[key]';
  return boundDiagnosticPath(`${path}.${safeKey}`);
}

function normalizeIdentifier(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return { ok: false, value: '', reason: 'identifier_not_string' };
  const normalized = value.trim();
  if (!normalized) {
    return allowEmpty
      ? { ok: true, value: '', reason: null }
      : { ok: false, value: '', reason: 'identifier_empty' };
  }
  if (utf8Bytes(normalized) > SPEC.identifier.max_utf8_bytes) {
    return { ok: false, value: '', reason: 'identifier_too_large' };
  }
  if (!IDENTIFIER_RE.test(normalized)) {
    return { ok: false, value: '', reason: 'identifier_invalid_grammar' };
  }
  return { ok: true, value: normalized, reason: null };
}

function inspectStructure(value, { maxBytes = SPEC.structure.max_payload_utf8_bytes } = {}) {
  const seen = new WeakSet();
  const stack = [{ value, path: '$', depth: 0 }];
  let nodeCount = 0;
  while (stack.length) {
    const current = stack.pop();
    nodeCount += 1;
    if (nodeCount > SPEC.structure.max_nodes) return failure('node_budget_exceeded', current.path);
    if (current.depth > SPEC.structure.max_depth) return failure('depth_budget_exceeded', current.path);
    const item = current.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return failure('nonfinite_number', current.path);
      continue;
    }
    if (typeof item !== 'object') return failure('unsupported_value_type', current.path);
    if (seen.has(item)) return failure('cycle_detected', current.path);
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > SPEC.structure.max_array_items) return failure('array_budget_exceeded', current.path);
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], path: boundDiagnosticPath(`${current.path}[${index}]`), depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(item)) return failure('unsupported_object_type', current.path);
    const keys = Object.keys(item);
    if (keys.length > SPEC.structure.max_object_keys) return failure('key_budget_exceeded', current.path);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      stack.push({ value: item[key], path: appendDiagnosticPropertyPath(current.path, key), depth: current.depth + 1 });
    }
  }
  const byteCount = utf8Bytes(JSON.stringify(value));
  if (byteCount > maxBytes) return failure('payload_byte_budget_exceeded', '$', byteCount);
  return { ok: true, reason: null, path: null, nodeCount, byteCount };
}

function failure(reason, path, byteCount = null) {
  return { ok: false, reason, path: boundDiagnosticPath(path), nodeCount: null, byteCount };
}

function sanitizeStructure(value, { sanitizeString = String, redactKey = () => null } = {}) {
  const seen = new WeakSet();
  let nodes = 0;
  let failureReason = null;
  function visit(item, depth, key = '') {
    nodes += 1;
    if (nodes > SPEC.structure.max_nodes) { failureReason = 'node_budget_exceeded'; return null; }
    if (depth > SPEC.structure.max_depth) { failureReason = 'depth_budget_exceeded'; return null; }
    const redacted = redactKey(key);
    if (redacted != null) return redacted;
    if (typeof item === 'string') return sanitizeString(item);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (typeof item !== 'object') return null;
    if (seen.has(item)) { failureReason = 'cycle_detected'; return null; }
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > SPEC.structure.max_array_items) { failureReason = 'array_budget_exceeded'; return null; }
      const result = item.map((entry) => visit(entry, depth + 1));
      seen.delete(item);
      return result;
    }
    if (!isPlainObject(item)) { failureReason = 'unsupported_object_type'; return null; }
    const keys = Object.keys(item);
    if (keys.length > SPEC.structure.max_object_keys) { failureReason = 'key_budget_exceeded'; return null; }
    const result = {};
    for (const rawKey of keys) {
      const normalizedKey = truncateUtf8(rawKey.split(/\s+/).filter(Boolean).join(' '), 80);
      if (!normalizedKey || Object.hasOwn(result, normalizedKey)) continue;
      result[normalizedKey] = visit(item[rawKey], depth + 1, rawKey);
      if (failureReason) break;
    }
    seen.delete(item);
    return result;
  }
  const sanitized = visit(value, 0);
  if (failureReason) {
    return { value: { truncated: true, summary: '[truncated:structure]' }, reason: failureReason };
  }
  if (utf8Bytes(JSON.stringify(sanitized)) > SPEC.structure.max_payload_utf8_bytes) {
    return { value: { truncated: true, summary: '[truncated:event-payload]' }, reason: 'payload_byte_budget_exceeded' };
  }
  return { value: sanitized, reason: null };
}

function normalizeTerminalStatus(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') return 'unknown';
  const normalized = raw.trim().toLowerCase().replace(/[\s.-]+/g, '_');
  if (!normalized) return '';
  if (TERMINAL_STATUS_SET.has(normalized)) return normalized;
  return SPEC.terminal.aliases[normalized] || 'unknown';
}

function validateChatStartPayload(value, { requireEditedMessageId = false } = {}) {
  const structural = inspectStructure(value, { maxBytes: SPEC.chat_start.max_payload_utf8_bytes });
  if (!structural.ok) return chatFailure(structural.reason, structural.path, structural.byteCount);
  if (!isPlainObject(value)) return chatFailure('payload_not_object', '$');
  for (const key of Object.keys(value)) {
    if (!SPEC.chat_start.allowed_fields.includes(key)) return chatFailure('unknown_field', '$.[unknown]');
  }
  if (typeof value.prompt !== 'string') return chatFailure('field_not_string', '$.prompt');
  if (requireEditedMessageId && !Object.hasOwn(value, 'editedMessageId')) {
    return chatFailure('field_required', '$.editedMessageId');
  }
  const normalized = { ...value };
  for (const field of SPEC.chat_start.identifier_fields) {
    if (!Object.hasOwn(value, field)) continue;
    const result = normalizeIdentifier(value[field], { allowEmpty: field === 'sessionId' });
    if (!result.ok) return chatFailure(result.reason, `$.${field}`);
    normalized[field] = result.value;
  }
  for (const field of SPEC.chat_start.string_fields) {
    if (Object.hasOwn(value, field) && typeof value[field] !== 'string') return chatFailure('field_not_string', `$.${field}`);
  }
  for (const field of SPEC.chat_start.object_fields) {
    if (Object.hasOwn(value, field) && value[field] !== null && !isPlainObject(value[field])) return chatFailure('field_not_object', `$.${field}`);
  }
  for (const field of SPEC.chat_start.array_fields) {
    if (Object.hasOwn(value, field) && !Array.isArray(value[field])) return chatFailure('field_not_array', `$.${field}`);
  }
  if ((value.attachments || []).length > SPEC.chat_start.max_attachments) return chatFailure('attachment_budget_exceeded', '$.attachments');
  if ((value.mentionContents || []).length > SPEC.chat_start.max_mentions) return chatFailure('mention_budget_exceeded', '$.mentionContents');
  if (Object.hasOwn(value, 'planMode') && typeof value.planMode !== 'boolean') return chatFailure('field_not_boolean', '$.planMode');
  if (Object.hasOwn(value, 'failureRetry') && typeof value.failureRetry !== 'boolean') return chatFailure('field_not_boolean', '$.failureRetry');
  if (Object.hasOwn(value, 'interactiveRoundCount') && (!Number.isSafeInteger(value.interactiveRoundCount) || value.interactiveRoundCount < 0)) {
    return chatFailure('field_not_nonnegative_integer', '$.interactiveRoundCount');
  }
  if (isPlainObject(value.clientTiming)) {
    for (const [key, timing] of Object.entries(value.clientTiming)) {
      if (typeof timing !== 'number' || !Number.isFinite(timing) || timing < 0) {
        return chatFailure('invalid_timing', appendDiagnosticPropertyPath('$.clientTiming', key));
      }
    }
  }
  return { ok: true, value: normalized, error: null, byteCount: structural.byteCount };
}

function chatFailure(reason, path, byteCount = null) {
  return {
    ok: false,
    value: null,
    error: { code: CHAT_PROTOCOL_ERROR_CODES.INVALID_PAYLOAD, reason, path: boundDiagnosticPath(path), byte_count: byteCount },
  };
}

module.exports = {
  CONTRACT_VERSION: SPEC.contract_version,
  IDENTIFIER_SPEC: SPEC.identifier,
  STRUCTURAL_BUDGETS: SPEC.structure,
  TERMINAL_ALIASES: SPEC.terminal.aliases,
  TERMINAL_STATUSES,
  inspectStructure,
  isPlainObject,
  normalizeIdentifier,
  normalizeTerminalStatus,
  sanitizeStructure,
  truncateUtf8,
  utf8Bytes,
  validateChatStartPayload,
};
'''

PY_RUNTIME = r'''

IDENTIFIER_PATTERN = re.compile(str(SPEC["identifier"]["pattern"]))
TERMINAL_STATUSES = frozenset(SPEC["terminal"]["terminal_statuses"])


def utf8_bytes(value: Any) -> int:
    return len(str(value).encode("utf-8"))


def truncate_utf8(value: Any, max_bytes: int) -> str:
    remaining = max(int(max_bytes), 0)
    result: list[str] = []
    for code_point in str(value or ""):
        size = len(code_point.encode("utf-8"))
        if size > remaining:
            break
        result.append(code_point)
        remaining -= size
    return "".join(result)


def normalize_identifier(value: Any, *, allow_empty: bool = False) -> tuple[bool, str, str | None]:
    if not isinstance(value, str):
        return False, "", "identifier_not_string"
    normalized = value.strip()
    if not normalized:
        return (True, "", None) if allow_empty else (False, "", "identifier_empty")
    if utf8_bytes(normalized) > int(SPEC["identifier"]["max_utf8_bytes"]):
        return False, "", "identifier_too_large"
    if IDENTIFIER_PATTERN.fullmatch(normalized) is None:
        return False, "", "identifier_invalid_grammar"
    return True, normalized, None


def sanitize_structure(
    value: Any,
    *,
    sanitize_string: Callable[[str], str] = str,
    redact_key: Callable[[str], str | None] = lambda _key: None,
) -> tuple[Any, str | None]:
    seen: set[int] = set()
    nodes = 0
    failure_reason: str | None = None
    budgets = SPEC["structure"]

    def visit(item: Any, depth: int, key: str = "") -> Any:
        nonlocal nodes, failure_reason
        nodes += 1
        if nodes > int(budgets["max_nodes"]):
            failure_reason = "node_budget_exceeded"
            return None
        if depth > int(budgets["max_depth"]):
            failure_reason = "depth_budget_exceeded"
            return None
        redacted = redact_key(key)
        if redacted is not None:
            return redacted
        if isinstance(item, str):
            return sanitize_string(item)
        if item is None or isinstance(item, bool):
            return item
        if isinstance(item, (int, float)):
            return item if not isinstance(item, float) or math.isfinite(item) else None
        if not isinstance(item, (Mapping, list, tuple)):
            return None
        identity = id(item)
        if identity in seen:
            failure_reason = "cycle_detected"
            return None
        seen.add(identity)
        if isinstance(item, (list, tuple)):
            if len(item) > int(budgets["max_array_items"]):
                failure_reason = "array_budget_exceeded"
                seen.discard(identity)
                return None
            list_result = [visit(entry, depth + 1) for entry in item]
            seen.discard(identity)
            return list_result
        if len(item) > int(budgets["max_object_keys"]):
            failure_reason = "key_budget_exceeded"
            seen.discard(identity)
            return None
        object_result: dict[str, Any] = {}
        for raw_key, item_value in item.items():
            if not isinstance(raw_key, str):
                continue
            normalized_key = truncate_utf8(" ".join(raw_key.split()), 80)
            if not normalized_key or normalized_key in object_result:
                continue
            object_result[normalized_key] = visit(item_value, depth + 1, raw_key)
            if failure_reason is not None:
                break
        seen.discard(identity)
        return object_result

    sanitized = visit(value, 0)
    if failure_reason is not None:
        return {"truncated": True, "summary": "[truncated:structure]"}, failure_reason
    encoded = json.dumps(
        sanitized, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    if len(encoded) > int(budgets["max_payload_utf8_bytes"]):
        return {"truncated": True, "summary": "[truncated:event-payload]"}, "payload_byte_budget_exceeded"
    return sanitized, None


def normalize_terminal_status(raw: Any) -> str:
    if raw is None or raw == "":
        return ""
    if not isinstance(raw, str):
        return "unknown"
    normalized = re.sub(r"[\s.-]+", "_", raw.strip().lower())
    if not normalized:
        return ""
    if normalized in SPEC["terminal"]["statuses"]:
        return normalized
    return str(SPEC["terminal"]["aliases"].get(normalized, "unknown"))
'''


def _load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _js_source(schema: dict) -> str:
    embedded = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
    return (
        "'use strict';\n\n"
        "// Generated by scripts/generate_chat_lifecycle_contracts.py.\n"
        "const { CHAT_PROTOCOL_ERROR_CODES } = require('./error-codes');\n"
        f"const SPEC = Object.freeze({embedded});\n"
        + JS_RUNTIME.lstrip()
    )


def _python_source(schema: dict) -> str:
    embedded = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
    header = (
        '"""Generated Chat Lifecycle v2 contract. Do not edit by hand."""\n\n'
        "# ruff: noqa: E501, C901, PLR0911, PLR0912\n\n"
        "from __future__ import annotations\n\n"
        "import json\nimport math\nimport re\n"
        "from typing import Any, Callable, Mapping\n\n"
        f"SPEC = json.loads({embedded!r})\n"
    )
    return header + PY_RUNTIME.lstrip()


def _renderer_source(schema: dict) -> str:
    terminal = schema["terminal"]
    statuses = json.dumps(terminal["statuses"], separators=(",", ":"))
    terminal_statuses = json.dumps(terminal["terminal_statuses"], separators=(",", ":"))
    aliases = json.dumps(terminal["aliases"], separators=(",", ":"))
    return f"""/* Generated by scripts/generate_chat_lifecycle_contracts.py. */
(function (root, factory) {{
  if (typeof module === 'object' && module.exports) {{ module.exports = factory(); return; }}
  root.chatTerminalStatusVocabulary = factory();
}})(typeof globalThis !== 'undefined' ? globalThis : this, function () {{
  'use strict';
  const STREAMING_STATUS = 'streaming', COMPLETE_STATUS = 'complete', ERROR_STATUS = 'error';
  const CANCELLED_STATUS = 'cancelled', DENIED_STATUS = 'denied', TIMEOUT_STATUS = 'timeout';
  const PREEMPTED_STATUS = 'preempted', INTERRUPTED_STATUS = 'interrupted', UNKNOWN_STATUS = 'unknown';
  const CANONICAL_TERMINAL_STATUSES = new Set({statuses});
  const TERMINAL_STATUSES = new Set({terminal_statuses});
  const ALIASES = new Map(Object.entries({aliases}));
  function normalizeTerminalStatus(raw) {{
    if (raw == null || raw === '') return '';
    if (typeof raw !== 'string') return UNKNOWN_STATUS;
    const normalized = raw.trim().toLowerCase().replace(/[\\s.-]+/g, '_');
    if (!normalized) return '';
    if (CANONICAL_TERMINAL_STATUSES.has(normalized)) return normalized;
    return ALIASES.get(normalized) || UNKNOWN_STATUS;
  }}
  function isTerminalStatus(value) {{ return TERMINAL_STATUSES.has(value); }}
  function coarseRenderStatus(value) {{
    if (value === '' || value === STREAMING_STATUS || value === COMPLETE_STATUS || value === UNKNOWN_STATUS) return value;
    return TERMINAL_STATUSES.has(value) ? ERROR_STATUS : UNKNOWN_STATUS;
  }}
  return {{ STREAMING_STATUS, COMPLETE_STATUS, ERROR_STATUS, CANCELLED_STATUS, DENIED_STATUS,
    TIMEOUT_STATUS, PREEMPTED_STATUS, INTERRUPTED_STATUS, UNKNOWN_STATUS,
    CANONICAL_TERMINAL_STATUSES, TERMINAL_STATUSES, ALIASES,
    normalizeTerminalStatus, isTerminalStatus, coarseRenderStatus }};
}});
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    schema = _load_schema()
    expected = {
        JS_PATH: _js_source(schema),
        PY_PATH: _python_source(schema),
        RENDERER_PATH: _renderer_source(schema),
    }
    stale = [path for path, content in expected.items() if not path.exists() or path.read_text(encoding="utf-8") != content]
    if args.check:
        if stale:
            print("Generated Chat Lifecycle contract is stale:", *(str(path.relative_to(ROOT)) for path in stale))
            return 1
        return 0
    for path, content in expected.items():
        path.write_text(content, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
