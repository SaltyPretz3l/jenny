'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, settle } = require('./helpers/ide-tree-harness');

const RAW_ENTRIES = [
  { name: 'zeta.js', relPath: 'zeta.js', kind: 'file', mtimeMs: 30 },
  { name: 'Beta', relPath: 'Beta', kind: 'directory', mtimeMs: 5 },
  { name: 'README', relPath: 'README', kind: 'file', mtimeMs: 0 },
  { name: 'alpha', relPath: 'alpha', kind: 'directory', mtimeMs: 20 },
  { name: 'alpha.txt', relPath: 'alpha.txt', kind: 'file' },
  { name: 'beta.js', relPath: 'beta.js', kind: 'file', mtimeMs: 10 },
  { name: 'Alpha.js', relPath: 'Alpha.js', kind: 'file', mtimeMs: 10 },
];

async function createHarness({ entries = RAW_ENTRIES, qol = true } = {}) {
  const domHarness = buildIdeDom();
  const ide = ideStateUtils.createIdeUiState();
  let persistCalls = 0;
  const tree = createIdeTree({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getMountEl: () => domHarness.getDom().ideRailPanel,
    isActivePanel: () => true,
    isQolEnabled: () => qol,
    schedulePersist: () => { persistCalls += 1; },
    getWorkspaceFsApi: () => ({
      async listDirectory() {
        return { entries };
      },
    }),
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(30);
  return {
    ...domHarness,
    ide,
    tree,
    panel: domHarness.getDom().ideRailPanel,
    getPersistCalls: () => persistCalls,
    dispose() {
      tree.dispose();
      domHarness.dom.window.close();
    },
  };
}

function rowNames(harness) {
  return [...harness.panel.querySelectorAll('[data-ide-tree-path]')]
    .map((row) => row.dataset.ideTreePath);
}

function sortButton(harness) {
  return harness.panel.querySelector('[data-ide-tree-action="cycle-sort"]');
}

function assertDirectoriesFirst(paths) {
  const kinds = paths.map((path) => RAW_ENTRIES.find((entry) => entry.relPath === path).kind);
  const firstFile = kinds.indexOf('file');
  assert.equal(kinds.slice(firstFile).includes('directory'), false);
}

test('sort control cycles name to type to modified to name and persists once per click', async (t) => {
  const entries = RAW_ENTRIES.map((entry) => ({ ...entry }));
  const originalEntries = entries.map((entry) => ({ ...entry }));
  const harness = await createHarness({ entries });
  t.after(() => harness.dispose());

  assert.equal(harness.ide.explorerSortMode, 'name');
  assert.deepEqual(rowNames(harness), [
    'alpha', 'Beta', 'Alpha.js', 'alpha.txt', 'beta.js', 'README', 'zeta.js',
  ]);
  assert.equal(sortButton(harness).getAttribute('aria-label'), 'Sort: name — click to change');
  assert.deepEqual(
    [...harness.panel.querySelectorAll('[data-ide-tree-action]')]
      .map((button) => button.dataset.ideTreeAction),
    ['new-file', 'new-folder', 'cycle-sort', 'toggle-generated', 'refresh', 'collapse-all']
  );

  sortButton(harness).click();
  assert.equal(harness.ide.explorerSortMode, 'type');
  assert.equal(harness.getPersistCalls(), 1);
  assert.deepEqual(rowNames(harness), [
    'alpha', 'Beta', 'README', 'Alpha.js', 'beta.js', 'zeta.js', 'alpha.txt',
  ]);
  assertDirectoriesFirst(rowNames(harness));
  assert.equal(sortButton(harness).title, 'Sort: type — click to change');

  sortButton(harness).click();
  assert.equal(harness.ide.explorerSortMode, 'modified');
  assert.equal(harness.getPersistCalls(), 2);
  assert.deepEqual(rowNames(harness), [
    'alpha', 'Beta', 'zeta.js', 'Alpha.js', 'beta.js', 'alpha.txt', 'README',
  ]);
  assertDirectoriesFirst(rowNames(harness));

  sortButton(harness).click();
  assert.equal(harness.ide.explorerSortMode, 'name');
  assert.equal(harness.getPersistCalls(), 3);
  assertDirectoriesFirst(rowNames(harness));
  assert.deepEqual(entries, originalEntries, 'render sorting must not mutate the cached listing array');
});

test('modified mode puts zero and missing mtimes last with a name tie-break', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.dispose());
  harness.ide.explorerSortMode = 'modified';
  harness.tree.syncSelection();

  const paths = rowNames(harness);
  assert.deepEqual(paths.slice(-2), ['alpha.txt', 'README']);
  assert.deepEqual(paths.slice(2, 5), ['zeta.js', 'Alpha.js', 'beta.js']);
  assertDirectoriesFirst(paths);
});

test('flag off omits the sort button and preserves raw listing order', async (t) => {
  const entries = RAW_ENTRIES.map((entry) => ({ ...entry }));
  const harness = await createHarness({ entries, qol: false });
  t.after(() => harness.dispose());

  assert.equal(sortButton(harness), null);
  assert.deepEqual(rowNames(harness), entries.map((entry) => entry.relPath));
  assert.equal(harness.getPersistCalls(), 0);
});

test('renderer state defaults, normalizes, and serializes explorerSortMode', () => {
  const ide = ideStateUtils.createIdeUiState();
  assert.equal(ide.explorerSortMode, 'name');
  ideStateUtils.applyPersistedState(ide, { explorerSortMode: 'modified' });
  assert.equal(ide.explorerSortMode, 'modified');
  assert.equal(ideStateUtils.toPersistedState(ide).explorerSortMode, 'modified');
  ideStateUtils.applyPersistedState(ide, { explorerSortMode: 'garbage' });
  assert.equal(ide.explorerSortMode, 'name');
  ide.explorerSortMode = 'bad';
  assert.equal(ideStateUtils.toPersistedState(ide).explorerSortMode, 'name');
});

test('renderer and schema normalizers agree on every sort mode (drift pin)', () => {
  const { normalizeWorkspaceIde } = require('../services/workspace-ide-config-schema');
  for (const mode of ['name', 'type', 'modified']) {
    const ide = ideStateUtils.createIdeUiState();
    ideStateUtils.applyPersistedState(ide, { explorerSortMode: mode });
    assert.equal(ide.explorerSortMode, mode, `renderer accepts ${mode}`);
    assert.equal(normalizeWorkspaceIde({ explorerSortMode: mode }).explorerSortMode, mode,
      `schema accepts ${mode}`);
  }
  assert.equal(normalizeWorkspaceIde({ explorerSortMode: 'size' }).explorerSortMode, 'name');
});
