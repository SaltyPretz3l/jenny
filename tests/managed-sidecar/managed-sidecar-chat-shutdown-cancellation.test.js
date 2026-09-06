'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  createCancellationError,
} = require('../../services/backend/chat-stream-terminal-utils');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test('shutdown cancellation after visible completion is informational, not a late failure', async () => {
  const service = createManagedChatServiceStub();
  let rejectChatSend;
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  const originalEmit = service.emit.bind(service);
  service.emit = (eventName, payload) => {
    originalEmit(eventName, payload);
    if (eventName === 'chat-stream' && payload?.type === 'complete') complete();
  };
  service.sidecarClient = {
    chatSend: async (_params, options) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'Done.' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return new Promise((_resolve, reject) => { rejectChatSend = reject; });
    },
  };

  const stream = await startManagedSidecarChatStream(
    service,
    buildManagedChatRequest({ sessionId: 'session_shutdown_cancel' })
  );
  const controller = service.activeStreams.get(stream.streamId);
  await completed;
  controller.abort(createCancellationError('service_stop'));
  rejectChatSend(new Error('sidecar disposed during shutdown'));
  await controller._pendingPromise;

  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.stream_late_settlement_failed'),
    false
  );
  const cancellation = service.serviceLogs.find(
    (entry) => entry.event === 'chat.stream_late_settlement_cancelled'
  );
  assert.equal(cancellation?.level, 'INFO');
  assert.equal(cancellation?.details?.cancelReason, 'service_stop');
});
