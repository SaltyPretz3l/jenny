'use strict';

// Row 94 P2: the port behind project_create / projects_list and Activity's Undo of a created project.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrimaryChatPlacementService } = require('../services/primary-chat-placement-service');

const PRIMARY = 'p1';
const CHANGE_ID = /^sc_[0-9a-f]{32}$/;
// Folders that exist in the fake filesystem; `G:\link` is a junction into `G:\real`.
const DIRS = new Map([['G:\\Work\\app', 'G:\\Work\\app'], ['G:\\link', 'G:\\real'], ['G:\\real', 'G:\\real'],
  ['G:\\Work\\taken', 'G:\\Work\\taken'], ['C:\\Users\\pat', 'C:\\Users\\pat']]);

function canonicalize(folder) {
  const key = [...DIRS.keys()].find((dir) => dir.toLowerCase() === require('path').win32.resolve(String(folder)).replace(/[\\/]+$/, '').toLowerCase());
  if (!key) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return DIRS.get(key);
}

function harness({ flags = {}, primary = PRIMARY, bindFails = false, bindTo = null, hostMode = 'desktop', resolve = canonicalize, timeoutMs } = {}) {
  let nextId = 1;
  const projects = new Map([['general', { id: 'general', name: 'General', root_path: null, root_id: null, root_revision: 0 }]]);
  const { workspaceRootId } = require('../services/workspace-root-identity');
  const taken = { id: 'pr_taken', name: 'Taken', root_path: 'G:\\Work\\taken', root_id: workspaceRootId('G:\\Work\\taken', { platform: 'win32' }), root_revision: 1 };
  projects.set(taken.id, taken);
  const sessions = [{ id: PRIMARY, project_id: 'general', session_role: 'primary', updated_at: '2026-11-02T10:00:00Z' },
    { id: 's1', project_id: 'pr_taken', updated_at: '2026-11-02T09:00:00Z' },
    { id: 's2', project_id: 'pr_taken', updated_at: '2026-11-01T09:00:00Z', archived_at: '2026-11-01T10:00:00Z' }];
  const history = [];
  const emitted = [];
  const deleted = [];
  const projectService = {
    list: () => [...projects.values()],
    get: (id) => (projects.has(id) ? { ...projects.get(id) } : null),
    remove: (id) => (projects.delete(id) ? { ok: true } : { ok: false }),
  };
  const projectApp = {
    createProject: ({ name }) => {
      const id = `pr_${nextId++}`;
      projects.set(id, { id, name, root_path: null, root_id: null, root_revision: 0, updated_at: '2026-11-02T08:00:00Z' });
      return { ok: true, project: { id, name } };
    },
    bindProjectRoot: ({ project_id: id, root_path: root }) => {
      if (bindFails) return { ok: false, error: { reason: bindFails === true ? 'stale_root_revision' : bindFails } };
      if (bindTo) root = bindTo;
      Object.assign(projects.get(id), { root_path: root, root_id: workspaceRootId(root, { platform: 'win32' }), root_revision: 1 });
      return { ok: true, project: projects.get(id) };
    },
    async listProjectsWithStatus() {
      return { ok: true, projects: [...projects.values()].map((project) => ({ ...project, folder_exists: project.root_path ? true : null, is_current: project.id === 'general' })) };
    },
    async deleteProject({ project_id: id }) { deleted.push(id); projects.delete(id); return { ok: true }; },
  };
  const service = createPrimaryChatPlacementService({
    projectApplicationService: () => projectApp, projectService: () => projectService, sessionStore: () => ({ listSessions: () => sessions }),
    controls: () => ({ recordChatChange: (entry) => { history.push(entry); return true; } }),
    featureFlags: () => flags, primarySessionId: () => primary, hostMode: () => hostMode,
    emitSessionsChanged: (payload) => emitted.push(payload),
    platform: 'win32', env: { APPDATA: 'C:\\Users\\pat\\AppData\\Roaming' }, homedir: () => 'C:\\Users\\pat', canonicalize: resolve,
    ...(timeoutMs ? { canonicalizeTimeoutMs: timeoutMs } : {}),
  });
  return { service, projects, sessions, history, emitted, deleted };
}

const card = (service, extra = {}) => service.prepareCard({ session_id: PRIMARY, tool_call_id: 'c1', name: 'App', folder: 'G:\\Work\\app', ...extra });

test('a carded request creates the project, binds the canonical folder and records one history row', async () => {
  const h = harness();
  assert.deepEqual((await card(h.service)), { ok: true, name: 'App', folder: 'G:\\Work\\app' });
  const answer = await h.service.create({ caller_session_id: PRIMARY, tool_call_id: 'c1', name: 'App', folder: 'G:\\Work\\app' });
  assert.equal(answer.ok, true);
  assert.match(answer.change_id, CHANGE_ID);
  assert.equal(h.projects.get(answer.project_id).root_path, 'G:\\Work\\app');
  assert.deepEqual(h.history.map(({ action, field, before, after, session_id: s }) => [action, field, before, after, s]),
    [['project_create', 'project', null, answer.project_id, PRIMARY]]);
  assert.deepEqual(h.emitted, [{ session_ids: [PRIMARY], projects_changed: true }]);
});

test('no card, another call, or changed arguments never write', async () => {
  const h = harness();
  assert.equal((await h.service.create({ caller_session_id: PRIMARY, tool_call_id: 'c1', name: 'App', folder: 'G:\\Work\\app' })).reason, 'stale');
  (await card(h.service));
  assert.equal((await h.service.create({ caller_session_id: PRIMARY, tool_call_id: 'c2', name: 'App', folder: 'G:\\Work\\app' })).reason, 'stale');
  assert.equal((await h.service.create({ caller_session_id: PRIMARY, tool_call_id: 'c1', name: 'Other', folder: 'G:\\Work\\app' })).reason, 'stale');
  // The mismatched attempt spent the card: a retry with the shown arguments needs a new card.
  assert.equal((await h.service.create({ caller_session_id: PRIMARY, tool_call_id: 'c1', name: 'App', folder: 'G:\\Work\\app' })).reason, 'stale');
  assert.equal(h.projects.size, 2);
});

test('the card refuses junctions, missing, protected and already-bound folders with what the model needs', async () => {
  const h = harness();
  assert.deepEqual((await card(h.service, { folder: 'G:\\link' })), { ok: false, reason: 'resolves_elsewhere', folder: 'G:\\real' });
  assert.equal((await card(h.service, { folder: 'G:\\nowhere' })).reason, 'missing');
  assert.equal((await card(h.service, { folder: 'C:\\Users\\pat' })).reason, 'home_folder');
  assert.deepEqual((await card(h.service, { folder: 'g:\\work\\TAKEN' })), { ok: false, reason: 'exists', project_id: 'pr_taken', project_name: 'Taken' });
  assert.equal((await card(h.service, { name: '  ' })).reason, 'invalid_input');
  assert.equal((await card(h.service, { name: 'a\u200bb' })).reason, 'invalid_input');
  assert.equal((await card(h.service, { folder: 'G:\\real' })).ok, true);
});

test('only the primary chat on desktop with the switch on', async () => {
  assert.equal((await card(harness({ primary: 'other' }).service)).reason, 'not_allowed');
  assert.equal((await card(harness({ flags: { primary_chat_placement: false } }).service)).reason, 'disabled');
  assert.equal((await card(harness({ hostMode: 'server' }).service)).reason, 'disabled');
  assert.equal((await harness({ primary: 'other' }).service.list({ caller_session_id: PRIMARY })).reason, 'not_allowed');
});

test('a failed bind removes the new, empty project', async () => {
  const h = harness({ bindFails: true });
  (await card(h.service));
  const answer = await h.service.create({ caller_session_id: PRIMARY, tool_call_id: 'c1', name: 'App', folder: 'G:\\Work\\app' });
  assert.deepEqual(answer, { ok: false, reason: 'unavailable' });
  assert.deepEqual([...h.projects.keys()], ['general', 'pr_taken']);
  assert.equal(h.history.length, 0);
});

test('projects_list counts unarchived chats, skips the primary and sorts by latest activity', async () => {
  const h = harness();
  const answer = await h.service.list({ caller_session_id: PRIMARY });
  assert.equal(answer.ok, true);
  const taken = answer.projects.find((project) => project.id === 'pr_taken');
  assert.deepEqual(taken, { id: 'pr_taken', name: 'Taken', folder: 'G:\\Work\\taken', folder_state: 'ok', chat_count: 1,
    last_activity_at: '2026-11-02T09:00:00Z', is_workspace: false });
  const general = answer.projects.find((project) => project.id === 'general');
  assert.equal(general.folder_state, 'none');
  assert.equal(general.chat_count, 0);
  assert.equal(general.is_workspace, true);
});

test('undo removes the project while it is empty and bound once, else changed_since', async () => {
  const h = harness();
  (await card(h.service));
  const created = await h.service.create({ caller_session_id: PRIMARY, tool_call_id: 'c1', name: 'App', folder: 'G:\\Work\\app' });
  const entry = h.history[0];
  h.sessions.push({ id: 's9', project_id: created.project_id, updated_at: '2026-11-02T11:00:00Z' });
  assert.equal((await h.service.undoCreate(entry)).reason, 'changed_since');
  h.sessions.pop();
  h.projects.get(created.project_id).root_revision = 2;
  assert.equal((await h.service.undoCreate(entry)).reason, 'changed_since');
  h.projects.get(created.project_id).root_revision = 1;
  assert.deepEqual(await h.service.undoCreate(entry), { ok: true });
  assert.deepEqual(h.deleted, [created.project_id]);
  assert.deepEqual(h.emitted.at(-1), { session_ids: [PRIMARY], projects_changed: true });
  assert.equal((await h.service.undoCreate(entry)).reason, 'unknown');
  assert.equal((await h.service.undoCreate({ ...entry, action: 'rename' })).reason, 'unknown');
});

test('a folder whose probe stalls or throws refuses instead of blocking the card', async () => {
  const stalled = harness({ resolve: () => new Promise(() => {}), timeoutMs: 20 });
  assert.deepEqual(await card(stalled.service), { ok: false, reason: 'unavailable' });
  const denied = harness({ resolve: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
  assert.deepEqual(await card(denied.service), { ok: false, reason: 'unavailable' });
});

test('review fixes: a dotted spelling, a folder taken meanwhile, and a bind that lands elsewhere', async () => {
  const h = harness();
  assert.deepEqual(await card(h.service, { folder: 'G:\\Work\\x\\..\\app' }),
    { ok: false, reason: 'resolves_elsewhere', folder: 'G:\\Work\\app' });
  assert.equal((await card(h.service, { folder: 'g:/work/app/' })).ok, true, 'case, slash direction and a trailing slash are the same folder');
  // The bind says the folder is a project now, yet no project holds it when re-read: never a success.
  const taken = harness({ bindFails: 'folder_already_project' });
  await card(taken.service);
  assert.deepEqual(await taken.service.create({ caller_session_id: PRIMARY, tool_call_id: 'c1', name: 'App', folder: 'G:\\Work\\app' }),
    { ok: false, reason: 'unavailable' });
  const moved = harness({ bindTo: 'G:\\real' });
  await card(moved.service);
  assert.deepEqual(await moved.service.create({ caller_session_id: PRIMARY, tool_call_id: 'c1', name: 'App', folder: 'G:\\Work\\app' }),
    { ok: false, reason: 'stale' });
  assert.deepEqual([...moved.projects.keys()], ['general', 'pr_taken']);
  assert.equal(moved.history.length, 0);
});
