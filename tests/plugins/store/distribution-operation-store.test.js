'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { createOperationRecord, advanceOperationPhase, findOperationByFingerprint, pruneTerminalOperationRecords } = require('../../../services/plugins/store/distribution-operation-store');
test('redacted operation recovery records advance monotonically and join by fingerprint', async () => {
  const fs = new MemoryFsFacade(); const record = { operation_record_schema_version: 1, operation_id: 'op', request_fingerprint: 'a'.repeat(64), operation_kind: 'install', phase: 'pending', sequence: 0, candidate_generation_id: 'g_op', created_at: '2026-08-04T00:00:00Z', updated_at: '2026-08-04T00:00:00Z' };
  assert.equal((await createOperationRecord(fs, 's', record)).outcome, 'created');
  assert.equal((await advanceOperationPhase(fs, 's', 'op', 'verification', '2026-08-04T00:00:01Z')).record.sequence, 1);
  assert.equal((await findOperationByFingerprint(fs, 's', 'a'.repeat(64))).record.operation_id, 'op');
});
test('concurrent identical fingerprints create one operation and join the other caller', async () => {
  const fs = new MemoryFsFacade(); const fingerprint = 'c'.repeat(64); const now = '2026-08-23T00:00:00Z';
  const record = (operationId) => ({ operation_record_schema_version: 1, operation_id: operationId,
    request_fingerprint: fingerprint, operation_kind: 'install', phase: 'pending', sequence: 0,
    candidate_generation_id: null, created_at: now, updated_at: now });
  const [first, second] = await Promise.all([
    createOperationRecord(fs, 's', record('op-a')),
    createOperationRecord(fs, 's', record('op-b')),
  ]);
  assert.deepEqual([first.outcome, second.outcome].sort(), ['created', 'joined']);
  assert.equal(first.record.operation_id, second.record.operation_id);
  assert.deepEqual(await fs.list('s/distribution/operations'), [`${first.record.operation_id}.json`]);
});
test('terminal operation records are retained for 30 days and then pruned', async () => {
  const fs = new MemoryFsFacade(); const record = { operation_record_schema_version: 1, operation_id: 'old', request_fingerprint: 'b'.repeat(64), operation_kind: 'check', phase: 'pending', sequence: 0, candidate_generation_id: 'g_old', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' };
  await createOperationRecord(fs, 's', record); await advanceOperationPhase(fs, 's', 'old', 'terminal', '2026-07-01T00:00:01Z');
  assert.deepEqual((await pruneTerminalOperationRecords(fs, 's', '2026-07-30T00:00:00Z')).removed, []);
  assert.deepEqual((await pruneTerminalOperationRecords(fs, 's', '2026-08-01T00:00:02Z')).removed, ['old']);
});
