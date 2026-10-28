'use strict';

/* services/primary-chat-contract.js - wire shapes for the primaryChat.* bridge
 * (row 76). Closed request schemas (exact key sets, `schema_version: 1`), the
 * common `{schema_version:1, ok, ...}` envelope and the stable reason enum.
 * Pure: no I/O, no logging. Unknown keys, malformed ids and out-of-range numbers
 * fail closed; `reason` is always a stable token, never exception prose, and no
 * envelope carries chat titles, message text or paths on a failure.
 */

const { PRIMARY_ERROR_CODES: CODES } = require('./backend/error-codes');

const SCHEMA_VERSION = 1;
const ACTIVITY_DEFAULT_LIMIT = 60;
const ACTIVITY_MAX_LIMIT = 200;
const PROJECT_ID_MAX = 128;
const MAX_CHILDREN_MAX = 3;
const RUN_MODES = Object.freeze(['ask', 'auto', 'plan', 'propose']);
const PERMISSION_ID_PATTERN = /^lp_[0-9a-f]{32}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

// reason -> [error code, retryable]. Anything unlisted degrades to UNAVAILABLE.
const REASON_CLASSES = Object.freeze({
  invalid_request: [CODES.INVALID_REQUEST, false],
  unknown_project: [CODES.UNKNOWN_PROJECT, false],
  unavailable: [CODES.UNAVAILABLE, true],
  disabled: [CODES.DISABLED, false],
  not_found: [CODES.NOT_FOUND, false],
  session_busy: [CODES.BUSY, true],
  capacity: [CODES.CAPACITY, false],
  copy_failed: [CODES.COPY_FAILED, false],
});

function fail(reason, { retryable = null } = {}) {
  const token = typeof reason === 'string' && Object.hasOwn(REASON_CLASSES, reason) ? reason : 'unavailable';
  const [code, defaultRetryable] = REASON_CLASSES[token];
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    code,
    reason: token,
    retryable: typeof retryable === 'boolean' ? retryable : defaultRetryable,
  };
}

function succeed(payload) {
  return { schema_version: SCHEMA_VERSION, ok: true, ...payload };
}

const INVALID = Object.freeze({ ok: false, reason: 'invalid_request' });
const ok = (value) => ({ ok: true, value });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// A closed request: a plain object, `schema_version` 1, and only the listed keys.
function closed(raw, optional = []) {
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION) return false;
  const allowed = new Set(['schema_version', ...optional]);
  return Object.keys(raw).every((key) => allowed.has(key));
}

const hasControlChar = (text) => [...text].some((char) => char.codePointAt(0) < 0x20 || char.codePointAt(0) === 0x7f);
const has = (raw, key) => Object.hasOwn(raw, key);

function validateEmptyRequest(raw) {
  return closed(raw) ? ok({}) : INVALID;
}

function validateActivityRequest(raw) {
  if (!closed(raw, ['limit', 'before'])) return INVALID;
  let limit = ACTIVITY_DEFAULT_LIMIT;
  if (has(raw, 'limit')) {
    if (!Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > ACTIVITY_MAX_LIMIT) return INVALID;
    limit = raw.limit;
  }
  let before = null;
  if (has(raw, 'before') && raw.before !== null) {
    if (typeof raw.before !== 'string' || !ISO_PATTERN.test(raw.before) || Number.isNaN(Date.parse(raw.before))) return INVALID;
    before = raw.before;
  }
  return ok({ limit, before });
}

function validProjectId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= PROJECT_ID_MAX && !hasControlChar(value);
}

function validRunModes(value) {
  return Array.isArray(value) && value.length >= 1 && value.every((mode) => RUN_MODES.includes(mode))
    && new Set(value).size === value.length;
}

function validateGrantLaunchRequest(raw) {
  if (!closed(raw, ['project_id', 'run_modes', 'max_children_per_turn']) || !has(raw, 'project_id')
    || !validProjectId(raw.project_id)) return INVALID;
  let runModes = null;
  if (has(raw, 'run_modes') && raw.run_modes !== null) {
    if (!validRunModes(raw.run_modes)) return INVALID;
    runModes = [...raw.run_modes];
  }
  let maxChildren = 1;
  if (has(raw, 'max_children_per_turn')) {
    if (!Number.isSafeInteger(raw.max_children_per_turn) || raw.max_children_per_turn < 1
      || raw.max_children_per_turn > MAX_CHILDREN_MAX) return INVALID;
    maxChildren = raw.max_children_per_turn;
  }
  return ok({ project_id: raw.project_id, run_modes: runModes, max_children_per_turn: maxChildren });
}

function validateRevokeLaunchRequest(raw) {
  if (!closed(raw, ['permission_id']) || !has(raw, 'permission_id')
    || typeof raw.permission_id !== 'string' || !PERMISSION_ID_PATTERN.test(raw.permission_id)) return INVALID;
  return ok({ permission_id: raw.permission_id });
}

function validateResetRequest(raw) {
  if (!closed(raw, ['forget', 'keep_copy', 'memory_opt_out'])) return INVALID;
  const flag = (key, fallback) => (has(raw, key) ? raw[key] : fallback);
  const forget = flag('forget', false);
  const keepCopy = flag('keep_copy', true);
  const optOut = flag('memory_opt_out', false);
  if ([forget, keepCopy, optOut].some((value) => typeof value !== 'boolean')) return INVALID;
  return ok({ forget, keep_copy: keepCopy, memory_opt_out: optOut });
}

module.exports = {
  SCHEMA_VERSION,
  RUN_MODES,
  REASON_CLASSES,
  fail,
  succeed,
  validateEmptyRequest,
  validateActivityRequest,
  validateGrantLaunchRequest,
  validateRevokeLaunchRequest,
  validateResetRequest,
};
