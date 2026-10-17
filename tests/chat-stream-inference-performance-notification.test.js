'use strict';

// inference.performance routing in the managed chat-stream notification dispatcher
// (row 59 checkpoint 6): a known method delegated to the intake, which owns request
// and session ownership; telemetry never touches liveness, rows or usage. Split from
// chat-stream-managed-runtime-notifications.test.js (file-size ceiling).
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleNotification } = require('../services/backend/chat-stream-managed-runtime-notifications');
const { makeCtx, makeHandleToolNotification, callsOf } = require('./helpers/managed-runtime-notification-harness');

const PERFORMANCE_PARAMS = Object.freeze({
  schema_version: 1, request_id: 'stream-1', trace_id: 't', session_id: 'session-1', turn_id: 'turn-1', provider_call_id: null,
  attempt_id: 'a1'.repeat(16), sequence: 0, sampled_at: 1_700_000_000_000, phase: 'waiting', source: 'provider',
  provider_kind: 'ninfer',
});

test('inference.performance is a known method delegated to the intake and touches nothing else', () => {
  const ctx = makeCtx();
  const accepted = [];
  ctx.service.inferenceIntake = { accept: (c, params) => { accepted.push([c, params]); return true; } };
  handleNotification(
    ctx,
    { method: 'inference.performance', params: { ...PERFORMANCE_PARAMS } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0][0], ctx, 'the intake receives the stream context (ownership comes from it)');
  assert.deepEqual(accepted[0][1], PERFORMANCE_PARAMS);
  // Telemetry never affects liveness, row rendering or the transcript.
  assert.equal(callsOf(ctx, 'touchActiveTurn').length, 0);
  assert.equal(callsOf(ctx, 'emitChatStream').length, 0);
  assert.equal(callsOf(ctx, 'emitThinkingStatus').length, 0);
  assert.equal(callsOf(ctx, 'appendText').length, 0);
  assert.equal(callsOf(ctx, 'persistCurrentTextSegment').length, 0);
  assert.equal(callsOf(ctx, 'serviceLog').filter((l) => l.code === 'chat.unknown_notification_method').length, 0);
  assert.equal(ctx.turnUsage, null);
  assert.equal(ctx.streamSawText, false);
});

test('inference.performance without a composed intake is dropped quietly, and a misspelled method is still unknown', () => {
  const ctx = makeCtx();
  const options = { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) };
  handleNotification(ctx, { method: 'inference.performance', params: { ...PERFORMANCE_PARAMS } }, options);
  assert.equal(callsOf(ctx, 'serviceLog').length, 0);
  handleNotification(ctx, { method: 'inference.performanse', params: { ...PERFORMANCE_PARAMS } }, options);
  const warns = callsOf(ctx, 'serviceLog').filter((l) => l.code === 'chat.unknown_notification_method');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].fields.method, 'inference.performanse');
});

test('the real intake enforces request and session ownership against the stream context', () => {
  const { createInferenceIntake } = require('../services/performance/inference-intake');
  const ctx = makeCtx();
  ctx.service.inferenceIntake = createInferenceIntake();
  const options = { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) };
  handleNotification(ctx, { method: 'inference.performance', params: { ...PERFORMANCE_PARAMS, request_id: 'someone-else' } }, options);
  handleNotification(ctx, { method: 'inference.performance', params: { ...PERFORMANCE_PARAMS, session_id: 'session-2' } }, options);
  assert.equal(ctx.service.inferenceIntake.snapshotForSession('session-1'), null);
  handleNotification(ctx, { method: 'inference.performance', params: { ...PERFORMANCE_PARAMS } }, options);
  assert.equal(ctx.service.inferenceIntake.snapshotForSession('session-1').observation.phase, 'waiting');
});
