'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionTurnActorRegistry } = require('../services/backend/session-turn-actor');

class ActorStore {
  constructor() {
    this.session = {
      id: 's1',
      session_incarnation: '',
      turn_generation: 0,
      active_turn: null,
      messages: [],
      pending_question_batch: null,
    };
  }

  getSession(sessionId) {
    return sessionId === 's1' ? this.session : null;
  }

  getSessionMessages() {
    return this.session.messages;
  }

  getActiveTurn() {
    return this.session.active_turn;
  }

  setTurnIdentity(_sessionId, identity) {
    Object.assign(this.session, identity);
    return this.session;
  }

  setActiveTurn(_sessionId, activeTurn, { expectedPriorStreamId } = {}) {
    if (
      expectedPriorStreamId
      && this.session.active_turn
      && this.session.active_turn.stream_id !== expectedPriorStreamId
    ) return null;
    this.session.active_turn = { ...activeTurn };
    return this.session;
  }

  clearActiveTurn(_sessionId, match = {}) {
    if (!this.session.active_turn) return null;
    if (match.request_id && match.request_id !== this.session.active_turn.request_id) return null;
    if (match.stream_id && match.stream_id !== this.session.active_turn.stream_id) return null;
    this.session.active_turn = null;
    return this.session;
  }

  setSessionPreferences(_sessionId, patch) {
    Object.assign(this.session, patch);
    return this.session;
  }

  flushSession() {
    return true;
  }
}

function createRegistry(terminalRepairStore = null) {
  let sequence = 0;
  return new SessionTurnActorRegistry({
    createId: () => `id${++sequence}`,
    now: () => Date.parse('2026-07-14T12:00:00.000Z'),
    terminalRepairStore,
  });
}

function reserve(registry, store, activeStreams = new Map()) {
  return registry.reserveStart({
    sessionId: 's1',
    store,
    activeStreams,
    prompt: 'hello',
  });
}

test('provider quiescence is independent from durable terminal ownership', async () => {
  const store = new ActorStore();
  const registry = createRegistry();
  const activeStreams = new Map();
  const lease = reserve(registry, store, activeStreams);
  registry.attachController(lease, {});
  let ownershipSettled = false;
  lease.settledPromise.then(() => { ownershipSettled = true; });

  assert.deepEqual(registry.markProviderQuiesced(lease), {
    ok: true,
    quiesced: true,
    alreadyQuiesced: false,
  });
  await lease.providerQuiescedPromise;
  await Promise.resolve();
  assert.equal(ownershipSettled, false);
  assert.equal(activeStreams.has(lease.identity.streamId), false);
  assert.equal(store.getActiveTurn().stream_id, lease.identity.streamId);

  const refused = registry.finalizeTerminal(lease, {
    ok: false,
    durableTerminal: false,
    reason: 'write_failed',
  }, { status: 'complete' });
  assert.equal(refused.released, false);
  assert.equal(refused.preserved, true);
  assert.throws(() => reserve(registry, store), (error) => (
    error.code === 'session_busy' && error.reason === 'lease_active'
  ));

  store.session.active_turn = null;
  assert.equal(registry.finalizeTerminal(lease, {
    ok: true,
    durableTerminal: true,
  }, { status: 'complete' }).released, true);
  await lease.settledPromise;
  assert.equal(ownershipSettled, true);
});

test('pending terminal repair fences restart admission and adopts the same generation', () => {
  const store = new ActorStore();
  const original = reserve(createRegistry(), store);
  const artifact = {
    artifact_id: 'repair_1',
    session_id: 's1',
    session_incarnation: original.identity.sessionIncarnation,
    turn_generation: original.identity.generation,
    turn_id: original.identity.turnId,
    stream_id: original.identity.streamId,
    state: 'pending',
  };
  const repairStore = {
    hasNewerSchema: () => false,
    findByIdentity: () => ({ ...artifact }),
  };
  const restarted = createRegistry(repairStore);

  assert.throws(() => reserve(restarted, store), (error) => (
    error.code === 'session_busy' && error.reason === 'terminal_repair_pending'
  ));
  assert.equal(store.getActiveTurn().stream_id, original.identity.streamId);
  const adopted = restarted.adoptPendingTerminalRepair({
    identity: original.identity,
    store,
    artifactId: artifact.artifact_id,
  });
  assert.equal(adopted.providerQuiesced, true);
  assert.equal(adopted.terminalRepairArtifactId, artifact.artifact_id);
  assert.equal(restarted.adoptPendingTerminalRepair({
    identity: original.identity,
    store,
    artifactId: artifact.artifact_id,
  }), adopted);
  assert.throws(() => reserve(restarted, store), (error) => (
    error.code === 'session_busy' && error.reason === 'lease_active'
  ));
  assert.throws(() => restarted.adoptPendingTerminalRepair({
    identity: { ...original.identity, generation: original.identity.generation + 1 },
    store,
    artifactId: artifact.artifact_id,
  }), (error) => error.reason === 'lease_active' || error.reason === 'stale_repair_identity');

  store.session.active_turn = null;
  assert.equal(restarted.finalizeTerminal(adopted, {
    ok: true,
    durableTerminal: true,
  }, { status: 'complete' }).released, true);
  repairStore.findByIdentity = () => null;
  assert.equal(reserve(restarted, store).identity.generation, original.identity.generation + 1);
});

test('discarded repair tombstone blocks orphan reclaim and requires explicit adoption', () => {
  const store = new ActorStore();
  const original = reserve(createRegistry(), store);
  const artifact = {
    artifact_id: 'repair_discarded',
    session_id: 's1',
    session_incarnation: original.identity.sessionIncarnation,
    turn_generation: original.identity.generation,
    turn_id: original.identity.turnId,
    stream_id: original.identity.streamId,
    state: 'discarded',
  };
  const repairStore = {
    hasNewerSchema: () => false,
    findByIdentity: () => ({ ...artifact }),
  };
  const restarted = createRegistry(repairStore);

  assert.throws(() => reserve(restarted, store), (error) => (
    error.code === 'session_busy' && error.reason === 'terminal_repair_discard_pending'
  ));
  assert.throws(() => restarted.adoptPendingTerminalRepair({
    identity: original.identity,
    store,
    artifactId: artifact.artifact_id,
  }), (error) => error.reason === 'repair_artifact_discarded');

  const adopted = restarted.adoptPendingTerminalRepair({
    identity: original.identity,
    store,
    artifactId: artifact.artifact_id,
    allowDiscarded: true,
  });
  assert.equal(adopted.terminalRepairState, 'discarded');
  store.session.active_turn = null;
  assert.equal(restarted.finalizeTerminal(adopted, {
    ok: true,
    durableTerminal: true,
  }, { status: 'cancelled' }).released, true);
  assert.equal(reserve(restarted, store).identity.generation, original.identity.generation + 1);
});

test('future repair schema blocks orphan reclaim without clearing active turn', () => {
  const store = new ActorStore();
  const original = reserve(createRegistry(), store);
  const restarted = createRegistry({
    hasNewerSchema: () => true,
    findByIdentity: () => null,
  });

  assert.throws(() => reserve(restarted, store), (error) => (
    error.code === 'session_busy' && error.reason === 'terminal_repair_newer_schema'
  ));
  assert.equal(store.getActiveTurn().stream_id, original.identity.streamId);
  assert.throws(() => restarted.adoptPendingTerminalRepair({
    identity: original.identity,
    store,
  }), (error) => error.reason === 'terminal_repair_newer_schema');
});
