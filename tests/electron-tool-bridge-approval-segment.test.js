'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildManagedSidecarChatSendOptions } = require('../services/backend/electron-tool-bridge');

function buildOptions({ runtime, order, logs = [] }) {
  return buildManagedSidecarChatSendOptions({
    service: {
      sessionExecutionAuthority: { requireCurrent() {}, noteApproved() {} },
      _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    },
    controller: new AbortController(),
    streamId: 'stream_seg',
    resolvedSessionId: 'sess_seg',
    requestId: 'stream_seg',
    requestTraceId: 'trace_seg',
    runtime,
    toolContext: {},
    handleToolNotification() {},
    waitForToolApproval: async () => {
      order.push('tool_use_row');
      return { approved: true, decision: 'approved_once' };
    },
    turnEventCollector: { turnId: 'stream_seg' },
    normalizedPreferences: {},
    timeoutMs: 1_000,
  });
}

// Linux QA 2026-10-05: with the tool_use row written first, the stored turn
// read [tool_use, commentary, tool_result] and the next turn replayed the
// commentary after the result it introduced.
test('an approval request cuts the pre-tool text segment before the tool_use row is written', async () => {
  const order = [];
  const options = buildOptions({
    order,
    runtime: {
      handleNotification() {},
      persistToolBoundarySegment() { order.push('text_segment'); },
    },
  });
  const result = await options.onApprovalRequest({ tool_name: 'write_file', tool_call_id: 'call_1' });
  assert.deepEqual(order, ['text_segment', 'tool_use_row']);
  assert.equal(result.approved, true);
});

test('a failed segment cut is logged and never blocks the approval', async () => {
  const order = [];
  const logs = [];
  const options = buildOptions({
    order,
    logs,
    runtime: {
      handleNotification() {},
      persistToolBoundarySegment() { throw new Error('store refused'); },
    },
  });
  const result = await options.onApprovalRequest({ tool_name: 'write_file', tool_call_id: 'call_1' });
  assert.deepEqual(order, ['tool_use_row']);
  assert.equal(result.approved, true);
  assert.equal(logs.filter((entry) => entry.event === 'chat.approval_segment_persist_failed').length, 1);
});

test('a runtime without the segment hook still reaches the approval', async () => {
  const order = [];
  const options = buildOptions({ order, runtime: { handleNotification() {} } });
  await options.onApprovalRequest({ tool_name: 'write_file', tool_call_id: 'call_1' });
  assert.deepEqual(order, ['tool_use_row']);
});

// The same ordering on the canonical path: the sidecar's approval event
// arrives before the approval request and must not be captured ahead of the
// text that introduced the call.
const { handleNotification } = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  makeCtx, makeHandleToolNotification, callsOf, canonicalEvent,
} = require('./helpers/managed-runtime-notification-harness');

test('a canonical approval request cuts the pre-tool text segment before it is captured', () => {
  const ctx = makeCtx();
  const order = [];
  const persist = ctx.persistCurrentTextSegment;
  ctx.persistCurrentTextSegment = (opts) => { order.push('segment'); return persist(opts); };
  const noteEvent = ctx.turnEventCollector.noteEvent;
  ctx.turnEventCollector.noteEvent = (params, meta) => {
    order.push(`event:${params.type}`);
    return noteEvent(params, meta);
  };
  const deps = { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) };

  handleNotification(ctx, {
    method: 'turn.event',
    params: canonicalEvent('tool_approval_requested', {
      call_id: 'call-1', tool_name: 'write_file', approval_state: 'pending',
    }, { seq: 4 }),
  }, deps);

  assert.deepEqual(order, ['segment', 'event:tool_approval_requested']);
  assert.deepEqual(callsOf(ctx, 'persistCurrentTextSegment')[0].opts, {
    allowReasoningOnly: true, atToolBoundary: true,
  });

  // Other canonical events keep their existing segment timing.
  order.length = 0;
  handleNotification(ctx, {
    method: 'turn.event',
    params: canonicalEvent('text_delta', { delta: 'x' }, { seq: 5 }),
  }, deps);
  assert.deepEqual(order, ['event:text_delta']);
});
