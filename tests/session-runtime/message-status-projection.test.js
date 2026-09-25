'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getSessionMessages } = require('../../services/backend/backend-sessions');
const { buildMessageRenderSignature } = require('../../renderer/chat/renderer-message-index-utils');

test('runtime status changes invalidate history rendering without changing text', () => {
  const message = { id: 'assistant', role: 'assistant', status: 'complete', content: '', runtime_status: 'paused' };
  const before = buildMessageRenderSignature([message]);
  message.runtime_status = 'completed';
  assert.notEqual(buildMessageRenderSignature([message]), before);
});

test('history overlays paged session-scoped runtime state without mutating saved messages', async () => {
  const messages = [{ id: 'one', turn_id: 'turn_one', role: 'assistant' },
    { id: 'two', turn_id: 'turn_two', role: 'assistant' }];
  const requests = [];
  const service = {
    sessionStore: { getSession: () => ({ messages, turn_events: [] }) },
    sessionRuntime: { store: { listSummaries(args) {
      requests.push(args);
      return args.cursor ? { items: [{ session_id: 'session', turn_id: 'turn_two', status: 'cancelled' }], next_cursor: null }
        : { items: [{ session_id: 'session', turn_id: 'turn_one', status: 'paused' },
          { session_id: 'foreign', turn_id: 'turn_two', status: 'completed' }], next_cursor: 'page_two' };
    } } },
  };
  const result = await getSessionMessages(service, 'session');
  assert.deepEqual(result.data.map(row => row.runtime_status), ['paused', 'cancelled']);
  assert.ok(requests.every(row => row.sessionId === 'session' && row.limit === 100));
  assert.equal(requests.length, 2);
  assert.ok(messages.every(row => !Object.hasOwn(row, 'runtime_status')));
  delete service.sessionRuntime;
  assert.deepEqual((await getSessionMessages(service, 'session')).data, messages);
});

async function projectRuntimeStatus(status, activeTurn) {
  const service = {
    sessionStore: {
      getSession: () => ({
        messages: [{ id: 'assistant', turn_id: 'turn_one', role: 'assistant' }],
        turn_events: [],
        active_turn: activeTurn,
      }),
    },
    sessionRuntime: {
      store: {
        listSummaries: () => ({
          items: [{ session_id: 'session', turn_id: 'turn_one', status }],
          next_cursor: null,
        }),
      },
    },
  };
  return (await getSessionMessages(service, 'session')).data[0].runtime_status;
}

test('history drops running status after its active turn is cleared', async () => {
  assert.equal(await projectRuntimeStatus('running', null), undefined);
});

test('history keeps running status for the matching active turn', async () => {
  assert.equal(await projectRuntimeStatus('running', { turn_id: 'turn_one' }), 'running');
  // An active turn without identity is not proof the work is stale.
  assert.equal(await projectRuntimeStatus('running', { request_id: 'request_one' }), 'running');
});

test('history drops running status when a different turn is active', async () => {
  assert.equal(await projectRuntimeStatus('running', { turn_id: 'turn_two' }), undefined);
});

test('history keeps paused and pending statuses without an active turn', async () => {
  assert.equal(await projectRuntimeStatus('paused', null), 'paused');
  assert.equal(await projectRuntimeStatus('pending', null), 'pending');
});
