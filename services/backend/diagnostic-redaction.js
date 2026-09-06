'use strict';
// Backend composition-seam lane: shared helper (dev diagnostics + codex engine).
// Composed only via backend-service; not a directly-importable product module.
// See docs/architecture/BACKEND_SEAM_LANE.md.

const MAX_STRING_LENGTH = 40_000;
const SECRET_VALUE_PATTERN = /\b(?:bearer\s+[a-z0-9._~+/=-]{12,}|sk-proj-[a-z0-9_-]{12,}|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{20,})\b/giu;
const AUTH_ASSIGNMENT_PATTERN = /(?:authorization|api[_-]?key|x-api-key|token|secret|password)\s*[:=]\s*["']?[^"',\s}]{8,}/giu;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /\b[A-Z]:[\\/][^\s"',}]+/giu;
const POSIX_ABSOLUTE_PATH_PATTERN = /(^|[\s([])\/(?:Users|home|tmp|var|private|mnt|Volumes|workspace)\/[^\s"',)}]+/giu;

function redactDiagnosticString(value) {
  let text = String(value || '');
  text = text.replace(SECRET_VALUE_PATTERN, '[redacted-secret]');
  text = text.replace(AUTH_ASSIGNMENT_PATTERN, (match) => {
    const separator = match.includes('=') ? '=' : ':';
    const key = match.split(separator)[0].trim();
    return `${key}${separator}[redacted-secret]`;
  });
  text = text.replace(WINDOWS_ABSOLUTE_PATH_PATTERN, '[redacted-path]');
  text = text.replace(POSIX_ABSOLUTE_PATH_PATTERN, (_match, prefix) => `${prefix || ''}[redacted-path]`);
  return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}[truncated]` : text;
}

module.exports = {
  redactDiagnosticString,
};
