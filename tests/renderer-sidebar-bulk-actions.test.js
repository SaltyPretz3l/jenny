// Chats sidebar selection: clicks, keys, paint and lifecycle. Menus and actions: renderer-sidebar-bulk-actions-menu.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const contextMenu = require('../renderer/inventory/context-menu');
const { createSidebarBulkActions } = require('../renderer/shell/renderer-sidebar-bulk-actions');
const { harness, settle } = require('./helpers/sidebar-bulk-harness');

test('the sidebar has no select mode: no Select button, toolbar or row checkbox roles', t => {
  const h = harness(t);
  assert.equal(h.doc.querySelector('[data-action="sidebar-bulk-select"]'), null);
  assert.equal(h.doc.querySelector('.sidebar-bulk-actions'), null);
  h.ctrl('a'); h.ctrl('b');
  assert.equal(h.open('a').hasAttribute('role'), false);
  assert.equal(h.open('a').hasAttribute('aria-checked'), false);
  assert.equal(h.groups.querySelector('.sidebar-bulk-selecting'), null);
  assert.equal(h.groups.querySelector('.session-row__selection'), null);
});

test('returns null without the menu primitive or the sidebar nodes', t => {
  const h = harness(t);
  assert.equal(createSidebarBulkActions({ state: h.state, windowRef: h.W, contextMenu: null, scheduler: {}, callbacks: { registerCleanup() {} } }), null);
  const bare = new JSDOM('<div id="conversationGroups"></div>');
  t.after(() => bare.window.close());
  assert.equal(createSidebarBulkActions({ state: h.state, windowRef: bare.window, contextMenu, scheduler: {}, callbacks: { registerCleanup() {} } }), null);
});

test('Ctrl and Meta click toggle a row, never reach the open handler, focus the row and set the anchor', t => {
  const h = harness(t);
  const event = h.ctrl('a');
  assert.deepEqual(h.sel(), ['a']);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.bubbled.click, 0, 'the chat does not open');
  assert.equal(h.doc.activeElement, h.open('a'));
  assert.deepEqual(h.roving, ['a']);
  h.click('c', { metaKey: true });
  assert.deepEqual(h.sel(), ['a', 'c']);
  h.ctrl('a');
  assert.deepEqual(h.sel(), ['c']);
  assert.equal(h.bubbled.click, 0);
  // The anchor moved with the last toggle: a Shift+click ranges from a.
  h.click('d', { shiftKey: true });
  assert.deepEqual(h.sel().sort(), ['a', 'b', 'c', 'd']);
});

test('a plain click clears the selection, reaches the open handler and becomes the anchor', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  const event = h.click('c');
  assert.equal(h.controller.selected.size, 0);
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.bubbled.click, 1);
  h.click('d', { shiftKey: true });
  assert.deepEqual(h.sel().sort(), ['c', 'd'], 'range starts at the plainly clicked row');
  assert.equal(h.bubbled.click, 1);
});

test('Shift+click selects the range from the anchor in either direction; Ctrl+Shift adds it; the anchor stays', t => {
  const h = harness(t);
  h.ctrl('b');
  h.click('d', { shiftKey: true });
  assert.deepEqual(h.sel().sort(), ['b', 'c', 'd']);
  h.click('a', { shiftKey: true });
  assert.deepEqual(h.sel().sort(), ['a', 'b'], 'Shift replaces the selection and ranges upward from the same anchor');
  h.click('c', { shiftKey: true, ctrlKey: true });
  assert.deepEqual(h.sel().sort(), ['a', 'b', 'c'], 'Ctrl+Shift adds the range b..c');
  assert.equal(h.bubbled.click, 0);
  assert.equal(h.doc.activeElement, h.open('c'));
  assert.equal(h.roving.at(-1), 'c');
});

test('Shift+click with no anchor starts at the open chat, then at the clicked row', t => {
  const withCurrent = harness(t, { current: 'b' });
  const event = withCurrent.click('d', { shiftKey: true });
  assert.deepEqual(withCurrent.sel().sort(), ['b', 'c', 'd']);
  assert.equal(event.defaultPrevented, true);
  withCurrent.click('a', { shiftKey: true });
  assert.deepEqual(withCurrent.sel().sort(), ['a', 'b'], 'the open chat became the anchor');
  const none = harness(t, { current: 'gone' });
  none.click('c', { shiftKey: true });
  assert.deepEqual(none.sel(), ['c']);
  none.click('a', { shiftKey: true });
  assert.deepEqual(none.sel().sort(), ['a', 'b', 'c']);
});

test('the primary row is never selected: a modified click on it does nothing, a plain click opens it', t => {
  const h = harness(t, { withPrimary: true });
  h.ctrl('a');
  const event = h.click('p', { ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.bubbled.click, 0, 'a modified click does not open the primary chat');
  assert.deepEqual(h.sel(), ['a'], 'and keeps the selection being built');
  h.click('p', { shiftKey: true });
  assert.equal(h.bubbled.click, 0);
  assert.deepEqual(h.sel(), ['a']);
  h.click('p');
  assert.equal(h.bubbled.click, 1, 'a plain click opens it');
  assert.equal(h.controller.selected.size, 0, 'and clears the selection');
  h.key('a', 'a', { ctrlKey: true });
  assert.deepEqual(h.sel().sort(), ['a', 'b', 'c', 'd'], 'select all skips the primary');
  assert.equal(h.groups.querySelector('[data-session-id="p"]').classList.contains('sidebar-bulk-selected'), false);
  h.click('d', { shiftKey: true });
  assert.equal(h.sel().includes('p'), false);
});

test('clicks on the ⋯ button, a chevron or the row background are not row clicks', t => {
  const h = harness(t);
  h.groups.querySelector('[data-session-id="a"]').insertAdjacentHTML('beforeend', '<button class="session-row__chevron" data-session-toggle="a">v</button>');
  h.mouse('click', h.groups.querySelector('[data-session-toggle]'), { ctrlKey: true });
  h.mouse('click', h.groups.querySelector('[data-session-id="a"]'), { ctrlKey: true, shiftKey: true });
  assert.equal(h.controller.selected.size, 0);
  assert.equal(h.bubbled.click, 2, 'both passed through untouched');
  h.mouse('click', h.menuButton('b'), { ctrlKey: true });
  assert.equal(h.controller.selected.size, 0);
  assert.equal(h.bubbled.click, 3);
});

test('Shift mousedown on a row is prevented so the browser selects no text', t => {
  const h = harness(t);
  assert.equal(h.mouse('mousedown', h.open('a'), { shiftKey: true, button: 0 }).defaultPrevented, true);
  assert.equal(h.mouse('mousedown', h.open('a'), { button: 0 }).defaultPrevented, false);
  assert.equal(h.mouse('mousedown', h.menuButton('a'), { shiftKey: true, button: 0 }).defaultPrevented, false);
});

test('Shift+Arrow selects synchronously, before the shell moves focus, so the range never trails focus', t => {
  const h = harness(t);
  h.open('b').focus();
  // A real keypress runs microtasks between listeners; read the selection from inside the shell's slot.
  let seen = null;
  h.groups.addEventListener('keydown', () => { seen = h.sel(); });
  h.key('b', 'ArrowDown', { shiftKey: true });
  assert.deepEqual(seen, ['b', 'c'], 'the range already reaches the row focus is about to land on');
  h.key('b', 'End', { shiftKey: true });
  assert.deepEqual(h.sel(), ['b', 'c', 'd']);
  h.key('b', 'Home', { shiftKey: true });
  assert.deepEqual(h.sel(), ['a', 'b']);
});

test('with nothing selected, Shift+Arrow starts the range at the focused row, not an old click anchor', t => {
  const h = harness(t);
  h.click('a');
  h.key('c', 'ArrowDown', { shiftKey: true });
  assert.deepEqual(h.sel(), ['c', 'd']);
});

test('right-click inside the inline rename input keeps the text menu', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  const input = h.doc.createElement('input');
  h.open('a').append(input);
  const event = h.mouse('contextmenu', input);
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.doc.querySelector('.inv-context-menu'), null);
});

test('Escape clears a selection without reaching the search-clear handler; with none it passes', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  const event = h.key('a', 'Escape');
  assert.equal(h.controller.selected.size, 0);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.bubbled.keydown, []);
  h.key('a', 'Escape');
  assert.deepEqual(h.bubbled.keydown, ['Escape']);
});

test('keys and clicks inside the inline rename input stay with the editor', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  const input = h.doc.createElement('input');
  h.open('b').append(input);
  for (const [k, mods] of [['Delete', {}], ['Escape', {}], ['a', { ctrlKey: true }], ['End', { shiftKey: true }]]) {
    const event = new h.W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `${k} is not taken from the editor`);
  }
  assert.equal(h.doc.querySelector('.inv-context-menu'), null, 'Delete in the editor opens no confirm');
  h.mouse('click', input, { ctrlKey: true });
  assert.deepEqual(h.sel(), ['a', 'b'], 'the selection is unchanged');
});

test('Enter and Space are no longer intercepted', t => {
  const h = harness(t);
  h.ctrl('a');
  h.key('b', 'Enter'); h.key('b', ' ');
  assert.deepEqual(h.bubbled.keydown, ['Enter', ' ']);
  assert.deepEqual(h.sel(), ['a']);
});

test('Ctrl+A selects every shown row and Ctrl+Space toggles the focused row', t => {
  const h = harness(t);
  const all = h.key('b', 'a', { ctrlKey: true });
  assert.deepEqual(h.sel(), ['a', 'b', 'c', 'd']);
  assert.equal(all.defaultPrevented, true);
  assert.deepEqual(h.bubbled.keydown, []);
  h.controller.clear();
  const toggle = h.key('c', ' ', { ctrlKey: true });
  assert.deepEqual(h.sel(), ['c']);
  assert.equal(toggle.defaultPrevented, true);
  h.key('c', ' ', { metaKey: true });
  assert.deepEqual(h.sel(), []);
  h.key('b', 'A', { metaKey: true });
  assert.equal(h.controller.selected.size, 4);
  assert.deepEqual(h.bubbled.keydown, []);
});

test('Shift+Arrow, Home and End extend the range after the shell moves focus', async t => {
  const h = harness(t);
  const buttons = () => [...h.groups.querySelectorAll('[data-session-open]')];
  h.groups.addEventListener('keydown', event => {
    const list = buttons(); const index = list.indexOf(event.target.closest('[data-session-open]'));
    const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key];
    if (target !== undefined) list[Math.max(0, Math.min(target, list.length - 1))].focus();
  });
  h.open('b').focus();
  const event = h.key('b', 'ArrowDown', { shiftKey: true });
  assert.equal(event.defaultPrevented, false, 'the shell handler still moves focus');
  await Promise.resolve();
  assert.deepEqual(h.sel().sort(), ['b', 'c']);
  h.key('c', 'ArrowDown', { shiftKey: true }); await Promise.resolve();
  assert.deepEqual(h.sel().sort(), ['b', 'c', 'd']);
  h.key('d', 'ArrowUp', { shiftKey: true }); await Promise.resolve();
  assert.deepEqual(h.sel().sort(), ['b', 'c'], 'moving back shrinks the range toward the anchor');
  h.key('c', 'Home', { shiftKey: true }); await Promise.resolve();
  assert.deepEqual(h.sel().sort(), ['a', 'b']);
  h.key('a', 'End', { shiftKey: true }); await Promise.resolve();
  assert.deepEqual(h.sel().sort(), ['b', 'c', 'd']);
  assert.equal(h.status().textContent, '3 chats selected');
  const before = h.sel();
  h.key('d', 'ArrowDown', { shiftKey: true, ctrlKey: true }); await Promise.resolve();
  assert.deepEqual(h.sel(), before, 'Ctrl+Shift+Arrow is not a range key');
});

test('Shift+Arrow onto a project header changes nothing', async t => {
  const h = harness(t);
  h.groups.insertAdjacentHTML('beforeend', '<li><button id="hdr" data-project-toggle="p1">Project</button></li>');
  h.groups.addEventListener('keydown', event => { if (event.key === 'ArrowDown') h.doc.getElementById('hdr').focus(); });
  h.ctrl('d');
  h.open('d').focus();
  h.key('d', 'ArrowDown', { shiftKey: true }); await Promise.resolve();
  assert.deepEqual(h.sel(), ['d']);
});

test('a view or search change clears the selection and unmounted ids drop on sidebar-rendered', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b'); h.ctrl('c');
  h.groups.querySelector('[data-session-id="c"]').remove();
  assert.equal(h.controller.selected.size, 3, 'nothing prunes until the panel renders');
  h.rendered();
  assert.deepEqual(h.sel(), ['a', 'b']);
  h.state.ui.sidebarArchivedView = true;
  h.rendered();
  assert.equal(h.controller.selected.size, 0);
  h.ctrl('a');
  const search = h.doc.getElementById('conversationSearch'); search.value = 'a'; search.dispatchEvent(new h.W.Event('input'));
  assert.equal(h.controller.selected.size, 0);
  h.ctrl('a');
  search.value = 'ab';
  h.rendered();
  assert.equal(h.controller.selected.size, 0, 'a changed search text clears even if the input event was missed');
});

test('selected rows are highlighted and labelled ", selected"; deselecting restores the original label', t => {
  const h = harness(t);
  h.ctrl('a');
  assert.equal(h.groups.querySelector('[data-session-id="a"]').classList.contains('sidebar-bulk-selected'), true);
  assert.equal(h.open('a').getAttribute('aria-label'), 'Open a, selected');
  assert.equal(h.open('b').getAttribute('aria-label'), 'Open b');
  h.ctrl('a');
  assert.equal(h.groups.querySelector('[data-session-id="a"]').classList.contains('sidebar-bulk-selected'), false);
  assert.equal(h.open('a').getAttribute('aria-label'), 'Open a');
  assert.equal(h.open('a').hasAttribute('data-bulk-original-label'), false);
  h.ctrl('b'); h.controller.clear();
  assert.equal(h.open('b').getAttribute('aria-label'), 'Open b');
});

test('a row the panel rebuilds keeps its selection: the new button is painted, an unchanged one is skipped', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  const row = h.groups.querySelector('[data-session-id="a"]');
  const old = h.open('a');
  row.innerHTML = '<button class="session-row__open" data-session-open="a" aria-label="Open Renamed">Renamed</button><button data-session-action="menu">Menu</button>';
  const fresh = h.open('a');
  assert.notEqual(fresh, old);
  h.rendered();
  assert.equal(fresh.getAttribute('aria-label'), 'Open Renamed, selected');
  assert.equal(row.classList.contains('sidebar-bulk-selected'), true);
  // An already-painted selected button is left alone on later repaints.
  h.open('b').setAttribute('aria-label', 'Changed by the panel');
  h.rendered();
  assert.equal(h.open('b').getAttribute('aria-label'), 'Changed by the panel');
  h.ctrl('a');
  assert.equal(fresh.getAttribute('aria-label'), 'Open Renamed');
});

test('with nothing selected a repaint touches no row', async t => {
  const h = harness(t);
  h.open('a').setAttribute('aria-label', 'Panel label');
  h.rendered();
  h.controller.paint();
  assert.equal(h.open('a').getAttribute('aria-label'), 'Panel label');
  assert.equal(h.groups.querySelector('.sidebar-bulk-selected'), null);
  let mutations = 0;
  const observer = new h.W.MutationObserver(records => { mutations += records.length; });
  observer.observe(h.groups, { attributes: true, subtree: true, childList: true });
  h.rendered();
  await settle();
  observer.disconnect();
  assert.equal(mutations, 0);
});

test('the hidden status line shows the count, Working… while busy, and nothing otherwise', t => {
  const h = harness(t);
  const status = h.status();
  assert.equal(status.getAttribute('role'), 'status');
  assert.ok(status.classList.contains('sr-only'));
  assert.equal(status.nextElementSibling, h.groups, 'sits just before the list');
  assert.equal(status.textContent, '');
  h.ctrl('a');
  assert.equal(status.textContent, '1 chat selected');
  h.ctrl('b');
  assert.equal(status.textContent, '2 chats selected');
  h.controller.clear();
  assert.equal(status.textContent, '');
});

test('modifier clicks are swallowed and change nothing while a bulk action is busy', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b'); h.deleteSelected();
  assert.equal(h.state.ui.sidebarBulkBusy, true);
  const event = h.ctrl('c');
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.bubbled.click, 0);
  assert.deepEqual(h.sel(), ['a', 'b']);
  h.click('d', { shiftKey: true });
  assert.deepEqual(h.sel(), ['a', 'b']);
  h.mouse('contextmenu', h.open('a'));
  assert.equal(h.doc.querySelector('.inv-context-menu'), null, 'no menu opens while busy');
  h.scheduled().onUndo();
  h.ctrl('c');
  assert.deepEqual(h.sel(), ['a', 'b', 'c']);
});

test('cleanup removes the listeners and the status line and restores the row labels', t => {
  const h = harness(t);
  h.ctrl('a');
  assert.equal(h.open('a').getAttribute('aria-label'), 'Open a, selected');
  h.cleanups.forEach(fn => fn());
  assert.equal(h.status(), null);
  assert.equal(h.open('a').getAttribute('aria-label'), 'Open a');
  assert.equal(h.groups.querySelector('.sidebar-bulk-selected'), null);
  const event = h.ctrl('b');
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.bubbled.click, 1, 'clicks pass once the controller is gone');
});
