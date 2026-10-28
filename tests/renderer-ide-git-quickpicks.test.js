'use strict';
// Row 82 G1: stash list / apply / pop / drop and Delete Branch quick picks
// (renderer/features/renderer-ide-git-quickpicks.js) on the shared picker overlay.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeGitQuickpicks, filterRows, describeFailure } = require('../renderer/features/renderer-ide-git-quickpicks');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const STASHES = [
  { index: 0, ref: 'stash@{0}', sha: 'a'.repeat(40), subject: 'On main: second', dateISO: '' },
  { index: 1, ref: 'stash@{1}', sha: 'b'.repeat(40), subject: 'WIP on main: first', dateISO: '' },
];

function setup({ client = {}, confirm = true, current = 'main' } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const doc = dom.window.document;
  const stage = doc.getElementById('stage');
  const calls = { stash: [], deleteBranch: [], confirms: [], toasts: [], errors: [], refresh: 0 };
  const picks = createIdeGitQuickpicks({
    getDom: () => ({ ideEditorStage: stage }),
    client: {
      listStashes: async () => ({ ok: true, stashes: STASHES }),
      getBranches: async () => ({ ok: true, branches: ['main', 'feature/x', 'old'], current }),
      stash: async (payload) => { calls.stash.push(payload); return { ok: true, stashed: true, operation: payload.op }; },
      deleteBranch: async (payload) => { calls.deleteBranch.push(payload); return { ok: true, deleted: true }; },
      ...client,
    },
    confirmDialog: { confirm: async (spec) => { calls.confirms.push(spec); return confirm; } },
    showToastMessage: (message) => calls.toasts.push(message),
    showShellErrorToast: (message) => calls.errors.push(message),
    refreshGit: async () => { calls.refresh += 1; },
    textField: require('../renderer/inventory/text-field'),
    escapeHtml: require('../renderer/shared/string-utils').escapeHtml,
  });
  return { picks, calls, stage, doc };
}

const rowNames = (stage) => [...stage.querySelectorAll('[data-ide-git-pick-index] .ide-picker-name')].map((el) => el.textContent);

test('the stash picker lists entries newest first and applies the picked index', async () => {
  const { picks, calls, stage } = setup();
  assert.equal(picks.openStashPicker('apply'), true);
  await settle();
  assert.deepEqual(rowNames(stage), ['On main: second', 'WIP on main: first']);
  assert.equal(stage.querySelector('[data-ide-git-quickpick="apply"] input').placeholder.includes('apply'), true);
  stage.querySelectorAll('[data-ide-git-pick-index]')[1].click();
  await settle();
  assert.deepEqual(calls.stash, [{ op: 'apply', index: 1 }]);
  assert.equal(calls.confirms.length, 0, 'apply does not ask');
  assert.equal(calls.refresh, 1);
  assert.equal(picks.isOpen(), false);
});

test('typing filters stashes by subject or ref; Enter pops the selected one', async () => {
  const { picks, calls, stage, doc } = setup();
  picks.openStashPicker('pop');
  await settle();
  const input = stage.querySelector('[data-ide-git-quickpick="pop"] input');
  input.value = 'first';
  input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  assert.deepEqual(rowNames(stage), ['WIP on main: first']);
  input.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.deepEqual(calls.stash, [{ op: 'pop', index: 1 }]);
});

test('drop asks first (danger) and does nothing when declined', async () => {
  const declined = setup({ confirm: false });
  await declined.picks.dropStash(STASHES[0]);
  assert.equal(declined.calls.confirms[0].variant, 'danger');
  assert.equal(declined.calls.stash.length, 0);
  const accepted = setup();
  await accepted.picks.dropStash(STASHES[0]);
  assert.deepEqual(accepted.calls.stash, [{ op: 'drop', index: 0 }]);
});

test('a stash pushed while the picker or confirm is open never shifts the action onto another entry', async () => {
  // Someone stashes meanwhile: the picked "second" (sha a…) moves from stash@{0} to stash@{1}.
  const shifted = [{ index: 0, ref: 'stash@{0}', sha: 'c'.repeat(40), subject: 'new', dateISO: '' }, ...STASHES.map((s) => ({ ...s, index: s.index + 1, ref: `stash@{${s.index + 1}}` }))];
  const moved = setup({ client: { listStashes: async () => ({ ok: true, stashes: shifted }) } });
  await moved.picks.dropStash(STASHES[0]);
  assert.deepEqual(moved.calls.stash, [{ op: 'drop', index: 1 }], 'the same stash, at its new index');
  const gone = setup({ client: { listStashes: async () => ({ ok: true, stashes: [STASHES[1]] }) } });
  await gone.picks.applyStash(STASHES[0]);
  assert.equal(gone.calls.stash.length, 0, 'a vanished stash is never acted on');
  assert.match(gone.calls.toasts[0], /no longer there/);
});

test('an empty stash list and a failed load say so', async () => {
  const empty = setup({ client: { listStashes: async () => ({ ok: true, stashes: [] }) } });
  empty.picks.openStashPicker('drop');
  await settle();
  assert.match(empty.stage.textContent, /There are no stashes/);
  const failed = setup({ client: { listStashes: async () => ({ ok: false }) } });
  failed.picks.openStashPicker('apply');
  await settle();
  assert.match(failed.stage.textContent, /Couldn.t load the stashes/);
});

test('a conflicting pop explains that the entry was kept', async () => {
  const { picks, calls } = setup({ client: { stash: async () => ({ ok: false, available: true, message: 'CONFLICT (content): Merge conflict in a.txt' }) } });
  await picks.popStash(STASHES[0]);
  assert.match(calls.errors[0], /conflicts with your changes/);
});

test('Delete Branch lists every branch but the current, confirms, then deletes with -d semantics', async () => {
  const { picks, calls, stage } = setup();
  picks.openDeleteBranchPicker();
  await settle();
  assert.deepEqual(rowNames(stage), ['feature/x', 'old']);
  stage.querySelectorAll('[data-ide-git-pick-index]')[1].click();
  await settle();
  assert.equal(calls.confirms[0].variant, 'danger');
  assert.deepEqual(calls.deleteBranch, [{ name: 'old' }]);
  assert.match(calls.toasts[0], /Deleted branch .old./);
});

test('an unmerged branch is kept and explained, never force-deleted', async () => {
  const { picks, calls } = setup({ client: { deleteBranch: async (payload) => { calls.deleteBranch.push(payload); return { ok: false, available: true, reason: 'not_fully_merged', message: '' }; } } });
  await picks.deleteBranch('topic');
  assert.match(calls.errors[0], /aren.t merged/);
  assert.equal(calls.refresh, 0);
  assert.deepEqual(calls.deleteBranch, [{ name: 'topic' }]);
});

test('a second action while one runs is refused with a busy toast', async () => {
  let release;
  const { picks, calls } = setup({ client: { stash: () => new Promise((resolve) => { release = resolve; }) } });
  const first = picks.applyStash(STASHES[0]);
  await settle();
  await picks.applyStash(STASHES[1]);
  assert.match(calls.toasts[0], /finishing the last git action/);
  release({ ok: true, stashed: true });
  await first;
});

test('pure helpers: filterRows and describeFailure', () => {
  assert.deepEqual(filterRows(STASHES, 'STASH@{1}', ['ref', 'subject']).map((row) => row.index), [1]);
  assert.equal(filterRows(STASHES, '', ['ref']).length, 2);
  assert.match(describeFailure({ available: false }, 'x'), /Git isn.t available/);
  assert.equal(describeFailure({ ok: false, message: '' }, 'fallback'), 'fallback');
});
