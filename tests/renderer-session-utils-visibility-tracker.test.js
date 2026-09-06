'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionManager } = require('../renderer/shell/renderer-session-utils');
const { getTimelineVisibilityTracker } = require('../renderer/chat/renderer-timeline-visibility-utils');

function createState() {
  return {
    sessions: [{ id: 'session-local', title: 'Local' }],
    messagesBySession: new Map([['session-local', []]]),
    sessionMessageAccessOrder: new Map(),
    interactiveDraftsBySession: new Map(),
    queuedSendBySession: new Map(),
    sendOutboxBySession: new Map(),
    pendingToolApprovals: new Map(),
    pendingStreams: new Map(),
    streamThinkingStatusByStream: new Map(),
    toolCallsByStream: new Map(),
    ui: {},
  };
}

function createManager(state) {
  return createSessionManager({
    state,
    constants: {
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      MAX_INTERACTIVE_ROUNDS: 4,
      MAX_INTERACTIVE_QUESTIONS: 4,
    },
    callbacks: {},
  });
}

test('removeSessionState clears the timeline-visibility tracker entry (hyg-W4-18-F02)', () => {
  const state = createState();
  const tracker = getTimelineVisibilityTracker(state);
  tracker.markRenderableEvent('session-local', { turnId: 'turn-1' });
  assert.notEqual(tracker.peek('session-local'), null);

  createManager(state).removeSessionState('session-local');

  assert.equal(
    tracker.peek('session-local'),
    null,
    'deleting a session must drop its visibility snapshot'
  );
});

test('rekeySessionState carries the timeline-visibility entry to the persisted id (hyg-W4-18-F02)', () => {
  const state = createState();
  const tracker = getTimelineVisibilityTracker(state);
  tracker.markRenderableEvent('session-local', { turnId: 'turn-1' });

  createManager(state).rekeySessionState('session-local', 'session-server');

  assert.equal(tracker.peek('session-local'), null, 'the temporary id entry is gone');
  assert.notEqual(
    tracker.peek('session-server'),
    null,
    'the persisted id owns the carried visibility snapshot'
  );
});
