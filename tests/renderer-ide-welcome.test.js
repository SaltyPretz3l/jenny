'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, settle } = require('./helpers/renderer-ide-harness');
const { buildIdeShortcutsHtml, IDE_SHORTCUTS } = require('../renderer/features/renderer-ide-shortcuts');
const { createChooseWorkspaceRoot, createIdeWelcome } = require('../renderer/features/renderer-ide-welcome');

function ctrlF4(harness) {
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'F4',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }));
}

test('shortcuts catalog: builds sections with kbd chiclets and reopen binding', () => {
  const html = buildIdeShortcutsHtml();
  assert.ok(IDE_SHORTCUTS.length >= 3, 'expected at least three shortcut sections');
  assert.match(html, /chat-help-overlay-section/);
  assert.match(html, /<kbd class="chat-help-overlay-kbd">Ctrl<\/kbd>/);
  assert.match(html, /Reopen the last closed tab/);
  assert.match(html, /Open the command palette/);
  // No raw primitives leak through — kbd/dl/section only.
  assert.doesNotMatch(html, /<button|<input/);
});

test('welcome cold open: cheat-sheet + open-different-folder render, no recent files', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one' } },
  });
  t.after(() => harness.dispose());

  await harness.controller.activateIde();
  await settle();

  const extra = harness.getDom().ideEmptyState.querySelector('[data-ide-welcome-extra]');
  assert.ok(extra, 'expected the welcome surface to render into #ideEmptyState');
  assert.match(extra.textContent, /Keyboard shortcuts/);
  assert.match(extra.innerHTML, /chat-help-overlay-kbd/);
  // A configured root hides the primary #ideEmptyStateAction CTA, so the
  // welcome surface offers a secondary "open a different folder" affordance.
  assert.ok(extra.querySelector('[data-ide-welcome-choose-root]'));
  // Nothing has been opened yet, so there are no recent files.
  assert.equal(extra.querySelector('[data-ide-welcome-file]'), null);
});

test('welcome lists recently opened files (most-recent first) and reopens on click', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one', 'src/b.js': 'two' } },
  });
  t.after(() => harness.dispose());

  await harness.controller.activateIde();
  await settle();
  await harness.controller.openFile('a.js');
  await harness.controller.openFile('src/b.js');
  await settle();

  // Close both tabs (Ctrl+F4 routes through the controller close path); the
  // second close lands on the empty editor and re-renders the welcome surface.
  ctrlF4(harness);
  await settle();
  ctrlF4(harness);
  await settle();

  const extra = harness.getDom().ideEmptyState.querySelector('[data-ide-welcome-extra]');
  const items = [...extra.querySelectorAll('[data-ide-welcome-file]')];
  assert.deepEqual(
    items.map((el) => el.getAttribute('data-ide-welcome-file')),
    ['src/b.js', 'a.js'],
    'most-recently opened file should sort first'
  );
  // The nested path splits into a basename + directory chip.
  assert.match(items[0].innerHTML, /ide-welcome-recent-name">b\.js</);
  assert.match(items[0].innerHTML, /ide-welcome-recent-dir">src</);

  const readsBefore = harness.bridge.calls.readFile.length;
  items[1].click();
  await settle();

  assert.equal(harness.state.ui.ide.activeTabPath, 'a.js', 'clicking a recent file reopens it');
  assert.ok(
    harness.bridge.calls.readFile.length > readsBefore,
    'reopening a closed file re-reads it from disk'
  );
});

test('welcome: open-a-different-folder triggers the workspace root chooser', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one' } },
  });
  t.after(() => harness.dispose());

  await harness.controller.activateIde();
  await settle();

  const extra = harness.getDom().ideEmptyState.querySelector('[data-ide-welcome-extra]');
  extra.querySelector('[data-ide-welcome-choose-root]').click();
  await settle();

  assert.equal(harness.bridge.calls.chooseRoot.length, 1);
});

test('welcome preserves the no-root copy + Choose Folder action contract', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: '', files: { 'a.js': 'one' } },
  });
  t.after(() => harness.dispose());

  await harness.controller.activateIde();
  await settle();

  const dom = harness.getDom();
  assert.equal(
    dom.ideEmptyStateCopy.textContent,
    'Choose a workspace folder to start editing files.'
  );
  const action = dom.ideEmptyStateAction.querySelector('[data-ide-choose-root]');
  assert.ok(action, 'no-root state still offers the primary Choose Folder button');
  assert.equal(dom.ideEmptyStateAction.classList.contains('hidden'), false);

  action.click();
  await settle();
  assert.equal(harness.bridge.calls.chooseRoot.length, 1);
});

test('a stale asynchronous root lookup cannot overwrite a newer explicit welcome render', async () => {
  let resolveRootState;
  const copy = { textContent: '' };
  const action = { innerHTML: '', classList: { toggle() {} } };
  const welcome = createIdeWelcome({
    getDom: () => ({ ideEmptyStateCopy: copy, ideEmptyStateAction: action }),
    getFsApi: () => ({
      getRootState: () => new Promise((resolve) => { resolveRootState = resolve; }),
    }),
    actionButton: () => '<button>choose</button>',
  });

  const staleRender = welcome.render();
  await welcome.render({ hasRoot: true });
  const currentCopy = copy.textContent;
  resolveRootState({ workspaceRoot: null });
  await staleRender;

  assert.match(currentCopy, /Open a file from the explorer/);
  assert.equal(copy.textContent, currentCopy, 'the older root lookup cannot repaint the welcome copy');
  welcome.dispose();
});

// The helper is now a thin adapter over the shell-owned root transaction.

function buildChooseDeps(overrides = {}) {
  const toasts = [];
  const chooseCalls = [];
  const api = {
    choose: async (...args) => {
      chooseCalls.push(args);
      return { committed: true, changed: true };
    },
  };
  const deps = {
    getWorkspaceRootApi: () => api,
    showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
    ...overrides,
  };
  return { deps, toasts, chooseCalls, api };
}

test('chooseWorkspaceRoot delegates to the shared transaction facade', async () => {
  const { deps, toasts, chooseCalls } = buildChooseDeps();
  const chooseWorkspaceRoot = createChooseWorkspaceRoot(deps);

  const result = await chooseWorkspaceRoot();

  assert.equal(result, true);
  assert.equal(chooseCalls.length, 1);
  assert.equal(toasts.length, 0);
});

test('chooseWorkspaceRoot treats a blocked transaction as unsuccessful without duplicate feedback', async () => {
  const { deps, toasts } = buildChooseDeps({
    getWorkspaceRootApi: () => ({
      choose: async () => ({ blocked: true, blockedReason: 'terminal_active', changed: false, canceled: false }),
    }),
  });
  const chooseWorkspaceRoot = createChooseWorkspaceRoot(deps);

  const result = await chooseWorkspaceRoot();

  assert.equal(result, false);
  assert.equal(toasts.length, 0, 'the shared transaction owner already reports the failure');
});

test('welcome keeps the primary action above a collapsed shortcut catalog (GUI finding 2026-07-20)', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one' } },
  });
  t.after(() => harness.dispose());

  await harness.controller.activateIde();
  await settle();

  const extra = harness.getDom().ideEmptyState.querySelector('[data-ide-welcome-extra]');
  const shortcuts = extra.querySelector('.ide-welcome-shortcuts');
  assert.equal(String(shortcuts.tagName).toLowerCase(), 'details', 'catalog is a native disclosure');
  assert.equal(shortcuts.hasAttribute('open'), false, 'catalog starts collapsed');
  assert.equal(
    String(shortcuts.querySelector('summary.ide-welcome-heading').textContent).trim(),
    'Keyboard shortcuts'
  );
  const chooseRoot = extra.querySelector('[data-ide-welcome-choose-root]');
  assert.ok(chooseRoot, 'secondary open-a-folder CTA still renders');
  assert.ok(
    chooseRoot.compareDocumentPosition(shortcuts) & 4,
    'the actionable CTA precedes the shortcut catalog in document order'
  );
});
