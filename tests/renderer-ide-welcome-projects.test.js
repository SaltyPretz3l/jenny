'use strict';

// Projects v2 (2026-09-20): the Workspace welcome page. No folder open: the
// copy says a folder becomes a project, the primary action is "Choose a
// folder…", and existing projects are one click away under "Your projects".
// Folder open: "Switch project…" opens the shared project menu. Both repaint
// on `jenny:projects-changed`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeWelcome } = require('../renderer/features/renderer-ide-welcome');
const actionButton = require('../renderer/inventory/action-button');

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function makeHarness(t, { rootPath, projects, switcher } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="ideEmptyState"><p id="ideEmptyStateCopy"></p><div id="ideEmptyStateAction" class="hidden"></div></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const doc = dom.window.document;
  const getDom = () => ({
    ideEmptyState: doc.getElementById('ideEmptyState'),
    ideEmptyStateCopy: doc.getElementById('ideEmptyStateCopy'),
    ideEmptyStateAction: doc.getElementById('ideEmptyStateAction'),
  });
  const calls = { choose: 0, switchTo: [], opened: [], refresh: 0 };
  const stub = switcher === null ? null : (switcher || {
    refresh: async () => { calls.refresh += 1; },
    switchToProject: async (id) => { calls.switchTo.push(id); },
    openSwitcher: async (anchor) => { calls.opened.push(anchor); },
    getProjects: () => projects || [],
  });
  const welcome = createIdeWelcome({
    getDom,
    actionButton,
    getFsApi: () => ({ async getRootState() { return { workspaceRoot: rootPath || '' }; } }),
    onChooseFolder: () => { calls.choose += 1; },
    getProjects: () => (projects || []),
    ...(stub ? { getProjectSwitcher: async () => stub } : {}),
  });
  welcome.bindEvents();
  t.after(() => welcome.dispose());
  return { dom, doc, getDom, welcome, calls, extra: () => doc.querySelector('[data-ide-welcome-extra]') };
}

const PROJECTS = [
  { id: 'project_general', name: 'General', rootPath: '' },
  { id: 'project_budget', name: 'Budget FY27', rootPath: 'C:\\Users\\alice\\Documents\\Budget FY27' },
  { id: 'project_grants', name: 'Grants archive', rootPath: 'D:\\Archive\\Grants' },
];

test('no folder: project copy, "Choose a folder…", and "Your projects" rows that switch by id', async (t) => {
  const { getDom, welcome, calls, extra } = makeHarness(t, { rootPath: '', projects: PROJECTS });
  await welcome.render();
  await settle();
  assert.equal(getDom().ideEmptyStateCopy.textContent, 'Pick a folder and Jenny makes it a project: file tools work inside it and new chats start there.');
  const primary = getDom().ideEmptyStateAction.querySelector('[data-ide-choose-root]');
  assert.equal(primary.textContent.trim(), 'Choose a folder…');
  const heading = Array.from(extra().querySelectorAll('.ide-welcome-heading')).find((node) => node.textContent === 'Your projects');
  assert.ok(heading, 'existing projects are listed');
  const rows = extra().querySelectorAll('[data-ide-welcome-project]');
  assert.deepEqual(Array.from(rows).map((row) => row.getAttribute('data-ide-welcome-project')), ['project_budget', 'project_grants'], 'General (no folder) is not a row');
  assert.match(rows[0].textContent, /Budget FY27/);
  assert.match(rows[0].textContent, /Documents\\Budget FY27/);
  assert.ok(rows[0].classList.contains('ide-welcome-recent-item'), 'rows share the recent-files row styling');
  assert.equal(extra().querySelector('[data-ide-welcome-project-menu]'), null, 'no "Switch project…" without a folder');
  assert.ok(calls.refresh >= 1, 'the switcher list is warmed so the rows are fresh');

  rows[1].click();
  await settle();
  assert.deepEqual(calls.switchTo, ['project_grants']);
  assert.equal(calls.choose, 0);
  primary.click();
  assert.equal(calls.choose, 1);
});

test('folder open: "Switch project…" opens the shared menu anchored on itself; the dialog button is gone', async (t) => {
  const { welcome, calls, extra } = makeHarness(t, { rootPath: 'D:/Projects/Ascend', projects: PROJECTS });
  await welcome.render();
  await settle();
  const button = extra().querySelector('[data-ide-welcome-project-menu]');
  assert.ok(button);
  assert.equal(button.textContent.trim(), 'Switch project…');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(extra().querySelector('[data-ide-welcome-choose-root]'), null);
  assert.equal(extra().querySelector('[data-ide-welcome-project]'), null, 'the project rows belong to the no-folder state');
  button.click();
  await settle();
  assert.deepEqual(calls.opened, [button]);
});

test('without a switcher wired the welcome keeps "Open a different folder…" (restricted shells)', async (t) => {
  const { welcome, calls, extra } = makeHarness(t, { rootPath: 'D:/Projects/Ascend', switcher: null });
  await welcome.render();
  await settle();
  const button = extra().querySelector('[data-ide-welcome-choose-root]');
  assert.equal(button.textContent.trim(), 'Open a different folder…');
  button.click();
  assert.equal(calls.choose, 1);
});

test('a projects-changed event repaints the rows from the fresh list', async (t) => {
  const projects = PROJECTS.slice(0, 2);
  const { dom, welcome, extra } = makeHarness(t, { rootPath: '', projects });
  await welcome.render();
  await settle();
  assert.equal(extra().querySelectorAll('[data-ide-welcome-project]').length, 1);
  projects.push({ id: 'project_new', name: 'Audit-2026', rootPath: 'D:\\Projects\\Audit-2026' });
  dom.window.dispatchEvent(new dom.window.CustomEvent('jenny:projects-changed'));
  await settle();
  assert.equal(extra().querySelectorAll('[data-ide-welcome-project]').length, 2);
});

test('D18: the rows keep the switcher\'s one order (most recently used first), and a missing folder reads "Locate…" and locates instead of switching', async (t) => {
  const { createProjectSwitcher } = require('../renderer/features/renderer-project-switcher');
  const state = {
    workspaceRoot: { path: '' },
    sessions: [
      { id: 's1', project_id: 'project_grants', updated_at: '2026-09-26T10:00:00Z' },
      { id: 's2', project_id: 'project_budget', updated_at: '2026-09-20T10:00:00Z' },
    ],
  };
  const real = createProjectSwitcher({
    state,
    menu: { isOpen: () => false, close() {}, show() { return null; }, dispose() {} },
    getProjectsApi: () => ({ async list() { return { projects: [
      { id: 'project_general', name: 'General', root_path: null },
      { id: 'project_audit', name: 'Audit', root_path: 'D:\\Audit', folder_exists: true },
      { id: 'project_budget', name: 'Budget FY27', root_path: 'C:\\Budget', folder_exists: true },
      { id: 'project_grants', name: 'Grants archive', root_path: 'D:\\Archive\\Grants', folder_exists: false },
    ] }; } }),
  });
  t.after(() => real.dispose());
  await real.refresh();
  const calls = { located: [], switched: [] };
  const stub = {
    refresh: async () => {},
    getProjects: () => real.getProjects(),
    switchToProject: async (id) => { calls.switched.push(id); },
    locateProjectFolder: async (id, options) => { calls.located.push([id, options]); },
    openSwitcher: async () => {},
  };
  const dom = new JSDOM('<!doctype html><html><body><div id="ideEmptyState"><p id="ideEmptyStateCopy"></p><div id="ideEmptyStateAction" class="hidden"></div></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const doc = dom.window.document;
  const welcome = createIdeWelcome({
    getDom: () => ({ ideEmptyState: doc.getElementById('ideEmptyState'), ideEmptyStateCopy: doc.getElementById('ideEmptyStateCopy'), ideEmptyStateAction: doc.getElementById('ideEmptyStateAction') }),
    actionButton,
    getFsApi: () => ({ async getRootState() { return { workspaceRoot: '' }; } }),
    getProjects: () => stub.getProjects(),
    getProjectSwitcher: async () => stub,
  });
  welcome.bindEvents();
  t.after(() => welcome.dispose());
  await welcome.render();
  await settle();
  const rows = Array.from(doc.querySelectorAll('[data-ide-welcome-project]'));
  assert.deepEqual(rows.map((row) => row.getAttribute('data-ide-welcome-project')), ['project_grants', 'project_budget', 'project_audit']);
  const missing = rows[0].querySelector('.ide-welcome-recent-dir');
  assert.equal(missing.textContent, 'Locate…');
  assert.ok(missing.classList.contains('project-menu-detail--danger'), 'the missing folder is marked in the danger text');
  assert.equal(rows[0].title, 'D:\\Archive\\Grants', 'the path stays in the tooltip');
  rows[0].click();
  await settle();
  assert.deepEqual(calls.located, [['project_grants', { openAfter: true }]]);
  assert.deepEqual(calls.switched, []);
  rows[1].click();
  await settle();
  assert.deepEqual(calls.switched, ['project_budget']);
});
