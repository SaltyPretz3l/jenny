'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const {
  createChatStartCancellation,
} = require('../services/backend/chat-start-cancellation');
const {
  startLocalEngineChatStream,
} = require('../services/backend/local-engine-requests');
const {
  SessionTurnActorRegistry,
} = require('../services/backend/session-turn-actor');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function actorStore() {
  const session = {
    id: 'session_1',
    session_type: 'chat',
    context_preferences: {},
    session_incarnation: 'incarnation_1',
    turn_generation: 0,
    active_turn: null,
  };
  return {
    getSession: () => session,
    getSessionMessages: () => [],
    getActiveTurn: () => session.active_turn,
    setTurnIdentity(_id, identity) { Object.assign(session, identity); return session; },
    setActiveTurn(_id, turn) { session.active_turn = turn; return session; },
    clearActiveTurn() { session.active_turn = null; return session; },
    flushSession: () => true,
  };
}

function params() {
  return {
    sessionId: 'session_1',
    prompt: 'hello',
    visiblePrompt: 'hello',
    traceId: 'remote:request_1',
    preferredModel: '',
    reasoningEffort: 'default',
    planMode: false,
    contextPreferences: {},
    attachments: [],
  };
}

function service(overrides = {}) {
  return {
    sessionStore: actorStore(),
    activeStreams: new Map(),
    _startManagedSidecarChatStream: (input) => ({
      sessionId: input.sessionId,
      streamId: input.turnLease.identity.streamId,
    }),
    ...overrides,
  };
}

test('cancel before start rejects before reserving a turn', async () => {
  const backend = service();
  const registry = new SessionTurnActorRegistry();
  let reservations = 0;
  const reserve = registry.reserveStart.bind(registry);
  registry.reserveStart = (input) => { reservations += 1; return reserve(input); };
  backend.sessionTurnActorRegistry = registry;
  const cancellation = createChatStartCancellation();
  cancellation.cancel('remote_disabled');

  await assert.rejects(
    startLocalEngineChatStream(backend, params(), { cancellation }),
    (error) => error?.code === 'chat_start_cancelled'
  );
  assert.equal(reservations, 0);
});

test('cancel during offline preflight releases the reserved lease', async () => {
  const gate = deferred();
  const backend = service({
    offlineIntelligenceService: { getState: () => gate.promise },
  });
  const registry = new SessionTurnActorRegistry();
  let releases = 0;
  let managedStarts = 0;
  const release = registry.release.bind(registry);
  registry.release = (lease, options) => {
    releases += 1;
    assert.deepEqual(options, { status: 'preflight_failed' });
    return release(lease, options);
  };
  backend.sessionTurnActorRegistry = registry;
  backend._startManagedSidecarChatStream = () => { managedStarts += 1; };
  const cancellation = createChatStartCancellation();

  const starting = startLocalEngineChatStream(backend, params(), { cancellation });
  cancellation.cancel('remote_disabled');
  gate.resolve({ mode: 'online' });

  await assert.rejects(starting, (error) => error?.code === 'chat_start_cancelled');
  assert.equal(releases, 1);
  assert.equal(managedStarts, 0);
  assert.equal(backend.sessionStore.getActiveTurn('session_1'), null);
});

test('cancel after binding targets the allocated stream exactly once', async () => {
  const cancellations = [];
  const backend = service();
  backend.cancelChatStream = (streamId, reason) => cancellations.push({ streamId, reason });
  const cancellation = createChatStartCancellation({
    onCancelStream: (streamId, reason) => backend.cancelChatStream(streamId, reason),
  });

  const started = await startLocalEngineChatStream(backend, params(), { cancellation });
  assert.equal(cancellation.boundStreamId, started.streamId);
  assert.equal(cancellation.cancel('remote_cancelled'), true);
  assert.equal(cancellation.cancel('ignored'), false);
  assert.deepEqual(cancellations, [{ streamId: started.streamId, reason: 'remote_cancelled' }]);
});

test('start cancellation never binds an undefined stream identity', async () => {
  let bindings = 0;
  const backend = service({
    _startManagedSidecarChatStream: () => ({ sessionId: '', streamId: '' }),
  });
  const cancellation = {
    signal: new AbortController().signal,
    bindStream() { bindings += 1; },
  };
  await startLocalEngineChatStream(backend, { ...params(), sessionId: '' }, { cancellation });
  assert.equal(bindings, 0);
});

test('BackendService.startChatStream still accepts a payload without options', async () => {
  const backend = service();
  const started = await BackendService.prototype.startChatStream.call(backend, params());
  assert.equal(started.sessionId, 'session_1');
  assert.match(started.streamId, /^stream_/);
});
