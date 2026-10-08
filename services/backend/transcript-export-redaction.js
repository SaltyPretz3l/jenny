'use strict';

// Host-path anonymisation for transcripts that LEAVE the app (HB-012).
//
// Owner rule (2026-09-28): real absolute paths are presented everywhere inside
// Jenny — the timeline, the persisted session and the model's history — and
// path redaction exists only for transparent anonymisation when the user
// exports a transcript. These rules therefore run at the export boundary
// (services/save-file-handler.js), never at persist time. Session exports also
// redact secrets here before serialization; persisted message text may contain
// secrets even though canonical turn-event payloads have persist-time redaction.
//
// The rules are the ones the canonical turn-event contract applied to every
// persisted payload string before HB-012 (moved from
// services/backend/canonical-turn-event.js), so an export reads exactly as a
// persisted transcript used to: the final segment of a path survives so a
// reader can still follow which file was touched. Order matters — file URL,
// drive letter, then POSIX. The POSIX rules are ROOT-ANCHORED because exports
// carry assistant prose and code, where an unanchored rule mangles route
// strings (app.get('/api/users'), "GET /api/users"). Host filesystem roots
// are the privacy payload; route-shaped slash strings are content.

const REDACTED_PATH_TOKEN = '[redacted:path]';
const REDACTED_SECRET_TOKEN = '[redacted:secret]';
const SECRET_VALUE_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}|\bbasic\s+[A-Za-z0-9+/=]{8,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9_-]{20,}|\b(?:sk|pk|tok|ghp|gho)_[A-Za-z0-9_-]{8,}/gi;
// The key may be JSON-quoted (`"api_key": "..."`): an optional closing quote sits between the key and the separator.
const SECRET_ASSIGNMENT_RE = /\b((?:authorization|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password)["']?\s*[:=]\s*["']?)[^\s"',{}]{8,}/gi;
const SECRET_KEYS = new Set(['authorization', 'api_key', 'apikey', 'x_api_key',
  'access_token', 'refresh_token', 'client_secret', 'password', 'secret']);
const WINDOWS_PATH_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'<>|]+/g;
const FILE_URL_RE = /(?<![A-Za-z0-9_])file:\/\/[^\s"'<>|]+/gi;
const UNIX_PATH_RE = /(^|[\s(])\/(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)(?:\/[^\s"'<>|]+|(?=$|[\s)"'<>|,]))/g;
const UNIX_PATH_AFTER_DELIMITER_RE = /(["':=,])\/(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)(?:\/[^\s"'<>|]+|(?=$|[\s)"'<>|,]))/g;
const JSON_EXPORT_FORMATS = new Set(['json', 'session-json']);

function redactExportSecrets(text) {
  return String(text ?? '')
    .replace(SECRET_VALUE_RE, REDACTED_SECRET_TOKEN)
    .replace(SECRET_ASSIGNMENT_RE, (_match, prefix) => `${prefix}${REDACTED_SECRET_TOKEN}`);
}

function redactExportSecretsInValue(value) {
  if (typeof value === 'string') return redactExportSecrets(value);
  if (Array.isArray(value)) return value.map((entry) => redactExportSecretsInValue(entry));
  if (value && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const redacted = {};
    for (const [key, entry] of Object.entries(value)) {
      const passthrough = key === '_exportedData' || key === 'assetPath';
      const secret = SECRET_KEYS.has(key.toLowerCase().replaceAll('-', '_'))
        && typeof entry === 'string' && entry.length > 0;
      Object.defineProperty(redacted, key, {
        value: passthrough ? entry : secret ? REDACTED_SECRET_TOKEN : redactExportSecretsInValue(entry),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return redacted;
  }
  return value;
}

function finalSegmentOf(segments) {
  return Array.from(segments.at(-1)).slice(0, 80).join('');
}

function redactPosixPath(match, prefix) {
  const path = match.slice(prefix.length);
  const trailingSeparator = path.endsWith('/') && path.length > 1 ? '/' : '';
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 1) return `${prefix}${REDACTED_PATH_TOKEN}`;
  return `${prefix}${REDACTED_PATH_TOKEN}/${finalSegmentOf(segments)}${trailingSeparator}`;
}

function redactTranscriptPaths(value) {
  return String(value ?? '')
    .replace(FILE_URL_RE, (match) => {
      const remainder = match.slice('file://'.length);
      const segments = remainder.split('/').filter(Boolean);
      if (segments.length && (/^[A-Za-z]:$/.test(segments[0]) || !remainder.startsWith('/'))) {
        segments.shift();
      }
      if (segments.length <= 1) return `file:///${REDACTED_PATH_TOKEN}`;
      const trailingSeparator = match.endsWith('/') ? '/' : '';
      return `file:///${REDACTED_PATH_TOKEN}/${finalSegmentOf(segments)}${trailingSeparator}`;
    })
    .replace(WINDOWS_PATH_RE, (match) => {
      const trailingSeparator = /[\\/]$/.test(match) ? match.at(-1) : '';
      const path = trailingSeparator ? match.slice(0, -1) : match;
      const segments = path.slice(3).split(/[\\/]/).filter(Boolean);
      if (segments.length <= 1) return REDACTED_PATH_TOKEN;
      const separator = path[Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))];
      return `${REDACTED_PATH_TOKEN}${separator}${finalSegmentOf(segments)}${trailingSeparator}`;
    })
    .replace(UNIX_PATH_RE, redactPosixPath)
    .replace(UNIX_PATH_AFTER_DELIMITER_RE, redactPosixPath);
}

// Structural walk for JSON exports: redacting the serialized text would read
// the JSON escape of a Windows separator ("G:\\x") as part of the path and
// could emit an invalid escape, so strings are redacted before serializing.
function redactTranscriptPathsInValue(value) {
  if (typeof value === 'string') return redactTranscriptPaths(value);
  if (Array.isArray(value)) return value.map((entry) => redactTranscriptPathsInValue(entry));
  if (value && typeof value === 'object') {
    const redacted = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(redacted, redactTranscriptPaths(key), {
        value: redactTranscriptPathsInValue(entry),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return redacted;
  }
  return value;
}

function redactTranscriptExportContent(content, format) {
  const text = String(content ?? '');
  if (!JSON_EXPORT_FORMATS.has(String(format || '').trim().toLowerCase())) {
    return redactTranscriptPaths(text);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    // Not JSON after all: anonymise the text rather than export it raw.
    return redactTranscriptPaths(text);
  }
  const indent = text.includes('\n') ? 2 : 0;
  return JSON.stringify(redactTranscriptPathsInValue(parsed), null, indent);
}

module.exports = {
  REDACTED_PATH_TOKEN,
  REDACTED_SECRET_TOKEN,
  redactExportSecrets,
  redactExportSecretsInValue,
  redactTranscriptPaths,
  redactTranscriptPathsInValue,
  redactTranscriptExportContent,
};
