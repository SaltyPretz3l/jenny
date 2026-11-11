'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const tool = require('../services/tools/builtin/sessions-list-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };

function harness({ directory = null } = {}) {
  const project = { project_id: 'project_a', root_path: os.tmpdir(), root_id: 'root', root_revision: 1,
    device_id: 'device', inode: 'inode' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: captured => captured,
      _sessionStore: { getSessionSummary: () => ({ id: 'caller', run_mode: 'auto', plan_mode: false }) } },
    permissionStore: PERMISSIONS,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('caller', { requestId: 'stream', mode: 'assist', approvalMode: 'auto' });
  const calls = [];
  const fake = directory || { list(args) { calls.push(args); return { ok: true, scope_kind: 'project', rows: [], truncated: false }; } };
  const backendService = { sessionExecutionAuthority: authority,
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call', backendService, executionAuthority, sessionDirectoryService: fake, mode: 'auto',
    abortSignal: new AbortController().signal };
  return { context, calls, backendService };
}

const { DIRECTORY_DATA_NOTE } = require('../services/tools/builtin/session-directory-tool-support');

// Every ok answer carries the data note (other chats' text is data, not instructions); asserted here once.
const { parseToolOutput } = require('./helpers/refusal-output');
const output = (result) => {
  const { note, ...value } = parseToolOutput(result);
  assert.equal(note, value.ok === true ? DIRECTORY_DATA_NOTE : undefined);
  return value;
};

test('sessions_list refuses unknown keys and bad values before any directory work', async () => {
  const { context, calls } = harness();
  for (const input of [{ extra: true }, { scope: 'mine' }, { limit: 0 }, { limit: 51 }, { limit: 1.5 },
    { include_archived: 'yes' }, { project_id: '' }, { project_id: 'p'.repeat(161) }, { session_id: 'forged' }, []]) {
    const result = await tool.execute(input, context);
    assert.deepEqual(output(result), { ok: false, reason: 'invalid_request' });
    assert.equal(result.isError, false);
  }
  assert.deepEqual(calls, []);
});

test('the caller comes from the live binding and the arguments pass through closed', async () => {
  const { context, calls } = harness();
  const result = await tool.execute({ scope: 'active', project_id: 'project_b', include_archived: true, limit: 5 }, context);
  assert.deepEqual(output(result), { ok: true, rows: [], message: 'No chats match.' });
  assert.deepEqual(calls, [{ callerSessionId: 'caller', scope: 'active', project_id: 'project_b', include_archived: true,
    limit: 5, query: '', offset: 0 }]);
  await tool.execute({}, context);
  assert.deepEqual(calls[1], { callerSessionId: 'caller', scope: 'recent', project_id: null, include_archived: false,
    limit: 10, query: '', offset: 0 });
  assert.equal(tool.summarize({}), 'Sessions: list');
  assert.equal(result.summary, 'Sessions: list');
});

test('an unbound call, a missing directory and a throwing directory do no work and stay normal results', async () => {
  const unbound = harness();
  unbound.context.sessionId = '';
  assert.deepEqual(output(await tool.execute({}, unbound.context)), { ok: false, reason: 'stale_operation' });
  assert.deepEqual(unbound.calls, []);
  const missing = harness();
  missing.context.sessionDirectoryService = null;
  assert.deepEqual(output(await tool.execute({}, missing.context)), { ok: false, reason: 'unavailable' });
  const throwing = harness({ directory: { list() { throw new Error('private path C:\\secret'); } } });
  const result = await tool.execute({}, throwing.context);
  assert.deepEqual(output(result), { ok: false, reason: 'unavailable' });
  assert.doesNotMatch(result.content, /secret/);
  const refused = harness({ directory: { list: () => ({ ok: false, reason: 'lockdown' }) } });
  assert.deepEqual(output(await tool.execute({}, refused.context)), { ok: false, reason: 'lockdown' });
});

test('the flag registers the three directory tools, and the executor threads the directory getter', async () => {
  assert.equal(createDefaultRegistry().getTool('sessions_list'), undefined);
  const registry = createDefaultRegistry({ toolsSessionDirectoryEnabled: true });
  for (const name of ['sessions_list', 'session_status', 'session_transcript', 'session_stop']) assert.ok(registry.getTool(name), name);
  const { context } = harness();
  const listed = [];
  const executor = new ToolExecutor({ registry, permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {},
    sessionDirectoryService: () => ({ list: (args) => { listed.push(args.callerSessionId); return { ok: true, rows: [] }; } }) });
  delete context.sessionDirectoryService;
  const result = await executor.executePreApproved({ toolName: 'sessions_list', callId: 'call', input: {} }, context);
  assert.equal(result.isError, false, result.content);
  assert.deepEqual(output(result), { ok: true, rows: [], message: 'No chats match.' });
  assert.deepEqual(listed, ['caller']);
});

test('Plan and read-only preflight keep sessions_list; the hosted bridge refuses it', async () => {
  const { context } = harness();
  const executor = new ToolExecutor({ registry: createDefaultRegistry({ toolsSessionDirectoryEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  const verdict = executor._preflightTool({ toolName: 'sessions_list', callId: 'call', input: {} },
    { ...context, readOnly: true, planMode: true }, { preApproved: true });
  assert.ok(verdict.tool);
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'sessions_list' } });
  assert.equal(hosted.success, false);
});

// ---------- row 129, C7: compact rows, query, offset, a smaller default page ----------

const TITLES = ['Fix the login bug', 'Plan the release notes', 'Login page redesign', 'Debug the installer', 'Write unit tests'];

// A row as the session directory builds it (every field, repeated project block, folder path).
function directoryRow(index) {
  return {
    session_id: `sess_${String(index).padStart(3, '0')}_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    title: `${TITLES[index % TITLES.length]} ${index}`,
    project: { id: 'project_a1b2c3d4e5f6', name: 'JennyGC', folder: 'D:/Work/jenny/some/deeply/nested/project/folder' },
    status: index % 7 === 0 ? 'failed' : 'idle',
    last_outcome: { status: 'completed', updated_at: '2026-11-09T10:00:00.000Z', resumable: false },
    preferred_model: 'qwen3.8-35b-a3b-instruct-q6_k_xl-256k:latest',
    updated_at: `2026-11-09T10:${String(59 - (index % 60)).padStart(2, '0')}:00.000Z`,
    message_count: 12 + index, unread_message_count: 0, pinned: false, archived: false, role: null,
    linked: { parent_session_id: null, children_count: 0 }, waiting_on_user: false,
  };
}

function bigDirectory(total) {
  const all = Array.from({ length: total }, (_, index) => directoryRow(index));
  const calls = [];
  return { calls, all, directory: { list(args) {
    calls.push(args);
    // like the real directory: a query or an offset filters and pages the sorted chats; `recent` is a 20-chat window
    const needle = String(args.query ?? '').toLowerCase();
    const matches = all.filter(row => row.title.toLowerCase().includes(needle));
    const window = args.scope === 'recent' ? matches.slice(0, 20) : matches;
    const start = args.offset ?? 0;
    const rows = window.slice(start, start + args.limit);
    return { ok: true, scope_kind: 'primary', rows, total: window.length,
      ...(window.length < matches.length ? { total_at_least: true } : {}), truncated: start + rows.length < matches.length };
  } } };
}

test('sessions_list keeps only what picks a chat, and says how to get the rest', async () => {
  const { directory, all } = bigDirectory(30);
  const { context } = harness({ directory });
  const raw = JSON.stringify({ ok: true, scope_kind: 'primary', rows: all.slice(0, 20), truncated: true, note: DIRECTORY_DATA_NOTE });
  const result = await tool.execute({}, context);
  const value = output(result);
  assert.equal(value.rows.length, 10);
  assert.deepEqual(Object.keys(value.rows[0]).sort(), ['last_outcome', 'project', 'project_id', 'session_id', 'status', 'title', 'updated_at']);
  assert.equal(value.rows[0].project, 'JennyGC');
  assert.equal(value.rows[0].project_id, 'project_a1b2c3d4e5f6');
  assert.equal(value.rows[0].status, 'failed');
  assert.equal(value.rows[0].last_outcome, 'completed');
  assert.equal(value.more.remaining, 10);
  assert.equal(value.more.at_least, true, 'recent lists the 20 newest; more exist beyond them');
  assert.match(value.more.how, /offset 10/u);
  assert.ok(result.content.length < raw.length / 3, `${result.content.length} vs ${raw.length}`);
  assert.equal(result.metadata.result_kind, 'sessions_list');
});

test('sessions_list pages with offset and limit', async () => {
  const { directory, all } = bigDirectory(30);
  const { context } = harness({ directory });
  const value = output(await tool.execute({ scope: 'all', offset: 25, limit: 10 }, context));
  assert.deepEqual(value.rows.map(row => row.session_id), all.slice(25, 30).map(row => row.session_id));
  assert.equal(value.more, undefined);
  const first = output(await tool.execute({ scope: 'all', limit: 5 }, context));
  assert.equal(first.rows.length, 5);
  assert.equal(first.more.remaining, 25);
  assert.match(first.more.how, /offset 5/u);
});

test('sessions_list query matches titles case-insensitively and reads past the recent cap', async () => {
  const { directory, calls } = bigDirectory(40);
  const { context } = harness({ directory });
  const value = output(await tool.execute({ query: '  LOGIN ', limit: 50 }, context));
  assert.ok(value.rows.length > 0);
  assert.ok(value.rows.every(row => /login/iu.test(row.title)));
  assert.equal(calls[0].scope, 'all', 'a query searches every chat, not only the 20 most recent');
  assert.equal(calls[0].limit, 50);
  assert.equal(calls[0].query, 'LOGIN');
  const none = output(await tool.execute({ query: 'zzz-no-such-title' }, context));
  assert.deepEqual(none.rows, []);
  assert.match(none.message, /No chat title matches/u);
});

test('sessions_list refuses a bad query or offset before any directory work', async () => {
  const { context, calls } = harness();
  for (const input of [{ query: 7 }, { query: 'q'.repeat(201) }, { offset: -1 }, { offset: 1.5 }, { offset: '2' }, { offset: 1001 }]) {
    assert.deepEqual(output(await tool.execute(input, context)), { ok: false, reason: 'invalid_request' });
  }
  assert.deepEqual(calls, []);
});

// ---------- the directory does the title search and the paging ----------

// A directory that honours query, offset, limit and reports an exact total, like the real one.
function pagingDirectory(total, titleOf = (index) => `Chat ${index}`) {
  const all = Array.from({ length: total }, (_, index) => ({ ...directoryRow(index), title: titleOf(index) }));
  const calls = [];
  return { calls, all, directory: { list(args) {
    calls.push(args);
    const needle = String(args.query ?? '').toLowerCase();
    const matches = all.filter(row => row.title.toLowerCase().includes(needle));
    const rows = matches.slice(args.offset ?? 0, (args.offset ?? 0) + args.limit);
    return { ok: true, scope_kind: 'primary', rows, total: matches.length, truncated: (args.offset ?? 0) + rows.length < matches.length };
  } } };
}

test('sessions_list hands query, offset and limit to the directory and finds a chat past the 50 newest', async () => {
  const { directory, calls } = pagingDirectory(300, index => (index === 250 ? 'Rare haystack needle' : `Chat ${index}`));
  const { context } = harness({ directory });
  const value = output(await tool.execute({ query: ' NEEDLE ', limit: 5 }, context));
  assert.deepEqual(value.rows.map(row => row.title), ['Rare haystack needle']);
  assert.equal(value.more, undefined);
  assert.deepEqual(calls[0], { callerSessionId: 'caller', scope: 'all', project_id: null, include_archived: false,
    limit: 5, query: 'NEEDLE', offset: 0 });
});

test('sessions_list pages past 50 with an exact remaining count', async () => {
  const { directory, all } = pagingDirectory(80);
  const { context } = harness({ directory });
  const value = output(await tool.execute({ scope: 'all', offset: 60, limit: 10 }, context));
  assert.deepEqual(value.rows.map(row => row.session_id), all.slice(60, 70).map(row => row.session_id));
  assert.equal(value.more.remaining, 10);
  assert.equal(value.more.at_least, undefined);
  assert.match(value.more.how, /offset 70/u);
  const tail = output(await tool.execute({ scope: 'all', offset: 1000, limit: 10 }, context));
  assert.deepEqual(tail.rows, []);
  assert.match(tail.message, /No chats at that offset/u);
});

test('sessions_list says at least when the directory total is a lower bound', async () => {
  const directory = { list: () => ({ ok: true, rows: [directoryRow(0)], total: 20, total_at_least: true, truncated: true }) };
  const { context } = harness({ directory });
  const value = output(await tool.execute({ limit: 1 }, context));
  assert.equal(value.more.remaining, 19);
  assert.equal(value.more.at_least, true);
  assert.match(value.more.how, /At least 19 more chats/u);
});

test('the manifest allows an offset past 50 and no longer says 50 most recently active', () => {
  const { parameters } = require('../services/tools/tool-manifest.json').tools.find(entry => entry.name === 'sessions_list');
  assert.ok(parameters.properties.offset.maximum >= 1000);
  assert.doesNotMatch(parameters.properties.query.description + parameters.properties.offset.description, /50 most recently/u);
});
