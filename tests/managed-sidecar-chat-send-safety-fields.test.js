'use strict';

// Owner decision D3: safety mode and the auto-approve streak cap ride every
// chat.send (snake_case, additive), read from the live chatUi state at send
// time, so a Settings change applies from the next turn without a sidecar
// config refresh. When the state is unavailable the fields are omitted.

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

async function captureChatSendParams(service) {
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

test('chat.send carries safety mode and streak cap from the current chatUi state', async () => {
  const service = createManagedChatServiceStub();
  let chatUi = { safetyMode: 'paranoid', autoApproveStreakCap: 3 };
  service.configService.getChatUiState = () => ({ ...chatUi });

  const first = await captureChatSendParams(service);
  assert.equal(first.safety_mode, 'paranoid');
  assert.equal(first.auto_approve_streak_cap, 3);

  chatUi = { safetyMode: 'normal', autoApproveStreakCap: 0 };
  const second = await captureChatSendParams(service);
  assert.equal(second.safety_mode, 'normal');
  assert.equal(second.auto_approve_streak_cap, 0);
});

test('chat.send omits the safety fields when the chatUi state is unavailable', async () => {
  const service = createManagedChatServiceStub();
  assert.equal(typeof service.configService.getChatUiState, 'undefined');

  const params = await captureChatSendParams(service);
  assert.equal(Object.hasOwn(params, 'safety_mode'), false);
  assert.equal(Object.hasOwn(params, 'auto_approve_streak_cap'), false);

  service.configService.getChatUiState = () => null;
  const nullState = await captureChatSendParams(service);
  assert.equal(Object.hasOwn(nullState, 'safety_mode'), false);
  assert.equal(Object.hasOwn(nullState, 'auto_approve_streak_cap'), false);
});

test('a request carrying the policy captured with its turn wins over the live chatUi state', async () => {
  const service = createManagedChatServiceStub();
  service.configService.getChatUiState = () => ({ safetyMode: 'normal', autoApproveStreakCap: 0 });
  let captured = null;
  service.sidecarClient = {
    async chatSend(params, options = {}) {
      captured = params;
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };
  // A checkpoint resume re-enters the sender with the turn's durable request.
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    safetyPolicy: { safety_mode: 'paranoid', auto_approve_streak_cap: 3 },
  }));
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  assert.equal(captured.safety_mode, 'paranoid');
  assert.equal(captured.auto_approve_streak_cap, 3);
});
