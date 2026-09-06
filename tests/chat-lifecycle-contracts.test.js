'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TERMINAL_KINDS,
  buildTerminalCommitResult,
  buildTerminalIdentity,
  buildStartIdentityBundle,
  describeMissingIdentityFields,
  buildManagedStartResult,
  isDurableCommitOutcome,
  normalizeTerminalKind,
  terminalIdentityMatches,
  validateTerminalIdentity,
} = require('../services/backend/chat-lifecycle-contracts');

// --- buildTerminalCommitResult ---

test('buildTerminalCommitResult normalizes a refused terminal settle', () => {
  assert.deepEqual(
    buildTerminalCommitResult({
      ok: false,
      visibleTerminal: true,
      durableTerminal: false,
      reason: 'assistant_persist_refused',
      persistedMessageIds: [],
    }),
    {
      ok: false,
      visibleTerminal: true,
      durableTerminal: false,
      reason: 'assistant_persist_refused',
      persistedMessageIds: [],
      repairDurable: null,
      artifactId: null,
    }
  );
});

test('buildTerminalCommitResult trims persistedMessageIds and drops invalid entries', () => {
  const result = buildTerminalCommitResult({
    ok: true,
    visibleTerminal: true,
    durableTerminal: true,
    reason: null,
    persistedMessageIds: [' assistant_1 ', '', null, 42, 'assistant_2'],
  });
  assert.deepEqual(result.persistedMessageIds, ['assistant_1', 'assistant_2']);
});

test('buildTerminalCommitResult never throws on a non-array persistedMessageIds', () => {
  const result = buildTerminalCommitResult({ ok: true, persistedMessageIds: 'not-an-array' });
  assert.deepEqual(result.persistedMessageIds, []);
  assert.equal(result.repairDurable, null);
  assert.equal(result.artifactId, null);
});

test('terminal identity validation is exact and terminal vocabulary normalizes legacy aliases', () => {
  const identity = buildTerminalIdentity({
    sessionId: ' s1 ',
    sessionIncarnation: ' inc1 ',
    generation: 3,
    turnId: 'turn1',
    streamId: 'stream1',
    userMessageId: 'user1',
  });
  assert.deepEqual(validateTerminalIdentity(identity), { ok: true, reason: null, identity });
  assert.equal(terminalIdentityMatches(identity, { ...identity }), true);
  assert.equal(terminalIdentityMatches(identity, { ...identity, generation: 4 }), false);
  assert.equal(validateTerminalIdentity({ ...identity, streamId: '' }).reason,
    'missing_terminal_identity_streamId');
  assert.equal(normalizeTerminalKind('completed'), 'complete');
  assert.equal(normalizeTerminalKind('runtime-error'), 'error');
  assert.equal(normalizeTerminalKind('canceled'), 'cancelled');
  assert.deepEqual(TERMINAL_KINDS, [
    'complete', 'error', 'cancelled', 'denied', 'timeout', 'preempted',
    'question_batch', 'plan_proposal',
  ]);
});

test('durable commit outcome requires explicit epoch proof', () => {
  assert.equal(isDurableCommitOutcome({
    ok: true, durable: true, commitEpoch: 4, durableEpoch: 4,
  }), true);
  assert.equal(isDurableCommitOutcome({ ok: true, durable: true }), false);
  assert.equal(isDurableCommitOutcome({
    ok: true, durable: true, commitEpoch: 5, durableEpoch: 4,
  }), false);
});

// --- buildStartIdentityBundle ---

test('buildStartIdentityBundle normalizes external-style ids (userMessageId known eagerly)', () => {
  assert.deepEqual(
    buildStartIdentityBundle({
      sessionId: 'session-1',
      streamId: 'stream-1',
      turnId: null,
      userMessageId: 'user_stream-1',
      sessionRevision: null,
      generation: null,
    }),
    {
      sessionId: 'session-1',
      streamId: 'stream-1',
      turnId: null,
      userMessageId: 'user_stream-1',
      sessionRevision: null,
      generation: null,
    }
  );
});

test('buildStartIdentityBundle coerces invalid types to null and never throws', () => {
  assert.deepEqual(
    buildStartIdentityBundle({
      sessionId: 7,
      streamId: undefined,
      turnId: {},
      userMessageId: '   ',
      sessionRevision: 'seven',
      generation: [],
    }),
    {
      sessionId: null,
      streamId: null,
      turnId: null,
      userMessageId: null,
      sessionRevision: null,
      generation: null,
    }
  );
});

// --- describeMissingIdentityFields ---

test('describeMissingIdentityFields lists every null/absent field', () => {
  const bundle = buildStartIdentityBundle({ sessionId: 'session-1', streamId: 'stream-1' });
  assert.deepEqual(describeMissingIdentityFields(bundle), [
    'turnId',
    'userMessageId',
    'sessionRevision',
    'generation',
  ]);
});

test('describeMissingIdentityFields returns every field name for a malformed bundle', () => {
  assert.deepEqual(describeMissingIdentityFields(null), [
    'sessionId',
    'streamId',
    'turnId',
    'userMessageId',
    'sessionRevision',
    'generation',
  ]);
  assert.deepEqual(describeMissingIdentityFields(undefined).length, 6);
});

test('describeMissingIdentityFields returns an empty list once every field is populated', () => {
  const bundle = buildStartIdentityBundle({
    sessionId: 'session-1',
    streamId: 'stream-1',
    turnId: 'turn-1',
    userMessageId: 'user-1',
    sessionRevision: 1,
    generation: 1,
  });
  assert.deepEqual(describeMissingIdentityFields(bundle), []);
});

// --- buildManagedStartResult ---

test('buildManagedStartResult returns streamId/sessionId plus an additive identity bundle with null userMessageId', () => {
  const logs = [];
  const service = {
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  };

  const result = buildManagedStartResult(service, { sessionId: 'session-1', streamId: 'stream-1' });

  assert.equal(result.streamId, 'stream-1');
  assert.equal(result.sessionId, 'session-1');
  assert.deepEqual(result.identity, {
    sessionId: 'session-1',
    streamId: 'stream-1',
    turnId: null,
    userMessageId: null,
    sessionRevision: null,
    generation: null,
  });

  const debugLogs = logs.filter((entry) => entry.event === 'chat.start_identity');
  assert.equal(debugLogs.length, 1);
  assert.equal(debugLogs[0].level, 'DEBUG');
  assert.deepEqual(debugLogs[0].details.identity, result.identity);
  assert.ok(debugLogs[0].details.missingIdentityFields.includes('userMessageId'));
});

test('buildManagedStartResult never throws when the service has no logger', () => {
  const result = buildManagedStartResult({}, { sessionId: 'session-1', streamId: 'stream-1' });
  assert.equal(result.streamId, 'stream-1');
  assert.equal(result.sessionId, 'session-1');
});
