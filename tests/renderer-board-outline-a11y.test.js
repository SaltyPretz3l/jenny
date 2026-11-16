'use strict';

// new-test-file: the outline's accessibility pass (names, tree sizes, the tree key map, announcements, styles) is a different lane from renderer-board-outline.test.js, which is near its line cap; it runs the real outline view over a stand-in editor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createBoardOutlineView } = require('../renderer/features/board/board-outline-view');
const actionButton = require('../renderer/inventory/action-button');

const card = (id, alias, kind, x, y, data, group) => ({ id, alias, kind, x, y, w: 160, h: 80, z: 0, group_id: group || null, geo_rev: 0, content_rev: 0, data });
const group = (id, alias, title, x, y) => ({ id, alias, title, x, y, w: 500, h: 200, tone: null, geo_rev: 0, content_rev: 0 });
const connector = (id, from, to, label, ends) => ({ id, from, to, label: label || '', style: 'solid', tone: null, ends: ends || 'end', content_rev: 0 });

function fixture() {
  return {
    id: 'board_1', name: 'Auth', rev: 3,
    groups: { g1: group('g1', 'g1', 'Open questions', 0, 0) },
    cards: {
      n1: card('n1', 'n1', 'note', 40, 40, { text: 'Do we keep refresh tokens?\nMobile needs them.', tone: null }, 'g1'),
      f1: card('f1', 'f1', 'file', 300, 40, { path: 'src/auth/session.ts', title: 'session.ts' }, 'g1'),
      l1: card('l1', 'l1', 'link', 40, 200, { url: 'https://example.com/docs', title: 'Docs' }),
      i1: card('i1', 'i1', 'image', 300, 200, { asset: 'a', width: 10, height: 10, alt: 'Wireframe' }),
      c1: card('c1', 'c1', 'chat', 40, 360, { session_id: 's', title: 'Auth chat', excerpt: 'x' }),
      d1: card('d1', 'd1', 'diagram', 300, 360, { scene: 'a -> b', title: 'Checkout flow' }),
    },
    connectors: { k1: connector('k1', 'n1', 'f1', 'blocks'), k2: connector('k2', 'n1', 'l1'), k3: connector('k3', 'l1', 'd1', '', 'both') },
  };
}

function standInEditor(initial, options) {
  let board = initial;
  let can = !(options && options.canEdit === false);
  let selection = [];
  let selectedConnector = '';
  const listeners = new Set();
  const calls = [];
  const emit = (kind) => Array.from(listeners).forEach((listener) => listener({ kind }));
  const rec = (name, answer) => (...args) => { calls.push([name, ...args]); return Promise.resolve(typeof answer === 'function' ? answer(...args) : (answer || { ok: true })); };
  return {
    calls,
    getBoard: () => board,
    canEdit: () => can,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSelection: () => selection.slice(),
    isSelected: (id) => selection.includes(id),
    select(ids, opts) { calls.push(['select', ids, opts]); selection = opts && opts.add ? Array.from(new Set(selection.concat(ids))) : ids.slice(); selectedConnector = ''; emit('selection'); },
    toggle(id) { calls.push(['toggle', id]); selection = selection.includes(id) ? selection.filter((x) => x !== id) : selection.concat(id); emit('selection'); },
    clearSelection() { selection = []; emit('selection'); },
    selectAll: rec('selectAll'),
    getSelectedConnector: () => selectedConnector,
    selectConnector(id) { calls.push(['selectConnector', id]); selectedConnector = id; selection = []; emit('selection'); },
    addNote: (...args) => {
      calls.push(['addNote', ...args]);
      board = Object.assign({}, board, { cards: Object.assign({}, board.cards, { nn: card('nn', 'n9', 'note', 900, 900, { text: '', tone: null }) }) });
      emit('board');
      return Promise.resolve({ ok: true, id: 'nn' });
    },
    addLink: rec('addLink', () => ({ ok: true, id: 'l1' })),
    editCard: rec('editCard'),
    editGroup: rec('editGroup'),
    removeSelected: rec('removeSelected'),
    removeConnector: rec('removeConnector'),
    connect: rec('connect'),
    assignToGroup: rec('assignToGroup'),
    groupSelected: rec('groupSelected'),
    ungroupSelected: rec('ungroupSelected'),
    undo: rec('undo'),
    redo: rec('redo'),
    setBoard(next) { board = next; emit('board'); },
  };
}

function harness(t, { board = fixture(), canEdit = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="before">before</button></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const editor = standInEditor(board, { canEdit });
  const menus = [];
  const view = createBoardOutlineView({ document: doc, actionButton, editor, model: require('../services/boards/board-model'), contextMenu: { show: (opts) => menus.push(opts), hide() {} } });
  doc.body.appendChild(view.element);
  view.show(editor.getBoard());
  t.after(() => { view.dispose(); window.close(); });
  const rows = () => Array.from(view.element.querySelectorAll('li[role="treeitem"]'));
  const row = (id) => rows().find((li) => li.getAttribute('data-outline-id') === id);
  const key = (target, k, init) => {
    const event = new window.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, init || {}));
    target.dispatchEvent(event);
    return event;
  };
  const focused = () => (doc.activeElement && doc.activeElement.getAttribute ? doc.activeElement.getAttribute('data-outline-id') : null);
  const names = (name) => editor.calls.filter((call) => call[0] === name);
  const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const live = view.element.querySelector('[data-outline-live]');
  const said = []; // every non-empty text the live region was given
  if (live) {
    const proto = Object.getOwnPropertyDescriptor(window.Node.prototype, 'textContent');
    Object.defineProperty(live, 'textContent', { get() { return proto.get.call(this); }, set(value) { if (value) said.push(value); proto.set.call(this, value); } });
  }
  return { window, doc, editor, view, menus, rows, row, key, focused, names, flush, live, said, tree: view.element.querySelector('[role="tree"]') };
}

const visible = (li) => !li.closest('[hidden]');

// What the tree should report, worked out from the DOM alone: a row's place among the visible rows of its own list.
function assertSizes(h) {
  const shown = h.rows().filter(visible);
  assert.ok(shown.length > 0);
  shown.forEach((li) => {
    const siblings = Array.from(li.parentElement.children).filter((node) => node.matches('li[role="treeitem"]') && !node.hidden);
    const id = li.getAttribute('data-outline-id');
    assert.equal(li.getAttribute('aria-setsize'), String(siblings.length), `${id}: aria-setsize`);
    assert.equal(li.getAttribute('aria-posinset'), String(siblings.indexOf(li) + 1), `${id}: aria-posinset`);
  });
  return shown.length;
}

// ---------------------------------------------------------------------------------- structure and names

test('the tree has a name, every row has its place in its list after every redraw, and groups own their rows through a group list', (t) => {
  const h = harness(t);
  assert.equal(h.tree.getAttribute('role'), 'tree');
  assert.equal(h.tree.getAttribute('aria-label'), 'Cards and groups');
  assert.equal(h.tree.getAttribute('aria-multiselectable'), 'true');
  assert.equal(assertSizes(h), 10);
  assert.equal(h.row('g1').getAttribute('aria-setsize'), '5');
  assert.equal(h.row('f1').getAttribute('aria-posinset'), '2');
  h.rows().forEach((li) => {
    const list = li.lastElementChild && li.lastElementChild.tagName === 'UL' ? li.lastElementChild : null;
    if (list) assert.equal(list.getAttribute('role'), 'group', `${li.getAttribute('data-outline-id')}: its children sit in a group list`);
  });
  assert.equal(h.row('g1').getAttribute('aria-expanded'), 'true');

  const moved = fixture(); // a card moves into the group
  moved.cards.l1.group_id = 'g1';
  h.editor.setBoard(moved);
  assert.equal(assertSizes(h), 10);
  assert.equal(h.row('g1').getAttribute('aria-setsize'), '4', 'one list fewer at the top');
  assert.equal(h.row('l1').getAttribute('aria-setsize'), '3');

  const added = fixture(); // a card is added
  added.cards.z1 = card('z1', 'n8', 'note', 700, 700, { text: 'New', tone: null });
  h.editor.setBoard(added);
  assert.equal(h.row('z1').getAttribute('aria-setsize'), '6');
  assert.equal(h.row('z1').getAttribute('aria-posinset'), '6');
  assertSizes(h);

  const removed = fixture(); // and one is removed, with the connections that led to it
  delete removed.cards.l1;
  delete removed.connectors.k2;
  delete removed.connectors.k3;
  h.editor.setBoard(removed);
  assert.equal(assertSizes(h), 7);
  assert.equal(h.row('g1').getAttribute('aria-setsize'), '4');

  h.editor.setBoard(fixture());
  h.key(h.row('g1'), 'ArrowLeft'); // a closed group is still one row of five
  assert.equal(h.row('g1').getAttribute('aria-expanded'), 'false');
  assertSizes(h);
  h.key(h.row('g1'), 'ArrowRight');

  h.view.setMatches(['f1', 'd1']); // a filter counts only what shows
  assert.equal(h.row('d1').getAttribute('aria-setsize'), '2');
  assert.equal(h.row('d1').getAttribute('aria-posinset'), '2');
  assert.equal(h.row('f1').getAttribute('aria-setsize'), '1');
  assertSizes(h);
  h.view.setMatches(null);
  assert.equal(h.row('d1').getAttribute('aria-setsize'), '5');
});

test('a row\'s name is its kind, its text and its alias, and its connections are read with it', (t) => {
  const board = fixture();
  board.cards.i2 = card('i2', 'n5', 'image', 600, 200, { asset: 'b', width: 1, height: 1, alt: '' });
  board.cards.e1 = card('e1', 'n6', 'note', 600, 300, { text: '', tone: null });
  board.groups.g2 = group('g2', 'g2', 'Later', 0, 700);
  board.cards.m1 = card('m1', 'n7', 'note', 0, 720, { text: 'Ship it', tone: null }, 'g2');
  const h = harness(t, { board });
  const name = (id) => h.row(id).getAttribute('aria-label');
  assert.equal(name('n1'), 'Note: Do we keep refresh tokens?, n1');
  assert.equal(name('f1'), 'File: session.ts, src/auth/session.ts, f1');
  assert.equal(name('l1'), 'Link: Docs, example.com, l1');
  assert.equal(name('i1'), 'Image: Wireframe, i1');
  assert.equal(name('i2'), 'Image: no description, n5');
  assert.equal(name('c1'), 'Chat: Auth chat, c1');
  assert.equal(name('d1'), 'Diagram: Checkout flow, d1');
  assert.equal(name('e1'), 'Note, n6', 'an empty note is not read twice');
  assert.equal(name('g1'), 'Group: Open questions, 2 cards, g1');
  assert.equal(name('g2'), 'Group: Later, 1 card, g2');
  assert.equal(name('k1'), 'Connects to f1 session.ts, src/auth/session.ts: blocks');
  assert.equal(name('k3'), 'Connects to d1 Checkout flow');
  h.rows().forEach((li) => assert.equal(li.hasAttribute('aria-labelledby'), false, 'the name is whole, not assembled from parts that hold controls'));
  const described = (id) => (h.row(id).getAttribute('aria-describedby') ? h.doc.getElementById(h.row(id).getAttribute('aria-describedby')).textContent : null);
  assert.equal(described('n1'), 'Connects to f1 session.ts, src/auth/session.ts: blocks; Connects to l1 Docs, example.com');
  assert.equal(described('l1'), 'Connects to d1 Checkout flow');
  assert.equal(described('c1'), null, 'a card with no connection has nothing to add');
  assert.equal(h.row('n1').querySelector('.board-outline__row').contains(h.doc.getElementById(h.row('n1').getAttribute('aria-describedby'))), true);
});

test('a name carries at most 300 characters, the 4,000-character note keeps its text on screen', (t) => {
  const board = fixture();
  board.cards.n1.data.text = 'x'.repeat(4000);
  board.connectors.k1.label = 'y'.repeat(900);
  board.cards.f1.data.title = 'z'.repeat(900);
  const h = harness(t, { board });
  ['n1', 'k1', 'f1', 'g1'].forEach((id) => assert.ok(h.row(id).getAttribute('aria-label').length <= 300, `${id}: ${h.row(id).getAttribute('aria-label').length}`));
  assert.match(h.row('n1').getAttribute('aria-label'), /^Note: x+…, n1$/);
  assert.ok(h.row('n1').getAttribute('aria-label').length > 200, 'it is cut, not dropped');
  assert.equal(h.row('n1').querySelector('.board-outline__text').textContent.length, 4000, 'the cut on screen is the stylesheet\'s');
});

test('nothing focusable sits in a row\'s name and every row control is out of the tab order', (t) => {
  const h = harness(t);
  h.rows().forEach((li) => {
    assert.equal(li.querySelectorAll('.board-outline__label button, .board-outline__label [tabindex]').length, 0);
    li.querySelectorAll('[data-outline-act]').forEach((button) => assert.equal(button.tabIndex, -1));
  });
  const stops = Array.from(h.view.element.querySelectorAll('[role="tree"] [tabindex="0"]'));
  assert.equal(stops.length, 1);
  assert.equal(h.tree.getAttribute('tabindex'), '-1', 'the tree itself can take focus when it has no row');
});

// ---------------------------------------------------------------------------------- keyboard

test('typing letters moves to the next row whose text starts with them, `*` opens the groups of a level', (t) => {
  const h = harness(t);
  const realNow = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  t.after(() => { Date.now = realNow; });
  h.view.focusFirst();
  const typed = h.key(h.row('g1'), 'w');
  assert.equal(typed.defaultPrevented, true);
  assert.equal(h.focused(), 'i1', 'W: Wireframe');
  h.key(h.row('i1'), 'a');
  assert.equal(h.focused(), 'i1', '"wa" matches nothing: focus stays');
  clock += 1000; // the buffer is forgotten
  h.key(h.row('i1'), 'A');
  assert.equal(h.focused(), 'c1', 'A: Auth chat, any case');
  h.key(h.row('c1'), 'c');
  assert.equal(h.focused(), 'c1', '"ac" matches nothing');
  clock += 1000;
  h.key(h.row('c1'), 'c');
  assert.equal(h.focused(), 'd1', 'C: Checkout flow');
  assert.equal(h.key(h.row('d1'), 'q').defaultPrevented, false);

  const two = fixture();
  two.groups.g2 = group('g2', 'g2', 'Decisions', 0, 500);
  two.cards.m1 = card('m1', 'n7', 'note', 40, 520, { text: 'Ship', tone: null }, 'g2');
  h.editor.setBoard(two);
  h.key(h.row('g1'), 'ArrowLeft');
  h.key(h.row('g2'), 'ArrowLeft');
  assert.deepEqual(['g1', 'g2'].map((id) => h.row(id).getAttribute('aria-expanded')), ['false', 'false']);
  const star = h.key(h.row('g1'), '*', { shiftKey: true });
  assert.equal(star.defaultPrevented, true);
  assert.deepEqual(['g1', 'g2'].map((id) => h.row(id).getAttribute('aria-expanded')), ['true', 'true'], '* opens every group at that level');
  assert.equal(visible(h.row('m1')), true);
});

test('F2 edits like Enter but only what has an edit; Escape gives focus back to the row, never the page', (t) => {
  const h = harness(t);
  h.row('n1').focus();
  assert.equal(h.key(h.row('n1'), 'F2').defaultPrevented, true);
  const field = h.row('n1').querySelector('textarea');
  assert.ok(field, 'F2 opens the note for editing');
  assert.equal(h.doc.activeElement, field);
  h.key(field, 'Escape');
  assert.equal(h.row('n1').querySelector('textarea'), null);
  assert.equal(h.doc.activeElement, h.row('n1'), 'focus is on the row');
  assert.notEqual(h.doc.activeElement, h.doc.body);
  h.row('g1').focus();
  h.key(h.row('g1'), 'F2');
  h.key(h.row('g1').querySelector('input'), 'Escape');
  assert.equal(h.doc.activeElement, h.row('g1'));
  assert.equal(h.key(h.row('f1'), 'F2').defaultPrevented, false, 'a file card has no edit in the outline');
  assert.equal(h.key(h.row('k1'), 'F2').defaultPrevented, false);
});

test('Right on an open group goes to its first row that shows', (t) => {
  const h = harness(t);
  h.view.setMatches(['f1']);
  h.row('g1').focus();
  h.key(h.row('g1'), 'ArrowRight');
  assert.equal(h.focused(), 'f1', 'n1 is filtered out, so the first child that shows');
});

test('Space toggles a row in the selection, Shift with the arrows extends it, Ctrl+A takes the rows that show', (t) => {
  const h = harness(t);
  h.key(h.row('n1'), ' ');
  assert.equal(h.row('n1').getAttribute('aria-selected'), 'true');
  h.key(h.row('n1'), ' ');
  assert.equal(h.row('n1').getAttribute('aria-selected'), 'false', 'a second Space takes it out');
  assert.deepEqual(h.names('toggle'), [['toggle', 'n1'], ['toggle', 'n1']]);
  h.key(h.row('k1'), ' ');
  assert.equal(h.row('k1').getAttribute('aria-selected'), 'true');
  h.key(h.row('k1'), ' ');
  assert.equal(h.row('k1').getAttribute('aria-selected'), 'false');
  assert.deepEqual(h.names('selectConnector'), [['selectConnector', 'k1'], ['selectConnector', '']]);

  h.editor.calls.length = 0;
  h.row('f1').focus();
  assert.equal(h.key(h.row('f1'), 'ArrowDown', { shiftKey: true }).defaultPrevented, true);
  assert.equal(h.focused(), 'l1');
  h.key(h.row('l1'), 'ArrowDown', { shiftKey: true }); // onto a connection: moves, selects nothing more
  assert.equal(h.focused(), 'k3');
  h.key(h.row('k3'), 'ArrowUp', { shiftKey: true });
  assert.equal(h.focused(), 'l1');
  assert.deepEqual(h.row('f1').getAttribute('aria-selected') + h.row('l1').getAttribute('aria-selected'), 'truetrue');
  assert.deepEqual(h.names('select')[0], ['select', ['f1', 'l1'], { add: true }]);

  h.editor.calls.length = 0;
  h.key(h.row('l1'), 'a', { ctrlKey: true });
  assert.deepEqual(h.names('select')[0].slice(1, 2), [['g1', 'n1', 'f1', 'l1', 'i1', 'c1', 'd1']], 'every visible row, not the connections');
  assert.equal(h.row('d1').getAttribute('aria-selected'), 'true');
  assert.equal(h.row('k1').getAttribute('aria-selected'), 'false');
  h.view.setMatches(['f1', 'd1']);
  h.editor.calls.length = 0;
  h.key(h.row('f1'), 'a', { ctrlKey: true });
  assert.deepEqual(h.names('select')[0].slice(1, 2), [['g1', 'f1', 'd1']], 'rows a filter hides are not taken');
  h.view.setMatches(null);
  h.key(h.row('g1'), 'ArrowLeft');
  h.editor.calls.length = 0;
  h.key(h.row('g1'), 'a', { ctrlKey: true });
  assert.deepEqual(h.names('select')[0].slice(1, 2), [['g1', 'l1', 'i1', 'c1', 'd1']], 'cards in a closed group are not taken');
});

test('focus is never lost: after a removal it goes to the next row, else the previous, else the tree; an outside change keeps the same row', (t) => {
  const h = harness(t);
  h.row('l1').focus();
  const without = fixture();
  delete without.cards.l1;
  delete without.connectors.k2; // the connections that led to it go too, and they sat above it
  delete without.connectors.k3;
  h.editor.setBoard(without);
  assert.equal(h.focused(), 'i1', 'the row after the one removed');

  h.row('d1').focus();
  const noLast = Object.assign(fixture(), { cards: Object.assign({}, without.cards) });
  delete noLast.cards.d1;
  h.editor.setBoard(noLast);
  assert.equal(h.focused(), 'c1', 'no row after: the one before');

  const above = Object.assign({}, noLast, { cards: Object.assign({ z0: card('z0', 'n8', 'note', 0, -50, { text: 'Top', tone: null }) }, noLast.cards) });
  h.editor.setBoard(above);
  assert.equal(h.focused(), 'c1', 'a change elsewhere does not move focus');
  assert.equal(h.tree.querySelectorAll('[tabindex="0"]').length, 1);

  h.editor.setBoard({ id: 'board_1', name: 'Auth', rev: 9, groups: {}, cards: {}, connectors: {} });
  assert.equal(h.doc.activeElement, h.tree, 'nothing left: the tree');
  assert.notEqual(h.doc.activeElement, h.doc.body);
});

test('Tab is left alone: the tree is one stop and holds nothing in', (t) => {
  const h = harness(t);
  h.view.focusFirst();
  const tab = h.key(h.row('g1'), 'Tab');
  assert.equal(tab.defaultPrevented, false);
  assert.equal(h.key(h.row('g1'), 'Tab', { shiftKey: true }).defaultPrevented, false);
  const tabbable = Array.from(h.doc.querySelectorAll('button, [tabindex], input, textarea')).filter((node) => node.tabIndex >= 0 && !node.disabled);
  const inTree = tabbable.filter((node) => h.tree.contains(node));
  assert.equal(inTree.length, 1, 'one tab stop in the tree');
  assert.ok(tabbable.indexOf(inTree[0]) > tabbable.findIndex((node) => node.id === 'before'), 'the next stop in DOM order is reached from the tree by Tab');
});

test('the menu key and Shift+F10 open the row\'s menu at the row', (t) => {
  const h = harness(t);
  h.key(h.row('l1'), 'ContextMenu');
  h.key(h.row('l1'), 'F10', { shiftKey: true });
  assert.equal(h.menus.length, 2);
  h.menus.forEach((menu) => { assert.equal(menu.anchorEl, h.row('l1')); assert.equal(menu.restoreFocusTo, h.row('l1')); });
});

// ---------------------------------------------------------------------------------- announcements

test('the outline owns one polite live region, outside the tree', (t) => {
  const h = harness(t);
  assert.ok(h.live, 'there is a live region');
  assert.equal(h.live.getAttribute('aria-live'), 'polite');
  assert.equal(h.live.getAttribute('role'), 'status');
  assert.equal(h.tree.contains(h.live), false);
  assert.equal(h.view.element.contains(h.live), true);
  assert.equal(h.view.element.querySelectorAll('[aria-live]').length, 1, 'the outline\'s one announcer');
  h.view.dispose();
  assert.equal(h.live.isConnected, false);
});

test('adding, removing, moving, connecting and renaming through the outline are announced once, in a sentence', async (t) => {
  const h = harness(t);
  h.view.element.querySelector('[data-outline-add="note"]').click();
  await h.flush();
  assert.deepEqual(h.said, ['Note n9 added.']);
  h.key(h.row('nn').querySelector('textarea'), 'Escape');
  await h.flush();
  assert.deepEqual(h.said, ['Note n9 added.', 'n9 removed. Undo is available.'], 'Escape cancels the new note, and a listener hears that it is gone');

  h.said.length = 0;
  h.editor.select(['n1']);
  h.key(h.row('n1'), 'Delete');
  await h.flush();
  assert.deepEqual(h.said, ['n1 removed. Undo is available.']);

  h.said.length = 0;
  h.editor.select(['n1', 'f1']);
  h.key(h.row('n1'), 'Delete');
  await h.flush();
  assert.deepEqual(h.said, ['2 items removed. Undo is available.']);

  h.said.length = 0;
  h.editor.select(['l1']);
  h.key(h.row('k1'), 'Delete');
  await h.flush();
  assert.deepEqual(h.said, ['Connection removed. Undo is available.']);

  h.said.length = 0;
  h.row('l1').querySelector('[data-outline-act="more"]').click();
  const menu = h.menus.pop();
  menu.items[2].items[1].action(); // Move to group > g1
  menu.items[2].items[0].action(); // Move to group > No group
  menu.items[1].items.find((item) => item.label.startsWith('d1')).action(); // Connect to d1
  await h.flush();
  assert.deepEqual(h.said, ['l1 moved to Open questions.', 'l1 taken out of its group.', 'l1 connected to d1.']);

  h.said.length = 0;
  h.key(h.row('g1'), 'Enter');
  const field = h.row('g1').querySelector('input');
  field.value = 'Questions';
  h.key(field, 'Enter');
  await h.flush();
  assert.deepEqual(h.said, ['g1 renamed to Questions.']);

  h.said.length = 0;
  h.key(h.row('n1'), 'Enter');
  h.row('n1').querySelector('textarea').value = 'Keep them';
  h.key(h.row('n1').querySelector('textarea'), 'Enter', { ctrlKey: true });
  h.row('g1').querySelector('[data-outline-act="ungroup"]').click();
  h.key(h.row('n1'), 'z', { ctrlKey: true });
  h.key(h.row('n1'), 'y', { ctrlKey: true });
  h.key(h.row('n1'), 'g', { ctrlKey: true });
  await h.flush();
  assert.deepEqual(h.said, ['n1 updated.', 'g1 ungrouped.', 'Change undone.', 'Change redone.', 'Items grouped.']);
});

test('a refused change says nothing, and a selection change is left to the tree', async (t) => {
  const h = harness(t);
  h.editor.removeSelected = () => Promise.resolve({ ok: false, reason: 'limit' });
  h.editor.select(['n1']);
  h.key(h.row('n1'), 'Delete');
  h.editor.toggle('f1');
  h.editor.selectConnector('k1');
  h.key(h.row('n1'), ' ');
  h.key(h.row('l1'), 'a', { ctrlKey: true });
  await h.flush();
  assert.deepEqual(h.said, []);
  assert.equal(h.live.textContent, '');
});

test('an empty board says so in text, in the outline\'s own words, and the tree points at it', (t) => {
  const h = harness(t, { board: { id: 'board_2', name: 'Empty', rev: 0, groups: {}, cards: {}, connectors: {} } });
  const hint = h.view.element.querySelector('[data-outline-empty]');
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /^This board is empty\./);
  assert.doesNotMatch(hint.textContent, /double-click/i, 'the outline needs no pointer');
  assert.equal(h.view.element.contains(hint), true);
  assert.equal(h.tree.getAttribute('aria-describedby'), hint.id);
  assert.ok(h.doc.getElementById(hint.id));
  h.editor.setBoard(fixture());
  assert.equal(h.tree.hasAttribute('aria-describedby'), false);
});

test('the group around the bar names what it holds (the view switch sits in it too), and an added card without an alias is not read as "undefined"', async (t) => {
  const h = harness(t);
  const bar = h.view.element.querySelector('.board-outline__bar');
  assert.equal(bar.getAttribute('aria-label'), 'Board controls');
  h.editor.addNote = () => {
    h.editor.setBoard(Object.assign({}, h.editor.getBoard(), { cards: Object.assign({}, h.editor.getBoard().cards, { nn: card('nn', undefined, 'note', 900, 900, { text: '', tone: null }) }) }));
    return Promise.resolve({ ok: true, id: 'nn' });
  };
  h.view.element.querySelector('[data-outline-add="note"]').click();
  await h.flush();
  assert.deepEqual(h.said, ['Note added.']);
});

// ---------------------------------------------------------------------------------- the module

test('the a11y helper is loadable on its own and cuts long text to one line', () => {
  const a11y = require('../renderer/features/board/board-outline-a11y');
  assert.equal(typeof a11y.createBoardOutlineA11y, 'function');
  assert.equal(a11y.clip('  a   b\nc ', 10), 'a b c');
  assert.equal(a11y.clip('x'.repeat(50), 10).length, 10);
  assert.ok(a11y.clip('x'.repeat(50), 10).endsWith('…'));
});

// ---------------------------------------------------------------------------------- the stylesheet

function sheet() {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'board-outline.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const media = {};
  const plain = css.replace(/@media\s*([^{]+)\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g, (_all, cond, body) => { media[cond.trim()] = body; return ''; });
  return { css, plain, media };
}

test('the stylesheet uses tokens and system colours, shows focus and selection, and honours reduced motion and forced colours', () => {
  const { css, plain, media } = sheet();
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'no hex colour');
  assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch)\(/, 'no colour function of literals');
  assert.doesNotMatch(plain, /\b(?:Highlight|HighlightText|CanvasText|Canvas|LinkText|ButtonText)\b/, 'system colours only where forced colours apply');
  assert.doesNotMatch(css, /\b\d*\.?\d+m?s\b(?!\w)/, 'no duration');
  assert.match(plain, /\.board-outline__item:focus-visible > \.board-outline__row\s*\{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring-color\)/, 'focus uses the app token');
  assert.match(plain, /\.board-outline__item\s*\{\s*outline:\s*none;\s*\}/, 'the row itself draws no ring, its line does');
  assert.match(plain, /\[aria-selected="true"\] > \.board-outline__row\s*\{[^}]*background:[^}]*box-shadow:/, 'a selected row is filled and hairlined, a focused one is ringed');

  const motion = media['(prefers-reduced-motion: reduce)'];
  assert.ok(motion, 'a reduced-motion block');
  assert.match(motion, /transition:\s*none/);
  const forced = media['(forced-colors: active)'];
  assert.ok(forced, 'a forced-colours block');
  assert.match(forced, /\[aria-selected="true"\][^{]*\{[^}]*(?:background|outline)[^}]*Highlight/, 'selection in system colours');
  assert.match(forced, /:focus-visible[^{]*\{[^}]*outline[^}]*CanvasText/, 'the ring in a system colour');
  assert.match(forced, /HighlightText/, 'text on the selection is readable');
});

test('the controls on a row are at least 24 by 24 CSS pixels', () => {
  const { plain } = sheet();
  const more = /\.board-outline__act--more\s*\{([^}]*)\}/.exec(plain)[1];
  assert.ok(Number(/width:\s*(\d+)px/.exec(more)[1]) >= 24);
  assert.ok(Number(/height:\s*(\d+)px/.exec(more)[1]) >= 24);
  const small = /\.btn--sm\s*\{[^}]*--btn-min-height:\s*(\d+)px/.exec(fs.readFileSync(path.join(__dirname, '..', 'styles', 'components', 'buttons.css'), 'utf8'));
  assert.ok(Number(small[1]) >= 24, 'the Rename, Ungroup and Remove buttons');
  const mark = Number(/\.board-outline__caret\s*\{[^}]*width:\s*(\d+)px/.exec(plain)[1]);
  const reach = Number(/\.board-outline__caret::before\s*\{[^}]*inset:\s*-(\d+)px/.exec(plain)[1]);
  assert.ok(mark + 2 * reach >= 24, 'the open/close mark has a 24 pixel target');
});
