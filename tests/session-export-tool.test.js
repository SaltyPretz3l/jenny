'use strict';

// Row 94 P4: `session_export` is a closed schema over the export port; it is always a write, so Plan mode and
// read-only chats refuse it, and no result carries exception text, a path or more than the file's name.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const tool = require('../services/tools/builtin/session-export-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const VALID = { session_id: 'sess_a', chat_title: 'Release notes', purpose: 'The user asked for a copy.' };

function harness({ port, featureFlags } = {}) {
  const project = { project_id: 'general', root_path: os.tmpdir(), root_id: 'root', root_revision: 1, device_id: 'device', inode: 'inode' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (captured) => captured,
      _sessionStore: { getSessionSummary: () => ({ id: 'caller', run_mode: 'ask', plan_mode: false }) } },
    permissionStore: PERMISSIONS,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('caller', { requestId: 'stream', mode: 'assist', approvalMode: 'prompt' });
  const calls = [];
  const fake = port === undefined ? {
    async exportChat(args) {
      calls.push(args);
      return { ok: true, file_name: 'Jenny - Notes.md', bytes: 120, messages: 4, path: 'C:\\private\\Downloads\\x.md' };
    },
  } : port;
  const backendService = { sessionExecutionAuthority: authority, ...(featureFlags ? { featureFlags } : {}),
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call-1', backendService, executionAuthority, primaryChatExportService: fake, mode: 'ask',
    abortSignal: new AbortController().signal };
  return { context, calls };
}

const { parseToolOutput } = require('./helpers/refusal-output');
const output = parseToolOutput;

test('the kill switch refuses first; Plan mode and read-only chats refuse a write', async () => {
  const off = harness({ featureFlags: { primary_chat_export: false } });
  assert.deepEqual(output(await tool.execute(VALID, off.context)), { ok: false, reason: 'disabled' });
  const ok = harness({ featureFlags: { primary_chat_export: true } });
  for (const mode of [{ planMode: true }, { readOnly: true }]) {
    assert.deepEqual(output(await tool.execute(VALID, { ...ok.context, ...mode })), { ok: false, reason: 'mode_refused' });
  }
  assert.deepEqual(ok.calls, []);
});

test('input is a closed schema: extra keys, missing or over-long fields are invalid_input', async () => {
  const { context, calls } = harness();
  const bad = [undefined, null, [], {}, 'x', { ...VALID, extra: 1 }, { chat_title: 'T', purpose: 'p' }, { session_id: 's', purpose: 'p' },
    { session_id: 's', chat_title: 'T' }, { ...VALID, purpose: '   ' }, { ...VALID, session_id: 7 },
    { ...VALID, session_id: 'x'.repeat(257) }, { ...VALID, chat_title: 'x'.repeat(201) }, { ...VALID, purpose: 'x'.repeat(201) }];
  for (const input of bad) {
    assert.deepEqual(output(await tool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
  const atLimits = { session_id: 'x'.repeat(256), chat_title: 'x'.repeat(200), purpose: 'x'.repeat(200) };
  assert.equal(output(await tool.execute(atLimits, context)).ok, true, 'the limits themselves are fine');
});

test('a stale or missing live call and a missing port are unavailable', async () => {
  const stale = harness();
  stale.context.sessionIncarnation = '';
  assert.deepEqual(output(await tool.execute(VALID, stale.context)), { ok: false, reason: 'unavailable' });
  const otherStream = harness();
  otherStream.context.streamId = 'other-stream';
  assert.deepEqual(output(await tool.execute(VALID, otherStream.context)), { ok: false, reason: 'unavailable' });
  const noAuthority = harness();
  assert.deepEqual(output(await tool.execute(VALID, { ...noAuthority.context, executionAuthority: null })), { ok: false, reason: 'unavailable' });
  for (const port of [null, {}, { exportChat: 'nope' }]) {
    assert.deepEqual(output(await tool.execute(VALID, harness({ port }).context)), { ok: false, reason: 'unavailable' });
  }
  assert.equal(stale.calls.length + otherStream.calls.length + noAuthority.calls.length, 0);
});

test('a request reaches the port with the live caller and call id; the answer is shaped, with no path', async () => {
  const { context, calls } = harness();
  const result = await tool.execute(VALID, context);
  assert.deepEqual(calls, [{ caller_session_id: 'caller', tool_call_id: 'call-1', session_id: 'sess_a', chat_title: 'Release notes' }]);
  assert.deepEqual(output(result), { ok: true, file_name: 'Jenny - Notes.md', bytes: 120, messages: 4, folder: 'Downloads' });
  assert.equal(result.isError, false);
  assert.equal(result.content.includes('private'), false);
  assert.deepEqual(result.metadata, { result_kind: 'session_export', status: 'ok' });
});

test('the port\'s refusal reason passes through; an odd answer is unavailable; a throw leaks nothing', async () => {
  const refused = harness({ port: { exportChat: async () => ({ ok: false, reason: 'title_mismatch', chat_title: 'The real one' }) } });
  const answer = await tool.execute(VALID, refused.context);
  assert.deepEqual(output(answer), { ok: false, reason: 'title_mismatch' });
  assert.deepEqual(answer.metadata, { result_kind: 'session_export', status: 'refused', reason: 'title_mismatch' });
  assert.deepEqual(output(await tool.execute(VALID, harness({ port: { exportChat: async () => null } }).context)), { ok: false, reason: 'unavailable' });
  const thrown = await tool.execute(VALID, harness({ port: { exportChat: async () => { throw new Error('C:\\private\\secret.md'); } } }).context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'unavailable' });
  assert.equal(thrown.content.includes('private'), false);
});

test('a missing call id is sent as an empty string, never undefined', async () => {
  const { context, calls } = harness();
  await tool.execute(VALID, { ...context, callId: undefined });
  assert.equal(calls[0].tool_call_id, '');
});
