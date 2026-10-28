'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateHandoffNote } = require('../services/backend/backend-handoff');
const { requestRuntimeInference } = require('../services/backend/backend-runtime-inference');

const MESSAGES = [
  { id: 'msg_1', role: 'user', content: 'Plan the parser rewrite.' },
  { id: 'msg_2', role: 'assistant', content: 'Start with the tokenizer.' },
];

// No sessionRuntime and no `session_runtime` flag: requestRuntimeInference takes
// the embedded legacy branch and calls sidecarClient.request directly.
function createMockService({ result = { status: 'ok', note: 'Next: tokenizer.', transcript_truncated: false },
  request, session = { id: 'sess_a', preferred_model: '' }, messages = MESSAGES, ...overrides } = {}) {
  const calls = [];
  const logs = [];
  const service = {
    currentModel: 'local-model',
    currentEngineType: 'ollama',
    featureFlags: {},
    activeStreams: new Map(),
    sidecarClient: {
      request: request || (async (method, params, options) => { calls.push({ method, params, options }); return result; }),
      chatCompact: async () => { throw new Error('chatCompact must not carry handoff.generate_note'); },
    },
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sessionStore: {
      getSession: () => session,
      getSessionMessages: () => messages,
    },
    _emitServiceLog: (level, event, fields) => logs.push({ level, event, fields }),
    ...overrides,
  };
  return { service, calls, logs };
}

test('sends the prepared history to handoff.generate_note and maps an ok note', async () => {
  const { service, calls, logs } = createMockService({
    result: { status: 'ok', note: '  ## Handoff\nNext: tokenizer.  ', transcript_truncated: true },
  });
  const res = await generateHandoffNote(service, ' sess_a ');
  assert.deepEqual(res, { ok: true, note: '## Handoff\nNext: tokenizer.', transcriptTruncated: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'handoff.generate_note');
  assert.equal(calls[0].params.session_id, 'sess_a');
  assert.ok(calls[0].params.accept_version);
  assert.deepEqual(calls[0].params.messages.map((message) => message.content), MESSAGES.map((message) => message.content));
  assert.equal(calls[0].options.timeoutMs, 120_000);
  assert.deepEqual(logs.map((entry) => entry.event), ['handoff.note_requested', 'handoff.note_result']);
  assert.deepEqual(logs[1].fields, {
    sessionId: 'sess_a', status: 'ok', note_chars: res.note.length, transcript_truncated: true,
  });
  assert.ok(!JSON.stringify(logs).includes('tokenizer'), 'the note text is never logged');
});

test('transcriptTruncated defaults to false', async () => {
  const { service } = createMockService({ result: { status: 'ok', note: 'note' } });
  assert.deepEqual(await generateHandoffNote(service, 'sess_a'), { ok: true, note: 'note', transcriptTruncated: false });
});

test('an empty trimmed note is generation_failed', async () => {
  const { service, logs } = createMockService({ result: { status: 'ok', note: ' \n ', transcript_truncated: false } });
  assert.deepEqual(await generateHandoffNote(service, 'sess_a'), { ok: false, reason: 'generation_failed' });
  assert.equal(logs.at(-1).level, 'WARN');
});

test('maps sidecar error statuses to their reason', async () => {
  for (const reason of ['no_history', 'generation_failed', 'note_invalid']) {
    const { service } = createMockService({ result: { status: 'error', reason, detail: 'x' } });
    assert.deepEqual(await generateHandoffNote(service, 'sess_a'), { ok: false, reason });
  }
  const { service } = createMockService({ result: { status: 'error', reason: 'surprise' } });
  assert.deepEqual(await generateHandoffNote(service, 'sess_a'), { ok: false, reason: 'generation_failed' });
});

test('a thrown request maps to request_failed with a bounded detail and a WARN log', async () => {
  const { service, logs } = createMockService({ request: async () => { throw new Error('x'.repeat(500)); } });
  const res = await generateHandoffNote(service, 'sess_a');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'request_failed');
  assert.equal(res.detail.length, 300);
  const last = logs.at(-1);
  assert.equal(last.level, 'WARN');
  assert.equal(last.event, 'handoff.note_result');
  assert.equal(last.fields.reason, 'request_failed');
});

test('runtime admission errors map to request_failed', async () => {
  // A declared `session_runtime` flag without a runtime is an admission refusal.
  const { service, calls } = createMockService({ featureFlags: { session_runtime: false } });
  const res = await generateHandoffNote(service, 'sess_a');
  assert.equal(res.reason, 'request_failed');
  assert.equal(calls.length, 0);
});

test('sidecar_unavailable refusal logs the handoff event and sends nothing', async () => {
  const { service, calls, logs } = createMockService({ sidecarManager: { getStatus: () => ({ phase: 'starting' }) } });
  assert.deepEqual(await generateHandoffNote(service, 'sess_a'), { ok: false, reason: 'sidecar_unavailable' });
  assert.equal(calls.length, 0);
  assert.deepEqual(logs.at(-1), {
    level: 'WARN', event: 'handoff.note_result', fields: { sessionId: 'sess_a', reason: 'sidecar_unavailable' },
  });
});

test('a locked session never reaches a remote engine', async () => {
  const { service, calls } = createMockService({
    featureFlags: { session_offline_lockdown: true },
    currentEngineType: 'chatgpt',
    session: { id: 'sess_a', lockdown: true },
  });
  assert.deepEqual(await generateHandoffNote(service, 'sess_a'), { ok: false, reason: 'session_offline_lockdown' });
  assert.equal(calls.length, 0);
});

test('model bring-up refusals: session_busy and model_unavailable', async () => {
  const busy = createMockService({
    session: { id: 'sess_a', preferred_model: 'other-model' },
    activeStreams: new Map([['stream_1', {}]]),
    _resolveModel: async () => {},
  });
  assert.deepEqual(await generateHandoffNote(busy.service, 'sess_a'), { ok: false, reason: 'session_busy' });
  const broken = createMockService({
    session: { id: 'sess_a', preferred_model: 'other-model' },
    _resolveModel: async () => { throw new Error('load failed'); },
  });
  assert.deepEqual(await generateHandoffNote(broken.service, 'sess_a'), { ok: false, reason: 'model_unavailable' });
  assert.equal(busy.calls.length + broken.calls.length, 0);
});

test('legacy branch keeps chat.compact on chatCompact and sends other scoped methods through request', async () => {
  const seen = [];
  const service = {
    featureFlags: {},
    sidecarClient: {
      request: async (method, params) => { seen.push(['request', method, params.session_id]); return { status: 'ok' }; },
      chatCompact: async (sessionId) => { seen.push(['chatCompact', 'chat.compact', sessionId]); return { status: 'ok' }; },
    },
  };
  await requestRuntimeInference(service, 'handoff.generate_note', { session_id: 'sess_a', messages: [] }, { sessionId: 'sess_a' });
  await requestRuntimeInference(service, 'chat.compact', { session_id: 'sess_a', messages: [] }, { sessionId: 'sess_a' });
  assert.deepEqual(seen, [['request', 'handoff.generate_note', 'sess_a'], ['chatCompact', 'chat.compact', 'sess_a']]);
  await assert.rejects(
    requestRuntimeInference(service, 'handoff.generate_note', { session_id: 'sess_b', messages: [] }, { sessionId: 'sess_a' }),
    /runtime_auxiliary_scope_invalid/,
  );
});

test('row 73: the primary chat must name a project before any inference', async () => {
  const projectService = { list: () => [{ id: 'project_general', name: 'General' }, { id: 'project_atlas', name: 'Atlas' }] };
  const { service, calls } = createMockService({ projectService });
  service.sessionStore.getSessionSummary = () => ({ id: 'sess_a', session_role: 'primary' });
  service.sessionStore.peekSessionMessages = () => [];
  service.sessionStore.listSessions = () => [];
  const required = await generateHandoffNote(service, 'sess_a');
  assert.equal(required.ok, false);
  assert.equal(required.reason, 'project_required');
  assert.deepEqual(required.projects.map((project) => project.id), ['project_atlas', 'project_general']);
  assert.equal(required.suggestedProjectId, null);
  assert.equal((await generateHandoffNote(service, 'sess_a', { projectId: 'project_gone' })).reason, 'project_invalid');
  assert.equal(calls.length, 0);
});

test('row 73: a named project scopes the sidecar note and the reply carries the flagged names', async () => {
  const projectService = { list: () => [{ id: 'project_atlas', name: 'Atlas' }, { id: 'project_zeta', name: 'Zeta site' }] };
  const { service, calls } = createMockService({ projectService });
  service.sessionStore.getSessionSummary = () => ({ id: 'sess_a', session_role: 'primary' });
  service.sessionStore.listSessions = () => [];
  const res = await generateHandoffNote(service, 'sess_a', { projectId: 'project_atlas' });
  assert.deepEqual(res, {
    ok: true, note: 'Next: tokenizer.', transcriptTruncated: false, projectId: 'project_atlas', otherNames: ['Zeta site'],
  });
  assert.deepEqual(calls[0].params.focus_project, { name: 'Atlas' });
});

test('row 73: an ordinary chat ignores a project id and sends no focus', async () => {
  const { service, calls } = createMockService();
  service.sessionStore.getSessionSummary = () => ({ id: 'sess_a', session_role: null });
  const res = await generateHandoffNote(service, 'sess_a', { projectId: 'project_atlas' });
  assert.deepEqual(res, { ok: true, note: 'Next: tokenizer.', transcriptTruncated: false });
  assert.equal(Object.hasOwn(calls[0].params, 'focus_project'), false);
});
