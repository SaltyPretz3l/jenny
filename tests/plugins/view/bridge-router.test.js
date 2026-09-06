'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PluginViewBridgeRouter } = require('../../../services/plugins/view/bridge-router');
const { VIEW_LIMITS } = require('../../../services/plugins/view/stage7-budgets');

const DIGEST = 'a'.repeat(64);
const event = { sender: { id: 7 }, senderFrame: { origin: `jenny-plugin-view://${DIGEST}` } };
const context = {
  senderId: 7, origin: event.senderFrame.origin, viewInstanceId: 'view_1', contributionId: 'panel',
  artifactDigest: DIGEST, commitEpoch: 3, lifecycleEpoch: 2,
  allowedOperations: ['get_context'], allowedEventTopics: ['context_changed'],
};

function envelope(method, payload, overrides = {}) {
  return {
    bridge_schema_version: 1, view_instance_id: 'view_1', contribution_id: 'panel',
    artifact_digest: DIGEST, commit_epoch: 3, lifecycle_epoch: 2, method,
    payload_json: JSON.stringify(payload), limits: VIEW_LIMITS, ...overrides,
  };
}

test('the router validates sender authority and returns only bounded stable results', async () => {
  const router = new PluginViewBridgeRouter({
    resolveContext: () => context,
    handlers: { get_context: async () => ({ ok: true, value: { safe: true } }) },
  });
  const call = { call_schema_version: 5, request_id: 'request_1', operation: 'get_context', payload_json: '{}' };
  const result = await router.route(event, envelope('request', call));
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(JSON.parse(result.payload_json), { safe: true });

  const rejected = await router.route({ sender: { id: 8 }, senderFrame: event.senderFrame }, envelope('request', call));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason_code, 'bridge_sender_rejected');
});

test('subscriptions are allowlisted, detached on teardown, and publish sequenced events', async () => {
  const delivered = [];
  const router = new PluginViewBridgeRouter({ resolveContext: () => context });
  const subscribed = await router.route(event, envelope('subscribe', { request_id: 'subscribe_1', topic: 'context_changed' }));
  assert.equal(subscribed.status, 'succeeded');
  assert.equal(router.publish('view_1', 'context_changed', { n: 1 }, (value) => delivered.push(value)), true);
  assert.equal(delivered[0].sequence, 1);
  router.detach('view_1');
  assert.equal(router.publish('view_1', 'context_changed', {}, () => {}), false);
});

test('handler failures and oversized responses are redacted', async () => {
  const call = { call_schema_version: 5, request_id: 'request_2', operation: 'get_context', payload_json: '{}' };
  const throwing = new PluginViewBridgeRouter({ resolveContext: () => context,
    handlers: { get_context: async () => { throw new Error('secret token'); } } });
  const failed = await throwing.route(event, envelope('request', call));
  assert.equal(failed.reason_code, 'bridge_operation_failed');
  assert.doesNotMatch(JSON.stringify(failed), /secret token/);

  const oversized = new PluginViewBridgeRouter({ resolveContext: () => context,
    handlers: { get_context: async () => ({ value: 'x'.repeat(70 * 1024) }) } });
  const capped = await oversized.route(event, envelope('request', call));
  assert.equal(capped.reason_code, 'bridge_response_too_large');
});

test('authorized session-provider calls use the additive frozen contract', async () => {
  const calls = [];
  const router = new PluginViewBridgeRouter({
    resolveContext: () => ({ ...context, sessionProviderAuthorized: true }),
    sessionProviderHandler: async (call, bound) => {
      calls.push([call.action, bound.viewInstanceId]);
      return { ok: true, value: { accepted: true } };
    },
  });
  const call = { call_schema_version: 1, request_id: 'provider_request_1',
    action: 'get_context', payload_json: '{}' };
  const result = await router.route(event, envelope('request', call));
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(JSON.parse(result.payload_json), { accepted: true });
  assert.deepEqual(calls, [['get_context', 'view_1']]);

  const unauthorized = new PluginViewBridgeRouter({
    resolveContext: () => context,
    sessionProviderHandler: async () => ({ ok: true }),
  });
  const rejected = await unauthorized.route(event, envelope('request', call));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason_code, 'session_provider_call_not_allowed');

  const malformed = await router.route(event, envelope('request', { ...call, action: 'unknown' }));
  assert.equal(malformed.status, 'rejected');
  assert.equal(malformed.reason_code, 'session_provider_call_not_allowed');
});

test('session-provider routing honors bridge cancellation and response bounds', async () => {
  let release;
  const router = new PluginViewBridgeRouter({
    resolveContext: () => ({ ...context, sessionProviderAuthorized: true }),
    sessionProviderHandler: () => new Promise((resolve) => { release = resolve; }),
  });
  const call = { call_schema_version: 1, request_id: 'provider_request_2',
    action: 'get_context', payload_json: '{}' };
  const pending = router.route(event, envelope('request', call));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await router.route(event, envelope('cancel', { request_id: call.request_id }));
  assert.equal(cancelled.status, 'cancelled');
  release({ ok: true, value: { late: true } });
  assert.equal((await pending).status, 'cancelled');

  const oversized = new PluginViewBridgeRouter({
    resolveContext: () => ({ ...context, sessionProviderAuthorized: true }),
    sessionProviderHandler: async () => ({ ok: true, value: { value: 'x'.repeat(70 * 1024) } }),
  });
  const capped = await oversized.route(event, envelope('request', {
    ...call, request_id: 'provider_request_3',
  }));
  assert.equal(capped.status, 'failed');
  assert.equal(capped.reason_code, 'bridge_response_too_large');
});
