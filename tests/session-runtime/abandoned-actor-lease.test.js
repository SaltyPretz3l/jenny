'use strict';
// Backend-restart drop of an abandoned session-turn actor lease (B3D-1): only
// the exact abandoned lease is dropped, from memory only, and the session then
// accepts a new send the way it does in a new process.
const assert = require('node:assert/strict');
const test = require('node:test');
const { abandonLeaseAfterBackendRestart } = require('../../services/backend/session-turn-actor-terminal');
const { reopenBackendRuntimeAfterStart } = require('../../services/backend/backend-runtime-lifecycle');
const { FakeStore, createRegistry, reserve } = require('../helpers/session-turn-actor-harness');

function abandoned() {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const activeStreams = new Map();
  const lease = reserve(registry, store, 's1', { activeStreams });
  const { streamId, turnId } = lease.identity;
  return { store, registry, activeStreams, lease, identity: { sessionId: 's1', streamId, turnId } };
}

test('an exact abandoned lease is dropped from memory and the session accepts a new send', async () => {
  const { store, registry, lease, identity } = abandoned();
  const bracket = store.getActiveTurn('s1');
  const sequence = store.sequence.length;

  assert.deepEqual(abandonLeaseAfterBackendRestart(registry, identity), { dropped: true });
  assert.equal(lease.released, true);
  await lease.settledPromise;
  assert.equal(registry.hasActiveLifecycle('s1'), false);
  // No durable write, no generation bump: the durable bracket is left for the orphan recovery.
  assert.equal(store.sequence.length, sequence);
  assert.deepEqual(store.getActiveTurn('s1'), bracket);
  assert.equal(store.getSession('s1').turn_generation, 1);

  const next = reserve(registry, store, 's1');
  assert.equal(next.identity.generation, 2);
});

test('the drop refuses, changing nothing, unless the lease is exactly the abandoned one', () => {
  const cases = [
    ['stream mismatch', h => ({ ...h.identity, streamId: 'stream_other' }), 'lease_identity_mismatch'],
    ['turn mismatch', h => ({ ...h.identity, turnId: 'turn_other' }), 'lease_identity_mismatch'],
    ['controller attached', h => { h.registry.attachController(h.lease, new AbortController()); return h.identity; },
      'lease_stream_active'],
    ['stream still registered', h => { h.activeStreams.set(h.identity.streamId, {}); return h.identity; },
      'lease_stream_active'],
    ['missing actor', h => ({ ...h.identity, sessionId: 's_unknown' }), 'actor_missing'],
  ];
  for (const [label, prepare, reason] of cases) {
    const h = abandoned();
    const actors = h.registry.size;
    assert.deepEqual(abandonLeaseAfterBackendRestart(h.registry, prepare(h)), { dropped: false, reason }, label);
    assert.equal(h.lease.released, false, label);
    assert.equal(h.registry.hasActiveLifecycle('s1'), true, label);
    assert.equal(h.registry.size, actors, label);
  }
});

test('a released lease is not dropped again', () => {
  const { registry, lease, identity } = abandoned();
  lease.released = true;
  assert.deepEqual(abandonLeaseAfterBackendRestart(registry, identity), { dropped: false, reason: 'lease_missing' });
});

// The stuck-session case: work whose settlement was unconfirmed is reclaimed
// as failed by an in-process restart; its turn lease kept the session busy
// (lease_active) for every later send until the app restarted.
test('backend-restart reclaim drops the turn lease of reclaimed work so the session accepts a new send', () => {
  const { store, registry, identity } = abandoned();
  const logs = [];
  const work = { work_id: 'work_1', session_id: 's1', turn_id: identity.turnId, status: 'failed',
    attempt: { stream_id: identity.streamId } };
  const service = {
    sessionTurnActors: registry,
    _emitServiceLog: (...entry) => logs.push(entry),
    sessionRuntime: {
      store: { get: id => (id === work.work_id ? work : null) },
      reclaimAbandonedAfterBackendRestart: () => ({
        reclaimed: [{ work_id: 'work_1', session_id: 's1', status: 'failed' }], retained: [] }),
      reopenAfterShutdown: () => ({ ok: true }),
    },
  };

  reopenBackendRuntimeAfterStart(service);

  assert.equal(reserve(registry, store, 's1').identity.generation, 2);
  const [reclaim] = logs.filter(([, event]) => event === 'session_runtime.abandoned_work_reclaimed');
  assert.deepEqual([reclaim[2].reclaimed, reclaim[2].recovering, reclaim[2].actorLeasesDropped],
    [['work_1'], [], ['work_1']]);
});
