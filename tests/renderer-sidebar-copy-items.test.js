'use strict';

// Chats sidebar Copy items (owner request 2026-10-27): the chat row menu gains
// Copy chat name / Copy chat ID / Copy project name / Copy project path, the
// project header menu gains Copy project name / Copy project path, and a
// right-click on a project header opens its menu at the pointer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const copyItemsModule = require('../renderer/shell/renderer-sidebar-copy-items');
const { createSessionActionsController } = require('../renderer/shell/renderer-session-actions');
const { createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const contextMenu = require('../renderer/inventory/context-menu');

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const labelsOf = (items) => items.filter((item) => !item.separator).map((item) => item.label);

const PROJECTS = [
  { id: 'project_alpha', name: 'Alpha', rootPath: 'D:\\Work\\Alpha' },
  { id: 'project_bare', name: 'Notes', rootPath: '' },
  { id: 'project_general', name: 'General', rootPath: '' },
];

function makeSwitcher({ loaded = true } = {}) {
  let list = loaded ? PROJECTS : [];
  return {
    refreshes: 0,
    async refresh() { this.refreshes += 1; list = PROJECTS; },
    getProjects: () => list,
    projectById: (id) => list.find((project) => project.id === id) || null,
    currentProject: () => null,
    async newChatInProject() {},
    async openProjectAsWorkspace() {},
    async openFilterMenu() {},
    setChatsFilter() {},
  };
}

function copyEnv({ switcher = makeSwitcher(), failWrite = false } = {}) {
  const written = [];
  const toasts = [];
  const logs = [];
  const windowRef = {
    jennyShell: {
      clipboard: {
        async writeText(text) {
          if (failWrite) throw new Error('clipboard denied');
          written.push(text);
        },
      },
    },
  };
  const helper = copyItemsModule.createSidebarCopyItems({
    windowRef,
    getSwitcher: async () => switcher,
    showToastMessage: (message, options) => toasts.push({ message, tone: options.tone }),
    appendClientLog: (level, event) => logs.push(`${level} ${event}`),
    toastSource: 'shell.session-action',
  });
  return { helper, written, toasts, logs, switcher };
}

const pick = (items, label) => {
  const item = items.find((entry) => entry.label === label);
  assert.ok(item, `expected "${label}" in [${labelsOf(items).join(' | ')}]`);
  return item.action();
};

test('chat items: name, ID and the project items, led by a separator; the copied value is the toast', async () => {
  const env = copyEnv();
  env.helper.chatItems({ id: 'warm' }); // the first menu read loads the project list
  await settle();
  const items = env.helper.chatItems({ id: 's-42', title: '  Weekly   report  ', project_id: 'project_alpha' });
  assert.equal(items[0].separator, true);
  assert.deepEqual(labelsOf(items), ['Copy chat name', 'Copy chat ID', 'Copy project name', 'Copy project path']);
  await pick(items, 'Copy chat name');
  await pick(items, 'Copy chat ID');
  await pick(items, 'Copy project name');
  await pick(items, 'Copy project path');
  assert.deepEqual(env.written, ['Weekly report', 's-42', 'Alpha', 'D:\\Work\\Alpha']);
  assert.deepEqual(env.toasts.map((entry) => entry.message), ['Copied Weekly report', 'Copied s-42', 'Copied Alpha', 'Copied D:\\Work\\Alpha']);
  assert.ok(env.toasts.every((entry) => entry.tone === 'success'));
});

test('chat items: an untitled chat copies the default title; a chat without a project belongs to General', async () => {
  const env = copyEnv();
  env.helper.chatItems({ id: 'warm' });
  await settle();
  const items = env.helper.chatItems({ id: 's1', title: '' });
  assert.deepEqual(labelsOf(items), ['Copy chat name', 'Copy chat ID', 'Copy project name'], 'General has no folder, so no path');
  await pick(items, 'Copy chat name');
  await pick(items, 'Copy project name');
  assert.deepEqual(env.written, ['New Chat', 'General']);
});

test('chat items: a plugin chat gets only its name and ID', () => {
  const env = copyEnv();
  assert.deepEqual(labelsOf(env.helper.chatItems({ id: 'p1', title: 'Plugin', session_type: 'plugin', project_id: 'project_alpha' })), ['Copy chat name', 'Copy chat ID']);
  assert.deepEqual(env.helper.chatItems(null), []);
});

test('before the project list loads, the path item shows and resolves on click; a folderless project says so', async () => {
  const switcher = makeSwitcher({ loaded: false });
  const env = copyEnv({ switcher });
  const items = env.helper.chatItems({ id: 's1', title: 'Draft', project_id: 'project_bare' });
  assert.deepEqual(labelsOf(items), ['Copy chat name', 'Copy chat ID', 'Copy project name', 'Copy project path'], 'unknown yet: offered');
  await pick(items, 'Copy project path');
  assert.equal(switcher.refreshes, 1, 'the click read the project list');
  assert.deepEqual(env.written, []);
  assert.deepEqual(env.toasts, [{ message: 'This project has no folder.', tone: 'info' }]);
  assert.deepEqual(labelsOf(env.helper.chatItems({ id: 's1', project_id: 'project_bare' })), ['Copy chat name', 'Copy chat ID', 'Copy project name'], 'known now: no path');
});

test('an unknown project or a refused clipboard ends in an error toast and copies nothing', async () => {
  const env = copyEnv();
  env.helper.chatItems({ id: 'warm' });
  await settle();
  await pick(env.helper.chatItems({ id: 's1', project_id: 'project_gone' }), 'Copy project name');
  assert.deepEqual(env.toasts, [{ message: "Couldn't find this chat's project.", tone: 'danger' }]);

  const refused = copyEnv({ failWrite: true });
  assert.equal(await pick(refused.helper.chatItems({ id: 's1', title: 'Draft' }), 'Copy chat ID'), false);
  assert.deepEqual(refused.toasts, [{ message: 'Could not copy to the clipboard.', tone: 'danger' }]);
  assert.deepEqual(refused.logs, ['WARN sessions.copy_failed']);
});

test('project menu items: name always, path only for a project with a folder; the header label names an unlisted project', async () => {
  const env = copyEnv();
  env.helper.projectMenuItems('project_alpha', 'Alpha');
  await settle();
  assert.deepEqual(labelsOf(env.helper.projectMenuItems('project_alpha', 'Alpha')), ['Copy project name', 'Copy project path']);
  assert.deepEqual(labelsOf(env.helper.projectMenuItems('project_general', 'General')), ['Copy project name']);
  await pick(env.helper.projectMenuItems('project_new', 'Fresh'), 'Copy project name');
  assert.deepEqual(env.written, ['Fresh']);
});

function rowMenuHarness(sessions, { withCopyItems = true } = {}) {
  const dom = new JSDOM(`<body><ul>${sessions.map((row) => `<li class="conversation-item" data-session-id="${row.id}"><button data-session-action="menu">⋯</button></li>`).join('')}</ul></body>`);
  const shown = [];
  const written = [];
  const windowRef = {
    document: dom.window.document,
    CSS: dom.window.CSS,
    jennyShell: { clipboard: { async writeText(text) { written.push(text); } } },
    ...(withCopyItems ? { rendererSidebarCopyItems: copyItemsModule } : {}),
  };
  const controller = createSessionActionsController({
    state: { sessions, ui: {} },
    windowRef,
    constants: { TOAST_SOURCE: { sessionAction: 'shell.session-action' } },
    inventory: { contextMenu: { show(options) { shown.push(options); }, hide() {} } },
    modules: { destructiveUndoUtils: { createDestructiveUndoScheduler: () => ({ list: () => [] }) } },
    callbacks: {
      renderAll() {}, renderSessions() {}, showToastMessage() {}, appendClientLog() {}, registerCleanup() {}, showSessionActionError() {},
      getProjectSwitcher: async () => makeSwitcher(),
    },
  });
  return { controller, shown, written };
}

test('row menu: the Copy group sits between Archive and Delete, each group fenced by separators', async () => {
  const h = rowMenuHarness([{ id: 's1', title: 'Intake', project_id: 'project_alpha' }]);
  h.controller.openSessionRowMenu({ sessionId: 's1', anchorX: 5, anchorY: 5 });
  await settle();
  h.controller.openSessionRowMenu({ sessionId: 's1', anchorX: 5, anchorY: 5 });
  const items = h.shown[1].items;
  assert.deepEqual(labelsOf(items), ['Pin', 'Rename', 'Move to project ›', 'Archive', 'Copy chat name', 'Copy chat ID', 'Copy project name', 'Copy project path', 'Delete']);
  const shape = items.map((item) => (item.separator ? '|' : item.label));
  assert.deepEqual(shape.slice(shape.indexOf('Archive')), ['Archive', '|', 'Copy chat name', 'Copy chat ID', 'Copy project name', 'Copy project path', '|', 'Delete']);
  await pick(items, 'Copy chat ID');
  assert.deepEqual(h.written, ['s1']);
});

test('row menu: the primary Jenny chat ends with the Copy group; no helper yet means no Copy items', () => {
  const primary = rowMenuHarness([{ id: 'jenny', title: 'Jenny', session_role: 'primary' }]);
  primary.controller.openSessionRowMenu({ sessionId: 'jenny', anchorX: 5, anchorY: 5 });
  const items = primary.shown[0].items;
  assert.equal(items.at(-1).separator, undefined, 'no trailing separator');
  assert.ok(labelsOf(items).includes('Copy chat name'));
  assert.equal(labelsOf(items).includes('Delete'), false);

  const bare = rowMenuHarness([{ id: 's1', title: 'Intake' }], { withCopyItems: false });
  bare.controller.openSessionRowMenu({ sessionId: 's1', anchorX: 5, anchorY: 5 });
  assert.equal(labelsOf(bare.shown[0].items).some((label) => label.startsWith('Copy')), false);
});

function panelHarness(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="chatsProjectRow"></div><div id="chatsScopeSlot"></div>'
    + '<div id="conversationGroups"></div><div id="chatsPanelStatus"></div><span id="conversationCount"></span></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  const doc = window.document;
  const written = [];
  window.jennyShell = { clipboard: { async writeText(text) { written.push(text); } } };
  window.rendererSidebarCopyItems = copyItemsModule;
  const shown = [];
  const menuSpy = { show(options) { shown.push(options); contextMenu.show(options); }, hide: (options) => contextMenu.hide(options) };
  const now = Date.now();
  const sessions = [
    { id: 'a1', title: 'Chat a1', project_id: 'project_alpha', updated_at: new Date(now - 60000).toISOString() },
    { id: 'g1', title: 'Chat g1', updated_at: new Date(now - 120000).toISOString() },
  ];
  const switcher = makeSwitcher();
  const controller = createChatsPanelController({
    state: { ui: {}, sessions },
    documentRef: doc,
    windowRef: window,
    dom: {
      conversationGroups: doc.getElementById('conversationGroups'),
      conversationCount: doc.getElementById('conversationCount'),
      scopeSlot: doc.getElementById('chatsScopeSlot'),
      projectRow: doc.getElementById('chatsProjectRow'),
      status: doc.getElementById('chatsPanelStatus'),
    },
    inventory: { actionButton, segmentedControl, contextMenu: menuSpy },
    callbacks: { getProjectSwitcher: async () => switcher, showToastMessage() {} },
  });
  t.after(() => { contextMenu.hide({ restoreFocus: false }); controller.dispose(); window.close(); });
  const q = (selector) => doc.querySelector(selector);
  const menuLabels = () => Array.from(doc.querySelectorAll('.inv-context-menu-item')).map((item) => item.textContent.trim());
  const rightClick = (el, init) => {
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  };
  return { window, doc, q, controller, shown, written, menuLabels, rightClick };
}

async function ready(h) {
  h.controller.renderNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.controller.renderNow();
  // The first menu read warms the helper's project cache.
  h.q('[data-project-menu="project_alpha"]').click();
  await settle();
  contextMenu.hide({ restoreFocus: false });
  h.shown.length = 0;
}

test('project header menu: Copy project name and path before Collapse all; General offers no path', async (t) => {
  const h = panelHarness(t);
  await ready(h);
  h.q('[data-project-menu="project_alpha"]').click();
  assert.deepEqual(h.menuLabels(), ['New chat in Alpha', 'Open as Workspace folder', 'Show only this project', 'Copy project name', 'Copy project path', 'Collapse all projects']);
  Array.from(h.doc.querySelectorAll('.inv-context-menu-item')).find((item) => item.textContent.trim() === 'Copy project path').click();
  await settle();
  assert.deepEqual(h.written, ['D:\\Work\\Alpha']);
  h.q('[data-project-menu="project_general"]').click();
  assert.equal(h.menuLabels().includes('Copy project path'), false);
  assert.ok(h.menuLabels().includes('Copy project name'));
});

test('right-click on a project header opens its menu at the pointer; the menu key anchors on the "..." button', async (t) => {
  const h = panelHarness(t);
  await ready(h);
  const header = h.q('.project-group[data-project-id="project_alpha"] .project-header');
  const event = h.rightClick(header.querySelector('[data-project-toggle]'), { clientX: 40, clientY: 70 });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].anchorX, 40);
  assert.equal(h.shown[0].anchorY, 70);
  assert.equal(h.shown[0].restoreFocusTo, header.querySelector('[data-project-toggle]'));
  assert.ok(h.menuLabels().includes('Copy project name'));

  h.rightClick(header);
  assert.equal(h.shown[1].restoreFocusTo, header.querySelector('[data-project-menu]'), 'no pointer: the keyboard path');

  const row = h.q('.conversation-item[data-session-id="a1"]');
  const rowEvent = h.rightClick(row, { clientX: 5, clientY: 5 });
  assert.equal(rowEvent.defaultPrevented, false, 'chat rows stay with the row menu');
  assert.equal(h.shown.length, 2);
});
