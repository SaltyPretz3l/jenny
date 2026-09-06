'use strict';

// Coverage for the chat-stream-managed-runtime-notifications.js
// ingestPlanUsage hook: chat.done reads the raw usage.plan_usage key, chat.
// error reads params.plan_usage, the flag gates both, an older-sidecar
// payload without the key is a no-op, and a throwing store never breaks turn
// settlement. Uses the same fake ctx/service harness as the sibling
// notification-dispatcher test file (see AGENTS.md pointer in the task brief).

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleNotification } = require('../services/backend/chat-stream-managed-runtime-notifications');
const { rebuildChatDoneUsage } = require('../services/backend/chat-stream-usage');
const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
} = require('./helpers/managed-runtime-notification-harness');

function attachRecordingStore(ctx) {
  const ingestCalls = [];
  ctx.service.chatgptPlanUsageStore = {
    ingest(raw, opts) {
      ingestCalls.push({ raw, opts });
    },
  };
  return ingestCalls;
}

const PLAN_USAGE_PAYLOAD = Object.freeze({
  schema_version: 1,
  primary: { used_percent: 62, window_minutes: 300, reset_at: 1_900_000_000 },
});

test('chat.done with usage.plan_usage ingests with source chat_done', () => {
  const ctx = makeCtx();
  const ingestCalls = attachRecordingStore(ctx);
  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: {
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1, output_tokens: 1, total_tokens: 2,
          plan_usage: PLAN_USAGE_PAYLOAD,
        },
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ingestCalls.length, 1);
  assert.deepEqual(ingestCalls[0].raw, PLAN_USAGE_PAYLOAD);
  assert.deepEqual(ingestCalls[0].opts, { source: 'chat_done' });
  // Ordinary turn-usage handling is unaffected by the additive key.
  assert.ok(ctx.turnUsage);
  assert.equal(callsOf(ctx, 'settleUnfinishedToolRows').length, 1);
});

test('chat.error with plan_usage ingests with source chat_error', () => {
  const ctx = makeCtx();
  const ingestCalls = attachRecordingStore(ctx);
  handleNotification(
    ctx,
    {
      method: 'chat.error',
      params: {
        code: 'provider_rate_limited',
        message: 'rate limited',
        plan_usage: PLAN_USAGE_PAYLOAD,
      },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );

  assert.equal(ingestCalls.length, 1);
  assert.deepEqual(ingestCalls[0].raw, PLAN_USAGE_PAYLOAD);
  assert.deepEqual(ingestCalls[0].opts, { source: 'chat_error' });
  // Ordinary error recording is unaffected.
  assert.equal(callsOf(ctx, 'recordSidecarErrorFromParams').length, 1);
});

test('an older-sidecar chat.done payload without usage.plan_usage never calls ingest', () => {
  const ctx = makeCtx();
  const ingestCalls = attachRecordingStore(ctx);
  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );
  assert.equal(ingestCalls.length, 0);
});

test('a chat.done payload with no usage block at all never calls ingest', () => {
  const ctx = makeCtx();
  const ingestCalls = attachRecordingStore(ctx);
  handleNotification(
    ctx,
    { method: 'chat.done', params: { stop_reason: 'end_turn' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );
  assert.equal(ingestCalls.length, 0);
});

test('an older-sidecar chat.error payload without plan_usage never calls ingest', () => {
  const ctx = makeCtx();
  const ingestCalls = attachRecordingStore(ctx);
  handleNotification(
    ctx,
    { method: 'chat.error', params: { code: 'boom', message: 'boom' } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );
  assert.equal(ingestCalls.length, 0);
});

test('the chatgpt_plan_meter flag being off skips ingest even when plan_usage is present', () => {
  const ctx = makeCtx();
  const ingestCalls = attachRecordingStore(ctx);
  ctx.service.featureFlags = { chatgpt_plan_meter: false };
  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, plan_usage: PLAN_USAGE_PAYLOAD } },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );
  assert.equal(ingestCalls.length, 0);
});

test('a missing chatgptPlanUsageStore on the service is a silent no-op (no throw)', () => {
  const ctx = makeCtx();
  ctx.streamSawText = true;
  // Deliberately do not attach chatgptPlanUsageStore.
  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, plan_usage: PLAN_USAGE_PAYLOAD } },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );
  // Settlement proceeded exactly as for a payload without plan_usage, and no
  // ingest warning was logged for the absent store.
  assert.equal(callsOf(ctx, 'settleUnfinishedToolRows').length, 1);
  assert.equal(callsOf(ctx, 'beginVisibleCompletionFinalization').length, 1);
  const warns = callsOf(ctx, 'serviceLog').filter((entry) => entry.code === 'chat.plan_usage_not_ingested');
  assert.equal(warns.length, 0);
});

test('a throwing store.ingest does not break chat.done settlement, and logs a WARN', () => {
  const ctx = makeCtx();
  ctx.streamSawText = true;
  ctx.service.chatgptPlanUsageStore = {
    ingest() {
      throw new Error('disk full');
    },
  };
  assert.doesNotThrow(() => {
    handleNotification(
      ctx,
      {
        method: 'chat.done',
        params: {
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, plan_usage: PLAN_USAGE_PAYLOAD },
        },
      },
      { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
    );
  });
  // Settlement still proceeded normally.
  assert.equal(callsOf(ctx, 'settleUnfinishedToolRows').length, 1);
  assert.equal(callsOf(ctx, 'beginVisibleCompletionFinalization').length, 1);
  const warns = callsOf(ctx, 'serviceLog').filter((entry) => entry.code === 'chat.plan_usage_not_ingested');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].fields.source, 'chat_done');
  assert.equal(warns[0].fields.streamId, 'stream-1');
});

test('a throwing store.ingest does not break chat.error recording', () => {
  const ctx = makeCtx();
  ctx.service.chatgptPlanUsageStore = {
    ingest() {
      throw new Error('disk full');
    },
  };
  assert.doesNotThrow(() => {
    handleNotification(
      ctx,
      { method: 'chat.error', params: { code: 'boom', message: 'boom', plan_usage: PLAN_USAGE_PAYLOAD } },
      { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
    );
  });
  assert.equal(callsOf(ctx, 'recordSidecarErrorFromParams').length, 1);
  const warns = callsOf(ctx, 'serviceLog').filter((entry) => entry.code === 'chat.plan_usage_not_ingested');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].fields.source, 'chat_error');
});

test('rebuildChatDoneUsage output is byte-identical whether or not plan_usage rides along', () => {
  const usageWithout = {
    input_tokens: 10, output_tokens: 20, total_tokens: 30,
    generation_tokens: 20, generation_duration_ms: 800,
  };
  const usageWith = { ...usageWithout, plan_usage: PLAN_USAGE_PAYLOAD };
  assert.deepEqual(
    rebuildChatDoneUsage(usageWithout, 'test-model'),
    rebuildChatDoneUsage(usageWith, 'test-model')
  );
});

test('a non-object plan_usage value is dropped rather than passed to ingest', () => {
  const ctx = makeCtx();
  const ingestCalls = attachRecordingStore(ctx);
  handleNotification(
    ctx,
    {
      method: 'chat.done',
      params: { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, plan_usage: 'not-an-object' } },
    },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) }
  );
  assert.equal(ingestCalls.length, 0);
});
