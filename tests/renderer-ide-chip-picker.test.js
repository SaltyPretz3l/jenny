'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeChipPicker } = require('../renderer/features/renderer-ide-chip-picker');
const popover = require('../renderer/inventory/popover');
const actionButton = require('../renderer/inventory/action-button');
const { createHarness, settle } = require('./helpers/renderer-ide-harness');

function fakeEditorHost() {
  const state = { eol: 'lf', tabCalls: [], eolCalls: [] };
  return {
    state,
    getActivePath: () => 'a.js',
    getTabSize: () => 2,
    getEol: () => state.eol,
    setTabSize: (n) => { state.tabCalls.push(n); return true; },
    setEol: (p, e) => { state.eol = e; state.eolCalls.push([p, e]); return true; },
  };
}

function buildPicker(host) {
  const dom = new JSDOM('<div id="ideShell"></div>');
  const shell = dom.window.document.getElementById('ideShell');
  const anchor = dom.window.document.createElement('button');
  shell.appendChild(anchor);
  let renders = 0;
  const changes = [];
  const picker = createIdeChipPicker({
    getDom: () => ({ ideShell: shell }),
    editorHost: host,
    getActivePath: () => 'a.js',
    actionButton,
    popover,
    onAfterChange: (change) => { renders += 1; changes.push(change); },
  });
  picker.initHandlers();
  return { picker, shell, anchor, getRenders: () => renders, changes };
}

test('chip-picker applies a tab-size pick and remembers it as the session default', () => {
  const host = fakeEditorHost();
  const { picker, shell, anchor, getRenders, changes } = buildPicker(host);

  picker.openTabSizePicker(anchor);
  const popEl = shell.querySelector('.inv-popover');
  assert.ok(popEl && !popEl.hidden, 'the tab-size quick-pick opens');
  const options = [...popEl.querySelectorAll('[data-ide-chip-value]')];
  const sizes = options.map((b) => b.getAttribute('data-ide-chip-value'));
  assert.deepEqual(sizes, ['2', '4', '8']);

  // Single-select group: the host is a menu, options are menuitemradio, and
  // exactly the current value (2) is aria-checked - not aria-pressed toggles.
  assert.equal(popEl.getAttribute('role'), 'menu', 'popover host is a menu');
  assert.ok(options.every((b) => b.getAttribute('role') === 'menuitemradio'), 'options are menuitemradio');
  assert.ok(options.every((b) => !b.hasAttribute('aria-pressed')), 'no toggle-button semantics');
  assert.deepEqual(
    options.map((b) => b.getAttribute('aria-checked')),
    ['true', 'false', 'false'],
    'only the current tab size is checked',
  );

  popEl.querySelector('[data-ide-chip-value="4"]').click();
  assert.deepEqual(host.state.tabCalls, [4]);
  assert.deepEqual(changes.at(-1), { kind: 'tab-size', value: 4 });
  assert.equal(popEl.hidden, true, 'the popover closes after a pick');
  assert.ok(getRenders() >= 1, 'onAfterChange refreshes the statusbar');
});

test('chip-picker applies an EOL pick to the active file', () => {
  const host = fakeEditorHost();
  const { picker, shell, anchor, changes } = buildPicker(host);

  picker.openEolPicker(anchor);
  const popEl = shell.querySelector('.inv-popover');
  popEl.querySelector('[data-ide-chip-value="crlf"]').click();
  assert.deepEqual(host.state.eolCalls, [['a.js', 'crlf']]);
  assert.deepEqual(changes.at(-1), { kind: 'eol', value: 'crlf' });
});

test('chip-picker applies session defaults to newly opened files', () => {
  const host = fakeEditorHost();
  const { picker, shell, anchor } = buildPicker(host);

  picker.openTabSizePicker(anchor);
  shell.querySelector('[data-ide-chip-value="8"]').click();
  picker.openEolPicker(anchor);
  shell.querySelector('[data-ide-chip-value="crlf"]').click();

  host.state.tabCalls.length = 0;
  host.state.eolCalls.length = 0;
  picker.applyDefaults('b.js');
  assert.deepEqual(host.state.tabCalls, [8]);
  assert.deepEqual(host.state.eolCalls, [['b.js', 'crlf']]);
});

test('chip-picker seedDefaults hydrates the session defaults from persisted prefs', () => {
  const host = fakeEditorHost();
  const { picker } = buildPicker(host);
  // Tier 2: persisted prefs seed the chip session defaults on activate/recreate.
  picker.seedDefaults({ tabSize: 8, eol: 'crlf' });
  assert.deepEqual(host.state.tabCalls, [8]);
  assert.deepEqual(host.state.eolCalls, [['a.js', 'crlf']]);
  // null means "leave following the file" - no host calls, no session change.
  host.state.tabCalls.length = 0;
  host.state.eolCalls.length = 0;
  picker.seedDefaults({ tabSize: null, eol: null });
  assert.deepEqual(host.state.tabCalls, []);
  assert.deepEqual(host.state.eolCalls, []);
  picker.applyDefaults('b.js');
  assert.deepEqual(host.state.tabCalls, [8]);
  assert.deepEqual(host.state.eolCalls, [['b.js', 'crlf']]);
});

test('chip-picker passes the change payload to onAfterChange for persistence', () => {
  const host = fakeEditorHost();
  const dom = new JSDOM('<div id="ideShell"></div>');
  const shell = dom.window.document.getElementById('ideShell');
  const anchor = dom.window.document.createElement('button');
  shell.appendChild(anchor);
  const changes = [];
  const picker = createIdeChipPicker({
    getDom: () => ({ ideShell: shell }),
    editorHost: host,
    getActivePath: () => 'a.js',
    actionButton,
    popover,
    onAfterChange: (change) => changes.push(change),
  });
  picker.initHandlers();
  picker.openTabSizePicker(anchor);
  shell.querySelector('[data-ide-chip-value="4"]').click();
  assert.deepEqual(changes.at(-1), { kind: 'tab-size', value: 4 });
});

test('chip-picker toggles the popover closed when the same chip is re-clicked', () => {
  const host = fakeEditorHost();
  const { picker, shell, anchor } = buildPicker(host);
  picker.openTabSizePicker(anchor);
  assert.equal(shell.querySelector('.inv-popover').hidden, false);
  picker.openTabSizePicker(anchor);
  assert.equal(shell.querySelector('.inv-popover').hidden, true);
});

// ── Integration through the controller + real statusbar/popover ──────────────

test('statusbar renders interactive tab-size and EOL chips', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'x' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();

  const statusBar = harness.getDom().ideStatusBar;
  assert.ok(statusBar.querySelector('[data-ide-status-action="tab-size"]'), 'tab-size chip is a button');
  assert.ok(statusBar.querySelector('[data-ide-status-action="eol"]'), 'EOL chip is a button');
  assert.match(statusBar.textContent, /Spaces: 2/);
  assert.match(statusBar.textContent, /LF/);
});

test('clicking the EOL chip opens a quick-pick; choosing CRLF updates the chip', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'x' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();

  harness.getDom().ideStatusBar.querySelector('[data-ide-status-action="eol"]').click();
  await settle();
  const popEl = harness.getDom().ideShell.querySelector('.inv-popover');
  assert.ok(popEl && !popEl.hidden, 'the EOL quick-pick opens in the shell');

  popEl.querySelector('[data-ide-chip-value="crlf"]').click();
  await settle();
  assert.match(harness.getDom().ideStatusBar.textContent, /CRLF/, 'the chip reflects the new EOL');
});
