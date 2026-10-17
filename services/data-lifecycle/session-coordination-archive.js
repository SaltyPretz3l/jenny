'use strict';

// Trusted full-profile archive entry for session coordination (row 59 cp5b-3, slice H1).
// One entry, `coordination/sessions.json`, carries per session its incarnation and the six
// schema-25 coordination fields. Only the trusted archive writes it; ordinary session export/import
// never carries coordination. Restore imports every session first (keeping the incarnation), then
// applies each record through ONE store method after the pure restore transform
// (./coordination-restore-transform). Nothing here is reachable from IPC.

const fs = require('fs');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { normalizeCoordinationFields } = require('../backend/session-coordination-records');
const { archiveError } = require('./archive-format');
const { transformRestoredCoordination } = require('./coordination-restore-transform');

const COORDINATION_LOGICAL_PATH = 'coordination/sessions.json';
const COORDINATION_CATEGORY = 'chat_coordination';
const COORDINATION_ARCHIVE_VERSION = 1;
const MAX_COORDINATION_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVED_SESSIONS = 20_000;
const MAX_INCARNATION_CHARS = 512;
const SESSION_ID_RE = /^sess_[A-Za-z0-9_-]{1,154}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PAYLOAD_KEYS = ['captured_at', 'schema_version', 'sessions'];

function corrupt(reason, message = 'Archived chat coordination is invalid.') {
  return archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, reason, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// ---------- capture (export side) ----------

/**
 * The archive payload for every session that carries an incarnation or any non-default coordination,
 * or null when no session does (no entry is written). Reads canonical records, which the caller has
 * flushed, through the existing per-field normalizers; a frozen (future-versioned) container is
 * captured verbatim.
 * @returns {Buffer|null}
 */
function captureSessionCoordination(sessionStore, { now = new Date() } = {}) {
  if (typeof sessionStore?.listSessions !== 'function') return null;
  const read = typeof sessionStore.peekSession === 'function' ? sessionStore.peekSession : sessionStore.getSession;
  if (typeof read !== 'function') return null;
  const defaults = JSON.stringify(normalizeCoordinationFields({}));
  const sessions = {};
  for (const summary of sessionStore.listSessions() || []) {
    const sessionId = String(summary?.id || '').trim();
    const session = sessionId ? read.call(sessionStore, sessionId) : null;
    if (!session || typeof session !== 'object') continue;
    const fields = normalizeCoordinationFields(session);
    const incarnation = typeof session.session_incarnation === 'string' ? session.session_incarnation.trim() : '';
    if (!incarnation && JSON.stringify(fields) === defaults) continue;
    sessions[sessionId] = { session_incarnation: incarnation, ...fields };
  }
  if (!Object.keys(sessions).length) return null;
  const data = Buffer.from(JSON.stringify({
    schema_version: COORDINATION_ARCHIVE_VERSION,
    captured_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    sessions,
  }), 'utf8');
  if (data.length > MAX_COORDINATION_ARCHIVE_BYTES) {
    throw Object.assign(new Error('Chat coordination exceeds the supported archive size.'), {
      code: DATA_ERROR_CODES.SOURCE_UNREADABLE, reason: 'source_too_large',
    });
  }
  return data;
}

// ---------- validation (restore side) ----------

/** @returns {Map<string, object>} session id -> the archived record (not yet validated per field). */
function parseCoordinationArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_COORDINATION_ARCHIVE_BYTES) throw corrupt('coordination_payload_invalid');
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    throw corrupt('coordination_payload_invalid');
  }
  if (Number(payload?.schema_version) > COORDINATION_ARCHIVE_VERSION) {
    throw archiveError(DATA_ERROR_CODES.UNSUPPORTED_VERSION, 'unsupported_coordination_version',
      'Archived chat coordination uses an unsupported schema version.');
  }
  if (!isPlainObject(payload) || Object.keys(payload).sort().join(',') !== PAYLOAD_KEYS.join(',')
    || payload.schema_version !== COORDINATION_ARCHIVE_VERSION || !ISO_RE.test(String(payload.captured_at))
    || !isPlainObject(payload.sessions)) {
    throw corrupt('coordination_payload_invalid');
  }
  const ids = Object.keys(payload.sessions);
  if (ids.length > MAX_ARCHIVED_SESSIONS || !ids.every((id) => SESSION_ID_RE.test(id))) {
    throw corrupt('coordination_payload_invalid');
  }
  return new Map(ids.map((id) => [id, payload.sessions[id]]));
}

/**
 * Reads the staged coordination entry (if the manifest has one) through `verifyEntry`, which must
 * return the verified staged file path. Absent entry -> an empty result.
 */
async function loadStagedCoordination(manifest, verifyEntry) {
  const entries = (manifest?.entries || []).filter((entry) => entry?.logical_path === COORDINATION_LOGICAL_PATH);
  if (entries.length > 1 || (entries[0] && entries[0].category !== COORDINATION_CATEGORY)) throw corrupt('coordination_entry_invalid');
  if (!entries.length) return { sessions: new Map() };
  const sourcePath = await verifyEntry(entries[0]);
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_COORDINATION_ARCHIVE_BYTES) {
    throw corrupt('coordination_entry_invalid', 'Staged chat coordination is unsafe.');
  }
  return { sessions: parseCoordinationArchive(fs.readFileSync(sourcePath)) };
}

/** The incarnation a trusted import keeps for this session ('' when the record has none usable). */
function restoredIncarnationFor(loaded, sessionId) {
  const incarnation = loaded?.sessions?.get(sessionId)?.session_incarnation;
  return typeof incarnation === 'string' && incarnation.length <= MAX_INCARNATION_CHARS ? incarnation : '';
}

// ---------- apply ----------

/**
 * Applies every archived record to its restored session. A malformed record is quarantined (the chat
 * keeps its transcript and gets default coordination); a record whose session was not restored is
 * ignored; a store write that fails aborts the restore. Diagnostics carry ids and reasons only.
 */
function applyCoordination(sessionStore, loaded, { now } = {}) {
  const report = { applied: 0, quarantined: [], ignored: [], unavailable_links: [] };
  if (!loaded?.sessions?.size) return report;
  const restored = new Set(sessionStore.getSessionIds());
  for (const [sessionId, archived] of loaded.sessions) {
    if (!restored.has(sessionId)) {
      report.ignored.push({ session_id: sessionId, reason: 'session_not_restored' });
      continue;
    }
    const result = transformRestoredCoordination(archived, { restoredSessionIds: restored, now });
    if (result.quarantined) report.quarantined.push({ session_id: sessionId, reason: result.reason });
    if (result.unavailable_session_ids.length) {
      report.unavailable_links.push({ session_id: sessionId, missing_session_ids: result.unavailable_session_ids });
    }
    if (sessionStore.restoreSessionCoordination(sessionId, result.record) !== true) {
      throw corrupt('restore_state_invalid', 'Restored chat coordination could not be saved.');
    }
    report.applied += 1;
  }
  return report;
}

module.exports = {
  COORDINATION_ARCHIVE_VERSION,
  COORDINATION_CATEGORY,
  COORDINATION_LOGICAL_PATH,
  MAX_COORDINATION_ARCHIVE_BYTES,
  applyCoordination,
  captureSessionCoordination,
  loadStagedCoordination,
  parseCoordinationArchive,
  restoredIncarnationFor,
};
