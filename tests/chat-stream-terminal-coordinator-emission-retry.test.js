'use strict';

// Split out of tests/chat-stream-terminal-coordinator.test.js to keep that
// file under the repo's 1015-raw-line file-size ceiling
// (scripts/checks/check_file_size.py).
//
// Covers the fix to TerminalCoordinator#_emitTerminalOnce
// (services/backend/chat-stream-terminal-coordinator.js): the
// `terminalEmissionAttempted` latch must mean "an attempt is in flight or
// has already succeeded", not "one attempt ever happened". A first emit
// attempt that returns false (renderer momentarily unsubscribed / IPC not
// ready) must not permanently suppress the user-visible terminal -- a later
// retry pass must be able to re-attempt and succeed.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TerminalCoordinator,
} = require('../services/backend/chat-stream-terminal-coordinator');
const {
  SessionTurnActorRegistry,
} = require('../services/backend/session-turn-actor');

class FakeTerminalStore {
  constructor(outcomes = []) {
    this.session = {
      id: 's1',
      session_incarnation: '',
      turn_generation: 0,
      active_turn: null,
      messages: [],
      turn_events: [],
      pending_question_batch: null,
    };
    this.outcomes = [...outcomes];
    this.commitCalls = [];
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

  setActiveTurn(sessionId, activeTurn, { expectedPriorStreamId } = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if (
      expectedPriorStreamId
      && session.active_turn
      && session.active_turn.stream_id !== expectedPriorStreamId
    ) return null;
    session.active_turn = { ...activeTurn };
    return session;
  }

  clearActiveTurn(sessionId, match = {}) {
    const session = this.getSession(sessionId);
    if (!session?.active_turn) return null;
    if (match.request_id && match.request_id !== session.active_turn.request_id) return null;
    if (match.stream_id && match.stream_id !== session.active_turn.stream_id) return null;
    session.active_turn = null;
    return session;
  }

  setSessionPreferences(sessionId, patch) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    Object.assign(session, patch);
    return session;
  }

  appendMessage(sessionId, message) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.messages.push({ ...message });
    return session;
  }

  flushSession() {
    return true;
  }

  async commitTerminal(sessionId, request, options) {
    this.commitCalls.push({ sessionId, request, options });
    const outcome = this.outcomes.shift() || durableOutcome(this.commitCalls.length);
    if (outcome.apply !== false) this._applyTerminal(request);
    return {
      ...outcome,
      value: {
        ...(outcome.value || {}),
        persistedMessageIds: request.messages.map((message) => message.id),
      },
    };
  }

  _applyTerminal(request) {
    for (const message of request.messages) {
      const index = this.session.messages.findIndex((entry) => entry.id === message.id);
      if (index >= 0) this.session.messages[index] = { ...message };
      else this.session.messages.push({ ...message });
    }
    this.session.turn_events = [...this.session.turn_events, ...request.turnEvents];
    Object.assign(this.session, request.preferencePatch);
    if (typeof request.title === 'string') this.session.title = request.title;
    this.session.active_turn = null;
  }
}

function durableOutcome(epoch = 1) {
  return {
    ok: true,
    applied: true,
    durable: true,
    reason: null,
    commitEpoch: epoch,
    dirtyEpoch: epoch,
    durableEpoch: epoch,
  };
}

function createRegistry() {
  let sequence = 0;
  return new SessionTurnActorRegistry({
    createId: () => `id${++sequence}`,
    now: () => Date.parse('2026-07-14T12:00:00.000Z'),
  });
}

function reserve(registry, store) {
  return registry.reserveStart({
    sessionId: 's1',
    store,
    activeStreams: new Map(),
    prompt: 'hello',
  });
}

function assistantMessage(lease) {
  return {
    id: `assistant_${lease.identity.streamId}`,
    role: 'assistant',
    content: 'answer',
    status: 'complete',
    terminal_status: 'complete',
    parent_stream_id: lease.identity.streamId,
    timestamp: '2026-07-14T12:00:01.000Z',
  };
}

test('terminal listener returning false clears the latch and re-emits on retry', async () => {
  const store = new FakeTerminalStore([{
    ok: false,
    applied: false,
    apply: false,
    durable: false,
    reason: 'write_failed',
    commitEpoch: 0,
    dirtyEpoch: 0,
    durableEpoch: 0,
  }, durableOutcome(1)]);
  const registry = createRegistry();
  let emissionAttempts = 0;
  const coordinator = new TerminalCoordinator({
    actorRegistry: registry,
    store,
    emitTerminal() {
      emissionAttempts += 1;
      return emissionAttempts > 1;
    },
  });
  const lease = reserve(registry, store);

  const refused = await coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
  });
  assert.equal(refused.visibleTerminal, false);
  assert.equal(emissionAttempts, 1);
  assert.equal(lease.terminalEmissionAttempted, false, 'a false-returning attempt must clear the latch');

  const retried = await coordinator.retry(lease);
  assert.equal(retried.durableTerminal, true);
  assert.equal(retried.visibleTerminal, true, 'a later retry pass must re-attempt and succeed');
  assert.equal(emissionAttempts, 2);
  assert.equal(lease.terminalVisibleEmitted, true);

  // Success latches for good: a further retry must not re-invoke emitTerminal.
  const settledAgain = await coordinator.retry(lease);
  assert.equal(settledAgain.visibleTerminal, true);
  assert.equal(emissionAttempts, 2, 'a successful emission must not be repeated');
});
