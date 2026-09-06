const { LOOP_PROTOCOL_ERROR_CODES } = require('./error-codes');

// Pure tool-input redaction and sanitization helpers with no service or session state.

const REDACTED_PATH_TOKEN = '[redacted:path]';
const REDACTED_VALUE_TOKEN = '[redacted]';
const MAX_TOOL_INPUT_JSON_CHARS = 2048;
const MAX_TOOL_INPUT_STRING_CHARS = 512;
const MAX_TOOL_INPUT_DEPTH = 6;
const MAX_TOOL_INPUT_OBJECT_KEYS = 64;
const MAX_TOOL_INPUT_ARRAY_ITEMS = 64;
const MAX_APPROVAL_POLICY_TEXT_CHARS = 120;
const MAX_APPROVAL_REASON_CHARS = 512;
const WINDOWS_PATH_RE = /\b[A-Za-z]:[\\/][^\s"'`<>|]+/g;
const UNIX_PATH_RE = /(^|[\s(])\/[^\s"'`<>|]+/g;
// Platform parity: file:// URLs carry a host filesystem path on every OS, but
// WINDOWS_PATH_RE only caught the drive-letter form (file:///C:/…) while the
// POSIX form (file:///Users/…) sailed through. Handle the whole file URL
// first, normalized to the historical Windows presentation. The (?!\/) guard
// on the delimiter rule keeps scheme separators (https://…) legible; a
// path-shaped value elsewhere in a URL (e.g. ?redirect=/etc/passwd) still
// redacts, which errs on the private side. Quote characters sit in the
// delimiter class so JSON-quoted POSIX values match like their Windows twins.
const FILE_URL_RE = /\bfile:\/\/[^\s"'`<>|]+/gi;
const UNIX_PATH_AFTER_DELIMITER_RE = /(["':=,])\/(?!\/)[^\s"'`<>|]+/g;
const SENSITIVE_INPUT_KEY_RE = /(token|secret|password|api[_-]?key|authorization|auth[_-]?token|cookie)/i;
const SENSITIVE_ASSIGNMENT_RE = /((?:"|')?(?:token|secret|password|api[_-]?key|authorization|auth[_-]?token|cookie)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;
const SENSITIVE_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

function redactPathLikeText(value) {
  const text = String(value || '');
  return text
    .replace(FILE_URL_RE, (match) => {
      const remainder = match.slice('file://'.length);
      const segments = remainder.split('/').filter(Boolean);
      if (segments.length && (/^[A-Za-z]:$/.test(segments[0]) || !remainder.startsWith('/'))) {
        segments.shift();
      }
      if (segments.length <= 1) return `file:///${REDACTED_PATH_TOKEN}`;
      const trailingSeparator = match.endsWith('/') ? '/' : '';
      const finalSegment = Array.from(segments.at(-1)).slice(0, 80).join('');
      return `file:///${REDACTED_PATH_TOKEN}/${finalSegment}${trailingSeparator}`;
    })
    .replace(WINDOWS_PATH_RE, (match) => {
      const trailingSeparator = /[\\/]$/.test(match) ? match.at(-1) : '';
      const path = trailingSeparator ? match.slice(0, -1) : match;
      const segments = path.slice(3).split(/[\\/]/).filter(Boolean);
      if (segments.length <= 1) return REDACTED_PATH_TOKEN;
      const separator = path[Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))];
      const finalSegment = Array.from(segments.at(-1)).slice(0, 80).join('');
      return `${REDACTED_PATH_TOKEN}${separator}${finalSegment}${trailingSeparator}`;
    })
    .replace(UNIX_PATH_RE, (match, prefix) => {
      const path = match.slice(prefix.length);
      const trailingSeparator = path.endsWith('/') && path.length > 1 ? '/' : '';
      const segments = path.split('/').filter(Boolean);
      if (segments.length <= 1) return `${prefix}${REDACTED_PATH_TOKEN}`;
      const finalSegment = Array.from(segments.at(-1)).slice(0, 80).join('');
      return `${prefix}${REDACTED_PATH_TOKEN}/${finalSegment}${trailingSeparator}`;
    })
    .replace(UNIX_PATH_AFTER_DELIMITER_RE, (match, prefix) => {
      const path = match.slice(prefix.length);
      const trailingSeparator = path.endsWith('/') && path.length > 1 ? '/' : '';
      const segments = path.split('/').filter(Boolean);
      if (segments.length <= 1) return `${prefix}${REDACTED_PATH_TOKEN}`;
      const finalSegment = Array.from(segments.at(-1)).slice(0, 80).join('');
      return `${prefix}${REDACTED_PATH_TOKEN}/${finalSegment}${trailingSeparator}`;
    });
}

function redactSensitiveLikeText(value) {
  return redactPathLikeText(value)
    .replace(SENSITIVE_ASSIGNMENT_RE, `$1"${REDACTED_VALUE_TOKEN}"`)
    .replace(BEARER_TOKEN_RE, REDACTED_VALUE_TOKEN)
    .replace(SENSITIVE_VALUE_RE, REDACTED_VALUE_TOKEN);
}

function sanitizeToolSummary(value) {
  const redacted = redactSensitiveLikeText(value);
  return redacted.length > MAX_TOOL_INPUT_STRING_CHARS
    ? `${redacted.slice(0, MAX_TOOL_INPUT_STRING_CHARS)}...`
    : redacted;
}

function sanitizeApprovalPolicyText(value) {
  if (typeof value !== 'string') return '';
  const normalized = redactSensitiveLikeText(value).replace(/\s+/g, ' ').trim();
  return Array.from(normalized).slice(0, MAX_APPROVAL_POLICY_TEXT_CHARS).join('');
}

function sanitizeApprovalReason(value) {
  if (typeof value !== 'string') return '';
  // Bidi overrides and other format controls could reorder the sentence the
  // user is approving; the renderer strips them too, but a persisted reason
  // must already be clean.
  const normalized = redactSensitiveLikeText(value)
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  const characters = Array.from(normalized);
  return characters.length > MAX_APPROVAL_REASON_CHARS
    ? `${characters.slice(0, MAX_APPROVAL_REASON_CHARS).join('')}...`
    : normalized;
}

function defineSanitizedProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function sanitizeToolInputValue(value, depth = 0) {
  if (depth >= MAX_TOOL_INPUT_DEPTH) {
    return '[truncated]';
  }
  if (typeof value === 'string') {
    const redacted = redactSensitiveLikeText(value);
    return redacted.length > MAX_TOOL_INPUT_STRING_CHARS
      ? `${redacted.slice(0, MAX_TOOL_INPUT_STRING_CHARS)}...`
      : redacted;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'boolean' || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_TOOL_INPUT_ARRAY_ITEMS)
      .map((entry) => sanitizeToolInputValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const sanitized = {};
    let count = 0;
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (count >= MAX_TOOL_INPUT_OBJECT_KEYS) {
        break;
      }
      const normalizedKey = String(entryKey || '');
      if (!normalizedKey) {
        continue;
      }
      if (SENSITIVE_INPUT_KEY_RE.test(normalizedKey)) {
        defineSanitizedProperty(sanitized, normalizedKey, REDACTED_VALUE_TOKEN);
        count += 1;
        continue;
      }
      defineSanitizedProperty(
        sanitized,
        normalizedKey,
        sanitizeToolInputValue(entryValue, depth + 1)
      );
      count += 1;
    }
    return sanitized;
  }
  return String(value);
}

function buildPersistedToolInputSnapshot(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sanitizedInput = sanitizeToolInputValue(source);
  let inputJson;
  try {
    inputJson = JSON.stringify(sanitizedInput);
  } catch (_error) {
    inputJson = '{}';
  }
  if (inputJson.length > MAX_TOOL_INPUT_JSON_CHARS) {
    inputJson = JSON.stringify({
      truncated: true,
      preview: `${inputJson.slice(0, MAX_TOOL_INPUT_JSON_CHARS - 24)}...`,
    });
  }
  return {
    input: sanitizedInput && typeof sanitizedInput === 'object' && !Array.isArray(sanitizedInput)
      ? sanitizedInput
      : {},
    inputJson,
  };
}

function buildRedactedRawArgumentsPreview(rawArguments) {
  const preview = redactSensitiveLikeText(rawArguments);
  if (preview.length <= MAX_TOOL_INPUT_STRING_CHARS) {
    return preview;
  }
  return `${preview.slice(0, MAX_TOOL_INPUT_STRING_CHARS)}...`;
}

function buildInvalidToolArgumentsMessage(toolName, rawArguments) {
  const safeToolName = String(toolName || 'unknown_tool').trim() || 'unknown_tool';
  const safeRawArgumentsPreview = buildRedactedRawArgumentsPreview(rawArguments);
  return [
    `${LOOP_PROTOCOL_ERROR_CODES.INVALID_TOOL_CALL} Tool "${safeToolName}" was not executed because its arguments could not be parsed as JSON.`,
    `Arguments preview: ${safeRawArgumentsPreview || '(empty)'}`,
  ].join('\n');
}

function normalizeGeneratedArtifactsFromToolResult(result) {
  const entries = Array.isArray(result?.metadata?.generatedArtifacts)
    ? result.metadata.generatedArtifacts
    : [];
  return entries
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const hasLocalTrusted = Object.prototype.hasOwnProperty.call(entry, 'local_trusted');
      const hasTrustedLocalPath = Object.prototype.hasOwnProperty.call(entry, 'trusted_local_path');
      return {
        artifact_id: String(entry.artifact_id || '').trim(),
        artifact_kind: String(entry.artifact_kind || '').trim(),
        title: String(entry.title || '').trim(),
        file_name: String(entry.file_name || '').trim(),
        display_path: String(entry.display_path || '').trim(),
        absolute_path: String(entry.absolute_path || '').trim() ? REDACTED_PATH_TOKEN : '',
        language: String(entry.language || '').trim(),
        mime_type: String(entry.mime_type || entry.mimeType || '').trim(),
        width: Math.max(Number(entry.width || 0), 0),
        height: Math.max(Number(entry.height || 0), 0),
        editable: entry.editable !== false,
        status: String(entry.status || 'available').trim(),
        ...(hasLocalTrusted ? { local_trusted: entry.local_trusted === true } : {}),
        ...(hasTrustedLocalPath ? { trusted_local_path: entry.trusted_local_path === true } : {}),
      };
    })
    .filter((entry) => (
      entry.artifact_id
      && entry.title
      && entry.file_name
      && entry.display_path
      && entry.absolute_path
    ));
}

module.exports = {
  REDACTED_PATH_TOKEN,
  redactPathLikeText,
  redactSensitiveLikeText,
  sanitizeApprovalReason,
  sanitizeApprovalPolicyText,
  sanitizeToolSummary,
  sanitizeToolInputValue,
  buildPersistedToolInputSnapshot,
  buildRedactedRawArgumentsPreview,
  buildInvalidToolArgumentsMessage,
  normalizeGeneratedArtifactsFromToolResult,
};
