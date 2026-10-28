'use strict';

/* services/shell-config-primary-chat.js - the `primaryChat` shell-config block
 * (row 76): `{schemaVersion:1, pausedAt, launchPermissions, history}`. It holds the
 * profile's one primary Jenny chat's pause flag, its standing launch permissions
 * (D4 record, snake_case on the wire like the message grants) and a short control
 * history. Invalid entries are dropped, never repaired. A block written by a NEWER
 * build (schemaVersion > 1) is preserved verbatim and treated read-only here, so an
 * older build never rewrites it. Additive: no CONFIG_VERSION bump; excluded from the
 * portable-preferences export (permissions belong to this machine). It owns shape
 * and bounds only; the controls service (primary-chat-controls.js) owns the rules.
 */

const SCHEMA_VERSION = 1;
const PRIMARY_LAUNCH_RUN_MODES = Object.freeze(['ask', 'auto', 'plan', 'propose']);
const PRIMARY_CHAT_HISTORY_KINDS = Object.freeze([
  'paused', 'resumed', 'reset', 'forgot', 'permission_granted', 'permission_revoked',
]);
const PRIMARY_CHAT_LIMITS = Object.freeze({
  permissions_max: 32,
  history_max: 50,
  revoked_retention_ms: 30 * 24 * 60 * 60 * 1000,
  project_id_chars: 128,
  max_children_per_turn_max: 3,
});
const DEFAULT_PRIMARY_CHAT = Object.freeze({
  schemaVersion: SCHEMA_VERSION, pausedAt: null, launchPermissions: Object.freeze([]), history: Object.freeze([]),
});

const PERMISSION_ID = /^lp_[0-9a-f]{32}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// True when the stored block belongs to a newer schema than this build understands.
function isReadOnlyPrimaryChat(value) {
  return isRecord(value) && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion > SCHEMA_VERSION;
}

// `YYYY-MM-DDTHH:MM:SS.mmmZ` that is a real instant (the round trip rejects 2026-13-45).
function isIsoInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPermissionId(value) {
  return typeof value === 'string' && PERMISSION_ID.test(value);
}

function hasControlChars(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function normalizeProjectId(value) {
  if (value === '*') return '*';
  if (typeof value !== 'string' || !value || value.length > PRIMARY_CHAT_LIMITS.project_id_chars) return null;
  return hasControlChars(value) ? null : value;
}

// Sorted, unique, known run modes; null (every mode) stays null; anything else is invalid (undefined).
function normalizeRunModes(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const unique = new Set(value);
  if (unique.size !== value.length) return undefined;
  if (!value.every((mode) => PRIMARY_LAUNCH_RUN_MODES.includes(mode))) return undefined;
  return PRIMARY_LAUNCH_RUN_MODES.filter((mode) => unique.has(mode));
}

function normalizeLaunchPermission(value) {
  if (!isRecord(value)) return null;
  const projectId = normalizeProjectId(value.project_id);
  const runModes = normalizeRunModes(value.run_modes);
  const cap = value.max_children_per_turn;
  const capOk = Number.isSafeInteger(cap) && cap >= 1 && cap <= PRIMARY_CHAT_LIMITS.max_children_per_turn_max;
  const revokedOk = value.revoked_at === null || isIsoInstant(value.revoked_at);
  if (!isPermissionId(value.permission_id) || projectId === null || runModes === undefined || !capOk
    || !isIsoInstant(value.created_at) || !revokedOk) return null;
  return {
    permission_id: value.permission_id,
    project_id: projectId,
    run_modes: runModes,
    max_children_per_turn: cap,
    created_at: value.created_at,
    revoked_at: value.revoked_at,
  };
}

function isLivePermission(record) {
  return isRecord(record) && record.revoked_at === null;
}

function normalizePermissions(value) {
  const seen = new Set();
  const records = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const record = normalizeLaunchPermission(entry);
    if (!record || seen.has(record.permission_id)) continue;
    seen.add(record.permission_id);
    records.push(record);
  }
  if (records.length <= PRIMARY_CHAT_LIMITS.permissions_max) return records;
  // Over the cap: keep the newest by created_at, in their stored order.
  const newest = new Set([...records]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, PRIMARY_CHAT_LIMITS.permissions_max));
  return records.filter((record) => newest.has(record));
}

function normalizeHistoryEntry(value) {
  if (!isRecord(value) || !PRIMARY_CHAT_HISTORY_KINDS.includes(value.kind) || !isIsoInstant(value.at)) return null;
  if (value.permission_id === undefined) return { kind: value.kind, at: value.at };
  if (!isPermissionId(value.permission_id)) return null;
  return { kind: value.kind, at: value.at, permission_id: value.permission_id };
}

function normalizeHistory(value) {
  const entries = (Array.isArray(value) ? value : []).map(normalizeHistoryEntry).filter(Boolean)
    .sort((left, right) => left.at.localeCompare(right.at)); // stable: oldest first
  return entries.slice(-PRIMARY_CHAT_LIMITS.history_max);
}

function normalizePrimaryChat(value) {
  if (isReadOnlyPrimaryChat(value)) return JSON.parse(JSON.stringify(value));
  const source = isRecord(value) ? value : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    pausedAt: isIsoInstant(source.pausedAt) ? source.pausedAt : null,
    launchPermissions: normalizePermissions(source.launchPermissions),
    history: normalizeHistory(source.history),
  };
}

// Merge a `{pausedAt?, launchPermissions?, history?}` patch (shallow, then normalized). A read-only
// (future-version) block is returned untouched, so the write becomes a no-op. A patch cannot set the version.
function applyPrimaryChatPatch(current, patch) {
  if (isReadOnlyPrimaryChat(current)) return current;
  const { schemaVersion: _ignored, ...fields } = isRecord(patch) ? patch : {};
  return normalizePrimaryChat({ ...normalizePrimaryChat(current), ...fields });
}

module.exports = {
  DEFAULT_PRIMARY_CHAT,
  PRIMARY_CHAT_HISTORY_KINDS,
  PRIMARY_CHAT_LIMITS,
  PRIMARY_LAUNCH_RUN_MODES,
  SCHEMA_VERSION,
  applyPrimaryChatPatch,
  isIsoInstant,
  isLivePermission,
  isPermissionId,
  isReadOnlyPrimaryChat,
  normalizeLaunchPermission,
  normalizePrimaryChat,
  normalizeProjectId,
  normalizeRunModes,
};
