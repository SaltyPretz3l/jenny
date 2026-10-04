'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createSessionCacheController } = require('../renderer/shell/renderer-session-cache-utils');
const { createSessionLifecycleController } = require('../renderer/shell/renderer-session-lifecycle-utils');
const { createSessionManager } = require('../renderer/shell/renderer-session-utils');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');

function makeState(overrides = {}) {
  return {
    sessions: Array.from({ length: 20 }, (_, index) => ({ id: `session-${index + 1}` })),
    currentSessionId: '',
    activeStreamId: '',
    messagesBySession: new Map(),
    turnEventsBySession: new Map(),
    interactiveDraftsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    pendingStreams: new Map(),
    pendingToolApprovals: new Map(),
    streamThinkingStatusByStream: new Map(),
    streamDeltaKindByStream: new Map(),
    toolCallsByStream: new Map(),
    sendPreflight: null,
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  const state = makeState(overrides);
  const loadCalls = [];
  const persisted = new Map(state.sessions.map(({ id }) => [id, {
    data: [{ id: `message-${id}`, role: 'assistant', content: id, streamId: `stream-${id}` }],
    turn_event_log_version: 1,
    turn_events: [{ event_id: `event-${id}`, event_seq: 1, turn_id: `turn-${id}`, kind: 'turn_started' }],
    active_turn: null,
  }]));
  const getActiveSession = () => state.sessions.find(({ id }) => id === state.currentSessionId);
  const manager = createSessionManager({
    state,
    constants: {},
    callbacks: {
      normalizeChatMessages: (messages) => messages,
      getActiveSession,
    },
  });
  const multiStream = createMultiStreamController({ getState: () => state });
  const cache = createSessionCacheController({ state, getMultiStreamController: () => multiStream });
  const lifecycle = createSessionLifecycleController({
    state,
    sessionCacheController: cache,
    getMultiStreamController: () => multiStream,
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: {
        async getMessages(sessionId) {
          loadCalls.push(sessionId);
          return structuredClone(persisted.get(sessionId));
        },
      },
    },
    callbacks: {
      getActiveSession,
      setSessionMessages: manager.setSessionMessages,
      setSessionTurnEventState: manager.setSessionTurnEventState,
    },
  });
  return { state, loadCalls, persisted, multiStream, cache, lifecycle };
}

function assertMatchingCacheKeys(state) {
  assert.equal(state.turnEventsBySession.size, state.messagesBySession.size,
    'event histories and message caches must have the same count');
  assert.deepEqual([...state.turnEventsBySession.keys()].sort(), [...state.messagesBySession.keys()].sort());
}

async function openAllSessions({ state, lifecycle }) {
  for (const { id } of state.sessions) {
    assert.equal(await lifecycle.openSession(id, { silent: true }), true);
  }
}

describe('cold session event history eviction', () => {
  test('opening 20 populated sessions bounds both histories to the six-session message cache', async () => {
    const harness = createHarness();

    await openAllSessions(harness);

    assert.equal(harness.loadCalls.length, 20);
    assert.equal(harness.state.messagesBySession.size, 6);
    assertMatchingCacheKeys(harness.state);
  });

  test('streaming, approvals, panes and preflights protect the same histories even above the cap', async () => {
    const harness = createHarness({
      activeStreamId: 'stream-session-1',
      activeStreamSessionId: 'session-1',
      pendingStreams: new Map([['stream-session-2', {}]]),
      pendingToolApprovals: new Map([['approval-3', { sessionId: 'session-3', streamId: 'stream-session-3' }]]),
      panes: { panes: [4, 5, 6].map((id) => ({ sessionId: `session-${id}` })), focusedPaneId: 0 },
      sendPreflight: { sessionId: 'session-7', streamId: 'stream-session-7', pending: true },
    });
    harness.multiStream.registerStream('session-1', 'stream-session-1');
    harness.multiStream.registerPreflight('session-8', { streamId: 'stream-session-8', pending: true });
    const protectedEvents = new Map();
    for (const { id } of harness.state.sessions) {
      await harness.lifecycle.openSession(id, { silent: true });
      if (protectedEvents.size < 8) protectedEvents.set(id, harness.state.turnEventsBySession.get(id));
    }

    assert.equal(harness.state.messagesBySession.size, 9, 'eight protected sessions plus the current session');
    assertMatchingCacheKeys(harness.state);
    for (const [id, events] of protectedEvents) {
      assert.equal(harness.state.messagesBySession.has(id), true, `${id} keeps its messages`);
      assert.equal(harness.state.turnEventsBySession.get(id), events, `${id} keeps its event state unchanged`);
    }
    assert.equal(harness.state.pendingStreams.has('stream-session-2'), true);
    assert.equal(harness.state.pendingToolApprovals.has('approval-3'), true);
    assert.equal(harness.multiStream.getStreamIdForSession('session-1'), 'stream-session-1');
  });

  test('reopening an evicted session reloads persisted events through the existing lifecycle', async () => {
    const harness = createHarness();
    await openAllSessions(harness);
    assert.equal(harness.state.messagesBySession.has('session-1'), false);
    assert.equal(harness.state.turnEventsBySession.has('session-1'), false,
      'an evicted session must drop its event history before reopening');
    const cachedEvents = harness.state.turnEventsBySession.get('session-20');
    const cachedMessages = harness.state.messagesBySession.get('session-20');
    harness.persisted.get('session-1').turn_events.push({
      event_id: 'event-session-1-complete', event_seq: 2, turn_id: 'turn-session-1', kind: 'turn_completed',
    });
    harness.persisted.get('session-1').turn_event_log_version = 2;
    const previousLoads = harness.loadCalls.length;

    await harness.lifecycle.openSession('session-1', { silent: true });

    assert.deepEqual(harness.loadCalls.slice(previousLoads), ['session-1']);
    assert.deepEqual(harness.state.turnEventsBySession.get('session-1'), {
      turnEventLogVersion: 2,
      turnEvents: harness.persisted.get('session-1').turn_events,
      activeTurn: null,
    });
    assert.deepEqual(harness.state.messagesBySession.get('session-1'), harness.persisted.get('session-1').data);
    assert.equal(harness.state.turnEventsBySession.get('session-20'), cachedEvents);
    assert.equal(harness.state.messagesBySession.get('session-20'), cachedMessages);
    assert.equal(harness.state.messagesBySession.size, 6);
    assertMatchingCacheKeys(harness.state);
  });
});
