'use strict';

// Shared result builders for Electron-side builtin tools so the unavailable,
// failure and argument-rejection shapes stay identical across tools.

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { manifestEntry } = require('../tool-manifest-index');

// The canonical manifest owns every model-facing description and schema;
// modules spread this instead of carrying literals that silently drift.
function manifestSchema(name) {
  const entry = manifestEntry(name);
  if (!entry) {
    throw new Error(`Tool "${name}" is missing from services/tools/tool-manifest.json.`);
  }
  return {
    description: entry.description,
    parameters: JSON.parse(JSON.stringify(entry.parameters)),
  };
}

function toolFailure(resultKind, {
  content,
  summary,
  reason = 'execution_failed',
  errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED,
  metadata = {},
} = {}) {
  return {
    content,
    summary,
    isError: true,
    errorCode,
    metadata: { result_kind: resultKind, reason, ...metadata },
  };
}

// The owning service (or a seam it needs) is not wired into this context.
function serviceUnavailable(resultKind, {
  label,
  content = 'Service is unavailable.',
  metadata = {},
} = {}) {
  return toolFailure(resultKind, {
    content,
    summary: `${label} unavailable`,
    reason: 'unavailable',
    errorCode: TOOL_ERROR_CODES.DISABLED,
    metadata: { unavailable: true, ...metadata },
  });
}

// Maps a service `{ success: false, message, reason, error_code }` result.
function serviceFailure(resultKind, result, {
  label,
  errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED,
  reason = 'execution_failed',
  content = '',
  metadata = {},
} = {}) {
  return toolFailure(resultKind, {
    content: result?.message || content || `${label} failed.`,
    summary: `${label} failed`,
    reason: result?.reason || reason,
    errorCode: result?.error_code || errorCode,
    metadata,
  });
}

function invalidArguments(resultKind, { label, content, metadata = {} } = {}) {
  return toolFailure(resultKind, {
    content,
    summary: `${label} failed`,
    reason: 'invalid_arguments',
    errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
    metadata,
  });
}

// Reads an optional/required string argument without coercing other types:
// `undefined`/`null` is absent; any non-string is `{ error }` (never
// stringified, so an object cannot become "[object Object]"). The value is
// trimmed; over-long values are rejected, not clamped.
function readStringArgument(input, key, { required = false, maxLength = Infinity } = {}) {
  const raw = input && typeof input === 'object' ? input[key] : undefined;
  if (raw === undefined || raw === null) {
    return required ? { error: `${key} is required.` } : { value: '' };
  }
  if (typeof raw !== 'string') {
    return { error: `${key} must be a string.` };
  }
  const value = raw.trim();
  if (required && !value) {
    return { error: `${key} is required.` };
  }
  if (value.length > maxLength) {
    return { error: `${key} exceeds the ${maxLength} character limit.` };
  }
  return { value };
}

// A string argument echoed into a summary line: never coerced, always bounded.
function summaryArgument(input, key, maxLength) {
  const raw = input && typeof input === 'object' ? input[key] : undefined;
  return typeof raw === 'string' ? raw.trim().slice(0, maxLength) : '';
}

// Clamping string normalizer: non-strings become '' (or null when required),
// and over-long text is cut to `limit`.
function boundedString(value, limit, { required = false } = {}) {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value.trim();
  if (required && !normalized) return null;
  return normalized.slice(0, limit);
}

function plural(count, noun, pluralNoun = `${noun}s`) {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

module.exports = {
  boundedString,
  invalidArguments,
  manifestSchema,
  plural,
  readStringArgument,
  serviceFailure,
  serviceUnavailable,
  summaryArgument,
  toolFailure,
};
