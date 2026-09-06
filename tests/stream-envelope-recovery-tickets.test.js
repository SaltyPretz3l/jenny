'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStreamEnvelopeRecoveryTicketStore,
} = require('../services/stream-envelope-recovery-tickets');

test('recovery tickets retain identity-only state until an exact current-epoch acknowledgement', () => {
  const sent = [];
  let retry = null;
  const store = createStreamEnvelopeRecoveryTicketStore({
    sendRecoveryRequired(payload) { sent.push(structuredClone(payload)); },
    setRetry(fn) { retry = fn; return `retry-${sent.length}`; },
    clearRetry() { retry = null; },
    now: () => 1_000,
  });

  store.replay(7);
  const issued = store.issue({
    streamId: 'stream-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    terminalType: 'complete',
    reason: 'renderer_terminal_ack_timeout',
    transcript: 'must never leave Electron',
  });

  assert.equal(issued.recovery_id, 'stream-1');
  assert.deepEqual(sent, [{
    recovery_id: 'stream-1',
    renderer_epoch: 7,
    stream_id: 'stream-1',
    session_id: 'session-1',
    turn_id: 'turn-1',
    terminal_type: 'complete',
    reason: 'renderer_terminal_ack_timeout',
    created_at_ms: 1_000,
  }]);
  assert.equal(JSON.stringify(sent).includes('must never leave Electron'), false);
  assert.equal(store.size(), 1);
  assert.equal(typeof retry, 'function');

  const stale = store.acknowledge({
    record_type: 'recovery_applied',
    recovery_id: 'stream-1',
    renderer_epoch: 6,
    stream_id: 'stream-1',
    session_id: 'session-1',
    outcome: 'applied',
  });
  assert.equal(stale.ok, false);
  assert.equal(store.size(), 1);

  retry();
  assert.equal(sent.length, 2);

  const applied = store.acknowledge({
    record_type: 'recovery_applied',
    recovery_id: 'stream-1',
    renderer_epoch: 7,
    stream_id: 'stream-1',
    session_id: 'session-1',
    outcome: 'applied',
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.recovery_applied, true);
  assert.equal(store.size(), 0);

  const duplicate = store.acknowledge({
    record_type: 'recovery_applied',
    recovery_id: 'stream-1',
    renderer_epoch: 7,
    stream_id: 'stream-1',
    session_id: 'session-1',
    outcome: 'applied',
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.already_applied, true);

  store.issue({ streamId: 'stream-1', sessionId: 'session-1', turnId: 'turn-1' });
  assert.equal(store.size(), 1);
  const staleReissuedDuplicate = store.acknowledge({
    record_type: 'recovery_applied', recovery_id: 'stream-1', renderer_epoch: 6,
    stream_id: 'stream-1', session_id: 'session-1', outcome: 'applied',
  });
  assert.equal(staleReissuedDuplicate.ok, false);
  assert.equal(store.size(), 1);
  const reissuedDuplicate = store.acknowledge({
    record_type: 'recovery_applied',
    recovery_id: 'stream-1',
    renderer_epoch: 7,
    stream_id: 'stream-1',
    session_id: 'session-1',
    outcome: 'applied',
  });
  assert.equal(reissuedDuplicate.ok, true);
  assert.equal(reissuedDuplicate.already_applied, true);
  assert.equal(store.size(), 0);
});

test('recovery tickets replay on a newer subscription and evict the oldest entry at the cap', () => {
  const sent = [];
  const logs = [];
  const store = createStreamEnvelopeRecoveryTicketStore({
    maxTickets: 2,
    maxDeliveryAttempts: 1,
    sendRecoveryRequired(payload) { sent.push(structuredClone(payload)); },
    log(level, event, details) { logs.push({ level, event, details }); },
    now: () => 2_000,
  });

  store.replay(2);
  store.issue({ streamId: 'oldest', sessionId: 'session-a', reason: 'timeout' });
  store.issue({ streamId: 'middle', sessionId: 'session-b', reason: 'timeout' });
  store.issue({ streamId: 'newest', sessionId: 'session-c', reason: 'timeout' });

  assert.equal(store.size(), 2);
  assert.equal(logs.some((entry) => (
    entry.event === 'chat.stream_envelope_recovery_ticket_evicted'
    && entry.details.recoveryId === 'oldest'
  )), true);

  sent.length = 0;
  store.replay(3);
  assert.deepEqual(sent.map((entry) => entry.recovery_id), ['middle', 'newest']);
  assert.equal(sent.every((entry) => entry.renderer_epoch === 3), true);
});

test('delivery failures retain tickets for later subscription replay', () => {
  const sent = [];
  const logs = [];
  let shouldFail = true;
  const store = createStreamEnvelopeRecoveryTicketStore({
    maxDeliveryAttempts: 1,
    sendRecoveryRequired(payload) {
      if (shouldFail) throw new Error('renderer unavailable');
      sent.push(structuredClone(payload));
    },
    log(level, event, details) { logs.push({ level, event, details }); },
    now: () => 3_000,
  });

  store.replay(4);
  store.issue({ streamId: 'stream-failed', sessionId: 'session-failed' });
  assert.equal(store.size(), 1);
  assert.equal(logs.some((entry) => (
    entry.event === 'chat.stream_envelope_recovery_ticket_delivery_failed'
  )), true);

  shouldFail = false;
  store.replay(5);
  assert.deepEqual(sent.map((entry) => [entry.recovery_id, entry.renderer_epoch]), [
    ['stream-failed', 5],
  ]);
});
