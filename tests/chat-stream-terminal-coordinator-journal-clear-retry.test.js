'use strict';

// Split out of tests/chat-stream-terminal-coordinator.test.js to keep that
// file under the repo's 1015-raw-line file-size ceiling
// (scripts/checks/check_file_size.py).
//
// Covers the fix to TerminalCoordinator#_clearJournal
// (services/backend/chat-stream-terminal-coordinator.js): a transient
// journal.clear() failure on an otherwise-successful terminal settle must not
// silently leave the turn's journal partition uncleared. A surviving
// non-empty partition after a successful turn is exactly the hard-
// interruption signature interrupted-turn-receipts.js keys on
// (services/backend/interrupted-turn-receipts.js), so an unretried clear
// failure would frame a successful turn as interrupted on the next
// chat.send. _clearJournal now mirrors _clearRepair's bounded-retry pattern
// exactly: MAX_REPAIR_CLEANUP_ATTEMPTS attempts, WARN per refusal/failure,
// and a final ERROR once attempts are exhausted.

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

test('journal clear failing once then succeeding still clears the partition', async () => {
  const store = new FakeTerminalStore([durableOutcome(1)]);
  const registry = createRegistry();
  const lease = reserve(registry, store);
  const logs = [];
  const clearCalls = [];
  let attempts = 0;
  const coordinator = new TerminalCoordinator({
    actorRegistry: registry,
    store,
    journal: {
      clear(sessionId, turnId, options) {
        attempts += 1;
        clearCalls.push({ sessionId, turnId, options });
        if (attempts === 1) {
          return { ok: false, cleared: false, durable: false, reason: 'journal_write_failed' };
        }
        return { ok: true, cleared: true, durable: true, reason: null };
      },
    },
    logger: (...entry) => logs.push(entry),
  });

  const result = await coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
  });

  assert.equal(result.durableTerminal, true);
  assert.equal(attempts, 2, 'a transient clear failure must be retried, not accepted as final');
  assert.equal(clearCalls.length, 2);
  assert.deepEqual(logs.map((entry) => entry.slice(0, 2)), [
    ['WARN', 'lifecycle.terminal_journal_clear_refused'],
  ]);
});

test('journal clear exhausting all retries logs WARN per attempt then a final ERROR', async () => {
  const store = new FakeTerminalStore([durableOutcome(1)]);
  const registry = createRegistry();
  const lease = reserve(registry, store);
  const logs = [];
  let attempts = 0;
  const coordinator = new TerminalCoordinator({
    actorRegistry: registry,
    store,
    journal: {
      clear() {
        attempts += 1;
        return { ok: false, cleared: false, durable: false, reason: 'journal_write_failed' };
      },
    },
    logger: (...entry) => logs.push(entry),
  });

  const result = await coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
  });

  assert.equal(
    result.durableTerminal,
    true,
    'a persistently failing journal clear must not reopen an otherwise-durable terminal'
  );
  assert.equal(attempts, 3, 'must attempt the same bounded retry count as _clearRepair');
  assert.deepEqual(logs.map((entry) => entry.slice(0, 2)), [
    ['WARN', 'lifecycle.terminal_journal_clear_refused'],
    ['WARN', 'lifecycle.terminal_journal_clear_refused'],
    ['WARN', 'lifecycle.terminal_journal_clear_refused'],
    ['ERROR', 'lifecycle.terminal_journal_clear_retry_exhausted'],
  ]);
});
