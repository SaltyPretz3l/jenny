'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRuntimeStoreIO } = require('./store');
const { MAX_CHECKPOINT_BYTES, normalizeCheckpointRef, stableJson, validId } = require('./contracts');
const { decodeContinuation } = require('./continuation-contracts');
const { decodeRetirement, beginRetirement, completeRetirement } = require('./checkpoint-retirement');

const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 4096;
const MAX_DOCUMENT_BYTES = Math.ceil(MAX_CHECKPOINT_BYTES / 3) * 4 + 4096;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function referenceFor(body, continuation) {
  return normalizeCheckpointRef({ schema_version: 1,
    checkpoint_id: continuation.identity.checkpoint_id,
    sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length,
    source_attempt: continuation.source_attempt });
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function sameAttempt(left, right) {
  return Boolean(left && right && stableJson(left) === stableJson(right));
}

function contextMatchesWork(continuation, work) {
  const route = work?.input?.route;
  return Boolean(work && route
    && continuation.authority?.project_id === work.project_id
    && continuation.authority?.root_id === work.authority?.root_id
    && continuation.authority?.root_revision === work.authority?.root_revision
    && continuation.authority?.sha256 === digest(work.authority)
    && continuation.route?.sha256 === digest(route)
    && continuation.route?.route_revision === route.configuration_revision
    && continuation.route?.route_id === `route_${continuation.route.sha256}`);
}

function decodePortableDocument(value) {
  if (value?.schema_version === 2 && ['retiring', 'retired'].includes(value.state)) {
    return decodeRetirement(value, decodePortableDocument);
  }
  if (value?.schema_version > 1) throw failure('checkpoint_future_schema');
  if (!value || Object.keys(value).sort().join(',') !== 'body,canonical_bytes,schema_version,state'
    || value.schema_version !== 1 || typeof value.body !== 'string'
    || !['preparing', 'committed'].includes(value.state)) throw failure('checkpoint_document_invalid');
  const body = Buffer.from(value.body, 'base64');
  if (body.length > MAX_CHECKPOINT_BYTES || body.toString('base64') !== value.body) {
    throw failure('checkpoint_body_invalid');
  }
  const continuation = decodeContinuation(body);
  if (!Number.isSafeInteger(value.canonical_bytes) || value.canonical_bytes < 2
    || body.length + value.canonical_bytes > MAX_CHECKPOINT_BYTES) {
    throw failure('checkpoint_material_capacity');
  }
  return { continuation, identity: continuation.identity, body, reference: referenceFor(body, continuation),
    document: value, chargedBytes: body.length + value.canonical_bytes,
    canonicalBytes: value.canonical_bytes, state: value.state };
}

function validatePortableCheckpointSnapshot(value) {
  if (value?.schema_version > 1) throw failure('checkpoint_snapshot_future_schema');
  if (!value || Object.keys(value).sort().join(',') !== 'records,schema_version'
    || value.schema_version !== 1 || !Array.isArray(value.records)
    || value.records.length > MAX_RECORDS) throw failure('checkpoint_snapshot_invalid');
  const ids = new Set();
  let totalBytes = 0;
  const records = value.records.map((item) => {
    if (!item || Object.keys(item).sort().join(',') !== 'checkpoint_id,document'
      || !validId(item.checkpoint_id) || ids.has(item.checkpoint_id)) {
      throw failure('checkpoint_snapshot_invalid');
    }
    const decoded = decodePortableDocument(item.document);
    if (decoded.reference.checkpoint_id !== item.checkpoint_id) throw failure('checkpoint_filename_conflict');
    ids.add(item.checkpoint_id);
    if (decoded.state === 'retiring') throw failure('checkpoint_retirement_pending');
    totalBytes += decoded.chargedBytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw failure('checkpoint_body_capacity');
    return { checkpoint_id: item.checkpoint_id, document: structuredClone(decoded.document) };
  });
  return Object.freeze({ schema_version: 1, records: Object.freeze(records) });
}

function readStableJsonFile(filePath, maxBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) {
      throw failure('checkpoint_document_invalid');
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
      throw failure('checkpoint_document_invalid');
    }
    return JSON.parse(bytes.toString('utf8'));
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function readPortableCheckpointSnapshot(root) {
  const resolvedRoot = path.resolve(root);
  const io = createRuntimeStoreIO();
  let rootStat;
  try {
    rootStat = fs.lstatSync(resolvedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return validatePortableCheckpointSnapshot({ schema_version: 1, records: [] });
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('checkpoint_root_changed');
  const realRoot = fs.realpathSync.native(resolvedRoot);
  const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
    if (entries.length > MAX_RECORDS) throw failure('checkpoint_record_capacity');
    const records = entries.map((entry) => {
      const directory = path.join(resolvedRoot, entry.name);
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) {
        throw failure('checkpoint_entry_unresolved');
      }
      io.sweepStaleTemp(directory);
      // Nothing to export from an unpublished begin() leftover; the owning store discards it.
      if (fs.readdirSync(directory).length === 0) return null;
      const lexical = fs.lstatSync(directory);
      if (!lexical.isDirectory() || lexical.isSymbolicLink()
        || fs.realpathSync.native(directory) !== path.join(realRoot, entry.name)
        || fs.readdirSync(directory).join(',') !== 'record.json') {
        throw failure('checkpoint_entry_unresolved');
      }
      const before = fs.statSync(directory);
      const document = readStableJsonFile(path.join(directory, 'record.json'), MAX_DOCUMENT_BYTES);
      const decoded = decodePortableDocument(document);
      if (createHash('sha256').update(decoded.reference.checkpoint_id).digest('hex') !== entry.name) {
        throw failure('checkpoint_filename_conflict');
      }
      const after = fs.statSync(directory);
      if (String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino)) {
        throw failure('checkpoint_entry_unresolved');
      }
      return { checkpoint_id: decoded.reference.checkpoint_id, document };
    }).filter(record => record !== null);
    const finalRoot = fs.statSync(resolvedRoot);
    if (fs.realpathSync.native(resolvedRoot) !== realRoot
      || String(finalRoot.dev) !== String(rootStat.dev) || String(finalRoot.ino) !== String(rootStat.ino)
      || fs.readdirSync(resolvedRoot).sort().join(',') !== entries.map(entry => entry.name).sort().join(',')) {
      throw failure('checkpoint_root_changed');
    }
  return validatePortableCheckpointSnapshot({ schema_version: 1, records });
}

// This owner stores bounded continuation bodies, never canonical history. The
// canonical owner must validate all referenced bytes before publication/use.
class CheckpointStore {
  constructor(root, { io = createRuntimeStoreIO(), validateCanonical } = {}) {
    if (typeof root !== 'string' || !root || typeof validateCanonical !== 'function') {
      throw new TypeError('checkpoint_store_dependencies_invalid');
    }
    this.root = path.resolve(root);
    this.io = io;
    this.validateCanonical = validateCanonical;
    this.records = new Map();
    this.totalBytes = 0;
    this.readOnly = false;
    this.reason = null;
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      this.resolvedRoot = fs.realpathSync.native(this.root);
      this._assertRoot();
      const leftovers = [];
      const directory = fs.opendirSync(this.root);
      try {
        let entry;
        while ((entry = directory.readSync())) {
          if (this.records.size >= MAX_RECORDS) throw failure('checkpoint_record_capacity');
          if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) {
            throw failure('checkpoint_entry_unresolved');
          }
          const entryPath = path.join(this.root, entry.name);
          // No record left after the temp sweep: a begin() crash leftover that was never published.
          this.io.sweepStaleTemp(entryPath);
          if (fs.readdirSync(entryPath).length === 0) { leftovers.push(entryPath); continue; }
          const decoded = this._readDirectory(entryPath);
          const id = decoded.reference.checkpoint_id;
          if (this._directory(id) !== entryPath) throw failure('checkpoint_filename_conflict');
          this.records.set(id, this._metadata(decoded));
          this.totalBytes += decoded.chargedBytes;
          if (this.totalBytes > MAX_TOTAL_BYTES) throw failure('checkpoint_body_capacity');
        }
      } finally { directory.closeSync(); }
      // Removed only after the scan closed, so the walk never sees its own edits.
      if (leftovers.length > 0) this._assertRoot();
      for (const leftover of leftovers) fs.rmdirSync(leftover);
    } catch (error) { this._block(error); }
  }

  snapshot() {
    return Object.freeze({ schema_version: 1, read_only: this.readOnly, reason: this.reason,
      record_count: this.records.size, body_bytes: this.totalBytes,
      preparing_count: [...this.records.values()].filter(record => record.state === 'preparing').length,
      max_body_bytes: MAX_TOTAL_BYTES, max_record_bytes: MAX_CHECKPOINT_BYTES });
  }

  exportPortableSnapshot() {
    if (this.readOnly) throw failure(this.reason || 'checkpoint_store_read_only');
    this._assertRoot();
    const records = [...this.records.keys()].sort().map((checkpointId) => {
      const saved = this._read(checkpointId);
      this._assertRegistered(saved);
      return { checkpoint_id: checkpointId, document: saved.document };
    });
    return validatePortableCheckpointSnapshot({ schema_version: 1, records });
  }

  put(body, work) {
    const continuation = decodeContinuation(body);
    const canonicalBytes = this._assertCanonical(continuation, work);
    const reference = this.begin(body, work, { canonicalBytes });
    return this.commit(reference, work);
  }

  begin(body, work, { canonicalBytes } = {}) {
    if (this.readOnly) throw failure(this.reason || 'checkpoint_store_read_only');
    this._assertRoot();
    const continuation = decodeContinuation(body);
    const reference = referenceFor(body, continuation);
    this._assertWork(continuation, reference, work);
    this._assertFootprint(body.length, canonicalBytes);
    const previous = this.records.get(reference.checkpoint_id);
    if (previous) {
      if (['retiring', 'retired'].includes(previous.state)) throw failure('checkpoint_retired');
      if (stableJson(previous.reference) !== stableJson(reference) || previous.canonicalBytes !== canonicalBytes) {
        throw failure('checkpoint_id_conflict');
      }
      const saved = this._read(reference.checkpoint_id);
      if (stableJson(this._metadata(saved)) !== stableJson(previous)) throw failure('checkpoint_id_conflict');
      return reference;
    }
    if (this.records.size >= MAX_RECORDS) throw failure('checkpoint_record_capacity');
    if (this.totalBytes + body.length + canonicalBytes > MAX_TOTAL_BYTES) throw failure('checkpoint_body_capacity');
    try {
      // A single application owner serializes this synchronous publication.
      // Unreferenced leftovers that hold a record are retained and charged on restart.
      this._assertRoot();
      fs.mkdirSync(this._directory(reference.checkpoint_id), { mode: 0o700 });
      this.io.writeJsonAtomic(this._file(reference.checkpoint_id), {
        schema_version: 1, body: body.toString('base64'), canonical_bytes: canonicalBytes, state: 'preparing',
      });
      const persisted = this._read(reference.checkpoint_id);
      if (stableJson(persisted.reference) !== stableJson(reference)) {
        throw failure('checkpoint_publication_mismatch');
      }
      this.records.set(reference.checkpoint_id, this._metadata(persisted));
      this.totalBytes += body.length + canonicalBytes;
      return reference;
    } catch (error) {
      this._block(error);
      throw error;
    }
  }

  commit(reference, work) {
    if (this.readOnly) throw failure(this.reason || 'checkpoint_store_read_only');
    const normalized = normalizeCheckpointRef(reference);
    if (!normalized) throw failure('checkpoint_reference_invalid');
    const saved = this._read(normalized.checkpoint_id);
    this._assertRegistered(saved);
    if (stableJson(saved.reference) !== stableJson(normalized)) throw failure('checkpoint_digest_mismatch');
    if (!['preparing', 'committed'].includes(saved.state)) throw failure('checkpoint_retired');
    this._assertWork(saved.continuation, normalized, work);
    if (this._assertCanonical(saved.continuation, work) !== saved.canonicalBytes) {
      throw failure('checkpoint_canonical_footprint_changed');
    }
    if (saved.state === 'committed') return normalized;
    try {
      this._assertRoot();
      this._assertDirectory(this._directory(normalized.checkpoint_id));
      this.io.writeJsonAtomic(this._file(normalized.checkpoint_id), {
        schema_version: 1, body: saved.body.toString('base64'),
        canonical_bytes: saved.canonicalBytes, state: 'committed',
      });
      this.read(normalized, work);
      this.records.set(normalized.checkpoint_id, { ...this._metadata(saved), state: 'committed' });
      return normalized;
    } catch (error) { this._block(error); throw error; }
  }

  read(reference, work) { return this._readCommitted(reference, work); }

  readHistorical(reference, work) { return this._readCommitted(reference, work, { historical: true }); }

  _readCommitted(reference, work, options = {}) {
    const normalized = normalizeCheckpointRef(reference);
    if (!normalized) throw failure('checkpoint_reference_invalid');
    this._assertRoot();
    const saved = this._read(normalized.checkpoint_id);
    this._assertRegistered(saved);
    if (stableJson(saved.reference) !== stableJson(normalized)) throw failure('checkpoint_digest_mismatch');
    if (saved.state !== 'committed') throw failure('checkpoint_not_committed');
    this._assertWork(saved.continuation, normalized, work);
    if (this._assertCanonical(saved.continuation, work, options) !== saved.canonicalBytes) {
      throw failure('checkpoint_canonical_footprint_changed');
    }
    return saved.continuation;
  }

  validate(work, reference) {
    if (this.readOnly) return false;
    try { this.read(reference, work); return true; } catch (_error) { return false; }
  }

  canDiscardWorkContext(workId) {
    if (this.readOnly || !validId(workId)) return false;
    try {
      this._assertRoot();
      // Retention concerns every attempt, including orphaned preparation. This
      // is deliberately stricter than discovery of one resumable checkpoint.
      return ![...this.records.values()].some(record => record.workId === workId && record.state !== 'retired');
    } catch (error) { this._block(error); return false; }
  }

  findCommittedForWork(work) {
    if (this.readOnly) return Object.freeze({ status: 'blocked',
      reason: this.reason || 'checkpoint_store_read_only' });
    const candidates = [];
    try {
      for (const [checkpointId, metadata] of this.records) {
        if (metadata.state === 'retired') continue;
        if (metadata.workId !== work?.work_id
          || !sameAttempt(metadata.reference.source_attempt, work?.attempt)) continue;
        const saved = this._read(checkpointId);
        candidates.push(saved);
      }
    } catch (error) {
      this._block(error);
      return Object.freeze({ status: 'blocked', reason: this.reason });
    }
    if (!candidates.length) return Object.freeze({ status: 'none', reason: null });
    if (candidates.length !== 1) {
      return Object.freeze({ status: 'blocked', reason: 'checkpoint_attempt_ambiguous' });
    }
    const saved = candidates[0];
    if (saved.state !== 'committed') {
      return Object.freeze({ status: 'blocked', reason: 'checkpoint_preparing' });
    }
    if (saved.continuation.identity.session_id !== work?.session_id
      || saved.continuation.identity.turn_id !== work?.turn_id
      || !contextMatchesWork(saved.continuation, work)) {
      return Object.freeze({ status: 'blocked', reason: 'checkpoint_work_fence_conflict' });
    }
    if (!this.validate(work, saved.reference)) {
      return Object.freeze({ status: 'blocked', reason: 'checkpoint_canonical_unavailable' });
    }
    return Object.freeze({ status: 'committed', reason: null,
      reference: structuredClone(saved.reference), continuation: structuredClone(saved.continuation) });
  }

  _assertWork(continuation, reference, work) {
    const identity = continuation.identity;
    if (!work || identity.work_id !== work.work_id || identity.turn_id !== work.turn_id
      || identity.session_id !== work.session_id || continuation.authority.project_id !== work.project_id
      || continuation.authority.root_id !== work.authority?.root_id
      || continuation.authority.root_revision !== work.authority?.root_revision
      || stableJson(reference.source_attempt) !== stableJson(work.attempt)) {
      throw failure('checkpoint_work_fence_conflict');
    }
  }

  _assertCanonical(continuation, work, options = {}) {
    const evidence = this.validateCanonical(continuation, work, options);
    if (!evidence || Object.keys(evidence).sort().join(',') !== 'bytes,valid' || evidence.valid !== true
      || !Number.isSafeInteger(evidence.bytes) || evidence.bytes < 2 || evidence.bytes > MAX_CHECKPOINT_BYTES) {
      throw failure('checkpoint_canonical_unavailable');
    }
    return evidence.bytes;
  }

  _assertFootprint(bodyBytes, canonicalBytes) {
    if (!Number.isSafeInteger(canonicalBytes) || canonicalBytes < 2
      || bodyBytes + canonicalBytes > MAX_CHECKPOINT_BYTES) throw failure('checkpoint_material_capacity');
  }

  inspectReference(reference) {
    const normalized = normalizeCheckpointRef(reference);
    if (!normalized || this.readOnly) throw failure('checkpoint_inspection_unavailable');
    const saved = this._read(normalized.checkpoint_id);
    this._assertRegistered(saved);
    if (saved.state !== 'committed' || stableJson(saved.reference) !== stableJson(normalized)) {
      throw failure('checkpoint_inspection_unavailable');
    }
    const { position, wait } = saved.continuation;
    return { progress: { completed_iterations: position.completed_iterations,
      remaining_iterations: position.remaining_iterations, tool_calls_consumed: position.tool_calls_consumed,
      tool_call_limit: position.tool_call_limit }, wait: { kind: wait.kind,
      resource_class: wait.resource_class, dependency_id: wait.dependency_id } };
  }

  beginRetirement(reference, work, at) { return beginRetirement(this, reference, work, at); }

  completeRetirement(reference, work, removeCanonical) {
    return completeRetirement(this, reference, work, removeCanonical);
  }

  retirementRecords(workId = null) {
    if (this.readOnly) throw failure(this.reason || 'checkpoint_store_read_only');
    return [...this.records.values()].filter(item => !workId || item.workId === workId).map(item => {
      const saved = this._read(item.reference.checkpoint_id);
      this._assertRegistered(saved);
      return saved;
    });
  }

  _metadata(saved) {
    return { reference: saved.reference, canonicalBytes: saved.canonicalBytes,
      state: saved.state, workId: saved.identity.work_id };
  }

  _assertRegistered(saved) {
    const registered = this.records.get(saved.reference.checkpoint_id);
    if (!registered || registered.canonicalBytes !== saved.canonicalBytes
      || stableJson(registered.reference) !== stableJson(saved.reference)) {
      throw failure('checkpoint_unregistered');
    }
  }

  _read(id) {
    const result = this._readDirectory(this._directory(id));
    if (result.reference.checkpoint_id !== id) throw failure('checkpoint_filename_conflict');
    return result;
  }

  _readDirectory(directory) {
    this._assertRoot();
    this._assertDirectory(directory);
    const result = this.io.readJson(path.join(directory, 'record.json'), { maxBytes: MAX_DOCUMENT_BYTES });
    this._assertDirectory(directory);
    if (result.status !== 'ok') throw failure('checkpoint_document_invalid');
    return decodePortableDocument(result.value);
  }

  _file(id) {
    return path.join(this._directory(id), 'record.json');
  }

  _directory(id) {
    if (!validId(id)) throw failure('checkpoint_id_invalid');
    return path.join(this.root, createHash('sha256').update(id).digest('hex'));
  }

  _assertDirectory(directory) {
    this.io.sweepStaleTemp(directory);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync.native(directory) !== path.join(this.resolvedRoot, path.basename(directory))) {
      throw failure('checkpoint_directory_changed');
    }
    const entries = fs.readdirSync(directory);
    if (entries.length !== 1 || entries[0] !== 'record.json') throw failure('checkpoint_entry_unresolved');
  }

  _assertRoot() {
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync.native(this.root) !== this.resolvedRoot) {
      throw failure('checkpoint_root_changed');
    }
  }

  _block(error) {
    this.readOnly = true;
    this.reason = String(error?.code || error?.message || 'checkpoint_store_corrupt').slice(0, 256);
  }
}

module.exports = {
  CheckpointStore,
  MAX_TOTAL_BYTES,
  MAX_RECORDS,
  readPortableCheckpointSnapshot,
  validatePortableCheckpointSnapshot,
};
