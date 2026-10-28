'use strict';

/* Row 82 T1: copy/paste chords and the right-click menu of the Workspace PTY terminal. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createTerminalClipboard } = require('../renderer/features/renderer-ide-terminal-clipboard');
const contextMenu = require('../renderer/inventory/context-menu');

function fakeTerm(selection = '') {
  const term = {
    selection,
    pasted: [],
    selectedAll: 0,
    hasSelection: () => term.selection !== '',
    getSelection: () => term.selection,
    clearSelection: () => { term.selection = ''; },
    selectAll: () => { term.selectedAll += 1; },
    paste: (text) => { term.pasted.push(text); },
  };
  return term;
}

function setup({ selection = '', shell = true, clipboardText = 'pasted text' } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>');
  const win = dom.window;
  const term = fakeTerm(selection);
  const written = [];
  const writer = { writeText: (text) => { written.push(text); return Promise.resolve(); }, readText: () => Promise.resolve(clipboardText) };
  if (shell) {
    win.jennyShell = { clipboard: writer };
  } else {
    Object.defineProperty(win.navigator, 'clipboard', { value: writer, configurable: true });
  }
  const calls = { clear: 0 };
  const clipboard = createTerminalClipboard({ windowRef: win, getTerminal: () => term, onClear: () => { calls.clear += 1; } });
  const mount = win.document.getElementById('mount');
  const unbind = clipboard.bindContextMenu(mount);
  return {
    win, term, written, calls, clipboard, mount, unbind,
    close: () => { contextMenu.hide(); win.close(); },
  };
}

function chord(init) {
  const event = { type: 'keydown', prevented: 0, preventDefault() { event.prevented += 1; }, ...init };
  return event;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('Ctrl+Shift+C copies the selection and consumes the chord (keydown, keypress and keyup)', async (t) => {
  const h = setup({ selection: 'hello' });
  t.after(h.close);
  const down = chord({ key: 'C', ctrlKey: true, shiftKey: true });
  assert.equal(h.clipboard.handleTerminalKey(down), true);
  assert.equal(down.prevented, 1);
  assert.deepEqual(h.written, ['hello']);
  assert.equal(h.term.selection, 'hello', 'Ctrl+Shift+C keeps the selection');
  assert.equal(h.clipboard.handleTerminalKey(chord({ type: 'keypress', key: 'C', ctrlKey: true, shiftKey: true })), true);
  assert.equal(h.clipboard.handleTerminalKey(chord({ type: 'keyup', key: 'C', ctrlKey: true, shiftKey: true })), true);
  assert.equal(h.clipboard.handleTerminalKey(chord({ type: 'keyup', key: 'C', ctrlKey: true, shiftKey: true })), false, 'the swallow ends with the keyup');
});

test('Ctrl+Shift+C with no selection writes nothing but is still consumed', (t) => {
  const h = setup();
  t.after(h.close);
  assert.equal(h.clipboard.handleTerminalKey(chord({ key: 'C', ctrlKey: true, shiftKey: true })), true);
  assert.deepEqual(h.written, []);
});

test('Ctrl+C with a selection copies and clears it instead of sending ^C', (t) => {
  const h = setup({ selection: 'abc' });
  t.after(h.close);
  const down = chord({ key: 'c', ctrlKey: true });
  assert.equal(h.clipboard.handleTerminalKey(down), true, 'xterm must not send ^C');
  assert.deepEqual(h.written, ['abc']);
  assert.equal(h.term.selection, '', 'the selection is cleared');
  assert.equal(h.clipboard.handleTerminalKey(chord({ type: 'keyup', key: 'c', ctrlKey: true })), true, 'its keyup is swallowed too');
});

test('Ctrl+C without a selection is left to the shell (^C)', (t) => {
  const h = setup();
  t.after(h.close);
  const down = chord({ key: 'c', ctrlKey: true });
  assert.equal(h.clipboard.handleTerminalKey(down), false);
  assert.equal(down.prevented, 0);
  assert.deepEqual(h.written, []);
});

test('Ctrl+V and Ctrl+Shift+V paste the clipboard through term.paste and prevent the browser paste', async (t) => {
  const h = setup();
  t.after(h.close);
  const plain = chord({ key: 'v', ctrlKey: true });
  assert.equal(h.clipboard.handleTerminalKey(plain), true);
  assert.equal(plain.prevented, 1, 'the browser must not paste a second time');
  await flush();
  assert.deepEqual(h.term.pasted, ['pasted text']);
  const shifted = chord({ key: 'V', ctrlKey: true, shiftKey: true });
  assert.equal(h.clipboard.handleTerminalKey(shifted), true);
  await flush();
  assert.deepEqual(h.term.pasted, ['pasted text', 'pasted text']);
});

test('an empty clipboard pastes nothing', async (t) => {
  const h = setup({ clipboardText: '' });
  t.after(h.close);
  h.clipboard.handleTerminalKey(chord({ key: 'v', ctrlKey: true }));
  await flush();
  assert.deepEqual(h.term.pasted, []);
});

test('every other key, including a bare c or v and Alt chords, stays with xterm', (t) => {
  const h = setup({ selection: 'abc' });
  t.after(h.close);
  for (const init of [{ key: 'c' }, { key: 'v' }, { key: 'a', ctrlKey: true }, { key: 'c', ctrlKey: true, altKey: true }, { key: 'Enter' }]) {
    assert.equal(h.clipboard.handleTerminalKey(chord(init)), false, JSON.stringify(init));
  }
  assert.deepEqual(h.written, []);
  assert.equal(h.term.selection, 'abc');
});

test('a lost keyup never makes a later plain keypress of the same letter vanish', (t) => {
  const h = setup({ selection: 'abc' });
  t.after(h.close);
  assert.equal(h.clipboard.handleTerminalKey(chord({ key: 'c', ctrlKey: true })), true);
  assert.equal(h.clipboard.handleTerminalKey(chord({ type: 'keypress', key: 'c' })), false, 'no modifier: the shell gets it');
});

test('the clipboard falls back to navigator.clipboard when the shell bridge is absent', async (t) => {
  const h = setup({ selection: 'nav', shell: false });
  t.after(h.close);
  h.clipboard.handleTerminalKey(chord({ key: 'C', ctrlKey: true, shiftKey: true }));
  h.clipboard.handleTerminalKey(chord({ key: 'v', ctrlKey: true }));
  await flush();
  assert.deepEqual(h.written, ['nav']);
  assert.deepEqual(h.term.pasted, ['pasted text']);
});

test('right-click opens the menu with Copy, Paste, Clear and Select All', (t) => {
  const h = setup({ selection: 'abc' });
  t.after(h.close);
  const event = new h.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 20 });
  h.mount.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'the native menu is suppressed');
  const items = [...h.win.document.querySelectorAll('.inv-context-menu .inv-context-menu-item')];
  assert.deepEqual(items.map((el) => el.querySelector('span').textContent), ['Copy', 'Paste', 'Clear', 'Select All']);
  assert.equal(items[0].disabled, false);
});

test('Copy is disabled without a selection', (t) => {
  const h = setup();
  t.after(h.close);
  h.mount.dispatchEvent(new h.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const items = [...h.win.document.querySelectorAll('.inv-context-menu .inv-context-menu-item')];
  assert.equal(items[0].disabled, true);
  assert.equal(items[1].disabled, false);
});

test('the menu items copy, paste, clear and select all', async (t) => {
  const h = setup({ selection: 'abc' });
  t.after(h.close);
  const open = () => h.mount.dispatchEvent(new h.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const item = (index) => [...h.win.document.querySelectorAll('.inv-context-menu .inv-context-menu-item')][index];
  open(); item(0).click();
  assert.deepEqual(h.written, ['abc']);
  open(); item(1).click();
  await flush();
  assert.deepEqual(h.term.pasted, ['pasted text']);
  open(); item(2).click();
  assert.equal(h.calls.clear, 1, 'Clear runs the panel callback');
  open(); item(3).click();
  assert.equal(h.term.selectedAll, 1);
  assert.equal(h.win.document.querySelector('.inv-context-menu'), null, 'a picked item dismisses the menu');
});

test('unbinding removes the right-click handler', (t) => {
  const h = setup();
  t.after(h.close);
  h.unbind();
  const event = new h.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  h.mount.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.win.document.querySelector('.inv-context-menu'), null);
});
