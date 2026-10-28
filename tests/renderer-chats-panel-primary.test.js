'use strict';

// Row 69: the primary "Jenny" chat in the chats sidebar. It is always the first
// row (above pinned chats, inside the Pinned group), stays visible under every
// project filter, carries the primary mark and label, and is never archived,
// deleted, moved, linked or bulk-selected from the sidebar. The kill switch
// (JENNY_ENABLE_PRIMARY_CHAT=0, feature flag primary_chat=false) hides the row.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const tree = require('../renderer/shell/renderer-chats-panel-tree');
const { buildChatsViewModel } = require('../renderer/shell/renderer-chats-panel');
const { createSessionActionsController } = require('../renderer/shell/renderer-session-actions');
const { createSidebarBulkActions } = require('../renderer/shell/renderer-sidebar-bulk-actions');
const actionButton = require('../renderer/inventory/action-button');
const popover = require('../renderer/inventory/popover');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const NOW = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
const iso = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();
const chat = (id, minutesAgo, extra = {}) => ({ id, title: `Chat ${id}`, updated_at: iso(minutesAgo), created_at: iso(minutesAgo), pinned: false, archived_at: null, ...extra });
const PRIMARY = chat('primary', 600, { title: 'Jenny', session_role: 'primary', project_id: 'project_general' });

test('tree: the primary sorts before pinned chats and lands in the Pinned group even when unpinned', () => {
  const sessions = [chat('recent', 1), chat('pinned', 30, { pinned: true }), PRIMARY, chat('older', 5000)];
  const sorted = tree.sortSessions(sessions);
  assert.deepEqual(sorted.map((s) => s.id), ['primary', 'pinned', 'recent', 'older']);
  const groups = tree.groupVisibleSessions(sorted, 'recent', NOW);
  assert.equal(groups[0].key, 'recent_pinned');
  assert.deepEqual(groups[0].items.map((s) => s.id), ['primary', 'pinned']);
  assert.equal(tree.isPrimarySession(PRIMARY), true);
  assert.equal(tree.isPrimarySession(chat('x', 1, { session_role: 'other' })), false);
  assert.equal(tree.isPrimarySession(null), false);
});

test('view model: the primary stays visible under another project filter, counts for General only, and the kill switch hides it', () => {
  const sessions = [PRIMARY, chat('a', 2, { project_id: 'project_ascend' }), chat('g', 3)];
  const ascend = buildChatsViewModel({ sessions, scope: 'recent', projectId: 'project_ascend', now: NOW });
  assert.deepEqual(ascend.visibleSessions.map((s) => s.id), ['primary', 'a']);
  assert.equal(ascend.recentTotal + ascend.archivedTotal, 1, 'the primary is not counted against another project');
  assert.equal(ascend.emptyKind, '');
  const general = buildChatsViewModel({ sessions, scope: 'recent', projectId: 'project_general', now: NOW });
  assert.deepEqual(general.visibleSessions.map((s) => s.id), ['primary', 'g']);
  assert.equal(general.recentTotal + general.archivedTotal, 2);
  const grants = buildChatsViewModel({ sessions, scope: 'recent', projectId: 'project_grants', now: NOW });
  assert.deepEqual(grants.visibleSessions.map((s) => s.id), ['primary'], 'the Jenny row still renders');
  assert.equal(grants.emptyKind, 'project', 'the Jenny row alone does not hide the project empty state');
  const fresh = buildChatsViewModel({ sessions: [PRIMARY], scope: 'recent', now: NOW });
  assert.equal(fresh.emptyKind, 'empty');
  assert.equal(fresh.noHistory, true, 'a profile with only the Jenny chat has no history yet');
  const archived = buildChatsViewModel({ sessions, scope: 'archived', now: NOW });
  assert.deepEqual(archived.visibleSessions, [], 'the primary never shows in the archived scope');
  const searched = buildChatsViewModel({ sessions, scope: 'recent', query: 'chat a', now: NOW });
  assert.deepEqual(searched.visibleSessions.map((s) => s.id), ['a'], 'search still filters the primary by title');
  const jennySearch = buildChatsViewModel({ sessions, scope: 'recent', query: 'jenny', now: NOW });
  assert.deepEqual(jennySearch.visibleSessions.map((s) => s.id), ['primary']);
  assert.equal(jennySearch.emptyKind, '', 'a search that matches the Jenny row has a result');
  const off = buildChatsViewModel({ sessions, scope: 'recent', primaryChatEnabled: false, now: NOW });
  assert.deepEqual(off.visibleSessions.map((s) => s.id), ['a', 'g'], 'primary_chat=false hides the row');
});

test('rows: the primary row renders first with its mark, label, dataset and class', async (t) => {
  const app = await loadRendererApp();
  t.after(() => app.dispose());
  const { window, shell } = app;
  const recent = new Date(Date.now() - 5 * 60000).toISOString();
  const base = { conversation_mode: 'chat', preferred_model: 'gpt-test', message_count: 1, linked_session_ids: [], archived_at: null, created_at: recent };
  shell.__state.sessions = [
    { ...base, id: 'session-pinned', title: 'Pinned Plan', updated_at: recent, pinned: true, last_message_preview: 'pinned' },
    { ...base, id: 'session-jenny', title: 'Jenny', updated_at: new Date(Date.now() - 3 * 86400000).toISOString(), pinned: false, session_role: 'primary', last_message_preview: 'hello' },
    { ...base, id: 'session-recent', title: 'Recent Plan', updated_at: recent, pinned: false, last_message_preview: 'recent' },
  ];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);
  const rows = [...window.document.querySelectorAll('.conversation-item[data-session-id]')];
  assert.deepEqual(rows.map((row) => row.dataset.sessionId), ['session-jenny', 'session-pinned', 'session-recent']);
  const row = rows[0];
  assert.equal(row.dataset.sessionRole, 'primary');
  assert.equal(row.classList.contains('session-row--primary'), true);
  assert.ok(row.querySelector('.session-row__primary-mark svg'), 'the spark mark renders');
  assert.equal(row.querySelector('.session-row__pin'), null, 'the primary never shows the pin glyph');
  assert.equal(row.querySelector('.session-row__title-text').textContent, 'Jenny');
  const open = row.querySelector('[data-session-open]');
  assert.equal(open.getAttribute('aria-label'), 'Open your Jenny chat Jenny', 'first paint and the chrome relabel agree on the noun');
  assert.match(open.getAttribute('title'), /^Your Jenny chat: ask what you were working on/);
  assert.equal(rows[1].dataset.sessionRole, undefined, 'ordinary rows carry no role');
  assert.equal(row.closest('.conversation-group').querySelector('.group-label').textContent.trim(), 'Pinned');
});

test('rows: a paused primary shows the Paused tag after its title, repaints on the flip, and no other row has one', () => {
  const { createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');
  const dom = new JSDOM('<!doctype html><html><body><div id="scope"></div><input id="search"><div id="count"></div><div id="groups"></div><div id="status"></div></body></html>');
  const doc = dom.window.document;
  const frames = [];
  const sessions = [chat('primary', 5, { title: 'Jenny', session_role: 'primary' }), chat('other', 6)];
  const state = { sessions, currentSessionId: 'other', ui: { pendingSessionDeletes: [], primaryChat: { paused: true, session_id: 'primary' } }, sendOutboxBySession: new Map() };
  const controller = createChatsPanelController({
    state,
    documentRef: doc,
    windowRef: { Event: dom.window.Event, performance: { now: () => 0 }, requestAnimationFrame: (callback) => frames.push(callback), cancelAnimationFrame() {} },
    dom: { scopeSlot: doc.getElementById('scope'), searchInput: doc.getElementById('search'), conversationCount: doc.getElementById('count'), conversationGroups: doc.getElementById('groups'), status: doc.getElementById('status') },
    inventory: { actionButton, segmentedControl: require('../renderer/inventory/segmented-control') },
    callbacks: { escapeHtml: actionButton.escapeHtml, appendClientLog() {}, newChat() {} },
  });
  controller.renderSessions();
  frames.shift()();
  const tags = [...doc.querySelectorAll('.session-row__paused')];
  assert.equal(tags.length, 1);
  assert.equal(tags[0].textContent, 'Paused');
  assert.equal(tags[0].previousElementSibling.className, 'session-row__title-text');
  assert.equal(tags[0].closest('[data-session-id]').dataset.sessionId, 'primary');
  state.ui.primaryChat = { paused: false, session_id: 'primary' };
  controller.renderSessions();
  frames.shift()();
  assert.equal(doc.querySelectorAll('.session-row__paused').length, 0, 'the tag goes away when the flag flips');
  dom.window.close();
});

function actionsHarness(sessions, extraCallbacks = {}) {
  const dom = new JSDOM(`<body><ul id="list">${sessions.map((row) => `<li class="conversation-item" data-session-id="${row.id}"><button data-session-open="${row.id}">${row.id}</button><button data-session-action="menu">x</button></li>`).join('')}</ul></body>`);
  const shown = [];
  const metaCalls = [];
  dom.window.jennyShell = { sessions: { setMeta: async (id, patch) => { metaCalls.push([id, patch]); return { id, ...patch }; } } };
  const controller = createSessionActionsController({
    state: { sessions, ui: {} },
    windowRef: dom.window,
    constants: { TOAST_SOURCE: {} },
    inventory: { contextMenu: { show(options) { shown.push(options); }, hide() {} } },
    modules: { destructiveUndoUtils: { createDestructiveUndoScheduler: () => ({ list: () => [], schedule: () => { throw new Error('must not schedule'); } }) } },
    callbacks: {
      renderAll() {}, renderSessions() {}, showToastMessage() {}, appendClientLog() {}, registerCleanup() {}, showSessionActionError() {},
      getProjectSwitcher: async () => ({}), openLinkedSessions() {}, openSendToChat() {},
      ...extraCallbacks,
    },
  });
  return { dom, controller, shown, metaCalls };
}

test('row menu: the primary offers Rename, Send to chat and its controls group; delete and archive are refused', async (t) => {
  const sessions = [{ id: 'p', title: 'Jenny', session_role: 'primary', pinned: true }, { id: 's', title: 'Other', pinned: false }];
  globalThis.rendererPrimarySessionMenu = require('../renderer/shell/renderer-primary-session-menu');
  t.after(() => { delete globalThis.rendererPrimarySessionMenu; });
  const store = { isPaused: () => false, getSnapshot: () => ({ status: 'ready', flags: {} }), pause() {}, resume() {} };
  const h = actionsHarness(sessions, { getPrimaryChatStore: () => store });
  assert.equal(h.controller.openSessionRowMenu({ sessionId: 'p' }), true);
  const labels = (index) => h.shown[index].items.filter((item) => !item.separator).map((item) => item.label);
  assert.deepEqual(labels(0), ['Rename', 'Send to chat…', 'Pause Jenny', 'Activity…', 'Reset chat…', 'Forget…']);
  h.controller.openSessionRowMenu({ sessionId: 's' });
  assert.deepEqual(labels(1), ['Pin', 'Rename', 'Link sessions…', 'Send to chat…', 'Move to project ›', 'Archive', 'Delete']);
  assert.equal(h.controller.requestDeleteSession('p'), false, 'delete is refused before any undo toast');
  await h.controller.toggleArchiveSession('p');
  assert.deepEqual(h.metaCalls, [], 'archive never reaches the backend');
  assert.equal(h.controller.isSessionPendingDelete('p'), false);
});

test('bulk actions: the primary row is never part of the selection', (t) => {
  const dom = new JSDOM('<section id="sidebarHistorySection"><div id="chatsSelectionEntry"></div><input id="conversationSearch"><div><ul id="conversationGroups"></ul></div></section>');
  const doc = dom.window.document;
  const state = { sessions: [{ id: 'p', title: 'Jenny', session_role: 'primary', updated_at: 'old', message_count: 1 }, { id: 'a', title: 'a', updated_at: 'old', message_count: 1 }], ui: {}, sendOutboxBySession: new Map() };
  const groups = doc.getElementById('conversationGroups');
  const rowHtml = (id, role) => `<li class="conversation-item session-row" data-session-id="${id}"${role ? ` data-session-role="${role}"` : ''}><button class="session-row__open" data-session-open="${id}" tabindex="0"><span class="session-row__selection" aria-hidden="true"></span>${id}</button><button class="session-row__menu" data-session-action="menu">Menu</button></li>`;
  groups.insertAdjacentHTML('beforeend', rowHtml('p', 'primary') + rowHtml('a'));
  const cleanups = [];
  const controller = createSidebarBulkActions({ state, windowRef: dom.window, actionButton, popover,
    scheduler: { schedule: () => true },
    callbacks: { registerCleanup: (fn) => cleanups.push(fn), renderSessions() {}, showToastMessage() {}, showSessionActionError() {}, hardDeleteSession: async () => ({}) },
  });
  t.after(() => { cleanups.forEach((fn) => fn()); dom.window.close(); });
  controller.act('select');
  controller.act('all');
  assert.deepEqual([...controller.selected], ['a'], 'select-all skips the primary');
  groups.querySelector('[data-session-id="p"] .session-row__open').click();
  assert.deepEqual([...controller.selected], ['a'], 'a click on the primary row selects nothing');
  const primaryOpen = groups.querySelector('[data-session-id="p"] .session-row__open');
  assert.equal(primaryOpen.getAttribute('role'), null, 'the primary row is not painted as a checkbox');
  assert.equal(groups.querySelector('[data-session-id="p"]').classList.contains('sidebar-bulk-selecting'), false);
});
