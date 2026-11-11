'use strict';

// The Chats sidebar selection harness: four rows (plus an optional primary) over JSDOM, the real
// context menu, and bubble-phase probes standing in for the shell's own row handlers.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const contextMenu = require('../../renderer/inventory/context-menu');
const { createSidebarBulkActions } = require('../../renderer/shell/renderer-sidebar-bulk-actions');

const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(t, { overrides = {}, withPrimary = false, wired = true, current = '', archived = false, scheduler } = {}) {
  const dom = new JSDOM('<section id="sidebarHistorySection"><input id="conversationSearch"><div><ul id="conversationGroups"></ul></div></section><button id="outside">Outside</button>');
  const W = dom.window;
  const doc = W.document;
  const ids = ['a', 'b', 'c', 'd'];
  const state = {
    sessions: [...ids, 'hidden', 'p'].map(id => ({ id, title: id, updated_at: 'old', message_count: 1, ...(archived ? { archived_at: 'old' } : {}) })),
    ui: archived ? { sidebarArchivedView: true } : {}, sendOutboxBySession: new Map(), currentSessionId: current,
  };
  const groups = doc.getElementById('conversationGroups');
  const rowHtml = (id, role) => `<li class="conversation-item session-row" data-session-id="${id}"${role ? ` data-session-role="${role}"` : ''}><button class="session-row__open" data-session-open="${id}" aria-label="Open ${id}" tabindex="${id === 'a' ? 0 : -1}">${id}</button><button class="session-row__menu" data-session-action="menu">Menu</button></li>`;
  if (withPrimary) groups.insertAdjacentHTML('beforeend', rowHtml('p', 'primary'));
  for (const id of ids) groups.insertAdjacentHTML('beforeend', rowHtml(id));
  const calls = []; const toasts = []; const cleanups = []; const roving = []; let scheduled;
  const switcher = { opened: [], openMoveMenu(anchor, movedIds, options) { this.opened.push({ anchor, ids: movedIds, options }); } };
  W.jennyShell = { sessions: { setMeta: async (id, patch) => { calls.push(['meta', id, patch]); return { id, ...patch }; } } };
  const controller = createSidebarBulkActions({
    state, windowRef: W, contextMenu,
    scheduler: scheduler || { schedule: (_, options) => { scheduled = options; options.markPending(); return true; } },
    callbacks: {
      registerCleanup: fn => cleanups.push(fn), renderSessions() {}, showToastMessage: text => toasts.push(text), showSessionActionError: (err, title) => toasts.push(`${title}: ${err.message}`),
      setRovingChatSession: id => roving.push(id),
      hardDeleteSession: async (id, options) => { calls.push(['delete', id, options]); return { id, deleted: true }; },
      ...(wired ? { getProjectSwitcher: async () => switcher } : {}), ...overrides,
    },
  });
  // Bubble-phase probes stand in for the shell's own handlers on the same node.
  const bubbled = { click: 0, contextmenu: 0, keydown: [] };
  groups.addEventListener('click', () => { bubbled.click += 1; });
  groups.addEventListener('contextmenu', () => { bubbled.contextmenu += 1; });
  groups.addEventListener('keydown', event => { bubbled.keydown.push(event.key); });
  t.after(() => { contextMenu.hide({ restoreFocus: false }); cleanups.forEach(fn => fn()); W.close(); });
  const open = id => groups.querySelector(`[data-session-id="${id}"] [data-session-open]`);
  const menuButton = id => groups.querySelector(`[data-session-id="${id}"] [data-session-action="menu"]`);
  const mouse = (type, target, mods = {}) => { const event = new W.MouseEvent(type, { bubbles: true, cancelable: true, ...mods }); target.dispatchEvent(event); return event; };
  const click = (id, mods = {}) => mouse('click', open(id), mods);
  const ctrl = id => click(id, { ctrlKey: true });
  const key = (id, k, mods = {}) => { const event = new W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }); open(id).dispatchEvent(event); return event; };
  const labels = () => [...doc.querySelectorAll('.inv-context-menu-item')].map(item => item.textContent);
  const heading = () => doc.querySelector('.inv-context-menu-heading')?.textContent;
  const pick = label => { const item = [...doc.querySelectorAll('.inv-context-menu-item')].find(node => node.textContent === label); assert.ok(item, `menu item ${label} exists in [${labels()}]`); item.click(); };
  const status = () => doc.querySelector('.sidebar-bulk-status');
  const sel = () => [...controller.selected];
  const deleteSelected = () => { const n = controller.selected.size; mouse('contextmenu', open('a')); pick(`Delete ${n} chats…`); pick(`Delete ${n} chats`); };
  const rendered = () => groups.dispatchEvent(new W.Event('sidebar-rendered'));
  return { dom, W, doc, groups, state, controller, calls, toasts, cleanups, roving, switcher, bubbled, open, menuButton, mouse, click, ctrl, key, labels, heading, pick, status, sel, deleteSelected, rendered, scheduled: () => scheduled };
}

module.exports = { harness, settle };
