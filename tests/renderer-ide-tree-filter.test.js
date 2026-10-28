'use strict';

// Files-header filter: hides non-matching rows among the loaded, expanded rows
// (keeping ancestors of matches), highlights hits, Esc clears, Ctrl+F opens it.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

async function createHarness({ files, expanded = ['src'] }) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files });
  const ide = ideStateUtils.createIdeUiState();
  ide.expandedDirs = new Set(expanded);
  const tree = createIdeTree({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getMountEl: () => domHarness.getDom().ideRailPanel,
    isActivePanel: () => true,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(30);
  const panel = domHarness.getDom().ideRailPanel;
  return {
    ...domHarness, bridge, ide, tree, panel,
    paths: () => [...panel.querySelectorAll('[data-ide-tree-path]')].map((row) => row.dataset.ideTreePath),
    toggle: () => panel.querySelector('[data-ide-tree-action="toggle-filter"]').click(),
    input: () => panel.querySelector('.chat-search-bar-input'),
    async type(value) {
      const input = panel.querySelector('.chat-search-bar-input');
      input.value = value;
      input.dispatchEvent(new domHarness.dom.window.Event('input', { bubbles: true }));
      await settle(200);
    },
    key(target, key, options = {}) {
      const event = new domHarness.dom.window.KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true, ...options,
      });
      target.dispatchEvent(event);
      return event;
    },
    dispose() {
      tree.dispose();
      domHarness.dom.window.close();
    },
  };
}

const FILES = { 'src/app.js': 'a', 'src/util.js': 'u', 'README.md': 'r' };

test('filter query keeps matching files and their expanded ancestors only', async (t) => {
  const h = await createHarness({ files: FILES });
  t.after(() => h.dispose());
  assert.deepEqual(h.paths().sort(), ['README.md', 'src', 'src/app.js', 'src/util.js']);

  h.toggle();
  assert.ok(h.input(), 'the filter bar mounts under the header');
  await h.type('app');

  assert.deepEqual(h.paths().sort(), ['src', 'src/app.js']);
  const hit = h.panel.querySelector('[data-ide-tree-path="src/app.js"] .ide-tree-name mark.ide-tree-filter-hit');
  assert.equal(hit?.textContent, 'app');
  assert.equal(h.panel.querySelector('[data-ide-tree-path="src/app.js"] .ide-tree-name').textContent, 'app.js');
  assert.match(h.panel.querySelector('.chat-search-bar-count').textContent, /1/);
});

test('filter never lists collapsed directories and matches directory names', async (t) => {
  const h = await createHarness({ files: { ...FILES, 'lib/app.js': 'x' }, expanded: ['src'] });
  t.after(() => h.dispose());
  h.toggle();
  await h.type('app');
  assert.deepEqual(h.paths().sort(), ['src', 'src/app.js']);
  assert.equal(h.bridge.calls.listDirectory.some((call) => call.path === 'lib'), false);
  await h.type('lib');
  assert.deepEqual(h.paths(), ['lib']);
});

test('case and whole-word toggles change which names match', async (t) => {
  const h = await createHarness({ files: { 'App.js': 'a', 'application.js': 'b' }, expanded: [] });
  t.after(() => h.dispose());
  h.toggle();
  await h.type('app');
  assert.deepEqual(h.paths().sort(), ['App.js', 'application.js']);
  h.panel.querySelector('[data-search-action="toggle-case"]').click();
  await settle(200);
  assert.deepEqual(h.paths(), ['application.js']);
  h.panel.querySelector('[data-search-action="toggle-case"]').click();
  h.panel.querySelector('[data-search-action="toggle-word"]').click();
  await settle(200);
  assert.deepEqual(h.paths(), ['App.js']);
});

test('names are escaped inside highlight markup', async (t) => {
  const h = await createHarness({ files: { 'a<b>.js': 'a' }, expanded: [] });
  t.after(() => h.dispose());
  h.toggle();
  await h.type('<b');
  const name = h.panel.querySelector('[data-ide-tree-path="a<b>.js"] .ide-tree-name');
  assert.equal(name.textContent, 'a<b>.js');
  assert.equal(name.querySelector('mark').textContent, '<b');
  assert.equal(name.querySelector('b'), null);
});

test('Enter and Shift+Enter walk the matching file rows with wrap-around', async (t) => {
  const h = await createHarness({ files: { 'a1.js': 'a', 'a2.js': 'b', 'b.js': 'c' }, expanded: [] });
  t.after(() => h.dispose());
  h.toggle();
  await h.type('a');
  assert.deepEqual(h.paths(), ['a1.js', 'a2.js']);

  h.key(h.input(), 'Enter');
  assert.deepEqual(h.tree.selection.getPaths(), ['a1.js']);
  h.key(h.input(), 'Enter');
  assert.deepEqual(h.tree.selection.getPaths(), ['a2.js']);
  h.key(h.input(), 'Enter');
  assert.deepEqual(h.tree.selection.getPaths(), ['a1.js'], 'wraps past the last match');
  h.key(h.input(), 'Enter', { shiftKey: true });
  assert.deepEqual(h.tree.selection.getPaths(), ['a2.js'], 'wraps back before the first match');
});

test('Esc clears the query, closes the bar and restores the full tree', async (t) => {
  const h = await createHarness({ files: FILES });
  t.after(() => h.dispose());
  h.toggle();
  await h.type('app');
  h.key(h.input(), 'Escape');
  await settle(20);
  assert.equal(h.input(), null);
  assert.deepEqual(h.paths().sort(), ['README.md', 'src', 'src/app.js', 'src/util.js']);
  assert.equal(h.panel.querySelector('mark'), null);
  assert.ok(h.panel.contains(h.dom.window.document.activeElement), 'focus returns to the tree');
});

test('Ctrl+F on a tree row opens the bar and focuses its input; again re-selects it', async (t) => {
  const h = await createHarness({ files: FILES });
  t.after(() => h.dispose());
  const row = h.panel.querySelector('[data-ide-tree-path="README.md"]');
  row.focus();
  const event = h.key(row, 'f', { ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.ok(h.input());
  assert.equal(h.dom.window.document.activeElement, h.input());
  await h.type('read');
  h.key(h.input(), 'f', { ctrlKey: true });
  assert.equal(h.dom.window.document.activeElement, h.input());
  assert.equal(h.input().selectionStart, 0);
  assert.equal(h.input().selectionEnd, 4);
});

test('filter bar typing survives a tree re-render and a root change clears the query', async (t) => {
  const h = await createHarness({ files: FILES });
  t.after(() => h.dispose());
  h.toggle();
  await h.type('util');
  h.tree.syncSelection();
  assert.ok(h.input(), 'bar is re-mounted after the markup swap');
  assert.equal(h.input().value, 'util');
  h.tree.resetForRoot();
  await settle(30);
  assert.equal(h.input(), null);
  assert.equal(h.panel.querySelector('mark'), null);
});

test('an open IME composition holds the filter until compositionend; an empty query shows no count', async (t) => {
  const h = await createHarness({ files: FILES });
  t.after(() => h.dispose());
  h.toggle();
  assert.equal(h.panel.querySelector('.chat-search-bar-count').textContent, '', 'no "No matches" before typing');
  const input = h.input();
  const { Event, CompositionEvent } = h.dom.window;
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  input.value = 'app';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(200);
  assert.equal(h.input(), input, 'the composing input is never detached');
  assert.deepEqual(h.paths().sort(), ['README.md', 'src', 'src/app.js', 'src/util.js']);
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  await settle(200);
  assert.deepEqual(h.paths().sort(), ['src', 'src/app.js']);
});
