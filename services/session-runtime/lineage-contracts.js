'use strict';

const { createHash } = require('node:crypto');
const { stableJson, validId } = require('./contracts');

const MAX_LINEAGE_ROOTS = 4096;
const MAX_LINEAGE_CHILDREN = 512;
const MAX_LINEAGE_BYTES = 1024 * 1024;
const ROOT_KEYS = ['authority_fingerprint', 'cancelled', 'children', 'limits', 'project_id',
  'provider_id', 'restored', 'revision', 'root_run_id', 'root_session_id', 'root_turn_id', 'root_work_id', 'schema_version'];
const CHILD_KEYS = ['args_sha256', 'call_id', 'depth', 'parent_turn_id', 'parent_work_id',
  'read_only', 'restored_submission_sha256', 'session_id', 'session_incarnation', 'state', 'submission_sha256', 'turn_id', 'work_id'];

function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function sha(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function spawnIdentity({ rootRunId, parentWorkId, parentTurnId, callId }) {
  if (![rootRunId, parentWorkId, parentTurnId, callId].every(validId)) fail('lineage_spawn_identity_invalid');
  const hash = createHash('sha256').update(stableJson([rootRunId, parentWorkId, parentTurnId, callId])).digest('hex');
  return { work_id: `childwork_${hash}`, session_id: `sess_child_${hash}`, turn_id: `childturn_${hash}` };
}
function validLimits(value) {
  return exact(value, ['descendant_depth', 'descendants'])
    && Number.isSafeInteger(value.descendants) && value.descendants >= 0 && value.descendants <= MAX_LINEAGE_CHILDREN
    && Number.isSafeInteger(value.descendant_depth) && value.descendant_depth >= 0 && value.descendant_depth <= 8;
}
function validateChild(child, root, parents, sessions) {
  if (!exact(child, CHILD_KEYS) || !sha(child.args_sha256) || child.read_only !== true
    || !validId(child.call_id) || !Number.isSafeInteger(child.depth) || child.depth < 1
    || child.depth > root.limits.descendant_depth || !['preparing', 'session_created', 'committed'].includes(child.state)) {
    fail('lineage_child_invalid');
  }
  const parent = parents.get(child.parent_work_id);
  const identity = spawnIdentity({ rootRunId: root.root_run_id, parentWorkId: child.parent_work_id,
    parentTurnId: child.parent_turn_id, callId: child.call_id });
  if (!parent || parent.state !== 'committed' || child.parent_turn_id !== parent.turn_id
    || child.depth !== parent.depth + 1 || parents.has(child.work_id) || sessions.has(child.session_id)
    || Object.keys(identity).some(key => child[key] !== identity[key])) fail('lineage_parent_invalid');
  if (child.state === 'preparing' ? child.session_incarnation !== null : !validId(child.session_incarnation)) {
    fail('lineage_session_proof_invalid');
  }
  if (child.restored_submission_sha256 !== null
    && (!root.restored || child.state !== 'committed' || !sha(child.restored_submission_sha256))) {
    fail('lineage_restore_proof_invalid');
  }
  if (child.state === 'committed' ? !sha(child.submission_sha256) : child.submission_sha256 !== null) {
    fail('lineage_work_proof_invalid');
  }
}
function validateLineageRecord(value) {
  if (value?.schema_version > 1) fail('lineage_future_schema');
  if (!exact(value, ROOT_KEYS) || value.schema_version !== 1
    || ![value.root_run_id, value.root_work_id, value.root_session_id, value.root_turn_id, value.project_id].every(validId)
    || typeof value.provider_id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.provider_id)
    || !sha(value.authority_fingerprint) || typeof value.cancelled !== 'boolean' || typeof value.restored !== 'boolean'
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !validLimits(value.limits)
    || !Array.isArray(value.children) || value.children.length > value.limits.descendants) {
    fail('lineage_record_invalid');
  }
  const parents = new Map([[value.root_work_id, { depth: 0, turn_id: value.root_turn_id, state: 'committed' }]]);
  const sessions = new Set([value.root_session_id]);
  for (const child of value.children) {
    validateChild(child, value, parents, sessions);
    parents.set(child.work_id, child);
    sessions.add(child.session_id);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_LINEAGE_BYTES) fail('lineage_document_capacity');
  return copy(value);
}
function validatePortableLineageSnapshot(value) {
  if (value?.schema_version > 1) fail('lineage_snapshot_future_schema');
  if (!exact(value, ['records', 'schema_version']) || value.schema_version !== 1
    || !Array.isArray(value.records) || value.records.length > MAX_LINEAGE_ROOTS) fail('lineage_snapshot_invalid');
  const roots = new Set();
  const workIds = new Set();
  const records = value.records.map(item => {
    if (!exact(item, ['document', 'root_run_id'])) fail('lineage_snapshot_invalid');
    const document = validateLineageRecord(item.document);
    if (item.root_run_id !== document.root_run_id || roots.has(item.root_run_id)) fail('lineage_snapshot_invalid');
    for (const id of [document.root_work_id, ...document.children.map(child => child.work_id)]) {
      if (workIds.has(id)) fail('lineage_snapshot_conflict');
      workIds.add(id);
    }
    roots.add(item.root_run_id);
    return { root_run_id: item.root_run_id, document };
  });
  return { schema_version: 1, records };
}

module.exports = { MAX_LINEAGE_ROOTS, MAX_LINEAGE_CHILDREN, MAX_LINEAGE_BYTES,
  copy, exact, fail, sha, spawnIdentity, validLineageLimits: validLimits, validateLineageRecord, validatePortableLineageSnapshot };
