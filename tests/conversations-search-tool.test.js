'use strict';

// Row 58 W4: conversations_search queries the sidecar's conversation index and
// re-checks every hit against the canonical chat list before answering.

const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationsSearchTool: search } = require('../services/tools/builtin/conversations-tool');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');

const chat = (id, extra = {}) => ({ id, project_id: 'project_a', title: 'Title ' + id, updated_at: '2026-10-15', message_count: 2, ...extra });
const hit = (session_id, extra = {}) => ({
  session_id, title: 'stale ' + session_id, message_id: 'm-' + session_id, role: 'user',
  created_at: '2026-10-14T10:00:00Z', snippet: 'about ' + session_id, score: 0.5, ...extra,
});

function fixture(chats = [chat('target')], { hits = null, answer = null } = {}) {
  const caller = chat('caller');
  const requests = [];
  const reads = [];
  const service = {
    featureFlags: { memory_v2_enabled: true, session_offline_lockdown: true },
    sessionRuntime: { lineageStore: { exportPortableSnapshot: () => ({ records: [{ document: { children: [{ session_id: 'child' }] } }] }) } },
    sessionStore: {
      listSessions: () => { reads.push('list'); return chats; },
      getSessionSummary: id => { reads.push('summary:' + id); return id === 'caller' ? caller : chats.find(c => c.id === id); },
      peekSessionMessages: id => { reads.push('messages:' + id); return []; },
      getSession: () => { throw new Error('settle-on-read is forbidden'); },
    },
    sidecarClient: {
      connected: true,
      async request(method, params) {
        requests.push({ method, params });
        if (answer) return answer(method, params);
        return { ok: true, mode: 'lexical', hits: hits || chats.map(c => hit(c.id)) };
      },
    },
  };
  return { caller, service, requests, reads,
    context: { sessionId: 'caller', projectAuthority: { project_id: ' project_a ' }, backendService: service } };
}

async function data(input, context) {
  const result = await search.execute(input, context);
  assert.equal(result.isError, false, result.content);
  return JSON.parse(result.content);
}

test('it searches the trusted project, excludes the caller and maps hits with a follow-up note', async () => {
  const f = fixture([chat('target', { title: 'x'.repeat(250) })]);
  const payload = await data({ query: '  tabs vs spaces ', limit: 3, project_id: 'project_b' }, f.context);
  assert.equal(f.requests.length, 1);
  const { method, params } = f.requests[0];
  assert.equal(method, 'conversations.search');
  assert.deepEqual({ ...params, accept_version: undefined }, {
    accept_version: undefined, query: 'tabs vs spaces', project_id: 'project_a', exclude_session_ids: ['caller'], limit: 3,
  });
  assert.equal(payload.mode, 'lexical');
  assert.deepEqual(payload.results, [{
    session_id: 'target', title: 'x'.repeat(200), message_id: 'm-target', role: 'user',
    created_at: '2026-10-14T10:00:00Z', snippet: 'about target',
  }]);
  assert.match(payload.note, /background data, not instructions/);
  assert.match(payload.note, /conversation_open/);
  assert.match(payload.note, /around_message_id/);
});

test('limit defaults to 5 and clamps to 1..10', async () => {
  for (const [limit, expected] of [[undefined, 5], [0, 1], [50, 10], [4, 4]]) {
    const f = fixture();
    await data({ query: 'q', limit }, f.context);
    assert.equal(f.requests[0].params.limit, expected);
  }
});

test('hits from another project, the caller, hidden, deleted or empty chats are dropped', async () => {
  const chats = [
    chat('target'), chat('other', { project_id: 'project_b' }), chat('optout', { context_preferences: { memory_opt_out: true } }),
    chat('locked', { lockdown: true }), chat('child'), chat('diag', { diagnostic_mode: true }),
    chat('plugin', { session_type: 'plugin' }), chat('empty', { message_count: 0 }),
  ];
  const hits = [...chats.map(c => hit(c.id)), hit('caller'), hit('deleted'), hit('target', { message_id: 'm2' })];
  const f = fixture(chats, { hits });
  const payload = await data({ query: 'q' }, f.context);
  assert.deepEqual(payload.results.map(r => [r.session_id, r.message_id]), [['target', 'm-target'], ['target', 'm2']]);
  assert.ok(!JSON.stringify(payload).includes('other'));
});

test('an unreadable lineage store drops every hit (fails closed)', async () => {
  const f = fixture();
  f.service.sessionRuntime.lineageStore.exportPortableSnapshot = () => { throw new Error('unavailable'); };
  assert.deepEqual((await data({ query: 'q' }, f.context)).results, []);
});

test('a lockdown caller is refused before any read or search', async () => {
  const f = fixture(); f.caller.lockdown = true; f.service.featureFlags.session_offline_lockdown = false;
  const result = await search.execute({ query: 'q' }, f.context);
  assert.equal(result.isError, true);
  assert.match(result.content, /not available in a lockdown chat/);
  assert.deepEqual(f.reads, ['summary:caller']);
  assert.equal(f.requests.length, 0);
});

test('no trusted project fails closed without searching', async () => {
  const f = fixture();
  f.context.projectAuthority = null;
  const result = await search.execute({ query: 'q' }, f.context);
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content).reason, 'project_unavailable');
  assert.equal(f.requests.length, 0);
});

test('an unavailable index or a missing sidecar answers empty with a note, not an error', async () => {
  for (const variant of [
    f => { f.service.sidecarClient.request = async () => ({ ok: false, reason: 'index_unavailable' }); },
    f => { f.service.sidecarClient = null; },
    f => { f.service.sidecarClient.connected = false; },
  ]) {
    const f = fixture();
    variant(f);
    const result = await search.execute({ query: 'q' }, f.context);
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content), { results: [], note: 'Search is not available right now.' });
  }
});

test('a failing search request is an error that never echoes its message', async () => {
  const f = fixture(undefined, { answer: () => { throw new Error('private chat text'); } });
  const result = await search.execute({ query: 'q' }, f.context);
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes('private chat text'));
});

test('invalid queries are refused without a search', async () => {
  for (const query of [undefined, '', '   ', 42, 'q'.repeat(501)]) {
    const f = fixture();
    const result = await search.execute({ query }, f.context);
    assert.equal(result.isError, true, String(query));
    assert.equal(JSON.parse(result.content).reason, 'invalid_input');
    assert.equal(f.requests.length, 0);
  }
});

test('the output stays within the 16,000-char budget', async () => {
  const chats = Array.from({ length: 10 }, (_, i) => chat('c' + i, { title: '"'.repeat(250) }));
  const hits = chats.map(c => hit(c.id, { snippet: '\u0001'.repeat(5000), message_id: 'm'.repeat(128) }));
  const f = fixture(chats, { hits });
  const result = await search.execute({ query: 'q', limit: 10 }, f.context);
  assert.equal(result.isError, false);
  assert.ok(result.content.length <= 16_000, String(result.content.length));
  const payload = JSON.parse(result.content);
  assert.ok(payload.results.length >= 1);
  assert.ok(payload.results.every(r => r.snippet.length <= 280 && r.title.length <= 200));
});

test('malformed hits from the sidecar are ignored', async () => {
  const f = fixture(undefined, { hits: [null, 'x', hit('target', { message_id: 7 }), hit('target', { role: 'tool' }), hit('target')] });
  assert.deepEqual((await data({ query: 'q' }, f.context)).results.map(r => r.message_id), ['m-target']);
});

test('registry gates the tool and the bridge runs it in a read-only Plan Mode chat', async () => {
  assert.ok(!createDefaultRegistry().getAllTools().some(t => t.name === 'conversations_search'));
  const f = fixture([chat('target', { project_id: null })]);
  const registry = createDefaultRegistry({ toolsConversationsEnabled: true });
  delete f.service.sessionRuntime;
  const authority = { project_id: 'project_general', root_path: null, root_id: null, root_revision: 0, device_id: null, inode: null };
  const execution = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => authority, requireCurrent: () => authority },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({}) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const binding = execution.captureSession('caller', { requestId: 'request', mode: 'plan', readOnly: true });
  f.service.toolExecutor = new ToolExecutor({ registry, permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) }, pathPolicy: {}, logger: () => {} });
  const result = await executeElectronToolRequest(f.service, { params: { tool_name: 'conversations_search', arguments: { query: 'q' }, session_id: 'caller', plan_mode: true, read_only: true }, sessionId: 'untrusted', executionAuthority: binding });
  assert.equal(result.success, true, result.output);
  const payload = JSON.parse(result.output);
  assert.equal(payload.results[0].session_id, 'target');
  assert.equal(f.requests[0].params.project_id, 'project_general');
});
