'use strict';

// D2 (Projects PO review 2026-09-27): any chat can move, not only the open
// one. The chat row menu gains "Move to project ›" (after Pin / Rename, before
// Archive) and the Chats bulk bar gains "Move to project"; both open the
// shared switcher's "Move this chat to" / "Move {n} chats to" menu, which owns
// the idle rule, the success toast and its Undo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSessionActionsController } = require('../renderer/shell/renderer-session-actions');
const { createSidebarBulkActions } = require('../renderer/shell/renderer-sidebar-bulk-actions');
const actionButton = require('../renderer/inventory/action-button');
const popover = require('../renderer/inventory/popover');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeSwitcher() {
  const opened = [];
  return {
    opened,
    async openMoveMenu(anchor, ids, options) { opened.push({ anchor, ids, options }); return {}; },
  };
}

function rowMenuHarness({ sessions, switcher, wired = true } = {}) {
  const dom = new JSDOM(`<body><ul id="list">${sessions.map((row) => `<li class="conversation-item" data-session-id="${row.id}"><button data-session-open="${row.id}">${row.id}</button><button data-session-action="menu">⋯</button></li>`).join('')}</ul></body>`);
  const shown = [];
  const contextMenu = { show(options) { shown.push(options); }, hide() {} };
  const controller = createSessionActionsController({
    state: { sessions, ui: {} },
    windowRef: { document: dom.window.document, CSS: dom.window.CSS },
    constants: { TOAST_SOURCE: {} },
    inventory: { contextMenu },
    modules: { destructiveUndoUtils: { createDestructiveUndoScheduler: () => ({ list: () => [] }) } },
    callbacks: {
      renderAll() {}, renderSessions() {}, showToastMessage() {}, appendClientLog() {}, registerCleanup() {}, showSessionActionError() {},
      ...(wired ? { getProjectSwitcher: async () => switcher } : {}),
    },
  });
  const trigger = (id) => dom.window.document.querySelector(`[data-session-id="${id}"] [data-session-action="menu"]`);
  return { dom, controller, shown, trigger };
}

test('row menu: "Move to project ›" sits after Rename and before Archive and opens the move menu for that chat', async () => {
  const switcher = fakeSwitcher();
  const h = rowMenuHarness({ sessions: [{ id: 's1', title: 'Intake', project_id: 'project_ascend' }, { id: 's2', title: 'Other' }], switcher });
  const trigger = h.trigger('s1');
  assert.equal(h.controller.openSessionRowMenu({ sessionId: 's1', trigger }), true);
  const labels = h.shown[0].items.filter((item) => !item.separator).map((item) => item.label);
  assert.deepEqual(labels, ['Pin', 'Rename', 'Move to project ›', 'Archive', 'Delete']);
  await h.shown[0].items.find((item) => item.label === 'Move to project ›').action();
  assert.equal(switcher.opened.length, 1);
  assert.deepEqual(switcher.opened[0].ids, ['s1'], 'only the row\'s chat, not the open one');
  assert.equal(switcher.opened[0].anchor, trigger, 'anchored on the row\'s ⋯');
});

test('row menu: a right-click (no trigger) anchors the move menu on the row\'s ⋯', async () => {
  const switcher = fakeSwitcher();
  const h = rowMenuHarness({ sessions: [{ id: 's1', title: 'Intake' }], switcher });
  h.controller.openSessionRowMenu({ sessionId: 's1', anchorX: 10, anchorY: 10 });
  await h.shown[0].items.find((item) => item.label === 'Move to project ›').action();
  assert.equal(switcher.opened[0].anchor, h.trigger('s1'));
});

test('row menu: plugin sessions and windows without a switcher get no Move entry', () => {
  const plugin = rowMenuHarness({ sessions: [{ id: 'p1', title: 'Plugin', session_type: 'plugin' }], switcher: fakeSwitcher() });
  plugin.controller.openSessionRowMenu({ sessionId: 'p1', trigger: plugin.trigger('p1') });
  assert.equal(plugin.shown[0].items.some((item) => item.label === 'Move to project ›'), false);
  const bare = rowMenuHarness({ sessions: [{ id: 's1', title: 'Intake' }], wired: false });
  bare.controller.openSessionRowMenu({ sessionId: 's1', trigger: bare.trigger('s1') });
  assert.equal(bare.shown[0].items.some((item) => item.label === 'Move to project ›'), false);
});

function bulkHarness(t, { switcher, wired = true } = {}) {
  const dom = new JSDOM('<section id="sidebarHistorySection"><div id="chatsSelectionEntry"></div><input id="conversationSearch"><div><ul id="conversationGroups"></ul></div></section>');
  const doc = dom.window.document;
  const state = { sessions: ['a', 'b', 'c'].map((id) => ({ id, title: id, updated_at: 'old', message_count: 1 })), ui: {}, sendOutboxBySession: new Map() };
  const groups = doc.getElementById('conversationGroups');
  for (const id of ['a', 'b', 'c']) groups.insertAdjacentHTML('beforeend', `<li class="conversation-item session-row" data-session-id="${id}"><button class="session-row__open" data-session-open="${id}">${id}</button><button data-session-action="menu">Menu</button></li>`);
  const cleanups = [];
  const controller = createSidebarBulkActions({
    state, windowRef: dom.window, actionButton, popover,
    scheduler: { schedule: () => true },
    callbacks: {
      registerCleanup: (fn) => cleanups.push(fn), renderSessions() {}, showToastMessage() {}, showSessionActionError() {},
      ...(wired ? { getProjectSwitcher: async () => switcher } : {}),
    },
  });
  t.after(() => { cleanups.forEach((fn) => fn()); dom.window.close(); });
  const control = (id) => doc.querySelector(`[data-action="sidebar-bulk-${id}"]`);
  return { doc, controller, control };
}

test('bulk bar: "Move to project" is disabled without a selection and opens the move menu with the selected ids', async (t) => {
  const switcher = fakeSwitcher();
  const h = bulkHarness(t, { switcher });
  h.controller.act('select');
  const move = h.control('move');
  assert.ok(move, 'the bulk bar has Move');
  assert.equal(move.getAttribute('aria-label'), 'Move to project');
  assert.equal(move.getAttribute('aria-haspopup'), 'menu');
  assert.equal(move.disabled, true, 'nothing selected yet');
  const order = [...h.doc.querySelectorAll('.sidebar-bulk-buttons [data-action]')].map((node) => node.dataset.action.replace('sidebar-bulk-', ''));
  assert.deepEqual(order, ['move', 'archive', 'delete', 'done']);
  h.controller.act('all');
  assert.equal(move.disabled, false);
  h.controller.act('move');
  await settle();
  assert.equal(switcher.opened.length, 1);
  assert.deepEqual(switcher.opened[0].ids, ['a', 'b', 'c']);
  assert.equal(switcher.opened[0].anchor, move);

  // The switcher reports what moved (busy chats are skipped): those leave the selection.
  switcher.opened[0].options.onMoved({ moved: ['a', 'c'], skipped: ['b'], failed: [], unchanged: [] });
  assert.deepEqual([...h.controller.selected], ['b'], 'a skipped chat stays selected');
});

test('bulk bar: no Move without a project switcher', (t) => {
  const h = bulkHarness(t, { wired: false });
  h.controller.act('select');
  assert.equal(h.control('move'), null);
  assert.ok(h.control('archive'));
});

test('row menu: "Link sessions…" sits after Rename, carries the linked count, and opens the popover anchored on the row', async () => {
  const opened = [];
  const dom = new JSDOM('<body><ul id="list"><li class="conversation-item" data-session-id="s1"><button data-session-open="s1">s1</button><button data-session-action="menu">⋯</button></li><li class="conversation-item" data-session-id="p1"><button data-session-action="menu">⋯</button></li></ul></body>');
  const shown = [];
  const controller = createSessionActionsController({
    state: { sessions: [{ id: 's1', title: 'Intake', linked_session_ids: ['a', 'b'] }, { id: 'p1', title: 'Plugin', session_type: 'plugin' }], ui: {} },
    windowRef: { document: dom.window.document, CSS: dom.window.CSS },
    constants: { TOAST_SOURCE: {} },
    inventory: { contextMenu: { show(options) { shown.push(options); }, hide() {} } },
    modules: { destructiveUndoUtils: { createDestructiveUndoScheduler: () => ({ list: () => [] }) } },
    callbacks: {
      renderAll() {}, renderSessions() {}, showToastMessage() {}, appendClientLog() {}, registerCleanup() {}, showSessionActionError() {},
      openLinkedSessions: (sessionId, anchor) => { opened.push({ sessionId, anchor }); },
    },
  });
  const trigger = dom.window.document.querySelector('[data-session-id="s1"] [data-session-action="menu"]');
  assert.equal(controller.openSessionRowMenu({ sessionId: 's1', trigger }), true);
  const labels = shown[0].items.filter((item) => !item.separator).map((item) => item.label);
  assert.deepEqual(labels, ['Pin', 'Rename', 'Link sessions… · 2 linked', 'Archive', 'Delete']);
  await shown[0].items.find((item) => item.label.startsWith('Link sessions')).action();
  assert.deepEqual(opened, [{ sessionId: 's1', anchor: trigger }], 'opens the popover for that chat, anchored on its ⋯');
  assert.equal(controller.openSessionRowMenu({ sessionId: 'p1' }), true);
  assert.equal(shown[1].items.some((item) => String(item.label || '').startsWith('Link sessions')), false, 'plugin sessions are never linked');
});
