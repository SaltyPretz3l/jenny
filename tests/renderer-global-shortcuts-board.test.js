// new-test-file: the Board chords are a new surface, and renderer-global-shortcuts.test.js is at 582 lines.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createGlobalShortcutsController } = require('../renderer/shell/renderer-global-shortcuts.js');

// The shortcuts controller reads the shell controller and the Board page off globalThis.
const GLOBAL_KEYS = ['rendererTopNavShellController', 'rendererBoardPage'];

function build(t, { html = '', activeView = 'chat', openBoardResult = true, toggleChatResult = true, useGlobalPage = false } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const { window } = dom;
  const doc = window.document;
  doc.documentElement.dataset.activeView = activeView;
  const calls = { openBoard: 0, toggleChat: 0, togglePanel: 0, logs: [] };
  const saved = {};
  for (const key of GLOBAL_KEYS) saved[key] = Object.prototype.hasOwnProperty.call(globalThis, key) ? globalThis[key] : undefined;
  globalThis.rendererTopNavShellController = {
    openBoardView() { calls.openBoard += 1; return openBoardResult; },
    focusActiveViewTab() {},
  };
  const page = { toggleChat() { calls.toggleChat += 1; return toggleChatResult; } };
  if (useGlobalPage) globalThis.rendererBoardPage = page;
  else window.rendererBoardPage = page;
  const controller = createGlobalShortcutsController({
    windowRef: window,
    callbacks: {
      setActiveView() {},
      togglePanel() { calls.togglePanel += 1; return true; },
      appendClientLog: (level, name, detail) => calls.logs.push([level, name, detail]),
    },
  });
  controller.bind();
  t.after(() => {
    controller.dispose();
    for (const key of GLOBAL_KEYS) {
      if (saved[key] === undefined) delete globalThis[key];
      else globalThis[key] = saved[key];
    }
    window.close();
  });
  return { window, doc, calls };
}

function press(window, init, target) {
  const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, ...init });
  (target || window).dispatchEvent(event);
  return event;
}

test('Ctrl+7 is claimed and logged only when the Board tab opened', (t) => {
  const open = build(t);
  const claimed = press(open.window, { key: '7', code: 'Digit7' });
  assert.equal(open.calls.openBoard, 1);
  assert.equal(claimed.defaultPrevented, true);
  assert.deepEqual(open.calls.logs, [['INFO', 'shortcuts.view_switch', { viewId: 'board', key: 'Ctrl+7' }]]);
});

test('Ctrl+7 with no Board tab keeps its default and logs nothing', (t) => {
  const env = build(t, { openBoardResult: false });
  const event = press(env.window, { key: '7', code: 'Digit7' });
  assert.equal(env.calls.openBoard, 1, 'the shell was asked');
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(env.calls.logs, []);
});

test('Ctrl+Alt+7 follows the same claim rule', (t) => {
  const yes = build(t);
  const claimed = press(yes.window, { key: '7', code: 'Digit7', altKey: true });
  assert.equal(claimed.defaultPrevented, true);
  assert.deepEqual(yes.calls.logs, [['INFO', 'shortcuts.view_switch', { viewId: 'board', key: 'Ctrl+Alt+7' }]]);
  const no = build(t, { openBoardResult: false });
  const left = press(no.window, { key: '7', code: 'Digit7', altKey: true });
  assert.equal(no.calls.openBoard, 1);
  assert.equal(left.defaultPrevented, false);
  assert.deepEqual(no.calls.logs, []);
});

test('Ctrl+Alt+7 stands down for AltGr and with Shift', (t) => {
  const env = build(t);
  const altGr = new env.window.KeyboardEvent('keydown', { key: '7', code: 'Digit7', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  altGr.getModifierState = (name) => name === 'AltGraph';
  env.window.dispatchEvent(altGr);
  const shifted = press(env.window, { key: '7', code: 'Digit7', altKey: true, shiftKey: true });
  assert.equal(env.calls.openBoard, 0);
  assert.equal(altGr.defaultPrevented, false);
  assert.equal(shifted.defaultPrevented, false);
});

test('plain Ctrl+7 inside the Workspace view is left to the IDE keymap', (t) => {
  const env = build(t, { html: '<div id="ideView"><button id="inIde">x</button></div>' });
  const event = press(env.window, { key: '7', code: 'Digit7' }, env.doc.getElementById('inIde'));
  assert.equal(env.calls.openBoard, 0);
  assert.equal(event.defaultPrevented, false);
});

test('Ctrl+Alt+7 still opens the Board from inside the Workspace view', (t) => {
  const env = build(t, { html: '<div id="ideView"><button id="inIde">x</button></div>' });
  const event = press(env.window, { key: '7', code: 'Digit7', altKey: true }, env.doc.getElementById('inIde'));
  assert.equal(env.calls.openBoard, 1);
  assert.equal(event.defaultPrevented, true);
});

test('plain Ctrl+7 from a text field is not handled', (t) => {
  const env = build(t, { html: '<textarea id="field"></textarea>' });
  env.doc.getElementById('field').focus();
  const event = press(env.window, { key: '7', code: 'Digit7' }, env.doc.getElementById('field'));
  assert.equal(env.calls.openBoard, 0);
  assert.equal(event.defaultPrevented, false);
});

test('Ctrl+Alt+B on the Board toggles the chat column and claims the key', (t) => {
  const env = build(t, { activeView: 'board' });
  const event = press(env.window, { key: 'b', code: 'KeyB', altKey: true });
  assert.equal(env.calls.toggleChat, 1);
  assert.equal(event.defaultPrevented, true);
  assert.equal(env.calls.logs.some((entry) => entry[1] === 'shortcuts.board_chat_toggle'), true);
  assert.equal(env.calls.togglePanel, 0, 'the panel toggle is not Ctrl+Alt+B');
});

test('Ctrl+Alt+B finds the Board page on the shared global too', (t) => {
  const env = build(t, { activeView: 'board', useGlobalPage: true });
  const event = press(env.window, { key: 'b', code: 'KeyB', altKey: true });
  assert.equal(env.calls.toggleChat, 1);
  assert.equal(event.defaultPrevented, true);
});

test('Ctrl+Alt+B is not claimed when the Board page did not toggle', (t) => {
  const env = build(t, { activeView: 'board', toggleChatResult: false });
  const event = press(env.window, { key: 'b', code: 'KeyB', altKey: true });
  assert.equal(env.calls.toggleChat, 1);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(env.calls.logs, []);
});

test('Ctrl+Alt+B outside the Board is left alone', (t) => {
  const chat = build(t, { activeView: 'chat' });
  const chatEvent = press(chat.window, { key: 'b', code: 'KeyB', altKey: true });
  assert.equal(chat.calls.toggleChat, 0);
  assert.equal(chatEvent.defaultPrevented, false);
  const ide = build(t, { activeView: 'board', html: '<div id="ideView"><button id="inIde">x</button></div>' });
  const ideEvent = press(ide.window, { key: 'b', code: 'KeyB', altKey: true }, ide.doc.getElementById('inIde'));
  assert.equal(ide.calls.toggleChat, 0);
  assert.equal(ideEvent.defaultPrevented, false);
});

test('Ctrl+Alt+B from a foreign text field on the Board is not handled', (t) => {
  const env = build(t, { activeView: 'board', html: '<input id="field" type="text">' });
  env.doc.getElementById('field').focus();
  const event = press(env.window, { key: 'b', code: 'KeyB', altKey: true }, env.doc.getElementById('field'));
  assert.equal(env.calls.toggleChat, 0);
  assert.equal(event.defaultPrevented, false);
});

test('Ctrl+Alt+B ignores auto-repeat after the first toggle', (t) => {
  const env = build(t, { activeView: 'board' });
  press(env.window, { key: 'b', code: 'KeyB', altKey: true });
  const repeat = press(env.window, { key: 'b', code: 'KeyB', altKey: true, repeat: true });
  assert.equal(env.calls.toggleChat, 1);
  assert.equal(repeat.defaultPrevented, true, 'the held key is still kept from the page');
});

test('Ctrl+B with the Board active reaches the panel toggle callback', (t) => {
  const env = build(t, { activeView: 'board' });
  const event = press(env.window, { key: 'b', code: 'KeyB' });
  assert.equal(env.calls.togglePanel, 1);
  assert.equal(event.defaultPrevented, true);
});
