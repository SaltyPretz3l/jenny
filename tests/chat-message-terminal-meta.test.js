'use strict';

// Sibling of tests/chat-message-utils.test.js (kept under the 600-line
// test-file ratchet): per-turn meta-label provenance + terminal-status
// preservation, from the 2026-07-20 GUI-pass findings remediation.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeChatMessage,
  buildAssistantMetaLabel,
} = require('../renderer/chat/chat-message-utils');

test('buildAssistantMetaLabel appends per-turn model provenance (GUI finding 2026-07-20)', () => {
  const formatTime = (value) => `@ ${value}`;
  const modelMessage = normalizeChatMessage({
    id: 'assistant_model_1',
    role: 'assistant',
    content: 'done',
    timestamp: '2026-07-20T10:00:00.000Z',
    model_used: 'ornith:9b-48k',
  });
  assert.equal(
    buildAssistantMetaLabel(modelMessage, formatTime),
    'Completed @ 2026-07-20T10:00:00.000Z · ornith:9b-48k'
  );
});

test('buildAssistantMetaLabel reads Stopped, not Failed, for cancelled turns', () => {
  const formatTime = (value) => `@ ${value}`;
  const stoppedMessage = normalizeChatMessage({
    id: 'assistant_stop_1',
    role: 'assistant',
    content: 'partial answer',
    timestamp: '2026-07-20T10:01:00.000Z',
    status: 'cancelled',
    finalizedAt: '2026-07-20T10:01:05.000Z',
  });
  assert.equal(
    buildAssistantMetaLabel(stoppedMessage, formatTime),
    'Stopped @ 2026-07-20T10:01:05.000Z'
  );
});

test('normalizeChatMessage preserves an explicit terminal_status through re-normalization', () => {
  // setSessionMessages re-normalizes every write;
  // deriving terminal_status from the already-coarsened status erased live
  // cancellations, so the turn read "Failed" until hydration replaced it.
  const live = normalizeChatMessage({
    id: 'assistant_live_cancel',
    role: 'assistant',
    content: 'partial',
    timestamp: '2026-07-20T11:00:00.000Z',
    status: 'error',
    terminal_status: 'cancelled',
    finalizedAt: '2026-07-20T11:00:05.000Z',
  });
  assert.equal(live.terminal_status, 'cancelled');
  assert.equal(
    buildAssistantMetaLabel(live, (value) => `@ ${value}`),
    'Stopped @ 2026-07-20T11:00:05.000Z'
  );
});
