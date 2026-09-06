'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REJECT_REASONS,
  initialSettlementState,
  reduceFrame,
  isSettled,
} = require('../../../services/plugins/protocol/frame-settlement.js');
const { createHostSimulator } = require('../../helpers/plugins/host-simulator.js');

function freshContext(overrides) {
  return {
    invocationId: 'inv-good',
    commitEpoch: 5,
    lifecycleEpoch: 2,
    maxStreamFrames: 8,
    maxFrameUtf8Bytes: 32,
    maxStreamTotalUtf8Bytes: 256,
    deadlineEpochMs: 10_000,
    ...overrides,
  };
}

test('a well-behaved stream accepts progress/data frames then exactly one terminal', () => {
  const sim = createHostSimulator({ invocationId: 'inv-good', commitEpoch: 5, lifecycleEpoch: 2 });
  let state = initialSettlementState(freshContext());

  const progress = reduceFrame(state, sim.progress('starting'), 0);
  assert.equal(progress.ok, true);
  state = progress.state;

  const data = reduceFrame(state, sim.data('chunk'), 1);
  assert.equal(data.ok, true);
  state = data.state;

  const terminal = reduceFrame(state, sim.terminal('succeeded', { retryable: false }), 2);
  assert.equal(terminal.ok, true);
  state = terminal.state;

  assert.equal(isSettled(state), true);
  assert.equal(state.terminal.status, 'succeeded');
  assert.equal(state.frameCount, 3);
});

test('out-of-order sequence is rejected without mutating settlement', () => {
  const sim = createHostSimulator({ invocationId: 'inv-ooo', commitEpoch: 5, lifecycleEpoch: 2 });
  const [first, second] = sim.misbehavior.outOfOrderPair();
  let state = initialSettlementState(freshContext({ invocationId: 'inv-ooo' }));

  const firstResult = reduceFrame(state, first, 0);
  assert.equal(firstResult.ok, true);
  state = firstResult.state;

  const secondResult = reduceFrame(state, second, 1);
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.error.code, REJECT_REASONS.OUT_OF_ORDER_SEQUENCE);
  assert.equal(isSettled(secondResult.state), false);
});

test('a duplicate terminal after real settlement is rejected and the recorded terminal is unchanged', () => {
  const sim = createHostSimulator({ invocationId: 'inv-dup', commitEpoch: 5, lifecycleEpoch: 2 });
  const [first, dup] = sim.misbehavior.duplicateTerminal();
  let state = initialSettlementState(freshContext({ invocationId: 'inv-dup' }));

  const firstResult = reduceFrame(state, first, 0);
  assert.equal(firstResult.ok, true);
  state = firstResult.state;
  assert.equal(state.terminal.status, 'succeeded');

  const dupResult = reduceFrame(state, dup, 1);
  assert.equal(dupResult.ok, false);
  assert.equal(dupResult.error.code, REJECT_REASONS.ALREADY_TERMINAL);
  assert.equal(dupResult.state.terminal.status, 'succeeded', 'the dup carried status=failed but must not overwrite it');
});

test('a payload over the per-frame byte budget is rejected', () => {
  const sim = createHostSimulator({ invocationId: 'inv-big', commitEpoch: 5, lifecycleEpoch: 2 });
  const state = initialSettlementState(freshContext({ invocationId: 'inv-big', maxFrameUtf8Bytes: 8 }));
  const oversized = sim.misbehavior.overBudgetPayload(64);

  const result = reduceFrame(state, oversized, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.FRAME_PAYLOAD_BUDGET_EXCEEDED);
});

test('a running total over the stream byte budget is rejected even when each frame is individually small', () => {
  const sim = createHostSimulator({ invocationId: 'inv-total', commitEpoch: 5, lifecycleEpoch: 2 });
  let state = initialSettlementState(freshContext({ invocationId: 'inv-total', maxFrameUtf8Bytes: 16, maxStreamTotalUtf8Bytes: 15 }));

  const first = reduceFrame(state, sim.data('0123456789'), 0);
  assert.equal(first.ok, true);
  state = first.state;

  const second = reduceFrame(state, sim.data('0123456789'), 1);
  assert.equal(second.ok, false);
  assert.equal(second.error.code, REJECT_REASONS.STREAM_TOTAL_BUDGET_EXCEEDED);
});

test('a frame stamped with a stale commit_epoch is rejected as wrong-epoch', () => {
  const sim = createHostSimulator({ invocationId: 'inv-epoch', commitEpoch: 5, lifecycleEpoch: 2 });
  const state = initialSettlementState(freshContext({ invocationId: 'inv-epoch' }));
  const staleFrame = sim.misbehavior.staleEpoch();

  const result = reduceFrame(state, staleFrame, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.WRONG_EPOCH);
});

test('flooding past the frame-count budget is rejected once the ceiling is hit', () => {
  const sim = createHostSimulator({ invocationId: 'inv-flood', commitEpoch: 5, lifecycleEpoch: 2 });
  let state = initialSettlementState(freshContext({ invocationId: 'inv-flood', maxStreamFrames: 3 }));
  const flood = sim.misbehavior.floodQueue(5);

  const results = flood.map((frame, index) => {
    const outcome = reduceFrame(state, frame, index);
    if (outcome.ok) state = outcome.state;
    return outcome.ok;
  });

  assert.deepEqual(results, [true, true, true, false, false]);
});

test('a frame arriving after the invocation deadline is rejected as late', () => {
  const sim = createHostSimulator({ invocationId: 'inv-late', commitEpoch: 5, lifecycleEpoch: 2 });
  const state = initialSettlementState(freshContext({ invocationId: 'inv-late', deadlineEpochMs: 1000 }));
  const { frame, arrivalNowMs } = sim.misbehavior.stallPastDeadline(1000, 500);

  const result = reduceFrame(state, frame, arrivalNowMs);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.FRAME_LATE);
});

// A dead field in this state shape is not free: `transportClosed` and the
// terminal's `viaTransportFailure` outlived the settleTransportFailure() path
// that wrote them (deleted in 4b352b16) and were later read by a reviewer as an
// active host-exit invariant. Pin the shape so the next residue is caught here
// rather than inferred as a feature.
test('the settlement state and its terminal expose no fields nothing writes', () => {
  const sim = createHostSimulator({ invocationId: 'inv-shape', commitEpoch: 5, lifecycleEpoch: 2 });
  const initial = initialSettlementState(freshContext({ invocationId: 'inv-shape' }));
  assert.deepEqual(Object.keys(initial).sort(), [
    'acknowledgedSequence',
    'context',
    'frameCount',
    'lastSequence',
    'terminal',
    'totalPayloadBytes',
    'unackedCount',
  ]);

  const settled = reduceFrame(initial, sim.terminal('succeeded', { retryable: false }), 0);
  assert.equal(settled.ok, true);
  // The reducer records the frame's own terminal verbatim; it synthesizes nothing.
  assert.deepEqual(
    Object.keys(settled.state.terminal).sort(),
    Object.keys(sim.terminal('succeeded', { retryable: false }).frame).sort()
  );
});
