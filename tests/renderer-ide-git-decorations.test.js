'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const { createIdeStatusBar } = require('../renderer/features/renderer-ide-statusbar');

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Tree git decorations ──────────────────────────────────────────────────

function buildTree(getGitDecoration) {
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panelEl = dom.window.document.getElementById('ideRailPanel');
  const entries = [
    { name: 'src', relPath: 'src', kind: 'directory' },
    { name: 'a.js', relPath: 'a.js', kind: 'file' },
    { name: 'new.txt', relPath: 'new.txt', kind: 'file' },
    { name: 'staged.js', relPath: 'staged.js', kind: 'file' },
    { name: 'clean.js', relPath: 'clean.js', kind: 'file' },
  ];
  const fakeFs = {
    listDirectory: async ({ path }) => ({ entries: path === '' ? entries : [], truncated: false }),
  };
  const tree = createIdeTree({
    getDom: () => ({ ideRailPanel: panelEl }),
    getIde: () => ({ railPanel: 'explorer', expandedDirs: new Set(), activeTabPath: '' }),
    getWorkspaceFsApi: () => fakeFs,
    getGitDecoration,
  });
  return { dom, panelEl, tree };
}

test('tree decorates files by git state with M/A/U badges', async () => {
  // 'added' was missing while the title still promised M/A/U, so the A badge
  // (GIT_TREE_BADGE.added in renderer/features/renderer-ide-tree.js) was never
  // exercised by the test named for it.
  const decorations = { 'a.js': 'modified', 'new.txt': 'untracked', 'staged.js': 'added' };
  const { panelEl, tree } = buildTree((rel, kind) => (kind === 'directory' ? null : decorations[rel] || null));
  tree.renderExplorer();
  await settle();

  const aRow = panelEl.querySelector('[data-ide-tree-path="a.js"]');
  assert.ok(aRow.classList.contains('ide-tree-row--git-modified'));
  assert.equal(aRow.querySelector('.ide-tree-git-badge').textContent, 'M');

  const newRow = panelEl.querySelector('[data-ide-tree-path="new.txt"]');
  assert.ok(newRow.classList.contains('ide-tree-row--git-untracked'));
  assert.equal(newRow.querySelector('.ide-tree-git-badge').textContent, 'U');

  const stagedRow = panelEl.querySelector('[data-ide-tree-path="staged.js"]');
  assert.ok(stagedRow.classList.contains('ide-tree-row--git-added'));
  assert.equal(stagedRow.querySelector('.ide-tree-git-badge').textContent, 'A');

  const cleanRow = panelEl.querySelector('[data-ide-tree-path="clean.js"]');
  assert.equal(cleanRow.querySelector('.ide-tree-git-badge'), null, 'clean file has no badge');
  assert.equal([...cleanRow.classList].some((c) => c.startsWith('ide-tree-row--git')), false);
});

test('tree rolls a dirty descendant up to its folder as a dot', async () => {
  const { panelEl, tree } = buildTree((rel, kind) => (kind === 'directory' && rel === 'src' ? 'conflicted' : null));
  tree.renderExplorer();
  await settle();
  const srcRow = panelEl.querySelector('[data-ide-tree-path="src"]');
  assert.ok(srcRow.classList.contains('ide-tree-row--git-rollup-conflicted'));
  assert.ok(srcRow.querySelector('.ide-tree-git-dot'), 'folder roll-up dot present');
});

test('tree renders exactly as before when git decoration is off', async () => {
  const { panelEl, tree } = buildTree(() => null);
  tree.renderExplorer();
  await settle();
  assert.equal(panelEl.querySelector('.ide-tree-git-badge'), null);
  assert.equal(panelEl.querySelector('.ide-tree-git-dot'), null);
  assert.ok(panelEl.querySelector('[data-ide-tree-path="a.js"]'), 'rows still render');
});

// ── Statusbar branch + dirty-count chip ───────────────────────────────────

function buildStatusBar(callbacks) {
  const dom = new JSDOM('<!doctype html><body><div id="ideStatusBar"></div><nav id="ideBreadcrumbs"></nav></body>');
  const doc = dom.window.document;
  const statusBarEl = doc.getElementById('ideStatusBar');
  const sb = createIdeStatusBar({
    getDom: () => ({ ideStatusBar: statusBarEl, ideBreadcrumbs: doc.getElementById('ideBreadcrumbs') }),
    getIde: () => ({ activeTabPath: 'a.js', wordWrap: 'off' }),
    callbacks: Object.assign({
      getCursorInfo: () => ({ lineNumber: 1, column: 1, selectedChars: 0 }),
      getActiveLanguageId: () => 'javascript',
      getEol: () => 'lf',
      getTabSize: () => 2,
      isDirty: () => false,
      isDiffTab: () => false,
      getDocumentKind: () => 'file',
    }, callbacks),
  });
  sb.bindEvents();
  sb.render();
  return { statusBarEl, sb };
}

test('statusbar shows a clickable branch chip that opens the branch switcher', () => {
  const switched = [];
  const { statusBarEl } = buildStatusBar({
    getBranch: () => 'main',
    getDirtyCount: () => 3,
    onSwitchBranch: () => switched.push(true),
  });
  assert.match(statusBarEl.textContent, /main/);
  assert.equal(statusBarEl.querySelector('.ide-statusbar-branch-count').textContent, '●3');
  const chip = statusBarEl.querySelector('[data-ide-status-action="switch-branch"]');
  assert.ok(chip, 'branch chip is an action');
  chip.click();
  assert.deepEqual(switched, [true]);
});

test('statusbar hides the dirty count at zero and the chip with no branch', () => {
  const clean = buildStatusBar({ getBranch: () => 'main', getDirtyCount: () => 0 });
  assert.equal(clean.statusBarEl.querySelector('.ide-statusbar-branch-count'), null);
  assert.ok(clean.statusBarEl.querySelector('[data-ide-status-action="switch-branch"]'), 'chip still shows at 0 dirty');

  const noRepo = buildStatusBar({ getBranch: () => '', getDirtyCount: () => 0 });
  assert.equal(noRepo.statusBarEl.querySelector('[data-ide-status-action="switch-branch"]'), null, 'no chip without a branch');
});
