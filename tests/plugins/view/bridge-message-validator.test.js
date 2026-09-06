'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { REJECT_REASONS, validateBridgeMessage, checkResponseSize } = require('../../../services/plugins/view/bridge-message-validator.js');

const DEFAULT_LIMITS = Object.freeze({
  max_depth: 4,
  max_nodes: 20,
  max_object_keys: 4,
  max_array_items: 4,
  max_message_utf8_bytes: 512,
  max_response_utf8_bytes: 256,
  max_messages_per_second: 3,
  max_queue_length: 3,
});

function baseMessage(overrides) {
  return {
    bridge_schema_version: 1,
    view_instance_id: 'view-0001',
    contribution_id: 'tool_alpha',
    artifact_digest: 'a'.repeat(64),
    commit_epoch: 5,
    lifecycle_epoch: 2,
    method: 'request',
    payload_json: '{"op":"ping"}',
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

function baseContext(overrides) {
  return {
    viewInstanceId: 'view-0001',
    contributionId: 'tool_alpha',
    artifactDigest: 'a'.repeat(64),
    commitEpoch: 5,
    lifecycleEpoch: 2,
    allowedMethods: ['request', 'subscribe'],
    // Host-owned ceiling. The message carries its own copy because the contract
    // requires one, but only this set is ever enforced against.
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

function freshRateState() {
  return { windowStartMs: 0, countInWindow: 0, queueLength: 0 };
}

test('a well-formed, in-allowlist, correctly-bound message is accepted and advances rate state', () => {
  const result = validateBridgeMessage(baseMessage(), baseContext(), freshRateState(), 0);
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.rateState.countInWindow, 1);
  assert.equal(result.rateState.queueLength, 1);
});

test('a view cannot raise its own ceiling: message-declared limits above the host limits are rejected', () => {
  const message = baseMessage({
    // Schema-valid (the contract caps these at 65536 / 1000) but far above the
    // host's 512-byte, 3-per-second ceiling for this view.
    limits: { ...DEFAULT_LIMITS, max_message_utf8_bytes: 4096, max_messages_per_second: 1000 },
  });
  const result = validateBridgeMessage(message, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.LIMITS_ESCALATION);
});

test('an oversize payload is rejected against the HOST limits even when the message declares a looser one', () => {
  const payload = JSON.stringify({ op: 'x'.repeat(1000) });
  const message = baseMessage({
    payload_json: payload,
    limits: { ...DEFAULT_LIMITS, max_message_utf8_bytes: 4096 },
  });
  const result = validateBridgeMessage(message, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.LIMITS_ESCALATION);
});

test('a message-declared limit TIGHTER than the host ceiling is allowed through', () => {
  const message = baseMessage({ limits: { ...DEFAULT_LIMITS, max_message_utf8_bytes: 64 } });
  const result = validateBridgeMessage(message, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, true);
});

test('a context without host-owned limits fails closed rather than trusting the message', () => {
  const context = baseContext();
  delete context.limits;
  const result = validateBridgeMessage(baseMessage(), context, freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.TRUSTED_LIMITS_MISSING);
});

test('a message that fails the generated PluginViewBridgeV1 schema is rejected', () => {
  const malformed = baseMessage({ method: 'not_a_real_method' });
  const result = validateBridgeMessage(malformed, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.SCHEMA_INVALID);
});

test('a schema-valid method outside this binding\'s own allowlist is rejected', () => {
  const message = baseMessage({ method: 'cancel' });
  const context = baseContext({ allowedMethods: ['request'] });
  const result = validateBridgeMessage(message, context, freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.METHOD_NOT_ALLOWED);
});

test('a message bound to the wrong commit_epoch is rejected as a binding mismatch', () => {
  const message = baseMessage({ commit_epoch: 999 });
  const result = validateBridgeMessage(message, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.BINDING_MISMATCH);
});

test('a payload over the configured per-message byte limit is rejected before it is parsed', () => {
  const message = baseMessage({ payload_json: `"${'x'.repeat(600)}"`, limits: { ...DEFAULT_LIMITS, max_message_utf8_bytes: 32 } });
  const result = validateBridgeMessage(message, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.MESSAGE_BYTES_EXCEEDED);
});

test('a payload that is not valid JSON is rejected', () => {
  const message = baseMessage({ payload_json: '{not-json' });
  const result = validateBridgeMessage(message, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.PAYLOAD_NOT_JSON);
});

test('a payload nested deeper than the configured depth limit is rejected', () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  const message = baseMessage({ payload_json: JSON.stringify(deep), limits: { ...DEFAULT_LIMITS, max_depth: 2 } });
  const result = validateBridgeMessage(message, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.DEPTH_BUDGET_EXCEEDED);
});

test('a payload array longer than the configured item limit is rejected', () => {
  const message = baseMessage({ payload_json: JSON.stringify({ items: [1, 2, 3, 4, 5] }), limits: { ...DEFAULT_LIMITS, max_array_items: 3 } });
  const result = validateBridgeMessage(message, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.ARRAY_BUDGET_EXCEEDED);
});

test('a payload with more object keys than the configured limit is rejected', () => {
  const message = baseMessage({ payload_json: JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 }), limits: { ...DEFAULT_LIMITS, max_object_keys: 3 } });
  const result = validateBridgeMessage(message, baseContext(), freshRateState(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.KEY_BUDGET_EXCEEDED);
});

test('messages arriving faster than the configured rate limit are rejected', () => {
  const context = baseContext();
  let rateState = freshRateState();
  const outcomes = [];
  for (let i = 0; i < 5; i += 1) {
    const result = validateBridgeMessage(baseMessage(), context, rateState, 100);
    outcomes.push(result.ok);
    if (result.ok) rateState = result.rateState;
  }
  assert.deepEqual(outcomes, [true, true, true, false, false]);
});

test('a queue already at its configured length limit rejects further messages', () => {
  const context = baseContext();
  let rateState = { windowStartMs: 0, countInWindow: 0, queueLength: DEFAULT_LIMITS.max_queue_length };
  const result = validateBridgeMessage(baseMessage(), context, rateState, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, REJECT_REASONS.QUEUE_LIMIT_EXCEEDED);
});

test('checkResponseSize caps an outbound reply and passes a small one through', () => {
  const small = checkResponseSize({ ok: true }, DEFAULT_LIMITS);
  assert.equal(small.ok, true);

  const large = checkResponseSize({ blob: 'y'.repeat(1000) }, DEFAULT_LIMITS);
  assert.equal(large.ok, false);
  assert.equal(large.error.code, REJECT_REASONS.MESSAGE_BYTES_EXCEEDED);
});
