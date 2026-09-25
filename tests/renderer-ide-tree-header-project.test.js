'use strict';

// Projects v2 (2026-09-20): the Explorer header title is the current project
// and opens the shared project menu. Without a switcher wired the header keeps
// its static "Explorer" label, so restricted shells and older tests are
// unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, settle } = require('./helpers/ide-tree-harness');

function makeTree(getDom, extra) {
  const ide = ideStateUtils.createIdeUiState();
  return createIdeTree({
    getDom,
    getIde: () => ide,
    getMountEl: () => getDom().ideRailPanel,
    isActivePanel: () => true,
    getWorkspaceFsApi: () => ({ async listDirectory() { return { entries: [] }; } }),
    ...extra,
  });
}

test('with a switcher the header title is a listbox button carrying the project name, and clicking it opens the menu anchored on the button', async () => {
  const { getDom } = buildIdeDom();
  const opened = [];
  let title = 'Ascend';
  const tree = makeTree(getDom, {
    getProjectTitle: () => title,
    onOpenProjectMenu: (anchor) => opened.push(anchor),
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle();
  const panel = getDom().ideRailPanel;
  const button = panel.querySelector('[data-ide-tree-action="project-menu"]');
  assert.ok(button, 'the header title is the project switcher button');
  assert.equal(button.tagName, 'BUTTON');
  assert.ok(button.classList.contains('ide-tree-header-title'));
  assert.equal(button.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(button.getAttribute('aria-label'), 'Switch project');
  assert.equal(button.querySelector('.ide-tree-header-project-name').textContent, 'Ascend');
  assert.ok(button.querySelector('svg'), 'the chevron is the only added mark');
  assert.equal(panel.querySelector('span.ide-tree-header-title'), null);

  button.click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0], button);

  title = 'Budget FY27';
  tree.repaintHeader();
  assert.equal(panel.querySelector('.ide-tree-header-project-name').textContent, 'Budget FY27', 'a re-render repaints the name');
  const generated = panel.querySelector('[data-ide-tree-action="toggle-generated"]');
  assert.ok(generated, 'the header actions stay');
});

test('without a switcher the header keeps the static Explorer label', async () => {
  const { getDom } = buildIdeDom();
  const tree = makeTree(getDom);
  tree.bindEvents();
  tree.refreshRoot();
  await settle();
  const panel = getDom().ideRailPanel;
  assert.equal(panel.querySelector('[data-ide-tree-action="project-menu"]'), null);
  assert.equal(panel.querySelector('span.ide-tree-header-title').textContent, 'Explorer');
});
