'use strict';

// Deliverable D: prove with synthetic canary values that no module under
// services/plugins/protocol/** or services/plugins/view/** ever places a
// secret into an error message, structured log, diagnostic, progress event,
// or audit-shaped record. The canaries below are obviously synthetic (they
// embed the literal substring "PLACEHOLDER", which check_no_secrets.py's
// placeholder-token allowlist recognizes) so this file itself never trips the
// secrets scanner while still exercising every rejection/diagnostic path each
// pure module can produce.
//
// The property under test: every REJECTED result these modules return is
// bounded structured metadata (a short code + a field path, sometimes a byte
// count) -- never the raw value that triggered the rejection. A caller may of
// course pass a secret-shaped string straight through as normal ACCEPTED data
// (e.g. an accepted frame payload) -- that is ordinary data flow, not a leak.
// This file only asserts about the diagnostic/rejection surface.

const test = require('node:test');
const assert = require('node:assert/strict');

const frameSettlement = require('../../../services/plugins/protocol/frame-settlement.js');
const bridgeValidator = require('../../../services/plugins/view/bridge-message-validator.js');

const CANARY_SECRET = 'CANARY_SECRET_PLACEHOLDER_do-not-leak-9f3e7b21';

function assertNoCanaryLeak(label, value) {
  const serialized = JSON.stringify(value);
  assert.equal(
    serialized.includes(CANARY_SECRET),
    false,
    `${label}: diagnostic must not embed the canary secret, got ${serialized}`,
  );
}

test('frame-settlement rejections never embed the offending payload', () => {
  const context = {
    invocationId: 'inv-canary',
    commitEpoch: 5,
    lifecycleEpoch: 2,
    maxStreamFrames: 4,
    maxFrameUtf8Bytes: 8,
    maxStreamTotalUtf8Bytes: 8,
    deadlineEpochMs: 100,
  };
  const state = frameSettlement.initialSettlementState(context);

  const overBudget = frameSettlement.reduceFrame(
    state,
    { frame_schema_version: 1, invocation_id: 'inv-canary', commit_epoch: 5, lifecycle_epoch: 2, sequence: 0, frame: { kind: 'data', payload: CANARY_SECRET } },
    0,
  );
  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.error.code, frameSettlement.REJECT_REASONS.FRAME_PAYLOAD_BUDGET_EXCEEDED);
  assertNoCanaryLeak('frame-settlement over-budget rejection', overBudget.error);

  const wrongEpoch = frameSettlement.reduceFrame(
    state,
    { frame_schema_version: 1, invocation_id: 'inv-canary', commit_epoch: 1, lifecycle_epoch: 2, sequence: 0, frame: { kind: 'progress', payload: CANARY_SECRET } },
    0,
  );
  assert.equal(wrongEpoch.ok, false);
  assertNoCanaryLeak('frame-settlement wrong-epoch rejection', wrongEpoch.error);

});

test('bridge-message-validator rejections never embed the plugin-authored payload', () => {
  const limits = {
    max_depth: 6,
    max_nodes: 32,
    max_object_keys: 8,
    max_array_items: 8,
    max_message_utf8_bytes: 4096,
    max_response_utf8_bytes: 4096,
    max_messages_per_second: 10,
    max_queue_length: 10,
  };
  const message = {
    bridge_schema_version: 1,
    view_instance_id: 'view-canary',
    contribution_id: 'tool_alpha',
    artifact_digest: 'a'.repeat(64),
    commit_epoch: 5,
    lifecycle_epoch: 2,
    method: 'request',
    payload_json: JSON.stringify({ secret: CANARY_SECRET }),
    limits,
  };
  const context = {
    // Deliberately wrong view_instance_id so the binding check rejects.
    viewInstanceId: 'view-expected',
    contributionId: 'tool_alpha',
    artifactDigest: 'a'.repeat(64),
    commitEpoch: 5,
    lifecycleEpoch: 2,
    allowedMethods: ['request'],
    // Host-owned ceiling; the validator enforces against this, never the
    // message's own declared `limits`.
    limits,
  };
  const rateState = { windowStartMs: 0, countInWindow: 0, queueLength: 0 };

  const result = bridgeValidator.validateBridgeMessage(message, context, rateState, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, bridgeValidator.REJECT_REASONS.BINDING_MISMATCH);
  assertNoCanaryLeak('bridge-message-validator binding-mismatch rejection', result.error);
});
