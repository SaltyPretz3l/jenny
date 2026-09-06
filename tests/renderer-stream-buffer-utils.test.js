const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendSemanticStreamEvent,
  createDegradedStreamRecovery,
  streamEventByteSize,
  utf8ByteLength,
} = require('../renderer/chat/renderer-stream-buffer-utils');

test('UTF-8 accounting counts multibyte payloads by wire bytes', () => {
  assert.equal(utf8ByteLength('🙂'), 4);
  assert.ok(streamEventByteSize({ content: '🙂' }) > JSON.stringify({ content: '🙂' }).length);
});

test('status coalescing never moves a post-reset update before its reset', () => {
  const events = [];
  appendSemanticStreamEvent(events, { type: 'thinking_status', thinkingId: 't1', summary: 'before' }, 1);
  appendSemanticStreamEvent(events, { type: 'stream_reset', reason: 'tool_continuation' }, 2);
  appendSemanticStreamEvent(events, { type: 'thinking_status', thinkingId: 't1', summary: 'after' }, 3);

  assert.deepEqual(events.map(({ type, summary, reason }) => ({ type, summary, reason })), [
    { type: 'thinking_status', summary: 'before', reason: undefined },
    { type: 'stream_reset', summary: undefined, reason: 'tool_continuation' },
    { type: 'thinking_status', summary: 'after', reason: undefined },
  ]);
});

test('degraded recovery hydrates canonical rows and leaves a visible notice', async () => {
  const mutations = [];
  const recover = createDegradedStreamRecovery({
    getPersistedSession: async () => ({
      data: [{ id: 'm1', content: 'canonical' }],
      turn_event_log_version: 3,
      turn_events: [{ kind: 'chat_token' }],
      active_turn: null,
    }),
    setSessionMessages: (...args) => mutations.push(['messages', ...args]),
    setSessionTurnEventState: (...args) => mutations.push(['events', ...args]),
    setSessionComposerNotice: (...args) => mutations.push(['notice', ...args]),
    queueSessionRender: (...args) => mutations.push(['render', ...args]),
    appendClientLog: () => {},
  });
  const result = await recover({ streamId: 's1', sessionId: 'session_1', reason: 'event_cap' });
  assert.equal(result.degraded, true);
  assert.equal(result.hydrated, true);
  assert.equal(mutations.some(([kind, , value]) => kind === 'messages' && value[0].content === 'canonical'), true);
  assert.equal(mutations.some(([kind, , message]) => kind === 'notice' && /resynced/i.test(message)), true);
});
