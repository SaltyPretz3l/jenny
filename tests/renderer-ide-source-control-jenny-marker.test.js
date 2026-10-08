'use strict';

// Row 40 W6-A: the Jenny marker on Source Control rows, the translated row
// labels, and the plain-word Discard copy.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeSourceControlPanel } = require('../renderer/features/renderer-ide-source-control-panel');
const { createIdeGitFeature } = require('../renderer/features/renderer-ide-git-feature');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');

function snapshotFixture() {
  return {
    available: true,
    isRepo: true,
    branch: 'main',
    files: [
      { path: 'src/a.js', state: 'modified', staged: false, worktree: 'M', index: ' ' },
      { path: 'new.txt', state: 'untracked', staged: false, worktree: '?', index: ' ' },
      { path: 'staged.js', state: 'modified', staged: true, worktree: ' ', index: 'M' },
    ],
  };
}

function mountPanel(deps = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const panelEl = dom.window.document.getElementById('host');
  const snapshot = snapshotFixture();
  const calls = { diff: [], stage: [], unstage: [], discard: [], delete: [] };
  const panel = createIdeSourceControlPanel({
    getMountEl: () => panelEl,
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    textField,
    store: { getSnapshot: () => snapshot },
    onOpenDiff: (path) => calls.diff.push(path),
    onStage: (paths) => calls.stage.push(paths),
    onUnstage: (paths) => calls.unstage.push(paths),
    onDiscard: (path) => calls.discard.push(path),
    onDelete: (path) => calls.delete.push(path),
    ...deps,
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  return { panelEl, panel, calls };
}

const rowOf = (panelEl, path) => panelEl.querySelector(`[data-ide-scm-path="${path}"]`);

test('the Jenny marker renders only for rows whose getter returns a turnId', () => {
  const ledger = {
    'src/a.js': { turnId: 'turn-1', fileKey: 'key-a' },
    'staged.js': { turnId: '', fileKey: 'key-s' },
  };
  const { panelEl } = mountPanel({ getJennyChange: (path) => ledger[path] || null });
  const marker = rowOf(panelEl, 'src/a.js').querySelector('[data-ide-scm-action="jenny-change"]');
  assert.ok(marker, 'a row with a Jenny change has the marker');
  assert.ok(marker.classList.contains('ide-scm-jenny'));
  assert.equal(marker.textContent.trim(), 'Jenny');
  assert.equal(marker.getAttribute('aria-label'), 'Jenny changed this file. Open the change in Changes');
  assert.equal(marker.title, 'Jenny changed this file. Open the change in Changes');
  assert.equal(rowOf(panelEl, 'new.txt').querySelector('.ide-scm-jenny'), null, 'null getter result: no marker');
  assert.equal(rowOf(panelEl, 'staged.js').querySelector('.ide-scm-jenny'), null, 'empty turnId: no marker');
});

test('the marker sits between the file button and the row actions', () => {
  const { panelEl } = mountPanel({ getJennyChange: () => ({ turnId: 't', fileKey: 'k' }) });
  const children = Array.from(rowOf(panelEl, 'src/a.js').children);
  const fileIdx = children.findIndex((el) => el.classList.contains('ide-scm-file'));
  const markerIdx = children.findIndex((el) => el.classList.contains('ide-scm-jenny'));
  const actionsIdx = children.findIndex((el) => el.classList.contains('ide-scm-row-actions'));
  assert.ok(fileIdx >= 0 && markerIdx === fileIdx + 1 && actionsIdx === markerIdx + 1, `order was ${children.map((c) => c.className).join(' | ')}`);
});

test('no marker when the getter is absent', () => {
  const { panelEl } = mountPanel();
  assert.equal(panelEl.querySelector('.ide-scm-jenny'), null);
});

test('clicking the marker opens the Jenny change and triggers no other row action', () => {
  const opened = [];
  const { panelEl, calls } = mountPanel({
    getJennyChange: (path) => (path === 'src/a.js' ? { turnId: 'turn-9', fileKey: 'fk-9' } : null),
    onOpenJennyChange: (payload) => opened.push(payload),
  });
  rowOf(panelEl, 'src/a.js').querySelector('[data-ide-scm-action="jenny-change"]').click();
  assert.deepEqual(opened, [{ turnId: 'turn-9', fileKey: 'fk-9', path: 'src/a.js' }]);
  assert.deepEqual(calls.diff, []);
  assert.deepEqual(calls.stage, []);
  assert.deepEqual(calls.unstage, []);
  assert.deepEqual(calls.discard, []);
  assert.deepEqual(calls.delete, []);
});

test('clicking the marker without an onOpenJennyChange callback is a harmless no-op', () => {
  const { panelEl, calls } = mountPanel({ getJennyChange: () => ({ turnId: 't', fileKey: 'k' }) });
  rowOf(panelEl, 'src/a.js').querySelector('.ide-scm-jenny').click();
  assert.deepEqual(calls.diff, []);
});

test('row and group labels render their English fallbacks', () => {
  const { panelEl } = mountPanel();
  const label = (path, action) => rowOf(panelEl, path).querySelector(`[data-ide-scm-action="${action}"]`);
  assert.equal(label('src/a.js', 'stage').textContent.trim(), 'Stage');
  assert.equal(label('staged.js', 'unstage').textContent.trim(), 'Unstage');
  assert.equal(label('new.txt', 'delete').textContent.trim(), 'Delete');
  assert.equal(label('src/a.js', 'discard').textContent.trim(), 'Discard');
  assert.match(panelEl.querySelector('.ide-scm-group-title').textContent, /Ready to commit/);
  const titles = Array.from(panelEl.querySelectorAll('.ide-scm-group-title')).map((el) => el.textContent);
  assert.ok(titles.includes('Changed'), `group titles: ${titles.join(', ')}`);
});

test('the row Discard button keeps its label but explains it discards all edits', () => {
  const { panelEl } = mountPanel();
  const discard = rowOf(panelEl, 'src/a.js').querySelector('[data-ide-scm-action="discard"]');
  assert.equal(discard.textContent.trim(), 'Discard');
  assert.equal(discard.title, 'Discard all edits since the last commit (cannot be undone)');
});

function mountFeature(extra = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const panelEl = dom.window.document.getElementById('host');
  const snapshot = snapshotFixture();
  const confirmCalls = [];
  const store = {
    getSnapshot: () => snapshot,
    getBranch: () => 'main',
    getDirtyCount: () => 1,
    getDecoration: () => null,
    getFolderRollup: () => null,
    isRepo: () => true,
    isAvailable: () => true,
    discardFile: async () => ({ ok: true }),
    refresh: () => {},
    refreshNow: () => Promise.resolve(),
    subscribe: () => () => {},
    dispose: () => {},
  };
  const feature = createIdeGitFeature({
    store,
    getDom: () => ({}),
    getMountEl: () => panelEl,
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    textField,
    confirmDialog: { confirm: async (config) => { confirmCalls.push(config); return false; } },
    ...extra,
  });
  return { feature, panelEl, confirmCalls };
}

test('the git feature forwards getJennyChange/onOpenJennyChange and refreshJennyMarkers re-renders', () => {
  const opened = [];
  let current = null;
  const { feature, panelEl } = mountFeature({
    getJennyChange: (path) => (path === 'src/a.js' ? current : null),
    onOpenJennyChange: (payload) => opened.push(payload),
  });
  feature.bindEvents();
  feature.renderPanel();
  assert.equal(panelEl.querySelector('.ide-scm-jenny'), null, 'no marker while the ledger has no change');

  current = { turnId: 'turn-2', fileKey: 'fk-2' };
  feature.refreshJennyMarkers();
  const marker = panelEl.querySelector('[data-ide-scm-path="src/a.js"] .ide-scm-jenny');
  assert.ok(marker, 'refreshJennyMarkers re-rendered the panel with the new getter result');
  marker.click();
  assert.deepEqual(opened, [{ turnId: 'turn-2', fileKey: 'fk-2', path: 'src/a.js' }]);

  current = null;
  feature.refreshJennyMarkers();
  assert.equal(panelEl.querySelector('.ide-scm-jenny'), null, 'the marker disappears when the ledger entry goes away');
});

test('refreshJennyMarkers is a no-op when the panel is not mounted', () => {
  let mounted = null;
  const { feature, panelEl } = mountFeature({ getMountEl: () => mounted });
  feature.refreshJennyMarkers();
  assert.equal(panelEl.innerHTML, '', 'nothing painted while unmounted');
  mounted = panelEl;
  feature.refreshJennyMarkers();
  assert.match(panelEl.textContent, /Ready to commit/, 'the same call paints once a host is mounted');
});

test('the discard confirm uses plain-word copy', async () => {
  const { feature, confirmCalls } = mountFeature();
  assert.equal(await feature.confirmDiscard('src/a.js'), false);
  assert.equal(confirmCalls.length, 1);
  assert.equal(confirmCalls[0].title, 'Discard all edits since the last commit?');
  assert.equal(confirmCalls[0].confirmLabel, 'Discard edits');
  assert.match(confirmCalls[0].message, /Discard changes to "a\.js"\? This restores the last committed version and cannot be undone\./);
});
