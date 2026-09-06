'use strict';

// W2-2: tool.result → background-job registration hook.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  noteBackgroundJobFromToolResult,
} = require('../services/backend/chat-stream-background-jobs');

function makeService() {
  const events = [];
  return {
    events,
    emit(name, payload) {
      events.push({ name, payload });
    },
  };
}

const CTX = { resolvedSessionId: 'session-9' };

test('a tool result carrying metadata.background_job_id emits background-job-started', () => {
  const service = makeService();
  const claimed = noteBackgroundJobFromToolResult(service, CTX, {
    tool_call_id: 'call-1',
    tool_name: 'run_command',
    tool_input: { command: 'npm run build', run_in_background: true },
    metadata: { background_job_id: 'abc123def456', background_job_pid: 777 },
  });
  assert.equal(claimed, true);
  assert.deepEqual(service.events, [{
    name: 'background-job-started',
    payload: {
      jobId: 'abc123def456',
      sessionId: 'session-9',
      command: 'npm run build',
      toolCallId: 'call-1',
      toolName: 'run_command',
      pid: 777,
    },
  }]);
});

test('a missing or malformed background_job_pid forwards as null, never a guess', () => {
  const service = makeService();
  for (const badPid of [undefined, 0, -5, 3.5, '777', null]) {
    service.events.length = 0;
    const claimed = noteBackgroundJobFromToolResult(service, CTX, backgroundResult({
      metadata: { background_job_id: 'abc123def456', background_job_pid: badPid },
    }));
    assert.equal(claimed, true);
    assert.equal(service.events[0].payload.pid, null, `pid ${String(badPid)} must forward as null`);
  }
});

function backgroundResult(overrides = {}) {
  return {
    tool_call_id: 'call-x',
    tool_name: 'run_command',
    tool_input: { command: 'x', run_in_background: true },
    metadata: { background_job_id: 'abc123def456' },
    ...overrides,
  };
}

test('results without a valid job id are ignored', () => {
  const service = makeService();
  assert.equal(noteBackgroundJobFromToolResult(service, CTX, backgroundResult({ metadata: undefined })), false);
  assert.equal(noteBackgroundJobFromToolResult(service, CTX, backgroundResult({ metadata: {} })), false);
  assert.equal(
    noteBackgroundJobFromToolResult(service, CTX, backgroundResult({ metadata: { background_job_id: '../../etc' } })),
    false,
    'path-shaped ids refused'
  );
  assert.equal(
    noteBackgroundJobFromToolResult(service, CTX, backgroundResult({ metadata: { background_job_id: 'ABC123DEF456' } })),
    false,
    'uppercase hex refused'
  );
  assert.equal(
    noteBackgroundJobFromToolResult(service, CTX, backgroundResult({ metadata: ['not-an-object'] })),
    false
  );
  assert.equal(service.events.length, 0);
});

test('only canonical background run_command results register', () => {
  const service = makeService();
  assert.equal(
    noteBackgroundJobFromToolResult(service, CTX, backgroundResult({ tool_name: 'some_mcp_tool' })),
    false,
    'non-run_command tools echoing a job id are refused'
  );
  assert.equal(
    noteBackgroundJobFromToolResult(service, CTX, backgroundResult({
      tool_input: { command: 'x' },
    })),
    false,
    'run_command without run_in_background is refused'
  );
  assert.equal(
    noteBackgroundJobFromToolResult(service, CTX, backgroundResult({
      tool_input: 'not-an-object',
    })),
    false,
    'a malformed tool_input cannot prove run_in_background'
  );
  assert.equal(service.events.length, 0);
});
