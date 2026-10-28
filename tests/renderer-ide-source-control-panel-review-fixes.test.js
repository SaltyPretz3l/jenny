'use strict';

// Source Control panel (renderer-ide-source-control-panel): review fixes for
// partially staged files, renamed-file diffs and the History refresh while the
// panel is hidden. Split from renderer-ide-source-control-panel.test.js at its
// 600-line ratchet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeSourceControlPanel } = require('../renderer/features/renderer-ide-source-control-panel');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// Row actions are injected on a row's first hover or focus (cleanup G6): reveal every row's.
const revealRows = (root) => root.querySelectorAll('.ide-scm-row').forEach((row) => row.dispatchEvent(new row.ownerDocument.defaultView.Event('focusin', { bubbles: true })));

function repo() {
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

function setup(snapshot) {
  const dom = new JSDOM('<!doctype html><body><div id="wbView-source-control"></div></body>');
  const panelEl = dom.window.document.getElementById('wbView-source-control');
  const calls = { stageAll: [] };
  const panel = createIdeSourceControlPanel({
    getDom: () => ({}), getMountEl: () => panelEl,
    getIde: () => ({ railPanel: 'source-control' }),
    actionButton,
    textField,
    store: { getSnapshot: () => snapshot },
    onStage: () => {},
    onUnstage: () => {},
    onStageAll: (paths) => calls.stageAll.push(paths),
    onDiscard: () => {},
    onDelete: () => {},
    onOpenDiff: () => {},
    onCommit: async () => ({ committed: true }),
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  revealRows(panelEl);
  return { panelEl, calls };
}

// A partially staged file (index M + worktree M) used to appear ONLY under
// "Ready to commit" with Unstage; Stage All / the Changed group never included
// it, so a commit silently left its newer edits behind.
test('a partially staged file is also listed under Changed with Stage/Discard, and Stage All includes it', () => {
  const snapshot = repo();
  snapshot.files.push({ path: 'both.js', state: 'modified', staged: true, worktree: 'M', index: 'M' });
  const { panelEl, calls } = setup(snapshot);
  const rows = [...panelEl.querySelectorAll('[data-ide-scm-path="both.js"]')];
  assert.equal(rows.length, 2, 'listed in both groups');
  const actions = rows.map((row) => [...row.querySelectorAll('[data-ide-scm-action]')].map((el) => el.dataset.ideScmAction));
  assert.ok(actions.some((list) => list.includes('unstage')), 'the staged copy keeps Unstage');
  assert.ok(actions.some((list) => list.includes('stage') && list.includes('discard')), 'the changed copy offers Stage + Discard');
  panelEl.querySelector('[data-ide-scm-action="stage-all"]').click();
  assert.deepEqual(calls.stageAll, [['src/a.js', 'new.txt', 'both.js']]);
});

test('opening the diff of a renamed file passes its original path through', () => {
  const snapshot = repo();
  snapshot.files.push({ path: 'src/new-name.js', origPath: 'src/old-name.js', state: 'renamed', staged: true, worktree: ' ', index: 'R' });
  const diffs = [];
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const panel = createIdeSourceControlPanel({
    getMountEl: () => host, isActivePanel: () => true, actionButton, textField,
    store: { getSnapshot: () => snapshot },
    onOpenDiff: (path, opts) => diffs.push([path, opts && opts.origPath]),
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  host.querySelector('[data-ide-scm-path="src/new-name.js"] [data-ide-scm-action="diff"]').click();
  host.querySelector('[data-ide-scm-path="src/a.js"] [data-ide-scm-action="diff"]').click();
  assert.deepEqual(diffs, [['src/new-name.js', 'src/old-name.js'], ['src/a.js', undefined]]);
});

// An external commit while the panel is hidden used to be dropped: the
// History refresh was a no-op when inactive and ensureLoaded() then saw the
// cached log as loaded. It now marks the log stale for the next activation.
test('refreshHistory while the panel is inactive reloads the log on the next activation', async () => {
  const { createIdeCommitHistory } = require('../renderer/features/renderer-ide-commit-history');
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  let active = true;
  let logCalls = 0;
  const panel = createIdeSourceControlPanel({
    getMountEl: () => host, isActivePanel: () => active, actionButton, textField,
    store: { getSnapshot: () => repo() },
    onGetLog: async () => { logCalls += 1; return { ok: true, available: true, isRepo: true, commits: [] }; },
    createCommitHistory: createIdeCommitHistory,
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  await settle();
  assert.equal(logCalls, 1, 'first open loads the log');
  active = false;
  panel.refreshHistory(); // external HEAD move while hidden
  await settle();
  assert.equal(logCalls, 1, 'no fetch while hidden');
  active = true;
  host.__jennyIdeRailMarkup = '';
  panel.renderSourceControlPanel();
  await settle();
  assert.equal(logCalls, 2, 'the stale log reloads on activation');
});
