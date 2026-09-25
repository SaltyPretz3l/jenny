'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { activateRuntimeCanonicalStream } = require('../../services/backend/runtime-canonical-activation');
const { createManagedContinuationSend } = require('../../services/backend/managed-sidecar-continuation');
const protocol = require('../../services/session-runtime/inference-protocol');
const { handleNotification } = require('../../services/backend/chat-stream-managed-runtime-notifications');
const { makeCtx, canonicalEvent, callsOf, makeHandleToolNotification } = require('../helpers/managed-runtime-notification-harness');

test('request canonical activation requires current acknowledgement before changing either consumer', () => {
  for (const acknowledged of [false, true]) {
    const client = { process: {} };
    protocol.completeRuntimeInferenceInitialization(client, protocol.beginRuntimeInferenceInitialization(client), {
      runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1,
      ...(acknowledged ? { runtime_continuation_version: 1 } : {}) });
    const ctx = { turnEventCollector: { canonicalPrimary: false, capturedEvents: [] }, canonicalBridgeEnabled: false };
    const args = { service: { sidecarClient: client }, runtimeContinuation: { context: {} },
      gateway: { enableContinuation: () => true }, collector: ctx.turnEventCollector,
      activateCanonical: () => activateRuntimeCanonicalStream(ctx) };
    assert.equal(Boolean(createManagedContinuationSend(args)), acknowledged);
    assert.equal(ctx.canonicalBridgeEnabled, acknowledged);
    assert.equal(ctx.turnEventCollector.canonicalPrimary, acknowledged);
    client.process = {};
    assert.throws(() => createManagedContinuationSend({ ...args, runtimeContinuation: { resumeHydration: {} } }), /Invalid JSON-RPC/);
  }
});

test('canonical mode cannot change after streamed content or tool effects', () => {
  for (const patch of [{ streamSawText: true }, { streamSawBatch: true }, { streamSawDone: true },
    { latestToolContext: {} }, { turnEventCollector: { canonicalPrimary: false, capturedEvents: [{}] } }]) {
    const ctx = { canonicalBridgeEnabled: false, turnEventCollector: { canonicalPrimary: false, capturedEvents: [] }, ...patch };
    assert.throws(() => activateRuntimeCanonicalStream(ctx), /activation_too_late/);
    assert.equal(ctx.canonicalBridgeEnabled, false);
    assert.equal(ctx.turnEventCollector.canonicalPrimary, false);
  }
});

test('unnegotiated additive events stay out of legacy capture while global shadow capture remains available', () => {
  for (const [shadow, activated] of [[false, false], [true, false], [false, true]]) {
    const ctx = makeCtx({ canonicalBridgeEnabled: activated });
    ctx.service.featureFlags.canonical_turn_events = shadow;
    handleNotification(ctx, { method: 'turn.event', params: canonicalEvent('text_delta', { delta: 'Canonical' }) },
      { handleToolNotification: makeHandleToolNotification(ctx) });
    assert.equal(callsOf(ctx, 'noteEvent').length, shadow || activated ? 1 : 0);
    assert.equal(ctx.assistantText, activated ? 'Canonical' : '');
  }
});


test('a prepared continuation rechecks the paired protocol after process replacement', () => {
  const client = { process: {} };
  const initialize = continuation => protocol.completeRuntimeInferenceInitialization(client,
    protocol.beginRuntimeInferenceInitialization(client), { runtime_inference_admission_version: 1,
      runtime_tool_resource_admission_version: 1, ...(continuation ? { runtime_continuation_version: 1 } : {}) });
  initialize(true);
  const send = createManagedContinuationSend({ service: { sidecarClient: client },
    runtimeContinuation: { context: {} }, gateway: { enableContinuation: () => true },
    collector: { canonicalPrimary: true } });
  assert.equal(send.assertProtocol(), true);
  client.process = {};
  initialize(false);
  assert.equal(protocol.assertRuntimeOperationsProtocol(client), true);
  assert.throws(() => send.assertProtocol(), { code: 'CMP-RUNTIME-0002', reason: 'runtime_continuation_protocol_required' });
});
