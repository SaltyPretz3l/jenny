'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewContext } = require('../services/backend/context-preview');

function fixture() {
  const calls = [];
  const session = { messages: [], run_mode: 'plan', context_preferences: {} };
  const binding = {};
  const service = {
    sessionStore: { peekSession: () => session, getSession: () => assert.fail('preview must not settle session state') },
    sidecarClient: { process: {}, request: async (method, params) => {
      calls.push({ method, params });
      return { status: 'estimated', used_tokens: 42, breakdown: { system_prompt: 42 } };
    } },
    sessionExecutionAuthority: {
      captureSession: () => binding,
      toExecutionContext: () => ({ project_id: 'project_general', root_path: null }),
      requireCurrent: () => {}, close: (value) => { assert.equal(value, binding); calls.push('closed'); },
    },
    personalityWorkspace: { getCompiledContext: async (options) => {
      assert.equal(options.ensure, false, 'preview never seeds personality files');
      return 'Be concise';
    } },
  };
  return { service, calls, session };
}

test('preview captures session authority, sends prepared history and closes transient binding', async () => {
  const { service, calls } = fixture();
  const result = await previewContext(service, 's1');
  assert.equal(result.status, 'estimated');
  assert.equal(calls[0].method, 'context.preview');
  assert.equal(calls[0].params.run_mode, 'plan');
  assert.equal(calls[0].params.execution_context.root_path, null);
  assert.deepEqual(calls[0].params.messages, []);
  assert.equal(calls.at(-1), 'closed');
  assert.ok(result.sampled_at);
});

test('preview failure and changed authority fail closed and release the binding', async () => {
  const { service, calls } = fixture();
  service.sessionExecutionAuthority.requireCurrent = () => { throw new Error('changed'); };
  assert.equal((await previewContext(service, 's1')).status, 'unavailable');
  assert.equal(calls.at(-1), 'closed');
  service.sidecarClient.process = null;
  assert.equal((await previewContext(service, 's1')).reason, 'backend_not_ready');
});

test('a session read failure fails closed instead of rejecting', async () => {
  const { service } = fixture();
  service.sessionStore.peekSession = () => { throw new Error('store unavailable'); };
  assert.deepEqual(await previewContext(service, 's1'), { status: 'unavailable', reason: 'preview_unavailable' });
});

test('concurrent previews of unchanged inputs share one sidecar call; changed inputs start another', async () => {
  const { service, calls, session } = fixture();
  const [first, second] = await Promise.all([previewContext(service, 's1'), previewContext(service, 's1')]);
  assert.equal(first, second);
  assert.equal(calls.filter((call) => call.method === 'context.preview').length, 1);
  const third = previewContext(service, 's1');
  session.run_mode = 'auto';
  await Promise.all([third, previewContext(service, 's1')]);
  assert.equal(calls.filter((call) => call.method === 'context.preview').length, 3, 'a mode change never joins the old call');
  await previewContext(service, 's1');
  assert.equal(calls.filter((call) => call.method === 'context.preview').length, 4, 'a settled call is never reused');
});
