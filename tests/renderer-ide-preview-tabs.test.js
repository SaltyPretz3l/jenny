'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const {
  buildIdeDom,
  createHarness,
  findMenuItem,
  openContextMenu,
  pressKey,
  settle,
} = require('./helpers/renderer-ide-harness');

test('ide tree preserves explorer scroll through selection rerenders and clears it on root reset', async () => {
  const { getDom } = buildIdeDom();
  const ide = ideStateUtils.createIdeUiState();
  const tree = createIdeTree({
    getIde: () => ide,
    getMountEl: () => getDom().ideRailPanel,
    isActivePanel: () => true,
    getWorkspaceFsApi: () => ({
      listDirectory: async () => ({ entries: [{ name: 'a.js', relPath: 'a.js', kind: 'file' }] }),
    }),
  });
  tree.refreshRoot();
  await settle();
  const panel = getDom().ideRailPanel;
  panel.scrollTop = 180;
  ide.activeTabPath = 'a.js';
  tree.syncSelection();
  assert.equal(panel.scrollTop, 180);

  panel.scrollTop = 240;
  tree.resetForRoot();
  assert.equal(panel.scrollTop, 0);
});

test('tree click and Enter use one preview slot while double-click and context menu promote explicit tabs', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const panel = harness.getDom().ideRailPanel;

  panel.querySelector('[data-ide-tree-path="a.js"]').click();
  await settle();
  assert.equal(harness.state.ui.ide.openTabs[0].transientPreview, true);

  pressKey(harness, panel.querySelector('[data-ide-tree-path="b.js"]'), 'Enter');
  await settle();
  assert.deepEqual(harness.state.ui.ide.openTabs.map((tab) => tab.path), ['b.js']);

  panel.querySelector('[data-ide-tree-path="b.js"]').dispatchEvent(
    new harness.dom.window.MouseEvent('click', { bubbles: true, detail: 2 })
  );
  await settle();
  assert.equal(ideStateUtils.getTab(harness.state.ui.ide, 'b.js').transientPreview, undefined);

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="c.js"]'));
  const openNew = findMenuItem(harness.dom.window.document, 'Open in New Tab');
  assert.ok(openNew);
  openNew.click();
  await settle();
  assert.equal(ideStateUtils.getTab(harness.state.ui.ide, 'c.js').transientPreview, undefined);
  assert.deepEqual(new Set(harness.state.ui.ide.openTabs.map((tab) => tab.path)), new Set(['b.js', 'c.js']));
});
