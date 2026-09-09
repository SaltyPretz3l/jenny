const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const actionButton = require('../renderer/inventory/action-button');
const popover = require('../renderer/inventory/popover');
const { createSidebarBulkActions } = require('../renderer/shell/renderer-sidebar-bulk-actions');
function harness(t, overrides = {}) {
  const dom = new JSDOM('<section id="sidebarHistorySection"><div id="chatsSelectionEntry"></div><input id="conversationSearch"><div><ul id="conversationGroups"></ul></div></section><button id="outside">Outside</button>');
  const doc = dom.window.document;
  const state = { sessions: ['a', 'b', 'hidden'].map(id => ({ id, title: id, updated_at: 'old', message_count: 1 })), ui: {}, sendOutboxBySession: new Map() };
  const groups = doc.getElementById('conversationGroups');
  for (const id of ['a', 'b']) groups.insertAdjacentHTML('beforeend', `<li class="conversation-item session-row" data-session-id="${id}"><button class="session-row__open" data-session-open="${id}" aria-label="Open ${id}" tabindex="${id === 'a' ? 0 : -1}"><span class="session-row__selection" aria-hidden="true"></span><span class="session-row__dot" aria-hidden="true"></span>${id}</button><button class="session-row__menu" data-session-action="menu" tabindex="${id === 'a' ? 0 : -1}">Menu</button></li>`);
  const calls = []; const toasts = []; const cleanups = []; let scheduled;
  dom.window.jennyShell = { sessions: { setMeta: async (id, patch) => { calls.push(['meta', id]); return { id, ...patch }; } } };
  const controller = createSidebarBulkActions({ state, windowRef: dom.window, actionButton, popover,
    scheduler: { schedule: (_, options) => { scheduled = options; options.markPending(); return true; } },
    callbacks: { registerCleanup: fn => cleanups.push(fn), renderSessions() {}, showToastMessage: text => toasts.push(text), showSessionActionError: err => toasts.push(err.message), hardDeleteSession: async (id, options) => { calls.push(['delete', id, options]); return { id, deleted: true }; }, ...overrides },
  });
  t.after(() => { cleanups.forEach(fn => fn()); dom.window.close(); });
  const control = id => doc.querySelector(`[data-action="sidebar-bulk-${id}"]`);
  return { dom, doc, groups, state, controller, calls, toasts, control, scheduled: () => scheduled };
}
test('selection is explicit, view scoped, and never includes unmounted chats', t => {
  const h = harness(t); h.controller.act('select'); h.controller.act('all');
  assert.deepEqual([...h.controller.selected], ['a', 'b']);
  const event = new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  let opened = 0; h.groups.addEventListener('click', () => opened++);
  h.groups.querySelector('button').dispatchEvent(event);
  assert.equal(opened, 0); assert.deepEqual([...h.controller.selected], ['b']);
  h.state.ui.sidebarArchivedView = true;
  h.groups.dispatchEvent(new h.dom.window.Event('sidebar-rendered'));
  assert.equal(h.controller.selected.size, 0);
  h.controller.act('all');
  const search = h.doc.getElementById('conversationSearch'); search.value = 'a'; search.dispatchEvent(new h.dom.window.Event('input'));
  assert.equal(h.controller.selected.size, 0);
});
test('delete requires confirmation, freezes IDs, skips queued work and Undo does not delete', t => {
  const h = harness(t); h.state.sendOutboxBySession.set('b', [{}]);
  h.controller.act('select'); h.controller.act('all'); h.controller.act('delete');
  assert.equal(h.scheduled(), undefined);
  h.controller.act('confirm');
  assert.deepEqual(h.state.ui.pendingSessionDeletes, ['a']);
  h.scheduled().onUndo();
  assert.deepEqual(h.state.ui.pendingSessionDeletes, []); assert.equal(h.calls.length, 0);
  assert.equal(h.state.ui.sidebarBulkBusy, false);
});
test('activity during Undo prevents deletion; eligible IDs receive the safe backend policy', async t => {
  const h = harness(t); h.controller.act('select'); h.controller.act('all'); h.controller.act('delete'); h.controller.act('confirm');
  h.state.sessions[0].updated_at = 'new';
  await h.scheduled().commit();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0], ['delete', 'b', { onlyIfIdle: true, expectedUpdatedAt: 'old' }]);
  assert.match(h.toasts[0], /1 deleted; 1 skipped; 0 failed/);
  assert.deepEqual(h.state.ui.pendingSessionDeletes, []);
});
test('partial delete failures restore pending state and retain failed selection', async t => {
  const h = harness(t, { hardDeleteSession: async id => { if (id === 'a') throw new Error('disk failure'); return { deleted: false }; } });
  h.controller.act('select'); h.controller.act('all'); h.controller.act('delete'); h.controller.act('confirm');
  await h.scheduled().commit();
  assert.equal(h.state.ui.sidebarBulkBusy, false); assert.deepEqual(h.state.ui.pendingSessionDeletes, []);
  assert.equal(h.controller.selected.size, 2); assert.match(h.toasts[0], /0 deleted; 1 skipped; 1 failed/);
});
test('archive uses explicit state, preserves pin and changes only mounted selected IDs', async t => {
  const h = harness(t); h.state.sessions[0].pinned = true;
  h.controller.act('select'); h.controller.act('all'); h.controller.act('archive');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, [['meta', 'a'], ['meta', 'b']]);
  assert.equal(h.state.sessions[0].pinned, true); assert.ok(h.state.sessions[0].archived_at);
  assert.equal(h.state.sessions[2].archived_at, undefined); assert.equal(h.controller.selected.size, 0);
});
test('mismatched archive acknowledgement leaves the row selected and unchanged', async t => {
  const h = harness(t); h.dom.window.jennyShell.sessions.setMeta = async () => ({ id: 'wrong' });
  h.controller.act('select'); h.controller.act('all'); h.controller.act('archive');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.selected.size, 2); assert.equal(h.state.sessions[0].archived_at, undefined);
  assert.match(h.toasts[0], /2 failed/);
});

test('compact controls expose none, mixed and all shown states without including hidden chats', t => {
  const h = harness(t);
  const bar = h.doc.querySelector('.sidebar-bulk-actions');
  assert.equal(bar.hidden, true);
  assert.equal(h.control('select').parentElement.id, 'chatsSelectionEntry');
  h.control('select').click();
  assert.equal(h.doc.activeElement, h.control('all'));
  assert.equal(h.control('select').hidden, true);
  assert.equal(h.control('archive').disabled, true);
  assert.equal(h.control('delete').disabled, true);
  assert.equal(h.control('all').getAttribute('aria-checked'), 'false');
  h.groups.querySelector('[data-session-open]').click();
  assert.equal(h.control('all').getAttribute('aria-checked'), 'mixed');
  h.control('all').click();
  assert.deepEqual([...h.controller.selected], ['a', 'b']);
  assert.equal(h.control('all').getAttribute('aria-checked'), 'true');
  assert.equal(h.control('all').getAttribute('aria-label'), 'Clear');
  h.control('all').click();
  assert.equal(h.controller.selected.size, 0);
  assert.equal(h.control('all').getAttribute('aria-label'), 'Select all shown');
  assert.ok(h.control('archive').querySelector('svg'));
  assert.ok(h.control('delete').querySelector('svg'));
  assert.equal(h.control('delete').getAttribute('aria-label'), 'Delete selected');
  h.control('done').click();
  assert.equal(bar.hidden, true);
  assert.equal(h.doc.activeElement, h.control('select'));
});

test('row keyboard selection keeps current-chat identity and activity separate and restores menu focus', t => {
  const h = harness(t);
  const open = h.groups.querySelector('[data-session-open]');
  const row = open.parentElement;
  const dot = row.querySelector('.session-row__dot');
  const menu = row.querySelector('[data-session-action="menu"]');
  row.dataset.sessionDominantState = 'streaming';
  open.setAttribute('aria-current', 'page');
  h.control('select').click();
  open.focus();
  let opened = 0;
  h.groups.addEventListener('keydown', () => opened++);
  open.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  assert.equal(opened, 0);
  assert.equal(open.getAttribute('aria-checked'), 'true');
  assert.equal(open.getAttribute('aria-current'), 'page');
  assert.equal(row.querySelector('.session-row__dot'), dot);
  assert.equal(menu.hidden, true);
  assert.equal(menu.tabIndex, -1);
  let contextMenus = 0;
  h.groups.addEventListener('contextmenu', () => contextMenus++);
  open.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(contextMenus, 0);
  assert.equal(open.getAttribute('aria-checked'), 'true');
  open.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.doc.activeElement, h.control('select'));
  assert.equal(open.hasAttribute('role'), false);
  assert.equal(open.getAttribute('aria-label'), 'Open a');
  assert.equal(menu.hidden, false);
  assert.equal(menu.tabIndex, open.tabIndex);
});

test('confirmation preserves the toolbar and selection; Cancel, Escape and outside dismissal never delete', t => {
  const h = harness(t);
  h.control('select').click(); h.control('all').click();
  const dialog = h.doc.getElementById('sidebarBulkConfirm');
  const status = h.doc.querySelector('[role="status"]');
  h.control('delete').click();
  assert.equal(dialog.hidden, false);
  assert.equal(h.doc.activeElement, h.control('cancel'));
  assert.equal(status.textContent, '2 selected');
  assert.equal(h.control('all').disabled, true);
  assert.equal(h.control('delete').getAttribute('aria-expanded'), 'true');
  assert.match(dialog.textContent, /Delete 2 chats\? Busy chats will be skipped/);
  assert.ok(h.control('confirm').classList.contains('btn--danger'));
  h.control('cancel').click();
  assert.equal(dialog.hidden, true);
  assert.equal(h.doc.activeElement, h.control('delete'));
  h.control('delete').click();
  h.control('cancel').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(dialog.hidden, true);
  assert.equal(h.doc.activeElement, h.control('delete'));
  assert.equal(h.control('select').hidden, true);
  h.control('delete').click();
  h.groups.querySelector('[data-session-open]').click();
  assert.equal(dialog.hidden, true);
  assert.equal(h.controller.selected.size, 2);
  h.control('delete').click();
  h.doc.getElementById('outside').click();
  assert.equal(dialog.hidden, true);
  assert.equal(h.scheduled(), undefined);
  assert.deepEqual(h.calls, []);
});

test('confirmation keyboard activation freezes IDs, reports Working and Undo returns focus to selection', t => {
  const h = harness(t);
  h.control('select').click(); h.control('all').click(); h.control('delete').click();
  const open = h.groups.querySelector('[data-session-open]');
  open.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(h.controller.selected.size, 2);
  h.control('confirm').click();
  const status = h.doc.querySelector('[role="status"]');
  assert.equal(status.textContent, 'Working…');
  assert.equal(h.doc.activeElement, status);
  assert.equal(h.doc.getElementById('sidebarBulkConfirm').hidden, true);
  for (const id of ['all', 'archive', 'delete', 'done']) assert.equal(h.control(id).disabled, true);
  assert.equal(open.getAttribute('aria-disabled'), 'true');
  assert.deepEqual(h.state.ui.pendingSessionDeletes, ['a', 'b']);
  h.scheduled().onUndo();
  assert.equal(h.doc.activeElement, h.control('all'));
  assert.equal(status.textContent, '2 selected');
  assert.deepEqual(h.calls, []);
});

test('mounted-row changes recompute select-all and scope changes update restore icons and dismiss confirmation', async t => {
  const h = harness(t);
  h.control('select').click(); h.control('all').click();
  const first = h.groups.firstElementChild;
  h.groups.lastElementChild.remove();
  h.groups.dispatchEvent(new h.dom.window.Event('sidebar-rendered'));
  assert.deepEqual([...h.controller.selected], ['a']);
  assert.equal(h.control('all').getAttribute('aria-checked'), 'true');
  assert.equal(h.groups.firstElementChild, first);
  const more = first.cloneNode(true);
  more.dataset.sessionId = 'b'; more.querySelector('[data-session-open]').dataset.sessionOpen = 'b';
  h.groups.append(more);
  h.groups.dispatchEvent(new h.dom.window.Event('sidebar-rendered'));
  assert.equal(h.control('all').getAttribute('aria-checked'), 'mixed');
  assert.equal(more.querySelector('[data-session-open]').getAttribute('aria-checked'), 'false');
  h.control('delete').click();
  const archiveIcon = h.control('archive').innerHTML;
  h.state.ui.sidebarArchivedView = true;
  h.state.sessions[0].archived_at = 'old';
  h.groups.dispatchEvent(new h.dom.window.Event('sidebar-rendered'));
  assert.equal(h.doc.getElementById('sidebarBulkConfirm').hidden, true);
  assert.equal(h.controller.selected.size, 0);
  assert.equal(h.control('archive').getAttribute('aria-label'), 'Restore selected');
  assert.equal(h.control('archive').dataset.tooltip, 'Restore selected');
  assert.notEqual(h.control('archive').innerHTML, archiveIcon);
  h.groups.querySelector('[data-session-open]').click();
  h.control('archive').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.sessions[0].archived_at, null);
});
