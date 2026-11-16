'use strict';

// new-test-file: a new surface (the Board's outline view); it runs against a stand-in editor with exactly the surface of the shared board-editor contract (section 1), not against the page.

const test = require('node:test');
const assert = require('node:assert/strict');
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
  const editor = {
    calls,
    getBoard: () => board,
    canEdit: () => can,
    canUndo: () => true,
    canRedo: () => true,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listenerCount: () => listeners.size,
    getSelection: () => selection.slice(),
    isSelected: (id) => selection.includes(id),
    select(ids, opts) { calls.push(['select', ids, opts]); selection = opts && opts.add ? selection.concat(ids) : ids.slice(); selectedConnector = ''; emit('selection'); },
    toggle(id) { calls.push(['toggle', id]); selection = selection.includes(id) ? selection.filter((x) => x !== id) : selection.concat(id); emit('selection'); },
    clearSelection() { calls.push(['clearSelection']); selection = []; emit('selection'); },
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
    setCanEdit(value) { can = value; emit('board'); },
    emit,
  };
  return editor;
}

function harness(t, { board = fixture(), canEdit = true } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
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
  const act = (id, name) => row(id).querySelector(`[data-outline-act="${name}"]`);
  const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return { window, doc, editor, view, menus, rows, row, key, focused, names, act, flush, tree: view.element.querySelector('[role="tree"]') };
}

test('the outline nests groups, their cards, the cards in no group and each card\'s connections, in reading order', (t) => {
  const h = harness(t);
  assert.deepEqual(h.rows().map((li) => li.getAttribute('data-outline-id')), ['g1', 'n1', 'k1', 'k2', 'f1', 'l1', 'k3', 'i1', 'c1', 'd1']);
  assert.deepEqual(h.rows().map((li) => li.getAttribute('aria-level')), ['1', '2', '3', '3', '2', '1', '2', '1', '1', '1']);
  const text = (id) => h.row(id).querySelector('.board-outline__label').textContent.replace(/\s+/g, ' ').trim();
  assert.match(text('g1'), /^Group Open questions g1$/);
  assert.match(text('n1'), /Note Do we keep refresh tokens\? n1/);
  assert.doesNotMatch(text('n1'), /Mobile needs them/, 'a note shows its first line only');
  assert.match(text('f1'), /File session\.ts · src\/auth\/session\.ts f1/);
  assert.match(text('l1'), /Link Docs · example\.com l1/);
  assert.match(text('i1'), /Image Wireframe i1/);
  assert.match(text('c1'), /Chat Auth chat c1/);
  assert.match(text('d1'), /Diagram Checkout flow d1/);
  assert.match(text('k1'), /Connects to.*blocks · session\.ts · src\/auth\/session\.ts f1/);
  assert.match(text('k3'), /Connects to Checkout flow d1$/);
  assert.equal(h.row('k3').querySelector('.board-outline__arrow').textContent, '↔', 'a connection with both ends points both ways');
  assert.equal(h.row('k2').querySelector('.board-outline__arrow').textContent, '→');
  assert.ok(h.row('g1').querySelector('.board-outline__glyph svg'), 'a group row has the card primitive\'s glyph');
  assert.ok(h.row('n1').querySelector('.board-outline__glyph svg'));
  assert.equal(h.view.element.hasAttribute('data-outline-empty'), false);
  assert.equal(h.view.element.getAttribute('aria-label'), 'Board outline');
  assert.equal(h.view.element.tagName, 'NAV');
});

test('it is a tree for assistive technology with one tab stop', (t) => {
  const h = harness(t);
  assert.equal(h.tree.getAttribute('role'), 'tree');
  assert.equal(h.tree.getAttribute('aria-multiselectable'), 'true');
  h.rows().forEach((li) => assert.ok(li.getAttribute('aria-label'), 'every row has a name a screen reader can read'));
  assert.equal(h.row('g1').getAttribute('aria-expanded'), 'true');
  assert.equal(h.row('n1').hasAttribute('aria-expanded'), false);
  assert.equal(h.row('g1').querySelector(':scope > ul').getAttribute('role'), 'group');
  assert.equal(h.row('n1').getAttribute('aria-label').startsWith('Note'), true);
  const stops = Array.from(h.view.element.querySelectorAll('[tabindex]')).filter((node) => node.closest('[role="tree"]') && node.tabIndex === 0);
  assert.equal(stops.length, 1, 'one tab stop inside the tree');
  assert.equal(stops[0].getAttribute('data-outline-id'), 'g1');
  h.view.focusFirst();
  assert.equal(h.focused(), 'g1');
  h.key(h.row('g1'), 'ArrowDown');
  const after = Array.from(h.tree.querySelectorAll('[tabindex="0"]'));
  assert.deepEqual(after.map((n) => n.getAttribute('data-outline-id')), ['n1'], 'the stop moves with the focus');
});

test('aria-selected follows the editor, and a selection change touches nothing else', (t) => {
  const h = harness(t);
  h.editor.select(['n1']);
  h.editor.calls.length = 0;
  const before = h.rows();
  h.editor.select(['f1', 'l1']);
  h.editor.selectConnector('k1');
  h.editor.select(['f1']);
  assert.deepEqual(h.rows(), before, 'the same nodes: no redraw');
  assert.deepEqual(h.rows().filter((li) => li.getAttribute('aria-selected') === 'true').map((li) => li.getAttribute('data-outline-id')), ['f1']);
  h.editor.selectConnector('k1');
  assert.equal(h.row('k1').getAttribute('aria-selected'), 'true', 'a connection row follows the selected connector');
  assert.equal(h.row('f1').getAttribute('aria-selected'), 'false');
});

test('arrow keys, Home and End move, Left and Right close, open and step through groups', (t) => {
  const h = harness(t);
  h.view.focusFirst();
  assert.equal(h.key(h.row('g1'), 'ArrowDown').defaultPrevented, true);
  assert.equal(h.focused(), 'n1');
  h.key(h.row('n1'), 'ArrowRight');
  assert.equal(h.focused(), 'k1', 'Right on a card with connections goes to the first');
  h.key(h.row('k1'), 'ArrowLeft');
  assert.equal(h.focused(), 'n1', 'Left goes to the parent');
  h.key(h.row('n1'), 'ArrowLeft');
  assert.equal(h.focused(), 'g1');
  h.key(h.row('g1'), 'ArrowLeft');
  assert.equal(h.row('g1').getAttribute('aria-expanded'), 'false');
  assert.equal(h.row('g1').querySelector(':scope > ul').hidden, true);
  h.key(h.row('g1'), 'ArrowDown');
  assert.equal(h.focused(), 'l1', 'a closed group\'s cards are skipped');
  h.key(h.row('l1'), 'ArrowUp');
  assert.equal(h.focused(), 'g1');
  h.key(h.row('g1'), 'ArrowRight');
  assert.equal(h.row('g1').getAttribute('aria-expanded'), 'true');
  h.key(h.row('g1'), 'ArrowRight');
  assert.equal(h.focused(), 'n1', 'Right on an open group goes to its first child');
  h.key(h.row('n1'), 'End');
  assert.equal(h.focused(), 'd1');
  h.key(h.row('d1'), 'Home');
  assert.equal(h.focused(), 'g1');
  const stray = h.key(h.row('d1'), 'q');
  assert.equal(stray.defaultPrevented, false, 'an unhandled key is left alone');
});

test('Space toggles a row, and the editing and history keys go to the editor', (t) => {
  const h = harness(t);
  h.key(h.row('n1'), ' ');
  h.key(h.row('f1'), ' ', { ctrlKey: true });
  h.key(h.row('l1'), ' ', { shiftKey: true });
  assert.deepEqual(h.names('toggle'), [['toggle', 'n1'], ['toggle', 'f1'], ['toggle', 'l1']]);
  h.key(h.row('k1'), ' ');
  assert.deepEqual(h.names('selectConnector'), [['selectConnector', 'k1']]);
  h.key(h.row('n1'), 'z', { ctrlKey: true });
  h.key(h.row('n1'), 'y', { ctrlKey: true });
  h.key(h.row('n1'), 'z', { ctrlKey: true, shiftKey: true });
  h.key(h.row('n1'), 'a', { ctrlKey: true });
  h.key(h.row('n1'), 'g', { ctrlKey: true });
  h.key(h.row('n1'), 'z', { metaKey: true });
  assert.equal(h.names('undo').length, 2);
  assert.equal(h.names('redo').length, 2);
  assert.equal(h.names('select').length, 1, 'Ctrl+A selects the rows that show');
  assert.equal(h.names('groupSelected').length, 1);
  h.editor.select(['f1']);
  h.key(h.row('n1'), 'Delete');
  assert.equal(h.names('removeSelected').length, 1, 'Delete removes the selection');
  h.editor.clearSelection();
  h.editor.calls.length = 0;
  h.key(h.row('l1'), 'Delete');
  assert.deepEqual(h.editor.calls.map((c) => c[0]), ['select', 'removeSelected'], 'with nothing selected the row itself goes');
  h.key(h.row('k1'), 'Delete');
  assert.deepEqual(h.editor.calls.slice(2).map((c) => c[0]), ['selectConnector', 'removeSelected']);
});

test('Enter edits in place: a note in a textarea, a link\'s title, a group\'s title; Ctrl+Enter, blur and Escape settle it', async (t) => {
  const h = harness(t);
  h.row('n1').focus();
  const event = h.key(h.row('n1'), 'Enter');
  assert.equal(event.defaultPrevented, true);
  let field = h.row('n1').querySelector('textarea');
  assert.ok(field, 'a note edits in a textarea');
  assert.equal(field.value, 'Do we keep refresh tokens?\nMobile needs them.');
  assert.equal(h.doc.activeElement, field);
  field.value = 'Keep them';
  assert.equal(h.key(field, 'Enter').defaultPrevented, false, 'plain Enter in a textarea is a new line');
  h.key(field, 'Enter', { ctrlKey: true });
  assert.deepEqual(h.names('editCard'), [['editCard', 'n1', { text: 'Keep them' }]]);
  assert.equal(h.row('n1').querySelector('textarea'), null);
  assert.equal(h.focused(), 'n1', 'focus comes back to the row');

  h.key(h.row('l1'), 'Enter');
  field = h.row('l1').querySelector('input');
  assert.equal(field.value, 'Docs');
  field.value = 'Documentation';
  h.key(field, 'Enter');
  assert.deepEqual(h.names('editCard')[1], ['editCard', 'l1', { title: 'Documentation' }]);

  h.key(h.row('g1'), 'Enter');
  field = h.row('g1').querySelector('input');
  field.value = 'Questions';
  field.blur();
  await h.flush();
  assert.deepEqual(h.names('editGroup'), [['editGroup', 'g1', { title: 'Questions' }]], 'leaving the field commits');

  h.key(h.row('n1'), 'Enter');
  field = h.row('n1').querySelector('textarea');
  field.value = 'discard me';
  h.key(field, 'Escape');
  assert.equal(h.row('n1').querySelector('textarea'), null);
  h.key(h.row('g1'), 'Enter');
  h.key(h.row('g1').querySelector('input'), 'Enter');
  assert.equal(h.names('editGroup').length, 1, 'an unchanged value is not sent');
  assert.equal(h.names('editCard').length, 2, 'Escape sent nothing');
  const file = h.key(h.row('f1'), 'Enter');
  assert.equal(file.defaultPrevented, false, 'a file card has no in-place edit here');
  assert.equal(h.row('f1').querySelector('input, textarea'), null);
});

test('a redraw after a board change keeps focus and the open groups, and waits for an edit in progress', (t) => {
  const h = harness(t);
  h.key(h.row('g1'), 'ArrowLeft');
  h.row('i1').focus();
  const next = fixture();
  next.cards.i1.data.alt = 'Wireframe v2';
  next.cards.zz = card('zz', 'n7', 'note', 5, 5, { text: 'new', tone: null });
  h.editor.setBoard(next);
  assert.equal(h.focused(), 'i1', 'focus stays on the same row by id');
  assert.match(h.row('i1').textContent, /Wireframe v2/);
  assert.equal(h.row('g1').getAttribute('aria-expanded'), 'false', 'a closed group stays closed');
  assert.ok(h.row('zz'));
  assert.equal(Array.from(h.tree.querySelectorAll('[tabindex="0"]')).length, 1);
  // The focused row goes away: focus falls to a neighbour, not to the page.
  const gone = fixture();
  delete gone.cards.i1;
  h.editor.setBoard(gone);
  assert.notEqual(h.focused(), null);
  assert.ok(h.tree.contains(h.doc.activeElement));
  // An edit in progress is not cancelled by a redraw.
  h.key(h.row('l1'), 'Enter');
  const field = h.row('l1').querySelector('input');
  h.editor.setBoard(fixture());
  assert.equal(h.row('l1').querySelector('input'), field, 'the field survives a board change');
  h.key(field, 'Escape');
  assert.ok(h.row('i1'), 'the held redraw ran when the edit ended');
});

test('setMatches hides the rows that are not in the list and their connections; null shows everything', (t) => {
  const h = harness(t);
  h.view.setMatches(['f1', 'd1']);
  const shown = () => h.rows().filter((li) => !li.closest('[hidden]')).map((li) => li.getAttribute('data-outline-id'));
  assert.deepEqual(shown(), ['g1', 'f1', 'd1'], 'the group stays for its matching card; connections go with their hidden card');
  h.view.setMatches(['n1']);
  assert.deepEqual(shown(), ['g1', 'n1', 'k1', 'k2']);
  h.view.setMatches([]);
  assert.deepEqual(shown(), []);
  assert.equal(h.view.element.querySelector('[data-outline-empty]').textContent, 'No cards match.');
  h.view.setMatches(['g1']);
  assert.deepEqual(shown(), ['g1'], 'a matching group shows by itself');
  h.view.setMatches(null);
  assert.equal(shown().length, 10);
  h.view.setMatches(['n1', 'i1']);
  h.key(h.row('n1'), 'End');
  assert.equal(h.focused(), 'i1', 'keys skip hidden rows');
});

test('hostile text from a board is shown as text', (t) => {
  const bad = fixture();
  bad.cards.n1.data.text = '<img src=x onerror="globalThis.hit=1">';
  bad.groups.g1.title = '</script><b id="boom">x</b>';
  bad.cards.l1.data.title = '<svg onload=1>';
  bad.cards.f1.data.path = '"><script>1</script>';
  bad.connectors.k1.label = '<u>hi</u>';
  const h = harness(t, { board: bad });
  assert.equal(h.tree.querySelector('img, b, svg[onload], script, u'), null);
  assert.ok(h.row('n1').textContent.includes('<img src=x onerror="globalThis.hit=1">'));
  assert.ok(h.row('g1').textContent.includes('</script><b id="boom">x</b>'));
  assert.ok(h.row('k1').textContent.includes('<u>hi</u>'));
  assert.equal(globalThis.hit, undefined);
  assert.equal(h.doc.getElementById('boom'), null);
});

test('every visible control works: Add note, Add link, the row menu with Edit, Connect to, Move to group and Delete, Rename, Ungroup, Remove', async (t) => {
  const h = harness(t);
  const bar = h.view.element.querySelector('.board-outline__bar');
  const [addNote, addLink] = bar.querySelectorAll('button');
  assert.deepEqual([addNote.textContent, addLink.textContent], ['Add note', 'Add link']);
  addNote.click();
  await h.flush();
  assert.deepEqual(h.names('addNote'), [['addNote', {}]]);
  assert.ok(h.row('nn').querySelector('textarea'), 'the new note opens for typing');
  assert.equal(h.doc.activeElement, h.row('nn').querySelector('textarea'), 'with the cursor in it');
  h.key(h.row('nn').querySelector('textarea'), 'Escape');

  addLink.click();
  const form = h.view.element.querySelector('[data-outline-link-form]');
  const input = form.querySelector('[data-outline-link-input]');
  assert.equal(form.hidden, false);
  assert.equal(addLink.getAttribute('aria-expanded'), 'true');
  for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'example.com', '']) {
    input.value = bad;
    form.querySelector('[data-outline-link-submit]').click();
    assert.equal(form.querySelector('[role="alert"]').hidden, false, `${bad}: refused with a message`);
  }
  assert.equal(h.names('addLink').length, 0, 'only http and https go through');
  input.value = ' https://example.org/a ';
  h.key(input, 'Enter');
  await h.flush();
  assert.deepEqual(h.names('addLink'), [['addLink', { url: 'https://example.org/a' }]]);
  assert.equal(form.hidden, true);
  addLink.click();
  h.key(input, 'Escape');
  assert.equal(form.hidden, true);
  assert.equal(h.doc.activeElement, addLink);

  // The row menu.
  act(h, 'n1', 'more').click();
  const menu = h.menus.pop();
  assert.deepEqual(menu.items.map((item) => item.label), ['Edit', 'Connect to', 'Move to group', 'Delete']);
  const connectTo = menu.items[1].items;
  assert.equal(connectTo.length, 6, 'every other card, by alias and text');
  assert.ok(connectTo.some((item) => item.label === 'f1 session.ts · src/auth/session.ts'.slice(0, 60)));
  assert.equal(connectTo.some((item) => item.label.startsWith('n1 ')), false, 'not the card itself');
  connectTo.find((item) => item.label.startsWith('d1')).action();
  assert.deepEqual(h.names('connect'), [['connect', 'n1', 'd1']]);
  const moveTo = menu.items[2].items;
  assert.deepEqual(moveTo.map((item) => item.label), ['No group', 'g1 Open questions']);
  assert.equal(moveTo[1].checked, true);
  moveTo[0].action();
  moveTo[1].action();
  assert.deepEqual(h.names('assignToGroup'), [['assignToGroup', ['n1'], null], ['assignToGroup', ['n1'], 'g1']]);
  menu.items[0].action();
  assert.ok(h.row('n1').querySelector('textarea'), 'Edit opens the field');
  h.key(h.row('n1').querySelector('textarea'), 'Escape');
  h.editor.calls.length = 0;
  menu.items[3].action();
  assert.deepEqual(h.editor.calls.map((c) => c[0]), ['select', 'removeSelected']);

  // Menu key and Shift+F10 open it from the keyboard.
  h.key(h.row('l1'), 'ContextMenu');
  h.key(h.row('l1'), 'F10', { shiftKey: true });
  assert.equal(h.menus.length, 2);
  assert.equal(h.key(h.row('k1'), 'ContextMenu').defaultPrevented, false, 'a connection has no menu');
  const noGroup = h.menus.pop().items[2].items.map((item) => item.checked);
  assert.deepEqual(noGroup, [true, false]);

  // A group row: Rename and Ungroup.
  act(h, 'g1', 'rename').click();
  assert.ok(h.row('g1').querySelector('input'));
  h.key(h.row('g1').querySelector('input'), 'Escape');
  h.editor.calls.length = 0;
  act(h, 'g1', 'ungroup').click();
  assert.deepEqual(h.editor.calls.map((c) => c[0]), ['select', 'ungroupSelected']);
  assert.deepEqual(h.editor.calls[0].slice(1, 2), [['g1']]);
  // A connection row: Remove.
  act(h, 'k2', 'remove').click();
  assert.deepEqual(h.names('removeConnector'), [['removeConnector', 'k2']]);
  assert.match(act(h, 'k2', 'remove').getAttribute('aria-label'), /Remove connection to l1/);
  assert.match(act(h, 'n1', 'more').getAttribute('aria-label'), /More actions for n1/);
  assert.equal(act(h, 'n1', 'more').getAttribute('title'), 'More actions');
});

function act(h, id, name) { return h.act(id, name); }

test('on a board that cannot be changed the controls are disabled with the reason, not hidden', (t) => {
  const h = harness(t, { canEdit: false });
  const buttons = Array.from(h.view.element.querySelectorAll('button')).filter((button) => !button.closest('[data-outline-link-form]'));
  assert.ok(buttons.length >= 2 + 6 + 1 + 3, 'Add note, Add link and every row control are drawn');
  buttons.forEach((button) => {
    assert.equal(button.disabled, true, button.outerHTML);
    assert.equal(button.hidden, false);
    assert.equal(button.getAttribute('title'), 'This board cannot be changed.');
  });
  h.row('n1').focus();
  assert.equal(h.key(h.row('n1'), 'Enter').defaultPrevented, false);
  assert.equal(h.row('n1').querySelector('textarea'), null);
  h.key(h.row('n1'), 'ContextMenu');
  assert.equal(h.menus.length, 0);
  h.key(h.row('n1'), ' ');
  assert.equal(h.names('toggle').length, 1, 'selecting still works');
  h.editor.setCanEdit(true);
  const enabled = Array.from(h.view.element.querySelectorAll('button'));
  enabled.forEach((button) => assert.equal(button.disabled, false));
  assert.equal(act(h, 'n1', 'more').getAttribute('title'), 'More actions');
});

test('an empty board says so in text and keeps Add note', (t) => {
  const empty = { id: 'board_2', name: 'Empty', rev: 0, groups: {}, cards: {}, connectors: {} };
  const h = harness(t, { board: empty });
  const hint = h.view.element.querySelector('[data-outline-empty]');
  assert.equal(hint.hidden, false);
  assert.equal(hint.textContent, 'This board is empty. Choose Add note or Add link, or ask Jenny to lay something out.');
  assert.equal(h.view.element.querySelector('.board-outline__bar button').disabled, false);
  assert.equal(h.rows().length, 0);
  h.view.focusFirst();
  assert.equal(h.doc.activeElement.textContent, 'Add note');
  h.view.show(null);
  assert.equal(h.view.element.querySelector('[data-outline-empty]').hidden, true);
});

test('500 cards draw in one pass with no listener on a row, and dispose stops everything', (t) => {
  const big = { id: 'board_3', name: 'Big', rev: 0, groups: { g1: group('g1', 'g1', 'All', 0, 0) }, cards: {}, connectors: {} };
  for (let i = 1; i <= 500; i += 1) big.cards[`c${i}`] = card(`c${i}`, `n${i}`, 'note', (i % 25) * 170, Math.floor(i / 25) * 90, { text: `Card ${i}`, tone: null }, i % 3 === 0 ? 'g1' : null);
  for (let i = 1; i < 200; i += 1) big.connectors[`k${i}`] = connector(`k${i}`, `c${i}`, `c${i + 1}`);
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/' });
  const { window } = dom;
  const adds = [];
  const removes = [];
  const proto = window.EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  proto.addEventListener = function (type, ...rest) { adds.push([this, type]); return add.call(this, type, ...rest); };
  proto.removeEventListener = function (type, ...rest) { removes.push([this, type]); return remove.call(this, type, ...rest); };
  t.after(() => { proto.addEventListener = add; proto.removeEventListener = remove; window.close(); });
  const editor = standInEditor(big);
  const view = createBoardOutlineView({ document: window.document, actionButton, editor, model: require('../services/boards/board-model'), contextMenu: { show() {}, hide() {} } });
  window.document.body.appendChild(view.element);
  const before = adds.length;
  view.show(big);
  const rowEvents = adds.slice(before).filter(([target]) => target.closest && target.closest('li'));
  assert.equal(window.document.querySelectorAll('li[role="treeitem"]').length, 500 + 1 + 199);
  assert.equal(rowEvents.length, 0, 'no listener on a row or anything in it');
  const tree = window.document.querySelector('[role="tree"]');
  const onTree = adds.filter(([target]) => target === tree).map(([, type]) => type).sort();
  assert.deepEqual(onTree, ['click', 'contextmenu', 'focusin', 'keydown'], 'one delegated listener per event on the tree');
  assert.equal(adds.slice(before).length, 0, 'drawing adds no listener at all');
  view.dispose();
  assert.equal(editor.listenerCount(), 0, 'the editor subscription is gone');
  const left = adds.filter(([target, type]) => !removes.some(([t2, ty2]) => t2 === target && ty2 === type));
  assert.deepEqual(left.filter(([target]) => target.closest && target.closest('.board-outline')).map(([, type]) => type), [], 'every listener it added is removed');
  assert.equal(window.document.querySelector('.board-outline'), null);
});

test('a note added from the outline and cancelled is taken off again: Escape, or leaving it empty; a save, text or a lost window keeps it', async (t) => {
  const h = harness(t);
  const add = () => { h.view.element.querySelector('[data-outline-add="note"]').click(); return h.flush(); };
  const box = () => h.row('nn').querySelector('textarea');
  const leave = () => box().dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  const removed = () => h.names('removeSelected').length;
  await add();
  box().value = 'half a thought';
  h.key(box(), 'Escape');
  assert.deepEqual([removed(), h.editor.getSelection(), h.names('editCard').length], [1, ['nn'], 0], 'Escape: the new note alone is selected and removed, and nothing is saved');
  await add();
  leave();
  assert.equal(removed(), 2, 'left with nothing typed');
  await add();
  box().value = 'a real note';
  leave();
  assert.deepEqual([removed(), h.names('editCard').pop().slice(1)], [2, ['nn', { text: 'a real note' }]], 'left with text: saved');
  await add();
  h.key(box(), 'Enter', { ctrlKey: true });
  assert.equal(removed(), 2, 'saved empty on purpose');
  await add();
  h.doc.hasFocus = () => false;
  leave();
  assert.equal(removed(), 2, 'the window lost focus');
  delete h.doc.hasFocus;
  h.row('n1').focus();
  h.key(h.row('n1'), 'Enter');
  h.row('n1').querySelector('textarea').value = '';
  h.key(h.row('n1').querySelector('textarea'), 'Escape');
  assert.equal(removed(), 2, 'a note that was already there is never removed by Escape');
});
