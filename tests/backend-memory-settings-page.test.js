'use strict';

// Settings > Memory page plumbing (agentic memory v2, row 58 W4): archived
// list, restore, erase, clear forgotten, operations, always-on, Markdown
// export, open USER.md / MEMORY.md, and pending by the queued row's project.
// Every call names its project explicitly; the renderer is never trusted for
// anything else.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  clearForgottenMemories,
  eraseMemory,
  exportMemoriesMarkdown,
  listArchivedMemories,
  listMemoryOperations,
  restoreArchivedMemory,
  setMemoryAlwaysOn,
} = require('../services/backend/backend-memory-settings');
const { acceptPendingMemory, deletePendingMemory } = require('../services/backend/backend-memory');
const { createMemorySettingsIpcHandlers } = require('../services/main/memory-settings-ipc-handlers');
const { PersonalityWorkspaceService } = require('../services/personality-workspace-service');
const fakeMemory = require('./fixtures/fake-sidecar-memory');

function serviceWith(answer = () => ({})) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    projectAuthority: { captureSession: () => ({ project_id: 'project_current' }) },
    projectService: { get: id => ({ project_garden: { name: 'Garden' } })[id] || null },
    sessionStore: { getSessionSummary: id => (id === 'chat-1' ? { title: 'Parser chat' } : null) },
    sidecarClient: {
      request: async (method, params) => {
        calls.push([method, params]);
        return answer(method, params, calls.length);
      },
    },
  };
}

const INVALID = { ok: false, reason: 'invalid' };
const BAD_PROJECTS = [undefined, '', 'garden', 7, {}, `project_${'x'.repeat(129)}`];

test('listArchived pages memory.list archived for the named project only', async () => {
  const pages = [
    { memories: [{ id: 1, lesson_text: 'a', status: 'archived' }], next_cursor: 'c1' },
    { memories: [{ id: 2, lesson_text: 'b', status: 'archived' }, 'junk'], next_cursor: null },
  ];
  const service = serviceWith(() => pages.shift());
  const result = await listArchivedMemories(service, { projectId: 'project_garden' });
  assert.deepEqual(result, { ok: true, memories: [
    { id: 1, lesson_text: 'a', status: 'archived' }, { id: 2, lesson_text: 'b', status: 'archived' }] });
  assert.deepEqual(service.calls.map(([method, params]) => [method, params.status, params.scope, params.project_id,
    params.cursor, params.accept_version !== undefined]), [
    ['memory.list', 'archived', 'project', 'project_garden', null, true],
    ['memory.list', 'archived', 'project', 'project_garden', 'c1', true],
  ]);
  for (const projectId of [...BAD_PROJECTS, null]) {
    assert.deepEqual(await listArchivedMemories(service, { projectId }), INVALID, String(projectId));
  }
  assert.equal(service.calls.length, 2);
});

test('listArchived stops at 2,000 rows and on a repeated cursor', async () => {
  let page = 0;
  const service = serviceWith(() => {
    page += 1;
    return { memories: Array.from({ length: 250 }, (_, index) => ({ id: page * 1000 + index })), next_cursor: `c${page}` };
  });
  const result = await listArchivedMemories(service, { projectId: 'project_general' });
  assert.equal(result.memories.length, 2000);
  assert.equal(service.calls.length, 8);
  const looping = serviceWith(() => ({ memories: [{ id: 1 }], next_cursor: 'same' }));
  assert.equal((await listArchivedMemories(looping, { projectId: 'project_general' })).memories.length, 2);
  assert.equal(looping.calls.length, 2);
});

test('restore sends memory.restore and passes the summarized write result through', async () => {
  const service = serviceWith(() => ({ status: 'saved', operation_id: 'rpc:1', duplicate: false, undoable: true,
    replayed: false, memory: { id: 4, lesson_text: 'tea' } }));
  assert.deepEqual(await restoreArchivedMemory(service, { projectId: 'project_garden', memoryId: 4 }), {
    ok: true, status: 'saved', operation_id: 'rpc:1', duplicate: false, undoable: true, memory: { id: 4, lesson_text: 'tea' } });
  assert.deepEqual(service.calls[0][0], 'memory.restore');
  assert.equal(service.calls[0][1].project_id, 'project_garden');
  assert.equal(service.calls[0][1].memory_id, 4);
  const refused = serviceWith(() => ({ status: 'refused', reason: 'duplicate', code: 'CMP-MEM-0009', memory: null }));
  assert.deepEqual(await restoreArchivedMemory(refused, { projectId: 'project_garden', memoryId: 4 }),
    { ok: true, status: 'refused', reason: 'duplicate' });
  for (const memoryId of [0, -1, 1.5, '4', null]) {
    assert.deepEqual(await restoreArchivedMemory(service, { projectId: 'project_garden', memoryId }), INVALID);
  }
  assert.deepEqual(await restoreArchivedMemory(service, { projectId: null, memoryId: 4 }), INVALID);
  assert.equal('target_project_id' in service.calls[0][1], false, 'a plain restore names no target');
});

test('restore to another project sends the target, which must be another valid project', async () => {
  const service = serviceWith(() => ({ status: 'saved', operation_id: 'rpc:2', duplicate: false, undoable: true,
    replayed: false, memory: { id: 4, lesson_text: 'tea', project_id: 'project_general' } }));
  const answer = await restoreArchivedMemory(service, { projectId: 'project_garden', memoryId: 4, targetProjectId: 'project_general' });
  assert.equal(answer.ok, true);
  const { project_id: project, memory_id: memoryId, target_project_id: target } = service.calls[0][1];
  assert.deepEqual([project, memoryId, target], ['project_garden', 4, 'project_general']);
  for (const targetProjectId of ['project_garden', 'garden', '', 5, null]) {
    assert.deepEqual(await restoreArchivedMemory(service, { projectId: 'project_garden', memoryId: 4, targetProjectId }), INVALID, String(targetProjectId));
  }
  assert.equal(service.calls.length, 1);
});

test('erase sends memory.erase and answers erased or not_found', async () => {
  const answers = [{ status: 'erased' }, { status: 'not_found' }, { status: 'weird' }];
  const service = serviceWith(() => answers.shift());
  assert.deepEqual(await eraseMemory(service, { projectId: 'project_garden', memoryId: 9 }), { ok: true, status: 'erased' });
  assert.deepEqual(await eraseMemory(service, { projectId: 'project_garden', memoryId: 9 }), { ok: true, status: 'not_found' });
  assert.deepEqual(await eraseMemory(service, { projectId: 'project_garden', memoryId: 9 }), { ok: false, reason: 'unexpected_reply' });
  assert.deepEqual(service.calls[0], ['memory.erase', { accept_version: service.calls[0][1].accept_version,
    project_id: 'project_garden', memory_id: 9 }]);
  assert.deepEqual(await eraseMemory(service, { projectId: 'project_garden' }), INVALID);
});

test('clearForgotten clears one project, or every project for an explicit null', async () => {
  const service = serviceWith(() => ({ cleared: 3 }));
  assert.deepEqual(await clearForgottenMemories(service, { projectId: 'project_garden' }), { ok: true, cleared: 3 });
  assert.deepEqual(await clearForgottenMemories(service, { projectId: null }), { ok: true, cleared: 3 });
  assert.equal(service.calls[0][1].project_id, 'project_garden');
  assert.equal(Object.hasOwn(service.calls[1][1], 'project_id'), false, 'null clears every project');
  for (const projectId of BAD_PROJECTS) {
    assert.deepEqual(await clearForgottenMemories(service, { projectId }), INVALID);
  }
  assert.equal(service.calls.length, 2);
});

test('listOperations asks for 50 and keeps only the bounded ledger fields', async () => {
  const service = serviceWith(() => ({ operations: [
    { operation_id: 'rpc:1', op: 'update', origin: 'user', memory_id: 3, result_revision: 2,
      created_at: '2026-10-15T10:00:00Z', expires_at: '2026-10-16T10:00:00Z', undone_at: null, undoable: true,
      before: { lesson_text: 'secret' } },
    { operation_id: 'bad id with spaces', op: 'update' },
    'junk',
  ] }));
  assert.deepEqual(await listMemoryOperations(service, { projectId: 'project_general' }), { ok: true, operations: [
    { operation_id: 'rpc:1', op: 'update', origin: 'user', memory_id: 3, result_revision: 2,
      created_at: '2026-10-15T10:00:00Z', expires_at: '2026-10-16T10:00:00Z', undone_at: null, undoable: true },
  ] });
  assert.deepEqual(service.calls[0][0], 'memory.operations');
  assert.equal(service.calls[0][1].project_id, 'project_general');
  assert.equal(service.calls[0][1].limit, 50);
});

test('setAlwaysOn sends memory.update always_on with the expected revision', async () => {
  const service = serviceWith(() => ({ status: 'saved', operation_id: 'rpc:2', undoable: true, memory: { id: 5, always_on: true } }));
  assert.deepEqual(await setMemoryAlwaysOn(service, { projectId: 'project_garden', memoryId: 5, alwaysOn: true, expectedRevision: 3 }),
    { ok: true, status: 'saved', operation_id: 'rpc:2', undoable: true, memory: { id: 5, always_on: true } });
  const [method, params] = service.calls[0];
  assert.equal(method, 'memory.update');
  assert.deepEqual({ ...params, accept_version: undefined }, { accept_version: undefined, project_id: 'project_garden',
    memory_id: 5, always_on: true, expected_revision: 3 });
  const full = serviceWith(() => ({ status: 'refused', reason: 'always_on_full', code: 'CMP-MEM-0014',
    always_on_lines: ['Use tabs.', 7, 'Reply in English.'] }));
  assert.deepEqual(await setMemoryAlwaysOn(full, { projectId: 'project_garden', memoryId: 5, alwaysOn: true, expectedRevision: 3 }),
    { ok: true, status: 'refused', reason: 'always_on_full', always_on_lines: ['Use tabs.', 'Reply in English.'] });
  for (const bad of [{ alwaysOn: 'yes' }, { expectedRevision: 0 }, { memoryId: 0 }, { projectId: 'nope' }]) {
    assert.deepEqual(await setMemoryAlwaysOn(service, { projectId: 'project_garden', memoryId: 5, alwaysOn: false, ...bad }), INVALID);
  }
});

test('a missing sidecar or a failed request answers a reason, never a throw or memory text in logs', async () => {
  const offline = { _emitServiceLog() {} };
  for (const call of [
    () => listArchivedMemories(offline, { projectId: 'project_general' }),
    () => restoreArchivedMemory(offline, { projectId: 'project_general', memoryId: 1 }),
    () => eraseMemory(offline, { projectId: 'project_general', memoryId: 1 }),
    () => clearForgottenMemories(offline, { projectId: null }),
    () => listMemoryOperations(offline, { projectId: 'project_general' }),
    () => setMemoryAlwaysOn(offline, { projectId: 'project_general', memoryId: 1, alwaysOn: true }),
    () => exportMemoriesMarkdown(offline, { projectId: null }),
  ]) {
    assert.deepEqual(await call(), { ok: false, reason: 'sidecar_unavailable' });
  }
  const failing = serviceWith(() => { throw Object.assign(new Error('boom secret text'), { reason: 'sidecar_timeout' }); });
  assert.deepEqual(await eraseMemory(failing, { projectId: 'project_general', memoryId: 1 }), { ok: false, reason: 'sidecar_timeout' });
  const odd = serviceWith(() => { throw new Error('no reason'); });
  assert.deepEqual(await listMemoryOperations(odd, { projectId: 'project_general' }), { ok: false, reason: 'request_failed' });
  assert.deepEqual(failing.logs.map(entry => [entry.level, entry.event, entry.details]),
    [['WARN', 'memory.settings_request_failed', { method: 'memory.erase', reason: 'sidecar_timeout' }]]);
});

const ROWS = [
  { id: 3, project_id: 'project_garden', scope_session_id: '', lesson_kind: 'fact', lesson_text: 'Tomatoes in bed 2.',
    origin: 'reflection', created_at: '2026-10-14T09:00:00Z', always_on: false, source_excerpt: 'SOURCE-EXCERPT' },
  { id: 1, project_id: 'project_general', scope_session_id: null, lesson_kind: 'preference', lesson_text: 'Prefers\ntabs.',
    origin: 'user', created_at: '2026-10-15T08:00:00Z', always_on: true },
  { id: 2, project_id: 'project_general', scope_session_id: 'chat-1', lesson_kind: 'decision', lesson_text: 'Parser uses tabs.',
    origin: 'tool', created_at: '2026-10-15T09:00:00Z', always_on: false },
  { id: 4, project_id: 'project_gone', scope_session_id: 'chat-missing', lesson_kind: 'lesson', lesson_text: 'Old lesson.',
    origin: 'user', created_at: 'not a date', always_on: false },
];

test('exportMarkdown builds the documented Markdown from every active row', async () => {
  const service = serviceWith(() => ({ memories: ROWS, next_cursor: null }));
  const result = await exportMemoriesMarkdown(service, { projectId: null }, { now: () => new Date(2026, 9, 15, 12) });
  assert.equal(result.ok, true);
  assert.equal(result.defaultName, 'jenny-memories-2026-10-15.md');
  assert.equal(result.markdown, [
    '# Jenny memories',
    '',
    '## General',
    '',
    '- **Preference** Prefers tabs. (always on) _(user, 2026-10-15)_',
    '',
    '### Chat notes',
    '',
    '#### Parser chat',
    '',
    '- **Decision** Parser uses tabs. _(tool, 2026-10-15)_',
    '',
    '## Garden',
    '',
    '- **Fact** Tomatoes in bed 2. _(reflection, 2026-10-14)_',
    '',
    '## project_gone',
    '',
    '### Chat notes',
    '',
    '- **Lesson** Old lesson. _(user)_',
    '',
  ].join('\n'));
  assert.equal(result.markdown.includes('SOURCE-EXCERPT'), false, 'no source excerpts');
  assert.deepEqual(service.calls[0][1].scope, 'all');
});

test('exportMarkdown for one project lists that project only; an empty export says so', async () => {
  const service = serviceWith(() => ({ memories: ROWS.filter(row => row.project_id === 'project_garden'), next_cursor: null }));
  const result = await exportMemoriesMarkdown(service, { projectId: 'project_garden' }, { now: () => new Date(2026, 0, 2) });
  assert.equal(service.calls[0][1].scope, 'project');
  assert.equal(service.calls[0][1].project_id, 'project_garden');
  assert.equal(result.defaultName, 'jenny-memories-2026-01-02.md');
  assert.match(result.markdown, /^# Jenny memories\n\n## Garden\n\n- \*\*Fact\*\*/u);
  const empty = serviceWith(() => ({ memories: [], next_cursor: null }));
  assert.equal((await exportMemoriesMarkdown(empty, { projectId: null })).markdown, '# Jenny memories\n\n_No memories yet._\n');
  assert.deepEqual(await exportMemoriesMarkdown(empty, { projectId: 'garden' }), INVALID);
});

test('pending approve and dismiss use the queued row project when given, else the session project', async () => {
  const service = serviceWith(() => ({ accepted: true, deleted: true, status: 'saved' }));
  await acceptPendingMemory(service, 'session-1', 'SHA256:ABC');
  await acceptPendingMemory(service, 'session-1', 'sha256:abc', 'project_garden');
  await deletePendingMemory(service, 'session-1', 'sha256:abc');
  await deletePendingMemory(service, 'session-1', 'sha256:abc', 'project_garden');
  assert.deepEqual(service.calls.map(([method, params]) => [method, params.project_id, params.session_id, params.content_fingerprint]), [
    ['memory.pending.accept', 'project_current', 'session-1', 'sha256:abc'],
    ['memory.pending.accept', 'project_garden', 'session-1', 'sha256:abc'],
    ['memory.pending.delete', 'project_current', 'session-1', 'sha256:abc'],
    ['memory.pending.delete', 'project_garden', 'session-1', 'sha256:abc'],
  ]);
  await assert.rejects(acceptPendingMemory(service, 'session-1', 'sha256:abc', 'garden'), /projectId is invalid/u);
  await assert.rejects(deletePendingMemory(service, 'session-1', 'sha256:abc', ''), /projectId is invalid/u);
  assert.equal(service.calls.length, 4);
});

function ipcHarness({ backend = {}, dialogAnswer = { canceled: true }, personality = {}, protectedRoots = [] } = {}) {
  const dialogCalls = [];
  const handlers = createMemorySettingsIpcHandlers({
    backendService: backend,
    personalityWorkspace: personality,
    dialog: { async showSaveDialog(...args) { dialogCalls.push(args); return dialogAnswer; } },
    getMainWindow: () => null,
    getProtectedRoots: () => protectedRoots,
    log: () => {},
  });
  return { handlers, dialogCalls };
}

test('the Settings IPC forwards one plain request object per call', async () => {
  const calls = [];
  const backend = {};
  for (const name of ['listArchivedMemories', 'restoreArchivedMemory', 'eraseMemory', 'clearForgottenMemories',
    'listMemoryOperations', 'setMemoryAlwaysOn']) {
    backend[name] = async request => { calls.push([name, request]); return { ok: true }; };
  }
  const { handlers } = ipcHarness({ backend });
  await handlers['memory.listArchived']({}, { projectId: 'project_a' });
  await handlers['memory.restore']({}, { projectId: 'project_a', memoryId: 1 });
  await handlers['memory.erase']({}, 'not-an-object');
  await handlers['memory.clearForgotten']({}, { projectId: null });
  await handlers['memory.listOperations']({}, [1]);
  await handlers['memory.setAlwaysOn']({}, { projectId: 'project_a', memoryId: 1, alwaysOn: true, expectedRevision: 2 });
  assert.deepEqual(calls, [
    ['listArchivedMemories', { projectId: 'project_a' }],
    ['restoreArchivedMemory', { projectId: 'project_a', memoryId: 1 }],
    ['eraseMemory', {}],
    ['clearForgottenMemories', { projectId: null }],
    ['listMemoryOperations', {}],
    ['setMemoryAlwaysOn', { projectId: 'project_a', memoryId: 1, alwaysOn: true, expectedRevision: 2 }],
  ]);
});

test('exportMarkdown saves through the save dialog with the renderer title and default name', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-memory-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'out.md');
  const requests = [];
  const backend = { async exportMemoriesMarkdown(request) {
    requests.push(request);
    return { ok: true, markdown: '# Jenny memories\n', defaultName: 'jenny-memories-2026-10-15.md' };
  } };
  const saved = ipcHarness({ backend, dialogAnswer: { canceled: false, filePath: target } });
  assert.deepEqual(await saved.handlers['memory.exportMarkdown']({}, { projectId: null, title: 'Exporter les souvenirs' }),
    { ok: true, saved: true, path: target });
  assert.equal(fs.readFileSync(target, 'utf8'), '# Jenny memories\n');
  assert.deepEqual(requests, [{ projectId: null }]);
  const options = saved.dialogCalls[0].at(-1);
  assert.equal(options.title, 'Exporter les souvenirs');
  assert.equal(options.defaultPath, 'jenny-memories-2026-10-15.md');
  assert.deepEqual(options.filters[0], { name: 'Markdown', extensions: ['md'] });

  const cancelled = ipcHarness({ backend });
  assert.deepEqual(await cancelled.handlers['memory.exportMarkdown']({}, { projectId: 'project_a' }), { ok: true, saved: false });
  assert.equal(cancelled.dialogCalls[0].at(-1).title, 'Export memories', 'English default title');

  const guarded = ipcHarness({ backend, dialogAnswer: { canceled: false, filePath: path.join(root, 'x.md') }, protectedRoots: [root] });
  assert.deepEqual(await guarded.handlers['memory.exportMarkdown']({}, { projectId: null }), { ok: false, reason: 'save_failed' });

  const refused = ipcHarness({ backend: { exportMemoriesMarkdown: async () => ({ ok: false, reason: 'invalid' }) } });
  assert.deepEqual(await refused.handlers['memory.exportMarkdown']({}, { projectId: 'x' }), { ok: false, reason: 'invalid' });
  assert.equal(refused.dialogCalls.length, 0);
});

test('openContextFile opens only USER.md or MEMORY.md inside the personality workspace', async t => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-memory-open-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const opened = [];
  const workspace = new PersonalityWorkspaceService({ userDataPath, openPathImpl: async target => { opened.push(target); return ''; } });
  const { handlers } = ipcHarness({ personality: workspace });
  assert.deepEqual(await handlers['memory.openContextFile']({}, { name: 'MEMORY.md' }), { ok: true });
  assert.deepEqual(await handlers['memory.openContextFile']({}, { name: 'USER.md' }), { ok: true });
  for (const name of ['PERSONALITY.md', '../MEMORY.md', 'memory.md', 'C:\\Windows\\win.ini', null]) {
    assert.deepEqual(await handlers['memory.openContextFile']({}, { name }), INVALID, String(name));
  }
  assert.deepEqual(await handlers['memory.openContextFile']({}, 'MEMORY.md'), INVALID);
  assert.deepEqual(opened, [path.join(workspace.workspacePath, 'MEMORY.md'), path.join(workspace.workspacePath, 'USER.md')]);
  assert.ok(fs.statSync(opened[0]).isFile(), 'a missing file is created before opening');

  const failing = new PersonalityWorkspaceService({ userDataPath, openPathImpl: async () => 'No application' });
  assert.deepEqual(await failing.openContextFile('MEMORY.md'), { ok: false, reason: 'launch_failed' });
  const noOpener = new PersonalityWorkspaceService({ userDataPath });
  assert.deepEqual(await noOpener.openContextFile('MEMORY.md'), { ok: false, reason: 'unavailable' });
  const { handlers: bare } = ipcHarness({ personality: {} });
  assert.deepEqual(await bare['memory.openContextFile']({}, { name: 'MEMORY.md' }), { ok: false, reason: 'unavailable' });
});

test('the fake sidecar speaks the Settings memory methods', () => {
  const saved = new Map();
  const make = (text, project = 'project_general') => fakeMemory.saveMemory({ session_id: 's', project_id: project,
    candidate: { title: text, lesson_text: text, lesson_kind: 'fact' } }, saved, saved.size + 1).result.memory;
  const kept = make('Kept fact');
  const gone = make('Gone fact');
  fakeMemory.deleteMemory({ memory_id: gone.id }, saved);
  const request = (method, params) => fakeMemory.requestSettingsMemory(method, params, saved);
  assert.deepEqual(request('memory.list', { status: 'archived', scope: 'project', project_id: 'project_general' })
    .memories.map(row => row.id), [gone.id]);
  assert.equal(request('memory.restore', { project_id: 'project_general', memory_id: gone.id }).status, 'saved');
  assert.equal(request('memory.list', { status: 'archived', scope: 'project', project_id: 'project_general' }).memories.length, 0);
  assert.deepEqual(request('memory.erase', { project_id: 'project_general', memory_id: kept.id }), { status: 'erased' });
  assert.deepEqual(request('memory.erase', { project_id: 'project_general', memory_id: kept.id }), { status: 'not_found' });
  assert.ok(Array.isArray(request('memory.operations', { project_id: 'project_general', limit: 50 }).operations));
  assert.equal(typeof request('memory.clear_suppressions', {}).cleared, 'number');
  assert.equal(request('memory.list', { scope: 'all' }), undefined, 'the active list stays with the main dispatcher');
});
