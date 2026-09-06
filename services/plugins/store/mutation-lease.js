'use strict';

// The single graph-scoped mutation lease (PLUG-D08, invariant 11): distinct
// lifecycle operations cannot interleave commits. This module owns the one
// durable lease record at `mutation-lease.json` (durable, not in-memory, so a
// crashed Electron instance's lease is recoverable by the NEXT instance rather
// than stuck forever); expected-generation CAS is layered on top via
// `revalidateAgainstCurrentGeneration`, checked again after every await inside
// a mutation (the architecture's "every post-await mutation revalidates lease
// ownership and current generation").
//
// This module intentionally has no generated contract of its own (only
// PluginGenerationV1/PluginRegistryV1 are in this packet's contract scope) --
// the lease record is Electron-internal bookkeeping, never persisted or
// inspected by another principal, so a hand-rolled shape check is sufficient
// and keeps the closed contract vocabulary reserved for cross-principal
// authority documents.
//
// A second distinct operation cannot acquire the lease while it is held and
// unexpired: it is rejected as busy (deterministic reject; a caller wanting
// queueing semantics layers that on top -- Stage 2 has no orchestrator to
// queue inside). An expired lease is recoverable: the crashed owner is
// recorded as a bounded tombstone and the lease is reclaimed by the new
// operation, never left stuck.

const crypto = require('node:crypto');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');

const LEASE_FILE = 'mutation-lease.json';
const MAX_TOMBSTONES = 20;
const DEFAULT_LEASE_DURATION_MS = 30000;
const leaseAdmissions = new Map();

function newOwnerToken() {
  return crypto.randomBytes(16).toString('hex');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidLeaseShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!isNonEmptyString(value.operation_id)) return false;
  if (!isNonEmptyString(value.owner_token)) return false;
  if (!isNonEmptyString(value.acquired_at)) return false;
  if (!isNonEmptyString(value.expires_at)) return false;
  if (!Array.isArray(value.tombstones)) return false;
  if (value.expected_generation !== null && typeof value.expected_generation !== 'object') return false;
  return true;
}

async function readLease(facade, baseDir) {
  const read = await readJsonFile(facade, joinPath(baseDir, LEASE_FILE));
  if (read.status === 'missing') return { status: 'missing' };
  if (read.status === 'corrupted') return { status: 'corrupted', error: read.error };
  if (!isValidLeaseShape(read.value)) return { status: 'corrupted', error: 'lease record has an invalid shape' };
  return { status: 'ok', lease: read.value };
}

function isLeaseExpired(lease, nowIso) {
  const expiresMs = Date.parse(lease.expires_at);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(expiresMs) || Number.isNaN(nowMs)) return true;
  return nowMs >= expiresMs;
}

function addExpiry(nowIso, leaseDurationMs) {
  return new Date(Date.parse(nowIso) + leaseDurationMs).toISOString();
}

async function writeLease(facade, baseDir, lease) {
  await writeJsonFileAtomic(facade, baseDir, LEASE_FILE, lease);
  return lease;
}

async function acquireLease(facade, baseDir, {
  operationId,
  expectedGeneration = null,
  now,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
}) {
  return withLeaseAdmission(facade, baseDir, () => acquireLeaseSerialized(facade, baseDir, {
    operationId, expectedGeneration, now, leaseDurationMs,
  }));
}

function withLeaseAdmission(facade, baseDir, operation) {
  let facadeAdmissions = leaseAdmissions.get(facade);
  if (!facadeAdmissions) {
    facadeAdmissions = new Map();
    leaseAdmissions.set(facade, facadeAdmissions);
  }
  const prior = facadeAdmissions.get(baseDir) || Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  facadeAdmissions.set(baseDir, current);
  return current.finally(() => {
    if (facadeAdmissions.get(baseDir) === current) facadeAdmissions.delete(baseDir);
    if (facadeAdmissions.size === 0) leaseAdmissions.delete(facade);
  });
}

async function writeAndVerifyLease(facade, baseDir, lease) {
  await writeLease(facade, baseDir, lease);
  const written = await readLease(facade, baseDir);
  if (written.status === 'corrupted') {
    return { ok: false, reason: 'lease_record_corrupted', detail: written.error };
  }
  if (written.status !== 'ok' || written.lease.operation_id !== lease.operation_id
    || written.lease.owner_token !== lease.owner_token) {
    return { ok: false, reason: 'not_lease_owner' };
  }
  return { ok: true, lease: written.lease };
}

async function acquireLeaseSerialized(facade, baseDir, {
  operationId, expectedGeneration, now, leaseDurationMs,
}) {
  const current = await readLease(facade, baseDir);
  if (current.status === 'corrupted') {
    return { ok: false, reason: 'lease_record_corrupted', detail: current.error };
  }

  if (current.status === 'missing') {
    const lease = {
      operation_id: operationId,
      owner_token: newOwnerToken(),
      acquired_at: now,
      expires_at: addExpiry(now, leaseDurationMs),
      expected_generation: expectedGeneration,
      tombstones: [],
    };
    const written = await writeAndVerifyLease(facade, baseDir, lease);
    return written.ok ? { ok: true, outcome: 'acquired', lease: written.lease } : written;
  }

  const existing = current.lease;
  if (existing.operation_id === operationId) {
    const lease = {
      ...existing,
      expires_at: addExpiry(now, leaseDurationMs),
      expected_generation: expectedGeneration,
    };
    const written = await writeAndVerifyLease(facade, baseDir, lease);
    return written.ok ? { ok: true, outcome: 'reacquired', lease: written.lease } : written;
  }

  if (!isLeaseExpired(existing, now)) {
    return { ok: false, reason: 'busy', heldBy: existing.operation_id, expiresAt: existing.expires_at };
  }

  const tombstone = { operation_id: existing.operation_id, released_at: now, reason: 'lease_expired' };
  const tombstones = [...existing.tombstones, tombstone].slice(-MAX_TOMBSTONES);
  const lease = {
    operation_id: operationId,
    owner_token: newOwnerToken(),
    acquired_at: now,
    expires_at: addExpiry(now, leaseDurationMs),
    expected_generation: expectedGeneration,
    tombstones,
  };
  const written = await writeAndVerifyLease(facade, baseDir, lease);
  return written.ok
    ? { ok: true, outcome: 'reclaimed_from_expired', lease: written.lease, reclaimedFrom: existing.operation_id }
    : written;
}

async function releaseLease(facade, baseDir, { operationId, ownerToken }) {
  const current = await readLease(facade, baseDir);
  if (current.status === 'corrupted') {
    return { ok: false, reason: 'lease_record_corrupted', detail: current.error };
  }
  if (current.status === 'missing') {
    return { ok: true, outcome: 'already_released' };
  }
  if (current.lease.operation_id !== operationId || current.lease.owner_token !== ownerToken) {
    return { ok: false, reason: 'not_lease_owner' };
  }
  await facade.remove(joinPath(baseDir, LEASE_FILE));
  return { ok: true, outcome: 'released' };
}

// Pure check used both right after acquisition and again after every await
// inside a mutation, per invariant 11's "every post-await mutation checks
// lease/current-generation ownership."
function validateLeaseOwnership(lease, { operationId, ownerToken, now }) {
  if (!lease) {
    return { ok: false, reason: 'lease_not_held' };
  }
  if (lease.operation_id !== operationId || lease.owner_token !== ownerToken) {
    return { ok: false, reason: 'not_lease_owner' };
  }
  if (isLeaseExpired(lease, now)) {
    return { ok: false, reason: 'lease_expired' };
  }
  return { ok: true };
}

// Pure check comparing the generation the lease was acquired against to the
// currently-committed pointer (as returned by active-pointer.readActivePointer
// -> {status:'ok', pointer}). A mismatch means another commit has landed since
// this operation started, and the in-flight mutation must abort rather than
// commit against a stale expectation.
function revalidateAgainstCurrentGeneration(lease, currentPointer) {
  if (!lease || !lease.expected_generation) {
    return { ok: false, reason: 'no_expected_generation_recorded' };
  }
  if (!currentPointer) {
    return { ok: false, reason: 'current_generation_unavailable' };
  }
  const expected = lease.expected_generation;
  const matches =
    expected.commit_epoch === currentPointer.commit_epoch
    && expected.revision === currentPointer.revision
    && expected.generation_id === currentPointer.generation_id;
  return matches ? { ok: true } : { ok: false, reason: 'generation_advanced' };
}

module.exports = {
  LEASE_FILE,
  MAX_TOMBSTONES,
  readLease,
  acquireLease,
  releaseLease,
  validateLeaseOwnership,
  revalidateAgainstCurrentGeneration,
};
