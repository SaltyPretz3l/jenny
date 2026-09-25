'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startManagedSidecarChatStream } = require('../../services/backend/managed-sidecar-chat');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { createManagedChatServiceStub, buildManagedChatRequest } = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test('managed Send keeps scheduler logical turn separate from stream even with durable dispatch OFF', async () => {
  const service = createManagedChatServiceStub();
  service.featureFlags.session_runtime = false;
  const request = buildManagedChatRequest();
  service.sessionStore.createSessionWithId(request.sessionId, { title: 'Logical identity' });
  const lease = ensureSessionTurnActorRegistry(service).reserveStart({
    sessionId: request.sessionId, store: service.sessionStore, activeStreams: service.activeStreams,
    logicalTurnId: 'turn_durable_1', prompt: request.prompt, path: 'managed',
  });
  let sent;
  service.sidecarManager = { process: { pid: 4242 }, getStatus: () => ({ phase: 'ready' }) };
  service.sidecarClient = { connected: true, async chatSend(params, options) {
    sent = params;
    options.onNotification({ method: 'chat.token', params: { delta: 'Done.' } });
    options.onNotification({ method: 'chat.done', params: {} });
    return { status: 'completed' };
  } };
  const stream = await startManagedSidecarChatStream(service, { ...request, turnLease: lease });
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;
  assert.ok(sent, 'provider received the admitted request');
  assert.equal(sent.logical_turn_id, 'turn_durable_1');
  assert.equal(sent.request_id, stream.streamId);
  assert.notEqual(sent.logical_turn_id, sent.request_id);
  assert.equal(Object.hasOwn(sent, 'continuation_context'), false);
  assert.ok(sent.execution_context.authority_revision, 'OFF retains scoped authority');
});
