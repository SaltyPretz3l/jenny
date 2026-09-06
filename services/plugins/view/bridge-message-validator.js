'use strict';

// Pure validation of one inbound PluginViewBridgeV1 message
// (PLUG-D06 / "Sandboxed plugin-view contract"). The generated contract
// validator (services/plugins/contracts/generated-plugin-contracts.js) proves
// the message's own envelope shape and its declared `limits`; the closed
// schema DSL has no "arbitrary JSON" node type, so the plugin-authored
// `payload_json` string is opaque to it by design. This module is where that
// payload actually gets parsed and walked against the PER-VIEW limits (which
// are configured tighter than the global structural budget every contract
// already enforces), plus everything else that is inherently caller state
// rather than static schema shape: rate/queue budgets and the
// view-instance/origin/epoch binding check.
//
// Pure function, no fs/net/child_process, no ambient clock: `nowMs` and the
// previous `rateState` are both passed in and a new `rateState` is returned,
// never mutated in place.

const { validate } = require('../contracts/generated-plugin-contracts.js');

const REJECT_REASONS = Object.freeze({
  SCHEMA_INVALID: 'bridge_message_schema_invalid',
  METHOD_NOT_ALLOWED: 'bridge_method_not_allowed',
  BINDING_MISMATCH: 'bridge_binding_mismatch',
  PAYLOAD_NOT_JSON: 'bridge_payload_not_json',
  DEPTH_BUDGET_EXCEEDED: 'bridge_payload_depth_exceeded',
  NODE_BUDGET_EXCEEDED: 'bridge_payload_node_budget_exceeded',
  KEY_BUDGET_EXCEEDED: 'bridge_payload_key_budget_exceeded',
  ARRAY_BUDGET_EXCEEDED: 'bridge_payload_array_budget_exceeded',
  MESSAGE_BYTES_EXCEEDED: 'bridge_message_bytes_exceeded',
  RATE_LIMIT_EXCEEDED: 'bridge_rate_limit_exceeded',
  QUEUE_LIMIT_EXCEEDED: 'bridge_queue_limit_exceeded',
  TRUSTED_LIMITS_MISSING: 'bridge_trusted_limits_missing',
  LIMITS_ESCALATION: 'bridge_limits_escalation',
});

// Every budget the view is held to. The message carries its own `limits` block
// because the contract requires one, but that block is PLUGIN-AUTHORED and is
// therefore only ever checked FOR ESCALATION -- enforcement always runs against
// the host-supplied `context.limits`. A view that could raise its own ceiling
// has no ceiling at all.
const LIMIT_KEYS = Object.freeze([
  'max_message_utf8_bytes',
  'max_response_utf8_bytes',
  'max_depth',
  'max_nodes',
  'max_object_keys',
  'max_array_items',
  'max_messages_per_second',
  'max_queue_length',
]);

function trustedLimitsError(limits) {
  if (!limits || typeof limits !== 'object') return 'context.limits missing or malformed';
  for (const key of LIMIT_KEYS) {
    if (!Number.isFinite(limits[key]) || limits[key] < 0) return `context.limits.${key} must be a non-negative number`;
  }
  return null;
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function reject(code, path) {
  return { ok: false, error: { code, path: path || '' } };
}

function accept(rateState) {
  return { ok: true, error: null, rateState };
}

/** Walk a parsed JSON value against the view's configured structural limits. */
function checkPayloadStructure(value, limits) {
  const stack = [{ value, depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodeCount += 1;
    if (nodeCount > limits.max_nodes) return { code: REJECT_REASONS.NODE_BUDGET_EXCEEDED };
    if (current.depth > limits.max_depth) return { code: REJECT_REASONS.DEPTH_BUDGET_EXCEEDED };
    const item = current.value;
    if (item === null || typeof item !== 'object') continue;
    if (Array.isArray(item)) {
      if (item.length > limits.max_array_items) return { code: REJECT_REASONS.ARRAY_BUDGET_EXCEEDED };
      for (const entry of item) stack.push({ value: entry, depth: current.depth + 1 });
      continue;
    }
    const keys = Object.keys(item);
    if (keys.length > limits.max_object_keys) return { code: REJECT_REASONS.KEY_BUDGET_EXCEEDED };
    for (const key of keys) stack.push({ value: item[key], depth: current.depth + 1 });
  }
  return null;
}

/**
 * @param {{windowStartMs:number, countInWindow:number, queueLength:number}} rateState
 * @param {number} nowMs
 * @param {{max_messages_per_second:number, max_queue_length:number}} limits
 */
function checkRateAndQueue(rateState, nowMs, limits) {
  const withinWindow = typeof rateState.windowStartMs === 'number' && nowMs - rateState.windowStartMs < 1000;
  const nextWindowStart = withinWindow ? rateState.windowStartMs : nowMs;
  const nextCount = (withinWindow ? rateState.countInWindow : 0) + 1;
  if (nextCount > limits.max_messages_per_second) {
    return { error: { code: REJECT_REASONS.RATE_LIMIT_EXCEEDED }, rateState };
  }
  const nextQueueLength = rateState.queueLength + 1;
  if (nextQueueLength > limits.max_queue_length) {
    return { error: { code: REJECT_REASONS.QUEUE_LIMIT_EXCEEDED }, rateState };
  }
  return {
    error: null,
    rateState: { windowStartMs: nextWindowStart, countInWindow: nextCount, queueLength: nextQueueLength },
  };
}

/**
 * @param {object} message a PluginViewBridgeV1-shaped inbound message
 * @param {{viewInstanceId:string, contributionId:string, artifactDigest:string,
 *   commitEpoch:number, lifecycleEpoch:number, allowedMethods:string[],
 *   limits:object}} context `limits` is the HOST-owned per-view ceiling and is
 *   the only limit set this function enforces against.
 * @param {{windowStartMs:number, countInWindow:number, queueLength:number}} rateState
 * @param {number} nowMs monotonic-clock reading supplied by the caller
 */
function validateBridgeMessage(message, context, rateState, nowMs) {
  const limits = context ? context.limits : null;
  if (trustedLimitsError(limits)) {
    return reject(REJECT_REASONS.TRUSTED_LIMITS_MISSING, 'limits');
  }

  const schemaResult = validate('PluginViewBridgeV1', message);
  if (!schemaResult.ok) {
    return reject(REJECT_REASONS.SCHEMA_INVALID, schemaResult.error ? schemaResult.error.path : '');
  }
  const validated = schemaResult.value;

  if (!Array.isArray(context.allowedMethods) || !context.allowedMethods.includes(validated.method)) {
    return reject(REJECT_REASONS.METHOD_NOT_ALLOWED, 'method');
  }
  if (
    validated.view_instance_id !== context.viewInstanceId
    || validated.contribution_id !== context.contributionId
    || validated.artifact_digest !== context.artifactDigest
    || validated.commit_epoch !== context.commitEpoch
    || validated.lifecycle_epoch !== context.lifecycleEpoch
  ) {
    return reject(REJECT_REASONS.BINDING_MISMATCH, '');
  }

  // The message's declared limits never authorize anything; they may only
  // agree with, or tighten, the host's. Anything looser is a tamper attempt.
  const escalated = LIMIT_KEYS.find((key) => validated.limits[key] > limits[key]);
  if (escalated) {
    return reject(REJECT_REASONS.LIMITS_ESCALATION, `limits.${escalated}`);
  }

  const messageBytes = utf8Bytes(validated.payload_json);
  if (messageBytes > limits.max_message_utf8_bytes) {
    return reject(REJECT_REASONS.MESSAGE_BYTES_EXCEEDED, 'payload_json');
  }

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(validated.payload_json);
  } catch {
    return reject(REJECT_REASONS.PAYLOAD_NOT_JSON, 'payload_json');
  }
  const structureError = checkPayloadStructure(parsedPayload, limits);
  if (structureError) {
    return reject(structureError.code, 'payload_json');
  }

  const rate = checkRateAndQueue(rateState, nowMs, limits);
  if (rate.error) {
    return reject(rate.error.code, '');
  }
  return accept(rate.rateState);
}

/** Cap an outbound bridge response before it is sent back to the view. */
function checkResponseSize(responseValue, limits) {
  const bytes = utf8Bytes(JSON.stringify(responseValue));
  if (bytes > limits.max_response_utf8_bytes) {
    return reject(REJECT_REASONS.MESSAGE_BYTES_EXCEEDED, 'response');
  }
  return { ok: true, error: null };
}

module.exports = {
  REJECT_REASONS,
  validateBridgeMessage,
  checkResponseSize,
};
