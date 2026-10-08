'use strict';

/* Changes view Undo/Redo (row 34 S5; design v3 §3, v6): the sheet is built
 * from stubbed recovery preflights, the switches change the requests, Redo
 * restores exactly what undo kept and never overwrites a changed file. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChangesUndo } = require('../renderer/features/renderer-changes-undo');
const undoPlan = require('../renderer/features/renderer-changes-undo-plan');
const { initToggleHandlers } = require('../renderer/inventory/toggle-switch');

const REF = 'refs/jenny/checkpoints/s1/1';
const ROLLBACK = 'refs/jenny/checkpoints/s1/2';
const TOKEN = 'a'.repeat(32);
const TOKEN_2 = 'b'.repeat(32);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function file(path, extra = {}) {
  return { path, fileKey: `ws:${path}`, created: false, sensitive: false, writers: ['edit'], changeIds: [`c-${path}`], afterHash: null, hashKind: '', restorePoint: null, ...extra };
}

function scriptFile(path, extra = {}) {
  return file(path, {
    writers: ['script'],
    afterHash: `sha256:${'1'.repeat(64)}`,
    hashKind: 'diff_input_text',
    restorePoint: { kind: 'git_checkpoint', ref: REF, createdAt: '2026-10-05T14:40:00Z' },
    ...extra,
  });
}

function step(id, kind, paths) {
  return { sequence: 1, inverse_step_id: id, kind, from_relative_path: paths.from || null, to_relative_path: paths.to || null, expected_current_signature: null };
}

function journalPreflight({ conflicts = [] } = {}) {
  return {
    ok: true,
    change_set_id: 'cs1',
    status: 'preflight',
    conflicts,
    inverse_plan: [
      step('s-a', 'restore_object', { to: 'a.js' }),
      step('s-b', 'restore_object', { to: 'b.js' }),
      step('s-n', 'remove_created', { from: 'notes.md' }),
      step('s-p', 'remove_empty_parent', { from: 'notes' }),
    ],
    staging_entries: [],
    outside_undo_set: [],
  };
}

const B_CONFLICT = {
  inverse_step_id: 's-b', sequence: 1, kind: 'restore_object', relative_path: 'b.js',
  reasons: ['source_changed'], allowed_outcomes: ['skip', 'alternate_name', 'protect_then_replace'],
};

function setup(api, extra = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="appShell"></div></body>');
  const toasts = [];
  const calls = [];
  const wrapped = {};
  for (const [name, impl] of Object.entries(api)) {
    wrapped[name] = async (payload) => {
      calls.push([name, payload]);
      return typeof impl === 'function' ? impl(payload) : impl;
    };
  }
  const undo = createChangesUndo({
    documentRef: dom.window.document,
    getApi: () => wrapped,
    getSessionId: () => 'session-1',
    showToast: (message, options) => toasts.push({ message, options }),
    formatTime: () => '2:41 PM',
    now: () => 1000,
    ...extra,
  });
  const doc = dom.window.document;
  // Production installs the inventory's switch handler on the document.
  initToggleHandlers(doc);
  const sheet = () => doc.querySelector('[data-step-modal="changes-undo-sheet"]');
  const groupText = (group) => {
    const section = doc.getElementById(`changesUndoGroup-${group}`)?.closest('section');
    return section ? Array.from(section.querySelectorAll('.changes-undo-row')).map((row) => row.querySelector('.changes-undo-path').textContent) : [];
  };
  const primary = () => doc.querySelector('[data-step-modal-action="confirm"]');
  const callsOf = (name) => calls.filter(([method]) => method === name).map(([, payload]) => payload);
  return { dom, doc, undo, toasts, calls, callsOf, sheet, groupText, primary };
}

const journalTurn = () => ({
  turnId: 't1', timeMs: 5000, title: 'Discount cap', changeSetIds: ['cs1'],
  files: [file('a.js'), file('b.js'), file('notes.md', { created: true })],
});

test('the sheet is built from the journal preflight: a conflict needs a call, a created file goes back by removal', async () => {
  const f = setup({ preflightUndo: journalPreflight({ conflicts: [B_CONFLICT] }) });
  await f.undo.openUndo(journalTurn(), { sessionId: 'session-1' });
  assert.ok(f.sheet(), 'the sheet opens');
  assert.deepEqual(f.groupText('back'), ['a.js', 'notes.md']);
  assert.deepEqual(f.groupText('call'), ['b.js']);
  const notes = Array.from(f.doc.querySelectorAll('.changes-undo-note')).map((el) => el.textContent);
  assert.ok(notes.includes('Jenny created this file, so undo removes it.'));
  assert.match(notes.find((text) => text.startsWith('You edited')), /left out unless you switch it on/);
  assert.equal(f.primary().textContent, 'Undo 2 files');
  assert.match(f.doc.querySelector('.changes-undo-outside').textContent, /installed packages/);
  const track = f.doc.querySelector('[data-changes-undo-row] [data-inv-toggle]');
  assert.equal(track.getAttribute('aria-checked'), 'false', 'needs-your-call files are left out by default');
});

test('the switch decides the conflict outcome sent with the undo', async () => {
  for (const switchOn of [false, true]) {
    const f = setup({
      preflightUndo: journalPreflight({ conflicts: [B_CONFLICT] }),
      undoChangeSet: { ok: true, status: 'committed', change_set_id: 'cs1', restored: [{ inverse_step_id: 's-a', relative_path: 'a.js' }, { inverse_step_id: 's-n', relative_path: 'notes.md' }].concat(switchOn ? [{ inverse_step_id: 's-b', relative_path: 'b.js' }] : []), skipped: [], renamed_to: [], protected: [], outside_undo_set: [], safety_copy: { token: TOKEN, paths: ['a.js', 'notes.md'], unavailable: [] } },
    });
    await f.undo.openUndo(journalTurn(), {});
    if (switchOn) {
      f.doc.querySelector('[data-inv-toggle]').click();
      assert.equal(f.doc.querySelector('[data-inv-toggle]').getAttribute('aria-checked'), 'true', 'the switch shows what will be sent');
      assert.equal(f.primary().textContent, 'Undo 3 files');
    }
    f.primary().click();
    await settle();
    await settle();
    const [request] = f.callsOf('undoChangeSet');
    assert.deepEqual(request, {
      changeSetId: 'cs1',
      decisions: { 's-b': switchOn ? 'protect_then_replace' : 'skip' },
      captureSafetyCopy: true,
    });
    assert.equal(f.callsOf('preflightUndo').length, 2, 'a fresh preflight runs right before the undo');
    const state = f.undo.getUndoStates('session-1').t1;
    assert.equal(state.status, 'undone');
    assert.equal(state.files['b.js'], switchOn ? 'undone' : 'kept');
    assert.equal(state.canRedo, true);
    assert.equal(f.toasts.at(-1).message, switchOn ? 'Undid 3 files.' : 'Undid 2 files. 1 kept.');
    assert.equal(f.toasts.at(-1).options.actions[0].label, 'Redo');
  }
});

test('Cancel and Escape change nothing', async () => {
  const f = setup({ preflightUndo: journalPreflight() });
  await f.undo.openUndo(journalTurn(), {});
  f.doc.querySelector('[data-step-modal-action="cancel"]').click();
  assert.equal(f.sheet(), null);
  await f.undo.openUndo(journalTurn(), {});
  f.doc.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(f.sheet(), null);
  assert.equal(f.callsOf('undoChangeSet').length, 0);
});

test('a later Jenny turn that changed the file is named instead of blaming the user', async () => {
  const f = setup({ preflightUndo: journalPreflight({ conflicts: [B_CONFLICT] }) });
  const turn = journalTurn();
  const later = { turnId: 't2', timeMs: 9000, files: [file('b.js')] };
  await f.undo.openUndo(turn, { history: { turns: [later, turn] } });
  const note = f.doc.querySelector('.changes-undo-row--warn .changes-undo-note').textContent;
  assert.equal(note, "A later turn (2:41 PM) changed this file too. Undoing it would also remove that change, so it's left out unless you switch it on.");
});

test('script files: restored from the checkpoint, new files stay unless "Delete it too", no copy cannot be undone', async () => {
  const turn = {
    turnId: 't3', timeMs: 5000, changeSetIds: [],
    files: [
      scriptFile('settings.py'),
      scriptFile('tests/test_pricing.py', { created: true }),
      scriptFile('data/export.csv', { restorePoint: { kind: 'none', reason: 'not_git' } }),
    ],
  };
  const f = setup({
    preflightCheckpointFiles: { ok: true, files: [
      { path: 'settings.py', inCheckpoint: 'tracked', exists: true, kind: 'file', size: 9, mtimeMs: 1, matchesCheckpoint: false, matchesAfter: true },
      { path: 'tests/test_pricing.py', inCheckpoint: 'absent', exists: true, kind: 'file', size: 9, mtimeMs: 1, matchesCheckpoint: false, matchesAfter: true },
    ] },
    restoreCheckpointFiles: { ok: true, rollbackRef: ROLLBACK, restored: ['settings.py'], removed: ['tests/test_pricing.py'], failed: [] },
  });
  assert.equal(f.undo.canUndoTurn(turn, 'session-1'), true);
  await f.undo.openUndo(turn, {});
  assert.deepEqual(f.callsOf('preflightCheckpointFiles'), [{ ref: REF, files: [
    { path: 'settings.py', afterHash: `sha256:${'1'.repeat(64)}`, hashKind: 'diff_input_text' },
    { path: 'tests/test_pricing.py', afterHash: `sha256:${'1'.repeat(64)}`, hashKind: 'diff_input_text' },
  ] }], 'only files with a checkpoint are checked');
  assert.deepEqual(f.groupText('back'), ['settings.py']);
  assert.deepEqual(f.groupText('stays'), ['tests/test_pricing.py']);
  assert.deepEqual(f.groupText('cannot'), ['data/export.csv']);
  assert.match(f.doc.body.textContent, /this folder isn't a git repository/);
  assert.match(f.doc.body.textContent, /Restored from the safety copy taken at 2:41 PM\./);
  f.doc.querySelector('[data-inv-toggle]').click();
  assert.equal(f.primary().textContent, 'Undo 2 files');
  f.primary().click();
  await settle();
  await settle();
  assert.deepEqual(f.callsOf('restoreCheckpointFiles'), [{ ref: REF, paths: ['settings.py'], removePaths: ['tests/test_pricing.py'] }]);
  assert.deepEqual(f.undo.getUndoStates('session-1').t3.files, { 'settings.py': 'undone', 'tests/test_pricing.py': 'undone', 'data/export.csv': 'kept' });
});

test('a turn where nothing can go back has no Undo', () => {
  const f = setup({});
  const turn = { turnId: 't4', changeSetIds: [], files: [scriptFile('fixtures/a.json', { restorePoint: { kind: 'none', reason: 'not_git' } })] };
  assert.equal(f.undo.canUndoTurn(turn, 'session-1'), false);
});

async function undoneJournalTurn(api) {
  const f = setup({
    preflightUndo: journalPreflight(),
    undoChangeSet: { ok: true, status: 'committed', change_set_id: 'cs1', restored: [{ inverse_step_id: 's-a', relative_path: 'a.js' }, { inverse_step_id: 's-b', relative_path: 'b.js' }], skipped: [], renamed_to: [], protected: [], outside_undo_set: [], safety_copy: { token: TOKEN, paths: ['a.js', 'b.js'], unavailable: [] } },
    ...api,
  });
  const turn = journalTurn();
  await f.undo.openUndo(turn, {});
  f.primary().click();
  await settle();
  await settle();
  return { f, turn };
}

test('Redo restores exactly what undo kept when nothing changed since', async () => {
  const { f, turn } = await undoneJournalTurn({
    preflightSafetyCopy: { ok: true, files: [{ path: 'a.js', unchanged: true, mtimeMs: 1 }, { path: 'b.js', unchanged: true, mtimeMs: 1 }] },
    restoreSafetyCopy: { ok: true, restored: ['a.js', 'b.js'], failed: [], safety_copy: { token: TOKEN_2, paths: ['a.js', 'b.js'], unavailable: [] } },
  });
  await f.undo.redo(turn, { sessionId: 'session-1' });
  assert.equal(f.sheet(), null, 'nothing changed: no sheet');
  assert.deepEqual(f.callsOf('restoreSafetyCopy'), [{ token: TOKEN, paths: ['a.js', 'b.js'] }]);
  assert.equal(f.undo.getUndoStates('session-1').t1.status, 'applied');
  assert.equal(f.undo.canUndoTurn(turn, 'session-1'), true, 'undo again uses the copy kept by the redo');
  assert.equal(f.toasts.at(-1).message, 'Redid 2 files.');
});

test('Redo never overwrites a file changed since the undo: it opens the sheet instead', async () => {
  const { f, turn } = await undoneJournalTurn({
    preflightSafetyCopy: { ok: true, files: [{ path: 'a.js', unchanged: true, mtimeMs: 1 }, { path: 'b.js', unchanged: false, mtimeMs: 2 }] },
    restoreSafetyCopy: { ok: true, restored: ['a.js'], failed: [], safety_copy: { token: TOKEN_2, paths: ['a.js'], unavailable: [] } },
  });
  await f.undo.redo(turn, {});
  assert.ok(f.sheet());
  assert.deepEqual(f.groupText('back'), ['a.js']);
  assert.deepEqual(f.groupText('stays'), ['b.js']);
  assert.equal(f.primary().textContent, 'Redo 1 file');
  f.primary().click();
  await settle();
  assert.deepEqual(f.callsOf('restoreSafetyCopy'), [{ token: TOKEN, paths: ['a.js'] }]);
  assert.equal(f.toasts.at(-1).message, 'Redid 1 file. 1 kept.');
});

test('every file changed since the undo: Redo goes away', async () => {
  const { f, turn } = await undoneJournalTurn({
    preflightSafetyCopy: { ok: true, files: [{ path: 'a.js', unchanged: false, mtimeMs: 2 }, { path: 'b.js', unchanged: false, mtimeMs: 2 }] },
  });
  await f.undo.redo(turn, {});
  assert.equal(f.sheet(), null);
  assert.equal(f.callsOf('restoreSafetyCopy').length, 0);
  assert.equal(f.undo.getUndoStates('session-1').t1.canRedo, false);
});

test('a checkpoint undo redoes from its rollback copy, removing files that did not exist before', () => {
  const plan = { rows: [
    { key: 'u0', path: 'settings.py', source: 'checkpoint', ref: REF, group: 'back', inRef: true, exists: true },
    { key: 'u1', path: 'gone.txt', source: 'checkpoint', ref: REF, group: 'back', inRef: true, exists: false },
  ], journalSetIds: [] };
  const [request] = undoPlan.checkpointRestores(plan, {});
  const summary = undoPlan.summarizeUndo(plan, {}, { journal: [], checkpoint: [{ request, result: { ok: true, rollbackRef: ROLLBACK, restored: ['settings.py', 'gone.txt'], removed: [], failed: [] } }] });
  assert.deepEqual(summary.swap.checkpoint, [{ ref: ROLLBACK, verifyRef: REF, paths: [{ path: 'settings.py', inRef: true }, { path: 'gone.txt', inRef: false }] }]);
  const verified = undoPlan.verifySwap(summary.swap, [], [{ ok: true, files: [
    { path: 'settings.py', inCheckpoint: 'tracked', exists: true, matchesCheckpoint: true },
    { path: 'gone.txt', inCheckpoint: 'tracked', exists: true, matchesCheckpoint: true },
  ] }]);
  const requests = undoPlan.swapRequests(summary.swap, verified);
  assert.deepEqual(requests.checkpoint.map(({ ref, paths, removePaths }) => ({ ref, paths, removePaths })), [{ ref: ROLLBACK, paths: ['settings.py'], removePaths: ['gone.txt'] }]);
});

test('Redo covers only the files the undo changed, not the ones the user kept', () => {
  const plan = { rows: [
    { key: 'u0', path: 'a.js', source: 'journal', group: 'back' },
    { key: 'u1', path: 'b.js', source: 'journal', group: 'call' },
  ], journalSetIds: ['cs1'] };
  const receipt = { ok: true, status: 'committed', restored: [{ inverse_step_id: 's-a', relative_path: 'a.js' }], skipped: [{ inverse_step_id: 's-b', relative_path: 'b.js' }], renamed_to: [], protected: [], safety_copy: { token: TOKEN, paths: ['a.js', 'b.js'], unavailable: [] } };
  const summary = undoPlan.summarizeUndo(plan, {}, { journal: [receipt], checkpoint: [] });
  assert.deepEqual(summary.swap.journal, [{ token: TOKEN, paths: ['a.js'] }]);
  assert.deepEqual(summary.files, { 'a.js': 'undone', 'b.js': 'kept' });
});

test('after a restart a journal-undone turn reads "undone" without Redo', async () => {
  // updated_at moves with retention touches; the undo time is when the restore completed.
  const f = setup({ listChangeSets: { ok: true, workspace_id: 'w', change_sets: [{ change_set_id: 'cs1', state: 'rolled_back', restore_status: 'committed', operation_count: 3, updated_at: '2026-10-06T09:00:00Z', restore_completed_at: '2026-10-05T14:52:00Z', partially_undoable: false, warning: '' }], outside_undo_set: [] } });
  const turn = journalTurn();
  f.undo.canUndoTurn(turn, 'session-1');
  await settle();
  await settle();
  assert.equal(f.undo.canUndoTurn(turn, 'session-1'), false);
  const state = f.undo.getUndoStates('session-1').t1;
  assert.equal(state.status, 'undone');
  assert.equal(state.canRedo, false);
  assert.equal(state.undoneAt, Date.parse('2026-10-05T14:52:00Z'));
});

test('an older sidecar without the restore completion time falls back to updated_at', async () => {
  const f = setup({ listChangeSets: { ok: true, workspace_id: 'w', change_sets: [{ change_set_id: 'cs1', state: 'rolled_back', restore_status: 'committed', operation_count: 3, updated_at: '2026-10-05T14:52:00Z', partially_undoable: false, warning: '' }], outside_undo_set: [] } });
  const turn = journalTurn();
  f.undo.canUndoTurn(turn, 'session-1');
  await settle();
  await settle();
  assert.equal(f.undo.getUndoStates('session-1').t1.undoneAt, Date.parse('2026-10-05T14:52:00Z'));
});

const REDO_ALL = {
  preflightSafetyCopy: { ok: true, files: [{ path: 'a.js', unchanged: true, mtimeMs: 1 }, { path: 'b.js', unchanged: true, mtimeMs: 1 }] },
  restoreSafetyCopy: { ok: true, restored: ['a.js', 'b.js'], failed: [], safety_copy: { token: TOKEN_2, paths: ['a.js', 'b.js'], unavailable: [] } },
};

test('Redo of a journal undo re-arms the change set, so the next Undo runs from the journal', async () => {
  const { f, turn } = await undoneJournalTurn({
    ...REDO_ALL,
    reapplyChangeSet: { ok: true, change_set_id: 'cs1', state: 'committed', restore_status: 'not_requested', operation_count: 3, updated_at: '2026-10-05T15:00:00Z', restore_completed_at: null, partially_undoable: false, warning: '' },
  });
  await f.undo.redo(turn, { sessionId: 'session-1' });
  assert.deepEqual(f.callsOf('reapplyChangeSet'), [{ changeSetId: 'cs1' }]);
  assert.deepEqual(f.callsOf('restoreSafetyCopy'), [{ token: TOKEN, paths: ['a.js', 'b.js'] }]);
  assert.equal(f.undo.getUndoStates('session-1').t1.status, 'applied');
  assert.equal(f.undo.canUndoTurn(turn, 'session-1'), true);
  assert.equal(f.toasts.at(-1).message, 'Redid 2 files.');
  const preflights = f.callsOf('preflightUndo').length;
  await f.undo.openUndo(turn, { sessionId: 'session-1' });
  assert.equal(f.callsOf('preflightUndo').length, preflights + 1, 'Undo prepares from the journal again');
  assert.equal(f.callsOf('preflightSafetyCopy').length, 1, 'not from the redo copy');
  assert.ok(f.sheet());
});

test('a refused re-apply keeps the in-memory Redo swap without an error toast', async () => {
  const { f, turn } = await undoneJournalTurn({
    ...REDO_ALL,
    reapplyChangeSet: { ok: false, reason: 'reapply_state_mismatch' },
  });
  await f.undo.redo(turn, { sessionId: 'session-1' });
  assert.equal(f.callsOf('reapplyChangeSet').length, 1);
  assert.equal(f.toasts.at(-1).message, 'Redid 2 files.');
  assert.equal(f.undo.getUndoStates('session-1').t1.status, 'applied');
  await f.undo.openUndo(turn, { sessionId: 'session-1' });
  assert.equal(f.callsOf('preflightSafetyCopy').length, 2, 'Undo again checks the redo copy');
  assert.equal(f.callsOf('preflightUndo').length, 2, 'not the journal');
  f.primary().click();
  await settle();
  await settle();
  assert.equal(f.callsOf('restoreSafetyCopy').at(-1).token, TOKEN_2, 'and swaps back to it');
  assert.equal(f.callsOf('reapplyChangeSet').length, 1, 'an undo swap never re-arms');
});

test('Redo that left a file behind does not re-arm that change set', async () => {
  const { f, turn } = await undoneJournalTurn({
    preflightSafetyCopy: { ok: true, files: [{ path: 'a.js', unchanged: true, mtimeMs: 1 }, { path: 'b.js', unchanged: false, mtimeMs: 2 }] },
    restoreSafetyCopy: { ok: true, restored: ['a.js'], failed: [], safety_copy: { token: TOKEN_2, paths: ['a.js'], unavailable: [] } },
    reapplyChangeSet: { ok: true },
  });
  await f.undo.redo(turn, {});
  f.primary().click();
  await settle();
  await settle();
  assert.equal(f.callsOf('restoreSafetyCopy').length, 1);
  assert.equal(f.callsOf('reapplyChangeSet').length, 0);
});

// Two change sets in one turn: cs1 wrote a.js, cs2 wrote c.js.
const TOKEN_3 = 'c'.repeat(32);
const SET_FILE = { cs1: 'a.js', cs2: 'c.js' };
const SET_TOKEN = { cs1: TOKEN, cs2: TOKEN_3 };

async function undoneTwoSetTurn(api) {
  const f = setup({
    preflightUndo: ({ changeSetId }) => ({ ...journalPreflight(), change_set_id: changeSetId, inverse_plan: [step(`s-${changeSetId}`, 'restore_object', { to: SET_FILE[changeSetId] })] }),
    undoChangeSet: ({ changeSetId }) => ({ ok: true, status: 'committed', change_set_id: changeSetId, restored: [{ inverse_step_id: `s-${changeSetId}`, relative_path: SET_FILE[changeSetId] }], skipped: [], renamed_to: [], protected: [], outside_undo_set: [], safety_copy: { token: SET_TOKEN[changeSetId], paths: [SET_FILE[changeSetId]], unavailable: [] } }),
    restoreSafetyCopy: ({ paths }) => ({ ok: true, restored: paths, failed: [], safety_copy: { token: paths[0] === 'a.js' ? 'd'.repeat(32) : 'e'.repeat(32), paths, unavailable: [] } }),
    ...api,
  });
  const turn = { turnId: 't1', timeMs: 5000, title: 'Two sets', changeSetIds: ['cs1', 'cs2'], files: [file('a.js'), file('c.js')] };
  await f.undo.openUndo(turn, {});
  f.primary().click();
  await settle();
  await settle();
  return { f, turn };
}

const unchangedCopy = ({ token }) => ({ ok: true, files: [{ path: token === TOKEN || token === 'd'.repeat(32) ? 'a.js' : 'c.js', unchanged: true, mtimeMs: 1 }] });

test('a Redo that re-arms one change set but not the other keeps the whole swap for the next Undo', async () => {
  const { f, turn } = await undoneTwoSetTurn({
    preflightSafetyCopy: unchangedCopy,
    reapplyChangeSet: ({ changeSetId }) => (changeSetId === 'cs1' ? { ok: true } : { ok: false, reason: 'reapply_protected_occupant' }),
  });
  await f.undo.redo(turn, {});
  assert.equal(f.callsOf('reapplyChangeSet').length, 2);
  assert.equal(f.undo.getUndoStates('session-1').t1.status, 'applied');
  const restores = f.callsOf('restoreSafetyCopy').length;
  await f.undo.openUndo(turn, {});
  f.primary().click();
  await settle();
  await settle();
  const undoTokens = f.callsOf('restoreSafetyCopy').slice(restores).map((call) => call.token).sort();
  assert.deepEqual(undoTokens, ['d'.repeat(32), 'e'.repeat(32)], 'the next Undo restores both files, not only the refused set');
});

test('a Redo that leaves one change set behind re-arms none', async () => {
  const { f, turn } = await undoneTwoSetTurn({
    preflightSafetyCopy: ({ token }) => (token === TOKEN ? unchangedCopy({ token }) : { ok: true, files: [{ path: 'c.js', unchanged: false, mtimeMs: 2 }] }),
    reapplyChangeSet: { ok: true },
  });
  await f.undo.redo(turn, {});
  f.primary().click();
  await settle();
  await settle();
  assert.deepEqual(f.callsOf('restoreSafetyCopy').at(-1), { token: TOKEN, paths: ['a.js'] });
  assert.equal(f.callsOf('reapplyChangeSet').length, 0, 'cs1 alone would make the next Undo skip it');
});

test('after a restart a re-applied turn reads applied with Undo available', async () => {
  const f = setup({ listChangeSets: { ok: true, workspace_id: 'w', change_sets: [{ change_set_id: 'cs1', state: 'committed', restore_status: 'not_requested', operation_count: 3, updated_at: '2026-10-05T15:00:00Z', restore_completed_at: null, partially_undoable: false, warning: '' }], outside_undo_set: [] } });
  const turn = journalTurn();
  f.undo.canUndoTurn(turn, 'session-1');
  await settle();
  await settle();
  assert.equal(f.callsOf('listChangeSets').length, 1);
  assert.equal(f.undo.canUndoTurn(turn, 'session-1'), true);
  assert.equal(f.undo.getUndoStates('session-1').t1, undefined, 'no undone state: the turn reads applied');
});

test('a failed preflight changes nothing and says so', async () => {
  const f = setup({ preflightUndo: { ok: false, reason: 'change_set_not_found' } });
  await f.undo.openUndo(journalTurn(), {});
  assert.equal(f.sheet(), null);
  assert.equal(f.toasts.at(-1).message, "Couldn't prepare the undo. Nothing was changed.");
  assert.equal(f.undo.getUndoStates('session-1').t1.busy, false);
});

test('states are per session', async () => {
  const { f } = await undoneJournalTurn({});
  assert.ok(f.undo.getUndoStates('session-1').t1);
  assert.equal(f.undo.getUndoStates('session-2').t1, undefined);
});

test('dispose closes an open sheet', async () => {
  const f = setup({ preflightUndo: journalPreflight() });
  await f.undo.openUndo(journalTurn(), {});
  f.undo.dispose();
  assert.equal(f.sheet(), null);
});

test('a file two change sets touched redoes oldest copy first, checked against the last one recorded', () => {
  // Undo ran cs2 (newest) then cs1: copy 0 expects the mid state, copy 1 the original.
  const swap = { journal: [{ token: TOKEN, paths: ['a.js'] }, { token: TOKEN_2, paths: ['a.js'] }], checkpoint: [] };
  const checks = (head) => [{ ok: true, files: [{ path: 'a.js', unchanged: false }] }, { ok: true, files: [{ path: 'a.js', unchanged: head }] }];
  const verified = undoPlan.verifySwap(swap, checks(true), []);
  assert.deepEqual(verified.map((row) => row.unchanged), [true, true], 'one verdict per file');
  assert.deepEqual(undoPlan.swapRequests(swap, verified).journal, [{ token: TOKEN_2, paths: ['a.js'] }, { token: TOKEN, paths: ['a.js'] }]);
  assert.deepEqual(undoPlan.swapRequests(swap, undoPlan.verifySwap(swap, checks(false), [])).journal, []);
});

test('a script file saved while the sheet sat open is left alone', async () => {
  let checks = 0;
  const turn = { turnId: 't5', timeMs: 5000, changeSetIds: [], files: [scriptFile('settings.py'), scriptFile('config.py')] };
  const f = setup({
    preflightCheckpointFiles: () => {
      checks += 1;
      return { ok: true, files: [
        { path: 'settings.py', inCheckpoint: 'tracked', exists: true, kind: 'file', size: 9, mtimeMs: checks === 1 ? 1 : 2, matchesCheckpoint: false, matchesAfter: true },
        { path: 'config.py', inCheckpoint: 'tracked', exists: true, kind: 'file', size: 9, mtimeMs: 1, matchesCheckpoint: false, matchesAfter: true },
      ] };
    },
    restoreCheckpointFiles: { ok: true, rollbackRef: ROLLBACK, restored: ['config.py'], removed: [], failed: [] },
  });
  await f.undo.openUndo(turn, {});
  f.primary().click();
  await settle();
  await settle();
  assert.deepEqual(f.callsOf('restoreCheckpointFiles'), [{ ref: REF, paths: ['config.py'] }]);
  assert.deepEqual(f.undo.getUndoStates('session-1').t5.files, { 'settings.py': 'kept', 'config.py': 'undone' });
});

test("an undo toast's Redo does nothing once a later Redo replaced its copy", async () => {
  const { f, turn } = await undoneJournalTurn({
    preflightSafetyCopy: { ok: true, files: [{ path: 'a.js', unchanged: true, mtimeMs: 1 }, { path: 'b.js', unchanged: true, mtimeMs: 1 }] },
    restoreSafetyCopy: { ok: true, restored: ['a.js', 'b.js'], failed: [], safety_copy: { token: TOKEN_2, paths: ['a.js', 'b.js'], unavailable: [] } },
  });
  const firstToast = f.toasts.find((toast) => toast.options?.actions?.length);
  await f.undo.redo(turn, { sessionId: 'session-1' });
  await f.undo.openUndo(turn, { sessionId: 'session-1' });
  f.primary().click();
  await settle();
  await settle();
  assert.equal(f.undo.getUndoStates('session-1').t1.status, 'undone');
  assert.equal(f.callsOf('restoreSafetyCopy').length, 2);
  await firstToast.options.actions[0].onClick();
  await settle();
  assert.equal(f.callsOf('restoreSafetyCopy').length, 2, 'the stale toast did not redo the newer undo');
});

test('Redo of a moved-back file covers both ends of the move', () => {
  const plan = { rows: [{ key: 'u0', path: 'a.txt', source: 'journal', group: 'back', how: 'move', from: 'b.txt' }], journalSetIds: ['cs1'] };
  const receipt = { ok: true, status: 'committed', restored: [{ inverse_step_id: 's-m', relative_path: 'a.txt' }], skipped: [], renamed_to: [], protected: [], safety_copy: { token: TOKEN, paths: ['a.txt', 'b.txt'], unavailable: [] } };
  const summary = undoPlan.summarizeUndo(plan, {}, { journal: [receipt], checkpoint: [] });
  assert.deepEqual(summary.swap.journal, [{ token: TOKEN, paths: ['a.txt', 'b.txt'] }]);
});

test('a script edit then a typed edit to one file redo in order: checkpoint first, then the journal copy', () => {
  // Undo ran the journal (C -> B) then the checkpoint (B -> A).
  const swap = { journal: [{ token: TOKEN, paths: ['f.py'] }], checkpoint: [{ ref: ROLLBACK, verifyRef: REF, paths: [{ path: 'f.py', inRef: true }] }], journalFirst: true };
  const journalCheck = [{ ok: true, files: [{ path: 'f.py', unchanged: false }] }];
  const checkpointCheck = [{ ok: true, files: [{ path: 'f.py', inCheckpoint: 'tracked', exists: true, matchesCheckpoint: true }] }];
  const verified = undoPlan.verifySwap(swap, journalCheck, checkpointCheck);
  assert.deepEqual(verified.map((row) => row.unchanged), [true, true], 'checked against the checkpoint, which runs first');
  const requests = undoPlan.swapRequests(swap, verified);
  assert.equal(requests.checkpointFirst, true);
  assert.deepEqual(requests.journal, [{ token: TOKEN, paths: ['f.py'] }]);
  const next = undoPlan.summarizeSwap(requests, {
    checkpoint: [{ ok: true, rollbackRef: 'refs/jenny/checkpoints/s1/3', restored: ['f.py'], removed: [] }],
    journal: [{ ok: true, restored: ['f.py'], safety_copy: { token: TOKEN_2, paths: ['f.py'], unavailable: [] } }],
  });
  assert.equal(next.swap.journalFirst, false, 'undo after this redo runs the journal copy first');
  const again = undoPlan.verifySwap(next.swap, [{ ok: true, files: [{ path: 'f.py', unchanged: true }] }], [{ ok: true, files: [{ path: 'f.py', inCheckpoint: 'tracked', exists: true, matchesCheckpoint: false }] }]);
  assert.deepEqual(again.map((row) => row.unchanged), [true, true]);
  assert.equal(undoPlan.swapRequests(next.swap, again).checkpointFirst, false);
});

test('a Redo check that could not run keeps Redo and says so', async () => {
  const { f, turn } = await undoneJournalTurn({ preflightSafetyCopy: () => { throw new Error('transport'); } });
  await f.undo.redo(turn, { sessionId: 'session-1' });
  assert.equal(f.callsOf('restoreSafetyCopy').length, 0);
  assert.equal(f.undo.getUndoStates('session-1').t1.canRedo, true);
  assert.equal(f.toasts.at(-1).message, "Couldn't check the files, so nothing was changed. Try again.");
});
