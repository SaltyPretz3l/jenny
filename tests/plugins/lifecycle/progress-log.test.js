'use strict';

// PluginOperationProgressV1 admissibility (progress-log.js). This log is a
// display-only projection, never authority or idempotency (PLUG-D01, PLUG-D15
// live elsewhere) -- what these tests actually pin down is the fencing and
// eviction rules that keep a late/duplicate/out-of-order event from
// resurrecting or overwriting a settled operation
// (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md acceptance-matrix row "late/
// duplicate/out-of-order operation progress after terminal settlement").

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProgressLog,
  buildProgressEvent,
  isTerminalEvent,
} = require('../../../services/plugins/lifecycle/progress-log');

const NOW = '2026-07-31T00:00:00Z';
const DIGEST_A = 'a'.repeat(64);

function phaseEvent({
  operationId = 'op-1',
  sequence,
  lifecycleEpoch = 1,
  expectedGeneration = { commit_epoch: 0 },
  observedGeneration = { commit_epoch: 0 },
  phase = 'staging',
} = {}) {
  return buildProgressEvent({
    operationId,
    sequence,
    lifecycleEpoch,
    expectedGeneration,
    observedGeneration,
    recordedAt: NOW,
    event: { kind: 'phase', phase },
  });
}

function terminalEvent({
  operationId = 'op-1',
  sequence,
  lifecycleEpoch = 1,
  expectedGeneration = { commit_epoch: 0 },
  observedGeneration = { commit_epoch: 0 },
  status = 'committed',
  retryable = false,
  terminalResultDigest,
} = {}) {
  return buildProgressEvent({
    operationId,
    sequence,
    lifecycleEpoch,
    expectedGeneration,
    observedGeneration,
    recordedAt: NOW,
    event: terminalResultDigest
      ? { kind: 'terminal', status, retryable, terminal_result_digest: terminalResultDigest }
      : { kind: 'terminal', status, retryable },
  });
}

test('a sequence <= the highest already accepted is rejected sequence_not_monotonic', () => {
  const log = createProgressLog('op-1');
  const first = log.accept(phaseEvent({ sequence: 5 }));
  assert.equal(first.ok, true);

  const repeat = log.accept(phaseEvent({ sequence: 5 }));
  assert.equal(repeat.ok, false);
  assert.equal(repeat.reason, 'sequence_not_monotonic');

  const lower = log.accept(phaseEvent({ sequence: 2 }));
  assert.equal(lower.ok, false);
  assert.equal(lower.reason, 'sequence_not_monotonic');
});

test('one terminal event fences ALL later progress, even a strictly higher sequence -- the headline property', () => {
  const log = createProgressLog('op-1');
  assert.equal(log.accept(phaseEvent({ sequence: 1 })).ok, true);

  const terminal = log.accept(terminalEvent({ sequence: 2, status: 'committed', retryable: false }));
  assert.equal(terminal.ok, true);
  assert.equal(log.isSettled, true);

  // A late event carrying a HIGHER sequence than the terminal must still be
  // fenced: the terminal is a fence, not a high-water mark, so "arrived with
  // a bigger number" is never authority to reopen a settled operation.
  const late = log.accept(phaseEvent({ sequence: 100 }));
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'fenced_after_terminal');
  assert.equal(late.detail.terminalSequence, 2);
  assert.equal(late.detail.rejectedSequence, 100);
});

test('generation_mismatch is rejected when observed disagrees with expected', () => {
  const log = createProgressLog('op-1');
  const result = log.accept(phaseEvent({
    sequence: 1,
    expectedGeneration: { commit_epoch: 0 },
    observedGeneration: { commit_epoch: 1 },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generation_mismatch');
});

test('a binding that omits optional generation_id/revision on one side still matches on commit_epoch', () => {
  const log = createProgressLog('op-1');
  const result = log.accept(phaseEvent({
    sequence: 1,
    expectedGeneration: { commit_epoch: 3, generation_id: 'gen-a', revision: 2 },
    observedGeneration: { commit_epoch: 3 },
  }));
  assert.equal(result.ok, true);
});

test('an event addressed to a different operation_id is rejected operation_id_mismatch', () => {
  const log = createProgressLog('op-1');
  const result = log.accept(phaseEvent({ operationId: 'op-2', sequence: 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operation_id_mismatch');
  assert.deepEqual(result.detail, { expected: 'op-1', actual: 'op-2' });
});

test('bounded retention evicts the oldest non-terminal events but never the terminal', () => {
  const log = createProgressLog('op-1', { maxRetained: 2 });
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    assert.equal(log.accept(phaseEvent({ sequence })).ok, true);
  }
  // Only the most recent maxRetained events survive so far.
  assert.deepEqual(log.events.map((entry) => entry.sequence), [3, 4]);

  const terminal = log.accept(terminalEvent({ sequence: 5, status: 'committed', retryable: false }));
  assert.equal(terminal.ok, true);
  // Pushing the terminal put the log one entry over budget; eviction must
  // drop the oldest NON-terminal entry (sequence 3) rather than the
  // terminal -- dropping the terminal would un-fence the operation, which
  // is the precise failure this retention bound exists to prevent.
  assert.deepEqual(log.events.map((entry) => entry.sequence), [4, 5]);
  assert.ok(log.terminal);
  assert.equal(log.terminal.sequence, 5);
});

test('a schema-invalid event is rejected invalid_progress_event without throwing', () => {
  const log = createProgressLog('op-1');
  const result = log.accept({ not: 'a valid progress event' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_progress_event');
  assert.ok(result.detail);
});

test('buildProgressEvent throws on a malformed candidate', () => {
  assert.throws(() => buildProgressEvent({
    operationId: 'op-1',
    sequence: 1,
    lifecycleEpoch: 1,
    expectedGeneration: { commit_epoch: 0 },
    observedGeneration: { commit_epoch: 0 },
    recordedAt: NOW,
    event: { kind: 'phase', phase: 'not-a-real-phase' },
  }));
});

test('terminalSnapshot returns null before settlement and a plain snapshot after', () => {
  const log = createProgressLog('op-1');
  assert.equal(log.terminalSnapshot(), null);

  log.accept(phaseEvent({ sequence: 1 }));
  assert.equal(log.terminalSnapshot(), null, 'a non-terminal event must not settle the log');

  log.accept(terminalEvent({ sequence: 2, status: 'failed', retryable: true, terminalResultDigest: DIGEST_A }));
  assert.deepEqual(log.terminalSnapshot(), {
    sequence: 2,
    status: 'failed',
    retryable: true,
    terminal_result_digest: DIGEST_A,
  });
});

test('isTerminalEvent distinguishes a terminal envelope from phase/heartbeat/absent', () => {
  assert.equal(isTerminalEvent({ kind: 'terminal', status: 'committed', retryable: false }), true);
  assert.equal(isTerminalEvent({ kind: 'phase', phase: 'staging' }), false);
  assert.equal(isTerminalEvent({ kind: 'heartbeat' }), false);
  assert.equal(isTerminalEvent(null), false);
});
