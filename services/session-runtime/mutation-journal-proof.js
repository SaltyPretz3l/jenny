'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Ajv = require('ajv');
const { stableJson } = require('./contracts');
const schema = require('../../config/workspace-mutation-journal-v1.schema.json');
const validate = new Ajv({ allErrors: false, allowUnionTypes: true, strict: true }).compile(schema);
const MAX_BYTES = 4 * 1024 * 1024;
const PREFIX_KEYS = ['schema_version', 'change_set_id', 'workspace', 'session_id', 'turn_id',
  'actor', 'tool_call_ids', 'operation_count', 'completed_sequences', 'coverage', 'operations'];
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Buffer.from(`${stableJson(value)}\n`, 'utf8');
const same = (left, right) => stableJson(left) === stableJson(right);
function fail() { throw new Error('runtime_mutation_journal_unproven'); }

function historicalPrefix(record, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > record.operation_count) fail();
  const operations = record.operations.slice(0, count);
  return { ...record, operation_count: count, operations,
    tool_call_ids: [...new Set(operations.map(op => op.tool_call_id))],
    completed_sequences: record.completed_sequences.filter(sequence => sequence <= count) };
}
function mutationReference(record) {
  return { schema_version: 1, workspace_id: record.workspace.workspace_id, change_set_id: record.change_set_id,
    operation_count: record.operation_count,
    operations_sha256: hash(canonical(Object.fromEntries(PREFIX_KEYS.map(key => [key, record[key]])))) };
}

function realDirectory(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
  return fs.realpathSync.native(directory);
}

function readOwnerRecord(root, reference) {
  if (!/^ws_[a-f0-9]{32}$/u.test(reference?.workspace_id || '')
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(reference?.change_set_id || '')) fail();
  let directory = realDirectory(root);
  for (const part of ['workspace-recovery', 'v1', reference.workspace_id, reference.change_set_id]) {
    directory = realDirectory(path.join(directory, part));
  }
  const target = path.join(directory, 'journal.json');
  const before = fs.lstatSync(target, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(MAX_BYTES)) fail();
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let body;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) fail();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      size += count;
      if (size > MAX_BYTES) fail();
      if (!count) break;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(target, { bigint: true });
    if (after.size !== BigInt(size) || after.mtimeNs !== opened.mtimeNs
      || current.dev !== after.dev || current.ino !== after.ino || current.isSymbolicLink()) fail();
    body = buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
  const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  if (!validate(record) || !canonical(record).equals(body)) fail();
  const { integrity, ...payload } = record;
  const bytes = canonical(payload);
  if (integrity.payload_byte_length !== bytes.length || integrity.payload_sha256 !== hash(bytes)) fail();
  return record;
}

function verifyWorkspace(record, work) {
  const root = work.authority?.root_path;
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail();
  const actual = realDirectory(root);
  const stat = fs.statSync(actual, { bigint: true });
  const stored = record.workspace;
  const normalized = value => path.normalize(value.normalize('NFC'));
  if (normalized(actual) !== normalized(stored.real_path)
    || stored.device_id !== String(stat.dev) || stored.file_id !== String(stat.ino)
    || String(work.authority.device_id) !== stored.device_id || String(work.authority.inode) !== stored.file_id
    || stored.workspace_id !== `ws_${stored.fingerprint.slice(0, 32)}`) fail();
}

function assertSettledHistory(record, refs, { historical = false } = {}) {
  const unprotectedSkipped = historical && record.state === 'rolled_back'
    && record.completed_sequences.length === 0 && record.operations.every(op => op.status === 'skipped');
  if (!Array.isArray(refs) || refs.length > 255 || new Set(refs.map(ref => ref.call_id)).size !== refs.length
    || record.actor !== 'sidecar_tools' || (record.retention.protected !== true && !unprotectedSkipped)
    || record.restore.status !== 'not_requested' || record.coverage.partially_undoable
    || record.coverage.known_unjournaled_events.length || record.operation_count !== record.operations.length
    || !record.operation_count) fail();
  const calls = new Map(refs.map(ref => [ref.call_id, ref.tool_id]));
  const completed = [];
  for (const [index, operation] of record.operations.entries()) {
    if (operation.sequence !== index + 1 || !['applied', 'skipped'].includes(operation.status)
      || calls.get(operation.tool_call_id) !== operation.tool_name) fail();
    if (operation.status === 'applied') completed.push(operation.sequence);
  }
  if (!same(completed, record.completed_sequences)
    || !same([...new Set(record.operations.map(op => op.tool_call_id))], record.tool_call_ids)) fail();
}

// Read-only counterpart to the Python owner. Atomic file replacement gives a
// complete snapshot; all pin/claim/release writes stay behind Python's OS locks.
function createMutationJournalProof(userDataPath) {
  const root = path.resolve(userDataPath);
  return Object.freeze({ verify({ work, reference, decision, completedRefs, allowReleased = false, historical = false, requireTerminal = false, allowPreparing = false }) {
    const record = readOwnerRecord(root, reference);
    verifyWorkspace(record, work);
    const prefix = historical ? historicalPrefix(record, reference.operation_count) : record;
    if (record.session_id !== work.session_id || record.turn_id !== work.turn_id
      || !same(reference, mutationReference(prefix))) fail();
    assertSettledHistory(prefix, completedRefs, { historical });
    const binding = { schema_version: 1, work_id: work.work_id, decision_id: decision.decision_id,
      source_attempt: work.attempt, mutation_ref: reference };
    if (historical) {
      if (![record.extensions.runtime_checkpoint, ...(record.extensions.runtime_claimed_checkpoints || [])]
        .some(saved => same(saved, binding))) fail();
      if (requireTerminal && (!['committed', 'rolled_back', 'interrupted'].includes(record.state)
        || (record.extensions.runtime_checkpoint && record.termination_reason !== 'turn_cancelled'))) fail();
      return Object.freeze({ valid: true, terminal: requireTerminal });
    }
    if (!same(record.extensions.runtime_checkpoint, binding)) fail();
    const released = record.state === 'interrupted' && record.termination_reason === 'turn_cancelled';
    if (record.state !== 'in_progress' && !(allowReleased && released)) fail();
    if (!released && record.extensions.runtime_checkpoint_phase !== 'confirmed'
      && !(allowPreparing && record.extensions.runtime_checkpoint_phase === 'preparing')) fail();
    return Object.freeze({ valid: true, released, preparing: record.extensions.runtime_checkpoint_phase === 'preparing', binding: structuredClone(binding) });
  } });
}
module.exports = { createMutationJournalProof, mutationReference };
