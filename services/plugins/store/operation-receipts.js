'use strict';

// Durable pending/terminal operation receipts: `operations/<operation_id>.json`
// (PLUG-D15, invariant 18). Receipts -- not the bounded journal.js evidence log
// -- own idempotency. Every authority-bearing mutation must durably record a
// pending receipt (createPendingReceipt) before any side effect, and settle it
// (settleReceipt) once the outcome is known.
//
// Two distinct read paths, matching two distinct real callers:
//   - evaluateIdempotency: called at the START of a mutation attempt that just
//     minted (or is re-driving) `operationId`. "Not found" is the ordinary,
//     expected case for a freshly minted id (Electron always mints a new
//     operation_id per invariant 18) and means it is safe to proceed.
//   - evaluateStatusQuery: called by a pure status/retry lookup that must
//     reference an operation_id it believes already exists ("retry/status
//     paths may reference only an existing operation id and cannot create
//     one" -- PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md). Here "not found" (or
//     expired) is fail-closed: it is classified `idempotency_expired` /
//     `outcome_indeterminate` and never treated as permission to (re-)execute.
// A caller that wants to safely re-drive a previously minted operation_id
// (e.g. its first response was lost) should check evaluateStatusQuery first
// rather than assuming evaluateIdempotency's "not found -> proceed" applies.

const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');
const { validate } = require('../contracts/generated-plugin-contracts');

const CONTRACT_NAME = 'PluginOperationReceiptV1';
const OPERATIONS_DIR = 'operations';
const TERMINAL_STATUSES = new Set(['committed', 'failed', 'indeterminate', 'expired']);
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TERMINAL_RECEIPTS = 4096;
// The generator supports object contracts but not cross-field conditional
// requirements. V1 therefore requires retain_until structurally on every
// receipt and uses a non-expiring sentinel while pending; terminal settlement
// always replaces it with the real 30-day deadline. Pending/corrupt evidence
// is never compacted regardless of this field.
const PENDING_RETAIN_UNTIL = '9999-12-31T23:59:59Z';

function receiptFileName(operationId) {
  return `${operationId}.json`;
}

function isExpired(receipt, nowIso) {
  if (!receipt.retain_until) return false;
  const retainUntilMs = Date.parse(receipt.retain_until);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(retainUntilMs) || Number.isNaN(nowMs)) return false;
  return nowMs >= retainUntilMs;
}

function defaultRetainUntil(nowIso, retentionMs = DEFAULT_RETENTION_MS) {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(retentionMs) || retentionMs < 1) {
    return null;
  }
  return new Date(nowMs + retentionMs).toISOString();
}

async function getReceipt(facade, baseDir, operationId) {
  const read = await readJsonFile(facade, joinPath(baseDir, OPERATIONS_DIR, receiptFileName(operationId)));
  if (read.status === 'missing') {
    return { found: false, corrupted: false };
  }
  if (read.status === 'corrupted') {
    return { found: false, corrupted: true, error: read.error };
  }
  const validated = validate(CONTRACT_NAME, read.value);
  if (!validated.ok) {
    return { found: false, corrupted: true, error: `${validated.error.path}: ${validated.error.reason}` };
  }
  return { found: true, corrupted: false, receipt: validated.value };
}

async function createPendingReceipt(
  facade,
  baseDir,
  { operationId, requestFingerprint, generationId, lifecycleEpoch, commitEpoch, now }
) {
  const existing = await getReceipt(facade, baseDir, operationId);
  if (existing.corrupted) {
    return { ok: false, reason: 'operation_receipt_corrupted', detail: existing.error };
  }
  if (existing.found) {
    if (existing.receipt.request_fingerprint !== requestFingerprint) {
      return { ok: false, reason: 'fingerprint_mismatch' };
    }
    return { ok: true, outcome: 'joined', receipt: existing.receipt };
  }
  const candidate = {
    operation_id: operationId,
    request_fingerprint: requestFingerprint,
    generation_id: generationId,
    lifecycle_epoch: lifecycleEpoch,
    commit_epoch: commitEpoch,
    status: 'pending',
    created_at: now,
    updated_at: now,
    retain_until: PENDING_RETAIN_UNTIL,
  };
  const validated = validate(CONTRACT_NAME, candidate);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_receipt', detail: validated.error };
  }
  await writeJsonFileAtomic(facade, joinPath(baseDir, OPERATIONS_DIR), receiptFileName(operationId), validated.value);
  return { ok: true, outcome: 'created', receipt: validated.value };
}

async function settleReceipt(
  facade,
  baseDir,
  { operationId, status, terminalResultDigest, now, retainUntil, retentionMs = DEFAULT_RETENTION_MS }
) {
  if (!TERMINAL_STATUSES.has(status)) {
    return { ok: false, reason: 'invalid_terminal_status' };
  }
  const existing = await getReceipt(facade, baseDir, operationId);
  if (existing.corrupted) {
    return { ok: false, reason: 'operation_receipt_corrupted', detail: existing.error };
  }
  if (!existing.found) {
    return { ok: false, reason: 'operation_receipt_not_found' };
  }
  if (existing.receipt.status !== 'pending') {
    if (existing.receipt.status === status) {
      return { ok: true, outcome: 'already_settled', receipt: existing.receipt };
    }
    return { ok: false, reason: 'already_settled_with_different_status', detail: { existing: existing.receipt.status } };
  }
  const next = {
    ...existing.receipt,
    status,
    updated_at: now,
    retain_until: retainUntil || defaultRetainUntil(now, retentionMs),
  };
  if (terminalResultDigest) next.terminal_result_digest = terminalResultDigest;
  if (!next.retain_until) {
    return { ok: false, reason: 'invalid_retention_deadline' };
  }
  const validated = validate(CONTRACT_NAME, next);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_receipt', detail: validated.error };
  }
  await writeJsonFileAtomic(facade, joinPath(baseDir, OPERATIONS_DIR), receiptFileName(operationId), validated.value);
  return { ok: true, outcome: 'settled', receipt: validated.value };
}

// Mutation-path idempotency decision. See module header for when to use this
// versus evaluateStatusQuery.
async function evaluateIdempotency(facade, baseDir, { operationId, requestFingerprint, now }) {
  const existing = await getReceipt(facade, baseDir, operationId);
  if (existing.corrupted) {
    return { decision: 'reject_indeterminate', reason: 'operation_receipt_corrupted' };
  }
  if (!existing.found) {
    return { decision: 'proceed_new' };
  }
  const receipt = existing.receipt;
  if (receipt.request_fingerprint !== requestFingerprint) {
    return { decision: 'reject_fingerprint_mismatch', receipt };
  }
  if (isExpired(receipt, now)) {
    return { decision: 'reject_expired', receipt };
  }
  if (receipt.status === 'pending') {
    return { decision: 'join_pending', receipt };
  }
  return { decision: 'return_recorded_outcome', receipt };
}

// Status/retry-path classification. Never authorizes (re-)execution: an
// unknown, corrupted, or expired id always comes back fail-closed.
async function evaluateStatusQuery(facade, baseDir, { operationId, now }) {
  const existing = await getReceipt(facade, baseDir, operationId);
  if (existing.corrupted) {
    return { classification: 'outcome_indeterminate', reason: 'operation_receipt_corrupted' };
  }
  if (!existing.found) {
    return { classification: 'idempotency_expired', reason: 'operation_receipt_unknown' };
  }
  const receipt = existing.receipt;
  if (receipt.status === 'pending') {
    return { classification: 'pending', receipt };
  }
  if (isExpired(receipt, now)) {
    return { classification: 'idempotency_expired', reason: 'retain_until_elapsed', receipt };
  }
  return { classification: 'terminal', receipt };
}

// Removes only terminal, expired receipts. Pending receipts and corrupted
// files are left untouched -- compaction must never destroy evidence it
// cannot prove is safe to discard.
async function compactReceipts(
  facade,
  baseDir,
  { now, maxTerminalReceipts = DEFAULT_MAX_TERMINAL_RECEIPTS, onWarning = null }
) {
  const dir = joinPath(baseDir, OPERATIONS_DIR);
  const names = await facade.list(dir);
  const removed = [];
  const terminals = [];
  let pendingCount = 0;
  let corruptCount = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const operationId = name.slice(0, -'.json'.length);
    const existing = await getReceipt(facade, baseDir, operationId);
    if (existing.corrupted) {
      corruptCount += 1;
      continue;
    }
    if (existing.found && TERMINAL_STATUSES.has(existing.receipt.status) && isExpired(existing.receipt, now)) {
      await facade.remove(joinPath(dir, name));
      removed.push(operationId);
    } else if (existing.found && TERMINAL_STATUSES.has(existing.receipt.status)) {
      terminals.push(existing.receipt);
    } else {
      pendingCount += 1;
    }
  }
  terminals.sort((a, b) => {
    const byUpdated = Date.parse(a.updated_at) - Date.parse(b.updated_at);
    return byUpdated || a.operation_id.localeCompare(b.operation_id);
  });
  const capEvicted = [];
  if (Number.isSafeInteger(maxTerminalReceipts) && maxTerminalReceipts >= 0) {
    const overflow = Math.max(0, terminals.length - maxTerminalReceipts);
    for (const receipt of terminals.slice(0, overflow)) {
      await facade.remove(joinPath(dir, receiptFileName(receipt.operation_id)));
      capEvicted.push(receipt.operation_id);
    }
  }
  if (capEvicted.length > 0 && typeof onWarning === 'function') {
    onWarning({
      event: 'plugins.operation_receipts.cap_eviction',
      level: 'WARN',
      evicted_count: capEvicted.length,
      max_terminal_receipts: maxTerminalReceipts,
    });
  }
  return {
    removed,
    capEvicted,
    expiredRemovedCount: removed.length,
    capEvictedCount: capEvicted.length,
    terminalKeptCount: terminals.length - capEvicted.length,
    pendingCount,
    corruptCount,
  };
}

module.exports = {
  CONTRACT_NAME,
  OPERATIONS_DIR,
  TERMINAL_STATUSES,
  DEFAULT_RETENTION_MS,
  PENDING_RETAIN_UNTIL,
  getReceipt,
  createPendingReceipt,
  settleReceipt,
  evaluateIdempotency,
  evaluateStatusQuery,
  compactReceipts,
};
