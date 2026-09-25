'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { stableJson, validId } = require('./contracts');
const { createRuntimeStoreIO } = require('./store-io');
const { MAX_LINEAGE_ROOTS, MAX_LINEAGE_BYTES, copy, fail, sha, spawnIdentity,
  validateLineageRecord, validatePortableLineageSnapshot } = require('./lineage-contracts');

function captureDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('lineage_directory_unsafe');
  return { real: fs.realpathSync.native(directory), dev: String(stat.dev), ino: String(stat.ino) };
}
function assertDirectory(directory, identity) {
  if (stableJson(captureDirectory(directory)) !== stableJson(identity)) fail('lineage_directory_changed');
}
function rootDirectory(root, rootRunId) {
  if (!validId(rootRunId)) fail('lineage_root_id_invalid');
  return path.join(root, createHash('sha256').update(rootRunId).digest('hex'));
}
function readRecord(root, rootIdentity, directory, io, { allowEmpty = false } = {}) {
  assertDirectory(root, rootIdentity);
  io.sweepStaleTemp(directory);
  const identity = captureDirectory(directory);
  if (identity.real !== path.join(rootIdentity.real, path.basename(directory))) fail('lineage_directory_changed');
  const entries = fs.readdirSync(directory);
  if (allowEmpty && !entries.length) return null;
  if (entries.length !== 1 || entries[0] !== 'record.json') fail('lineage_entry_unresolved');
  const result = io.readJson(path.join(directory, 'record.json'), { maxBytes: MAX_LINEAGE_BYTES });
  assertDirectory(directory, identity);
  assertDirectory(root, rootIdentity);
  if (result.status !== 'ok') fail('lineage_record_unreadable');
  const record = validateLineageRecord(result.value);
  if (rootDirectory(root, record.root_run_id) !== directory) fail('lineage_root_id_conflict');
  return record;
}
function readInventory(root, identity, io) {
  const names = fs.readdirSync(root).sort();
  if (names.length > MAX_LINEAGE_ROOTS) fail('lineage_root_capacity');
  const records = names.map(name => {
    if (!/^[a-f0-9]{64}$/u.test(name)) fail('lineage_entry_unresolved');
    const document = readRecord(root, identity, path.join(root, name), io);
    return { root_run_id: document.root_run_id, document };
  });
  assertDirectory(root, identity);
  if (stableJson(fs.readdirSync(root).sort()) !== stableJson(names)) fail('lineage_inventory_changed');
  return validatePortableLineageSnapshot({ schema_version: 1, records });
}
function readPortableLineageSnapshot(root, { io = createRuntimeStoreIO() } = {}) {
  const resolved = path.resolve(root);
  let identity;
  try { identity = captureDirectory(resolved); }
  catch (error) {
    if (error?.code === 'ENOENT') return { schema_version: 1, records: [] };
    throw error;
  }
  return readInventory(resolved, identity, io);
}

// Application-only inventory. It owns intent/lineage, never conversation history,
// grants, scheduling eligibility or budget consumption. No mutation starts work.
class RuntimeLineageStore {
  constructor(root, { io = createRuntimeStoreIO() } = {}) {
    if (typeof root !== 'string' || !root || typeof io?.readJson !== 'function'
      || typeof io?.writeJsonAtomic !== 'function') throw new TypeError('lineage_dependencies_invalid');
    this.root = path.resolve(root);
    this.io = io;
    this.rootIds = new Set();
    this.rootWorkIds = new Set();
    this.readOnly = false;
    this.reason = null;
    this.pendingWrite = null;
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      this.identity = captureDirectory(this.root);
      const snapshot = readInventory(this.root, this.identity, this.io);
      for (const item of snapshot.records) {
        this.rootIds.add(item.root_run_id);
        this.rootWorkIds.add(item.document.root_work_id);
      }
    } catch (error) { this._block(error); }
  }

  snapshot() {
    return { schema_version: 1, read_only: this.readOnly, reason: this.reason,
      root_record_count: this.rootIds.size, max_root_records: MAX_LINEAGE_ROOTS };
  }

  get(rootRunId) {
    this._available();
    if (!this.rootIds.has(rootRunId)) fail('lineage_not_found');
    try { return this._read(rootRunId); }
    catch (error) { this._block(error); throw error; }
  }

  hasSessionReferences(sessionId) {
    const snapshot = this.exportPortableSnapshot();
    return snapshot.records.some(({ document }) => document.root_session_id === sessionId
      || document.children.some(child => child.session_id === sessionId));
  }

  exportPortableSnapshot() {
    this._available();
    try { return readInventory(this.root, this.identity, this.io); }
    catch (error) { this._block(error); throw error; }
  }

  create({ rootRunId, rootWorkId, rootSessionId, rootTurnId, projectId, providerId,
    authorityFingerprint, limits } = {}) {
    this._available();
    const proposed = validateLineageRecord({ schema_version: 1, root_run_id: rootRunId,
      root_work_id: rootWorkId, root_session_id: rootSessionId, root_turn_id: rootTurnId,
      project_id: projectId, provider_id: providerId, authority_fingerprint: authorityFingerprint,
      limits, revision: 1, cancelled: false, restored: false, children: [] });
    if (this.rootIds.has(rootRunId)) {
      const current = this.get(rootRunId);
      if (stableJson({ ...current, revision: 1, cancelled: false, restored: false, children: [] }) !== stableJson(proposed)) {
        fail('lineage_root_conflict');
      }
      return { created: false, record: current };
    }
    if (this.rootIds.size >= MAX_LINEAGE_ROOTS) fail('lineage_root_capacity');
    const inventory = this.exportPortableSnapshot();
    validatePortableLineageSnapshot({ schema_version: 1, records: [...inventory.records,
      { root_run_id: rootRunId, document: proposed }] });
    const directory = rootDirectory(this.root, rootRunId);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      this._write(proposed, null);
      return { created: true, record: copy(proposed) };
    } catch (error) { this._block(error); throw error; }
  }

  beginSpawn({ rootRunId, parentWorkId, parentTurnId, callId, argsSha256 } = {}) {
    const current = this.get(rootRunId);
    if (current.cancelled) fail('lineage_root_cancelled');
    if (current.restored) fail('lineage_restored_authority_required');
    if (!sha(argsSha256)) fail('lineage_spawn_arguments_invalid');
    const identity = spawnIdentity({ rootRunId, parentWorkId, parentTurnId, callId });
    if (this.rootWorkIds.has(identity.work_id)) fail('lineage_snapshot_conflict');
    const existing = current.children.find(child => child.work_id === identity.work_id);
    if (existing) {
      if (existing.args_sha256 !== argsSha256) fail('lineage_spawn_conflict');
      return { created: false, child: existing };
    }
    const parent = parentWorkId === current.root_work_id
      ? { depth: 0, turn_id: current.root_turn_id, state: 'committed' }
      : current.children.find(child => child.work_id === parentWorkId);
    if (!parent || parent.state !== 'committed' || parent.turn_id !== parentTurnId) fail('lineage_parent_invalid');
    if (current.children.length >= current.limits.descendants || parent.depth >= current.limits.descendant_depth) {
      fail('lineage_descendant_capacity');
    }
    const child = { ...identity, args_sha256: argsSha256, call_id: callId, parent_work_id: parentWorkId,
      parent_turn_id: parentTurnId, depth: parent.depth + 1, read_only: true, state: 'preparing',
      session_incarnation: null, submission_sha256: null, restored_submission_sha256: null };
    this._write({ ...current, revision: current.revision + 1, children: [...current.children, child] }, current);
    return { created: true, child: copy(child) };
  }

  recordSession({ rootRunId, childWorkId, sessionIncarnation } = {}) {
    if (!validId(sessionIncarnation)) fail('lineage_session_proof_invalid');
    return this._advance(rootRunId, childWorkId, child => {
      if (child.state !== 'preparing') {
        if (child.session_incarnation !== sessionIncarnation) fail('lineage_session_conflict');
        return child;
      }
      return { ...child, state: 'session_created', session_incarnation: sessionIncarnation };
    });
  }

  commitSpawn({ rootRunId, childWorkId, sessionIncarnation, submissionSha256 } = {}) {
    if (!sha(submissionSha256)) fail('lineage_work_proof_invalid');
    return this._advance(rootRunId, childWorkId, child => {
      if (child.state === 'preparing' || child.session_incarnation !== sessionIncarnation) fail('lineage_session_conflict');
      if (child.state === 'committed' && child.submission_sha256 !== submissionSha256) fail('lineage_work_conflict');
      return { ...child, state: 'committed', submission_sha256: submissionSha256 };
    });
  }

  cancelRoot(rootRunId) {
    const current = this.get(rootRunId);
    if (!current.cancelled) this._write({ ...current, cancelled: true, revision: current.revision + 1 }, current);
    return this.get(rootRunId);
  }

  recover() {
    if (!this.pendingWrite) return this.snapshot();
    const { next, previous } = this.pendingWrite;
    try {
      const actual = this._read(next.root_run_id, { allowEmpty: previous === null });
      if (stableJson(actual) !== stableJson(next)) {
        if (stableJson(actual) !== stableJson(previous)) fail('lineage_recovery_conflict');
        this.io.writeJsonAtomic(path.join(rootDirectory(this.root, next.root_run_id), 'record.json'), next);
        if (stableJson(this._read(next.root_run_id)) !== stableJson(next)) fail('lineage_publication_mismatch');
      }
      this.rootIds.add(next.root_run_id);
      this.rootWorkIds.add(next.root_work_id);
      this.pendingWrite = null;
      this.readOnly = false;
      this.reason = null;
    } catch (error) { this._block(error); throw error; }
    return this.snapshot();
  }

  _advance(rootRunId, childWorkId, change) {
    const current = this.get(rootRunId);
    if (current.cancelled) fail('lineage_root_cancelled');
    if (current.restored) fail('lineage_restored_authority_required');
    const index = current.children.findIndex(child => child.work_id === childWorkId);
    if (index < 0) fail('lineage_child_not_found');
    const child = change(current.children[index]);
    if (stableJson(child) !== stableJson(current.children[index])) {
      const children = [...current.children];
      children[index] = child;
      this._write({ ...current, revision: current.revision + 1, children }, current);
    }
    return copy(child);
  }

  _read(rootRunId, options) {
    return readRecord(this.root, this.identity, rootDirectory(this.root, rootRunId), this.io, options);
  }

  _write(next, previous) {
    const checked = validateLineageRecord(next);
    this.pendingWrite = { next: checked, previous: previous ? copy(previous) : null };
    try {
      if (stableJson(this._read(next.root_run_id, { allowEmpty: previous === null })) !== stableJson(previous)) {
        fail('lineage_publication_conflict');
      }
      this.io.writeJsonAtomic(path.join(rootDirectory(this.root, next.root_run_id), 'record.json'), checked);
      if (stableJson(this._read(next.root_run_id)) !== stableJson(checked)) fail('lineage_publication_mismatch');
      this.rootIds.add(next.root_run_id);
      this.rootWorkIds.add(next.root_work_id);
      this.pendingWrite = null;
    } catch (error) {
      this._block(Object.assign(new Error('lineage_write_uncertain'), { code: 'lineage_write_uncertain', cause: error }));
      fail('lineage_write_uncertain');
    }
  }

  _available() {
    if (this.readOnly) fail(this.reason || 'lineage_store_read_only');
    try { assertDirectory(this.root, this.identity); }
    catch (error) { this._block(error); throw error; }
  }

  _block(error) {
    this.readOnly = true;
    this.reason = String(error?.code || error?.message || 'lineage_store_read_only').slice(0, 256);
  }
}

module.exports = { RuntimeLineageStore, readPortableLineageSnapshot };
