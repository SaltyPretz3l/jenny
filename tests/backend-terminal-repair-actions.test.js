'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  discardUnsavedReply,
  retryUnsavedReply,
} = require('../services/backend/backend-terminal-repair-actions');
const {
  TerminalCoordinator,
} = require('../services/backend/chat-stream-terminal-coordinator');
const {
  SessionTurnActorRegistry,
} = require('../services/backend/session-turn-actor');

const identity = Object.freeze({
  sessionId: 'session_1',
  sessionIncarnation: 'inc_1',
  generation: 1,
  turnId: 'turn_1',
  streamId: 'stream_1',
  userMessageId: 'user_1',
  sessionRevision: null,
});

function assistantMessage() {
  return {
    id: 'assistant_1',
    role: 'assistant',
    content: 'visible unsaved reply',
    status: 'complete',
    terminal_status: 'complete',
    parent_stream_id: identity.streamId,
    timestamp: '2026-07-14T12:00:01.000Z',
  };
}

function repairArtifact(state = 'pending') {
  const message = assistantMessage();
  return {
    artifact_id: 'repair_1',
    session_id: identity.sessionId,
    session_incarnation: identity.sessionIncarnation,
    turn_generation: identity.generation,
    turn_id: identity.turnId,
    stream_id: identity.streamId,
    message,
    state,
    terminal_snapshot: {
      kind: 'complete',
      terminal: { kind: 'complete' },
      messages: [message],
      tool_repairs: [],
      turn_events: [],
      preference_patch: {},
      title: null,
    },
  };
}

class RawStore {
  constructor() {
    this.session = {
      id: identity.sessionId,
      session_incarnation: identity.sessionIncarnation,
      turn_generation: identity.generation,
      active_turn: {
        request_id: identity.turnId,
        turn_id: identity.turnId,
        stream_id: identity.streamId,
        user_message_id: identity.userMessageId,
        session_incarnation: identity.sessionIncarnation,
        generation: identity.generation,
      },
      messages: [],
      turn_events: [],
    };
  }

  getSession(sessionId) {
    return sessionId === identity.sessionId ? this.session : null;
  }

  getSessionMessages() {
    return this.session.messages;
  }

  getActiveTurn() {
    return this.session.active_turn;
  }

  setActiveTurn(_sessionId, value) {
    this.session.active_turn = { ...value };
    return this.session;
  }

  clearActiveTurn() {
    if (!this.session.active_turn) return null;
    this.session.active_turn = null;
    return this.session;
  }

  flushSession() {
    return true;
  }
}

function createRepairStore(initialArtifact, operations) {
  let artifact = { ...initialArtifact };
  return {
    hasNewerSchema: () => false,
    get: (artifactId) => (artifact?.artifact_id === artifactId ? structuredClone(artifact) : null),
    findByIdentity: () => (artifact ? structuredClone(artifact) : null),
    markDiscardPending(artifactId, requestIdentity) {
      operations.push({ kind: 'discard_pending', artifactId, identity: requestIdentity });
      if (!artifact || artifact.artifact_id !== artifactId) {
        return { ok: false, durable: false, reason: 'artifact_not_found' };
      }
      artifact = { ...artifact, discard_requested: true };
      return { ok: true, durable: true, reason: null, artifact: structuredClone(artifact) };
    },
    markDiscarded(artifactId, requestIdentity) {
      operations.push({ kind: 'discard', artifactId, identity: requestIdentity });
      if (!artifact || artifact.artifact_id !== artifactId) {
        return { ok: false, durable: false, reason: 'artifact_not_found' };
      }
      artifact = { ...artifact, state: 'discarded' };
      return { ok: true, durable: true, reason: null, artifact: structuredClone(artifact) };
    },
    clearResolved(artifactId) {
      operations.push({ kind: 'clear', artifactId });
      artifact = null;
      return { ok: true, durable: true, reason: null, artifact: null };
    },
    current: () => (artifact ? structuredClone(artifact) : null),
  };
}

function createHarness({
  state = 'pending',
  commitOutcomes = [],
  artifact = null,
  commitMessageCopies = 1,
} = {}) {
  const operations = [];
  const rawStore = new RawStore();
  const terminalRepairStore = createRepairStore(artifact || repairArtifact(state), operations);
  const actorRegistry = new SessionTurnActorRegistry({ terminalRepairStore });
  const commitCalls = [];
  const conversationStore = {
    getSessionMessages: () => rawStore.getSessionMessages(),
    async commitTerminal(sessionId, request) {
      operations.push({ kind: 'commit', sessionId });
      commitCalls.push(request);
      const durable = commitOutcomes.length ? commitOutcomes.shift() : true;
      if (!durable) {
        return {
          ok: false,
          applied: false,
          durable: false,
          reason: 'durability_failed',
          commitEpoch: 0,
          dirtyEpoch: 1,
          durableEpoch: 0,
          value: null,
        };
      }
      for (const message of request.messages) {
        for (let copy = 0; copy < commitMessageCopies; copy += 1) {
          const index = rawStore.session.messages.findIndex((entry) => entry.id === message.id);
          if (index >= 0 && commitMessageCopies === 1) {
            rawStore.session.messages[index] = { ...message };
          } else {
            rawStore.session.messages.push({ ...message });
          }
        }
      }
      rawStore.session.active_turn = null;
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
    },
  };
  rawStore.conversationStore = conversationStore;
  const terminalCoordinator = new TerminalCoordinator({
    actorRegistry,
    repairStore: terminalRepairStore,
  });
  const service = {
    sessionStore: rawStore,
    conversationStore,
    terminalRepairStore,
    sessionTurnActors: actorRegistry,
    terminalCoordinator,
    activeStreams: new Map(),
  };
  return {
    service,
    rawStore,
    terminalRepairStore,
    operations,
    commitCalls,
  };
}

function payload(overrides = {}) {
  return {
    sessionId: identity.sessionId,
    messageId: 'assistant_1',
    artifactId: 'repair_1',
    ...overrides,
  };
}

test('retry adopts the exact active identity and replays the persisted terminal snapshot', async () => {
  const harness = createHarness();

  const result = await retryUnsavedReply(harness.service, payload());

  assert.deepEqual(result, {
    ok: true,
    durable: true,
    reason: null,
    message: assistantMessage(),
  });
  assert.equal(harness.commitCalls.length, 1);
  assert.deepEqual(harness.commitCalls[0].messages, [assistantMessage()]);
  assert.equal(harness.rawStore.getActiveTurn(), null);
  assert.equal(harness.terminalRepairStore.current(), null);
  assert.deepEqual(harness.operations.map((operation) => operation.kind), ['commit', 'clear']);
});

test('retry refuses payload or active-turn identity drift before any terminal write', async () => {
  const wrongMessage = createHarness();
  const invalid = await retryUnsavedReply(
    wrongMessage.service,
    payload({ messageId: 'assistant_other' })
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'artifact_identity_conflict');
  assert.equal(wrongMessage.commitCalls.length, 0);

  const stale = createHarness();
  stale.rawStore.session.active_turn.generation = 2;
  const refused = await retryUnsavedReply(stale.service, payload());
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'active_turn_identity_mismatch');
  assert.equal(stale.commitCalls.length, 0);
});

test('message-less terminal repair retries durably without fabricating reply content', async () => {
  const terminalOnlyArtifact = {
    ...repairArtifact(),
    artifact_id: 'repair_terminal_only',
    message: null,
    terminal_snapshot: {
      kind: 'denied',
      terminal: { kind: 'denied' },
      messages: [],
      tool_repairs: [],
      turn_events: [],
      preference_patch: {},
      title: null,
    },
  };
  const harness = createHarness({ artifact: terminalOnlyArtifact });

  const result = await retryUnsavedReply(harness.service, {
    sessionId: identity.sessionId,
    messageId: 'assistant_stream_1',
    artifactId: 'repair_terminal_only',
  });

  assert.deepEqual(result, { ok: true, durable: true, reason: null });
  assert.deepEqual(harness.commitCalls[0].messages, []);
  assert.deepEqual(harness.rawStore.getSessionMessages(), []);
  assert.equal(harness.rawStore.getActiveTurn(), null);
});

test('message-bearing retry requires exactly one canonical row after durable commit', async () => {
  const missing = createHarness({ commitMessageCopies: 0 });
  const missingResult = await retryUnsavedReply(missing.service, payload());
  assert.deepEqual(missingResult, {
    ok: false,
    durable: false,
    reason: 'terminal_repair_message_missing',
  });
  assert.equal(Object.hasOwn(missingResult, 'message'), false);

  const ambiguous = createHarness({ commitMessageCopies: 2 });
  const ambiguousResult = await retryUnsavedReply(ambiguous.service, payload());
  assert.deepEqual(ambiguousResult, {
    ok: false,
    durable: false,
    reason: 'terminal_repair_message_ambiguous',
  });
  assert.equal(Object.hasOwn(ambiguousResult, 'message'), false);
});

test('discard durably tombstones before exact clear, retains it, and is idempotent after clear', async () => {
  const harness = createHarness();

  const first = await discardUnsavedReply(harness.service, payload());

  assert.deepEqual(first, {
    ok: true,
    durable: true,
    reason: null,
    removedMessageId: 'assistant_1',
  });
  assert.deepEqual(harness.operations.map((operation) => operation.kind), [
    'discard_pending', 'commit', 'discard',
  ]);
  assert.equal(harness.commitCalls.length, 1);
  assert.deepEqual(harness.commitCalls[0].messages, []);
  assert.equal(harness.rawStore.getActiveTurn(), null);
  assert.equal(harness.rawStore.getSessionMessages().length, 0);
  assert.equal(harness.terminalRepairStore.current().state, 'discarded');

  const second = await discardUnsavedReply(harness.service, payload());
  assert.deepEqual(second, first);
  assert.equal(harness.commitCalls.length, 1);
  assert.deepEqual(harness.operations.map((operation) => operation.kind), [
    'discard_pending', 'commit', 'discard', 'discard',
  ]);
  assert.equal(harness.terminalRepairStore.current().state, 'discarded');
});

test('failed discard commit remains hydratable and can finish after actor-registry reload', async () => {
  const harness = createHarness({ commitOutcomes: [false, true] });

  const first = await discardUnsavedReply(harness.service, payload());
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'durability_failed');
  assert.notEqual(harness.rawStore.getActiveTurn(), null);
  assert.equal(harness.terminalRepairStore.current().state, 'pending');
  assert.equal(harness.terminalRepairStore.current().discard_requested, true);

  const reloadedActors = new SessionTurnActorRegistry({
    terminalRepairStore: harness.terminalRepairStore,
  });
  harness.service.sessionTurnActors = reloadedActors;
  harness.service.terminalCoordinator = new TerminalCoordinator({
    actorRegistry: reloadedActors,
    repairStore: harness.terminalRepairStore,
  });
  const second = await discardUnsavedReply(harness.service, payload());

  assert.equal(second.ok, true);
  assert.equal(second.durable, true);
  assert.equal(harness.rawStore.getActiveTurn(), null);
  assert.equal(harness.terminalRepairStore.current().state, 'discarded');
  assert.deepEqual(harness.operations.map((operation) => operation.kind), [
    'discard_pending', 'commit', 'discard_pending', 'commit', 'discard',
  ]);
});
