'use strict';

// Durable record of project deletions whose memory move the sidecar has not
// confirmed (review finding DPR-008). A record is written before the project
// entry is removed and cleared once the move is answered, so a lost reply (or
// a crash) leaves something to finish from: ProjectDeleteOperation.reconcile
// re-issues the idempotent move after the sidecar is initialized again.
//
// Fail closed: a file that cannot be read, or that a newer build wrote, makes
// the journal read-only and a delete that needs a record is then refused. A
// damaged file (not JSON, or outside the schema) is moved aside as
// `<name>.corrupt-<ms>` and the journal starts empty; if it cannot be moved
// the journal is read-only too. Nothing is ever written over bytes that were
// not understood. State is bounded to MAX_PENDING_PROJECT_DELETES records.

const { preserveCorruptFile, readWithRetry } = require('../backend/corrupt-file-preserve');
const { FileJsonStore } = require('../backend/file-json-store');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./project-schema');

const PROJECT_DELETE_JOURNAL_SCHEMA_VERSION = 1;
const MAX_PENDING_PROJECT_DELETES = 16;
const MAX_ATTEMPTS = 9999;
const MAX_REASON_LENGTH = 120;
const MAX_TIMESTAMP_LENGTH = 40;

const DOCUMENT_KEYS = ['operations', 'schema_version'];
const OPERATION_KEYS = [
  'attempts', 'created_at', 'last_attempt_at', 'last_reason', 'project_id', 'target_project_id',
];

function isPlainRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TIMESTAMP_LENGTH;
}

function isValidOperation(projectId, operation) {
  return isPlainRecord(operation)
    && hasExactKeys(operation, OPERATION_KEYS)
    && normalizeProjectId(projectId) === projectId
    && projectId !== GENERAL_PROJECT_ID
    && operation.project_id === projectId
    && operation.target_project_id === GENERAL_PROJECT_ID
    && isTimestamp(operation.created_at)
    && Number.isSafeInteger(operation.attempts)
    && operation.attempts >= 0 && operation.attempts <= MAX_ATTEMPTS
    && (operation.last_attempt_at === null || isTimestamp(operation.last_attempt_at))
    && (operation.last_reason === null
      || (typeof operation.last_reason === 'string' && operation.last_reason.length <= MAX_REASON_LENGTH));
}

function validateJournalDocument(value) {
  if (!isPlainRecord(value)) return { ok: false, reason: 'invalid_schema' };
  if (Number.isSafeInteger(value.schema_version)
    && value.schema_version > PROJECT_DELETE_JOURNAL_SCHEMA_VERSION) {
    return { ok: false, reason: 'future_schema' };
  }
  if (value.schema_version !== PROJECT_DELETE_JOURNAL_SCHEMA_VERSION
    || !hasExactKeys(value, DOCUMENT_KEYS)
    || !isPlainRecord(value.operations)) {
    return { ok: false, reason: 'invalid_schema' };
  }
  const entries = Object.entries(value.operations);
  if (entries.length > MAX_PENDING_PROJECT_DELETES
    || !entries.every(([projectId, operation]) => isValidOperation(projectId, operation))) {
    return { ok: false, reason: 'invalid_schema' };
  }
  return { ok: true, document: structuredClone(value) };
}

function emptyDocument() {
  return { schema_version: PROJECT_DELETE_JOURNAL_SCHEMA_VERSION, operations: {} };
}

class ProjectDeleteJournal {
  constructor(filePath, { logger = null, store = null, now = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this._logger = typeof logger === 'function' ? logger : null;
    this._store = store || new FileJsonStore(filePath, { logger: this._logger });
    this._now = typeof now === 'function' ? now : () => new Date().toISOString();
    this._readOnlyReason = '';
    this._document = this._load();
  }

  // A missing file is the normal state (no deletion is waiting) and is not
  // created here: the file exists only while a record does, or after one did.
  _load() {
    const status = readWithRetry(this._store, null);
    if (status.missing) return emptyDocument();
    // A read error (busy, access denied) says nothing about the bytes.
    let damage = status.corrupted ? (status.errorCode ? 'unreadable_store' : 'corrupt_store') : '';
    if (!damage) {
      const validated = validateJournalDocument(status.value);
      if (validated.ok) return validated.document;
      damage = validated.reason;
    }
    // Records in a damaged file are lost: their memories stay under ids no
    // chat belongs to (recalled by nothing) instead of being moved.
    const movable = damage === 'corrupt_store' || damage === 'invalid_schema';
    const preserved = movable && preserveCorruptFile(this.filePath, { logger: this._logger }).preserved === true;
    if (!preserved) this._readOnlyReason = damage;
    this.log('ERROR', 'project_delete_journal.unusable', { reason: damage, preserved });
    return emptyDocument();
  }

  // Also the diagnostics sink of the delete operation that owns the records.
  log(level, event, details) {
    try {
      this._logger?.(level, event, details);
    } catch (_error) {
      // Logging cannot change persistence behavior.
    }
  }

  getStatus() {
    return {
      schema_version: PROJECT_DELETE_JOURNAL_SCHEMA_VERSION,
      read_only: Boolean(this._readOnlyReason),
      reason: this._readOnlyReason || null,
    };
  }

  list() {
    return Object.values(this._document.operations).map((operation) => structuredClone(operation));
  }

  has(projectId) {
    return Object.prototype.hasOwnProperty.call(this._document.operations, projectId);
  }

  // Called before the project entry is removed. An existing record for the
  // same project (a delete that never removed it) is replaced.
  record(projectId) {
    const id = normalizeProjectId(projectId);
    if (!id || id !== projectId || id === GENERAL_PROJECT_ID) return { ok: false, reason: 'invalid_project_id' };
    if (!this.has(id) && Object.keys(this._document.operations).length >= MAX_PENDING_PROJECT_DELETES) {
      return { ok: false, reason: 'journal_full' };
    }
    return this._commit({
      ...this._document.operations,
      [id]: {
        project_id: id,
        target_project_id: GENERAL_PROJECT_ID,
        created_at: String(this._now()).slice(0, MAX_TIMESTAMP_LENGTH),
        attempts: 0,
        last_attempt_at: null,
        last_reason: null,
      },
    });
  }

  clear(projectId) {
    if (!this.has(projectId)) return { ok: true, unchanged: true };
    const operations = { ...this._document.operations };
    delete operations[projectId];
    return this._commit(operations);
  }

  // Diagnostics for a re-issued move that was not answered ok. Losing this
  // write loses a counter, never the record.
  noteAttempt(projectId, reason) {
    const current = this._document.operations[projectId];
    if (!current) return { ok: true, unchanged: true };
    return this._commit({
      ...this._document.operations,
      [projectId]: {
        ...current,
        attempts: Math.min(MAX_ATTEMPTS, current.attempts + 1),
        last_attempt_at: String(this._now()).slice(0, MAX_TIMESTAMP_LENGTH),
        last_reason: typeof reason === 'string' && reason ? reason.slice(0, MAX_REASON_LENGTH) : null,
      },
    });
  }

  _commit(operations) {
    if (this._readOnlyReason) return { ok: false, reason: this._readOnlyReason, read_only: true };
    const validated = validateJournalDocument({
      schema_version: PROJECT_DELETE_JOURNAL_SCHEMA_VERSION, operations,
    });
    if (!validated.ok) return { ok: false, reason: validated.reason };
    try {
      const write = this._store.write(validated.document);
      if (write?.durable !== true) return { ok: false, reason: 'durability_deferred' };
    } catch (error) {
      this.log('ERROR', 'project_delete_journal.write_failed', {
        errorCode: error?.code || null,
        errorMessage: String(error?.message || error || '').slice(0, 240),
      });
      return { ok: false, reason: 'write_failed' };
    }
    this._document = validated.document;
    return { ok: true };
  }
}

module.exports = {
  MAX_PENDING_PROJECT_DELETES,
  PROJECT_DELETE_JOURNAL_SCHEMA_VERSION,
  ProjectDeleteJournal,
  validateJournalDocument,
};
