'use strict';

// Bounded, append-only audit log of membership changes: team-audit.json,
// schema 2, read with a 2 MiB cap. Entries carry ids and a display-name
// snapshot, never a key, an address or an invite string. Project entries
// (schema 2, TEAM_PROJECTS_SPEC slice 3-1) carry a `project_id` and ids only:
// no display name, project name or path. A schema 1 file is upgraded
// explicitly on load (every entry gains `project_id: null`) and written as
// schema 2 by the next append or reconcile.
//
// Audit first: the member store appends the entry before its mutation commits
// and stamps it with `store_rev`, the revision the store will hold once the
// commit lands. `reconcile(storeRev)` runs once on open and marks tail entries
// above the store's revision `applied: false` (a crash left an entry for a
// change that did not happen, never a change with no entry).
//
// `floor_seq` is the lowest sequence number that may still be present: every
// entry with a smaller seq was dropped to stay inside the bounds. It starts at
// 1 and only moves forward.

const { readJson: durableReadJson, writeJson: durableWriteJson } = require('../../services/host/durable-json');
const { hostFailure } = require('../api-contract');
const { isId } = require('./ids');
const {
  hasExactKeys, isCleanText, isCount, isPlainObject, isProjectId,
} = require('./member-schema');
const { safeLogger } = require('./safe-logger');

const AUDIT_SCHEMA_VERSION = 2;
const AUDIT_LIMITS = Object.freeze({
  MAX_ENTRIES: 5000,
  MAX_BYTES: 2 * 1024 * 1024,
  MAX_PAGE: 100,
  MAX_BATCH: 8,
  RECONCILE_SCAN: 256,
  MAX_DETAIL_CHARS: 160,
});

const AUDIT_KINDS = Object.freeze([
  'invite_created', 'invite_redeemed', 'invite_revoked', 'member_admitted', 'role_changed',
  'member_revoked', 'member_left', 'device_added', 'device_revoked', 'owner_transferred', 'recovery_used',
  'team_renamed',
]);

// Kinds about one shared project: `project_id` set, `name` always null.
// `project_reconciled` is produced by slice 3-4's start-up reconcile.
const PROJECT_AUDIT_KINDS = Object.freeze([
  'project_created', 'project_member_added', 'project_role_changed', 'project_member_removed',
  'project_owner_self_added', 'project_deleting', 'project_deleted', 'project_reconciled',
]);

const ALL_KINDS = Object.freeze([...AUDIT_KINDS, ...PROJECT_AUDIT_KINDS]);
const READ_ORDERS = Object.freeze(['oldest', 'newest']);

const DOCUMENT_KEYS = ['schema_version', 'floor_seq', 'next_seq', 'entries'];
const ENTRY_KEYS_V1 = ['seq', 'at', 'kind', 'actor_member_id', 'subject_member_id', 'subject_device_id', 'name',
  'detail', 'store_rev', 'applied'];
const ENTRY_KEYS = [...ENTRY_KEYS_V1, 'project_id'];

// A detail is a short machine-readable note ("role=read_only"). It may not look
// like a key (a long base64url run) or an invite or address code.
const DETAIL_PATTERN = new RegExp(`^[A-Za-z0-9_=,.: -]{0,${AUDIT_LIMITS.MAX_DETAIL_CHARS}}$`, 'u');
const KEY_LIKE = /[A-Za-z0-9_-]{32,}/u;
const SECRET_PREFIX = /jteam(addr)?1_/iu;

function isNullOrId(kind, value) {
  return value === null || isId(kind, value);
}

function isDetail(value) {
  return value === null || (typeof value === 'string' && DETAIL_PATTERN.test(value)
    && !KEY_LIKE.test(value) && !SECRET_PREFIX.test(value));
}

function validProjectFields(entry) {
  if (!PROJECT_AUDIT_KINDS.includes(entry.kind)) return entry.project_id === null;
  return isProjectId(entry.project_id) && entry.name === null && entry.subject_device_id === null;
}

function validEntry(entry) {
  return isPlainObject(entry) && hasExactKeys(entry, ENTRY_KEYS)
    && Number.isSafeInteger(entry.seq) && entry.seq >= 1 && isCount(entry.at)
    && ALL_KINDS.includes(entry.kind) && validProjectFields(entry)
    && isNullOrId('member', entry.actor_member_id) && isNullOrId('member', entry.subject_member_id)
    && isNullOrId('device', entry.subject_device_id)
    && (entry.name === null || isCleanText(entry.name))
    && isDetail(entry.detail) && isCount(entry.store_rev) && typeof entry.applied === 'boolean';
}

function validDocument(doc) {
  if (!isPlainObject(doc) || doc.schema_version !== AUDIT_SCHEMA_VERSION || !hasExactKeys(doc, DOCUMENT_KEYS)) return false;
  if (!Number.isSafeInteger(doc.floor_seq) || doc.floor_seq < 1 || !Number.isSafeInteger(doc.next_seq)
    || doc.next_seq < doc.floor_seq || !Array.isArray(doc.entries) || doc.entries.length > AUDIT_LIMITS.MAX_ENTRIES) {
    return false;
  }
  let previous = doc.floor_seq - 1;
  for (const entry of doc.entries) {
    if (!validEntry(entry) || entry.seq <= previous) return false;
    previous = entry.seq;
  }
  return previous < doc.next_seq;
}

// The explicit migration: a schema 1 document whose entries all have exactly
// the schema 1 keys becomes a fresh schema 2 document, every entry gaining
// `project_id: null`, and is then held to every schema 2 rule. Returns null for
// anything else.
function upgradeDocument(doc) {
  if (!isPlainObject(doc) || doc.schema_version !== 1 || !hasExactKeys(doc, DOCUMENT_KEYS)) return null;
  if (!Array.isArray(doc.entries) || doc.entries.length > AUDIT_LIMITS.MAX_ENTRIES) return null;
  if (!doc.entries.every((entry) => isPlainObject(entry) && hasExactKeys(entry, ENTRY_KEYS_V1))) return null;
  const upgraded = {
    ...doc,
    schema_version: AUDIT_SCHEMA_VERSION,
    entries: doc.entries.map((entry) => ({ ...entry, project_id: null })),
  };
  return validDocument(upgraded) ? upgraded : null;
}

function emptyDocument() {
  return { schema_version: AUDIT_SCHEMA_VERSION, floor_seq: 1, next_seq: 1, entries: [] };
}

function unavailable() {
  return hostFailure('unavailable', 'team_unavailable');
}

class AuditLog {
  constructor({
    filePath, clock = Date.now, logger = null, assertSafePath = null,
    readJson = durableReadJson, writeJson = durableWriteJson,
    maxEntries = AUDIT_LIMITS.MAX_ENTRIES, maxBytes = AUDIT_LIMITS.MAX_BYTES,
  } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('AuditLog requires a filePath.');
    this.filePath = filePath;
    this._clock = clock;
    this._log = safeLogger(logger);
    this._assertSafePath = typeof assertSafePath === 'function' ? assertSafePath : null;
    this._readJson = readJson;
    this._writeJson = writeJson;
    this._maxEntries = Math.min(maxEntries, AUDIT_LIMITS.MAX_ENTRIES);
    this._maxBytes = Math.min(maxBytes, AUDIT_LIMITS.MAX_BYTES);
    this._doc = null;
    this._broken = false;
  }

  // Strict load. An unreadable or invalid file marks the log broken and is
  // never rewritten.
  _load() {
    if (this._broken) return null;
    if (this._doc) return this._doc;
    try {
      if (this._assertSafePath) this._assertSafePath(this.filePath);
      const stored = this._readJson(this.filePath, { maxBytes: AUDIT_LIMITS.MAX_BYTES });
      if (stored === null) {
        this._doc = emptyDocument();
        return this._doc;
      }
      const doc = validDocument(stored) ? stored : upgradeDocument(stored);
      if (!doc) throw new Error('audit_invalid');
      this._doc = doc;
      return this._doc;
    } catch (error) {
      this._broken = true;
      this._log('ERROR', 'team_audit.rejected', { code: error?.code || null });
      return null;
    }
  }

  floorSeq() {
    const doc = this._load();
    return doc ? doc.floor_seq : null;
  }

  // Marks tail entries whose store_rev is above the member store's revision as
  // not applied. Bounded: it stops at the first entry the store already holds.
  reconcile(storeRev) {
    const doc = this._load();
    if (!doc) return unavailable();
    let marked = 0;
    const stop = Math.max(0, doc.entries.length - AUDIT_LIMITS.RECONCILE_SCAN);
    const next = doc.entries.map((entry) => ({ ...entry }));
    for (let index = next.length - 1; index >= stop; index -= 1) {
      if (next[index].store_rev <= storeRev) break;
      if (next[index].applied) {
        next[index].applied = false;
        marked += 1;
      }
    }
    if (marked === 0) return { ok: true, marked };
    // Bounded like an append: an upgraded schema 1 file near the cap grows by
    // `project_id` on every entry, and a write past the read cap would leave the
    // log unreadable for good.
    const written = this._persist(this._bounded({ ...doc, entries: next }));
    if (!written.ok) return written;
    this._log('WARN', 'team_audit.unapplied_marked', { count: marked });
    return { ok: true, marked };
  }

  _persist(candidate) {
    try {
      if (this._assertSafePath) this._assertSafePath(this.filePath);
      this._writeJson(this.filePath, candidate);
    } catch (error) {
      this._log('ERROR', 'team_audit.write_failed', { code: error?.code || null });
      return hostFailure('persistence', 'team_store_failed');
    }
    this._doc = candidate;
    return { ok: true };
  }

  // Appends one to eight entries in a single durable write. Nothing is held in
  // memory unless the write succeeded.
  append(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > AUDIT_LIMITS.MAX_BATCH) {
      throw new TypeError('append takes one to eight entries.');
    }
    const doc = this._load();
    if (!doc) return unavailable();
    const at = this._clock();
    let seq = doc.next_seq;
    const added = inputs.map((input) => ({
      seq: seq++,
      at,
      kind: input.kind,
      actor_member_id: input.actor_member_id ?? null,
      subject_member_id: input.subject_member_id ?? null,
      subject_device_id: input.subject_device_id ?? null,
      name: input.name ?? null,
      detail: input.detail ?? null,
      store_rev: input.store_rev,
      applied: true,
      project_id: input.project_id ?? null,
    }));
    if (!added.every(validEntry)) throw new TypeError('Invalid audit entry.');
    const candidate = this._bounded({
      schema_version: AUDIT_SCHEMA_VERSION,
      floor_seq: doc.floor_seq,
      next_seq: seq,
      entries: [...doc.entries, ...added],
    });
    const written = this._persist(candidate);
    if (!written.ok) return written;
    return { ok: true, seqs: added.map((entry) => entry.seq) };
  }

  // Drops the oldest entries until the document fits both bounds, and records
  // the new floor.
  _bounded(candidate) {
    const sizes = candidate.entries.map((entry) => Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1);
    let size = Buffer.byteLength(JSON.stringify({ ...candidate, entries: [] }), 'utf8')
      + sizes.reduce((sum, value) => sum + value, 0);
    let drop = 0;
    while (drop < candidate.entries.length - 1
      && (candidate.entries.length - drop > this._maxEntries || size > this._maxBytes)) {
      size -= sizes[drop];
      drop += 1;
    }
    if (drop === 0) return candidate;
    const entries = candidate.entries.slice(drop);
    return { ...candidate, entries, floor_seq: entries[0].seq };
  }

  // Pages at most 100 entries. Oldest first (the default): entries with seq
  // greater than `cursor`. Newest first (`order: 'newest'`): entries with seq
  // below `cursor`, where cursor 0 starts at the newest entry.
  read({ cursor = 0, limit = AUDIT_LIMITS.MAX_PAGE, order = 'oldest' } = {}) {
    const doc = this._load();
    if (!doc) return unavailable();
    if (!isCount(cursor) || !Number.isSafeInteger(limit) || limit < 1 || !READ_ORDERS.includes(order)) {
      return hostFailure('invalid', 'team_cursor_invalid');
    }
    const size = Math.min(limit, AUDIT_LIMITS.MAX_PAGE);
    const rest = order === 'oldest'
      ? doc.entries.filter((entry) => entry.seq > cursor)
      : doc.entries.filter((entry) => cursor === 0 || entry.seq < cursor).reverse();
    const page = rest.slice(0, size).map((entry) => ({ ...entry }));
    return {
      ok: true,
      entries: page,
      next_cursor: rest.length > size ? page[page.length - 1].seq : null,
      floor_seq: doc.floor_seq,
    };
  }
}

module.exports = {
  AUDIT_SCHEMA_VERSION, AUDIT_LIMITS, AUDIT_KINDS, PROJECT_AUDIT_KINDS, AuditLog,
};
