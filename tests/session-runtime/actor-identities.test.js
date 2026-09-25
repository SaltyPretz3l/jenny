'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { SessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-actor-identities-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  t.after(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let sequence = 0;
  const registry = new SessionTurnActorRegistry({
    now: () => Date.parse('2026-09-09T12:00:00.000Z'),
    createId: () => `identity_${++sequence}`,
  });
  const sessionId = store.createSession({ title: 'Actor identity test' }).id;
  const activeStreams = new Map();
  const reserve = (logicalTurnId) => registry.reserveStart({
    sessionId,
    store,
    activeStreams,
    prompt: 'hello',
    ...(logicalTurnId === undefined ? {} : { logicalTurnId }),
  });
  return { activeStreams, registry, reserve, sessionId, store };
}

test('actor keeps the legacy turn-equals-stream identity when no logical turn is supplied', (t) => {
  const { registry, reserve, sessionId, store } = harness(t);
  const lease = reserve();

  assert.equal(lease.identity.turnId, lease.identity.streamId);
  assert.deepEqual(store.getActiveTurn(sessionId), lease.activeTurnClaim);
  assert.equal(lease.activeTurnClaim.request_id, lease.identity.streamId);
  assert.equal(lease.activeTurnClaim.turn_id, lease.identity.streamId);
  assert.equal(lease.activeTurnClaim.stream_id, lease.identity.streamId);
  registry.release(lease, { status: 'completed' });
});

test('actor reuses one trusted logical turn across fresh attempt streams', (t) => {
  const { activeStreams, registry, reserve, sessionId, store } = harness(t);
  const logicalTurnId = 'runtime.turn.123';
  const first = reserve(logicalTurnId);
  registry.attachController(first, new AbortController());

  assert.equal(first.identity.turnId, logicalTurnId);
  assert.notEqual(first.identity.streamId, logicalTurnId);
  assert.equal(first.activeTurnClaim.request_id, logicalTurnId);
  assert.equal(first.activeTurnClaim.turn_id, logicalTurnId);
  assert.equal(first.activeTurnClaim.stream_id, first.identity.streamId);
  assert.equal(first.identity.userMessageId, `user_${first.identity.streamId}`);
  assert.equal(registry.release(first, { status: 'completed' }).released, true);

  const second = reserve(logicalTurnId);
  const secondController = new AbortController();
  registry.attachController(second, secondController);

  assert.equal(second.identity.turnId, logicalTurnId);
  assert.notEqual(second.identity.streamId, first.identity.streamId);
  assert.equal(second.identity.generation, first.identity.generation + 1);
  assert.equal(second.identity.sessionIncarnation, first.identity.sessionIncarnation);
  assert.equal(second.activeTurnClaim.request_id, logicalTurnId);
  assert.equal(second.activeTurnClaim.turn_id, logicalTurnId);
  assert.equal(second.activeTurnClaim.stream_id, second.identity.streamId);

  assert.deepEqual(registry.release(first, { status: 'completed' }), {
    released: false,
    restoredContinuation: false,
    reason: 'stale_lease',
  });
  assert.equal(activeStreams.get(second.identity.streamId), secondController);
  assert.deepEqual(store.getActiveTurn(sessionId), second.activeTurnClaim);
  registry.release(second, { status: 'completed' });
});

test('actor validates an explicitly supplied logical turn with the lifecycle grammar', (t) => {
  const { reserve, sessionId, store } = harness(t);

  for (const logicalTurnId of [null, '', 'invalid turn', 'x'.repeat(129)]) {
    assert.throws(
      () => reserve(logicalTurnId),
      (error) => error.code === 'invalid_logical_turn_id'
        && error.reason.startsWith('identifier_')
    );
  }
  assert.equal(store.getActiveTurn(sessionId), null);
});
