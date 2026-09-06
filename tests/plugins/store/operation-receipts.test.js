'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  createPendingReceipt: createPendingReceiptRaw,
  settleReceipt,
  getReceipt,
  evaluateIdempotency,
  evaluateStatusQuery,
  compactReceipts,
  DEFAULT_RETENTION_MS,
  PENDING_RETAIN_UNTIL,
} = require('../../../services/plugins/store/operation-receipts');

const NOW = '2026-07-31T00:00:00Z';
const LATER = '2026-08-05T00:00:00Z';
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const GENERATION_ID = 'gen-0001';

function createPendingReceipt(facade, baseDir, input) {
  return createPendingReceiptRaw(facade, baseDir, {
    generationId: GENERATION_ID,
    ...input,
  });
}

test('createPendingReceipt requires generation attribution', async () => {
  const facade = createMemoryFsFacade();
  const result = await createPendingReceiptRaw(facade, 'plugins', {
    operationId: 'op-0001', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_receipt');
  assert.equal(result.detail.path, 'generation_id');
});

test('createPendingReceipt creates a fresh pending receipt for a new operation id', async () => {
  const facade = createMemoryFsFacade();
  const result = await createPendingReceipt(facade, 'plugins', {
    operationId: 'op-0001', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'created');
  assert.equal(result.receipt.status, 'pending');
  assert.equal(result.receipt.retain_until, PENDING_RETAIN_UNTIL);
});

test('createPendingReceipt with the same id and same fingerprint joins the existing receipt (PLUG-D15)', async () => {
  const facade = createMemoryFsFacade();
  const first = await createPendingReceipt(facade, 'plugins', {
    operationId: 'op-0001', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  const second = await createPendingReceipt(facade, 'plugins', {
    operationId: 'op-0001', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  assert.equal(second.ok, true);
  assert.equal(second.outcome, 'joined');
  assert.deepEqual(second.receipt, first.receipt);
});

test('createPendingReceipt with the same id but a different fingerprint is rejected (PLUG-D15)', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', {
    operationId: 'op-0001', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  const result = await createPendingReceipt(facade, 'plugins', {
    operationId: 'op-0001', requestFingerprint: FP_B, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'fingerprint_mismatch' });
});

test('settleReceipt transitions a pending receipt to a terminal status and records the terminal digest', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', {
    operationId: 'op-0001', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  const settled = await settleReceipt(facade, 'plugins', {
    operationId: 'op-0001', status: 'committed', terminalResultDigest: 'c'.repeat(64), now: LATER, retainUntil: '2026-09-01T00:00:00Z',
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.receipt.status, 'committed');
  assert.equal(settled.receipt.terminal_result_digest, 'c'.repeat(64));
  assert.equal(settled.receipt.retain_until, '2026-09-01T00:00:00Z');
});

test('settleReceipt defaults terminal retention to exactly 30 days', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', {
    operationId: 'op-default-retention', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  const settled = await settleReceipt(facade, 'plugins', {
    operationId: 'op-default-retention', status: 'committed', now: NOW,
  });
  assert.equal(DEFAULT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(settled.receipt.retain_until, '2026-08-30T00:00:00.000Z');
});

test('invalid retention configuration and terminal receipts without retain_until fail closed', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', {
    operationId: 'op-invalid-retention', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  const invalid = await settleReceipt(facade, 'plugins', {
    operationId: 'op-invalid-retention', status: 'committed', now: NOW, retentionMs: 0,
  });
  assert.equal(invalid.reason, 'invalid_retention_deadline');

  const pending = await getReceipt(facade, 'plugins', 'op-invalid-retention');
  const malformedTerminal = {
    ...pending.receipt,
    status: 'committed',
    updated_at: NOW,
  };
  delete malformedTerminal.retain_until;
  await facade.writeFile(
    'plugins/operations/op-invalid-retention.json',
    JSON.stringify(malformedTerminal)
  );
  const missingDeadline = await getReceipt(facade, 'plugins', 'op-invalid-retention');
  assert.equal(missingDeadline.corrupted, true);
  assert.match(missingDeadline.error, /retain_until: .*required field/);
});

test('settleReceipt rejects settling an operation that was never created', async () => {
  const facade = createMemoryFsFacade();
  const result = await settleReceipt(facade, 'plugins', { operationId: 'never-created', status: 'committed', now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'operation_receipt_not_found' });
});

test('settleReceipt re-settling with the SAME terminal status is an idempotent no-op', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  await settleReceipt(facade, 'plugins', { operationId: 'op-1', status: 'committed', now: NOW });
  const again = await settleReceipt(facade, 'plugins', { operationId: 'op-1', status: 'committed', now: LATER });
  assert.equal(again.ok, true);
  assert.equal(again.outcome, 'already_settled');
});

test('settleReceipt refuses to flip an already-terminal receipt to a different status', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  await settleReceipt(facade, 'plugins', { operationId: 'op-1', status: 'committed', now: NOW });
  const flip = await settleReceipt(facade, 'plugins', { operationId: 'op-1', status: 'failed', now: LATER });
  assert.equal(flip.ok, false);
  assert.equal(flip.reason, 'already_settled_with_different_status');
});

test('evaluateIdempotency: unknown operation id proceeds as new (Electron always mints a fresh id)', async () => {
  const facade = createMemoryFsFacade();
  const result = await evaluateIdempotency(facade, 'plugins', { operationId: 'brand-new', requestFingerprint: FP_A, now: NOW });
  assert.deepEqual(result, { decision: 'proceed_new' });
});

test('evaluateIdempotency: same id + same fingerprint while pending joins the in-flight attempt', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  const result = await evaluateIdempotency(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, now: NOW });
  assert.equal(result.decision, 'join_pending');
});

test('evaluateIdempotency: same id + same fingerprint after settlement returns the recorded outcome', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  await settleReceipt(facade, 'plugins', { operationId: 'op-1', status: 'committed', now: NOW });
  const result = await evaluateIdempotency(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, now: NOW });
  assert.equal(result.decision, 'return_recorded_outcome');
  assert.equal(result.receipt.status, 'committed');
});

test('evaluateIdempotency: same id + different fingerprint is rejected', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  const result = await evaluateIdempotency(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_B, now: NOW });
  assert.equal(result.decision, 'reject_fingerprint_mismatch');
});

test('evaluateIdempotency: an expired terminal receipt is rejected and never authorizes re-execution, even with a matching fingerprint', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  await settleReceipt(facade, 'plugins', { operationId: 'op-1', status: 'committed', now: NOW, retainUntil: '2026-08-01T00:00:00Z' });
  const result = await evaluateIdempotency(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, now: '2026-09-01T00:00:00Z' });
  assert.equal(result.decision, 'reject_expired');
});

test('evaluateStatusQuery classifies an unknown operation id as idempotency_expired, never as safe to execute', async () => {
  const facade = createMemoryFsFacade();
  const result = await evaluateStatusQuery(facade, 'plugins', { operationId: 'never-seen', now: NOW });
  assert.deepEqual(result, { classification: 'idempotency_expired', reason: 'operation_receipt_unknown' });
});

test('evaluateStatusQuery classifies a corrupted receipt as outcome_indeterminate', async () => {
  const facade = createMemoryFsFacade();
  await facade.mkdir('plugins/operations');
  await facade.writeFile('plugins/operations/op-1.json', '{not json');
  const result = await evaluateStatusQuery(facade, 'plugins', { operationId: 'op-1', now: NOW });
  assert.equal(result.classification, 'outcome_indeterminate');
});

test('evaluateStatusQuery classifies a pending receipt as pending and a fresh terminal receipt as terminal', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  const pendingResult = await evaluateStatusQuery(facade, 'plugins', { operationId: 'op-1', now: NOW });
  assert.equal(pendingResult.classification, 'pending');

  await settleReceipt(facade, 'plugins', { operationId: 'op-1', status: 'committed', now: NOW });
  const terminalResult = await evaluateStatusQuery(facade, 'plugins', { operationId: 'op-1', now: NOW });
  assert.equal(terminalResult.classification, 'terminal');
});

test('getReceipt reports found:false for a missing operation and found:true for an existing one', async () => {
  const facade = createMemoryFsFacade();
  assert.deepEqual(await getReceipt(facade, 'plugins', 'missing'), { found: false, corrupted: false });
  await createPendingReceipt(facade, 'plugins', { operationId: 'op-1', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  const found = await getReceipt(facade, 'plugins', 'op-1');
  assert.equal(found.found, true);
});

test('compactReceipts removes only terminal, expired receipts and leaves pending/corrupted/unexpired alone', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', { operationId: 'expired-terminal', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  await settleReceipt(facade, 'plugins', { operationId: 'expired-terminal', status: 'committed', now: NOW, retainUntil: '2026-08-01T00:00:00Z' });

  await createPendingReceipt(facade, 'plugins', { operationId: 'fresh-terminal', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });
  await settleReceipt(facade, 'plugins', { operationId: 'fresh-terminal', status: 'committed', now: NOW, retainUntil: '2027-01-01T00:00:00Z' });

  await createPendingReceipt(facade, 'plugins', { operationId: 'still-pending', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW });

  await facade.mkdir('plugins/operations');
  await facade.writeFile('plugins/operations/corrupt-one.json', '{not json');

  const summary = await compactReceipts(facade, 'plugins', { now: '2026-09-01T00:00:00Z' });
  assert.deepEqual(summary.removed, ['expired-terminal']);
  assert.equal(summary.terminalKeptCount, 1);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.corruptCount, 1);

  const stillThere = await getReceipt(facade, 'plugins', 'fresh-terminal');
  assert.equal(stillThere.found, true);
  const pendingStillThere = await getReceipt(facade, 'plugins', 'still-pending');
  assert.equal(pendingStillThere.found, true);
});

test('a terminal receipt expires exactly at retain_until', async () => {
  const facade = createMemoryFsFacade();
  await createPendingReceipt(facade, 'plugins', {
    operationId: 'deadline-terminal', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  await settleReceipt(facade, 'plugins', {
    operationId: 'deadline-terminal', status: 'committed', now: NOW, retainUntil: LATER,
  });
  const status = await evaluateStatusQuery(facade, 'plugins', {
    operationId: 'deadline-terminal', now: LATER,
  });
  assert.equal(status.classification, 'idempotency_expired');
  assert.equal(status.reason, 'retain_until_elapsed');
});

test('compactReceipts evicts oldest terminal receipts at the cap and preserves pending/corrupt evidence', async () => {
  const facade = createMemoryFsFacade();
  for (const [operationId, settledAt] of [['old-terminal', NOW], ['new-terminal', LATER]]) {
    await createPendingReceipt(facade, 'plugins', {
      operationId, requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: settledAt,
    });
    await settleReceipt(facade, 'plugins', {
      operationId, status: 'committed', now: settledAt, retainUntil: '2027-01-01T00:00:00Z',
    });
  }
  await createPendingReceipt(facade, 'plugins', {
    operationId: 'still-pending', requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: NOW,
  });
  await facade.writeFile('plugins/operations/corrupt.json', '{not json');
  const warnings = [];
  const summary = await compactReceipts(facade, 'plugins', {
    now: '2026-09-01T00:00:00Z', maxTerminalReceipts: 1, onWarning: (warning) => warnings.push(warning),
  });
  assert.deepEqual(summary.capEvicted, ['old-terminal']);
  assert.equal(summary.capEvictedCount, 1);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.corruptCount, 1);
  assert.deepEqual(warnings, [{
    event: 'plugins.operation_receipts.cap_eviction',
    level: 'WARN',
    evicted_count: 1,
    max_terminal_receipts: 1,
  }]);
  assert.equal((await getReceipt(facade, 'plugins', 'still-pending')).found, true);
  assert.equal((await getReceipt(facade, 'plugins', 'corrupt')).corrupted, true);
  assert.deepEqual(
    await evaluateStatusQuery(facade, 'plugins', { operationId: 'old-terminal', now: '2026-09-01T00:00:00Z' }),
    { classification: 'idempotency_expired', reason: 'operation_receipt_unknown' }
  );
});

test('cap eviction orders mixed fractional ISO timestamps chronologically', async () => {
  const facade = createMemoryFsFacade();
  for (const [operationId, settledAt] of [
    ['whole-second', '2026-08-05T00:00:00Z'],
    ['fractional-second', '2026-08-05T00:00:00.100Z'],
  ]) {
    await createPendingReceipt(facade, 'plugins', {
      operationId, requestFingerprint: FP_A, lifecycleEpoch: 1, commitEpoch: 0, now: settledAt,
    });
    await settleReceipt(facade, 'plugins', {
      operationId, status: 'committed', now: settledAt, retainUntil: '2027-01-01T00:00:00Z',
    });
  }

  const summary = await compactReceipts(facade, 'plugins', {
    now: '2026-09-01T00:00:00Z', maxTerminalReceipts: 1,
  });
  assert.deepEqual(summary.capEvicted, ['whole-second']);
});
