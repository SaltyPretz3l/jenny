// Follow Jenny (row 121): the canonical bridge forwards the whole argument text
// of a followed file tool (write_file, edit_file) and flushes its folded tail
// before the tool event. With the flag off the 4 KB preview holds.
//
// Static-literal require (source->test existence gate walks this graph):
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
  canonicalEvent,
} = require('./helpers/managed-runtime-notification-harness');

test('turn.event tool_input_delta forwards a followed file whole and flushes its tail before the tool event (row 121)', () => {
  const ctx = makeCtx();
  ctx.service.featureFlags.follow_jenny = true;
  let nowMs = 1000;
  ctx.now = () => nowMs;
  const deps = { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) };
  const send = (toolName, delta, sequence, toolCallId) => handleNotification(ctx, {
    method: 'turn.event',
    params: canonicalEvent('tool_input_delta', { tool_name: toolName, arguments_delta: delta, sequence }, { tool_call_id: toolCallId }),
  }, deps);
  const deltasOf = (toolCallId) => callsOf(ctx, 'emitChatStream')
    .filter((call) => call.payload.type === 'tool_input_delta' && call.payload.toolCallId === toolCallId);
  const joined = (toolCallId) => deltasOf(toolCallId).map((call) => call.payload.argumentsDelta).join('');

  // 100 KB of write_file arguments in 500-char fragments, 20 ms apart; the closing brace
  // comes with the last of them, so it is always inside the fold.
  const writeArguments = `{"path":"src/a.js","content":"${'line of code\\n'.repeat(7200)}"}`;
  assert.ok(writeArguments.length > 100000);
  let sequence = 0;
  for (let offset = 0; offset < writeArguments.length - 1; offset += 500) {
    nowMs += 20;
    send('write_file', writeArguments.slice(offset, Math.min(offset + 500, writeArguments.length - 1)), sequence += 1, 'call-follow-write');
  }
  send('write_file', '}', sequence += 1, 'call-follow-write');
  const beforeToolEvent = deltasOf('call-follow-write').length;
  assert.ok(beforeToolEvent <= Math.ceil((nowMs - 1000) / 50) + 1, 'still folded: at most one event per 50 ms');
  assert.ok(beforeToolEvent > Math.ceil((nowMs - 1000) / 100) + 1, 'a followed file is forwarded more often than the 100 ms fold');
  assert.notEqual(joined('call-follow-write'), writeArguments, 'the last fragments are still folded');

  handleNotification(ctx, {
    method: 'turn.event',
    params: canonicalEvent('tool_call_requested', {
      tool_name: 'write_file', tool_input: { path: 'src/a.js', content: 'x' }, sequence: sequence + 1,
    }, { tool_call_id: 'call-follow-write' }),
  }, deps);
  assert.equal(joined('call-follow-write'), writeArguments, 'the whole argument text reached the renderer');
  const all = callsOf(ctx, 'emitChatStream');
  const lastDeltaIndex = all.map((call) => call.payload.type).lastIndexOf('tool_input_delta');
  assert.equal(deltasOf('call-follow-write').length, beforeToolEvent + 1, 'one trailing flush');
  assert.equal(lastDeltaIndex, beforeToolEvent, 'the flush is sent before anything the tool event emits');
  assert.equal(all[lastDeltaIndex].payload.argumentsBytes, Buffer.byteLength(writeArguments));

  // edit_file follows too; a tool that is not followed never flushes its tail.
  nowMs += 1000;
  send('edit_file', '{"path":"src/a.js",', 1, 'call-follow-edit');
  send('edit_file', '"old_string":"a","new_string":"b"}', 2, 'call-follow-edit');
  send('run_command', '{"command":', 1, 'call-run');
  assert.equal(joined('call-follow-edit'), '{"path":"src/a.js","old_string":"a","new_string":"b"}',
    'the next call flushes the followed call before it: its tool event may come later');
  const order = callsOf(ctx, 'emitChatStream').filter((call) => call.payload.type === 'tool_input_delta')
    .map((call) => call.payload.toolCallId);
  assert.deepEqual(order.slice(-3), ['call-follow-edit', 'call-follow-edit', 'call-run'], 'the flush goes out first');
  send('run_command', '"npm test"}', 2, 'call-run');
  handleNotification(ctx, {
    method: 'turn.event',
    params: canonicalEvent('tool_call_requested', {
      tool_name: 'run_command', tool_input: { command: 'npm test' }, sequence: 3,
    }, { tool_call_id: 'call-run' }),
  }, deps);
  assert.equal(joined('call-run'), '{"command":', 'other tools keep the fold with nothing trailing');
});

test('turn.event tool_input_delta keeps the 4 KB preview for file tools when follow_jenny is off', () => {
  const ctx = makeCtx();
  ctx.service.featureFlags.follow_jenny = false;
  let nowMs = 1000;
  ctx.now = () => nowMs;
  const deps = { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) };
  const send = (delta, sequence) => handleNotification(ctx, {
    method: 'turn.event',
    params: canonicalEvent('tool_input_delta', { tool_name: 'write_file', arguments_delta: delta, sequence }, { tool_call_id: 'call-off' }),
  }, deps);
  send('y'.repeat(9000), 1);
  send('tail', 2);
  handleNotification(ctx, {
    method: 'turn.event',
    params: canonicalEvent('tool_call_requested', {
      tool_name: 'write_file', tool_input: { path: 'a.js', content: 'x' }, sequence: 3,
    }, { tool_call_id: 'call-off' }),
  }, deps);
  const deltas = callsOf(ctx, 'emitChatStream').filter((call) => call.payload.type === 'tool_input_delta');
  assert.equal(deltas.length, 1, 'no trailing flush');
  assert.equal(deltas[0].payload.argumentsDelta.length, 4096);
});

test('turn.event tool_input_delta keeps the 100 ms fold for a tool that is not followed', () => {
  const ctx = makeCtx();
  ctx.service.featureFlags.follow_jenny = true;
  let nowMs = 1000;
  ctx.now = () => nowMs;
  const deps = { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) };
  for (let sequence = 1; sequence <= 50; sequence += 1) {
    handleNotification(ctx, {
      method: 'turn.event',
      params: canonicalEvent('tool_input_delta', { tool_name: 'run_command', arguments_delta: 'x', sequence }, { tool_call_id: 'call-run' }),
    }, deps);
    nowMs += 20;
  }
  const deltas = callsOf(ctx, 'emitChatStream').filter((call) => call.payload.type === 'tool_input_delta');
  assert.equal(deltas.length, 10, 'one second of fragments, one event per 100 ms');
});
