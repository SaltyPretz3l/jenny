'use strict';

// Settings > Projects (Projects v2, 2026-09-20; the manager, 2026-09-27): one
// row per project with the Current / No folder / Folder missing tags and chat
// counts, one primary action and a ⋯ command menu, inline Rename, Delete
// behind an inline confirm, the backend's own failure sentence on the status
// line, and "New project from folder" always in the header.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createSessionRuntimeSettingsController,
  countSessionsByProject,
  sortProjects,
} = require('../renderer/shell/renderer-settings-session-runtime');
const {
  createSettingsSectionBinders,
} = require('../renderer/shell/renderer-settings-section-binders');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function project(id, name, rootPath = null, revision = 0, authorityKey = `${id}:${revision}`) {
  return { id, name, root_path: rootPath, root_revision: revision, authority_key: authorityKey };
}

function createHarness({ api, memoryApi, state, chooseWorkspaceRoot, clearWorkspaceRoot, renderSessions, switcher, setActiveView, setSidebarCollapsed, formatTime } = {}) {
  const dom = new JSDOM('<div id="sessionRuntimeSettingsMount"></div>');
  const errors = [];
  const controller = createSessionRuntimeSettingsController({
    windowRef: { document: dom.window.document, jennyShell: { projects: api, memory: memoryApi } },
    documentRef: dom.window.document,
    state: state || { currentSessionId: '', sessions: [], workspaceRoot: { path: '' } },
    showError: (error, title) => errors.push({ error, title }),
    chooseWorkspaceRoot,
    clearWorkspaceRoot,
    renderSessions,
    setActiveView,
    setSidebarCollapsed,
    formatTime,
    ...(switcher ? { getProjectSwitcher: async () => switcher } : {}),
  });
  const document = dom.window.document;
  return {
    controller,
    document,
    window: dom.window,
    host: document.getElementById('sessionRuntimeSettingsMount'),
    errors,
    click: (selector) => document.querySelector(selector).click(),
    text: () => document.getElementById('sessionRuntimeSettingsMount').textContent,
  };
}

test('projects page lists every project with folder, count and tags; current Workspace project first, General last', async () => {
  let listCalls = 0;
  const api = {
    async list() {
      listCalls += 1;
      return { ok: true, projects: [
        project('project_general', 'General'),
        project('project_budget', 'Budget FY27', 'C:\\Users\\alice\\Documents\\Budget FY27', 1),
        project('project_ascend', 'Ascend', 'D:\\Projects\\Ascend', 2),
        project('project_grants', 'Grants archive', 'D:\\Archive\\Grants', 1, ''),
      ] };
    },
  };
  const state = {
    workspaceRoot: { path: 'd:/projects/ascend/' },
    sessions: [
      { id: 's1', project_id: 'project_ascend' }, { id: 's2', project_id: 'project_ascend' },
      { id: 's3', project_id: 'project_budget' }, { id: 's4' }, { id: 's5', project_id: 'project_general' },
    ],
  };
  const h = createHarness({ api, state });
  assert.equal(listCalls, 0, 'constructing performs no bridge call');
  h.controller.bind();
  await settle();
  assert.equal(listCalls, 1);
  const rows = [...h.document.querySelectorAll('.projects-row')].map((row) => row.dataset.projectId);
  assert.deepEqual(rows, ['project_ascend', 'project_budget', 'project_grants', 'project_general']);
  assert.equal(h.controller.getState().currentProjectId, 'project_ascend', 'separator and case differences do not hide the current project');
  const ascend = h.document.querySelector('[data-project-id="project_ascend"]');
  assert.match(ascend.textContent, /Current/);
  assert.equal(ascend.querySelector('.projects-row-meta').textContent, '2 chats');
  assert.match(ascend.querySelector('.projects-row-folder').textContent, /D:\\Projects\\Ascend/);
  const general = h.document.querySelector('[data-project-id="project_general"]');
  assert.match(general.textContent, /No folder/);
  assert.equal(general.querySelector('.projects-row-meta').textContent, '2 chats');
  assert.equal(general.querySelector('[data-action="projects-delete"]'), null, 'General has no Delete');
  assert.equal(general.querySelector('[data-action="projects-rename"]'), null, 'General has no Rename');
  const grants = h.document.querySelector('[data-project-id="project_grants"]');
  assert.match(grants.textContent, /Folder missing/);
  assert.equal(grants.querySelector('.projects-row-meta').textContent, '0 chats');
  assert.equal(h.document.querySelector('[data-action="projects-choose-folder"]'), null, 'the empty-state-only chooser is gone');
  assert.equal(h.document.querySelector('.settings-badge'), null, 'the Local badge is gone');
  assert.equal(h.document.querySelector('#runtimeProjectSelect'), null, 'the dropdown editor is gone');
  assert.doesNotMatch(h.text(), /Folder revision|Bind folder|Assign conversation|Start work/);
});

test('rename is inline: Enter saves through projects.rename, Escape cancels, and the status names both names', async () => {
  const calls = [];
  let projects = [project('project_general', 'General'), project('project_alpha', 'FY27 budget', 'G:\\alpha', 1)];
  const api = {
    async list() { return { ok: true, projects }; },
    async rename(payload) {
      calls.push(['rename', payload]);
      projects = projects.map((entry) => (entry.id === payload.project_id ? { ...entry, name: payload.name } : entry));
      return { ok: true, project: projects.find((entry) => entry.id === payload.project_id) };
    },
  };
  const h = createHarness({ api });
  h.controller.bind();
  await settle();
  h.click('[data-project-id="project_alpha"] [data-action="projects-rename"]');
  const input = h.document.getElementById('projectsRenameName');
  assert.equal(input.value, 'FY27 budget');
  assert.equal(h.document.activeElement, input, 'the field takes focus');
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.document.getElementById('projectsRenameName'), null, 'Escape cancels');
  assert.deepEqual(calls, []);

  h.click('[data-project-id="project_alpha"] [data-action="projects-rename"]');
  h.document.getElementById('projectsRenameName').value = 'Budget FY27';
  h.document.getElementById('projectsRenameName').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.deepEqual(calls, [['rename', { project_id: 'project_alpha', name: 'Budget FY27' }]]);
  assert.match(h.document.getElementById('runtimeActionStatus').textContent, /Renamed "FY27 budget" to "Budget FY27"/);
  assert.equal(h.document.getElementById('runtimeActionStatus').dataset.tone, 'success');
  assert.match(h.document.querySelector('[data-project-id="project_alpha"]').textContent, /Budget FY27/);
});

test('delete asks first, names the consequences, moves chats to General in state, and closes the Workspace when it was bound', async () => {
  const calls = [];
  let cleared = 0;
  let renders = 0;
  let projects = [
    project('project_general', 'General'),
    project('project_ascend', 'Ascend', 'D:\\Projects\\Ascend', 2),
    project('project_budget', 'Budget FY27', 'C:\\Budget', 1),
  ];
  const api = {
    async list() { return { ok: true, projects }; },
    async delete(payload) {
      calls.push(['delete', payload]);
      const bound = payload.project_id === 'project_ascend';
      projects = projects.filter((entry) => entry.id !== payload.project_id);
      return { ok: true, project: { id: payload.project_id }, moved_sessions: bound ? 2 : 1, workspace_bound: bound };
    },
  };
  const state = {
    workspaceRoot: { path: 'D:\\Projects\\Ascend' },
    sessions: [
      { id: 's1', project_id: 'project_ascend' }, { id: 's2', project_id: 'project_ascend' }, { id: 's3', project_id: 'project_budget' },
    ],
  };
  const h = createHarness({
    api, state,
    clearWorkspaceRoot: async () => { cleared += 1; calls.push(['clear']); state.workspaceRoot.path = ''; return { committed: true, changed: true }; },
    renderSessions: () => { renders += 1; },
  });
  h.controller.bind();
  await settle();

  h.click('[data-project-id="project_budget"] [data-action="projects-delete"]');
  const confirm = h.document.querySelector('[data-project-id="project_budget"] .projects-confirm');
  assert.match(confirm.textContent, /Delete "Budget FY27"\?/);
  assert.match(confirm.textContent, /1 chat moves to General\. The folder and its files stay on your disk\./);
  assert.deepEqual(calls, [], 'nothing is deleted before the confirm');
  h.click('[data-action="projects-delete-cancel"]');
  assert.equal(h.document.querySelector('.projects-confirm'), null);

  h.click('[data-project-id="project_ascend"] [data-action="projects-delete"]');
  assert.match(h.document.querySelector('.projects-confirm').textContent, /It is your current project: the Workspace closes/);
  h.click('[data-action="projects-delete-confirm"]');
  await settle();
  assert.deepEqual(calls, [['clear'], ['delete', { project_id: 'project_ascend' }]], 'the Workspace closes BEFORE the delete');
  assert.equal(cleared, 1, 'the bound Workspace is cleared once');
  assert.equal(renders, 1, 'the chat list is asked to repaint');
  assert.deepEqual(state.sessions.map((row) => row.project_id), ['project_general', 'project_general', 'project_budget']);
  assert.match(h.document.getElementById('runtimeActionStatus').textContent, /Deleted "Ascend"\. 2 chats moved to General\./);
  assert.equal(h.document.querySelector('[data-project-id="project_ascend"]'), null);
});

test('a canceled or refused Workspace close keeps the current project: nothing is deleted or moved', async (t) => {
  for (const outcome of [{ committed: false, canceled: true }, { committed: false, blocked: true, code: 'process_termination_refused' }, null]) {
    const calls = [];
    const projects = [project('project_general', 'General'), project('project_ascend', 'Ascend', 'D:\\Projects\\Ascend', 1)];
    const api = { async list() { return { ok: true, projects }; }, async delete(payload) { calls.push(['delete', payload]); return { ok: true, moved_sessions: 1 }; } };
    const state = { workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [{ id: 's1', project_id: 'project_ascend' }] };
    const h = createHarness({ api, state, clearWorkspaceRoot: async () => { calls.push(['clear']); if (outcome === null) throw new Error('bridge down'); return outcome; } });
    h.controller.bind();
    await settle();
    h.click('[data-project-id="project_ascend"] [data-action="projects-delete"]');
    h.click('[data-action="projects-delete-confirm"]');
    await settle();
    assert.deepEqual(calls, [['clear']], `no delete after ${JSON.stringify(outcome)}`);
    assert.ok(h.document.querySelector('[data-project-id="project_ascend"]'), 'the project is still listed');
    assert.equal(state.sessions[0].project_id, 'project_ascend', 'its chat did not move');
    assert.equal(h.document.querySelector('.projects-confirm'), null, 'the confirm closes');
    assert.match(h.document.getElementById('runtimeActionStatus').textContent, /Nothing deleted: the Workspace stayed open/);
    h.controller.dispose();
  }
});

test('failures show the backend sentence, not the generic one; a missing API shows the generic one', async () => {
  const api = {
    async list() { return { ok: true, projects: [project('project_general', 'General'), project('project_a', 'A', 'G:\\a', 1)] }; },
    async delete() {
      return { ok: false, error: { code: 'CMP-PROJECT-0003', reason: 'session_busy', busy_count: 1,
        message: 'A chat in this project is still working. Wait for it to finish, then try again.' } };
    },
  };
  const h = createHarness({ api });
  h.controller.bind();
  await settle();
  h.click('[data-project-id="project_a"] [data-action="projects-delete"]');
  h.click('[data-action="projects-delete-confirm"]');
  await settle();
  const statusNode = h.document.getElementById('runtimeActionStatus');
  assert.equal(statusNode.textContent, 'A chat in this project is still working. Wait for it to finish, then try again.');
  assert.equal(statusNode.dataset.tone, 'danger');
  assert.equal(h.errors.length, 0, 'a refused request is not an error toast');
  assert.equal(h.document.querySelector('[data-project-id="project_a"]') !== null, true, 'the row stays');

  const none = createHarness({ api: null });
  none.controller.bind();
  await settle();
  assert.match(none.document.getElementById('runtimeActionStatus').textContent, /unavailable in this window/);
});

test('empty state offers the Workspace chooser; read-only disables every action and says why', async () => {
  let chosen = 0;
  const h = createHarness({
    api: { async list() { return { ok: true, projects: [project('project_general', 'General')] }; } },
    state: { sessions: [{ id: 's1' }], workspaceRoot: { path: '' } },
    chooseWorkspaceRoot: async () => { chosen += 1; },
  });
  h.controller.bind();
  await settle();
  assert.match(h.document.getElementById('projectsEmptyHint').textContent, /no Workspace folder yet/);
  assert.equal(h.document.querySelector('[data-action="projects-choose-folder"]'), null, 'the header button replaces the empty-state button');
  h.click('[data-action="projects-new-folder"]');
  await settle();
  assert.equal(chosen, 1, 'without a switcher the header button runs the Workspace folder pick');

  const ro = createHarness({
    api: { async list() { return { ok: true, storage: { read_only: true, reason: 'future_schema' }, projects: [project('project_general', 'General'), project('project_a', 'A', 'G:\\a', 1)] }; } },
  });
  ro.controller.bind();
  await settle();
  assert.match(ro.text(), /Projects are read-only in this window/);
  for (const button of ro.document.querySelectorAll('[data-action]')) assert.equal(button.disabled, true, button.dataset.action);
});

test('stale list completions and completions after disposal are ignored', async () => {
  const first = deferred();
  const third = deferred();
  let calls = 0;
  const api = {
    list() {
      calls += 1;
      if (calls === 1) return first.promise;
      if (calls === 2) return Promise.resolve({ ok: true, projects: [project('project_current', 'Current')] });
      return third.promise;
    },
  };
  const h = createHarness({ api });
  h.controller.bind();
  await h.controller.refresh();
  first.resolve({ ok: true, projects: [project('project_stale', 'Stale')] });
  await settle();
  assert.match(h.text(), /Current/);
  assert.doesNotMatch(h.text(), /Stale/);
  const refresh = h.controller.refresh();
  h.controller.dispose();
  third.resolve({ ok: true, projects: [project('project_after', 'After disposal')] });
  await refresh;
  assert.equal(h.controller.getState().disposed, true);
  assert.doesNotMatch(h.text(), /After disposal/);
});

function createEventHarness({ api, state } = {}) {
  // A real window: the page listens for jenny:projects-changed on it.
  const dom = new JSDOM('<div id="sessionRuntimeSettingsMount"></div>');
  dom.window.jennyShell = { projects: api };
  const controller = createSessionRuntimeSettingsController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    state: state || { currentSessionId: '', sessions: [], workspaceRoot: { path: '' } },
  });
  const announce = (source) => dom.window.dispatchEvent(new dom.window.CustomEvent('jenny:projects-changed', { detail: { source } }));
  const rows = () => [...dom.window.document.querySelectorAll('.projects-row')].map((row) => row.dataset.projectId);
  return { dom, controller, announce, rows, document: dom.window.document, window: dom.window };
}

test('F33: a project created elsewhere (a folder pick through the switcher) is listed without a reload; the page ignores its own announcement', async () => {
  let listCalls = 0;
  let projects = [project('project_general', 'General'), project('project_sandbox', 'sandbox-0923', 'G:\\sandbox-0923', 1)];
  const h = createEventHarness({ api: { async list() { listCalls += 1; return { ok: true, projects }; } } });
  h.controller.bind();
  await settle();
  assert.deepEqual(h.rows(), ['project_sandbox', 'project_general']);
  assert.equal(listCalls, 1);

  // Main provisioned the folder's project; the switcher's post-commit sync
  // announces the change for every other surface.
  projects = [...projects, project('project_fixture', 'a2-fixture-project', 'G:\\a2-fixture-project', 1)];
  h.announce('switcher');
  await settle();
  assert.equal(listCalls, 2, 'an announcement from another surface re-reads the list');
  assert.deepEqual(h.rows(), ['project_fixture', 'project_sandbox', 'project_general'], 'the new project is listed');

  h.announce('settings');
  await settle();
  assert.equal(listCalls, 2, 'its own announcement does not loop back into a re-read');

  h.controller.dispose();
  h.announce('switcher');
  await settle();
  assert.equal(listCalls, 2, 'a disposed page stops listening');
});

test('F33: an announcement never clobbers an open rename field or a rename in flight; the deferred re-read runs afterwards', async () => {
  let listCalls = 0;
  let projects = [project('project_general', 'General'), project('project_alpha', 'Alpha', 'G:\\alpha', 1)];
  const renamed = deferred();
  const api = {
    async list() { listCalls += 1; return { ok: true, projects }; },
    rename(payload) {
      return renamed.promise.then(() => {
        projects = projects.map((entry) => (entry.id === payload.project_id ? { ...entry, name: payload.name } : entry));
        return { ok: true, project: projects.find((entry) => entry.id === payload.project_id) };
      });
    },
  };
  const h = createEventHarness({ api });
  h.controller.bind();
  await settle();
  h.document.querySelector('[data-project-id="project_alpha"] [data-action="projects-rename"]').click();
  h.document.getElementById('projectsRenameName').value = 'Alpha typed';
  projects = [...projects, project('project_beta', 'Beta', 'G:\\beta', 1)];
  h.announce('switcher');
  await settle();
  assert.equal(listCalls, 1, 'no re-read while the rename field is open');
  assert.equal(h.document.getElementById('projectsRenameName').value, 'Alpha typed', 'the typed name survives');

  h.document.querySelector('[data-action="projects-rename-save"]').click();
  h.announce('switcher');
  await settle();
  assert.equal(listCalls, 1, 'no re-read while the rename is in flight');
  renamed.resolve();
  await settle();
  assert.match(h.document.getElementById('runtimeActionStatus').textContent, /Renamed "Alpha" to "Alpha typed"/);
  assert.ok(listCalls >= 2);
  assert.deepEqual(h.rows(), ['project_alpha', 'project_beta', 'project_general'], 'the project announced meanwhile is listed');

  h.document.querySelector('[data-project-id="project_beta"] [data-action="projects-rename"]').click();
  const before = listCalls;
  h.announce('switcher');
  await settle();
  assert.equal(listCalls, before, 'deferred while editing');
  h.document.querySelector('[data-action="projects-rename-cancel"]').click();
  await settle();
  assert.equal(listCalls, before + 1, 'Cancel runs the deferred re-read');
  h.controller.dispose();
});

test('pure helpers: counts default missing project ids to General and sort current first, General last', () => {
  const counts = countSessionsByProject([{ id: 'a' }, { id: 'b', project_id: 'p1' }, { id: 'c', project_id: 'p1' }, null]);
  assert.equal(counts.get('project_general'), 1);
  assert.equal(counts.get('p1'), 2);
  const sorted = sortProjects([
    project('project_general', 'General'), project('z', 'Zeta', 'G:\\z'), project('c', 'Current', 'G:\\c'), project('a', 'Alpha', 'G:\\a'),
  ], 'c').map((entry) => entry.id);
  assert.deepEqual(sorted, ['c', 'a', 'z', 'project_general']);
});

test('binder passes the Workspace callbacks and registers disposal', () => {
  const mount = {};
  const state = { currentSessionId: 'session_1' };
  let received = null;
  let disposals = 0;
  const chooser = async () => {};
  const clearer = async () => {};
  const switcherGetter = async () => null;
  const collapse = () => {};
  const repaint = () => {};
  const windowRef = {
    document: {},
    rendererSettingsSessionRuntime: {
      createSessionRuntimeSettingsController(options) {
        received = options;
        return { bind() {}, dispose() { disposals += 1; } };
      },
    },
  };
  const binder = createSettingsSectionBinders({
    state,
    windowRef,
    getLazySectionDom: () => ({ sessionRuntimeSettingsMount: mount }),
    callbacks: { handleWorkspaceRootChoose: chooser, clearWorkspaceRoot: clearer, getProjectSwitcher: switcherGetter, setSidebarCollapsed: collapse, renderSessions: repaint },
  });
  let cleanup = null;
  let marked = false;
  const result = binder.bindSection('runtime', {
    registerSectionListener() {},
    markSectionBound() { marked = true; },
    addCleanup(callback) { cleanup = callback; },
    finalizeSectionBindings() { return marked; },
  });
  assert.equal(result, true);
  assert.equal(received.host, mount);
  assert.equal(received.chooseWorkspaceRoot, chooser);
  assert.equal(received.clearWorkspaceRoot, clearer);
  assert.equal(received.getProjectSwitcher, switcherGetter, 'the switcher reaches the page');
  assert.equal(received.setSidebarCollapsed, collapse);
  assert.equal(received.renderSessions, repaint);
  cleanup();
  assert.equal(disposals, 1);
});

// ---- The manager (Projects PO review 2026-09-27, Fork 1 A) ----------------

function fakeSwitcher(overrides = {}) {
  const listeners = new Set();
  const calls = [];
  const shown = [];
  let list = [];
  const menu = {
    open: null,
    show(options) { shown.push(options); menu.open = options; return {}; },
    close() { const current = menu.open; menu.open = null; current?.onClose?.(); },
    isOpen() { return Boolean(menu.open); },
  };
  return {
    calls,
    shown,
    menu,
    setList(next) { list = next.slice(); },
    emit(payload) { listeners.forEach((listener) => listener(payload)); },
    listenerCount: () => listeners.size,
    getProjects: () => list.slice(),
    async refreshProjects(options) { calls.push(['refreshProjects', options]); return list.slice(); },
    onProjectsChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async openProjectAsWorkspace(id) { calls.push(['openProjectAsWorkspace', id]); return { committed: true }; },
    async locateProjectFolder(id) { calls.push(['locateProjectFolder', id]); return { ok: true }; },
    async newChatInProject(id) { calls.push(['newChatInProject', id]); return 'session_new'; },
    async newProjectFromFolder() { calls.push(['newProjectFromFolder']); return { committed: true }; },
    ...overrides,
  };
}

function managerProjects() {
  return [
    project('project_general', 'General'),
    { ...project('project_ascend', 'Ascend', 'D:\\Projects\\Ascend', 2), folder_exists: true, is_current: true },
    { ...project('project_budget', 'Budget FY27', 'C:\\Budget', 1), folder_exists: true, is_current: false },
    { ...project('project_grants', 'Grants', 'D:\\Archive\\Grants', 1), folder_exists: false, is_current: false },
  ];
}

async function managerHarness(extra = {}) {
  let listCalls = 0;
  const projects = extra.projects || managerProjects();
  const switcher = extra.switcher === null ? null : (extra.switcher || fakeSwitcher());
  if (switcher) switcher.setList(projects);
  const api = {
    async list() { listCalls += 1; return { ok: true, projects }; },
    ...(extra.api || {}),
  };
  const h = createHarness({ api, switcher, state: extra.state, ...(extra.options || {}) });
  h.controller.bind();
  await settle();
  return { ...h, switcher, listCalls: () => listCalls };
}

const rowOf = (h, id) => h.document.querySelector(`.projects-row[data-project-id="${id}"]`);
const primaryOf = (h, id) => rowOf(h, id).querySelector('[data-row-primary]');
const pickFromMenu = (h, projectId, rowId) => {
  rowOf(h, projectId).querySelector('[data-action="projects-more"]').click();
  const menu = h.switcher.shown[h.switcher.shown.length - 1];
  menu.onPick(menu.rows.find((row) => row.id === rowId));
};

test('manager: "New project from folder" is always in the header and runs the switcher\'s folder pick', async () => {
  for (const projects of [managerProjects(), [project('project_general', 'General')]]) {
    const h = await managerHarness({ projects });
    const create = h.document.querySelector('.settings-card-header [data-action="projects-new-folder"]');
    assert.ok(create, 'the header carries the create button');
    assert.equal(create.textContent.trim(), 'New project from folder');
    assert.ok(create.classList.contains('btn--primary'));
    assert.equal(create.disabled, false);
    assert.match(h.text(), /A project is a folder Jenny works in\. Its chats, memories and file access stay with it\./);
    create.click();
    await settle();
    assert.deepEqual(h.switcher.calls, [['newProjectFromFolder']]);
    h.controller.dispose();
  }
  const ro = await managerHarness({ api: { async list() { return { ok: true, storage: { read_only: true }, projects: managerProjects() }; } } });
  assert.equal(ro.document.querySelector('[data-action="projects-new-folder"]').disabled, true, 'present but disabled while read-only');
});

test('manager: one primary action per row: Show chats (current, General), Open (another folder), Locate folder (missing)', async () => {
  const h = await managerHarness();
  assert.equal(primaryOf(h, 'project_ascend').dataset.action, 'projects-show-chats');
  assert.equal(primaryOf(h, 'project_ascend').textContent.trim(), 'Show chats');
  assert.equal(primaryOf(h, 'project_general').dataset.action, 'projects-show-chats');
  assert.equal(primaryOf(h, 'project_budget').dataset.action, 'projects-open');
  assert.equal(primaryOf(h, 'project_budget').textContent.trim(), 'Open');
  assert.equal(primaryOf(h, 'project_grants').dataset.action, 'projects-locate');
  assert.equal(primaryOf(h, 'project_grants').textContent.trim(), 'Locate folder');
  for (const row of h.document.querySelectorAll('.projects-row')) {
    assert.equal(row.querySelectorAll('[data-row-primary]').length, 1, row.dataset.projectId);
    assert.ok(!row.querySelector('[data-row-primary]').classList.contains('btn--ghost'), 'the primary is a secondary .btn');
  }
  assert.match(rowOf(h, 'project_grants').textContent, /Folder missing/, 'folder_exists=false is the missing tag');
  primaryOf(h, 'project_budget').click();
  primaryOf(h, 'project_grants').click();
  await settle();
  assert.deepEqual(h.switcher.calls, [['openProjectAsWorkspace', 'project_budget'], ['locateProjectFolder', 'project_grants']]);
});

test('manager: is_current from main wins over the renderer\'s folder compare', async () => {
  const h = await managerHarness({ state: { sessions: [], workspaceRoot: { path: 'C:\\Budget' } } });
  assert.equal(h.controller.getState().currentProjectId, 'project_ascend');
  assert.match(rowOf(h, 'project_ascend').textContent, /Current/);
  assert.doesNotMatch(rowOf(h, 'project_budget').textContent, /Current/);
});

test('manager: a missing contract function hides its action instead of throwing', async () => {
  const bare = fakeSwitcher({ openProjectAsWorkspace: undefined, locateProjectFolder: undefined, newChatInProject: undefined });
  const h = await managerHarness({ switcher: bare });
  assert.equal(rowOf(h, 'project_grants').querySelector('[data-row-primary]'), null, 'no Locate without locateProjectFolder');
  assert.equal(rowOf(h, 'project_budget').querySelector('[data-row-primary]'), null, 'no Open without an open function');
  rowOf(h, 'project_budget').querySelector('[data-action="projects-more"]').click();
  assert.deepEqual(h.switcher.shown[0].rows.map((row) => row.id), ['show-chats', 'rename', 'delete']);
});

test('manager: the ⋯ menu lists commands per state; General has none and the current project has no Open', async () => {
  const h = await managerHarness();
  assert.equal(rowOf(h, 'project_general').querySelector('[data-action="projects-more"]'), null, 'General has no ⋯');
  const more = rowOf(h, 'project_budget').querySelector('[data-action="projects-more"]');
  assert.equal(more.getAttribute('aria-label'), 'More actions for Budget FY27');
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  assert.ok(more.classList.contains('btn--ghost'));
  more.click();
  const menu = h.switcher.shown[0];
  assert.equal(menu.anchor, more);
  assert.deepEqual(menu.rows.map((row) => row.id), ['open', 'new-chat', 'show-chats', 'change-folder', 'rename', 'delete']);
  assert.deepEqual(menu.rows.map((row) => row.label), ['Open as Workspace', 'New chat here', 'Show chats', 'Change folder…', 'Rename', 'Delete…']);
  assert.ok(menu.rows.every((row) => row.kind === 'action'), 'command mode');
  assert.deepEqual(menu.rows.filter((row) => row.separatorBefore).map((row) => row.id), ['change-folder', 'delete'], 'hairlines before Change folder and Delete');
  assert.equal(menu.rows.find((row) => row.id === 'delete').danger, true);
  assert.equal(menu.rows.some((row) => row.id === 'reveal'), false, 'no id-based reveal exists yet');

  rowOf(h, 'project_ascend').querySelector('[data-action="projects-more"]').click();
  assert.deepEqual(h.switcher.shown[1].rows.map((row) => row.id), ['new-chat', 'show-chats', 'change-folder', 'rename', 'delete'], 'current: no Open as Workspace');
  rowOf(h, 'project_grants').querySelector('[data-action="projects-more"]').click();
  assert.equal(h.switcher.shown[2].rows.some((row) => row.id === 'open'), false, 'a missing folder cannot be opened');
});

test('manager: Reveal folder appears only with the id-only IPC and a present folder, and sends just the id', async () => {
  const reveals = [];
  const h = await managerHarness({ api: {
    async revealFolder(payload) { reveals.push(payload); return reveals.length === 1 ? { ok: true } : { ok: false, error: { message: 'The project folder is missing. Locate it first.' } }; },
  } });
  rowOf(h, 'project_budget').querySelector('[data-action="projects-more"]').click();
  const rows = h.switcher.shown[0].rows.map((row) => row.id);
  assert.deepEqual(rows, ['open', 'new-chat', 'show-chats', 'reveal', 'change-folder', 'rename', 'delete']);
  rowOf(h, 'project_grants').querySelector('[data-action="projects-more"]').click();
  assert.equal(h.switcher.shown[1].rows.some((row) => row.id === 'reveal'), false, 'no Reveal for a missing folder');
  pickFromMenu(h, 'project_budget', 'reveal');
  await settle();
  assert.deepEqual(reveals, [{ project_id: 'project_budget' }]);
  pickFromMenu(h, 'project_budget', 'reveal');
  await settle();
  assert.match(h.document.body.textContent, /The project folder is missing\. Locate it first\./);
});

test('manager: menu commands run the switcher; Show chats sets the Chats filter and navigates to Chats', async () => {
  const views = [];
  const collapsed = [];
  let repaints = 0;
  const state = { ui: { chatsProjectFilter: '', activeView: 'settings', activeSettingsSection: 'runtime' }, sessions: [], workspaceRoot: { path: '' } };
  const h = await managerHarness({ state, options: { setActiveView: (view) => views.push(view), setSidebarCollapsed: (value) => collapsed.push(value), renderSessions: () => { repaints += 1; } } });
  pickFromMenu(h, 'project_budget', 'open');
  pickFromMenu(h, 'project_budget', 'new-chat');
  pickFromMenu(h, 'project_budget', 'change-folder');
  await settle();
  assert.deepEqual(h.switcher.calls, [['openProjectAsWorkspace', 'project_budget'], ['newChatInProject', 'project_budget'], ['locateProjectFolder', 'project_budget']]);
  assert.deepEqual(views, ['chat'], 'New chat here opens the new chat (N7)');
  pickFromMenu(h, 'project_budget', 'show-chats');
  assert.equal(state.ui.chatsProjectFilter, 'project_budget');
  assert.deepEqual(views, ['chat', 'chat']);
  assert.deepEqual(collapsed, [false]);
  assert.equal(repaints, 1);
  primaryOf(h, 'project_general').click();
  assert.equal(state.ui.chatsProjectFilter, 'project_general', 'General\'s Show chats');
  pickFromMenu(h, 'project_budget', 'rename');
  assert.equal(h.document.activeElement, h.document.getElementById('projectsRenameName'), 'Rename opens the inline field');
});

test('manager: the delete confirm names the memory move in both variants and takes focus on its confirm button', async () => {
  const h = await managerHarness({ state: { sessions: [{ id: 's1', project_id: 'project_budget' }], workspaceRoot: { path: '' } } });
  for (const id of ['project_budget', 'project_ascend']) {
    pickFromMenu(h, id, 'delete');
    const confirm = rowOf(h, id).querySelector('.projects-confirm');
    assert.match(confirm.textContent, /Its memories and knowledge folders move to General\./, id);
    assert.match(confirm.textContent, id === 'project_ascend' ? /It is your current project.* 0 chats move to General\./ : /1 chat moves to General/);
    assert.equal(h.document.activeElement, confirm.querySelector('[data-action="projects-delete-confirm"]'), 'the confirm button has focus');
    confirm.querySelector('[data-action="projects-delete-cancel"]').click();
    assert.equal(h.document.activeElement, rowOf(h, id).querySelector('[data-action="projects-more"]'), 'Cancel returns focus to the row\'s ⋯');
  }
});

test('manager: a re-render restores focus to the same control by project and action (D13)', async () => {
  const h = await managerHarness();
  const open = primaryOf(h, 'project_budget');
  open.focus();
  assert.equal(h.document.activeElement, open);
  h.switcher.emit({ projects: managerProjects() });
  await settle();
  const fresh = primaryOf(h, 'project_budget');
  assert.notEqual(fresh, open, 'the row was re-rendered');
  assert.equal(h.document.activeElement, fresh, 'focus followed to the new Open button');

  const more = rowOf(h, 'project_grants').querySelector('[data-action="projects-more"]');
  more.focus();
  more.click();
  // Focus is inside the menu (outside the page) when a change repaints it.
  h.document.activeElement.blur();
  h.switcher.emit({ projects: managerProjects() });
  await settle();
  assert.equal(more.isConnected, false, 'the anchor was replaced');
  h.switcher.menu.close();
  assert.equal(h.document.activeElement, rowOf(h, 'project_grants').querySelector('[data-action="projects-more"]'), 'closing the menu returns focus to the fresh ⋯');
});

test('manager: switcher changes repaint from its cache without a list read; rename syncs through the switcher once', async () => {
  const h = await managerHarness();
  assert.equal(h.listCalls(), 1, 'one read on bind (the storage flag)');
  assert.equal(h.switcher.listenerCount(), 1, 'subscribed to onProjectsChanged');
  const renamed = managerProjects().map((entry) => (entry.id === 'project_budget' ? { ...entry, name: 'Budget FY28' } : entry));
  h.switcher.setList(renamed);
  h.switcher.emit({ projects: renamed });
  await settle();
  assert.match(rowOf(h, 'project_budget').textContent, /Budget FY28/);
  assert.equal(h.listCalls(), 1, 'no projects.list read for a change notification');

  let projects = managerProjects();
  const switcher = fakeSwitcher();
  const r = await managerHarness({
    switcher,
    api: {
      async rename(payload) {
        projects = projects.map((entry) => (entry.id === payload.project_id ? { ...entry, name: payload.name } : entry));
        switcher.setList(projects);
        return { ok: true, project: projects.find((entry) => entry.id === payload.project_id) };
      },
    },
  });
  pickFromMenu(r, 'project_budget', 'rename');
  r.document.getElementById('projectsRenameName').value = 'Budget FY29';
  r.document.getElementById('projectsRenameName').dispatchEvent(new r.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.deepEqual(switcher.calls, [['refreshProjects', { force: true }]], 'the switcher re-reads once and tells every surface');
  assert.equal(r.listCalls(), 1, 'the page itself does not re-read');
  assert.match(rowOf(r, 'project_budget').textContent, /Budget FY29/);
  assert.equal(r.document.activeElement, rowOf(r, 'project_budget').querySelector('[data-action="projects-more"]'), 'focus lands on the renamed row\'s ⋯');
  r.controller.dispose();
  assert.equal(switcher.listenerCount(), 0, 'dispose unsubscribes');
});

test('manager: the meta line reads "{n} chats · last used {age}" from the newest chat and omits the age without chats', async () => {
  const seen = [];
  const h = await managerHarness({
    state: { sessions: [
      { id: 's1', project_id: 'project_budget', updated_at: '2026-09-20T10:00:00.000Z' },
      { id: 's2', project_id: 'project_budget', updated_at: '2026-09-26T09:00:00.000Z' },
    ], workspaceRoot: { path: '' } },
    options: { formatTime: (value) => { seen.push(value); return '5m'; } },
  });
  assert.equal(rowOf(h, 'project_budget').querySelector('.projects-row-meta').textContent, '2 chats · last used 5m');
  assert.ok(seen.includes('2026-09-26T09:00:00.000Z'), 'the newest chat sets the age');
  assert.equal(rowOf(h, 'project_grants').querySelector('.projects-row-meta').textContent, '0 chats');
  const order = [...h.document.querySelectorAll('.projects-row')].map((row) => row.dataset.projectId);
  assert.deepEqual(order, ['project_ascend', 'project_budget', 'project_grants', 'project_general'], 'current, most recently used, name, General last');
});

test('manager: without the shared menu (no switcher) Rename and Delete stay inline', async () => {
  const h = await managerHarness({ switcher: null });
  const row = rowOf(h, 'project_budget');
  assert.equal(row.querySelector('[data-action="projects-more"]'), null);
  assert.ok(row.querySelector('[data-action="projects-rename"]'));
  assert.ok(row.querySelector('[data-action="projects-delete"]'));
  assert.equal(primaryOf(h, 'project_ascend').dataset.action, 'projects-show-chats', 'Show chats needs no switcher');
});

test('N5/N7: the delete confirm agrees in number and names the memory count; a failed New chat here stays put', async () => {
  const memoryApi = { async listApproved() {
    return { memories: [{ id: 1, project_id: 'project_budget' }, { id: 2, project_id: 'project_budget' }, { id: 3, project_id: 'project_general' }] };
  } };
  const views = [];
  const h = await managerHarness({
    state: { sessions: [{ id: 's1', project_id: 'project_budget' }, { id: 's2', project_id: 'project_budget' }, { id: 's3', project_id: 'project_grants' }], workspaceRoot: { path: '' } },
    switcher: fakeSwitcher({ async newChatInProject() { return null; } }),
    options: { memoryApi, setActiveView: (view) => views.push(view) },
  });
  pickFromMenu(h, 'project_budget', 'delete');
  const confirmText = () => rowOf(h, 'project_budget').querySelector('.projects-confirm').textContent;
  assert.match(confirmText(), /2 chats move to General\./);
  assert.match(confirmText(), /Its memories and knowledge folders move to General\./, 'generic until the count lands');
  await settle();
  assert.match(confirmText(), /2 memories and the project's knowledge folders move to General\./);
  assert.equal(h.document.activeElement?.dataset.action, 'projects-delete-confirm', 'the count repaint keeps focus on the confirm');
  rowOf(h, 'project_budget').querySelector('[data-action="projects-delete-cancel"]').click();
  pickFromMenu(h, 'project_grants', 'delete');
  await settle();
  const grants = rowOf(h, 'project_grants').querySelector('.projects-confirm').textContent;
  assert.match(grants, /1 chat moves to General\./);
  assert.match(grants, /0 memories and the project's knowledge folders move to General\./);
  pickFromMenu(h, 'project_budget', 'new-chat');
  await settle();
  assert.deepEqual(views, [], 'no chat was created: the view stays on Settings');
});

test('N7: a New chat here that lands after the user left Settings › Projects does not pull them back (Astra review)', async () => {
  let resolveCreate = null;
  const views = [];
  // The Projects section keeps the registry id `runtime` (persisted section ids resolve).
  const state = { ui: { activeView: 'settings', activeSettingsSection: 'runtime' }, sessions: [], workspaceRoot: { path: '' } };
  const h = await managerHarness({
    state,
    switcher: fakeSwitcher({ newChatInProject() { return new Promise((resolve) => { resolveCreate = resolve; }); } }),
    options: { setActiveView: (view) => views.push(view) },
  });
  pickFromMenu(h, 'project_budget', 'new-chat');
  await settle();
  state.ui.activeView = 'ide'; // the user moved on while the chat was still being created
  resolveCreate('sess_new');
  await settle();
  assert.deepEqual(views, [], 'the later navigation wins');
  state.ui.activeView = 'settings';
  pickFromMenu(h, 'project_budget', 'new-chat');
  await settle();
  resolveCreate('sess_new_2');
  await settle();
  assert.deepEqual(views, ['chat'], 'still on the page when it lands: the new chat opens');
});
