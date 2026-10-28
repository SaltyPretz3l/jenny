'use strict';

// Row 75: unmerged (conflicted) entries get their own "Needs resolving" group
// in the Source Control panel, where Stage means "mark resolved".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeSourceControlPanel } = require('../renderer/features/renderer-ide-source-control-panel');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Shapes mirror services/workspace-git-parsers.js parseStatus: an unmerged
// entry carries a non-space index column, so `staged` is true.
function conflictRepo() {
  return {
    available: true,
    isRepo: true,
    branch: 'main',
    files: [
      { path: 'src/billing/invoice.js', index: 'U', worktree: 'U', state: 'conflicted', staged: true },
      { path: 'src/billing/tax-rates.json', index: 'A', worktree: 'A', state: 'conflicted', staged: true },
      { path: 'docs/billing.md', index: 'U', worktree: 'D', state: 'conflicted', staged: true },
      { path: 'src/billing/currency.js', index: 'M', worktree: ' ', state: 'modified', staged: true },
      { path: 'src/billing/totals.test.js', index: 'A', worktree: ' ', state: 'added', staged: true },
      { path: 'package.json', index: ' ', worktree: 'M', state: 'modified', staged: false },
    ],
  };
}

function setup(snapshot, opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="wbView-source-control"></div></body>');
  const panelEl = dom.window.document.getElementById('wbView-source-control');
  const calls = { stage: [], stageAll: [], unstage: [], discard: [], diff: [], resolve: [], resolveDelete: [], openFile: [], commit: [] };
  const panel = createIdeSourceControlPanel({
    getMountEl: () => panelEl,
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    textField,
    store: { getSnapshot: () => snapshot },
    getJennyChange: () => ({ turnId: 't1', fileKey: 'k1' }),
    onStage: (paths) => calls.stage.push(paths),
    onUnstage: (paths) => calls.unstage.push(paths),
    onStageAll: (paths) => calls.stageAll.push(paths),
    onDiscard: (path) => calls.discard.push(path),
    onOpenDiff: (path) => calls.diff.push(path),
    onResolve: async (path) => {
      calls.resolve.push(path);
      return opts.resolveResult || { ok: true };
    },
    onResolveDelete: (path, options) => calls.resolveDelete.push([path, options || null]),
    onOpenFile: (path) => calls.openFile.push(path),
    onCommit: async (message) => { calls.commit.push(message); return { committed: true }; },
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  return { dom, panelEl, panel, calls };
}

function rowsFor(panelEl, path) {
  return panelEl.querySelectorAll(`.ide-scm-row[data-ide-scm-path="${path}"]`);
}

function action(row, name) {
  return row.querySelector(`[data-ide-scm-action="${name}"]`);
}

test('conflicts get their own first group and leave the staged/changed groups', () => {
  const { panelEl } = setup(conflictRepo());
  const heads = [...panelEl.querySelectorAll('.ide-scm-group-head')].map((head) => [
    head.querySelector('.ide-scm-group-title').textContent,
    head.querySelector('.ide-scm-group-count').textContent,
  ]);
  assert.deepEqual(heads, [['Needs resolving', '3'], ['Ready to commit', '2'], ['Changed', '1']]);
  for (const file of conflictRepo().files) {
    assert.equal(rowsFor(panelEl, file.path).length, 1, `${file.path} renders exactly once`);
  }
});

test('conflicted rows carry the conflict badge, kind labels and only resolve actions', () => {
  const { panelEl } = setup(conflictRepo());
  const uu = rowsFor(panelEl, 'src/billing/invoice.js')[0];
  const aa = rowsFor(panelEl, 'src/billing/tax-rates.json')[0];
  const ud = rowsFor(panelEl, 'docs/billing.md')[0];
  for (const row of [uu, aa, ud]) {
    assert.equal(row.querySelector('.ide-scm-badge').dataset.gitState, 'conflicted');
    for (const name of ['stage', 'unstage', 'discard', 'delete', 'jenny-change', 'diff']) {
      assert.equal(action(row, name), null, `no ${name} on a conflicted row`);
    }
  }
  assert.equal(uu.querySelector('.ide-scm-row-kind'), null, 'both-edited shows no kind label');
  assert.equal(aa.querySelector('.ide-scm-row-kind').textContent, 'both added');
  assert.equal(ud.querySelector('.ide-scm-row-kind').textContent, 'they deleted');
  assert.ok(action(uu, 'resolve'), 'UU offers Mark resolved');
  assert.ok(action(aa, 'resolve'), 'AA offers Mark resolved');
  assert.equal(action(uu, 'resolve').textContent, 'Mark resolved');
  assert.equal(action(ud, 'resolve'), null, 'a deletion conflict has no plain Mark resolved');
  assert.equal(action(ud, 'keep').textContent, 'Keep');
  assert.equal(action(ud, 'delete-resolve').textContent, 'Delete');
  assert.match(ud.querySelector('.ide-scm-file').title, /the other branch deleted it/);
});

test('Commit is disabled with a counted hint while conflicts remain, and re-enables once resolved', () => {
  const snapshot = conflictRepo();
  const { panelEl, panel } = setup(snapshot);
  const commit = () => panelEl.querySelector('[data-ide-scm-action="commit"]');
  const hint = () => panelEl.querySelector('.ide-scm-commit-hint');
  assert.equal(commit().disabled, true);
  assert.equal(hint().textContent, 'Resolve 3 files before committing.');

  snapshot.files = snapshot.files.filter((file) => file.path !== 'src/billing/invoice.js' && file.path !== 'docs/billing.md');
  panel.renderSourceControlPanel();
  assert.equal(commit().disabled, true);
  assert.equal(hint().textContent, 'Resolve 1 file before committing.');

  snapshot.files = snapshot.files.map((file) => (file.state === 'conflicted'
    ? { ...file, index: 'A', worktree: ' ', state: 'added' }
    : file));
  panel.renderSourceControlPanel();
  assert.equal(commit().disabled, false, 'no conflicts + staged files -> Commit enabled');
  assert.equal(hint(), null, 'the conflict hint clears');
  assert.equal(panelEl.querySelector('.ide-scm-group-title').textContent, 'Ready to commit', 'the group disappears');
});

test('Stage All never marks conflicts resolved', () => {
  const { panelEl, calls } = setup(conflictRepo());
  panelEl.querySelector('[data-ide-scm-action="stage-all"]').click();
  assert.deepEqual(calls.stageAll, [['package.json']]);
});

test('Mark resolved with markers left opens the confirm line; "anyway" stages once', async () => {
  const { panelEl, calls } = setup(conflictRepo(), { resolveResult: { needsConfirm: true, count: 2 } });
  action(rowsFor(panelEl, 'src/billing/invoice.js')[0], 'resolve').click();
  await settle();
  assert.deepEqual(calls.resolve, ['src/billing/invoice.js']);
  assert.deepEqual(calls.stage, [], 'markers left -> nothing staged yet');
  const line = panelEl.querySelector('.ide-scm-row-confirm');
  assert.ok(line, 'the confirm line renders');
  assert.equal(line.getAttribute('role'), 'alert');
  assert.match(line.textContent, /2 conflict blocks still in this file\./);
  assert.equal(panelEl.querySelectorAll('.ide-scm-row-confirm').length, 1);

  line.querySelector('[data-ide-scm-action="confirm-resolve"]').click();
  assert.deepEqual(calls.stage, [['src/billing/invoice.js']]);
  assert.equal(panelEl.querySelector('.ide-scm-row-confirm'), null, 'the line closes');
});

test('the confirm line "Open file" opens the file and closes the line', async () => {
  const { panelEl, calls } = setup(conflictRepo(), { resolveResult: { needsConfirm: true, count: 1 } });
  action(rowsFor(panelEl, 'src/billing/invoice.js')[0], 'resolve').click();
  await settle();
  assert.match(panelEl.querySelector('.ide-scm-row-confirm').textContent, /1 conflict block still in this file\./);
  panelEl.querySelector('.ide-scm-row-confirm [data-ide-scm-action="open-conflict"]').click();
  assert.deepEqual(calls.openFile, ['src/billing/invoice.js']);
  assert.deepEqual(calls.stage, []);
  assert.equal(panelEl.querySelector('.ide-scm-row-confirm'), null);
});

test('a clean Mark resolved shows no confirm line', async () => {
  const { panelEl, calls } = setup(conflictRepo(), { resolveResult: { ok: true } });
  action(rowsFor(panelEl, 'src/billing/tax-rates.json')[0], 'resolve').click();
  await settle();
  assert.deepEqual(calls.resolve, ['src/billing/tax-rates.json']);
  assert.equal(panelEl.querySelector('.ide-scm-row-confirm'), null);
});

test('the confirm line drops when its file stops being conflicted, and on a root reset', async () => {
  const snapshot = conflictRepo();
  const { panelEl, panel } = setup(snapshot, { resolveResult: { needsConfirm: true, count: 2 } });
  action(rowsFor(panelEl, 'src/billing/invoice.js')[0], 'resolve').click();
  await settle();
  assert.ok(panelEl.querySelector('.ide-scm-row-confirm'));
  // An unrelated re-render keeps it.
  panel.renderSourceControlPanel();
  assert.ok(panelEl.querySelector('.ide-scm-row-confirm'), 'kept while still conflicted');
  snapshot.files = snapshot.files.map((file) => (file.path === 'src/billing/invoice.js'
    ? { ...file, index: 'M', worktree: ' ', state: 'modified' }
    : file));
  panel.renderSourceControlPanel();
  assert.equal(panelEl.querySelector('.ide-scm-row-confirm'), null, 'resolved elsewhere -> dropped');

  snapshot.files = conflictRepo().files;
  panel.renderSourceControlPanel();
  action(rowsFor(panelEl, 'src/billing/invoice.js')[0], 'resolve').click();
  await settle();
  assert.ok(panelEl.querySelector('.ide-scm-row-confirm'));
  panel.resetForRoot();
  panel.renderSourceControlPanel();
  assert.equal(panelEl.querySelector('.ide-scm-row-confirm'), null, 'root reset clears it');
});

test('Keep stages and Delete routes to the confirm-gated delete-resolve', () => {
  const { panelEl, calls } = setup(conflictRepo());
  const ud = rowsFor(panelEl, 'docs/billing.md')[0];
  action(ud, 'keep').click();
  action(ud, 'delete-resolve').click();
  assert.deepEqual(calls.stage, [['docs/billing.md']]);
  assert.deepEqual(calls.resolveDelete, [['docs/billing.md', null]]);
});

test('a both-deleted conflict resolves through the plain Mark resolved path and has no open action', async () => {
  const snapshot = conflictRepo();
  snapshot.files.push({ path: 'old/gone.txt', index: 'D', worktree: 'D', state: 'conflicted', staged: true });
  const { panelEl, calls } = setup(snapshot);
  const dd = rowsFor(panelEl, 'old/gone.txt')[0];
  assert.equal(dd.querySelector('.ide-scm-row-kind').textContent, 'both deleted');
  assert.equal(action(dd, 'open-conflict'), null, 'nothing on disk to open');
  action(dd, 'resolve').click();
  await settle();
  assert.deepEqual(calls.resolve, ['old/gone.txt'], '`git add` clears a both-deleted entry without deleting anything');
  assert.deepEqual(calls.resolveDelete, []);
});

test('clicking a conflicted row opens the file itself, not the HEAD compare', () => {
  const { panelEl, calls } = setup(conflictRepo());
  action(rowsFor(panelEl, 'src/billing/invoice.js')[0], 'open-conflict').click();
  assert.deepEqual(calls.openFile, ['src/billing/invoice.js']);
  assert.deepEqual(calls.diff, []);
});

test('without conflicts the panel renders exactly as before (no new group, no hint)', () => {
  const snapshot = conflictRepo();
  snapshot.files = snapshot.files.filter((file) => file.state !== 'conflicted');
  const { panelEl } = setup(snapshot);
  const titles = [...panelEl.querySelectorAll('.ide-scm-group-title')].map((el) => el.textContent);
  assert.deepEqual(titles, ['Ready to commit', 'Changed']);
  assert.equal(panelEl.querySelector('.ide-scm-commit-hint'), null);
  assert.equal(panelEl.querySelector('[data-ide-scm-action="commit"]').disabled, false);
});
