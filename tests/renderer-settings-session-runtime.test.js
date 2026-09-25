'use strict';

// Settings > Projects (Projects v2, 2026-09-20): one row per project with the
// Current / No folder / Folder missing tags and chat counts, inline Rename,
// Delete behind an inline confirm, the backend's own failure sentence on the
// status line, and the empty state that hands off to the Workspace chooser.

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

function createHarness({ api, state, chooseWorkspaceRoot, clearWorkspaceRoot, renderSessions } = {}) {
  const dom = new JSDOM('<div id="sessionRuntimeSettingsMount"></div>');
  const errors = [];
  const controller = createSessionRuntimeSettingsController({
    windowRef: { document: dom.window.document, jennyShell: { projects: api } },
    documentRef: dom.window.document,
    state: state || { currentSessionId: '', sessions: [], workspaceRoot: { path: '' } },
    showError: (error, title) => errors.push({ error, title }),
    chooseWorkspaceRoot,
    clearWorkspaceRoot,
    renderSessions,
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
  assert.match(ascend.textContent, /2 chats · new chats start here/);
  assert.match(ascend.querySelector('.projects-row-folder').textContent, /D:\\Projects\\Ascend/);
  const general = h.document.querySelector('[data-project-id="project_general"]');
  assert.match(general.textContent, /No folder/);
  assert.match(general.textContent, /2 chats · General never has a folder/);
  assert.equal(general.querySelector('[data-action="projects-delete"]'), null, 'General has no Delete');
  assert.equal(general.querySelector('[data-action="projects-rename"]'), null, 'General has no Rename');
  const grants = h.document.querySelector('[data-project-id="project_grants"]');
  assert.match(grants.textContent, /Folder missing/);
  assert.match(grants.textContent, /0 chats · file tools are off/);
  assert.equal(h.document.querySelector('[data-action="projects-choose-folder"]'), null, 'no empty-state action when projects exist');
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
  assert.match(confirm.textContent, /1 chat move to General\. The folder and its files stay on your disk\./);
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
  h.click('[data-action="projects-choose-folder"]');
  assert.equal(chosen, 1);

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
    callbacks: { handleWorkspaceRootChoose: chooser, clearWorkspaceRoot: clearer },
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
  cleanup();
  assert.equal(disposals, 1);
});
