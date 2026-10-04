'use strict';

// Projects spec 2026-09-27, Wave P slice 2 (P2a): the one project menu says
// what picking does (heading + footnote), is a real menu (menuitemradio for
// projects, menuitem for commands, disabled rows reachable with a reason),
// scrolls its row list, and the switcher behind it owns the one renderer
// project cache, the Fork 2 A switch (the open chat stays; a toast offers the
// latest chat), the D7/D8 filter rules, the missing-folder Locate flow and
// the single move engine (idle-only, busy skipped, one refresh, Undo).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const menuUtils = require('../renderer/features/renderer-project-menu');
const { createProjectSwitcher, CHANGED_EVENT } = require('../renderer/features/renderer-project-switcher');
const actionButton = require('../renderer/inventory/action-button');

const PROJECTS = [
  { id: 'project_general', name: 'General (stored)', root_path: null, folder_exists: null, is_current: false },
  { id: 'project_budget', name: 'Budget FY27', root_path: 'C:\\Users\\alice\\Documents\\Budget FY27', folder_exists: true, is_current: false, root_revision: 1 },
  { id: 'project_ascend', name: 'Ascend', root_path: 'D:\\Projects\\Ascend', folder_exists: true, is_current: true, root_revision: 2 },
  { id: 'project_grants', name: 'Grants archive', root_path: 'D:\\Archive\\Grants', folder_exists: false, is_current: false, root_revision: 5 },
  { id: 'project_loose', name: 'Loose', root_path: null, folder_exists: null, is_current: false },
];

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function makeDom() {
  return new JSDOM('<!doctype html><html><body><button id="anchor">Ascend</button></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
}

function key(dom, target, name) {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
}

function menuRows(dom) {
  return Array.from(dom.window.document.querySelectorAll('#projectMenu [data-project-menu-item]'));
}

function makeSwitcher(t, { state, rootService, projects = PROJECTS, api: apiOverrides = {} } = {}) {
  const dom = makeDom();
  let listed = projects;
  const calls = { list: 0, assign: [], chooseRoot: [], toasts: [], errors: [], settings: [], refreshed: 0, opened: [], newChats: [], events: [] };
  const api = {
    async list() { calls.list += 1; return { ok: true, projects: listed }; },
    async assignSession(payload) {
      calls.assign.push(payload);
      if (payload.session_id === 's_refused') return { ok: false, error: { reason: 'session_busy', message: 'busy' } };
      return { ok: true, session: { id: payload.session_id, project_id: payload.project_id } };
    },
    ...apiOverrides,
  };
  dom.window.addEventListener(CHANGED_EVENT, (event) => { calls.events.push(event.detail); });
  const appState = state || { ui: {}, workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [], currentSessionId: '' };
  const switcher = createProjectSwitcher({
    state: appState,
    windowRef: dom.window,
    documentRef: dom.window.document,
    actionButton,
    getProjectsApi: () => api,
    workspaceRootService: rootService || {},
    openSettingsSection: (id) => calls.settings.push(id),
    showToast: (message, options) => calls.toasts.push({ message, options: options || {} }),
    showError: (message) => calls.errors.push(message),
    refreshSessions: () => { calls.refreshed += 1; },
    openSession: (id) => { calls.opened.push(id); },
    newChat: (options) => {
      const id = 's_new_' + (calls.newChats.length + 1);
      calls.newChats.push(id);
      calls.newChatOptions = [...(calls.newChatOptions || []), options];
      appState.sessions.push({ id, project_id: 'project_ascend' });
      return id;
    },
  });
  switcher.bind();
  t.after(() => switcher.dispose());
  return { dom, switcher, calls, state: appState, api, setListed: (next) => { listed = next; }, anchor: dom.window.document.getElementById('anchor') };
}

// ---- The menu component ------------------------------------------------------

test('the menu is a menu: heading and footnote, menuitemradio rows with aria-checked, menuitem commands, and a scrolling row list that holds only the project rows', () => {
  const dom = makeDom();
  const anchor = dom.window.document.getElementById('anchor');
  const menu = menuUtils.createProjectMenu({ windowRef: dom.window, documentRef: dom.window.document, actionButton });
  menu.show({
    anchor,
    heading: 'Open project',
    footnote: 'Its file access and memories follow the project.',
    rows: [
      { id: 'project_ascend', kind: 'project', label: 'Ascend', selected: true },
      { id: 'project_budget', kind: 'project', label: 'Budget FY27' },
      { id: '__new', kind: 'action', label: 'New project from folder', separatorBefore: true },
    ],
  });
  const element = dom.window.document.getElementById('projectMenu');
  assert.equal(element.getAttribute('role'), 'menu');
  const heading = element.querySelector('.project-menu-heading');
  assert.equal(heading.textContent, 'Open project');
  assert.equal(element.getAttribute('aria-labelledby'), heading.id, 'the heading names the menu');
  assert.equal(element.querySelector('.project-menu-footnote').textContent, 'Its file access and memories follow the project.');
  const list = element.querySelector('.project-menu-list');
  assert.ok(list, 'the project rows sit in their own scroll container');
  assert.equal(list.querySelectorAll('[data-project-menu-item]').length, 2);
  assert.equal(list.contains(element.querySelector('.project-menu-heading')), false, 'the heading stays outside the scrolling list');
  const rows = menuRows(dom);
  assert.equal(rows[0].getAttribute('role'), 'menuitemradio');
  assert.equal(rows[0].getAttribute('aria-checked'), 'true');
  assert.equal(rows[1].getAttribute('aria-checked'), 'false');
  assert.equal(rows[2].getAttribute('role'), 'menuitem');
  assert.equal(rows[2].hasAttribute('aria-checked'), false);
  assert.equal(list.contains(rows[2]), false, 'commands stay fixed below the list');
});

test('a disabled row stays keyboard reachable with its reason, but cannot be picked', () => {
  const dom = makeDom();
  const anchor = dom.window.document.getElementById('anchor');
  const menu = menuUtils.createProjectMenu({ windowRef: dom.window, documentRef: dom.window.document, actionButton });
  const picks = [];
  menu.show({
    anchor,
    rows: [
      { id: 'a', kind: 'project', label: 'A', selected: true },
      { id: 'b', kind: 'project', label: 'B', disabled: true, reason: 'Wait for this chat to finish first.' },
      { id: 'c', kind: 'project', label: 'C' },
    ],
    onPick: (row) => picks.push(row.id),
  });
  const rows = menuRows(dom);
  assert.equal(rows[1].getAttribute('aria-disabled'), 'true');
  assert.equal(rows[1].disabled, false, 'not natively disabled, so focus can reach it');
  const describedBy = rows[1].getAttribute('aria-describedby');
  assert.ok(describedBy, 'the reason is wired as a description');
  assert.equal(dom.window.document.getElementById(describedBy).textContent, 'Wait for this chat to finish first.');
  key(dom, rows[0], 'ArrowDown');
  assert.equal(dom.window.document.activeElement, rows[1], 'arrows reach the disabled row');
  rows[1].click();
  assert.deepEqual(picks, [], 'a disabled row cannot be picked');
  assert.equal(menu.isOpen(), true);
  rows[2].click();
  assert.deepEqual(picks, ['c']);
});

// ---- Pure helpers: order, names ----------------------------------------------

test('one order everywhere: current first, then most recently used, then the rest by name, General last; General is always the translated name', () => {
  const projects = menuUtils.normalizeProjectList({ projects: PROJECTS });
  const general = projects.find((project) => project.id === 'project_general');
  assert.equal(general.name, 'General', 'the stored English name never shows');
  const sessions = [
    { id: 'x1', project_id: 'project_budget', updated_at: '2026-09-20T10:00:00Z' },
    { id: 'x2', project_id: 'project_grants', updated_at: '2026-09-25T10:00:00Z' },
    { id: 'x3', project_id: 'project_general', updated_at: '2026-09-26T10:00:00Z' },
  ];
  const ordered = menuUtils.orderProjects(projects, { currentId: 'project_ascend', sessions });
  assert.deepEqual(ordered.map((project) => project.id), ['project_ascend', 'project_grants', 'project_budget', 'project_loose', 'project_general']);
  assert.equal(projects.find((project) => project.id === 'project_grants').folderMissing, true, 'folder_exists false marks the folder missing');
});

test('duplicate names are told apart by the folder parent ("src · jenny")', () => {
  const projects = menuUtils.normalizeProjectList([
    { id: 'p1', name: 'src', root_path: 'D:\\Work\\jenny\\src' },
    { id: 'p2', name: 'SRC', root_path: 'D:\\Work\\refactor\\src' },
    { id: 'p3', name: 'Ascend', root_path: 'D:\\Projects\\Ascend' },
  ]);
  const labels = menuUtils.displayNames(projects);
  assert.equal(labels.p1, 'src · jenny');
  assert.equal(labels.p2, 'SRC · refactor');
  assert.equal(labels.p3, 'Ascend');
});

// ---- One cache ----------------------------------------------------------------

test('one cache: getProjects/refreshProjects/onProjectsChanged, and jenny:projects-changed carries the list only when it changed', async (t) => {
  const { switcher, calls, setListed } = makeSwitcher(t);
  const seen = [];
  const unsubscribe = switcher.onProjectsChanged((projects) => seen.push(projects.map((project) => project.id)));
  await switcher.refreshProjects();
  assert.equal(calls.list, 1);
  assert.equal(seen.length, 1);
  assert.equal(calls.events.length, 1);
  assert.ok(Array.isArray(calls.events[0].projects), 'the event carries the list');
  assert.equal(switcher.getProjects()[0].id, 'project_ascend', 'getProjects hands out the one order');
  await switcher.refreshProjects({ force: true });
  assert.equal(calls.list, 2);
  assert.equal(seen.length, 1, 'an unchanged re-read notifies nobody');
  assert.equal(calls.events.length, 1);
  setListed(PROJECTS.filter((project) => project.id !== 'project_loose'));
  await switcher.refreshProjects({ force: true });
  assert.equal(seen.length, 2);
  unsubscribe();
  setListed(PROJECTS);
  await switcher.refreshProjects({ force: true });
  assert.equal(seen.length, 2, 'unsubscribed');
});

test('is_current from main wins over the path compare (junction / subst drives)', async (t) => {
  const state = { ui: {}, workspaceRoot: { path: 'X:\\' }, sessions: [] };
  const { switcher } = makeSwitcher(t, { state });
  await switcher.refreshProjects();
  assert.equal(switcher.currentProject().id, 'project_ascend');
  assert.equal(switcher.title(), 'Ascend');
  state.workspaceRoot.path = '';
  assert.equal(switcher.currentProject(), null, 'no Workspace folder, no current project');
});

// ---- Open project (Explorer / welcome) -----------------------------------------

test('"Open project": heading, missing folder rows offer Locate…, folderless rows are disabled with a reason, commands without trailing ellipses', async (t) => {
  const { dom, switcher, anchor } = makeSwitcher(t);
  await switcher.openSwitcher(anchor);
  const element = dom.window.document.getElementById('projectMenu');
  assert.equal(element.querySelector('.project-menu-heading').textContent, 'Open project');
  const rows = switcher.switcherRows();
  const grants = rows.find((row) => row.id === 'project_grants');
  assert.equal(grants.detail, 'Locate…');
  assert.equal(grants.danger, true);
  assert.equal(grants.disabled, false, 'activating it runs Locate');
  const loose = rows.find((row) => row.id === 'project_loose');
  assert.equal(loose.disabled, true);
  assert.equal(loose.reason, 'no folder');
  assert.equal(rows.find((row) => row.id === '__new').label, 'New project from folder');
  assert.equal(rows.find((row) => row.id === '__manage').label, 'Manage projects');
  assert.equal(rows.find((row) => row.id === '__clear').detail, 'closes the Workspace');
  assert.equal(rows.some((row) => row.id === 'project_general'), false, 'General is the No folder command');
});

test('Locate folder rebinds through projects.chooseRoot with the root revision; each refusal has its own sentence and a cancel is silent', async (t) => {
  let reply = { ok: true, project: { id: 'project_grants' } };
  const { switcher, calls } = makeSwitcher(t, { api: { async chooseRoot(payload) { calls.chooseRoot.push(payload); return reply; } } });
  await switcher.refreshProjects();
  const listsBefore = calls.list;
  const ok = await switcher.locateProjectFolder('project_grants');
  assert.equal(ok.ok, true);
  assert.deepEqual(calls.chooseRoot, [{ project_id: 'project_grants', expected_root_revision: 5 }]);
  assert.ok(calls.list > listsBefore, 'the list is re-read after a rebind');

  reply = { ok: false, reason: 'canceled' };
  await switcher.locateProjectFolder('project_grants');
  assert.deepEqual(calls.errors, [], 'a canceled picker says nothing');

  reply = { ok: false, reason: 'folder_already_project', conflict_project_name: 'Budget FY27' };
  await switcher.locateProjectFolder('project_grants');
  reply = { ok: false, reason: 'project_is_current' };
  await switcher.locateProjectFolder('project_grants');
  reply = { ok: false, error: { message: 'Disk on fire.' } };
  await switcher.locateProjectFolder('project_grants');
  assert.deepEqual(calls.errors, [
    'That folder is already the project "Budget FY27".',
    'Close the Workspace before changing its folder.',
    'Could not change the folder: Disk on fire.',
  ]);
});

test('opening a project whose folder is missing never starts the switch: a toast offers Locate folder', async (t) => {
  const rootCalls = [];
  const rootService = { async switchToProject(id) { rootCalls.push(id); return { committed: false, blocked: true, code: 'workspace_folder_missing' }; } };
  const { switcher, calls } = makeSwitcher(t, { rootService, api: { async chooseRoot(payload) { calls.chooseRoot.push(payload); return { ok: false, reason: 'canceled' }; } } });
  await switcher.refreshProjects();
  await switcher.openProjectAsWorkspace('project_grants');
  assert.deepEqual(rootCalls, []);
  assert.equal(calls.toasts.length, 1);
  assert.equal(calls.toasts[0].message, 'The folder for "Grants archive" is missing. Locate it to open the project.');
  const action = calls.toasts[0].options.actions[0];
  assert.equal(action.label, 'Locate folder');
  await action.onClick();
  assert.deepEqual(calls.chooseRoot, [{ project_id: 'project_grants', expected_root_revision: 5 }]);

  // The folder vanished after the list was read: main refuses, same toast.
  await switcher.openProjectAsWorkspace('project_budget');
  assert.deepEqual(rootCalls, ['project_budget']);
  assert.equal(calls.toasts.at(-1).message, 'The folder for "Budget FY27" is missing. Locate it to open the project.');
});

// ---- Fork 2 A: the open chat stays -----------------------------------------------

test('Fork 2 A: a committed switch keeps the open chat and offers "Open latest chat"; a project without chats offers "New chat here"', async (t) => {
  const state = {
    ui: {},
    workspaceRoot: { path: 'D:\\Projects\\Ascend' },
    currentSessionId: 's1',
    sessions: [
      { id: 's1', project_id: 'project_ascend', updated_at: '2026-09-20T10:00:00Z' },
      { id: 's2', project_id: 'project_budget', updated_at: '2026-09-19T10:00:00Z' },
      { id: 's3', project_id: 'project_budget', updated_at: '2026-09-20T09:00:00Z' },
    ],
  };
  const byId = Object.fromEntries(PROJECTS.map((project) => [project.id, project]));
  let listed = PROJECTS;
  const rootService = {
    async switchToProject(id) {
      state.workspaceRoot.path = byId[id].root_path;
      listed = Object.values(byId).map((project) => ({ ...project, is_current: project.id === id }));
      return { committed: true, changed: true };
    },
  };
  const { switcher, calls } = makeSwitcher(t, { state, rootService, api: { async list() { calls.list += 1; return { projects: listed }; } } });
  await switcher.refreshProjects();
  await switcher.switchToProject('project_budget');
  assert.deepEqual(calls.opened, [], 'the open chat stays');
  assert.deepEqual(calls.newChats, [], 'no chat is created');
  assert.equal(switcher.currentProject().id, 'project_budget', 'is_current is re-read after a switch by id');
  const toast = calls.toasts.at(-1);
  assert.equal(toast.message, 'Workspace is now Budget FY27. New chats start here.');
  assert.equal(toast.options.actions[0].label, 'Open latest chat');
  await toast.options.actions[0].onClick();
  assert.deepEqual(calls.opened, ['s3'], 'the action runs the follow logic');

  byId.project_loose2 = { id: 'project_loose2', name: 'Empty', root_path: 'E:\\Empty', folder_exists: true };
  listed = Object.values(byId).map((project) => ({ ...project, is_current: project.id === 'project_budget' }));
  await switcher.refreshProjects({ force: true });
  await switcher.switchToProject('project_loose2');
  const empty = calls.toasts.at(-1);
  assert.equal(empty.message, 'Workspace is now Empty. New chats start here.');
  assert.equal(empty.options.actions[0].label, 'New chat here');
});

test('New project from folder keeps its announcement and gains the same action; a provisioning failure says chats go to General', async (t) => {
  let listed = PROJECTS;
  let provisioning = null;
  const state = { ui: {}, workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [], currentSessionId: '' };
  const rootService = {
    async choose() {
      listed = [...PROJECTS.map((project) => ({ ...project, is_current: false })), { id: 'project_audit', name: 'Audit-2026', root_path: 'D:\\Projects\\Audit-2026', folder_exists: true, is_current: provisioning === null }];
      state.workspaceRoot.path = 'D:\\Projects\\Audit-2026';
      return { committed: true, changed: true, ...(provisioning ? { project_provisioning: provisioning } : {}) };
    },
  };
  const { switcher, calls } = makeSwitcher(t, { state, rootService, api: { async list() { return { projects: listed }; } } });
  await switcher.refreshProjects();
  await switcher.newProjectFromFolder();
  const toast = calls.toasts.at(-1);
  assert.equal(toast.message, 'New project "Audit-2026" from D:\\Projects\\Audit-2026. New chats start here.');
  assert.equal(toast.options.actions[0].label, 'New chat here');

  provisioning = { ok: false, reason: 'storage_unavailable' };
  listed = PROJECTS.map((project) => ({ ...project, is_current: false }));
  await switcher.newProjectFromFolder();
  assert.equal(calls.errors.at(-1), 'Jenny couldn\'t create a project for this folder. New chats go to General.');
});

// ---- Filter rules (D7, D8) -------------------------------------------------------

test('D8: a switch sets the Chats filter only until the user picks one; "All projects" is a pick too', async (t) => {
  const state = { ui: {}, workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [] };
  const rootService = { async switchToProject(id) { state.workspaceRoot.path = PROJECTS.find((project) => project.id === id).root_path; return { committed: true, changed: true }; } };
  const { dom, switcher, anchor } = makeSwitcher(t, {
    state, rootService,
    api: { async list() { return { projects: PROJECTS.map((project) => ({ ...project, is_current: undefined })) }; } },
  });
  await switcher.refreshProjects();
  await switcher.switchToProject('project_budget');
  assert.equal(state.ui.chatsProjectFilter, 'project_budget', 'no pick yet: the filter follows the Workspace');

  const picked = [];
  await switcher.openFilterMenu({ anchor, selectedId: state.ui.chatsProjectFilter, onPick: (id) => { picked.push(id); state.ui.chatsProjectFilter = id; } });
  assert.equal(dom.window.document.querySelector('#projectMenu .project-menu-heading').textContent, 'Show chats from');
  menuRows(dom)[0].click(); // All projects
  assert.deepEqual(picked, ['']);
  await switcher.switchToProject('project_ascend');
  assert.equal(state.ui.chatsProjectFilter, '', 'the explicit "All projects" pick is respected');
});

test('D7: ensureFilterShows narrows to the new chat\'s project only when the active filter would hide it', async (t) => {
  const state = { ui: { chatsProjectFilter: 'project_budget' }, workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [] };
  const { switcher } = makeSwitcher(t, { state });
  assert.equal(switcher.ensureFilterShows('project_budget'), false);
  assert.equal(switcher.ensureFilterShows('project_ascend'), true);
  assert.equal(state.ui.chatsProjectFilter, 'project_ascend');
  state.ui.chatsProjectFilter = '';
  assert.equal(switcher.ensureFilterShows('project_budget'), false, 'All projects already shows it');
  assert.equal(state.ui.chatsProjectFilter, '');
});

test('newChatInProject creates a chat and assigns it when the project is not the Workspace project; the filter follows', async (t) => {
  const state = { ui: { chatsProjectFilter: 'project_grants' }, workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [] };
  const { switcher, calls } = makeSwitcher(t, { state });
  await switcher.refreshProjects();
  const created = await switcher.newChatInProject('project_ascend');
  assert.equal(created, 's_new_1');
  assert.deepEqual(calls.assign, [], 'the Workspace project is where new chats land anyway');
  assert.equal(state.ui.chatsProjectFilter, 'project_ascend');
  await switcher.newChatInProject('project_budget');
  assert.deepEqual(calls.assign, [{ session_id: 's_new_2', project_id: 'project_budget' }]);
  // Another project's chat must be a real record (a busy send would otherwise make a draft that lands in Ascend).
  assert.deepEqual(calls.newChatOptions, [{ projectId: 'project_ascend', requireRecord: false }, { projectId: 'project_budget', requireRecord: true }]);
});

// ---- Move engine -----------------------------------------------------------------

test('the move engine assigns idle chats one by one, skips busy ones, refreshes once, and Undo sends each chat back', async (t) => {
  const state = {
    ui: {},
    workspaceRoot: { path: 'D:\\Projects\\Ascend' },
    activeStreamSessionId: 's_stream',
    sessions: [
      { id: 's1', project_id: 'project_ascend' },
      { id: 's2' },
      { id: 's_busy', project_id: 'project_ascend', active_turn: { id: 't1' } },
      { id: 's_stream', project_id: 'project_ascend' },
      { id: 's_refused', project_id: 'project_ascend' },
    ],
  };
  const { switcher, calls } = makeSwitcher(t, { state });
  await switcher.refreshProjects();
  const result = await switcher.moveSessionsToProject(['s1', 's2', 's_busy', 's_stream', 's_refused'], 'project_budget', { source: 'bulk' });
  assert.deepEqual(calls.assign, [
    { session_id: 's1', project_id: 'project_budget' },
    { session_id: 's2', project_id: 'project_budget' },
    { session_id: 's_refused', project_id: 'project_budget' },
  ], 'busy chats never reach the backend');
  assert.deepEqual(result.moved, ['s1', 's2']);
  assert.deepEqual(result.skipped.sort(), ['s_busy', 's_refused', 's_stream']);
  assert.equal(calls.refreshed, 1, 'one refresh at the end');
  assert.equal(state.sessions[0].project_id, 'project_budget');
  const toast = calls.toasts.at(-1);
  assert.equal(toast.message, 'Moved 2 chats to Budget FY27. 3 busy chats were skipped.');
  const undo = toast.options.actions[0];
  assert.equal(undo.label, 'Undo');
  calls.assign.length = 0;
  await undo.onClick();
  assert.deepEqual(calls.assign, [
    { session_id: 's1', project_id: 'project_ascend' },
    { session_id: 's2', project_id: 'project_general' },
  ], 'one call per chat, back to where it was');
  assert.equal(calls.refreshed, 2);
  assert.equal(state.sessions[1].project_id, 'project_general');
});

test('Undo is offered only for chats whose original project can take them back (its folder is not missing)', async (t) => {
  const state = { ui: {}, workspaceRoot: { path: '' }, sessions: [{ id: 's_lost', project_id: 'project_grants' }, { id: 's_ok', project_id: 'project_budget' }] };
  const { switcher, calls } = makeSwitcher(t, { state });
  await switcher.refreshProjects();
  await switcher.moveSessionsToProject(['s_lost'], 'project_general');
  assert.equal(calls.toasts.at(-1).message, 'Moved this chat to General.');
  assert.deepEqual(calls.toasts.at(-1).options.actions, [], 'no Undo that main would refuse');
  await switcher.moveSessionsToProject(['s_ok'], 'project_general');
  calls.assign.length = 0;
  await calls.toasts.at(-1).options.actions[0].onClick();
  assert.deepEqual(calls.assign, [{ session_id: 's_ok', project_id: 'project_budget' }]);
});

test('moving one chat says "Moved this chat to {name}."; General is named in the current language', async (t) => {
  const state = { ui: {}, workspaceRoot: { path: '' }, sessions: [{ id: 's1', project_id: 'project_ascend' }] };
  const { switcher, calls } = makeSwitcher(t, { state });
  await switcher.refreshProjects();
  await switcher.moveSessionsToProject(['s1'], 'project_general');
  assert.equal(calls.toasts.at(-1).message, 'Moved this chat to General.');
});

test('the move menu: heading, plain project names, "here now" on the chat\'s project (inert), General last, and the footnote', async (t) => {
  const state = { ui: {}, workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [{ id: 's1', project_id: 'project_ascend' }, { id: 's2', project_id: 'project_ascend' }, { id: 's3', project_id: 'project_budget' }] };
  const { dom, switcher, calls, anchor } = makeSwitcher(t, { state });
  const moved = [];
  await switcher.openMoveMenu(anchor, ['s1'], { onMoved: (result) => moved.push(result) });
  const element = dom.window.document.getElementById('projectMenu');
  assert.equal(element.querySelector('.project-menu-heading').textContent, 'Move this chat to');
  assert.equal(element.querySelector('.project-menu-footnote').textContent, 'Its file access and memories follow the project.');
  const rows = switcher.moveRows(['s1']);
  assert.equal(rows[0].id, 'project_ascend');
  assert.equal(rows[0].label, 'Ascend');
  assert.equal(rows[0].detail, 'here now');
  assert.equal(rows[0].disabled, true);
  assert.equal(rows[1].label, 'Budget FY27', 'plain names, no "Move this chat to X"');
  assert.equal(rows.at(-1).id, 'project_general');
  assert.equal(rows.at(-1).label, 'General');
  assert.equal(rows.at(-1).detail, 'no folder · file tools off');

  menuRows(dom).find((row) => row.textContent.includes('Budget FY27')).click();
  await settle();
  assert.deepEqual(calls.assign, [{ session_id: 's1', project_id: 'project_budget' }]);
  assert.equal(moved.length, 1);

  state.sessions[0].active_turn = { id: 't' };
  const busy = switcher.moveRows(['s1']);
  assert.ok(busy.every((row) => row.disabled), 'a busy single chat gets no enabled row');
  assert.equal(busy.find((row) => row.id === 'project_grants').reason, 'Wait for this chat to finish first.');

  await switcher.openMoveMenu(anchor, ['s2', 's3'], {});
  assert.equal(dom.window.document.querySelector('#projectMenu .project-menu-heading').textContent, 'Move 2 chats to');
});

test('the Chats filter menu: "All projects" first with the total, projects with counts, General last', async (t) => {
  const state = { ui: {}, workspaceRoot: { path: '' }, sessions: [{ id: 'a', project_id: 'project_ascend' }, { id: 'b' }, { id: 'c', project_id: 'project_budget' }] };
  const { switcher } = makeSwitcher(t, { state });
  await switcher.refreshProjects();
  const rows = switcher.filterRows('');
  assert.equal(rows[0].label, 'All projects');
  assert.equal(rows[0].count, 3);
  assert.equal(rows.at(-1).id, 'project_general');
  assert.equal(rows.at(-1).label, 'General');
});
