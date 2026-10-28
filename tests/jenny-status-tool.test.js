'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const jennyStatusTool = require('../services/tools/builtin/jenny-status-tool');

function backend(status) {
  const calls = [];
  return {
    calls,
    async getJennyStatus(options) {
      calls.push(options);
      return structuredClone(status);
    },
  };
}

const STATUS = {
  schema_version: 3,
  generated_at: '2026-10-19T10:00:00.000Z',
  backend: { phase: 'ready' },
  usage: {
    session_id: 'session-a',
    recent_turns: [
      { session_id: 'session-a', stream_id: 'a1' },
      { session_id: 'session-b', stream_id: 'b1' },
      { session_id: 'session-a', stream_id: 'a2' },
    ],
  },
};

test('the session comes from the trusted context, never from the model', async () => {
  const service = backend(STATUS);
  await jennyStatusTool.execute(
    { session_id: 'session-b', sessionId: 'session-c', recent_log_limit: 99 },
    { backendService: service, sessionId: 'session-a' }
  );
  assert.equal(service.calls[0].session_id, 'session-a');
  assert.equal(service.calls[0].recent_log_limit, 50);
});

test('usage rows are narrowed to the calling chat', async () => {
  const result = await jennyStatusTool.execute({}, { backendService: backend(STATUS), sessionId: 'session-a' });
  const payload = JSON.parse(result.content);
  assert.deepEqual(payload.usage.recent_turns.map((row) => row.stream_id), ['a1', 'a2']);
  const anonymous = await jennyStatusTool.execute({}, { backendService: backend(STATUS) });
  assert.deepEqual(JSON.parse(anonymous.content).usage.recent_turns, []);
});

test('the harness facet is opt-in and the payload is compact JSON', async () => {
  const service = backend(STATUS);
  const result = await jennyStatusTool.execute({}, { backendService: service, sessionId: 'session-a' });
  await jennyStatusTool.execute({ include_harness: true }, { backendService: service, sessionId: 'session-a' });
  assert.deepEqual(service.calls.map((options) => options.include_harness), [false, true]);
  assert.equal(result.content.includes('\n'), false);
  assert.equal(result.summary, 'Jenny status: ready');
  assert.equal(result.metadata.schema_version, 3);
});

test('a missing backend or a composition failure is a structured unavailable result', async () => {
  const missing = await jennyStatusTool.execute({}, {});
  assert.equal(missing.isError, true);
  assert.equal(missing.metadata.unavailable, true);
  const failed = await jennyStatusTool.execute({}, {
    backendService: { getJennyStatus: async () => { throw new Error('secret'); } },
  });
  assert.equal(failed.isError, true);
  assert.doesNotMatch(failed.content, /secret/);
});
