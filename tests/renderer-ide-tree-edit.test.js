'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const { validateEntryName } = require('../renderer/features/renderer-ide-tree-edit');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

async function createHarness({ files = {}, dirs = [], failRename = false, qol = true } = {}) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files, dirs, failRename });
  const ide = ideStateUtils.createIdeUiState();
  const toasts = [];
  const renamed = [];
  const tree = createIdeTree({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getMountEl: () => domHarness.getDom().ideRailPanel,
    isActivePanel: () => true,
    isQolEnabled: () => qol,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    getMutationContext: async () => ({ rootId: 'root-test', generation: 1, phase: 'ready' }),
    preflightMutation: async () => ({ ready: true, paths: [] }),
    commitMutationPreflight: () => ({ committed: true }),
    cancelMutationPreflight: () => {},
    showError: (message, meta) => toasts.push({ message, meta }),
    onEntryRenamed: (...args) => renamed.push(args),
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(30);
  return {
    ...domHarness,
    bridge,
    ide,
    tree,
    toasts,
    renamed,
    panel: domHarness.getDom().ideRailPanel,
    dispose() {
      tree.dispose();
      domHarness.dom.window.close();
    },
  };
}

function getRow(harness, path) {
  const row = harness.panel.querySelector(`[data-ide-tree-path="${path}"]`);
  assert.ok(row, `missing tree row ${path}`);
  return row;
}

function findMenuItem(harness, label) {
  return [...harness.dom.window.document.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.textContent.includes(label)) || null;
}

function openContextMenu(harness, path) {
  getRow(harness, path).dispatchEvent(new harness.dom.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 12,
    clientY: 24,
  }));
}

function beginRename(harness, path) {
  openContextMenu(harness, path);
  const rename = findMenuItem(harness, 'Rename');
  assert.ok(rename, 'missing Rename menu item');
  rename.click();
  const input = harness.panel.querySelector('[data-ide-tree-edit-control]');
  assert.ok(input, 'rename input did not open');
  return input;
}

function setInput(harness, input, value) {
  input.value = value;
  input.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

function pressKey(harness, target, key) {
  target.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  }));
}

test('blur with a valid changed name commits exactly once and closes the editor', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'other.js': 'b' } });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  setInput(harness, input, 'renamed.js');

  getRow(harness, 'other.js').focus();
  assert.equal(harness.bridge.calls.rename.length, 0, 'blur commit must be deferred');
  await settle(80);

  assert.deepEqual(harness.bridge.calls.rename, [{
    from: 'alpha.js', to: 'renamed.js', expectedGeneration: 1,
  }]);
  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]'), null);
});

test('blur with an invalid name preserves the unfocused draft and inline error', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'other.js': 'b' } });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  setInput(harness, input, 'bad:name.js');

  const other = getRow(harness, 'other.js');
  other.focus();
  await settle(20);

  const retained = harness.panel.querySelector('[data-ide-tree-edit-control]');
  assert.ok(retained);
  assert.notEqual(harness.dom.window.document.activeElement, retained);
  assert.equal(retained.value, 'bad:name.js');
  assert.match(harness.panel.querySelector('.ide-tree-edit-error')?.textContent || '', /can't contain/);
  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.deepEqual(harness.toasts, []);
});

test('blur with an unchanged name quietly cancels', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'other.js': 'b' } });
  t.after(() => harness.dispose());
  beginRename(harness, 'alpha.js');

  getRow(harness, 'other.js').focus();
  await settle(20);

  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]'), null);
  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.deepEqual(harness.toasts, []);
});

test('context menu focus theft defers but does not discard a valid rename', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'other.js': 'b' } });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  setInput(harness, input, 'renamed.js');

  openContextMenu(harness, 'other.js');
  assert.equal(harness.bridge.calls.rename.length, 0,
    'rename ran synchronously inside contextmenu dispatch');
  assert.ok(findMenuItem(harness, 'Rename'));
  await settle(80);

  assert.equal(harness.bridge.calls.rename.length, 1);
  assert.ok(harness.panel.querySelector('[data-ide-tree-path="renamed.js"]'));
  assert.ok(findMenuItem(harness, 'Rename'), 'the unrelated context menu was corrupted');
});

test('a queued blur commit uses its captured edit while a second rename survives', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'beta.js': 'b' } });
  t.after(() => harness.dispose());
  const first = beginRename(harness, 'alpha.js');
  setInput(harness, first, 'renamed.js');

  openContextMenu(harness, 'beta.js');
  assert.equal(harness.bridge.calls.rename.length, 0);
  findMenuItem(harness, 'Rename').click();
  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]')?.value, 'beta.js');
  await settle(80);

  assert.deepEqual(harness.bridge.calls.rename, [{
    from: 'alpha.js', to: 'renamed.js', expectedGeneration: 1,
  }]);
  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]')?.value, 'beta.js');
  assert.ok(harness.panel.querySelector('[data-ide-tree-path="renamed.js"]'));
});

test('Enter blocks an invalid name without a toast or bridge call', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a' } });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  input.value = 'nested/name.js';

  pressKey(harness, input, 'Enter');
  await settle(20);

  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.deepEqual(harness.toasts, []);
  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]')?.value, 'nested/name.js');
  assert.ok(harness.panel.querySelector('.ide-tree-edit-error'));
});

test('Escape cancels a queued blur commit', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'other.js': 'b' } });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  setInput(harness, input, 'renamed.js');

  getRow(harness, 'other.js').focus();
  pressKey(harness, input, 'Escape');
  await settle(40);

  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]'), null);
});

test('rename failure retains the editor and paints the server message beside the toast', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a' }, failRename: true });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  setInput(harness, input, 'renamed.js');

  pressKey(harness, input, 'Enter');
  await settle(50);

  assert.equal(harness.bridge.calls.rename.length, 1);
  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]')?.value, 'renamed.js');
  assert.equal(harness.toasts.at(-1)?.message, 'rename refused');
  assert.equal(harness.panel.querySelector('.ide-tree-edit-error')?.textContent, 'rename refused');
});

test('F2 stem selection applies once while a re-render preserves draft and error', async (t) => {
  const harness = await createHarness({ files: { 'report.xlsx': 'a', 'other.js': 'b' } });
  t.after(() => harness.dispose());
  let row = getRow(harness, 'report.xlsx');
  row.dispatchEvent(new harness.dom.window.MouseEvent('click', {
    bubbles: true, cancelable: true, ctrlKey: true,
  }));
  row = getRow(harness, 'report.xlsx');
  pressKey(harness, row, 'F2');
  let input = harness.panel.querySelector('[data-ide-tree-edit-control]');
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 'report'.length);
  setInput(harness, input, 'bad:name.xlsx');

  harness.tree.selection.replace(['other.js'], 'other.js');
  harness.tree.syncSelection();
  input = harness.panel.querySelector('[data-ide-tree-edit-control]');

  assert.equal(input.value, 'bad:name.xlsx');
  assert.ok(harness.panel.querySelector('.ide-tree-edit-error'));
  assert.notEqual(input.selectionEnd, 'report'.length, 'the stem was selected a second time');
});

test('validateEntryName applies ordered platform and collision rules', () => {
  const invalidRows = [
    ['', 'Enter a name.'],
    ['.', 'A name can\'t be "." or "..".'],
    ['foo:bar', 'A name can\'t contain any of: \\ / : * ? " < > |'],
    ['CON', '"CON" is a reserved name in Windows.'],
    ['con.txt', '"con.txt" is a reserved name in Windows.'],
    ['lpt9.log', '"lpt9.log" is a reserved name in Windows.'],
    ['evil.', 'A name can\'t end with a space or a period.'],
    ['evil ', 'A name can\'t end with a space or a period.'],
    ['x'.repeat(256), 'That name is too long (255 characters max).'],
  ];
  for (const [name, message] of invalidRows) {
    assert.deepEqual(validateEntryName(name, {}), { ok: false, message }, name || '<empty>');
  }
  for (const name of ['COM0', 'COM10', 'console.log', 'report (2).xlsx', '.env']) {
    assert.deepEqual(validateEntryName(name, {}), { ok: true }, name);
  }
  assert.deepEqual(validateEntryName('readme.md', {
    siblings: ['README.md'], isWin32: true,
  }), {
    ok: false,
    message: 'A file or folder named "readme.md" already exists here.',
  });
  assert.deepEqual(validateEntryName('readme.md', {
    siblings: ['README.md'], isWin32: false,
  }), { ok: true });
  assert.deepEqual(validateEntryName('README.md', {
    siblings: ['README.md', 'other.js'], currentName: 'README.md', isWin32: true,
  }), { ok: true });
});

test('flag off keeps legacy blur cancellation and input-inert markup', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'other.js': 'b' }, qol: false });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  const legacyMarkup = harness.panel.innerHTML;
  input.value = 'bad:name.js';
  input.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));

  assert.equal(harness.panel.innerHTML, legacyMarkup);
  assert.equal(harness.panel.querySelector('.ide-tree-edit-error'), null);
  assert.equal(input.hasAttribute('aria-invalid'), false);
  getRow(harness, 'other.js').focus();
  await settle(20);

  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]'), null);
  assert.deepEqual(harness.bridge.calls.rename, []);
});

test('a re-render while a blur-held invalid edit row is open does not steal focus', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'other.js': 'b' } });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  setInput(harness, input, 'bad:name.js');
  getRow(harness, 'other.js').focus();
  await settle(20);

  // Force a markup-changing render (selection change) with focus outside the input.
  harness.tree.selection.replace(['other.js'], 'other.js');
  harness.tree.syncSelection();
  await settle(20);

  const retained = harness.panel.querySelector('[data-ide-tree-edit-control]');
  assert.ok(retained, 'edit row must survive the re-render');
  assert.notEqual(harness.dom.window.document.activeElement, retained,
    'a background re-render must not focus the held-open edit input');
  assert.equal(retained.value, 'bad:name.js');
  assert.ok(harness.panel.querySelector('.ide-tree-edit-error'));
});

test('a deferred no-op blur commit does not cancel a second row\'s fresh editor', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'beta.js': 'b' } });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  // Leading space passes live validation but trims back to the original name,
  // so the queued blur commit resolves to a no-op cancel.
  setInput(harness, input, ' alpha.js');

  // Right-click beta.js (menu steals focus -> queues alpha's blur commit),
  // then open beta's rename editor synchronously before the timer fires.
  const betaInput = beginRename(harness, 'beta.js');
  assert.ok(betaInput, 'beta rename editor opened');
  await settle(80);

  const retained = harness.panel.querySelector('[data-ide-tree-edit-control]');
  assert.ok(retained, 'beta rename editor must survive the no-op commit');
  assert.deepEqual(harness.bridge.calls.rename, []);
});
