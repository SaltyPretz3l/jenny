'use strict';

/* The Workspace New Terminal command (palette row + Ctrl+Shift+`): offered only while the
 * terminal header's + is, running the same create path (renderer-ide-commands). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeCommands,
  createViewKeydownHandler,
} = require('../renderer/features/renderer-ide-commands');
const { createHarness, settle } = require('./helpers/renderer-ide-harness');

function buildCommands(overrides) {
  const commands = createIdeCommands({
    getActiveView: () => 'ide',
    editorHost: { runAction: () => true, toggleMinimap: () => false },
    ...overrides,
  });
  return { commands };
}

function fakeKeyEvent(key, mods = {}) {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
}

test('New Terminal is a palette row only while its layout action is offered', () => {
  let offered = true;
  const runs = [];
  const { commands } = buildCommands({
    layoutActions: { get newTerminal() { return offered ? () => { runs.push(true); } : undefined; } },
  });
  const row = commands.getCommandItems().find((i) => i.id === 'ide:new-terminal');
  assert.ok(row, 'listed while a terminal can be added');
  assert.equal(row.label, 'New Terminal');
  assert.equal(row.hint, 'Ctrl+Shift+`');
  assert.equal(row.group, 'Workspace');
  row.run();
  assert.deepEqual(runs, [true], 'run() goes through the wired create path');

  offered = false;
  assert.equal(commands.getCommandItems().some((i) => i.id === 'ide:new-terminal'), false, 'hidden at the cap / without terminals');
});

test('Ctrl+Shift+Backquote opens a new terminal; Ctrl+Backquote stays Toggle Panel', () => {
  const calls = { newTerminal: 0, toggle: 0 };
  const handler = createViewKeydownHandler({
    state: { ui: { activeView: 'ide' } },
    bottomPanel: { toggle: () => { calls.toggle += 1; } },
    newTerminal: () => { calls.newTerminal += 1; },
  });
  const chord = fakeKeyEvent('~', { ctrl: true, shift: true });
  chord.code = 'Backquote';
  handler(chord);
  assert.equal(calls.newTerminal, 1);
  assert.equal(chord.defaultPrevented, true);
  assert.equal(calls.toggle, 0, 'the shifted chord does not toggle the panel');

  handler(fakeKeyEvent('`', { ctrl: true }));
  assert.deepEqual(calls, { newTerminal: 1, toggle: 1 }, 'plain Ctrl+` keeps toggling the panel');

  const withAlt = fakeKeyEvent('~', { ctrl: true, shift: true, alt: true });
  withAlt.code = 'Backquote';
  handler(withAlt);
  assert.equal(calls.newTerminal, 1, 'Ctrl+Alt+Shift+` is not bound');
});

test('the New Terminal palette command adds and reveals a terminal like the + control, until the cap', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'x' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const q = (sel) => doc.querySelector(`#ideWorkbench ${sel}`);
  const row = () => harness.controller.getIdeCommandItems().find((i) => i.id === 'ide:new-terminal');

  assert.equal(q('[data-wb-tab="terminal-2"]'), null, 'one terminal to start');
  assert.ok(row(), 'the palette lists New Terminal');
  row().run();
  await settle();
  const tab = q('[data-wb-tab="terminal-2"]');
  assert.ok(tab, 'Terminal 2 joins the stack');
  assert.equal(tab.getAttribute('aria-selected'), 'true', 'and is revealed as the active tab');

  row().run();
  await settle();
  row().run();
  await settle();
  assert.ok(q('[data-wb-tab="terminal-4"]'), 'four terminals are open');
  assert.equal(row(), undefined, 'gone at the cap, like the + control');
  assert.equal(q('[data-wb-action="view:new-terminal"]'), null, 'the + control is gone too');

  // Ctrl+Shift+` runs the same path once a slot is free again.
  q('[data-wb-tab="terminal-4"]').dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  q('[data-wb-action="view:kill-terminal"]').dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(q('[data-wb-tab="terminal-4"]'), null, 'a slot is free again');
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  await settle();
  assert.ok(q('[data-wb-tab="terminal-4"]'), 'Ctrl+Shift+` opened the next terminal');
});
