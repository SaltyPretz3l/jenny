'use strict';

// new-test-file: a new surface (the Board's canvas keyboard map, find box and Canvas | Outline switch); each runs against a stand-in editor and canvas view with exactly the surface of the shared board-editor contract (sections 1 and 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createBoardKeyboard } = require('../renderer/features/board/board-keyboard');
const { findCards, createBoardFind } = require('../renderer/features/board/board-find');
const { createBoardViewSwitch } = require('../renderer/features/board/board-view-switch');
const { createLayoutStore, VIEW_KEY } = require('../renderer/features/board/board-layout-store');
const actionButton = require('../renderer/inventory/action-button');

const card = (id, alias, kind, x, y, data, group) => ({ id, alias, kind, x, y, w: 100, h: 60, z: 0, group_id: group || null, geo_rev: 0, content_rev: 0, data });

// Centres: a (50,30)  b (360,30)  e (200,190)  c (50,330)  d (350,330). Reading order: a, b, e, c, d.
function gridBoard() {
  return {
    id: 'board_1', name: 'Grid', groups: {}, connectors: {},
    cards: {
      d: card('d', 'n4', 'note', 300, 300, { text: 'D', tone: null }),
      c: card('c', 'n3', 'note', 0, 300, { text: 'C', tone: null }),
      e: card('e', 'n5', 'note', 150, 160, { text: 'E', tone: null }),
      b: card('b', 'n2', 'note', 310, 0, { text: 'B', tone: null }),
      a: card('a', 'n1', 'note', 0, 0, { text: 'A', tone: null }),
    },
  };
}

function standIn(board) {
  let selection = [];
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve({ ok: true }); };
  const editor = {
    getBoard: () => board,
    getSelection: () => selection.slice(),
    select(ids) { calls.push(['select', ids]); selection = ids.slice(); },
    clearSelection() { calls.push(['clearSelection']); selection = []; },
    getSelectedConnector: () => '',
    selectConnector: rec('selectConnector'),
    selectAll: rec('selectAll'), removeSelected: rec('removeSelected'), undo: rec('undo'), redo: rec('redo'), groupSelected: rec('groupSelected'),
    ungroupSelected: rec('ungroupSelected'), duplicateSelected: rec('duplicateSelected'), nudgeSelected: rec('nudgeSelected'), connect: rec('connect'),
  };
  const view = {};
  ['focusItem', 'startEdit', 'zoomBy', 'fit', 'actualSize'].forEach((name) => { view[name] = (...args) => { calls.push([`view.${name}`, ...args]); return true; }; });
  return { editor, view, calls, setSelection: (ids) => { selection = ids.slice(); } };
}

function keyboardHarness(t, { platform = 'Win32' } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="canvas"><button id="fit">Fit</button></div></body>', { url: 'https://jenny.invalid/' });
  const { window } = dom;
  const doc = window.document;
  const stand = standIn(gridBoard());
  const finds = [];
  const keyboard = createBoardKeyboard({ editor: stand.editor, view: stand.view, openFind: () => finds.push('open'), platform });
  const canvas = doc.getElementById('canvas');
  Object.keys(gridBoard().cards).forEach((id) => { const node = doc.createElement('div'); node.setAttribute('data-card-id', id); node.tabIndex = 0; canvas.appendChild(node); });
  keyboard.attach(canvas);
  t.after(() => { keyboard.dispose(); window.close(); });
  const press = (target, key, init) => {
    const event = new window.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, init || {}));
    target.dispatchEvent(event);
    return event;
  };
  const on = (id) => canvas.querySelector(`[data-card-id="${id}"]`);
  const live = () => canvas.querySelector('[data-board-live]');
  const last = () => stand.calls[stand.calls.length - 1];
  return { ...stand, window, doc, canvas, keyboard, press, on, live, last, finds };
}

test('Tab and Shift+Tab walk the cards in reading order, select each, and leave the canvas past the ends', (t) => {
  const h = keyboardHarness(t);
  const order = [];
  let target = h.canvas;
  for (let i = 0; i < 5; i += 1) {
    const event = h.press(target, 'Tab');
    assert.equal(event.defaultPrevented, true);
    const id = h.calls.filter((c) => c[0] === 'view.focusItem').pop()[1];
    order.push(id);
    target = h.on(id);
  }
  assert.deepEqual(order, ['a', 'b', 'e', 'c', 'd']);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'select').map((c) => c[1][0]), order, 'each stop selects the card');
  h.calls.length = 0;
  const past = h.press(h.on('d'), 'Tab');
  assert.equal(past.defaultPrevented, false, 'past the last card Tab leaves the canvas');
  assert.deepEqual(h.calls, []);
  h.press(h.on('d'), 'Tab', { shiftKey: true });
  assert.equal(h.last()[1], 'c');
  h.calls.length = 0;
  assert.equal(h.press(h.on('a'), 'Tab', { shiftKey: true }).defaultPrevented, false);
  assert.deepEqual(h.calls, []);
});

test('arrow keys go to the nearest card in that direction, and nothing happens when there is none', (t) => {
  const h = keyboardHarness(t);
  const go = (from, key) => {
    h.calls.length = 0;
    const event = h.press(h.on(from), key);
    return { event, to: (h.calls.find((c) => c[0] === 'view.focusItem') || [])[1] };
  };
  assert.equal(go('a', 'ArrowRight').to, 'b');
  assert.equal(go('a', 'ArrowDown').to, 'e', 'nearest, not axis aligned');
  assert.equal(go('e', 'ArrowRight').to, 'd');
  assert.equal(go('e', 'ArrowLeft').to, 'c');
  assert.equal(go('e', 'ArrowUp').to, 'a');
  assert.equal(go('c', 'ArrowRight').to, 'e');
  const none = go('e', 'ArrowDown');
  assert.equal(none.to, undefined, 'no card that way');
  assert.deepEqual(h.calls, []);
  assert.equal(go('a', 'ArrowLeft').event.defaultPrevented, true, 'the key is still taken');
  assert.deepEqual(h.calls.filter((c) => c[0] === 'select').length, 0);
  assert.equal(go('a', 'ArrowRight').event.defaultPrevented, true);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'select'), [['select', ['b']]]);
});

function everyKey(h, mod) {
  const press = (key, init) => h.press(h.on('a'), key, Object.assign({}, init));
  h.setSelection(['a']);
  const cases = [
    [() => press('Enter'), ['view.startEdit', 'a']],
    [() => press('ArrowRight', { altKey: true }), ['nudgeSelected', 8, 0]],
    [() => press('ArrowLeft', { altKey: true }), ['nudgeSelected', -8, 0]],
    [() => press('ArrowUp', { altKey: true, shiftKey: true }), ['nudgeSelected', 0, -1]],
    [() => press('ArrowDown', { altKey: true, shiftKey: true }), ['nudgeSelected', 0, 1]],
    [() => press('a', mod), ['selectAll']],
    [() => press('Delete'), ['removeSelected']],
    [() => press('Backspace'), ['removeSelected']],
    [() => press('z', mod), ['undo']],
    [() => press('y', mod), ['redo']],
    [() => press('z', Object.assign({ shiftKey: true }, mod)), ['redo']],
    [() => press('g', mod), ['groupSelected']],
    [() => press('g', Object.assign({ shiftKey: true }, mod)), ['ungroupSelected']],
    [() => press('d', mod), ['duplicateSelected']],
    [() => press('+'), ['view.zoomBy', 1.2]],
    [() => press('=', { shiftKey: false }), ['view.zoomBy', 1.2]],
    [() => press('-'), ['view.zoomBy', 1 / 1.2]],
    [() => press('0'), ['view.actualSize']],
    [() => press('1'), ['view.fit']],
    [() => press('Escape'), ['clearSelection']],
  ];
  for (const [fire, expected] of cases) {
    h.calls.length = 0;
    const event = fire();
    assert.deepEqual(h.calls[0], expected, JSON.stringify(expected));
    assert.equal(event.defaultPrevented, true, `${expected[0]} is handled`);
    h.setSelection(['a']);
  }
  h.press(h.on('a'), 'f', mod);
  assert.deepEqual(h.finds, ['open'], 'Find opens');
}

test('every key of the map goes to the editor or the canvas, with Ctrl on Windows', (t) => {
  everyKey(keyboardHarness(t), { ctrlKey: true });
});

test('on macOS the same keys answer to Cmd, not Ctrl', (t) => {
  const h = keyboardHarness(t, { platform: 'MacIntel' });
  everyKey(h, { metaKey: true });
  h.calls.length = 0;
  const control = h.press(h.on('a'), 'z', { ctrlKey: true });
  assert.equal(control.defaultPrevented, false);
  assert.deepEqual(h.calls, []);
});

test('keys that are not handled are left alone, and Enter needs exactly one selected item', (t) => {
  const h = keyboardHarness(t);
  for (const [key, init] of [['x'], ['F5'], ['a'], ['z', { ctrlKey: true, altKey: true }], ['ArrowLeft', { shiftKey: true }], ['Enter']]) {
    h.calls.length = 0;
    assert.equal(h.press(h.on('a'), key, init).defaultPrevented, false, `${key} ${JSON.stringify(init || {})}`);
    assert.deepEqual(h.calls, []);
  }
  h.setSelection(['a', 'b']);
  assert.equal(h.press(h.on('a'), 'Enter').defaultPrevented, false, 'two selected');
  h.setSelection(['a']);
  assert.equal(h.press(h.canvas.querySelector('#fit'), 'Enter').defaultPrevented, false, 'Enter on the Fit button is the button\'s');
  assert.equal(h.press(h.canvas.querySelector('#fit'), 'Tab').defaultPrevented, false);
});

test('connect mode: L starts it, arrows and Tab choose, Enter connects, Escape leaves, and a live region speaks', async (t) => {
  const h = keyboardHarness(t);
  h.setSelection(['a', 'b']);
  assert.equal(h.press(h.on('a'), 'l').defaultPrevented, false, 'two selected: no mode');
  h.setSelection(['a']);
  assert.equal(h.press(h.on('a'), 'L').defaultPrevented, true);
  assert.equal(h.live().textContent, 'Connecting from n1. Choose a card and press Enter.');
  assert.equal(h.live().getAttribute('role'), 'status');
  h.calls.length = 0;
  h.press(h.on('a'), 'ArrowRight');
  assert.deepEqual(h.calls, [['view.focusItem', 'b']], 'the target is shown through focusItem and the selection does not move');
  assert.match(h.live().textContent, /n1.*n2/);
  h.press(h.on('b'), 'Tab');
  assert.equal(h.last()[1], 'e');
  h.press(h.on('e'), 'ArrowRight');
  assert.equal(h.last()[1], 'd');
  h.calls.length = 0;
  h.press(h.on('d'), 'Enter');
  assert.deepEqual(h.calls.filter((c) => c[0] === 'connect'), [['connect', 'a', 'd']]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.live().textContent, 'Connected n1 to n4.');
  h.calls.length = 0;
  h.press(h.on('a'), 'Enter');
  assert.deepEqual(h.calls[0], ['view.startEdit', 'a'], 'the mode is over');

  h.press(h.on('a'), 'l');
  h.press(h.on('a'), 'ArrowDown');
  h.calls.length = 0;
  const cancel = h.press(h.on('e'), 'Escape');
  assert.equal(cancel.defaultPrevented, true);
  assert.deepEqual(h.calls, [['view.focusItem', 'a']], 'Escape leaves the mode, not the selection');
  assert.equal(h.live().textContent, 'Connecting cancelled.');
  h.press(h.on('a'), 'l');
  h.calls.length = 0;
  h.press(h.on('a'), 'Enter');
  assert.deepEqual(h.calls.filter((c) => c[0] === 'connect'), [], 'Enter with no target connects nothing');
  h.press(h.on('a'), 'Escape');
  h.calls.length = 0;
  h.press(h.on('a'), 'Escape');
  assert.deepEqual(h.calls, [['clearSelection']], 'outside the mode Escape clears the selection');
});

test('a key aimed at a field is left alone, and dispose removes the listener and the live region', (t) => {
  const h = keyboardHarness(t);
  const area = h.doc.createElement('textarea');
  const select = h.doc.createElement('select');
  const editable = h.doc.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  const inner = h.doc.createElement('span');
  editable.appendChild(inner);
  const input = h.doc.createElement('input');
  [area, select, editable, input].forEach((node) => h.canvas.appendChild(node));
  h.setSelection(['a']);
  h.calls.length = 0;
  for (const target of [area, select, inner, input]) {
    for (const key of ['Delete', 'Enter', 'Tab', 'ArrowRight', 'Escape', 'l']) assert.equal(h.press(target, key).defaultPrevented, false, `${target.tagName} ${key}`);
    assert.equal(h.press(target, 'z', { ctrlKey: true }).defaultPrevented, false);
  }
  assert.deepEqual(h.calls, []);
  assert.ok(h.live());
  let removed = 0;
  const original = h.canvas.removeEventListener;
  h.canvas.removeEventListener = function (...args) { removed += 1; return original.apply(this, args); };
  h.keyboard.dispose();
  assert.equal(removed, 1, 'the one listener is removed');
  assert.equal(h.live(), null);
  assert.equal(h.press(h.on('a'), 'Delete').defaultPrevented, false);
  assert.deepEqual(h.calls, []);
});

// ------------------------------------------------------------------ find

function findBoard() {
  return {
    id: 'board_1', name: 'Find', connectors: {},
    groups: { g1: { id: 'g1', alias: 'g1', title: 'Open Questions', x: 0, y: 500, w: 1, h: 1, tone: null } },
    cards: {
      n1: card('n1', 'n1', 'note', 0, 0, { text: 'First line\nSecond line about Tokens', tone: null }),
      f1: card('f1', 'f1', 'file', 0, 100, { path: 'src/auth/session.ts', title: 'Session store' }),
      l1: card('l1', 'l1', 'link', 0, 200, { url: 'https://docs.example.com/a?x=secretquery', title: 'Docs' }),
      c1: card('c1', 'c1', 'chat', 0, 300, { session_id: 's', title: 'Auth chat', excerpt: 'hidden excerpt' }),
      d1: card('d1', 'd1', 'diagram', 0, 400, { scene: 'a -> b', title: 'Checkout flow' }),
      i1: card('i1', 'i1', 'image', 100, 400, { asset: 'a', width: 1, height: 1, alt: 'Wireframe sketch' }),
    },
  };
}

test('findCards matches what the outline shows, a note\'s whole text and a group\'s title, ignoring case and outer spaces', () => {
  const board = findBoard();
  assert.deepEqual(findCards(board, 'tokens'), ['n1'], 'a note is searched by its whole text');
  assert.deepEqual(findCards(board, '  FIRST LINE '), ['n1']);
  assert.deepEqual(findCards(board, 'session'), ['f1'], 'a file by its title');
  assert.deepEqual(findCards(board, 'auth/session'), ['f1'], 'and by its path');
  assert.deepEqual(findCards(board, 'docs.example.com'), ['l1'], 'a link by its host');
  assert.deepEqual(findCards(board, 'docs'), ['l1']);
  assert.deepEqual(findCards(board, 'secretquery'), [], 'not by the rest of the address');
  assert.deepEqual(findCards(board, 'auth chat'), ['c1']);
  assert.deepEqual(findCards(board, 'hidden excerpt'), [], 'a chat card is found by its title, as the outline shows it');
  assert.deepEqual(findCards(board, 'checkout'), ['d1']);
  assert.deepEqual(findCards(board, 'wireframe'), ['i1']);
  assert.deepEqual(findCards(board, 'questions'), ['g1'], 'a group by its title');
  assert.deepEqual(findCards(board, 'e'), ['n1', 'f1', 'l1', 'd1', 'i1', 'g1'], 'in reading order');
  assert.deepEqual(findCards(board, '   '), []);
  assert.deepEqual(findCards(board, ''), []);
  assert.deepEqual(findCards(null, 'x'), []);
  assert.deepEqual(findCards(board, 'nothing like this'), []);
});

function findHarness(t, board = findBoard()) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Find</button></body>', { url: 'https://jenny.invalid/' });
  const { window } = dom;
  const doc = window.document;
  const calls = [];
  const find = createBoardFind({ document: doc, actionButton, getBoard: () => board, onMatches: (...args) => calls.push(args) });
  doc.body.appendChild(find.element);
  t.after(() => { find.dispose(); window.close(); });
  const input = find.element.querySelector('[data-board-find-input]');
  const type = (value) => { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const press = (key, init) => { const event = new window.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, init || {})); input.dispatchEvent(event); return event; };
  return { window, doc, find, calls, input, type, press, count: () => find.element.querySelector('[data-board-find-count]').textContent };
}

test('the find box: a field, a count, Enter through the matches, Escape and the close button', (t) => {
  const h = findHarness(t);
  assert.equal(h.find.element.hidden, true);
  h.doc.getElementById('opener').focus();
  h.find.open();
  assert.equal(h.find.element.hidden, false);
  assert.equal(h.doc.activeElement, h.input, 'open puts the cursor in the field');
  assert.equal(h.find.element.getAttribute('role'), 'search');
  h.type('line');
  assert.deepEqual(h.calls.pop(), [['n1']]);
  assert.equal(h.count(), '1 of 6 cards');
  h.type('e');
  const ids = h.calls.pop()[0];
  assert.equal(ids.length, 6);
  assert.equal(h.count(), '6 of 6 cards', 'a group counts as a match');
  assert.equal(h.press('Enter').defaultPrevented, true);
  assert.deepEqual(h.calls.pop(), [ids, ids[0]]);
  h.press('Enter');
  assert.deepEqual(h.calls.pop(), [ids, ids[1]]);
  h.press('Enter', { shiftKey: true });
  assert.deepEqual(h.calls.pop(), [ids, ids[0]], 'Shift+Enter steps back');
  h.press('Enter', { shiftKey: true });
  assert.deepEqual(h.calls.pop(), [ids, ids[ids.length - 1]], 'and wraps');
  h.type('   ');
  assert.deepEqual(h.calls.pop(), [null], 'an empty box clears the matches');
  assert.equal(h.count(), '');
  h.type('zzz');
  assert.deepEqual(h.calls.pop(), [[]]);
  assert.equal(h.count(), 'No cards match');
  assert.equal(h.press('Escape').defaultPrevented, true);
  assert.deepEqual(h.calls.pop(), [null]);
  assert.equal(h.find.element.hidden, true);
  assert.equal(h.input.value, '');
  assert.equal(h.doc.activeElement.id, 'opener', 'focus goes back to where it was');
  h.find.open();
  h.type('docs');
  h.calls.length = 0;
  h.find.element.querySelector('[data-board-find-close]').click();
  assert.deepEqual(h.calls, [[null]]);
  assert.equal(h.find.element.hidden, true);
  const close = h.find.element.querySelector('[data-board-find-close]');
  assert.ok(close.getAttribute('aria-label') && close.getAttribute('title'), 'the icon button has a label and a title');
});

test('the count says "1 card" for a one-card board, and dispose removes the box', (t) => {
  const one = { id: 'b', name: 'One', groups: {}, connectors: {}, cards: { n1: card('n1', 'n1', 'note', 0, 0, { text: 'solo', tone: null }) } };
  const h = findHarness(t, one);
  h.find.open();
  h.type('solo');
  assert.equal(h.count(), '1 of 1 card');
  h.find.dispose();
  assert.equal(h.doc.querySelector('.board-find'), null);
  h.find.open();
  h.type('x');
  assert.equal(h.calls.length, 1, 'a disposed box answers nothing');
});

// ------------------------------------------------------------------ the Canvas | Outline switch

function switchHarness(t, { projectId = { value: 'p1' }, storage } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://jenny.invalid/' });
  const { window } = dom;
  const changes = [];
  const store = storage || window.localStorage;
  const make = () => createBoardViewSwitch({ document: window.document, storage: store, getProjectId: () => projectId.value, onChange: (view) => changes.push(view) });
  const sw = make();
  window.document.body.appendChild(sw.element);
  t.after(() => { sw.dispose(); window.close(); });
  const radios = () => Array.from(sw.element.querySelectorAll('[role="radio"]'));
  return { window, sw, changes, store, radios, projectId, make, on: () => radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.getAttribute('data-value')) };
}

test('the view switch is a radio group, Canvas first, remembered per project', (t) => {
  const h = switchHarness(t);
  const group = h.sw.element.querySelector('[role="radiogroup"]');
  assert.equal(group.getAttribute('aria-label'), 'Board view');
  assert.deepEqual(h.radios().map((r) => r.textContent), ['Canvas', 'Outline']);
  assert.equal(h.sw.get(), 'canvas');
  assert.deepEqual(h.on(), ['canvas']);
  h.radios()[1].click();
  assert.deepEqual(h.changes, ['outline'], 'a click calls onChange');
  assert.equal(h.sw.get(), 'outline');
  assert.deepEqual(JSON.parse(h.store.getItem(VIEW_KEY)), { p1: 'outline' });
  h.projectId.value = 'p2';
  assert.equal(h.sw.get(), 'canvas', 'another project has its own view');
  assert.deepEqual(h.on(), ['canvas'], 'and the control follows');
  h.sw.set('outline');
  assert.deepEqual(h.changes, ['outline', 'outline'], 'set calls onChange too');
  assert.deepEqual(JSON.parse(h.store.getItem(VIEW_KEY)), { p1: 'outline', p2: 'outline' });
  h.sw.set('canvas');
  assert.deepEqual(h.on(), ['canvas']);
  assert.equal(h.changes.pop(), 'canvas');
  h.sw.set('nonsense');
  assert.equal(h.changes.length, 2, 'an unknown view is ignored');
  h.projectId.value = 'p1';
  const again = h.make();
  assert.equal(again.get(), 'outline', 'a new switch starts where the project was left');
  assert.deepEqual(Array.from(again.element.querySelectorAll('[aria-checked="true"]')).map((r) => r.getAttribute('data-value')), ['outline']);
  again.element.querySelector('[data-value="canvas"]').click();
  assert.equal(h.changes.pop(), 'canvas', 'a second switch over the same store is its own control');
  again.dispose();
});

test('the layout store keeps a view per project and survives a missing or damaged store', () => {
  const memory = new Map();
  const storage = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v) };
  const store = createLayoutStore({ storage, model: null });
  assert.equal(store.viewOf('p1'), 'canvas');
  store.saveView('p1', 'outline');
  store.saveView('p2', 'nonsense');
  store.saveView('', 'outline');
  assert.equal(store.viewOf('p1'), 'outline');
  assert.equal(store.viewOf('p2'), 'canvas');
  memory.set(VIEW_KEY, '{"p1":"sideways"}');
  assert.equal(store.viewOf('p1'), 'canvas', 'a damaged value reads as the default');
  memory.set(VIEW_KEY, '[1]');
  store.saveView('p3', 'outline');
  assert.equal(store.viewOf('p3'), 'outline');
  memory.set(VIEW_KEY, 'not json');
  assert.equal(store.viewOf('p1'), 'canvas');
  const broken = createLayoutStore({ storage: { getItem() { throw new Error('no'); }, setItem() { throw new Error('full'); } }, model: null });
  assert.equal(broken.viewOf('p1'), 'canvas');
  assert.doesNotThrow(() => broken.saveView('p1', 'outline'));
  for (let i = 0; i < 130; i += 1) store.saveView(`q${i}`, 'outline');
  assert.ok(Object.keys(JSON.parse(memory.get(VIEW_KEY))).length <= 100, 'the record is bounded');
});
