'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildRepairActionResult,
  hydrateMessagesWithTerminalRepairs,
  resolveTerminalRepairRequest,
} = require('../services/backend/terminal-repair-service');

const artifact = {
  artifact_id: 'repair-a',
  session_id: 'session-a',
  session_incarnation: 'inc-a',
  turn_generation: 1,
  turn_id: 'turn-a',
  stream_id: 'stream-a',
  state: 'pending',
  reason: 'write_failed',
  scope: 'assistant',
  message: {
    id: 'assistant-a',
    role: 'assistant',
    content: 'Reply',
    status: 'complete',
    timestamp: '2026-07-14T12:00:00.000Z',
  },
};
artifact.terminal_snapshot = {
  kind: 'complete',
  terminal: { kind: 'complete' },
  messages: [{ ...artifact.message }],
  tool_repairs: [],
  turn_events: [],
  preference_patch: {},
  title: null,
};

function serviceWithArtifact(value = artifact) {
  return {
    terminalRepairStore: {
      get(id) {
        return id === value.artifact_id ? value : null;
      },
      listPending(sessionId) {
        return sessionId === value.session_id ? [value] : [];
      },
    },
  };
}

test('repair request resolution requires the exact session/message/artifact tuple', () => {
  const service = serviceWithArtifact();
  assert.equal(resolveTerminalRepairRequest(service, {
    sessionId: 'session-a', messageId: 'assistant-a', artifactId: 'repair-a',
  }).ok, true);
  assert.equal(resolveTerminalRepairRequest(service, {
    sessionId: 'session-b', messageId: 'assistant-a', artifactId: 'repair-a',
  }).reason, 'artifact_identity_conflict');
  assert.equal(resolveTerminalRepairRequest(service, {
    sessionId: 'session-a', messageId: 'assistant-b', artifactId: 'repair-a',
  }).reason, 'artifact_identity_conflict');
  const discardedService = serviceWithArtifact({ ...artifact, state: 'discarded' });
  assert.equal(resolveTerminalRepairRequest(discardedService, {
    sessionId: 'session-a', messageId: 'assistant-a', artifactId: 'repair-a',
  }).reason, 'artifact_not_found');
  assert.equal(resolveTerminalRepairRequest(discardedService, {
    sessionId: 'session-a', messageId: 'assistant-a', artifactId: 'repair-a',
  }, { allowDiscarded: true }).ok, true);

  const terminalOnly = serviceWithArtifact({
    ...artifact,
    artifact_id: 'repair-terminal-only',
    message: null,
    scope: 'terminal',
    terminal_snapshot: {
      ...artifact.terminal_snapshot,
      kind: 'denied',
      terminal: {
        kind: 'denied',
        rendererPayload: { message: 'The request was denied.' },
      },
      messages: [],
    },
  });
  assert.equal(resolveTerminalRepairRequest(terminalOnly, {
    sessionId: 'session-a', messageId: 'assistant_stream-a', artifactId: 'repair-terminal-only',
  }).ok, true);
  assert.equal(resolveTerminalRepairRequest(terminalOnly, {
    sessionId: 'session-a', messageId: '', artifactId: 'repair-terminal-only',
  }).reason, 'artifact_identity_conflict');
  const discardPending = serviceWithArtifact({ ...artifact, discard_requested: true });
  assert.equal(resolveTerminalRepairRequest(discardPending, {
    sessionId: 'session-a', messageId: 'assistant-a', artifactId: 'repair-a',
  }).reason, 'artifact_discard_pending');
  assert.equal(resolveTerminalRepairRequest(discardPending, {
    sessionId: 'session-a', messageId: 'assistant-a', artifactId: 'repair-a',
  }, { allowDiscarded: true }).ok, true);
});

test('hydration overlays only the requested session repair', () => {
  const restored = hydrateMessagesWithTerminalRepairs(serviceWithArtifact(), 'session-a', []);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].durability.artifact_id, 'repair-a');
  assert.deepEqual(hydrateMessagesWithTerminalRepairs(serviceWithArtifact(), 'session-b', []), []);
});

test('hydration gives a terminal-only repair a deterministic recoverable row', () => {
  const terminalOnly = {
    ...artifact,
    artifact_id: 'repair-terminal-only',
    message: null,
    scope: 'terminal',
    terminal_snapshot: {
      ...artifact.terminal_snapshot,
      kind: 'denied',
      terminal: {
        kind: 'denied',
        rendererPayload: { message: 'The request was denied.' },
      },
      messages: [],
    },
  };

  const restored = hydrateMessagesWithTerminalRepairs(
    serviceWithArtifact(terminalOnly),
    'session-a',
    []
  );

  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'assistant_stream-a');
  assert.equal(restored[0].content, 'The request was denied.');
  assert.equal(restored[0].status, 'denied');
  assert.equal(restored[0].durability.artifact_id, 'repair-terminal-only');
});

test('hydration reconciles an exact canonical terminal twin after deferred clear failure', () => {
  const clearCalls = [];
  const service = serviceWithArtifact();
  service.sessionStore = { getActiveTurn: () => null };
  service.terminalRepairStore.clearResolved = (artifactId, identity) => {
    clearCalls.push({ artifactId, identity });
    return { ok: true, durable: true, reason: null };
  };
  const canonical = [{ ...artifact.message }];

  const hydrated = hydrateMessagesWithTerminalRepairs(service, 'session-a', canonical);

  assert.deepEqual(hydrated, canonical);
  assert.deepEqual(clearCalls, [{
    artifactId: 'repair-a',
    identity: {
      session_id: 'session-a',
      session_incarnation: 'inc-a',
      turn_generation: 1,
    },
  }]);

  clearCalls.length = 0;
  service.sessionStore.getActiveTurn = () => ({ turn_id: 'turn-a' });
  hydrateMessagesWithTerminalRepairs(service, 'session-a', canonical);
  assert.equal(clearCalls.length, 0, 'an active bracket forbids canonical-twin cleanup');
});

test('repair action results expose stable retry/discard shapes', () => {
  assert.deepEqual(buildRepairActionResult({ reason: 'write_failed' }), {
    ok: false, durable: false, reason: 'write_failed',
  });
  assert.deepEqual(buildRepairActionResult({
    ok: true, durable: true, removedMessageId: 'assistant-a',
  }), {
    ok: true, durable: true, reason: null, removedMessageId: 'assistant-a',
  });
});
