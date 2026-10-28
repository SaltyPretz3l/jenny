'use strict';

/* Row 82 T1: the Workspace PTY terminal find bar over a fake SearchAddon. The bar is built
 * from the inventory text-field and action-button primitives inside a host element the
 * panel owns; it keeps its own state across the panel's markup rebuilds. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createTerminalFind, toHexColor } = require('../renderer/features/renderer-ide-terminal-find');

function fakeAddon({ found = true, result = { resultIndex: 2, resultCount: 12 } } = {}) {
  const addon = {
    calls: [],
    cleared: 0,
    found,
    result,
    _cb: null,
    onDidChangeResults(cb) { addon._cb = cb; return { dispose() {} }; },
    findNext(term, options) { addon.calls.push(['next', term, options]); if (addon._cb && addon.result) addon._cb(addon.result); return addon.found; },
    findPrevious(term, options) { addon.calls.push(['prev', term, options]); if (addon._cb && addon.result) addon._cb(addon.result); return addon.found; },
    clearDecorations() { addon.cleared += 1; },
  };
  return addon;
}

function setup({ addon = fakeAddon(), selection = '', styles = {} } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="panel"></div></body>');
  const win = dom.window;
  const doc = win.document;
  win.getComputedStyle = () => ({ getPropertyValue: (name) => styles[name] || '' });
  const state = { host: null, addon, focused: 0, selection };
  const makeHost = () => {
    const host = doc.createElement('div');
    host.hidden = true;
    doc.getElementById('panel').replaceChildren(host);
    state.host = host;
    return host;
  };
  makeHost();
  const find = createTerminalFind({
    windowRef: win,
    getFindHost: () => state.host,
    getThemeHost: () => doc.body,
    getSearchAddon: () => state.addon,
    getTerminal: () => ({ hasSelection: () => state.selection !== '', getSelection: () => state.selection }),
    focusTerminal: () => { state.focused += 1; },
    // The input debounce runs at once here; the bar's timing is not under test.
    timers: { setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {} },
  });
  find.syncHost();
  const input = () => state.host.querySelector('[data-ide-terminal-find-input]');
  const count = () => state.host.querySelector('[data-ide-terminal-find-count]').textContent;
  const key = (target, init) => target.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const type = (text) => { input().value = text; input().dispatchEvent(new win.Event('input', { bubbles: true })); };
  return { win, doc, state, find, input, count, key, type, makeHost, close: () => win.close() };
}

function keyEvent(init) {
  const event = { type: 'keydown', prevented: 0, preventDefault() { event.prevented += 1; }, ...init };
  return event;
}

test('the bar is built from inventory primitives with the contract classes and labelled controls', (t) => {
  const h = setup();
  t.after(h.close);
  const host = h.state.host;
  assert.equal(host.hidden, true, 'hidden until opened');
  assert.ok(host.querySelector('.ide-terminal-find__input input.inv-text-field-control'), 'text-field primitive');
  assert.ok(host.querySelector('.ide-terminal-find__count'));
  const buttons = [...host.querySelectorAll('button.ide-terminal-find__button')];
  assert.deepEqual(buttons.map((b) => b.dataset.ideTerminalFindAction), ['prev', 'next', 'close']);
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-label')), ['Previous match', 'Next match', 'Close find']);
});

test('show() opens the bar and focuses its input; Ctrl+F in the terminal does the same and is consumed', (t) => {
  const h = setup();
  t.after(h.close);
  const event = keyEvent({ key: 'f', ctrlKey: true });
  assert.equal(h.find.handleTerminalKey(event), true, 'xterm must not also handle Ctrl+F');
  assert.equal(event.prevented, 1);
  assert.equal(h.find.isOpen(), true);
  assert.equal(h.state.host.hidden, false);
  assert.equal(h.doc.activeElement, h.input());
  assert.equal(h.find.handleTerminalKey({ type: 'keyup', key: 'f', ctrlKey: true, preventDefault() {} }), true, 'the keyup of the chord is consumed too');
});

test('a one-line selection pre-fills the query and searches; a multi-line selection does not', (t) => {
  const h = setup({ selection: 'needle' });
  t.after(h.close);
  h.find.show();
  assert.equal(h.input().value, 'needle');
  assert.equal(h.state.addon.calls.length, 1);
  assert.deepEqual(h.state.addon.calls[0].slice(0, 2), ['next', 'needle']);
  const multi = setup({ selection: 'line one\nline two' });
  t.after(multi.close);
  multi.find.show();
  assert.equal(multi.input().value, '');
  assert.equal(multi.state.addon.calls.length, 0);
});

test('typing searches incrementally with decorations and shows "n of m"', (t) => {
  const h = setup({ styles: { '--ide-terminal-find-match': '#112233', '--ide-terminal-find-match-active': 'rgb(255, 0, 128)' } });
  t.after(h.close);
  h.find.show();
  h.type('foo');
  const [direction, term, options] = h.state.addon.calls[0];
  assert.equal(direction, 'next');
  assert.equal(term, 'foo');
  assert.equal(options.incremental, true);
  assert.equal(options.decorations.matchBackground, '#112233');
  assert.equal(options.decorations.activeMatchBackground, '#ff0080');
  assert.equal(h.count(), '3 of 12');
  assert.equal(h.find.getCountText(), '3 of 12');
});

test('without the colour tokens the decorations fall back to hex values', (t) => {
  const h = setup();
  t.after(h.close);
  h.find.show();
  h.type('x');
  const { decorations } = h.state.addon.calls[0][2];
  assert.match(decorations.matchBackground, /^#[0-9a-f]{6}$/);
  assert.match(decorations.activeMatchBackground, /^#[0-9a-f]{6}$/);
});

test('Enter and F3 find the next match, Shift+Enter and Shift+F3 the previous, none of them incremental', (t) => {
  const h = setup();
  t.after(h.close);
  h.find.show();
  h.type('foo');
  h.state.addon.calls.length = 0;
  h.key(h.input(), { key: 'Enter' });
  h.key(h.input(), { key: 'Enter', shiftKey: true });
  h.key(h.input(), { key: 'F3' });
  h.key(h.input(), { key: 'F3', shiftKey: true });
  assert.deepEqual(h.state.addon.calls.map((c) => c[0]), ['next', 'prev', 'next', 'prev']);
  assert.ok(h.state.addon.calls.every((c) => c[2].incremental === false));
});

test('the Previous and Next buttons search and the Close button closes', (t) => {
  const h = setup();
  t.after(h.close);
  h.find.show();
  h.type('foo');
  h.state.addon.calls.length = 0;
  h.state.host.querySelector('[data-ide-terminal-find-action="next"]').click();
  h.state.host.querySelector('[data-ide-terminal-find-action="prev"]').click();
  assert.deepEqual(h.state.addon.calls.map((c) => c[0]), ['next', 'prev']);
  h.state.host.querySelector('[data-ide-terminal-find-action="close"]').click();
  assert.equal(h.find.isOpen(), false);
  assert.equal(h.state.host.hidden, true);
});

test('F3 and Shift+F3 in the terminal search while the bar is open and are left to the shell otherwise', (t) => {
  const h = setup();
  t.after(h.close);
  assert.equal(h.find.handleTerminalKey(keyEvent({ key: 'F3' })), false, 'closed: not ours');
  h.find.show();
  h.type('foo');
  h.state.addon.calls.length = 0;
  assert.equal(h.find.handleTerminalKey(keyEvent({ key: 'F3' })), true);
  assert.equal(h.find.handleTerminalKey(keyEvent({ key: 'F3', shiftKey: true })), true);
  assert.deepEqual(h.state.addon.calls.map((c) => c[0]), ['next', 'prev']);
});

test('a miss reads "No results"', (t) => {
  const h = setup({ addon: fakeAddon({ found: false, result: null }) });
  t.after(h.close);
  h.find.show();
  h.type('nothing');
  assert.equal(h.count(), 'No results');
  h.type('');
  assert.equal(h.count(), '', 'an empty query clears the count and the decorations');
  assert.ok(h.state.addon.cleared >= 1);
});

test('Esc in the input closes the bar, clears decorations and refocuses the terminal', (t) => {
  const h = setup();
  t.after(h.close);
  h.find.show();
  h.type('foo');
  h.key(h.input(), { key: 'Escape' });
  assert.equal(h.find.isOpen(), false);
  assert.equal(h.state.host.hidden, true);
  assert.equal(h.state.addon.cleared, 1);
  assert.equal(h.state.focused, 1);
});

test('Esc in the terminal closes an open bar and is left to the shell when the bar is closed', (t) => {
  const h = setup();
  t.after(h.close);
  assert.equal(h.find.handleTerminalKey(keyEvent({ key: 'Escape' })), false);
  h.find.show();
  const event = keyEvent({ key: 'Escape' });
  assert.equal(h.find.handleTerminalKey(event), true);
  assert.equal(h.find.isOpen(), false);
  assert.equal(h.state.focused, 1);
});

test('the bar re-renders from its own state when the panel rebuilds its markup', (t) => {
  const h = setup();
  t.after(h.close);
  h.find.show();
  h.type('foo');
  const rebuilt = h.makeHost();
  assert.equal(rebuilt.hidden, true, 'a fresh host starts hidden');
  h.find.syncHost();
  assert.equal(rebuilt.hidden, false, 'the open bar comes back');
  assert.equal(h.input().value, 'foo', 'with its query');
  h.type('foobar');
  assert.deepEqual(h.state.addon.calls.at(-1).slice(0, 2), ['next', 'foobar'], 'and the new input is live');
});

test('without a search addon the bar never opens and Ctrl+F is left to the shell', (t) => {
  const h = setup({ addon: null });
  t.after(h.close);
  assert.equal(h.find.show(), false);
  assert.equal(h.find.handleTerminalKey(keyEvent({ key: 'f', ctrlKey: true })), false);
  assert.equal(h.find.isOpen(), false);
});

test('toHexColor accepts #rgb, #rrggbb and rgb() and falls back otherwise', () => {
  assert.equal(toHexColor('#abc', '#000000'), '#aabbcc');
  assert.equal(toHexColor('#ABCDEF', '#000000'), '#abcdef');
  assert.equal(toHexColor('rgb(1, 2, 3)', '#000000'), '#010203');
  assert.equal(toHexColor('rgba(255 0 0 / 0.5)', '#000000'), '#ff0000');
  assert.equal(toHexColor('red', '#123456'), '#123456');
  assert.equal(toHexColor('', '#123456'), '#123456');
});
