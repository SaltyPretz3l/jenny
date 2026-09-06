'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupIssues, correlations } = require('../renderer/shared/diagnostics-issue-utils');

test('groups issues by component, event, and error code using highest severity and latest evidence', () => {
  const issues = groupIssues([
    { sequence: 1, level: 'WARN', component: 'runtime.engine', event: 'engine.failed', data: { error_code: 'CMP-AI-1' }, message: 'first' },
    { sequence: 2, level: 'ERROR', component: 'runtime.engine', event: 'engine.failed', data: { error_code: 'CMP-AI-1', remediation: 'Restart the engine.' }, message: 'latest' },
  ]);
  assert.equal(issues.length, 1); assert.equal(issues[0].count, 2); assert.equal(issues[0].severity, 'ERROR'); assert.equal(issues[0].message, 'latest'); assert.equal(issues[0].remediation, 'Restart the engine.');
  assert.equal(Object.hasOwn(issues[0], 'latest'), false);
});

test('mixed canonical and local issues use timestamps and preserve the newest structured remediation', () => {
  const issues = groupIssues([
    { run_id: 'run', sequence: 8, ts: '2026-08-16T00:00:01Z', level: 'WARN', component: 'runtime', event: 'failed', message: 'canonical', data: { remediation: 'Older advice' } },
    { run_id: 'run', ts: '2026-08-16T00:00:03Z', level: 'ERROR', component: 'runtime', event: 'failed', message: 'local newest' },
    { run_id: 'run', sequence: 9, ts: '2026-08-16T00:00:02Z', level: 'WARN', component: 'runtime', event: 'failed', message: 'middle', data: { remediation: 'Newest available advice' } },
  ]);
  assert.equal(issues[0].message, 'local newest');
  assert.equal(issues[0].remediation, 'Newest available advice');
});

test('correlations surface the stream id under one canonical key', () => {
  assert.deepEqual(correlations({ data: { stream_id: 'stream_abc' } }), { stream_id: 'stream_abc' });
  assert.deepEqual(correlations({ data: { streamId: 'stream_abc' } }), { stream_id: 'stream_abc' });
  assert.deepEqual(correlations({ streamId: 'stream_abc' }), { stream_id: 'stream_abc' });
  /* Both spellings present: one row, snake_case wins. */
  assert.deepEqual(
    correlations({ data: { stream_id: 'canonical', streamId: 'camel' } }),
    { stream_id: 'canonical' }
  );
});

test('correlations keep the existing keys and omit empty stream ids', () => {
  assert.deepEqual(
    correlations({ trace_id: 't', data: { request_id: 'r', session_id: 's', tool_call_id: 'c', rpc_id: '1' } }),
    { trace_id: 't', request_id: 'r', session_id: 's', tool_call_id: 'c', rpc_id: '1' }
  );
  assert.deepEqual(correlations({ data: { streamId: '   ' } }), {});
  assert.deepEqual(correlations(null), {});
});

test('grouped issues carry the stream id correlation through to the Overview list', () => {
  const issues = groupIssues([
    {
      sequence: 1, level: 'ERROR', component: 'chat.stream', event: 'chat.error',
      data: { error_code: 'CMP-CHAT-0002', streamId: 'stream_abc' }, message: 'boom',
    },
  ]);
  assert.equal(issues[0].correlations.stream_id, 'stream_abc');
});
