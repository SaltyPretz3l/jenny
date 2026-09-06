'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TerminalCoordinator,
} = require('../services/backend/chat-stream-terminal-coordinator');
const {
  SessionTurnActorRegistry,
} = require('../services/backend/session-turn-actor');
const {
  streamEnvelopeToLegacyPayload,
} = require('../renderer/chat/renderer-stream-envelope-v2');

class FakeTerminalStore {
  constructor() {
    this.session = {
      id: 's1',
      session_incarnation: '',
      turn_generation: 0,
      active_turn: null,
      messages: [],
      turn_events: [],
      pending_question_batch: null,
    };
  }

  getSession(sessionId) {
    return sessionId === this.session.id ? this.session : null;
  }

  getSessionMessages(sessionId) {
    return this.getSession(sessionId)?.messages || [];
  }

  getActiveTurn(sessionId) {
    return this.getSession(sessionId)?.active_turn || null;
  }

  setTurnIdentity(sessionId, identity) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    Object.assign(session, identity);
    return session;
  }

  setActiveTurn(sessionId, activeTurn) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.active_turn = { ...activeTurn };
    return session;
  }

  clearActiveTurn(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.active_turn = null;
    return session;
  }

  setSessionPreferences(sessionId, patch) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    Object.assign(session, patch);
    return session;
  }

  flushSession() {
    return true;
  }

  async commitTerminal(_sessionId, request) {
    this.session.messages.push(...request.messages.map((message) => ({ ...message })));
    this.session.turn_events.push(...request.turnEvents);
    this.session.active_turn = null;
    return {
      ok: true,
      applied: true,
      durable: true,
      reason: null,
      commitEpoch: 1,
      dirtyEpoch: 1,
      durableEpoch: 1,
      value: { persistedMessageIds: request.messages.map((message) => message.id) },
    };
  }
}

function createSettlement(t) {
  const store = new FakeTerminalStore();
  let sequence = 0;
  const registry = new SessionTurnActorRegistry({
    createId: () => `id${++sequence}`,
    now: () => Date.parse('2026-08-26T12:00:00.000Z'),
  });
  const emitted = [];
  const coordinator = new TerminalCoordinator({
    actorRegistry: registry,
    store,
    emitTerminal(payload) {
      emitted.push(payload);
    },
  });
  const lease = registry.reserveStart({
    sessionId: 's1',
    store,
    activeStreams: new Map(),
    prompt: 'hello',
  });
  t.after(() => {
    if (registry.size > 0) registry.release(lease, { status: 'cancelled' });
  });
  const message = {
    id: `assistant_${lease.identity.streamId}`,
    role: 'assistant',
    content: 'answer',
    status: 'complete',
    terminal_status: 'complete',
    parent_stream_id: lease.identity.streamId,
    timestamp: '2026-08-26T12:00:01.000Z',
  };
  return { coordinator, emitted, lease, message };
}

test('settled terminal emits its canonical turn events', async (t) => {
  const { coordinator, emitted, lease, message } = createSettlement(t);
  const turnEvents = [{
    event_id: 'event_1',
    turn_id: lease.identity.turnId,
    kind: 'assistant_text',
    status: 'complete',
    primary_message_id: message.id,
    source_message_ids: [message.id],
    payload: { text: 'answer' },
  }];

  await coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [message],
    turnEvents,
  });

  assert.deepEqual(emitted[0].canonicalTurnEvents, turnEvents);
});

test('settled terminal omits canonical turn events when none exist', async (t) => {
  const { coordinator, emitted, lease, message } = createSettlement(t);

  await coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [message],
    turnEvents: [],
  });

  assert.equal('canonicalTurnEvents' in emitted[0], false);
});

test('terminal canonical turn events survive the renderer transport spread', () => {
  const canonicalTurnEvents = [{ event_id: 'event_1', kind: 'assistant_text' }];
  const legacy = streamEnvelopeToLegacyPayload({
    schemaVersion: 2,
    streamId: 'stream-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    channel: 'control',
    eventKind: 'terminal',
    payload: { type: 'complete', canonicalTurnEvents },
  });

  assert.deepEqual(legacy.canonicalTurnEvents, canonicalTurnEvents);
});
