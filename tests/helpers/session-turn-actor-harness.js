'use strict';

const { SessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');

const NOW_MS = Date.parse('2026-07-13T18:00:00.000Z');

function createIdFactory() {
  let sequence = 0;
  return () => `id${++sequence}`;
}

function baseSession(patch = {}) {
  return {
    id: patch.id || 'session',
    messages: [],
    pending_question_batch: null,
    active_turn: null,
    ...patch,
  };
}

class FakeStore {
  constructor(sessions = {}, {
    flushResults = [],
    preferenceResults = [],
    clearResults = [],
  } = {}) {
    this.sessions = new Map(
      Object.entries(sessions).map(([id, session]) => [id, baseSession({ ...session, id })])
    );
    this.flushResults = [...flushResults];
    this.preferenceResults = [...preferenceResults];
    this.clearResults = [...clearResults];
    this.sequence = [];
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getSessionMessages(sessionId) {
    return this.getSession(sessionId)?.messages || [];
  }

  getActiveTurn(sessionId) {
    return this.getSession(sessionId)?.active_turn || null;
  }

  setActiveTurn(sessionId, activeTurn, { expectedPriorStreamId } = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const current = session.active_turn;
    if (
      expectedPriorStreamId
      && current
      && current.stream_id !== expectedPriorStreamId
    ) return null;
    session.active_turn = { ...activeTurn };
    this.sequence.push(`claim:${activeTurn.stream_id}`);
    return session;
  }

  setTurnIdentity(sessionId, identity) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    Object.assign(session, identity);
    this.sequence.push(`identity:${identity.turn_generation}`);
    return session;
  }

  clearActiveTurn(sessionId, match = {}) {
    const session = this.getSession(sessionId);
    const current = session?.active_turn;
    if (!current) return null;
    if (match.request_id && match.request_id !== current.request_id) return null;
    if (match.stream_id && match.stream_id !== current.stream_id) return null;
    if (this.clearResults.length && this.clearResults.shift() === false) {
      this.sequence.push(`clear_refused:${current.stream_id}`);
      return null;
    }
    this.sequence.push(`clear:${current.stream_id}`);
    session.active_turn = null;
    return session;
  }

  appendMessage(sessionId, message) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.messages.push({ ...message });
    this.sequence.push(`append:${message.id}`);
    return session;
  }

  updateMessage(sessionId, messageId, patch) {
    const session = this.getSession(sessionId);
    const index = session?.messages.findIndex((message) => message.id === messageId) ?? -1;
    if (index < 0) return null;
    session.messages[index] = { ...session.messages[index], ...patch, id: messageId };
    this.sequence.push(`update:${messageId}`);
    return session;
  }

  setSessionPreferences(sessionId, preferences) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if (this.preferenceResults.length && this.preferenceResults.shift() === false) {
      this.sequence.push('token:refused');
      return null;
    }
    Object.assign(session, preferences);
    this.sequence.push(
      `token:${preferences.pending_question_batch?.continuation_token?.consumed}`
    );
    return session;
  }

  flushSession(sessionId) {
    this.sequence.push(`flush:${sessionId}`);
    return this.flushResults.length ? this.flushResults.shift() : true;
  }
}

function createRegistry(options = {}) {
  return new SessionTurnActorRegistry({
    now: () => NOW_MS,
    createId: createIdFactory(),
    ...options,
  });
}

function reserve(registry, store, sessionId, patch = {}) {
  return registry.reserveStart({
    sessionId,
    store,
    activeStreams: patch.activeStreams || new Map(),
    prompt: 'hello',
    ...patch,
  });
}

function questionBatch(batchId = 'batch_1') {
  return {
    batch_id: batchId,
    round_index: 1,
    intro_text: '',
    questions: [{
      id: 'question_1',
      prompt: 'Which option?',
      options: [{ id: 'option_1', label: 'One' }],
    }],
  };
}

module.exports = {
  FakeStore,
  NOW_MS,
  createRegistry,
  questionBatch,
  reserve,
};
