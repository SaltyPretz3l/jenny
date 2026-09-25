'use strict';

// Projects v2 (2026-09-20): the one shared project menu and the switcher glue
// behind it. The menu is a plain listbox (rows through action-button, option
// roles applied after paint, arrows/Home/End/Escape, outside click closes,
// focus returns to the anchor). The switcher owns the 15 s project-list
// cache, switches by PROJECT ID (never a path), creates through the existing
// folder dialog, clears for General, moves ONE chat idle-only, and raises
// `jenny:projects-changed` so every surface repaints from one list.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const menuUtils = require('../renderer/features/renderer-project-menu');
const { createProjectSwitcher, CHANGED_EVENT } = require('../renderer/features/renderer-project-switcher');
const actionButton = require('../renderer/inventory/action-button');

const PROJECTS = [
  { id: 'project_general', name: 'General', root_path: null, authority_key: 'project_general:0' },
  { id: 'project_budget', name: 'Budget FY27', root_path: 'C:\\Users\\alice\\Documents\\Budget FY27', authority_key: 'project_budget:1' },
  { id: 'project_ascend', name: 'Ascend', root_path: 'D:\\Projects\\Ascend', authority_key: 'project_ascend:2' },
  { id: 'project_grants', name: 'Grants archive', root_path: 'D:\\Archive\\Grants', authority_key: '' },
];

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
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

test('pure helpers: chat counts default to General, folder keys ignore separators and case, General never sorts as a switch row', () => {
  assert.deepEqual(menuUtils.countChatsByProject([
    { id: 'a', project_id: 'project_ascend' }, { id: 'b' }, { id: 'c', project_id: '' }, { id: 'd', project_id: 'project_ascend' }, null,
  ]), { project_ascend: 2, project_general: 2 });
  assert.equal(menuUtils.folderKey('D:\\Projects\\Ascend\\'), menuUtils.folderKey('d:/projects/ascend'));
  const sorted = menuUtils.sortProjectsForMenu(menuUtils.normalizeProjectList({ projects: PROJECTS }), 'project_grants');
  assert.deepEqual(sorted.map((project) => project.id), ['project_grants', 'project_ascend', 'project_budget']);
  assert.equal(sorted[0].folderMissing, true, 'an empty authority key marks the folder missing');
});

test('the menu is a listbox: option roles, the selected row is checked and focused, click picks and closes, Escape restores focus', () => {
  const dom = makeDom();
  const anchor = dom.window.document.getElementById('anchor');
  const menu = menuUtils.createProjectMenu({ windowRef: dom.window, documentRef: dom.window.document, actionButton });
  const picks = [];
  menu.show({
    anchor,
    rows: [
      { id: 'project_ascend', kind: 'project', label: 'Ascend', detail: 'D:\\Projects\\Ascend', count: 6, selected: true },
      { id: 'project_grants', kind: 'project', label: 'Grants archive', detail: 'D:\\Archive\\Grants · folder missing', danger: true, count: 1 },
      { id: '__new', kind: 'action', label: 'New project from folder…', separatorBefore: true },
      { id: '__clear', kind: 'action', label: 'No folder (General)', disabled: true },
    ],
    onPick: (row) => picks.push(row.id),
  });
  const list = dom.window.document.getElementById('projectMenu');
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  const rows = menuRows(dom);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.getAttribute('role') === 'option'));
  assert.equal(rows[0].getAttribute('aria-selected'), 'true');
  assert.equal(rows[1].getAttribute('aria-selected'), 'false');
  assert.equal(dom.window.document.activeElement, rows[0], 'focus lands on the selected row');
  assert.match(rows[0].querySelector('.project-menu-check').textContent, /✓/);
  assert.equal(rows[0].querySelector('.project-menu-count').textContent, '6');
  assert.ok(rows[1].querySelector('.project-menu-name--danger'), 'a missing folder is marked in the danger colour');
  assert.equal(list.querySelectorAll('.project-menu-separator').length, 1);
  assert.equal(rows[3].disabled, true);

  key(dom, rows[0], 'ArrowDown');
  assert.equal(dom.window.document.activeElement, rows[1]);
  key(dom, rows[1], 'ArrowDown');
  assert.equal(dom.window.document.activeElement, rows[2], 'the disabled row is skipped by keyboard');
  key(dom, rows[2], 'ArrowDown');
  assert.equal(dom.window.document.activeElement, rows[0], 'arrows wrap');
  key(dom, rows[0], 'End');
  assert.equal(dom.window.document.activeElement, rows[2]);

  rows[3].click();
  assert.deepEqual(picks, [], 'a disabled row cannot be picked');
  rows[1].click();
  assert.deepEqual(picks, ['project_grants']);
  assert.equal(dom.window.document.getElementById('projectMenu'), null, 'picking closes the menu');
  assert.equal(anchor.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.window.document.activeElement, anchor, 'focus returns to the anchor');

  menu.show({ anchor, rows: [{ id: 'x', kind: 'project', label: 'X' }], onPick: (row) => picks.push(row.id) });
  key(dom, dom.window.document.body, 'Escape');
  assert.equal(menu.isOpen(), false);
  assert.equal(dom.window.document.activeElement, anchor);

  menu.show({ anchor, rows: [{ id: 'x', kind: 'project', label: 'X' }] });
  dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(menu.isOpen(), false, 'an outside pointer closes the menu');
  menu.show({ anchor, rows: [{ id: 'x', kind: 'project', label: 'X' }] });
  menu.show({ anchor, rows: [{ id: 'x', kind: 'project', label: 'X' }] });
  assert.equal(menu.isOpen(), false, 'showing from the same anchor toggles');
});

function makeSwitcher(t, { state, rootService, projects = PROJECTS, clock } = {}) {
  const dom = makeDom();
  const calls = { list: 0, assign: [], toasts: [], errors: [], settings: [], refreshed: 0, opened: [], newChats: 0, events: 0 };
  const api = {
    async list() { calls.list += 1; return { ok: true, projects }; },
    async assignSession(payload) {
      calls.assign.push(payload);
      return payload.project_id === 'project_refused'
        ? { ok: false, error: { message: 'A chat in this project is still working. Wait for it to finish.' } }
        : { ok: true, session: { id: payload.session_id, project_id: payload.project_id } };
    },
  };
  dom.window.addEventListener(CHANGED_EVENT, () => { calls.events += 1; });
  const switcher = createProjectSwitcher({
    state: state || { workspaceRoot: { path: '' }, sessions: [], currentSessionId: '' },
    windowRef: dom.window,
    documentRef: dom.window.document,
    actionButton,
    getProjectsApi: () => api,
    workspaceRootService: rootService || {},
    openSettingsSection: (id) => calls.settings.push(id),
    showToast: (message) => calls.toasts.push(message),
    showError: (message) => calls.errors.push(message),
    refreshSessions: () => { calls.refreshed += 1; },
    openSession: (id) => { calls.opened.push(id); },
    newChat: () => { calls.newChats += 1; },
    now: clock || (() => Date.now()),
  });
  switcher.bind();
  t.after(() => switcher.dispose());
  return { dom, switcher, calls, anchor: dom.window.document.getElementById('anchor') };
}

test('the switcher titles the Explorer with the project whose folder is the Workspace folder, and re-reads the list once per 15 s', async (t) => {
  let now = 1000;
  const state = { workspaceRoot: { path: 'd:/projects/ascend/' }, sessions: [{ id: 's1', project_id: 'project_ascend' }, { id: 's2' }] };
  const { switcher, calls } = makeSwitcher(t, { state, clock: () => now });
  assert.equal(switcher.title(), 'Workspace', 'nothing loaded yet');
  await switcher.refresh();
  assert.equal(switcher.title(), 'Ascend');
  assert.equal(switcher.currentProject().id, 'project_ascend');
  await switcher.refresh();
  assert.equal(calls.list, 1, 'fresh list reused');
  now += 20000;
  await switcher.refresh();
  assert.equal(calls.list, 2, 'stale list re-read');
  state.workspaceRoot.path = '';
  assert.equal(switcher.title(), 'Workspace');
});

test('switcher rows: current project first and checked with chat counts, then New / No folder / Manage', async (t) => {
  const state = { workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [{ id: 's1', project_id: 'project_ascend' }, { id: 's2', project_id: 'project_ascend' }, { id: 's3' }] };
  const { switcher } = makeSwitcher(t, { state });
  await switcher.refresh();
  const rows = switcher.switcherRows();
  assert.deepEqual(rows.map((row) => row.id), ['project_ascend', 'project_budget', 'project_grants', '__new', '__clear', '__manage']);
  assert.equal(rows[0].selected, true);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[2].danger, true);
  assert.match(rows[2].detail, /folder missing/);
  assert.equal(rows[3].separatorBefore, true);
  assert.equal(rows[4].disabled, false, 'No folder is available while a folder is open');
  state.workspaceRoot.path = '';
  assert.equal(switcher.switcherRows().find((row) => row.id === '__clear').disabled, true, 'nothing to clear without a folder');
});

test('picking a project switches by id through the facade, New runs the folder dialog and announces a new project, No folder clears, Manage opens Settings > Projects', async (t) => {
  const rootCalls = [];
  const rootService = {
    async switchToProject(id) { rootCalls.push(['switch', id]); return { committed: true, changed: true }; },
    async choose() { rootCalls.push(['choose']); return { committed: true, changed: true }; },
    async clear() { rootCalls.push(['clear']); state.workspaceRoot.path = ''; return { committed: true, changed: true }; },
  };
  const state = { workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [] };
  const { dom, switcher, calls, anchor } = makeSwitcher(t, { state, rootService });
  await switcher.openSwitcher(anchor);
  let rows = menuRows(dom);
  assert.equal(rows.length, 6);
  rows[1].click(); // Budget FY27
  await settle();
  assert.deepEqual(rootCalls, [['switch', 'project_budget']]);
  assert.ok(calls.events >= 1, 'a committed switch announces jenny:projects-changed');

  await switcher.openSwitcher(anchor);
  rows = menuRows(dom);
  rows[0].click(); // the current project: nothing to do
  await settle();
  assert.equal(rootCalls.length, 1, 'picking the current project is a no-op');

  await switcher.openSwitcher(anchor);
  menuRows(dom).find((row) => row.textContent.includes('No folder')).click();
  await settle();
  assert.deepEqual(rootCalls.at(-1), ['clear']);

  await switcher.openSwitcher(anchor);
  menuRows(dom).find((row) => row.textContent.includes('Manage projects')).click();
  await settle();
  assert.deepEqual(calls.settings, ['runtime']);
  assert.equal(rootCalls.length, 2, 'Manage never touches the Workspace');
});

test('the open chat follows the Workspace: a switch opens the newest chat of the new project, or a new chat when it has none; nothing moves when the open chat already belongs', async (t) => {
  // The real transition moves the Workspace folder; the mock does the same so
  // the switcher's current-project read sees the new project afterwards.
  const rootService = { async switchToProject(id) { state.workspaceRoot.path = PROJECTS.find((project) => project.id === id).root_path; return { committed: true, changed: true }; } };
  const state = {
    workspaceRoot: { path: 'D:\\Projects\\Ascend' },
    currentSessionId: 's1',
    sessions: [
      { id: 's1', project_id: 'project_ascend', updated_at: '2026-09-20T10:00:00Z' },
      { id: 's2', project_id: 'project_budget', updated_at: '2026-09-19T10:00:00Z' },
      { id: 's3', project_id: 'project_budget', updated_at: '2026-09-20T09:00:00Z' },
      { id: 's4', project_id: 'project_budget', updated_at: '2026-09-20T12:00:00Z', archived_at: '2026-09-20T13:00:00Z' },
      { id: 's5', project_id: 'project_budget', updated_at: '2026-09-20T12:30:00Z', session_type: 'plugin' },
    ],
  };
  const { switcher, calls } = makeSwitcher(t, { state, rootService });
  await switcher.refresh();
  await switcher.switchToProject('project_budget');
  assert.deepEqual(calls.opened, ['s3'], 'the newest live chat of the new project opens (archived and plugin sessions skipped)');
  assert.equal(calls.newChats, 0);
  assert.ok(calls.refreshed >= 1, 'the session list is reloaded before choosing');

  state.currentSessionId = 's3';
  await switcher.switchToProject('project_grants');
  assert.deepEqual(calls.opened, ['s3'], 'no chat to open');
  assert.equal(calls.newChats, 1, 'a project with no chats starts a new one');

  await switcher.switchToProject('project_budget');
  assert.deepEqual(calls.opened, ['s3'], 'the open chat already belongs to the new project: nothing moves');
  assert.equal(calls.newChats, 1);
});

test('New project from folder: the existing dialog runs and a project that was not in the list before is announced by name and path', async (t) => {
  let listed = PROJECTS;
  const dom = makeDom();
  const toasts = [];
  const state = { workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [] };
  const switcher = createProjectSwitcher({
    state, windowRef: dom.window, documentRef: dom.window.document, actionButton,
    getProjectsApi: () => ({ async list() { return { projects: listed }; } }),
    workspaceRootService: {
      async choose() {
        listed = [...PROJECTS, { id: 'project_audit', name: 'Audit-2026', root_path: 'D:\\Projects\\Audit-2026', authority_key: 'a:1' }];
        state.workspaceRoot.path = 'D:\\Projects\\Audit-2026';
        return { committed: true, changed: true };
      },
    },
    showToast: (message) => toasts.push(message),
  });
  t.after(() => switcher.dispose());
  await switcher.refresh();
  await switcher.newProjectFromFolder();
  assert.deepEqual(toasts, ['New project "Audit-2026" from D:\\Projects\\Audit-2026. New chats start here.']);
  assert.equal(switcher.title(), 'Audit-2026');
  toasts.length = 0;
  state.workspaceRoot.path = 'D:\\Projects\\Ascend';
  await switcher.newProjectFromFolder();
  assert.equal(switcher.title(), 'Audit-2026');
  assert.deepEqual(toasts, [], 'switching to a known project through the dialog is not announced as new');
});

test('F33: New project from folder is still announced when another surface re-reads the list between the commit and the post-commit sync', async (t) => {
  // In the app the commit's own UI work (IDE rehydrate, Explorer header
  // repaint, Chats panel render) can land a list read BEFORE afterTransition
  // runs: the Explorer's first-load kick or the Chats panel's first request.
  // That read already contains the new project, so the "was it known before?"
  // baseline must be taken before the dialog opens, not after the commit.
  let now = 1000;
  let listed = PROJECTS;
  const dom = makeDom();
  const toasts = [];
  const state = { workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [] };
  let switcher = null;
  switcher = createProjectSwitcher({
    state, windowRef: dom.window, documentRef: dom.window.document, actionButton,
    getProjectsApi: () => ({ async list() { return { projects: listed }; } }),
    workspaceRootService: {
      async choose() {
        listed = [...PROJECTS, { id: 'project_audit', name: 'Audit-2026', root_path: 'D:\\Projects\\Audit-2026', authority_key: 'a:1' }];
        state.workspaceRoot.path = 'D:\\Projects\\Audit-2026';
        now += 20000; // the native dialog was open for a while: the cache went stale
        await switcher.refresh(); // an unrelated surface re-reads after the commit
        return { committed: true, changed: true };
      },
    },
    showToast: (message) => toasts.push(message),
    now: () => now,
  });
  t.after(() => switcher.dispose());
  await switcher.refresh();
  await switcher.newProjectFromFolder();
  assert.deepEqual(switcher.switcherRows().map((row) => row.id).slice(0, 2), ['project_audit', 'project_ascend'], 'the new project is listed first and current');
  assert.deepEqual(toasts, ['New project "Audit-2026" from D:\\Projects\\Audit-2026. New chats start here.']);
});

test('F33: a post-commit sync without a loaded list never announces an existing project as new', async (t) => {
  const dom = makeDom();
  const toasts = [];
  const state = { workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [] };
  const switcher = createProjectSwitcher({
    state, windowRef: dom.window, documentRef: dom.window.document, actionButton,
    getProjectsApi: () => ({ async list() { return { projects: PROJECTS }; } }),
    workspaceRootService: {},
    showToast: (message) => toasts.push(message),
  });
  t.after(() => switcher.dispose());
  // The facade synced a commit another surface started before this module
  // ever read the list: Ascend already existed, so nothing is "new".
  await switcher.afterTransition({ committed: true, changed: true }, { announceNew: true });
  assert.equal(switcher.currentProject().id, 'project_ascend');
  assert.deepEqual(toasts, []);
});

test('the composer menu moves ONE chat: rows read "Move this chat to …", the busy chat gets no enabled row, a refusal surfaces the backend sentence', async (t) => {
  const state = { workspaceRoot: { path: 'D:\\Projects\\Ascend' }, sessions: [{ id: 's1', project_id: 'project_ascend' }], currentSessionId: 's1' };
  const { dom, switcher, calls, anchor } = makeSwitcher(t, { state });
  await switcher.refresh();
  const busy = switcher.moveRows({ projectId: 'project_ascend', idle: false });
  assert.ok(busy.every((row) => row.disabled), 'busy chat: every row disabled');
  assert.equal(busy[1].title, 'Wait for this chat to finish first.');
  const rows = switcher.moveRows({ projectId: 'project_ascend', idle: true });
  assert.equal(rows[0].label, 'Ascend');
  assert.equal(rows[0].selected, true);
  assert.equal(rows[0].disabled, true, 'the chat is already here');
  assert.equal(rows[1].label, 'Move this chat to Budget FY27');
  assert.equal(rows.at(-1).id, 'project_general');
  assert.equal(rows.at(-1).label, 'Move this chat to General');

  const moved = [];
  await switcher.openMoveChatMenu({ anchor, sessionId: 's1', projectId: 'project_ascend', idle: true, onMoved: () => moved.push(1) });
  menuRows(dom)[1].click();
  await settle();
  assert.deepEqual(calls.assign, [{ session_id: 's1', project_id: 'project_budget' }]);
  assert.equal(state.sessions[0].project_id, 'project_budget', 'the chat record follows the move');
  assert.equal(calls.refreshed, 1);
  assert.deepEqual(moved, [1]);

  const result = await switcher.moveChat('s1', 'project_refused');
  assert.equal(result.ok, false);
  assert.deepEqual(calls.errors, ['Could not move this chat: A chat in this project is still working. Wait for it to finish.']);
  assert.equal(state.sessions[0].project_id, 'project_budget', 'a refusal leaves the chat where it was');
});

test('filter rows: All projects carries the total, projects carry their counts, General closes the list', async (t) => {
  const state = { workspaceRoot: { path: '' }, sessions: [{ id: 'a', project_id: 'project_ascend' }, { id: 'b' }, { id: 'c', project_id: 'project_budget' }, { id: 'd' }] };
  const { switcher } = makeSwitcher(t, { state });
  await switcher.refresh();
  const rows = switcher.filterRows('project_budget');
  assert.equal(rows[0].label, 'All projects');
  assert.equal(rows[0].count, 4);
  assert.equal(rows[0].selected, false);
  assert.equal(rows.find((row) => row.id === 'project_budget').selected, true);
  assert.equal(rows.find((row) => row.id === 'project_budget').count, 1);
  assert.equal(rows.at(-1).id, 'project_general');
  assert.equal(rows.at(-1).count, 2);
  assert.equal(switcher.filterRows('')[0].selected, true);
});

test('a jenny:projects-changed event raised elsewhere (Settings rename/delete) invalidates the cache and re-reads', async (t) => {
  const { dom, switcher, calls } = makeSwitcher(t);
  await switcher.refresh();
  assert.equal(calls.list, 1);
  dom.window.dispatchEvent(new dom.window.CustomEvent(CHANGED_EVENT, { detail: { source: 'settings' } }));
  await settle();
  assert.equal(calls.list, 2);
});

test('a forced re-read supersedes an in-flight list request: a project deleted meanwhile never comes back from the older response', async (t) => {
  const dom = makeDom();
  const deferred = [];
  const switcher = createProjectSwitcher({
    state: { workspaceRoot: { path: '' }, sessions: [] },
    windowRef: dom.window, documentRef: dom.window.document, actionButton,
    getProjectsApi: () => ({ list() { return new Promise((resolve) => deferred.push(resolve)); } }),
    workspaceRootService: {},
  });
  switcher.bind();
  t.after(() => switcher.dispose());
  const first = switcher.refresh({ force: true });
  assert.equal(deferred.length, 1);
  // Settings deleted "Grants archive" while the first request was still out.
  dom.window.dispatchEvent(new dom.window.CustomEvent(CHANGED_EVENT, { detail: { source: 'settings' } }));
  await settle();
  assert.equal(deferred.length, 2, 'the invalidation starts a new request instead of reusing the stale one');
  deferred[0]({ projects: PROJECTS });
  deferred[1]({ projects: PROJECTS.filter((project) => project.id !== 'project_grants') });
  const seenByFirst = await first;
  await settle();
  assert.deepEqual(switcher.getProjects().map((project) => project.id).sort(), ['project_ascend', 'project_budget', 'project_general']);
  assert.deepEqual(seenByFirst.map((project) => project.id).sort(), ['project_ascend', 'project_budget', 'project_general'], 'the older caller gets the newer list too');
});

test('overlapping switches: only the latest transition drives the Chats filter and the chat follow', async (t) => {
  const dom = makeDom();
  const refreshes = [];
  const opened = [];
  const state = {
    ui: {},
    workspaceRoot: { path: 'D:\\Projects\\Ascend' },
    currentSessionId: 'sa',
    sessions: [
      { id: 'sa', project_id: 'project_ascend', updated_at: '2026-09-20T10:00:00Z' },
      { id: 'sb', project_id: 'project_budget', updated_at: '2026-09-20T10:00:00Z' },
      { id: 'sg', project_id: 'project_grants', updated_at: '2026-09-20T10:00:00Z' },
    ],
  };
  const switcher = createProjectSwitcher({
    state, windowRef: dom.window, documentRef: dom.window.document, actionButton,
    getProjectsApi: () => ({ async list() { return { projects: PROJECTS }; } }),
    workspaceRootService: {
      async switchToProject(id) { state.workspaceRoot.path = PROJECTS.find((project) => project.id === id).root_path; return { committed: true, changed: true }; },
    },
    refreshSessions: () => new Promise((resolve) => refreshes.push(resolve)),
    openSession: (id) => { opened.push(id); },
  });
  switcher.bind();
  t.after(() => switcher.dispose());
  await switcher.refresh();
  const toBudget = switcher.switchToProject('project_budget');
  await settle();
  const toGrants = switcher.switchToProject('project_grants');
  await settle();
  assert.equal(refreshes.length, 2);
  refreshes[1]();
  await settle();
  refreshes[0]();
  await Promise.all([toBudget, toGrants]);
  await settle();
  assert.equal(state.ui.chatsProjectFilter, 'project_grants');
  assert.deepEqual(opened, ['sg'], 'the superseded Budget continuation never navigates');
});
