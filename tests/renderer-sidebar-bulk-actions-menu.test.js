// Chats sidebar selection: the bulk menu, Move, Archive/Restore and the Delete confirm with Undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const contextMenu = require('../renderer/inventory/context-menu');
const { harness, settle } = require('./helpers/sidebar-bulk-harness');

test('right-click on a selected row with two or more selected opens the bulk menu and stops the event', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  const event = h.mouse('contextmenu', h.open('a'), { clientX: 40, clientY: 50 });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.bubbled.contextmenu, 0, 'the single-chat menu does not open');
  assert.equal(h.heading(), '2 chats selected');
  assert.deepEqual(h.labels(), ['Move 2 chats to project…', 'Archive 2 chats', 'Delete 2 chats…', 'Clear selection']);
  assert.equal(h.doc.querySelectorAll('.inv-context-menu-separator').length, 2);
  assert.ok(h.doc.querySelector('.inv-context-menu-item--danger'));
  assert.deepEqual(h.sel(), ['a', 'b'], 'the selection is intact while the menu is open');
});

test('right-click outside the selection clears it and lets the single-chat menu open; a lone selected row keeps its selection', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  const event = h.mouse('contextmenu', h.open('c'));
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.bubbled.contextmenu, 1);
  assert.equal(h.controller.selected.size, 0);
  assert.equal(h.doc.querySelector('.inv-context-menu'), null);
  h.ctrl('a');
  h.mouse('contextmenu', h.open('a'));
  assert.equal(h.bubbled.contextmenu, 2, 'one selected row is a single-chat menu');
  assert.deepEqual(h.sel(), ['a']);
  assert.equal(h.doc.querySelector('.inv-context-menu'), null);
});

test('the ⋯ button follows the same rule and anchors the move menu on itself', async t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  const event = h.mouse('click', h.menuButton('b'));
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.bubbled.click, 0, 'the row menu handler never sees the click');
  assert.equal(h.heading(), '2 chats selected');
  h.pick('Move 2 chats to project…');
  await settle();
  assert.equal(h.switcher.opened[0].anchor, h.menuButton('b'));
  const outside = h.mouse('click', h.menuButton('c'));
  assert.equal(outside.defaultPrevented, false);
  assert.equal(h.bubbled.click, 1);
  assert.equal(h.controller.selected.size, 0);
});

test('the menu key and Shift+F10 on a selected row open the bulk menu and restore focus to the row button', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  const event = h.key('b', 'ContextMenu');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.bubbled.keydown, [], 'the shell handler is not reached');
  assert.equal(h.heading(), '2 chats selected');
  h.pick('Clear selection');
  assert.equal(h.controller.selected.size, 0);
  assert.equal(h.doc.activeElement, h.open('b'));
  h.ctrl('a'); h.ctrl('c');
  h.key('c', 'F10', { shiftKey: true });
  assert.equal(h.heading(), '2 chats selected');
  contextMenu.hide();
  h.click('d');
  h.key('d', 'ContextMenu');
  assert.equal(h.doc.querySelector('.inv-context-menu'), null, 'outside the selection the shell opens the single menu');
  assert.deepEqual(h.bubbled.keydown, ['ContextMenu']);
});

test('"Move N chats to project…" hands the selected ids to the project switcher and drops moved ids; absent without a switcher', async t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b'); h.ctrl('c');
  h.mouse('contextmenu', h.open('a'));
  h.pick('Move 3 chats to project…');
  await settle();
  assert.deepEqual(h.switcher.opened[0].ids, ['a', 'b', 'c']);
  assert.equal(h.switcher.opened[0].anchor, h.open('a'), 'a right-click anchors the move menu on the row button');
  assert.equal(h.switcher.opened[0].options.source, 'bulk');
  h.switcher.opened[0].options.onMoved({ moved: ['a', 'c'], skipped: ['b'], failed: [], unchanged: [] });
  assert.deepEqual(h.sel(), ['b'], 'a skipped chat stays selected');
  const bare = harness(t, { wired: false });
  bare.ctrl('a'); bare.ctrl('b');
  bare.mouse('contextmenu', bare.open('a'));
  assert.deepEqual(bare.labels(), ['Archive 2 chats', 'Delete 2 chats…', 'Clear selection']);
});

test('a disconnected trigger falls back to the first selected row\'s ⋯ button for the move menu', async t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  h.mouse('contextmenu', h.open('b'));
  const detached = h.doc.createElement('button');
  h.open('b').replaceWith(detached);
  h.pick('Move 2 chats to project…');
  await settle();
  assert.equal(h.switcher.opened[0].anchor, h.menuButton('a'));
});

test('"Archive N chats" archives in explicit state, preserves pin and changes only the selected ids', async t => {
  const h = harness(t);
  h.state.sessions[0].pinned = true;
  h.ctrl('a'); h.ctrl('b');
  h.mouse('contextmenu', h.open('a'));
  h.pick('Archive 2 chats');
  assert.equal(h.status().textContent, 'Working…');
  assert.equal(h.state.ui.sidebarBulkBusy, true);
  await settle();
  assert.deepEqual(h.calls.map(call => call.slice(0, 2)), [['meta', 'a'], ['meta', 'b']]);
  assert.equal(h.state.sessions[0].pinned, true); assert.ok(h.state.sessions[0].archived_at);
  assert.equal(h.state.sessions[2].archived_at, undefined);
  assert.equal(h.controller.selected.size, 0);
  assert.equal(h.state.ui.sidebarBulkBusy, false);
  assert.match(h.toasts[0], /2 archived; 0 skipped; 0 failed/);
});

test('in the Archived view the same item reads "Restore N chats" and restores', async t => {
  const h = harness(t, { archived: true });
  h.ctrl('a'); h.ctrl('b');
  h.mouse('contextmenu', h.open('b'));
  assert.deepEqual(h.labels(), ['Move 2 chats to project…', 'Restore 2 chats', 'Delete 2 chats…', 'Clear selection']);
  h.pick('Restore 2 chats');
  await settle();
  assert.deepEqual(h.calls.map(call => call[2]), [{ archived_at: null }, { archived_at: null }]);
  assert.equal(h.state.sessions[0].archived_at, null);
  assert.match(h.toasts[0], /2 restored; 0 skipped; 0 failed/);
});

test('mismatched archive acknowledgement leaves the rows selected and unchanged', async t => {
  const h = harness(t); h.W.jennyShell.sessions.setMeta = async () => ({ id: 'wrong' });
  h.ctrl('a'); h.ctrl('b');
  h.mouse('contextmenu', h.open('a')); h.pick('Archive 2 chats');
  await settle();
  assert.equal(h.controller.selected.size, 2); assert.equal(h.state.sessions[0].archived_at, undefined);
  assert.match(h.toasts[0], /2 failed/);
});

test('"Delete N chats…" asks first: the confirm names the count; Delete schedules the batch, Cancel schedules nothing', t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b');
  h.mouse('contextmenu', h.open('a'));
  h.pick('Delete 2 chats…');
  assert.equal(h.heading(), 'Delete 2 chats? Busy chats will be skipped.');
  assert.deepEqual(h.labels(), ['Cancel', 'Delete 2 chats'], 'Cancel comes first, so Enter on the focused first item is safe');
  assert.ok(h.doc.querySelector('.inv-context-menu-item--danger'));
  assert.equal(h.scheduled(), undefined, 'nothing is scheduled by opening the confirm');
  h.pick('Cancel');
  assert.equal(h.scheduled(), undefined);
  assert.equal(h.doc.querySelector('.inv-context-menu'), null);
  assert.equal(h.doc.activeElement, h.open('a'), 'focus returns to the trigger');
  assert.deepEqual(h.sel(), ['a', 'b']);
  h.mouse('contextmenu', h.open('a')); h.pick('Delete 2 chats…'); h.pick('Delete 2 chats');
  assert.deepEqual(h.state.ui.pendingSessionDeletes, ['a', 'b']);
  assert.equal(h.status().textContent, 'Working…');
});

test('delete skips queued work and Undo does not delete', t => {
  const h = harness(t); h.state.sendOutboxBySession.set('b', [{}]);
  h.ctrl('a'); h.ctrl('b');
  h.deleteSelected();
  assert.deepEqual(h.state.ui.pendingSessionDeletes, ['a']);
  h.scheduled().onUndo();
  assert.deepEqual(h.state.ui.pendingSessionDeletes, []); assert.equal(h.calls.length, 0);
  assert.equal(h.state.ui.sidebarBulkBusy, false);
  assert.deepEqual(h.sel(), ['a', 'b'], 'Undo keeps the selection');
});

test('activity during Undo prevents deletion; eligible ids receive the safe backend policy', async t => {
  const h = harness(t);
  h.ctrl('a'); h.ctrl('b'); h.deleteSelected();
  h.state.sessions[0].updated_at = 'new';
  await h.scheduled().commit();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0], ['delete', 'b', { onlyIfIdle: true, expectedUpdatedAt: 'old' }]);
  assert.match(h.toasts[0], /1 deleted; 1 skipped; 0 failed/);
  assert.deepEqual(h.state.ui.pendingSessionDeletes, []);
});

test('partial delete failures restore pending state and retain the failed selection', async t => {
  const h = harness(t, { overrides: { hardDeleteSession: async id => { if (id === 'a') throw new Error('disk failure'); return { deleted: false }; } } });
  h.ctrl('a'); h.ctrl('b'); h.deleteSelected();
  await h.scheduled().commit();
  assert.equal(h.state.ui.sidebarBulkBusy, false); assert.deepEqual(h.state.ui.pendingSessionDeletes, []);
  assert.equal(h.controller.selected.size, 2); assert.match(h.toasts[0], /0 deleted; 1 skipped; 1 failed/);
});

test('a scheduler that throws reports Bulk Delete Failed and releases the batch', t => {
  const h = harness(t, { scheduler: { schedule: () => { throw new Error('boom'); } } });
  h.ctrl('a'); h.ctrl('b'); h.deleteSelected();
  assert.deepEqual(h.toasts, ['Bulk Delete Failed: boom']);
  assert.equal(h.state.ui.sidebarBulkBusy, false);
  assert.deepEqual(h.state.ui.pendingSessionDeletes || [], []);
  assert.equal(h.status().textContent, '2 chats selected');
});

test('the Delete key opens the confirm only when something is selected and no modifier is held', t => {
  const h = harness(t);
  const empty = h.key('a', 'Delete');
  assert.equal(h.doc.querySelector('.inv-context-menu'), null);
  assert.equal(empty.defaultPrevented, false);
  h.ctrl('a'); h.ctrl('c');
  h.key('a', 'Delete', { shiftKey: true });
  assert.equal(h.doc.querySelector('.inv-context-menu'), null);
  const event = h.key('a', 'Delete');
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.heading(), 'Delete 2 chats? Busy chats will be skipped.');
  h.pick('Delete 2 chats');
  assert.deepEqual(h.state.ui.pendingSessionDeletes, ['a', 'c']);
  h.scheduled().onUndo();
  h.controller.clear();
  h.ctrl('b');
  h.key('b', 'Delete');
  assert.equal(h.heading(), 'Delete 1 chat? Busy chats will be skipped.', 'singular for one selected chat');
});

test('the Delete key on a row outside the selection does nothing', t => {
  const h = harness(t);
  h.ctrl('b'); h.ctrl('c');
  const event = h.key('d', 'Delete');
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.doc.querySelector('.inv-context-menu'), null);
});
