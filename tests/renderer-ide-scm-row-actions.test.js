'use strict';
// Row 82 G1: Source Control row hover actions, group header actions and the commit
// options (renderer/features/renderer-ide-scm-row-actions.js), unit and through the panel.
// Cleanup wave G6 (owner D5): row actions are injected on a row's first hover or focus.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScmRowActions } = require('../renderer/features/renderer-ide-scm-row-actions');
const { createIdeSourceControlPanel } = require('../renderer/features/renderer-ide-source-control-panel');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const btn = (label, action) => `<b data-a="${action}">${label}</b>`;

function snapshot() {
  return {
    available: true,
    isRepo: true,
    branch: 'main',
    files: [
      { path: 'src/a.js', state: 'modified', staged: false, worktree: 'M', index: ' ' },
      { path: 'new.txt', state: 'untracked', staged: false, worktree: '?', index: ' ' },
      { path: 'both.js', state: 'modified', staged: true, worktree: 'M', index: 'M' },
    ],
  };
}

function setup({ snap = snapshot(), gitActions = {}, onCommit } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const calls = { open: [], diff: [], commit: [], actions: [] };
  const actions = {
    unstageAll: () => calls.actions.push('unstageAll'),
    discardAll: () => calls.actions.push('discardAll'),
    getLastCommitMessage: async () => 'Previous subject\n\nPrevious body',
    ...gitActions,
  };
  const panel = createIdeSourceControlPanel({
    getMountEl: () => host, isActivePanel: () => true, actionButton, textField,
    store: { getSnapshot: () => snap },
    gitActions: actions,
    onOpenFile: (path) => calls.open.push(path),
    onOpenDiff: (path, opts) => calls.diff.push([path, opts.staged === true]),
    onCommit: onCommit || (async (message, opts) => { calls.commit.push([message, opts]); return { committed: true }; }),
  });
  panel.bindEvents();
  panel.renderSourceControlPanel();
  return { host, panel, calls, snap };
}

const actionsOf = (row) => [...row.querySelectorAll('.ide-scm-row-actions [data-ide-scm-action]')].map((el) => el.dataset.ideScmAction);
// A pointer entering a row (pointerenter does not bubble: the panel listens in capture).
const hover = (row) => row.dispatchEvent(new row.ownerDocument.defaultView.Event('pointerenter'));

// A checkbox click toggles its own checked state (no manual assignment needed).
test('rows carry VS Code hover actions: Open, Discard or Delete, Stage; staged rows Open, Unstage', () => {
  const rows = createScmRowActions({ actionBtn: btn });
  assert.equal(rows.rowActionsMarkup({ path: 'a', state: 'modified' }, false), btn('Open', 'open-file') + btn('Discard', 'discard') + btn('Stage', 'stage'));
  assert.equal(rows.rowActionsMarkup({ path: 'n', state: 'untracked' }, false), btn('Open', 'open-file') + btn('Delete', 'delete') + btn('Stage', 'stage'));
  assert.equal(rows.rowActionsMarkup({ path: 's', state: 'modified' }, true), btn('Open', 'open-file') + btn('Unstage', 'unstage'));
});

test('group headers: Discard All + Stage All on Changed, Unstage All on Ready to commit', () => {
  const { host } = setup();
  const head = (kind) => [...host.querySelectorAll(`[data-ide-scm-group="${kind}"] .ide-scm-group-head [data-ide-scm-action]`)].map((el) => el.dataset.ideScmAction);
  assert.deepEqual(head('changed'), ['discard-all', 'stage-all']);
  assert.deepEqual(head('staged'), ['unstage-all']);
  const withoutActions = createScmRowActions({ actionBtn: btn });
  assert.equal(withoutActions.groupHeadMarkup('staged'), '', 'no Unstage All without the git actions');
  assert.match(withoutActions.groupHeadMarkup('changed'), /stage-all/);
});

test('panel rows route Open, Unstage All and Discard All, and the row diff knows its group', () => {
  const { host, calls } = setup();
  const changedRow = host.querySelector('[data-ide-scm-group="changed"] [data-ide-scm-path="both.js"]');
  const stagedRow = host.querySelector('[data-ide-scm-group="staged"] [data-ide-scm-path="both.js"]');
  hover(changedRow);
  hover(stagedRow);
  assert.deepEqual(actionsOf(changedRow), ['open-file', 'discard', 'stage']);
  assert.deepEqual(actionsOf(stagedRow), ['open-file', 'unstage']);
  changedRow.querySelector('[data-ide-scm-action="open-file"]').click();
  changedRow.querySelector('[data-ide-scm-action="diff"]').click();
  stagedRow.querySelector('[data-ide-scm-action="diff"]').click();
  host.querySelector('[data-ide-scm-action="unstage-all"]').click();
  host.querySelector('[data-ide-scm-action="discard-all"]').click();
  assert.deepEqual(calls.open, ['both.js']);
  assert.deepEqual(calls.diff, [['both.js', false], ['both.js', true]]);
  assert.deepEqual(calls.actions, ['unstageAll', 'discardAll']);
  assert.match(stagedRow.querySelector('[data-ide-scm-action="diff"]').title, /Open Staged Changes/);
});

test('Amend prefills an empty draft with the last message and passes amend to the commit', async () => {
  const { host, calls } = setup();
  const amend = host.querySelector('[data-ide-scm-action="commit-amend"]');
  amend.click();
  await settle();
  const input = host.querySelector('[data-ide-scm-input="commit"]');
  assert.equal(input.value, 'Previous subject\n\nPrevious body');
  assert.equal(host.querySelector('[data-ide-scm-action="commit-amend"]').checked, true);
  const signoff = host.querySelector('[data-ide-scm-action="commit-signoff"]');
  signoff.click();
  host.querySelector('[data-ide-scm-action="commit"]').click();
  await settle();
  assert.deepEqual(calls.commit, [['Previous subject\n\nPrevious body', { amend: true, signoff: true }]]);
  // A successful commit unticks Amend (Sign off stays, as in VS Code's setting).
  assert.equal(host.querySelector('[data-ide-scm-action="commit-amend"]').checked, false);
});

test('Amend never overwrites a typed draft; unticking clears only the untouched prefill', async () => {
  const { host } = setup();
  const input = host.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'my words';
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
  const amend = host.querySelector('[data-ide-scm-action="commit-amend"]');
  amend.click();
  await settle();
  assert.equal(host.querySelector('[data-ide-scm-input="commit"]').value, 'my words');
  amend.click();
  assert.equal(host.querySelector('[data-ide-scm-input="commit"]').value, 'my words');

  const fresh = setup();
  const box = fresh.host.querySelector('[data-ide-scm-action="commit-amend"]');
  box.click();
  await settle();
  box.click();
  assert.equal(fresh.host.querySelector('[data-ide-scm-input="commit"]').value, '');
});

test('with nothing staged, Commit is enabled only while Amend is ticked', async () => {
  const snap = snapshot();
  snap.files = snap.files.filter((file) => !file.staged);
  const { host } = setup({ snap });
  const commit = () => host.querySelector('[data-ide-scm-action="commit"]');
  assert.equal(commit().disabled, true);
  const amend = host.querySelector('[data-ide-scm-action="commit-amend"]');
  amend.click();
  await settle();
  assert.equal(commit().disabled, false);
});

test('a root switch drops the amend state and a prefill still in flight', async () => {
  let resolvePrefill;
  const { host, panel } = setup({ gitActions: { getLastCommitMessage: () => new Promise((resolve) => { resolvePrefill = resolve; }) } });
  const amend = host.querySelector('[data-ide-scm-action="commit-amend"]');
  amend.click();
  panel.resetForRoot();
  resolvePrefill('old root message');
  await settle();
  panel.renderSourceControlPanel();
  assert.equal(host.querySelector('[data-ide-scm-input="commit"]').value, '');
  assert.equal(host.querySelector('[data-ide-scm-action="commit-amend"]').checked, false);
});

test('commitFromPalette commits a typed message, else focuses the box; amend ticks the option', async () => {
  const { host, panel, calls } = setup();
  await panel.commitFromPalette({});
  assert.equal(calls.commit.length, 0, 'an empty draft only focuses');
  const input = host.querySelector('[data-ide-scm-input="commit"]');
  input.value = 'typed';
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
  await panel.commitFromPalette({});
  assert.deepEqual(calls.commit, [['typed', { amend: false, signoff: false }]]);
  await panel.commitFromPalette({ amend: true });
  await settle();
  assert.equal(host.querySelector('[data-ide-scm-action="commit-amend"]').checked, true);
});

test('2,000 rows carry no action buttons until one is hovered or focused', () => {
  const snap = snapshot();
  snap.files = Array.from({ length: 2000 }, (_v, i) => ({ path: `src/f${i}.js`, state: 'modified', staged: false, worktree: 'M', index: ' ' }));
  const { host } = setup({ snap });
  assert.equal(host.querySelectorAll('.ide-scm-row').length, 2000);
  assert.equal(host.querySelectorAll('.ide-scm-row-actions [data-ide-scm-action]').length, 0);
  const row = host.querySelector('[data-ide-scm-path="src/f1000.js"]');
  hover(row);
  hover(row);
  assert.deepEqual(actionsOf(row), ['open-file', 'discard', 'stage'], 'injected once');
  assert.equal(host.querySelectorAll('.ide-scm-row-actions [data-ide-scm-action]').length, 3);
});

test('keyboard focus on a row exposes its actions, and a re-render keeps them on that row', () => {
  const { host, panel, snap, calls } = setup();
  const rowOf = () => host.querySelector('[data-ide-scm-group="changed"] [data-ide-scm-path="src/a.js"]');
  rowOf().querySelector('[data-ide-scm-action="diff"]').focus();
  assert.deepEqual(actionsOf(rowOf()), ['open-file', 'discard', 'stage']);
  rowOf().querySelector('[data-ide-scm-action="open-file"]').click();
  assert.deepEqual(calls.open, ['src/a.js']);
  snap.files = [...snap.files, { path: 'later.js', state: 'modified', staged: false, worktree: 'M', index: ' ' }];
  panel.renderSourceControlPanel();
  assert.deepEqual(actionsOf(rowOf()), ['open-file', 'discard', 'stage'], 're-injected after the list repaint');
  assert.deepEqual(actionsOf(host.querySelector('[data-ide-scm-path="later.js"]')), []);
});
