'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { SessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { createManagedChatStreamRuntime } = require('../../services/backend/chat-stream-managed-runtime');
const { acknowledgeFinalizedTurnPersistence } = require('../../services/backend/managed-sidecar-chat-turn-seams');
const { CanonicalTurnEventCollector } = require('../../services/backend/canonical-turn-event-collector');
const { handleToolNotification } = require('../../services/backend/chat-stream-tool-handling');
const { projectTurnTree } = require('../../renderer/chat/renderer-turn-tree-projector');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-identities-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  t.after(() => { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const sessionId = store.createSession({ title: 'Identity fixture' }).id;
  const service = Object.assign(new EventEmitter(), { sessionStore: store,
    sessionTurnActors: new SessionTurnActorRegistry(), activeStreams: new Map(),
    featureFlags: {}, _emitServiceLog() {}, renameSession: async () => null });
  const lease = service.sessionTurnActors.reserveStart({ sessionId, store,
    activeStreams: service.activeStreams, prompt: 'hello', logicalTurnId: 'logical_turn_1' });
  const streamId = lease.identity.streamId;
  const runtime = createManagedChatStreamRuntime({ service, resolvedSessionId: sessionId,
    streamId, turnLease: lease, normalizedPreferences: { conversation_mode: 'chat', interactive_round_count: 0 },
    normalizedInteractiveResponse: null, normalizedAttachments: [], transcriptPrompt: 'hello',
    userMessageId: lease.identity.userMessageId });
  return { root, service, store, sessionId, lease, streamId, runtime };
}

test('managed denial clears the logical active turn while keeping stream correlation', async t => {
  const { runtime, store, sessionId, streamId } = fixture(t);
  runtime.setModel('mock-v1');
  assert.equal(runtime.getEventBase().turnId, 'logical_turn_1');
  assert.equal(runtime.getEventBase().requestId, streamId);
  assert.equal(runtime.getEventBase().streamId, streamId);
  runtime.persistUserMessage();
  assert.equal(store.getActiveTurn(sessionId).request_id, 'logical_turn_1');
  assert.equal((await runtime.settleTerminalResult({ status: 'denied' })).status, 'denied');
  assert.equal(store.getActiveTurn(sessionId), null);
  assert.equal(store.getSessionMessages(sessionId)[0].id, `user_${streamId}`);
  assert.equal(store.getSessionMessages(sessionId)[0].turn_id, 'logical_turn_1');
});

test('failure cleanup uses both logical turn and attempt stream and rejects stale attempts', t => {
  const { runtime, service, store, sessionId, lease } = fixture(t);
  runtime.persistUserMessage();
  runtime.clearReconnectStateOnFailure();
  assert.equal(store.getActiveTurn(sessionId), null);
  service.sessionTurnActors.release(lease, { status: 'failed' });
  const next = service.sessionTurnActors.reserveStart({ sessionId, store,
    activeStreams: service.activeStreams, prompt: 'resume', logicalTurnId: 'logical_turn_1' });
  runtime.clearReconnectStateOnFailure();
  assert.equal(store.getActiveTurn(sessionId).stream_id, next.identity.streamId);
  service.sessionTurnActors.release(next, { status: 'cancelled' });
});

test('finalized canonical persistence uses the collector logical identity', () => {
  let received;
  const collector = { turnId: 'logical_turn_1', persistFinalizedTurn: (...args) => {
    received = args;
    return { ok: true, appended: 1 };
  } };
  const messages = [{ id: 'assistant_stream_1', parent_stream_id: 'stream_1' }];
  const service = { sessionStore: { getSessionMessages: () => messages } };
  assert.equal(acknowledgeFinalizedTurnPersistence(service, collector, 'session_1', 'stream_1').ok, true);
  assert.deepEqual(received, ['session_1', 'logical_turn_1', messages]);
});

test('generated canonical events from separate attempts never reuse event identity', () => {
  const first = new CanonicalTurnEventCollector({ turnId: 'logical_turn_1', attemptId: 'stream_1' });
  const second = new CanonicalTurnEventCollector({ turnId: 'logical_turn_1', attemptId: 'stream_2' });
  const event = { kind: 'tool_use', tool_call_id: 'call_1', payload: {} };
  const one = first.noteEvent(event);
  const two = second.noteEvent(event);
  assert.equal(one.turn_id, two.turn_id);
  assert.notEqual(one.event_id, two.event_id);
});

test('tool rows carry logical identity while retaining physical stream message and parent IDs', t => {
  const { service, store, sessionId, streamId } = fixture(t);
  const collector = new CanonicalTurnEventCollector({ turnId: 'logical_turn_1', attemptId: streamId });
  const context = { resolvedSessionId: sessionId, streamId, model: 'mock-v1',
    seenToolCalls: new Set(), toolSummaries: new Map(), turnEventCollector: collector,
    eventBase: { streamId, turnId: 'logical_turn_1', requestId: streamId, sessionId } };
  handleToolNotification(service, context, { method: 'tool.executing', params: {
    tool_name: 'read_file', tool_call_id: 'call_1', tool_input: { path: 'README.md' },
  } });
  const message = store.getSessionMessages(sessionId)[0];
  assert.equal(message.turn_id, 'logical_turn_1');
  assert.equal(message.tool_call.parent_stream_id, streamId);
  assert.ok(message.id.includes(streamId));
  assert.equal(collector.capturedEvents[0].turn_id, 'logical_turn_1');
});

test('canonical persistence and reload retain one logical turn across physical message IDs', async t => {
  const { root, runtime, store, sessionId, streamId } = fixture(t);
  runtime.persistUserMessage();
  await runtime.settleTerminalResult({ status: 'denied' });
  const collector = new CanonicalTurnEventCollector({ store, sessionId,
    turnId: 'logical_turn_1', attemptId: streamId });
  const receipt = collector.persistFinalizedTurn(sessionId, 'logical_turn_1', store.getSessionMessages(sessionId));
  assert.equal(receipt.ok, true);
  assert.ok(receipt.appended > 0);
  store.flush();
  store.dispose();
  const reopened = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  try {
    const session = reopened.getSession(sessionId);
    const tree = projectTurnTree(session);
    assert.equal(tree.turns.length, 1);
    assert.equal(tree.turns[0].turn_id, 'logical_turn_1');
    assert.ok(session.turn_events.length > 0);
    assert.ok(session.turn_events.every(event => event.turn_id === 'logical_turn_1'));
    assert.equal(session.messages[0].id, `user_${streamId}`);
    assert.equal(session.messages[0].turn_id, 'logical_turn_1');
  } finally { reopened.dispose(); }
});

test('editing reanchors the surviving user message to the new logical turn without changing its identity', t => {
  const { runtime, store, sessionId, streamId } = fixture(t);
  runtime.persistUserMessage();
  const original = store.getSessionMessages(sessionId)[0];
  store.truncateAfterMessage(sessionId, original.id, {
    replaceMessageContent: 'edited request', replaceMessageTurnId: 'logical_turn_2',
  });
  const updated = store.getSessionMessages(sessionId)[0];
  assert.equal(updated.id, `user_${streamId}`);
  assert.equal(updated.timestamp, original.timestamp);
  assert.equal(updated.turn_id, 'logical_turn_2');
  assert.equal(projectTurnTree({ messages: [updated] }).turns[0].turn_id, 'logical_turn_2');
});
