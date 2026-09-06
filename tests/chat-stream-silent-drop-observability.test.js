'use strict';

// W3.8 silent-drop observability: previously-invisible drop points now log
// and count — unmatched sidecar responses/notifications, unknown managed
// notification methods, and renderer dispatch handler exceptions on
// terminal events.

const test = require('node:test');
const assert = require('node:assert/strict');

const { SidecarClient } = require('../services/backend/sidecar-client');
const { handleNotification } = require('../services/backend/chat-stream-managed-runtime-notifications');
const { createStreamDispatchRouter } = require('../renderer/chat/renderer-stream-handler-dispatch');

function createLoggingClient() {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, details) {
      logs.push({ level, event, details });
    },
  });
  return { client, logs };
}

test('sidecar client logs a WARN for a response no request is waiting for', () => {
  const { client, logs } = createLoggingClient();

  client._handleMessage({ id: 42, result: {} });
  client._handleMessage({ id: 43, error: { message: 'late failure' } });

  const unmatched = logs.filter((entry) => entry.event === 'sidecar.unmatched_response');
  assert.equal(unmatched.length, 2);
  assert.equal(unmatched[0].level, 'WARN');
  assert.deepEqual(unmatched[0].details, { incoming_id: 42, has_error: false });
  assert.deepEqual(unmatched[1].details, { incoming_id: 43, has_error: true });
});

test('sidecar client warns once per request_id for unmatched notifications and keeps counting', () => {
  const { client, logs } = createLoggingClient();

  client._handleMessage({ method: 'chat.token', params: { request_id: 'req_dead', delta: 'a' } });
  client._handleMessage({ method: 'chat.token', params: { request_id: 'req_dead', delta: 'b' } });
  client._handleMessage({ method: 'chat.thinking', params: { request_id: 'req_other' } });

  const unmatched = logs.filter((entry) => entry.event === 'sidecar.unmatched_notification');
  assert.equal(unmatched.length, 2);
  assert.equal(unmatched[0].level, 'WARN');
  assert.deepEqual(unmatched[0].details, { request_id: 'req_dead', incoming_method: 'chat.token' });
  assert.deepEqual(unmatched[1].details, { request_id: 'req_other', incoming_method: 'chat.thinking' });
  assert.equal(client.unmatchedNotificationCounts.get('req_dead'), 2);
  assert.equal(client.unmatchedNotificationCounts.get('req_other'), 1);

  client.dispose();
  assert.equal(client.unmatchedNotificationCounts.size, 0);
});

test('sidecar client bounds unmatched request ids and removes a matching finalized key', () => {
  const client = new SidecarClient();
  for (let index = 0; index <= 1000; index += 1) {
    client._handleMessage({ method: 'chat.token', params: { request_id: `req_${index}` } });
  }
  assert.equal(client.unmatchedNotificationCounts.size, 1000);
  assert.equal(client.unmatchedNotificationCounts.has('req_0'), false);
  assert.equal(client.unmatchedNotificationCounts.get('req_1000'), 1);

  client.pendingRequests.set(7, {
    requestKey: 'req_1000', resolve() {}, reject() {},
  });
  assert.equal(client._finalizePendingRequest(7, { type: 'resolve', value: {} }), true);
  assert.equal(client.unmatchedNotificationCounts.has('req_1000'), false);
});

test('sidecar client does not flag notifications that reach a registered handler', () => {
  const { client, logs } = createLoggingClient();
  const seen = [];
  client.notificationHandlers.set('req_live', (message) => {
    seen.push(message.method);
  });

  client._handleMessage({ method: 'chat.token', params: { request_id: 'req_live', delta: 'a' } });

  assert.deepEqual(seen, ['chat.token']);
  assert.equal(logs.filter((entry) => entry.event === 'sidecar.unmatched_notification').length, 0);
  assert.equal(client.unmatchedNotificationCounts.size, 0);
});

function createNotificationCtx(serviceLogs) {
  return {
    service: {
      _emitServiceLog(level, event, details) {
        serviceLogs.push({ level, event, details });
      },
      emit() {},
    },
    streamId: 'stream_1',
    resolvedSessionId: 'sess_1',
    model: 'mock:model',
    eventBase: { sessionId: 'sess_1', streamId: 'stream_1' },
    emitChatStream() {},
  };
}

test('managed notification router warns once per unknown method and counts repeats', () => {
  const serviceLogs = [];
  const ctx = createNotificationCtx(serviceLogs);
  const dispatchOptions = { toolContext: null, handleToolNotification: () => false };

  handleNotification(ctx, { method: 'chat.surprise', params: {} }, dispatchOptions);
  handleNotification(ctx, { method: 'chat.surprise', params: {} }, dispatchOptions);
  handleNotification(ctx, { method: 'runtime.mystery', params: {} }, dispatchOptions);

  const unknown = serviceLogs.filter((entry) => entry.event === 'chat.unknown_notification_method');
  assert.equal(unknown.length, 2);
  assert.equal(unknown[0].level, 'WARN');
  assert.equal(unknown[0].details.method, 'chat.surprise');
  assert.equal(unknown[1].details.method, 'runtime.mystery');
  assert.equal(ctx.unknownNotificationMethodCounts.get('chat.surprise'), 2);
  assert.equal(ctx.unknownNotificationMethodCounts.get('runtime.mystery'), 1);
});

test('managed notification router does not flag known methods', () => {
  const serviceLogs = [];
  const ctx = createNotificationCtx(serviceLogs);

  handleNotification(
    ctx,
    { method: 'context.compacted', params: { strategy: 'micro', tokens_before: 10, tokens_after: 5 } },
    { toolContext: null, handleToolNotification: () => false }
  );

  assert.equal(serviceLogs.filter((entry) => entry.event === 'chat.unknown_notification_method').length, 0);
  assert.equal(ctx.unknownNotificationMethodCounts, undefined);
});

function createDispatchHarness(handlers) {
  const logs = [];
  const router = createStreamDispatchRouter({
    state: { bufferedStreamEventsByStream: new Map() },
    normalizeId: (value) => String(value || '').trim(),
    normalizeString: (value) => String(value || '').trim(),
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
    handlers,
    shouldBufferStreamEvent: () => false,
    bufferStreamEvent() {},
    isRenderableBufferedStreamEvent: (payload) => payload.type === 'delta',
    waitForRenderFrame: async () => {},
  });
  return { router, logs };
}

test('dispatch reports terminal:true when a terminal handler throws', async () => {
  const { router, logs } = createDispatchHarness({
    async handleComplete() {
      throw new Error('settle exploded');
    },
    async handleError() {
      throw new Error('error handler exploded');
    },
  });

  const completeResult = await router.handleStreamPayload({
    type: 'complete', sessionId: 'sess_1', streamId: 'stream_1', content: 'hi',
  });
  assert.deepEqual(completeResult, { buffered: false, terminal: true, handlerError: true });

  const errorResult = await router.handleStreamPayload({
    type: 'error', sessionId: 'sess_1', streamId: 'stream_1', message: 'boom',
  });
  assert.deepEqual(errorResult, { buffered: false, terminal: true, handlerError: true });

  const exceptions = logs.filter((entry) => entry.event === 'stream.handler_exception');
  assert.equal(exceptions.length, 2);
  assert.equal(exceptions[0].level, 'ERROR');
  assert.equal(exceptions[0].details.terminalType, true);
  assert.equal(exceptions[0].details.message, 'settle exploded');
});

test('dispatch keeps terminal:false when a non-terminal handler throws', async () => {
  const { router, logs } = createDispatchHarness({
    async handleDelta() {
      throw new Error('delta exploded');
    },
  });

  const result = await router.handleStreamPayload({
    type: 'delta', sessionId: 'sess_1', streamId: 'stream_1', content: 'x',
  });

  assert.deepEqual(result, { buffered: false, terminal: false, handlerError: true });
  const exceptions = logs.filter((entry) => entry.event === 'stream.handler_exception');
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].details.terminalType, false);
});
