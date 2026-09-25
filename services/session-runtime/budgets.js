'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { stableJson } = require('./contracts');
const { createRuntimeStoreIO } = require('./store');

const SCHEMA_VERSION = 1;
const MAX_ROOT_RECORDS = 4096;
const MAX_OPERATIONS_PER_ROOT = 4096;
const MAX_PROVIDER_IDS = 32;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_BUDGET_VALUE = 1_000_000_000_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COUNTER_KEYS = Object.freeze(['inference_requests', 'input_tokens', 'output_tokens']);
const RECORD_KEYS = Object.freeze([
  'allowed_provider_ids', 'authority_fingerprint', 'charged', 'created_at', 'limits',
  'over_limit', 'reservations', 'revision', 'root_run_id', 'schema_version', 'updated_at',
].sort());
const RESERVATION_KEYS = Object.freeze([
  'attempt_id', 'maxima', 'operation_id', 'provider_id', 'settlement', 'work_id',
].sort());
const SETTLEMENT_KEYS = Object.freeze(['consumption', 'usage']);

class RuntimeBudgetError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'RuntimeBudgetError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function fail(code, cause = null) {
  return new RuntimeBudgetError(code, cause);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join(',') === keys.join(',');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function frozen(value) {
  return Object.freeze(clone(value));
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40
    && Number.isFinite(Date.parse(value));
}

function normalizedCounters(value, {
  reservation = false,
  usage = false,
  maximum = MAX_BUDGET_VALUE,
} = {}) {
  if (!exactKeys(value, COUNTER_KEYS)) return null;
  const result = {};
  for (const key of COUNTER_KEYS) {
    const counter = value[key];
    if (!Number.isSafeInteger(counter) || counter < 0 || counter > maximum) return null;
    result[key] = counter;
  }
  if (reservation && result.inference_requests !== 1) return null;
  if (usage && result.inference_requests > 1) return null;
  return result;
}

function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw fail('budget_usage_overflow');
  return result;
}

function chargedFor(reservations) {
  const charged = { inference_requests: 0, input_tokens: 0, output_tokens: 0 };
  for (const reservation of reservations) {
    const source = reservation.settlement?.consumption === 'known'
      ? reservation.settlement.usage : reservation.maxima;
    for (const key of COUNTER_KEYS) charged[key] = safeAdd(charged[key], source[key]);
  }
  return charged;
}

function isOverLimit(charged, limits) {
  return COUNTER_KEYS.some(key => charged[key] > limits[key]);
}

function normalizeSettlement(consumption, usage) {
  if (consumption === 'unknown' && usage === null) {
    return { consumption: 'unknown', usage: null };
  }
  const normalized = consumption === 'known'
    ? normalizedCounters(usage, { usage: true }) : null;
  return normalized ? { consumption: 'known', usage: normalized } : null;
}

function validateRecord(value) {
  if (value?.schema_version > SCHEMA_VERSION) throw fail('budget_future_schema');
  if (!exactKeys(value, RECORD_KEYS) || value.schema_version !== SCHEMA_VERSION
    || !ID.test(value.root_run_id) || !SHA256.test(value.authority_fingerprint)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !validTimestamp(value.created_at) || !validTimestamp(value.updated_at)
    || !Array.isArray(value.allowed_provider_ids) || !value.allowed_provider_ids.length
    || value.allowed_provider_ids.length > MAX_PROVIDER_IDS
    || value.allowed_provider_ids.some(id => !PROVIDER_ID.test(id))
    || stableJson(value.allowed_provider_ids) !== stableJson([...new Set(value.allowed_provider_ids)].sort())
    || !Array.isArray(value.reservations)
    || value.reservations.length > MAX_OPERATIONS_PER_ROOT
    || typeof value.over_limit !== 'boolean') throw fail('budget_record_invalid');
  const limits = normalizedCounters(value.limits);
  if (!limits) throw fail('budget_record_invalid');
  const operations = new Set();
  const reservations = [];
  for (const item of value.reservations) {
    if (!exactKeys(item, RESERVATION_KEYS) || !ID.test(item.work_id)
      || !ID.test(item.attempt_id) || !OPERATION_ID.test(item.operation_id)
      || !PROVIDER_ID.test(item.provider_id)
      || !value.allowed_provider_ids.includes(item.provider_id)
      || operations.has(item.operation_id)) throw fail('budget_record_invalid');
    const maxima = normalizedCounters(item.maxima, { reservation: true });
    if (!maxima) throw fail('budget_record_invalid');
    let settlement = null;
    if (item.settlement !== null) {
      if (!exactKeys(item.settlement, SETTLEMENT_KEYS)) throw fail('budget_record_invalid');
      settlement = normalizeSettlement(item.settlement.consumption, item.settlement.usage);
      if (!settlement) throw fail('budget_record_invalid');
    }
    operations.add(item.operation_id);
    reservations.push({ work_id: item.work_id, attempt_id: item.attempt_id,
      operation_id: item.operation_id, provider_id: item.provider_id, maxima, settlement });
  }
  let charged;
  try { charged = chargedFor(reservations); } catch (_error) { throw fail('budget_record_invalid'); }
  const storedCharged = normalizedCounters(value.charged, { maximum: Number.MAX_SAFE_INTEGER });
  if (!storedCharged || stableJson(storedCharged) !== stableJson(charged)
    || value.over_limit !== isOverLimit(charged, limits)) throw fail('budget_record_invalid');
  return {
    schema_version: SCHEMA_VERSION, root_run_id: value.root_run_id, revision: value.revision,
    authority_fingerprint: value.authority_fingerprint,
    allowed_provider_ids: [...value.allowed_provider_ids], limits, charged,
    over_limit: value.over_limit, reservations,
    created_at: value.created_at, updated_at: value.updated_at,
  };
}

function validatePortableBudgetSnapshot(value) {
  if (value?.schema_version > SCHEMA_VERSION) throw fail('budget_snapshot_future_schema');
  if (!exactKeys(value, ['records', 'schema_version']) || value.schema_version !== SCHEMA_VERSION
    || !Array.isArray(value.records) || value.records.length > MAX_ROOT_RECORDS) {
    throw fail('budget_snapshot_invalid');
  }
  const ids = new Set();
  const records = value.records.map((item) => {
    if (!exactKeys(item, ['document', 'root_run_id']) || !ID.test(item.root_run_id)
      || ids.has(item.root_run_id)) throw fail('budget_snapshot_invalid');
    const document = validateRecord(item.document);
    if (document.root_run_id !== item.root_run_id
      || Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_DOCUMENT_BYTES) {
      throw fail('budget_snapshot_invalid');
    }
    ids.add(item.root_run_id);
    return { root_run_id: item.root_run_id, document };
  });
  return frozen({ schema_version: SCHEMA_VERSION, records });
}

function readStableJsonFile(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_DOCUMENT_BYTES) {
      throw fail('budget_record_unreadable');
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino)) {
      throw fail('budget_record_unreadable');
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function readPortableBudgetSnapshot(root) {
  const resolvedRoot = path.resolve(root);
  const io = createRuntimeStoreIO();
  let rootStat;
  try {
    rootStat = fs.lstatSync(resolvedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return validatePortableBudgetSnapshot({ schema_version: 1, records: [] });
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail('budget_root_changed');
  const realRoot = fs.realpathSync.native(resolvedRoot);
  const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
    if (entries.length > MAX_ROOT_RECORDS) throw fail('budget_root_capacity');
    const records = entries.map((entry) => {
      const directory = path.join(resolvedRoot, entry.name);
      if (!entry.isDirectory() || !SHA256.test(entry.name)) throw fail('budget_entry_unresolved');
      io.sweepStaleTemp(directory);
      const lexical = fs.lstatSync(directory);
      if (!lexical.isDirectory() || lexical.isSymbolicLink()
        || fs.realpathSync.native(directory) !== path.join(realRoot, entry.name)
        || fs.readdirSync(directory).join(',') !== 'record.json') throw fail('budget_entry_unresolved');
      const before = fs.statSync(directory);
      const document = validateRecord(readStableJsonFile(path.join(directory, 'record.json')));
      if (createHash('sha256').update(document.root_run_id).digest('hex') !== entry.name) {
        throw fail('budget_root_id_conflict');
      }
      const after = fs.statSync(directory);
      if (String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino)) {
        throw fail('budget_entry_unresolved');
      }
      return { root_run_id: document.root_run_id, document };
    });
    const finalRoot = fs.statSync(resolvedRoot);
    if (fs.realpathSync.native(resolvedRoot) !== realRoot
      || String(finalRoot.dev) !== String(rootStat.dev) || String(finalRoot.ino) !== String(rootStat.ino)
      || fs.readdirSync(resolvedRoot).sort().join(',') !== entries.map(entry => entry.name).sort().join(',')) {
      throw fail('budget_root_changed');
    }
  return validatePortableBudgetSnapshot({ schema_version: SCHEMA_VERSION, records });
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw fail('budget_clock_invalid');
  return date.toISOString();
}

function summary(record) {
  let unresolved = 0;
  let unknown = 0;
  for (const reservation of record.reservations) {
    if (reservation.settlement === null) unresolved += 1;
    else if (reservation.settlement.consumption === 'unknown') unknown += 1;
  }
  return {
    schema_version: SCHEMA_VERSION, root_run_id: record.root_run_id,
    revision: record.revision, authority_fingerprint: record.authority_fingerprint,
    allowed_provider_ids: [...record.allowed_provider_ids], limits: { ...record.limits },
    charged: { ...record.charged }, over_limit: record.over_limit,
    reservation_count: record.reservations.length,
    unresolved_reservation_count: unresolved, unknown_consumption_count: unknown,
  };
}

// Callers own current/narrower project-authority validation. This store accepts
// only a trusted application fingerprint and never creates a budget implicitly.
class RootRunBudgetStore {
  constructor(root, { io = createRuntimeStoreIO(), now = () => new Date() } = {}) {
    if (typeof root !== 'string' || !root || !io || typeof io.readJson !== 'function'
      || typeof io.writeJsonAtomic !== 'function' || typeof now !== 'function') {
      throw new TypeError('runtime_budget_store_dependencies_invalid');
    }
    this.root = path.resolve(root);
    this.io = io;
    this.now = now;
    this.rootIds = new Set();
    this.readOnly = false;
    this.reason = null;
    this.pendingWrite = null;
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      this.resolvedRoot = fs.realpathSync.native(this.root);
      this._assertRoot();
      const directory = fs.opendirSync(this.root);
      try {
        let entry;
        while ((entry = directory.readSync())) {
          if (this.rootIds.size >= MAX_ROOT_RECORDS) throw fail('budget_root_capacity');
          if (!entry.isDirectory() || !SHA256.test(entry.name)) {
            throw fail('budget_entry_unresolved');
          }
          const ownerDirectory = path.join(this.root, entry.name);
          const record = this._readDirectory(ownerDirectory);
          if (this._directory(record.root_run_id) !== ownerDirectory
            || this.rootIds.has(record.root_run_id)) throw fail('budget_root_id_conflict');
          this.rootIds.add(record.root_run_id);
        }
      } finally { directory.closeSync(); }
    } catch (error) { this._block(error); }
  }

  snapshot() {
    return frozen({ schema_version: SCHEMA_VERSION, read_only: this.readOnly,
      reason: this.reason, root_record_count: this.rootIds.size,
      max_root_records: MAX_ROOT_RECORDS, max_operations_per_root: MAX_OPERATIONS_PER_ROOT });
  }

  exportPortableSnapshot() {
    this._assertAvailable();
    const records = [...this.rootIds].sort().map(rootRunId => ({
      root_run_id: rootRunId, document: this._read(rootRunId),
    }));
    return validatePortableBudgetSnapshot({ schema_version: SCHEMA_VERSION, records });
  }

  get(rootRunId) {
    this._assertAvailable();
    return frozen(this._read(rootRunId));
  }

  inspect(rootRunId, { offset = 0, limit = 100 } = {}) {
    this._assertAvailable();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 100) throw fail('budget_inspection_invalid');
    const record = this._read(rootRunId);
    const reservations = record.reservations.slice(offset, offset + limit);
    const nextOffset = offset + reservations.length;
    return frozen({ ...summary(record), reservations,
      next_offset: nextOffset < record.reservations.length ? nextOffset : null });
  }

  create({ rootRunId, authorityFingerprint, allowedProviderIds, limits } = {}) {
    this._assertAvailable();
    if (!ID.test(rootRunId || '') || !SHA256.test(authorityFingerprint || '')) {
      throw fail('budget_creation_invalid');
    }
    const providers = Array.isArray(allowedProviderIds)
      ? [...new Set(allowedProviderIds)].sort() : [];
    const normalizedLimits = normalizedCounters(limits);
    if (!providers.length || providers.length > MAX_PROVIDER_IDS
      || providers.length !== allowedProviderIds.length
      || providers.some(id => !PROVIDER_ID.test(id)) || !normalizedLimits) {
      throw fail('budget_creation_invalid');
    }
    if (this.rootIds.has(rootRunId)) {
      const existing = this._read(rootRunId);
      const matches = existing.authority_fingerprint === authorityFingerprint
        && stableJson(existing.allowed_provider_ids) === stableJson(providers)
        && stableJson(existing.limits) === stableJson(normalizedLimits);
      if (!matches) throw fail('budget_root_id_conflict');
      return frozen({ created: false, record: existing });
    }
    if (this.rootIds.size >= MAX_ROOT_RECORDS) throw fail('budget_root_capacity');
    const at = isoNow(this.now);
    const record = {
      schema_version: SCHEMA_VERSION, root_run_id: rootRunId, revision: 1,
      authority_fingerprint: authorityFingerprint, allowed_provider_ids: providers,
      limits: normalizedLimits,
      charged: { inference_requests: 0, input_tokens: 0, output_tokens: 0 },
      over_limit: false, reservations: [], created_at: at, updated_at: at,
    };
    this._assertRoot();
    try {
      fs.mkdirSync(this._directory(rootRunId), { mode: 0o700 });
      this._write(rootRunId, record, null);
      this.rootIds.add(rootRunId);
      return frozen({ created: true, record });
    } catch (error) {
      if (!this.readOnly) this._block(error);
      throw error instanceof RuntimeBudgetError ? error : fail('budget_create_failed', error);
    }
  }

  reserve({ rootRunId, workId, attemptId, operationId, providerId, maxima } = {}) {
    this._assertAvailable();
    const normalizedMaxima = normalizedCounters(maxima, { reservation: true });
    if (!ID.test(rootRunId || '') || !ID.test(workId || '') || !ID.test(attemptId || '')
      || !OPERATION_ID.test(operationId || '') || !PROVIDER_ID.test(providerId || '')
      || !normalizedMaxima) throw fail('budget_reservation_invalid');
    const current = this._read(rootRunId);
    const proposed = { work_id: workId, attempt_id: attemptId, operation_id: operationId,
      provider_id: providerId, maxima: normalizedMaxima, settlement: null };
    const existing = current.reservations.find(item => item.operation_id === operationId);
    if (existing) {
      if (stableJson({ ...existing, settlement: null }) !== stableJson(proposed)) {
        throw fail('budget_reservation_conflict');
      }
      return frozen({ created: false, reservation: existing, record: current });
    }
    if (current.reservations.length >= MAX_OPERATIONS_PER_ROOT) {
      throw fail('budget_operation_capacity');
    }
    if (!current.allowed_provider_ids.includes(providerId)) throw fail('budget_provider_not_allowed');
    if (current.over_limit) throw fail('budget_exhausted');
    const charged = {};
    for (const key of COUNTER_KEYS) {
      charged[key] = safeAdd(current.charged[key], normalizedMaxima[key]);
      if (charged[key] > current.limits[key]) throw fail('budget_exhausted');
    }
    const next = { ...current, revision: current.revision + 1, charged,
      reservations: [...current.reservations, proposed], updated_at: isoNow(this.now) };
    this._write(rootRunId, next, current);
    return frozen({ created: true, reservation: proposed, record: next });
  }

  settle({ rootRunId, workId, attemptId, operationId, consumption, usage } = {}) {
    this._assertAvailable();
    if (!ID.test(rootRunId || '') || !ID.test(workId || '') || !ID.test(attemptId || '')
      || !OPERATION_ID.test(operationId || '')) throw fail('budget_settlement_invalid');
    const settlement = normalizeSettlement(consumption, usage);
    if (!settlement) throw fail('budget_settlement_invalid');
    const current = this._read(rootRunId);
    const index = current.reservations.findIndex(item => item.operation_id === operationId);
    if (index < 0) throw fail('budget_reservation_not_found');
    const reservation = current.reservations[index];
    if (reservation.work_id !== workId || reservation.attempt_id !== attemptId) {
      throw fail('budget_reservation_conflict');
    }
    if (reservation.settlement !== null) {
      if (stableJson(reservation.settlement) !== stableJson(settlement)) {
        throw fail('budget_settlement_conflict');
      }
      return frozen({ changed: false, reservation, record: current });
    }
    const settled = { ...reservation, settlement };
    const reservations = [...current.reservations];
    reservations[index] = settled;
    const charged = chargedFor(reservations);
    const next = { ...current, revision: current.revision + 1, reservations, charged,
      over_limit: isOverLimit(charged, current.limits), updated_at: isoNow(this.now) };
    this._write(rootRunId, next, current, { mustCommit: true });
    return frozen({ changed: true, reservation: settled, record: next });
  }

  recover() {
    if (!this.pendingWrite) return this.snapshot();
    const pending = this.pendingWrite;
    try {
      const read = this._readMaybe(pending.rootRunId, { allowEmpty: pending.previous === null });
      if (read && stableJson(read) === stableJson(pending.next)) {
        this.rootIds.add(pending.rootRunId);
      } else if (pending.previous && read
        && stableJson(read) === stableJson(pending.previous)) {
        // A reservation that never authorized dispatch can be retried. A
        // settlement contains observed consumption and must not be forgotten.
        if (pending.mustCommit) {
          this.io.writeJsonAtomic(this._file(pending.rootRunId), pending.next);
          if (stableJson(this._readMaybe(pending.rootRunId)) !== stableJson(pending.next)) {
            throw fail('budget_publication_mismatch');
          }
        }
      } else if (pending.previous === null && read === null) {
        this.io.writeJsonAtomic(this._file(pending.rootRunId), pending.next);
        const persisted = this._readMaybe(pending.rootRunId);
        if (stableJson(persisted) !== stableJson(pending.next)) {
          throw fail('budget_publication_mismatch');
        }
        this.rootIds.add(pending.rootRunId);
      } else {
        throw fail('budget_recovery_conflict');
      }
      this.pendingWrite = null;
      this.readOnly = false;
      this.reason = null;
      return this.snapshot();
    } catch (error) {
      this._block(error, pending);
      throw error instanceof RuntimeBudgetError ? error : fail('budget_recovery_failed', error);
    }
  }

  _read(rootRunId, { ignoreBlocked = false } = {}) {
    if (!ignoreBlocked) this._assertAvailable();
    if (!ID.test(rootRunId || '') || !this.rootIds.has(rootRunId)) {
      throw fail('budget_not_found');
    }
    return this._readDirectory(this._directory(rootRunId));
  }

  _readMaybe(rootRunId, { allowEmpty = false } = {}) {
    const directory = this._directory(rootRunId);
    this._assertRoot();
    this._assertDirectory(directory, { allowEmpty });
    const result = this.io.readJson(path.join(directory, 'record.json'), {
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    this._assertDirectory(directory, { allowEmpty: result.status === 'missing' && allowEmpty });
    if (result.status === 'missing' && allowEmpty) return null;
    if (result.status !== 'ok') throw fail('budget_record_unreadable', result.error);
    const record = validateRecord(result.value);
    if (record.root_run_id !== rootRunId || this._directory(record.root_run_id) !== directory) {
      throw fail('budget_root_id_conflict');
    }
    return record;
  }

  _readDirectory(directory) {
    this._assertRoot();
    this._assertDirectory(directory);
    const result = this.io.readJson(path.join(directory, 'record.json'), {
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    this._assertDirectory(directory);
    if (result.status !== 'ok') throw fail('budget_record_unreadable', result.error);
    const record = validateRecord(result.value);
    if (this._directory(record.root_run_id) !== directory) throw fail('budget_root_id_conflict');
    return record;
  }

  _write(rootRunId, next, previous, { mustCommit = false } = {}) {
    const checked = validateRecord(next);
    if (Buffer.byteLength(JSON.stringify(checked), 'utf8') > MAX_DOCUMENT_BYTES) {
      throw fail('budget_document_capacity');
    }
    const pending = { rootRunId, previous: previous ? clone(previous) : null, next: clone(checked), mustCommit };
    this._assertRoot();
    this._assertDirectory(this._directory(rootRunId), { allowEmpty: previous === null });
    try {
      this.io.writeJsonAtomic(this._file(rootRunId), checked);
      const persisted = this._readMaybe(rootRunId);
      if (stableJson(persisted) !== stableJson(checked)) throw fail('budget_publication_mismatch');
    } catch (error) {
      this._block(fail('budget_write_uncertain', error), pending);
      throw fail('budget_write_uncertain', error);
    }
  }

  _file(rootRunId) {
    return path.join(this._directory(rootRunId), 'record.json');
  }

  _directory(rootRunId) {
    if (!ID.test(rootRunId || '')) throw fail('budget_root_run_id_invalid');
    return path.join(this.root, createHash('sha256').update(rootRunId).digest('hex'));
  }

  _assertDirectory(directory, { allowEmpty = false } = {}) {
    this.io.sweepStaleTemp(directory);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync.native(directory) !== path.join(this.resolvedRoot, path.basename(directory))) {
      throw fail('budget_directory_changed');
    }
    const entries = fs.readdirSync(directory);
    if (!(allowEmpty && entries.length === 0)
      && (entries.length !== 1 || entries[0] !== 'record.json')) {
      throw fail('budget_entry_unresolved');
    }
  }

  _assertRoot() {
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync.native(this.root) !== this.resolvedRoot) throw fail('budget_root_changed');
  }

  _assertAvailable() {
    if (this.readOnly) throw fail(this.reason || 'budget_store_read_only');
    this._assertRoot();
  }

  _block(error, pending = this.pendingWrite) {
    this.readOnly = true;
    this.reason = String(error?.code || error?.message || 'budget_store_read_only').slice(0, 256);
    this.pendingWrite = pending;
  }
}

module.exports = {
  MAX_BUDGET_VALUE,
  MAX_OPERATIONS_PER_ROOT,
  MAX_ROOT_RECORDS,
  RootRunBudgetStore,
  RuntimeBudgetError,
  readPortableBudgetSnapshot,
  validatePortableBudgetSnapshot,
};
