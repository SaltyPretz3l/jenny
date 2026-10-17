'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupIssues, correlations, errorCode, issueEntryMatches, severityRank } = require('../renderer/shared/diagnostics-issue-utils');

test('groups issues by component, event, error code and severity using latest evidence', () => {
  const issues = groupIssues([
    { sequence: 1, level: 'WARN', component: 'runtime.engine', event: 'engine.failed', data: { error_code: 'CMP-AI-1' }, message: 'first' },
    { sequence: 2, level: 'ERROR', component: 'runtime.engine', event: 'engine.failed', data: { error_code: 'CMP-AI-1', remediation: 'Restart the engine.' }, message: 'latest' },
  ]);
  assert.equal(issues.length, 2); assert.equal(issues[0].count, 1); assert.equal(issues[0].severity, 'ERROR'); assert.equal(issues[0].message, 'latest'); assert.equal(issues[0].remediation, 'Restart the engine.');
  assert.equal(Object.hasOwn(issues[0], 'latest'), false);
});

test('mixed canonical and local issues use timestamps and preserve the newest structured remediation', () => {
  const issues = groupIssues([
    { run_id: 'run', sequence: 8, ts: '2026-08-16T00:00:01Z', level: 'WARN', component: 'runtime', event: 'failed', message: 'canonical', data: { remediation: 'Older advice' } },
    { run_id: 'run', ts: '2026-08-16T00:00:03Z', level: 'WARN', component: 'runtime', event: 'failed', message: 'local newest' },
    { run_id: 'run', sequence: 9, ts: '2026-08-16T00:00:02Z', level: 'WARN', component: 'runtime', event: 'failed', message: 'middle', data: { remediation: 'Newest available advice' } },
  ]);
  assert.equal(issues[0].message, 'local newest');
  assert.equal(issues[0].remediation, 'Newest available advice');
});

test('message-matched workspace variants and renderer dedupe keys stay separate', () => {
  const rows = [
    { level: 'WARN', component: 'ide.watch', event: 'ide.watch_start_failed', message: 'no workspace root' },
    { level: 'WARN', component: 'ide.watch', event: 'ide.watch_start_failed', message: 'EACCES' },
    { level: 'WARN', component: 'ide.watch', event: 'ide.watch_start_failed', data: { message: 'NO WORKSPACE ROOT' } },
    ...['one', 'two', 'one'].map(dedupe_key => ({ level: 'ERROR', layer: 'renderer', event: 'renderer.unhandled_error', data: { dedupe_key } })),
  ];
  const groups = groupIssues(rows);
  assert.equal(groups.length, 4);
  for (const group of groups) {
    const members = rows.filter(row => issueEntryMatches(group, row));
    assert.equal(members.length, group.count);
    assert.equal(issueEntryMatches(group, { ...members[0], level: 'INFO' }), false);
  }
  assert.equal(issueEntryMatches(null, rows[0]), false);
  assert.equal(issueEntryMatches(groups[0], null), false);
});

test('Inspect uses normalized identities and groups expose member ids and latest data and layer', () => {
  const rows = [
    { level: 'warn', source: 'sidecar', entry_id: 'canonical', sequence: 1, data: { durationMs: 1200 } },
    { level: 'WARN', layer: 'sidecar', origin_entry_id: 'local', sequence: 2, data: { durationMs: 2400 } },
    { level: 'WARN', layer: 'sidecar', sequence: 3, details: { durationMs: 3600 } },
  ];
  const [group] = groupIssues(rows);
  assert.equal(group.component, 'sidecar');
  assert.equal(group.event, 'unknown.event');
  assert.deepEqual(group.entry_ids, ['canonical', 'local', 3]);
  assert.equal(group.data, rows[2].details);
  assert.equal(group.layer, 'sidecar');
  assert.ok(rows.every(row => issueEntryMatches(group, row)));
  assert.equal(issueEntryMatches(group, { ...rows[0], component: 'different' }), false);
  assert.equal(issueEntryMatches(group, { ...rows[0], event: 'different' }), false);
  assert.equal(issueEntryMatches(group, { ...rows[0], data: { error_code: 'ENOENT' } }), false);
});

test('process exit codes are ignored while symbolic codes and explicit error codes are preserved', () => {
  for (const code of [0, 1, -1, '1', 'exit 1', '1.5', 'A', 'A'.repeat(65)]) {
    assert.equal(errorCode({ data: { code } }), '');
  }
  for (const code of ['ENOENT', 'CMP-AI-0001', 'A_B', 'write_failed', 'spawn.failed', 'A'.repeat(64)]) assert.equal(errorCode({ data: { code } }), code);
  assert.equal(errorCode({ data: { error_code: 1, code: 'ENOENT' } }), '1');
  assert.equal(errorCode({ data: { errorCode: 'custom value' } }), 'custom value');
  assert.equal(errorCode({ error_code: 'custom value', data: { code: 1 } }), 'custom value');
  const groups = groupIssues([0, 1].map(code => ({ level: 'ERROR', event: 'llama.server.exited', data: { code } })));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
});

test('issue sorting parses timezone offsets and keeps the existing timestamp tie-break', () => {
  const rows = [
    { level: 'ERROR', event: 'older', ts: '2026-10-07T02:00:00Z' },
    { level: 'ERROR', event: 'newer', ts: '2026-10-07T02:00:00.500+00:00' },
    { level: 'WARN', event: 'warning', ts: '2026-10-08T02:00:00Z' },
  ];
  assert.deepEqual(groupIssues(rows).map(group => group.event), ['newer', 'older', 'warning']);
  assert.deepEqual(groupIssues([
    { level: 'WARN', event: 'first', ts: 'invalid' },
    { level: 'WARN', event: 'second', ts: 'invalid' },
  ]).map(group => group.event), ['first', 'second']);
});

test('shared severity rank orders all log levels', () => {
  assert.deepEqual(['DEBUG', 'INFO', 'WARN', 'ERROR', 'unknown'].map(severityRank), [0, 1, 2, 3, 0]);
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
