'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TerminalCoordinator,
} = require('../services/backend/chat-stream-terminal-coordinator');
const { buildTerminalTranscriptPreview } = require('../services/backend/chat-stream-terminal-preview');
const {
  SessionTurnActorRegistry,
} = require('../services/backend/session-turn-actor');
const {
  CanonicalTurnEventCollector,
} = require('../services/backend/canonical-turn-event-collector');
const {
  settleTerminalMutation,
} = require('../services/backend/chat-terminal-settlement-service');
const { buildToolResultMessageId } = require('../services/backend/tool-message-id');

function baseSession(id) {
  return {
    id,
    session_incarnation: '',
    turn_generation: 0,
    active_turn: null,
    messages: [],
    turn_events: [],
    pending_question_batch: null,
  };
}

class FakeTerminalStore {
  constructor(outcomes = []) {
    this.session = baseSession('s1');
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
    for (const repair of request.toolRepairs) {
      const index = this.session.messages.findIndex((message) => message.id === repair.messageId);
      if (index >= 0) {
        const current = this.session.messages[index];
        this.session.messages[index] = {
          ...current,
          ...repair.patch,
          ...(repair.patch.tool_call
            ? { tool_call: { ...(current.tool_call || {}), ...repair.patch.tool_call } }
            : {}),
        };
      }
    }
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

function assistantMessage(lease, kind = 'complete') {
  return {
    id: `assistant_${lease.identity.streamId}`,
    role: 'assistant',
    content: 'answer',
    status: kind === 'complete' ? 'complete' : kind,
    terminal_status: kind,
    parent_stream_id: lease.identity.streamId,
    timestamp: '2026-07-14T12:00:01.000Z',
  };
}

function questionBatch() {
  return {
    batch_id: 'batch_1',
    round_index: 1,
    questions: [{ id: 'q1', prompt: 'Choose?', options: [] }],
  };
}

function createHarness({ outcomes = [], repairStore = null } = {}) {
  const store = new FakeTerminalStore(outcomes);
  const registry = createRegistry(repairStore);
  const emitted = [];
  const durabilityUpdates = [];
  const clearedJournal = [];
  const coordinator = new TerminalCoordinator({
    actorRegistry: registry,
    store,
    repairStore,
    journal: {
      clear(sessionId, turnId, options) {
        clearedJournal.push({ sessionId, turnId, options });
        return { ok: true, cleared: true, durable: true, reason: null };
      },
    },
    emitTerminal(payload) {
      emitted.push(payload);
    },
    emitDurabilityUpdate(payload) {
      durabilityUpdates.push(payload);
    },
    now: () => '2026-07-14T12:00:02.000Z',
  });
  return { store, registry, coordinator, emitted, durabilityUpdates, clearedJournal };
}

test('all terminal variants use one epoch-proven commit and exact actor release path', async () => {
  const variants = [
    'complete', 'error', 'cancelled', 'denied', 'timeout', 'preempted',
    'question_batch', 'plan_proposal',
  ];
  for (const kind of variants) {
    const harness = createHarness();
    const lease = reserve(harness.registry, harness.store);
    const batch = kind === 'question_batch' ? questionBatch() : null;
    const message = {
      ...assistantMessage(lease, kind),
      ...(batch ? { kind: 'question_batch', interactive_batch: batch } : {}),
    };
    const result = await harness.coordinator.settle({
      lease,
      identity: lease.identity,
      terminal: { kind, questionBatch: batch },
      messages: [message],
      turnEvents: [],
      preferencePatch: {},
    });

    assert.equal(result.ok, true, kind);
    assert.equal(result.durableTerminal, true, kind);
    assert.equal(result.visibleTerminal, true, kind);
    assert.equal(result.reason, null, kind);
    assert.equal(harness.store.commitCalls.length, 1, kind);
    assert.equal(harness.store.commitCalls[0].options.durable, true, kind);
    assert.deepEqual(
      harness.store.commitCalls[0].request.clearActiveTurnMatch,
      {
        requestId: lease.identity.turnId,
        turnId: lease.identity.turnId,
        streamId: lease.identity.streamId,
        sessionIncarnation: lease.identity.sessionIncarnation,
        generation: lease.identity.generation,
        userMessageId: lease.identity.userMessageId,
      },
      kind
    );
    assert.equal(harness.emitted.length, 1, kind);
    assert.equal(harness.emitted[0].terminalStatus, kind, kind);
    assert.equal(harness.clearedJournal.length, 1, kind);
    assert.equal(
      harness.clearedJournal[0].options.commitResult.commitEpoch,
      1,
      kind
    );
    const replacement = reserve(harness.registry, harness.store);
    assert.equal(replacement.identity.generation, 2, kind);
  }
});

test('question batch token is staged inside the atomic message and preference mutation', async () => {
  const harness = createHarness();
  const lease = reserve(harness.registry, harness.store);
  const batch = questionBatch();
  await harness.coordinator.settle({
    lease,
    terminal: { kind: 'question_batch', questionBatch: batch },
    messages: [{
      ...assistantMessage(lease, 'question_batch'),
      kind: 'question_batch',
      interactive_batch: batch,
    }],
  });

  const request = harness.store.commitCalls[0].request;
  const token = request.preferencePatch.pending_question_batch.continuation_token;
  assert.equal(token.session_incarnation, lease.identity.sessionIncarnation);
  assert.equal(token.prior_generation, lease.identity.generation);
  assert.deepEqual(request.messages[0].interactive_batch.continuation_token, token);
});

test('identity refusal and nonterminal tool repair never reach the store', async () => {
  const harness = createHarness();
  const lease = reserve(harness.registry, harness.store);
  const stale = await harness.coordinator.settle({
    lease,
    identity: { ...lease.identity, generation: lease.identity.generation + 1 },
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
  });
  assert.equal(stale.reason, 'terminal_identity_mismatch');
  assert.equal(harness.store.commitCalls.length, 0);
  assert.throws(() => reserve(harness.registry, harness.store), (error) => (
    error.code === 'session_busy'
  ));

  const invalidRepair = await harness.coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
    toolRepairs: [{
      messageId: 'tool_use_1',
      patch: { tool_call: { call_id: 'call1', status: 'running' } },
    }],
  });
  assert.equal(invalidRepair.reason, 'invalid_tool_repair');
  assert.equal(harness.store.commitCalls.length, 0);
  const mismatchedCall = await harness.coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
    toolRepairs: [{
      messageId: 'tool_use_1',
      callId: 'expected_call',
      patch: { tool_call: { call_id: 'rewritten_call', status: 'interrupted' } },
    }],
  });
  assert.equal(mismatchedCall.reason, 'invalid_tool_repair');
  assert.equal(harness.store.commitCalls.length, 0);
  harness.registry.release(lease, { status: 'cancelled' });
});

test('tool repair commits a deterministic interrupted tool_result in the same epoch', async () => {
  const harness = createHarness();
  const lease = reserve(harness.registry, harness.store);
  harness.store.session.messages.push({
    id: 'tool_use_existing',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_1',
      tool_name: 'shell',
      summary: 'Run command',
      status: 'running',
      parent_stream_id: lease.identity.streamId,
    },
  });

  await harness.coordinator.settle({
    lease,
    terminal: { kind: 'error' },
    messages: [assistantMessage(lease, 'error')],
    toolRepairs: [{
      messageId: 'tool_use_existing',
      patch: {
        tool_call: {
          call_id: 'call_1',
          tool_name: 'shell',
          summary: 'Run command',
          status: 'interrupted',
          parent_stream_id: lease.identity.streamId,
        },
      },
    }],
  });

  const request = harness.store.commitCalls[0].request;
  assert.deepEqual(request.toolRepairs.map((repair) => repair.messageId), ['tool_use_existing']);
  assert.equal(request.toolRepairs[0].callId, 'call_1');
  const preview = buildTerminalTranscriptPreview([
    harness.store.session.messages.find((message) => message.id === 'tool_use_existing'),
  ], {
    messages: request.messages,
    toolRepairs: request.toolRepairs,
  });
  assert.equal(preview.ok, true);
  assert.ok(preview.messages.some(
    (message) => message.id === `tool_result_${lease.identity.streamId}_call_1`
  ));
  const result = request.messages.find(
    (message) => message.id === `tool_result_${lease.identity.streamId}_call_1`
  );
  assert.equal(result.tool_result.error_code, 'CMP-LOOP-0013');
  assert.equal(result.tool_result.metadata.terminal_state, 'interrupted');
  assert.equal(request.turnEvents[0].event_id,
    `terminal_repair:${lease.identity.turnId}:call_1:tool_result`);
  assert.equal(harness.store.session.messages.find(
    (message) => message.id === 'tool_use_existing'
  ).tool_call.status, 'interrupted');
});

test('collector and coordinator persist one semantic tool_result for a synthesized repair', async () => {
  const harness = createHarness();
  const lease = reserve(harness.registry, harness.store);
  harness.store.session.messages.push({
    id: 'tool_use_semantic_dedupe',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_semantic_dedupe',
      tool_name: 'shell',
      status: 'running',
      parent_stream_id: lease.identity.streamId,
    },
  });
  const resultMessageId = buildToolResultMessageId(
    lease.identity.streamId,
    'call_semantic_dedupe'
  );
  const collector = new CanonicalTurnEventCollector({
    turnId: lease.identity.turnId,
    sessionId: lease.identity.sessionId,
    canonicalPrimary: true,
  });
  collector.noteEvent({
    event_id: 'projected_tool_result',
    turn_id: lease.identity.turnId,
    kind: 'tool_result',
    status: 'error',
    tool_call_id: 'call_semantic_dedupe',
    primary_message_id: resultMessageId,
    source_message_ids: [resultMessageId],
    payload: {},
  });

  const outcome = await settleTerminalMutation({
    terminalCoordinator: harness.coordinator,
  }, {
    lease,
    rawStore: harness.store,
    terminal: { kind: 'error' },
    messages: [],
    toolRepairs: [{
      messageId: 'tool_use_semantic_dedupe',
      callId: 'call_semantic_dedupe',
      patch: {
        tool_call: { call_id: 'call_semantic_dedupe', status: 'interrupted' },
      },
    }],
    turnEventCollector: collector,
  });

  assert.equal(outcome.result.durableTerminal, true);
  const persisted = harness.store.commitCalls[0].request.turnEvents.filter((event) => (
    event.kind === 'tool_result'
    && event.tool_call_id === 'call_semantic_dedupe'
    && event.primary_message_id === resultMessageId
  ));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].event_id, 'projected_tool_result');
});

test('custom completed tool result is authoritative when repairing a stale running tool use', async () => {
  const harness = createHarness();
  const lease = reserve(harness.registry, harness.store);
  const resultId = `tool_result_${lease.identity.streamId}_call_done`;
  const realResult = {
    id: resultId,
    role: 'tool',
    kind: 'tool_result',
    content: 'real provider output',
    timestamp: '2026-07-14T12:00:01.000Z',
    finalizedAt: '2026-07-14T12:00:01.000Z',
    tool_result: {
      call_id: 'call_done',
      tool_name: 'shell',
      output_text: 'real provider output',
      summary: 'Command completed',
      is_error: false,
      error_code: null,
      parent_stream_id: lease.identity.streamId,
      generated_artifacts: [],
    },
  };
  harness.store.appendMessage('s1', {
    id: 'tool_use_stale',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_done',
      tool_name: 'shell',
      summary: 'Run command',
      status: 'running',
      parent_stream_id: lease.identity.streamId,
    },
  });
  harness.store.appendMessage('s1', realResult);

  await harness.coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
    toolRepairs: [{
      messageId: 'tool_use_stale',
      callId: 'call_done',
      resultMessage: realResult,
      patch: {
        tool_call: {
          call_id: 'call_done',
          tool_name: 'shell',
          summary: 'Run command',
          status: 'complete',
          parent_stream_id: lease.identity.streamId,
        },
      },
    }],
  });

  const request = harness.store.commitCalls[0].request;
  assert.equal(request.messages.find((message) => message.id === resultId).content,
    'real provider output');
  assert.equal(request.turnEvents[0].status, 'complete');
  assert.equal(request.turnEvents[0].primary_message_id, resultId);
  assert.equal(request.turnEvents[0].payload.output_text, 'real provider output');
  assert.equal(request.turnEvents[0].payload.is_error, false);
  assert.equal(request.turnEvents[0].payload.error_code, null);
  assert.equal(harness.store.session.messages.find(
    (message) => message.id === 'tool_use_stale'
  ).tool_call.status, 'complete');
});

test('durability refusal preserves bracket, journal, repair, and actor until idempotent retry', async () => {
  const repairCalls = [];
  const clearCalls = [];
  const repairStore = {
    savePending(value) {
      repairCalls.push(value);
      return {
        ok: true,
        durable: true,
        reason: null,
        artifact: { artifact_id: 'repair_1' },
      };
    },
    clearResolved(artifactId, identity) {
      clearCalls.push({ artifactId, identity });
      return { ok: true, durable: true, reason: null, artifact: null };
    },
  };
  const harness = createHarness({
    repairStore,
    outcomes: [
      {
        ok: false,
        applied: true,
        apply: true,
        durable: false,
        reason: 'write_failed',
        commitEpoch: 1,
        dirtyEpoch: 1,
        durableEpoch: 0,
      },
      { ...durableOutcome(1), applied: false },
    ],
  });
  const activeStreams = new Map();
  const lease = reserve(harness.registry, harness.store, activeStreams);
  const controller = {};
  harness.registry.attachController(lease, controller);

  const refused = await harness.coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
  });
  assert.deepEqual(refused, {
    ok: false,
    visibleTerminal: true,
    durableTerminal: false,
    reason: 'write_failed',
    persistedMessageIds: [],
    repairDurable: true,
    artifactId: 'repair_1',
  });
  assert.equal(lease.providerQuiesced, true);
  assert.equal(activeStreams.has(lease.identity.streamId), false);
  assert.equal(harness.store.getActiveTurn('s1').stream_id, lease.identity.streamId);
  assert.equal(harness.clearedJournal.length, 0);
  assert.equal(repairCalls.length, 1);
  assert.equal(repairCalls[0].terminal_snapshot.kind, 'complete');
  assert.equal(repairCalls[0].terminal_snapshot.messages[0].content, 'answer');
  assert.throws(() => reserve(harness.registry, harness.store), (error) => (
    error.code === 'session_busy' && error.reason === 'lease_active'
  ));

  const [retry, duplicateRetry] = await Promise.all([
    harness.coordinator.retry(lease),
    harness.coordinator.retry(lease),
  ]);
  assert.equal(retry.ok, true);
  assert.deepEqual(duplicateRetry, retry);
  assert.equal(harness.store.commitCalls.length, 2);
  assert.equal(harness.store.session.messages.filter(
    (message) => message.id === `assistant_${lease.identity.streamId}`
  ).length, 1);
  assert.equal(harness.emitted.length, 1, 'retry does not emit a second terminal');
  assert.equal(harness.durabilityUpdates.length, 1);
  assert.equal(harness.clearedJournal.length, 1);
  assert.equal(clearCalls.length, 1);
  assert.deepEqual(clearCalls[0], {
    artifactId: 'repair_1',
    identity: {
      session_id: 's1',
      session_incarnation: lease.identity.sessionIncarnation,
      turn_generation: lease.identity.generation,
    },
  });
  const replacement = reserve(harness.registry, harness.store);
  assert.equal(replacement.identity.generation, 2);
});

test('terminal listener throw clears the emission latch so a durable retry re-emits', async () => {
  // The emission latch means "an attempt is in flight or has already
  // succeeded", not "one attempt ever happened": a renderer momentarily
  // unsubscribed / IPC not ready on the first try must not permanently
  // suppress the user-visible terminal once the durable commit lands on a
  // later retry pass.
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
      if (emissionAttempts === 1) {
        throw new Error('renderer listener failed after dispatch began');
      }
      return true;
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
  assert.equal(lease.terminalEmissionAttempted, false, 'a thrown attempt must clear the latch');

  const retried = await coordinator.retry(lease);
  assert.equal(retried.durableTerminal, true);
  assert.equal(retried.visibleTerminal, true, 'a later retry pass must re-attempt and succeed');
  assert.equal(emissionAttempts, 2);

  // Success latches for good: a further retry must not re-invoke emitTerminal.
  const settledAgain = await coordinator.retry(lease);
  assert.equal(settledAgain.visibleTerminal, true);
  assert.equal(emissionAttempts, 2, 'a successful emission must not be repeated');
});

test('repairMessage preserves the full visible reply while the snapshot stays canonical', async () => {
  const repairCalls = [];
  const repairStore = {
    savePending(value) {
      repairCalls.push(value);
      return {
        ok: true,
        durable: true,
        reason: null,
        artifact: { artifact_id: 'repair_segmented' },
      };
    },
  };
  const harness = createHarness({
    repairStore,
    outcomes: [{
      ok: false,
      applied: false,
      durable: false,
      reason: 'write_failed',
      commitEpoch: 0,
      dirtyEpoch: 0,
      durableEpoch: 0,
    }],
  });
  const lease = reserve(harness.registry, harness.store);
  const canonicalTail = {
    ...assistantMessage(lease),
    id: `assistant_${lease.identity.streamId}_seg2`,
    content: 'final tail only',
  };
  const visibleReply = {
    ...assistantMessage(lease),
    content: 'commentary, tool boundary, and final tail',
  };

  const result = await harness.coordinator.settle({
    lease,
    terminal: { kind: 'complete', repairMessage: visibleReply },
    messages: [canonicalTail],
  });

  assert.equal(result.durableTerminal, false);
  assert.equal(repairCalls.length, 1);
  assert.equal(repairCalls[0].message.id, visibleReply.id);
  assert.equal(repairCalls[0].message.content, visibleReply.content);
  assert.deepEqual(repairCalls[0].terminal_snapshot.messages, [canonicalTail]);

  const invalidHarness = createHarness();
  const invalidLease = reserve(invalidHarness.registry, invalidHarness.store);
  const invalid = await invalidHarness.coordinator.settle({
    lease: invalidLease,
    terminal: { kind: 'complete', repairMessage: { id: 'user_1', role: 'user' } },
    messages: [assistantMessage(invalidLease)],
  });
  assert.equal(invalid.reason, 'invalid_terminal_repair_message');
  assert.equal(invalidHarness.store.commitCalls.length, 0);
});

test('preexisting refusal saves one repair before an explicit retry commits', async () => {
  const saved = [];
  const cleared = [];
  const repairStore = {
    savePending(value) {
      saved.push(value);
      return { ok: true, durable: true, artifact: { artifact_id: 'repair_forced' } };
    },
    clearResolved(artifactId) {
      cleared.push(artifactId);
      return { ok: true, durable: true };
    },
  };
  const harness = createHarness({ repairStore, outcomes: [durableOutcome(2)] });
  const lease = reserve(harness.registry, harness.store);
  const message = assistantMessage(lease);
  const first = await harness.coordinator.settle({
    lease,
    terminal: {
      kind: 'complete',
      repairMessage: message,
      preexistingRefusalReason: 'assistant_segment_persist_refused',
    },
    messages: [message],
  });
  assert.equal(first.durableTerminal, false);
  assert.equal(first.repairDurable, true);
  assert.equal(harness.store.commitCalls.length, 0);
  assert.equal(harness.emitted.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(lease.released, false);

  const retry = await harness.coordinator.retry(lease);
  assert.equal(retry.durableTerminal, true);
  assert.equal(harness.store.commitCalls.length, 1);
  assert.equal(harness.emitted.length, 1);
  assert.equal(lease.released, true);
  assert.deepEqual(cleared, ['repair_forced']);
});

test('pre-painted terminal is never emitted again by coordinator', async () => {
  const harness = createHarness();
  const lease = reserve(harness.registry, harness.store);
  const result = await harness.coordinator.settle({
    lease,
    terminal: { kind: 'complete', visibleTerminal: true },
    messages: [assistantMessage(lease)],
  });
  assert.equal(result.visibleTerminal, true);
  assert.equal(harness.emitted.length, 0);
});

test('restart adoption replays the persisted terminal snapshot without inference', async () => {
  const store = new FakeTerminalStore([durableOutcome(2)]);
  const originalRegistry = createRegistry();
  const original = reserve(originalRegistry, store);
  const message = assistantMessage(original);
  let artifact = {
    artifact_id: 'repair_restart',
    session_id: 's1',
    session_incarnation: original.identity.sessionIncarnation,
    turn_generation: original.identity.generation,
    turn_id: original.identity.turnId,
    stream_id: original.identity.streamId,
    state: 'pending',
    message,
    terminal_snapshot: {
      kind: 'complete',
      terminal: { kind: 'complete' },
      messages: [message],
      tool_repairs: [],
      turn_events: [],
      preference_patch: { pending_question_batch: null },
      title: 'Recovered title',
    },
  };
  const repairStore = {
    hasNewerSchema: () => false,
    findByIdentity: () => artifact,
    clearResolved(artifactId, identity) {
      assert.equal(artifactId, 'repair_restart');
      assert.equal(identity.turn_generation, original.identity.generation);
      artifact = null;
      return { ok: true, durable: true, reason: null };
    },
  };
  const restarted = createRegistry(repairStore);
  const adopted = restarted.adoptPendingTerminalRepair({
    identity: original.identity,
    store,
    artifactId: 'repair_restart',
  });
  const emitted = [];
  const coordinator = new TerminalCoordinator({
    actorRegistry: restarted,
    store,
    repairStore,
    emitTerminal: (payload) => emitted.push(payload),
  });

  const result = await coordinator.settlePendingRepair({ lease: adopted, artifact });
  assert.equal(result.ok, true);
  assert.equal(result.visibleTerminal, true, 'hydrated repair is already visible');
  assert.equal(emitted.length, 0, 'restart retry does not duplicate the hydrated terminal');
  assert.equal(store.commitCalls[0].request.messages[0].id, message.id);
  assert.equal(store.commitCalls[0].request.title, 'Recovered title');
  const replacement = reserve(restarted, store);
  assert.equal(replacement.identity.generation, original.identity.generation + 1);
});

test('discard persists a tombstone before exact active-turn cleanup and never resurrects content', async () => {
  const store = new FakeTerminalStore([durableOutcome(1)]);
  const original = reserve(createRegistry(), store);
  store.session.messages.push({
    id: 'tool_use_discard',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_discard',
      tool_name: 'shell',
      status: 'pending_approval',
      approval_state: 'pending',
      parent_stream_id: original.identity.streamId,
    },
  });
  const toolResult = {
    id: `tool_result_${original.identity.streamId}_call_discard`,
    role: 'tool',
    kind: 'tool_result',
    content: 'System error: tool execution interrupted. Retry if needed.',
    tool_result: {
      call_id: 'call_discard',
      parent_stream_id: original.identity.streamId,
      is_error: true,
    },
  };
  let artifact = {
    artifact_id: 'repair_discard',
    session_id: 's1',
    session_incarnation: original.identity.sessionIncarnation,
    turn_generation: original.identity.generation,
    turn_id: original.identity.turnId,
    stream_id: original.identity.streamId,
    state: 'pending',
    message: assistantMessage(original),
    terminal_snapshot: {
      kind: 'complete',
      terminal: { kind: 'complete' },
      messages: [assistantMessage(original), toolResult],
      tool_repairs: [{
        messageId: 'tool_use_discard',
        callId: 'call_discard',
        patch: {
          tool_call: {
            call_id: 'call_discard',
            status: 'interrupted',
            approval_state: 'interrupted',
          },
        },
      }],
      turn_events: [{
        event_id: 'tool_result_discard',
        turn_id: original.identity.turnId,
        kind: 'tool_result',
        tool_call_id: 'call_discard',
        primary_message_id: toolResult.id,
        source_message_ids: [toolResult.id],
      }, {
        event_id: 'assistant_discarded',
        turn_id: original.identity.turnId,
        kind: 'assistant_text',
        primary_message_id: assistantMessage(original).id,
      }],
      preference_patch: {},
    },
  };
  const operations = [];
  const repairStore = {
    hasNewerSchema: () => false,
    findByIdentity: () => ({ ...artifact }),
    markDiscardPending(artifactId, identity) {
      operations.push({ kind: 'discard_pending', artifactId, identity });
      artifact = { ...artifact, discard_requested: true };
      return { ok: true, durable: true, reason: null, artifact: { ...artifact } };
    },
    markDiscarded(artifactId, identity) {
      operations.push({ kind: 'discard', artifactId, identity });
      artifact = { ...artifact, state: 'discarded' };
      return { ok: true, durable: true, reason: null, artifact: { ...artifact } };
    },
    clearResolved() {
      operations.push({ kind: 'clear_repair' });
      return { ok: true, durable: true, reason: null };
    },
  };
  const restarted = createRegistry(repairStore);
  const adopted = restarted.adoptPendingTerminalRepair({
    identity: original.identity,
    store,
    artifactId: artifact.artifact_id,
  });
  const coordinator = new TerminalCoordinator({ actorRegistry: restarted, store, repairStore });

  const result = await coordinator.discardPendingRepair({ lease: adopted, artifact });

  assert.equal(result.ok, true);
  assert.equal(result.durableTerminal, true);
  assert.equal(artifact.state, 'discarded');
  assert.deepEqual(operations.map((operation) => operation.kind), ['discard_pending', 'discard']);
  assert.equal(store.commitCalls.length, 1);
  assert.deepEqual(store.commitCalls[0].request.messages, [toolResult]);
  assert.deepEqual(store.commitCalls[0].request.turnEvents, [artifact.terminal_snapshot.turn_events[0]]);
  assert.equal(store.session.messages[0].tool_call.status, 'interrupted');
  assert.equal(store.session.messages[0].tool_call.approval_state, 'interrupted');
  assert.ok(store.session.messages.some((message) => message.id === toolResult.id));
  assert.ok(!store.session.messages.some((message) => message.id === assistantMessage(original).id));
  assert.equal(store.getActiveTurn('s1'), null);
  assert.equal(reserve(restarted, store).identity.generation, original.identity.generation + 1);
});

test('structured cleanup refusals warn without reopening a durable terminal', async () => {
  const store = new FakeTerminalStore([durableOutcome(1)]);
  const registry = createRegistry();
  const lease = reserve(registry, store);
  lease.terminalRepairArtifactId = 'repair_cleanup';
  lease.terminalRepairDurable = true;
  const logs = [];
  const coordinator = new TerminalCoordinator({
    actorRegistry: registry,
    store,
    repairStore: {
      clearResolved: () => ({ ok: false, durable: false, reason: 'stale_identity' }),
    },
    journal: {
      clear: () => ({ ok: false, durable: false, reason: 'journal_write_failed' }),
    },
    logger: (...entry) => logs.push(entry),
  });

  const result = await coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
  });

  assert.equal(result.ok, true);
  assert.equal(result.durableTerminal, true);
  assert.deepEqual(logs.map((entry) => entry.slice(0, 2)), [
    ['WARN', 'lifecycle.terminal_journal_clear_refused'],
    ['WARN', 'lifecycle.terminal_journal_clear_refused'],
    ['WARN', 'lifecycle.terminal_journal_clear_refused'],
    ['ERROR', 'lifecycle.terminal_journal_clear_retry_exhausted'],
    ['WARN', 'lifecycle.terminal_repair_clear_refused'],
    ['WARN', 'lifecycle.terminal_repair_clear_refused'],
    ['WARN', 'lifecycle.terminal_repair_clear_refused'],
    ['ERROR', 'lifecycle.terminal_repair_clear_retry_exhausted'],
  ]);
});

test('resolved repair cleanup retries a bounded transient refusal and reconciles', async () => {
  const store = new FakeTerminalStore([durableOutcome(1)]);
  const registry = createRegistry();
  const lease = reserve(registry, store);
  lease.terminalRepairArtifactId = 'repair_cleanup_retry';
  lease.terminalRepairDurable = true;
  let clearAttempts = 0;
  const coordinator = new TerminalCoordinator({
    actorRegistry: registry,
    store,
    repairStore: {
      clearResolved() {
        clearAttempts += 1;
        return clearAttempts < 3
          ? { ok: false, durable: false, reason: 'write_failed' }
          : { ok: true, durable: true, reason: null };
      },
    },
  });

  const result = await coordinator.settle({
    lease,
    terminal: { kind: 'complete' },
    messages: [assistantMessage(lease)],
  });

  assert.equal(result.durableTerminal, true);
  assert.equal(clearAttempts, 3);
});
