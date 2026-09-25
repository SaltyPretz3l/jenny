'use strict';

const { createHash } = require('node:crypto');
const { normalizeCheckpointRef, stableJson, validId } = require('./contracts');
const { RETENTION_MS, TERMINAL } = require('./terminal-retention-contract');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
}
function transitionHash(work) { return createHash('sha256').update(stableJson(work.transition)).digest('hex'); }
function identityFor(work, checkpointId) {
  return { checkpoint_id: checkpointId, work_id: work.work_id, session_id: work.session_id, turn_id: work.turn_id };
}
function decodeRetirement(document, decodeOriginal) {
  const retiring = document.state === 'retiring';
  const keys = 'schema_version,state,reference,identity,retirement' + (retiring ? ',original' : '');
  const proof = document.retirement;
  const reference = normalizeCheckpointRef(document.reference);
  if (!exact(document, keys) || document.schema_version !== 2 || (!retiring && document.state !== 'retired')
    || !reference || !exact(document.identity, 'checkpoint_id,work_id,session_id,turn_id')
    || !Object.values(document.identity).every(validId) || document.identity.checkpoint_id !== reference.checkpoint_id
    || !exact(proof, 'at,submission_hash,transition_sha256,terminal_at,status') || !TERMINAL.has(proof.status)
    || !/^[a-f0-9]{64}$/u.test(proof.submission_hash) || !/^[a-f0-9]{64}$/u.test(proof.transition_sha256)
    || typeof proof.at !== 'string' || proof.at.length > 40 || !Number.isFinite(Date.parse(proof.at))
    || typeof proof.terminal_at !== 'string' || proof.terminal_at.length > 40 || !Number.isFinite(Date.parse(proof.terminal_at))
    || Date.parse(proof.at) - Date.parse(proof.terminal_at) < RETENTION_MS) fail('checkpoint_retirement_invalid');
  if (retiring && document.original?.schema_version !== 1) fail('checkpoint_retirement_invalid');
  const original = retiring ? decodeOriginal(document.original) : null;
  if (retiring && (original.state !== 'committed' || stableJson(original.reference) !== stableJson(reference)
    || stableJson(identityFor(original.continuation.identity, reference.checkpoint_id)) !== stableJson(document.identity))) {
    fail('checkpoint_retirement_invalid');
  }
  return { ...original, reference, identity: document.identity, retirement: proof, document,
    state: document.state, canonicalBytes: original?.canonicalBytes || 0,
    chargedBytes: original ? original.chargedBytes : Buffer.byteLength(JSON.stringify(document), 'utf8') };
}
function assertRetirementWork(saved, work) {
  if (!work || !TERMINAL.has(work.status) || saved.retirement.status !== work.status
    || saved.retirement.submission_hash !== work.submission_hash
    || saved.retirement.terminal_at !== work.transition.at
    || saved.retirement.transition_sha256 !== transitionHash(work)
    || stableJson(saved.identity) !== stableJson(identityFor(work, saved.reference.checkpoint_id))) {
    fail('checkpoint_retirement_work_conflict');
  }
}
function writeRetirement(store, saved, document) {
  try {
    store._assertRoot();
    store._assertDirectory(store._directory(saved.reference.checkpoint_id));
    store.io.writeJsonAtomic(store._file(saved.reference.checkpoint_id), document);
    const persisted = store._read(saved.reference.checkpoint_id);
    if (stableJson(persisted.document) !== stableJson(document)) fail('checkpoint_retirement_write_mismatch');
    store.records.set(saved.reference.checkpoint_id, store._metadata(persisted));
    store.totalBytes += persisted.chargedBytes - saved.chargedBytes;
    return persisted;
  } catch (error) { store._block(error); throw error; }
}
function beginRetirement(store, reference, work, at) {
  if (store.readOnly) fail(store.reason || 'checkpoint_store_read_only');
  const normalized = normalizeCheckpointRef(reference);
  if (!normalized) fail('checkpoint_reference_invalid');
  const saved = store._read(normalized.checkpoint_id);
  store._assertRegistered(saved);
  if (stableJson(saved.reference) !== stableJson(normalized)) fail('checkpoint_digest_mismatch');
  if (saved.retirement) { assertRetirementWork(saved, work); return saved; }
  if (saved.state !== 'committed' || !TERMINAL.has(work?.status)) fail('checkpoint_retirement_not_terminal');
  store.readHistorical(reference, { ...work, attempt: reference.source_attempt });
  const document = { schema_version: 2, state: 'retiring', reference: saved.reference,
    identity: identityFor(work, reference.checkpoint_id), retirement: { at,
      submission_hash: work.submission_hash, transition_sha256: transitionHash(work),
      terminal_at: work.transition.at, status: work.status }, original: saved.document };
  decodeRetirement(document, () => saved);
  return writeRetirement(store, saved, document);
}
function completeRetirement(store, reference, work, removeCanonical) {
  if (store.readOnly) fail(store.reason || 'checkpoint_store_read_only');
  const normalized = normalizeCheckpointRef(reference);
  if (!normalized) fail('checkpoint_reference_invalid');
  const saved = store._read(normalized.checkpoint_id);
  store._assertRegistered(saved);
  if (!saved.retirement || stableJson(saved.reference) !== stableJson(normalized)) fail('checkpoint_retirement_intent_required');
  assertRetirementWork(saved, work);
  if (work.checkpoint_ref?.checkpoint_id === normalized.checkpoint_id) fail('checkpoint_retirement_work_reference_active');
  if (saved.state === 'retired') return saved;
  // Only the application canonical owner can prove durable removal. No async or
  // truthy answer can reclaim a byte of encoded/canonical capacity.
  if (removeCanonical(saved) !== true) fail('checkpoint_retirement_canonical_unsettled');
  const { original: _original, ...document } = saved.document;
  document.state = 'retired';
  return writeRetirement(store, saved, document);
}
module.exports = { decodeRetirement, assertRetirementWork, beginRetirement, completeRetirement };
