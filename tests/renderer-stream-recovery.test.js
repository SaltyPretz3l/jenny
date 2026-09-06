'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStreamRecoveryController,
} = require('../renderer/chat/renderer-stream-recovery');

function createHarness(overrides = {}) {
  const calls = [];
  let resolvePersisted;
  const persisted = new Promise((resolve) => { resolvePersisted = resolve; });
  const controller = createStreamRecoveryController({
    getPersistedSession: async () => persisted,
    setSessionMessages: (...args) => calls.push(['messages', ...args]),
    setSessionTurnEventState: (...args) => calls.push(['turn-events', ...args]),
    clearRecoveredTerminalState: (...args) => calls.push(['clear-terminal', ...args]),
    clearSessionLiveTurnState: (...args) => calls.push(['clear-live', ...args]),
    rehydrateLiveTurnState: (...args) => calls.push(['rehydrate-live', ...args]),
    clearChatSendLifecycle: (...args) => calls.push(['clear-lifecycle', ...args]),
    queueSessionRender: (...args) => calls.push(['render', ...args]),
    setSessionComposerNotice: (...args) => calls.push(['notice', ...args]),
    fallbackToLegacy: (...args) => calls.push(['fallback', ...args]),
    isStreamCurrentForSession: () => true,
    hasSession: () => true,
    acknowledgeRecovery: async (record) => { calls.push(['ack', record]); return { ok: true }; },
    appendClientLog: (...args) => calls.push(['log', ...args]),
    ...overrides,
  });
  return { controller, calls, resolvePersisted };
}

const TICKET = Object.freeze({
  recovery_id: 'stream-1',
  renderer_epoch: 4,
  stream_id: 'stream-1',
  session_id: 'session-1',
  reason: 'renderer_terminal_ack_timeout',
});

test('recovery controller serializes duplicate tickets and acknowledges only after canonical apply', async () => {
  const harness = createHarness();
  const first = harness.controller.recover(TICKET);
  const duplicate = harness.controller.recover({ ...TICKET, renderer_epoch: 5 });
  harness.resolvePersisted({
    data: [{ id: 'assistant-1', role: 'assistant', status: 'complete', content: 'Done' }],
    turn_event_log_version: 3,
    turn_events: [{ event_id: 'terminal-1', kind: 'assistant_message' }],
    active_turn: null,
  });

  assert.deepEqual(await first, { ok: true, outcome: 'applied' });
  assert.deepEqual(await duplicate, { ok: true, outcome: 'applied' });
  assert.equal(harness.calls.filter((entry) => entry[0] === 'messages').length, 1);
  assert.equal(harness.calls.some((entry) => entry[0] === 'clear-terminal'), true);
  assert.equal(harness.calls.some((entry) => entry[0] === 'clear-live'), true);
  assert.equal(harness.calls.some((entry) => entry[0] === 'clear-lifecycle'), true);
  const ack = harness.calls.find((entry) => entry[0] === 'ack');
  assert.deepEqual(ack[1], {
    record_type: 'recovery_applied',
    recovery_id: 'stream-1',
    renderer_epoch: 5,
    stream_id: 'stream-1',
    session_id: 'session-1',
    outcome: 'applied',
  });
  assert.ok(harness.calls.findIndex((entry) => entry[0] === 'messages') < harness.calls.findIndex((entry) => entry[0] === 'ack'));

  await harness.controller.recover(TICKET);
  assert.equal(harness.calls.filter((entry) => entry[0] === 'messages').length, 1);
  assert.equal(harness.calls.filter((entry) => entry[0] === 'ack').length, 2);
});

test('recovery controller refuses stale stream mutation and acknowledges the superseded ticket', async () => {
  const calls = [];
  const controller = createStreamRecoveryController({
    getPersistedSession: async () => ({ data: [{ id: 'newer' }], turn_events: [], active_turn: null }),
    setSessionMessages: () => calls.push('messages'),
    isStreamCurrentForSession: () => false,
    fallbackToLegacy: () => calls.push('fallback'),
    acknowledgeRecovery: async (record) => { calls.push(record); return { ok: true }; },
  });

  assert.deepEqual(await controller.recover(TICKET), { ok: true, outcome: 'superseded' });
  assert.equal(calls.includes('messages'), false);
  assert.equal(calls.at(-1).outcome, 'superseded');
});

test('recovery controller retains the ticket when canonical hydration fails or disposal wins the await', async () => {
  const failedAcks = [];
  const failed = createStreamRecoveryController({
    getPersistedSession: async () => { throw new Error('store unavailable'); },
    acknowledgeRecovery: async (record) => failedAcks.push(record),
    fallbackToLegacy() {},
  });
  assert.deepEqual(await failed.recover(TICKET), { ok: false, reason: 'canonical_refresh_failed' });
  assert.deepEqual(failedAcks, []);

  const harness = createHarness();
  const pending = harness.controller.recover(TICKET);
  harness.controller.dispose();
  harness.resolvePersisted({ data: [{ id: 'late' }], turn_events: [], active_turn: null });
  assert.deepEqual(await pending, { ok: false, reason: 'disposed' });
  assert.equal(harness.calls.some((entry) => entry[0] === 'messages'), false);
  assert.equal(harness.calls.some((entry) => entry[0] === 'ack'), false);

  const callsBeforeDisposedRetry = harness.calls.length;
  assert.deepEqual(await harness.controller.recover(TICKET), { ok: false, reason: 'disposed' });
  assert.equal(harness.calls.length, callsBeforeDisposedRetry, 'disposed recovery rejects without fallback or I/O');
});

test('recovery controller does not render a canonical-read failure after disposal', async () => {
  let rejectPersisted;
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const harness = createHarness({
    getPersistedSession: async () => {
      markReadStarted();
      return new Promise((_, reject) => { rejectPersisted = reject; });
    },
  });
  const pending = harness.controller.recover(TICKET);
  await readStarted;
  harness.controller.dispose();
  const callsAtDispose = harness.calls.length;
  rejectPersisted(new Error('late store failure'));

  assert.deepEqual(await pending, { ok: false, reason: 'disposed' });
  assert.equal(harness.calls.length, callsAtDispose);
});

test('recovery controller times out a stalled canonical read and allows a later retry', async () => {
  let reads = 0;
  const controller = createStreamRecoveryController({
    canonicalReadDeadlineMs: 5,
    getPersistedSession: async () => {
      reads += 1;
      if (reads === 1) return new Promise(() => {});
      return { data: [{ id: 'settled' }], turn_events: [], active_turn: null };
    },
    hasSession: () => true,
  });

  assert.deepEqual(await controller.recover(TICKET), {
    ok: false,
    reason: 'canonical_refresh_failed',
  });
  assert.deepEqual(await controller.recover(TICKET), { ok: true, outcome: 'applied' });
  assert.equal(reads, 2);
});

test('recovery controller rehydrates an active canonical turn without settling its stream', async () => {
  const calls = [];
  const controller = createStreamRecoveryController({
    getPersistedSession: async () => ({
      data: [{ id: 'partial' }],
      turn_event_log_version: 2,
      turn_events: [{ event_id: 'partial-1' }],
      active_turn: { stream_id: 'stream-1', turn_id: 'turn-1' },
    }),
    setSessionMessages: () => calls.push('messages'),
    setSessionTurnEventState: () => calls.push('turn-events'),
    clearRecoveredTerminalState: () => calls.push('clear-terminal'),
    clearSessionLiveTurnState: () => calls.push('clear-live'),
    rehydrateLiveTurnState: () => calls.push('rehydrate-live'),
    fallbackToLegacy: () => calls.push('fallback'),
    isStreamCurrentForSession: () => true,
    hasSession: () => true,
  });

  assert.deepEqual(await controller.recover({ ...TICKET, recovery_id: '' }), { ok: true, outcome: 'applied' });
  assert.equal(calls.includes('rehydrate-live'), true);
  assert.equal(calls.includes('clear-terminal'), false);
  assert.equal(calls.includes('clear-live'), false);
});

test('recovery controller re-acknowledges an applied snapshot after an initial acknowledgement refusal', async () => {
  let canonicalReads = 0;
  let ackAttempts = 0;
  const controller = createStreamRecoveryController({
    getPersistedSession: async () => {
      canonicalReads += 1;
      return { data: [{ id: 'settled' }], turn_events: [], active_turn: null };
    },
    hasSession: () => true,
    acknowledgeRecovery: async () => {
      ackAttempts += 1;
      return ackAttempts === 1 ? { ok: false, reason: 'busy' } : { ok: true };
    },
  });

  assert.deepEqual(await controller.recover(TICKET), {
    ok: false,
    reason: 'recovery_ack_failed',
    outcome: 'applied',
  });
  assert.deepEqual(await controller.recover({ ...TICKET, renderer_epoch: 5 }), {
    ok: true,
    outcome: 'applied',
  });
  assert.equal(canonicalReads, 1);
  assert.equal(ackAttempts, 2);
});

test('recovery controller preserves the recovery-ack failure result on cached retries', async () => {
  let canonicalReads = 0;
  const controller = createStreamRecoveryController({
    getPersistedSession: async () => {
      canonicalReads += 1;
      return { data: [{ id: 'settled' }], turn_events: [], active_turn: null };
    },
    hasSession: () => true,
    acknowledgeRecovery: async () => ({ ok: false, reason: 'busy' }),
  });

  const expected = { ok: false, reason: 'recovery_ack_failed', outcome: 'applied' };
  assert.deepEqual(await controller.recover(TICKET), expected);
  assert.deepEqual(await controller.recover({ ...TICKET, renderer_epoch: 5 }), expected);
  assert.equal(canonicalReads, 1);
});

test('JCA-011: dispose settles a permanently stalled canonical read and releases its timer and abort controller', async () => {
  // Regression: per-read resources used to be local to readCanonicalSession, so
  // dispose() could not reach them — teardown retained the recovery promise for
  // the full 20s deadline and left the bridge read running with no abort.
  // This read NEVER settles (the earlier disposal tests resolve theirs late).
  const timers = new Map();
  let timerId = 0;
  let observedSignal = null;
  const controller = createStreamRecoveryController({
    getPersistedSession: (_sessionId, options) => {
      observedSignal = options?.signal || null;
      return new Promise(() => {}); // permanently stalled
    },
    fallbackToLegacy: () => {},
    appendClientLog: () => {},
    setTimeoutImpl: (callback, delayMs) => {
      timerId += 1;
      timers.set(timerId, { callback, delayMs });
      return timerId;
    },
    clearTimeoutImpl: (handle) => { timers.delete(handle); },
  });

  const pending = controller.recover(TICKET);
  // Let the queued recovery reach the canonical read: the deadline timer arms
  // synchronously but the bridge read itself starts one microtask later.
  for (let i = 0; i < 20 && (timers.size === 0 || observedSignal === null); i += 1) {
    await Promise.resolve();
  }
  assert.equal(timers.size, 1, 'the read deadline timer is armed while the read is stalled');
  assert.ok(observedSignal, 'the bridge read receives the controller-owned abort signal');
  assert.equal(observedSignal.aborted, false);

  controller.dispose();

  assert.deepEqual(await pending, { ok: false, reason: 'disposed' },
    'the stalled recovery settles at dispose time, not after the 20s deadline');
  assert.equal(timers.size, 0, 'no deadline timer survives dispose');
  assert.equal(observedSignal.aborted, true, 'the underlying bridge read is aborted');
});
