'use strict';

// Row 66 W2: the session record's stored calibration (the last terminal turn's
// provider-vs-estimate pair) rides the next chat.send as `context_calibration`,
// so the sidecar can count the history in the provider's units. A missing or
// invalid record sends nothing and never blocks the turn.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const CALIBRATION = Object.freeze({
  provider_tokens: 150000,
  estimate_tokens: 110000,
  engine: 'ninfer',
  model: 'qwen3.8',
  estimator: 'CharEstimationBackend',
});

function contextUsage(calibration) {
  return {
    version: 1,
    used_tokens: 150000,
    context_window: 262144,
    compact_threshold_tokens: 218000,
    model: 'qwen3.8',
    usage_source: 'provider',
    updated_at: '2026-10-20T12:00:00.000Z',
    ...(calibration === undefined ? {} : { calibration }),
  };
}

async function captureChatSendParams(service, usage) {
  const getSession = service.sessionStore.getSession.bind(service.sessionStore);
  service.sessionStore.getSession = (sessionId) => {
    const session = getSession(sessionId);
    return session && usage ? { ...session, context_usage: usage } : session;
  };
  let captured = null;
  service.sidecarClient = {
    async chatSend(params, options = {}) {
      captured = params;
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest());
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  assert.ok(captured, 'chat.send must have been called');
  return captured;
}

test('chat.send carries the stored calibration from the session record', async () => {
  const params = await captureChatSendParams(createManagedChatServiceStub(), contextUsage(CALIBRATION));
  assert.deepEqual(params.context_calibration, CALIBRATION);
});

test('chat.send omits the calibration when the record has none or an invalid one', async () => {
  for (const usage of [
    null,
    contextUsage(),
    contextUsage({ ...CALIBRATION, provider_tokens: -1 }),
    contextUsage({ ...CALIBRATION, model: '' }),
    contextUsage('not-an-object'),
  ]) {
    const params = await captureChatSendParams(createManagedChatServiceStub(), usage);
    assert.equal(Object.hasOwn(params, 'context_calibration'), false);
  }
});
