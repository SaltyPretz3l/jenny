'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startManagedSidecarChatStream } = require('../../services/backend/managed-sidecar-chat');
const { buildManagedChatRequest, createManagedChatServiceStub } = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test('first managed send waits for full provider refresh to publish runtime protocol', async () => {
  const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } =
    require('../../services/session-runtime/inference-protocol');
  const service = createManagedChatServiceStub();
  const process = { pid: 4242 };
  service.sidecarManager = { process, getStatus: () => ({ phase: 'ready' }) };
  let sends = 0;
  service.sidecarClient = { process, connected: true, async chatSend(_params, options) {
    sends += 1;
    options.onNotification({ method: 'chat.token', params: { delta: 'Ready after refresh.' } });
    options.onNotification({ method: 'chat.done', params: {} });
    return { status: 'completed' };
  } };
  const token = beginRuntimeInferenceInitialization(service.sidecarClient);
  let finish;
  service._managedInitializeFlight = { process, promise: new Promise(resolve => { finish = resolve; }) };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    runtimeOperationGateway: { handle() {}, snapshot: () => ({ active: 0, quarantined: 0 }) },
  }));
  const controller = service.activeStreams.get(stream.streamId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 0);
  completeRuntimeInferenceInitialization(service.sidecarClient, token, {
    runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1,
  });
  service._managedInitializeFlight = null;
  finish();
  await controller._pendingPromise;
  assert.equal(sends, 1, JSON.stringify(service.serviceLogs));
  assert.equal(service.emittedEvents.some(entry => entry.payload?.type === 'complete'), true);
});
