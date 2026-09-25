'use strict';

// A4 F8 (1.2.0 gate): a paused turn resumes on a fresh stream, and the paused
// stream never gets its own terminal event, so the continuation's terminal
// must release it from pendingStreams.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamHandlerRuntime } = require('../renderer/chat/renderer-stream-handler-runtime.js');

function createHarness(t, { pendingStreams, pendingToolApprovals, messagesBySession, liveStreams = {} }) {
  const clearedStreams = [];
  // The session's live stream, as the multi-stream controller tracks it.
  const liveBySession = new Map(Object.entries(liveStreams));
  const state = {
    pendingStreams,
    pendingToolApprovals,
    toolCallsByStream: new Map(),
    messagesBySession,
    streamThinkingStatusByStream: new Map(),
  };
  const runtime = createStreamHandlerRuntime({
    state,
    multiStreamController: {
      clearStream(streamId) {
        clearedStreams.push(streamId);
        for (const [sessionId, live] of liveBySession) {
          if (live === streamId) liveBySession.delete(sessionId);
        }
      },
      getStreamIdForSession: (sessionId) => liveBySession.get(sessionId) || null,
    },
  });
  t.after(() => runtime.disposeRenderQueue());
  return { runtime, state, clearedStreams };
}

test('a resumed continuation terminal releases the paused stream for the same turn', (t) => {
  const harness = createHarness(t, {
    pendingStreams: new Map([
      ['stream-a', 'message-a'],
      ['stream-b', 'message-b'],
      ['stream-c', 'message-c'],
      ['stream-d', 'message-d'],
    ]),
    pendingToolApprovals: new Map([
      ['approval-a', { sessionId: 'session-s', streamId: 'stream-a' }],
      ['approval-c', { sessionId: 'session-s', streamId: 'stream-c' }],
    ]),
    messagesBySession: new Map([
      ['session-s', [
        { id: 'message-a', turn_id: 'turn-t' },
        { id: 'message-b', turn_id: 'turn-t' },
        { id: 'message-c', turn_id: 'turn-u' },
      ]],
      ['session-s2', [{ id: 'message-d', turn_id: 'turn-t' }]],
    ]),
    liveStreams: { 'session-s': 'stream-b' },
  });

  harness.runtime.finalizeTerminalStream(
    new Set(),
    new Map(),
    new Map(),
    { sessionId: 'session-s', streamId: 'stream-b', turnId: 'turn-t' }
  );

  assert.deepEqual([...harness.state.pendingStreams.keys()], ['stream-c', 'stream-d']);
  assert.deepEqual(harness.clearedStreams, ['stream-b', 'stream-a']);
  assert.equal(harness.state.pendingToolApprovals.has('approval-a'), false);
  assert.equal(harness.state.pendingToolApprovals.has('approval-c'), true);
});

test('a terminal without a turn id releases only its own stream', (t) => {
  const harness = createHarness(t, {
    pendingStreams: new Map([
      ['stream-a', 'message-a'],
      ['stream-b', 'message-b'],
      ['stream-c', 'message-c'],
      ['stream-d', 'message-d'],
    ]),
    pendingToolApprovals: new Map(),
    messagesBySession: new Map([
      ['session-s', [
        { id: 'message-a', turn_id: 'turn-t' },
        { id: 'message-b', turn_id: 'turn-t' },
        { id: 'message-c', turn_id: 'turn-u' },
      ]],
      ['session-s2', [{ id: 'message-d', turn_id: 'turn-t' }]],
    ]),
  });

  harness.runtime.finalizeTerminalStream(
    new Set(),
    new Map(),
    new Map(),
    { sessionId: 'session-s', streamId: 'stream-b' }
  );

  assert.deepEqual([...harness.state.pendingStreams.keys()], ['stream-a', 'stream-c', 'stream-d']);
  assert.deepEqual(harness.clearedStreams, ['stream-b']);
});

test('a pending stream with no message in the terminal session is left alone', (t) => {
  const harness = createHarness(t, {
    pendingStreams: new Map([
      ['stream-a', 'missing-message'],
      ['stream-b', 'message-b'],
    ]),
    pendingToolApprovals: new Map(),
    messagesBySession: new Map([
      ['session-s', [{ id: 'message-b', turn_id: 'turn-t' }]],
    ]),
  });

  harness.runtime.finalizeTerminalStream(
    new Set(),
    new Map(),
    new Map(),
    { sessionId: 'session-s', streamId: 'stream-b', turn_id: 'turn-t' }
  );

  assert.deepEqual([...harness.state.pendingStreams.keys()], ['stream-a']);
  assert.deepEqual(harness.clearedStreams, ['stream-b']);
});

test('a late terminal from an older attempt leaves the newer live attempt alone', (t) => {
  const harness = createHarness(t, {
    pendingStreams: new Map([
      ['stream-attempt-1', 'message-1'],
      ['stream-attempt-2', 'message-2'],
    ]),
    pendingToolApprovals: new Map(),
    messagesBySession: new Map([
      ['session-s', [
        { id: 'message-1', turn_id: 'turn-t' },
        { id: 'message-2', turn_id: 'turn-t' },
      ]],
    ]),
    liveStreams: { 'session-s': 'stream-attempt-2' },
  });

  harness.runtime.finalizeTerminalStream(
    new Set(),
    new Map(),
    new Map(),
    { sessionId: 'session-s', streamId: 'stream-attempt-1', turnId: 'turn-t' }
  );

  assert.deepEqual([...harness.state.pendingStreams.keys()], ['stream-attempt-2']);
  assert.deepEqual(harness.clearedStreams, ['stream-attempt-1']);
});
