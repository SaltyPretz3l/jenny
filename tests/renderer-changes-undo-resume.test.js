'use strict';

/* A19-F3 / A16-F3: a journal Undo that stopped partway stays resumable. The
 * History Undo says so (not "Nothing was undone"), stops before older change
 * sets, keeps Undo available, and the next Undo takes the resume route. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { createChangesUndo } = require('../renderer/features/renderer-changes-undo');
const { initToggleHandlers } = require('../renderer/inventory/toggle-switch');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { createRecoveryHarness } = require('./helpers/workspace-recovery-harness');

const TOKEN = 'a'.repeat(32);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function file(path) {
  return { path, fileKey: `ws:${path}`, created: false, sensitive: false, writers: ['edit'], changeIds: [`c-${path}`], afterHash: null, hashKind: '', restorePoint: null };
}

function step(id, to) {
  return { sequence: 1, inverse_step_id: id, kind: 'restore_object', from_relative_path: null, to_relative_path: to, expected_current_signature: null };
}

function preflight(changeSetId, plan) {
  return { ok: true, change_set_id: changeSetId, status: 'preflight', conflicts: [], inverse_plan: plan, staging_entries: [], outside_undo_set: [] };
}

function setup(t, api) {
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
  });
  t.after(() => undo.dispose());
  initToggleHandlers(dom.window.document);
  const confirm = async () => {
    dom.window.document.querySelector('[data-step-modal-action="confirm"]').click();
    await settle();
    await settle();
  };
  const callsOf = (name) => calls.filter(([method]) => method === name).map(([, payload]) => payload);
  return { undo, toasts, confirm, callsOf, doc: dom.window.document };
}

test('a stopped journal undo says it can be finished, stops older sets, and resumes on the next Undo', async (t) => {
  let attempts = 0;
  const f = setup(t, {
    preflightUndo: ({ changeSetId }) => (changeSetId === 'cs2'
      ? preflight('cs2', attempts ? [step('1.2', 'b.js')] : [step('1.1', 'a.js'), step('1.2', 'b.js')])
      : preflight('cs1', [step('1.1', 'c.js')])),
    undoChangeSet: ({ changeSetId }) => {
      if (changeSetId === 'cs2' && attempts++ === 0) {
        return { ok: false, reason: 'restore_io_failed', status: 'in_progress', message: 'Undo stopped before it finished.' };
      }
      return {
        ok: true, status: 'committed', change_set_id: changeSetId,
        restored: changeSetId === 'cs2'
          ? [{ inverse_step_id: '1.1', relative_path: 'a.js' }, { inverse_step_id: '1.2', relative_path: 'b.js' }]
          : [{ inverse_step_id: '1.1', relative_path: 'c.js' }],
        skipped: [], renamed_to: [], protected: [], outside_undo_set: [],
        safety_copy: { token: TOKEN, paths: changeSetId === 'cs2' ? ['a.js', 'b.js'] : ['c.js'], unavailable: [] },
      };
    },
  });
  const turn = { turnId: 't1', timeMs: 5000, title: 'Two sets', changeSetIds: ['cs1', 'cs2'], files: [file('a.js'), file('b.js'), file('c.js')] };

  await f.undo.openUndo(turn, {});
  await f.confirm();

  assert.deepEqual(f.callsOf('undoChangeSet').map((request) => request.changeSetId), ['cs2'], 'the older set never runs over the stopped one');
  assert.equal(f.toasts.at(-1).message, 'Undo stopped partway. Undo again to finish it.');
  assert.equal(f.toasts.at(-1).options.tone, 'warning');
  assert.equal(f.undo.canUndoTurn(turn), true);
  assert.notEqual(f.undo.getUndoStates('session-1').t1?.status, 'undone');

  await f.undo.openUndo(turn, {});
  await f.confirm();

  assert.deepEqual(f.callsOf('undoChangeSet').map((request) => request.changeSetId), ['cs2', 'cs2', 'cs1']);
  const state = f.undo.getUndoStates('session-1').t1;
  assert.equal(state.status, 'undone');
  assert.equal(state.canRedo, true);
});

const REF = 'b'.repeat(40);

function scriptFile(path) {
  return { ...file(path), writers: ['shell'], restorePoint: { kind: 'git_checkpoint', ref: REF, createdAt: 4000 } };
}

const committed = (changeSetId, paths) => ({
  ok: true, status: 'committed', change_set_id: changeSetId,
  restored: paths.map((path, index) => ({ inverse_step_id: `1.${index + 1}`, relative_path: path })),
  skipped: [], renamed_to: [], protected: [], outside_undo_set: [],
  safety_copy: { token: changeSetId === 'cs2' ? TOKEN : 'c'.repeat(32), paths, unavailable: [] },
});

test('when the newest set undid and an older one stopped, the turn stays resumable and the retry runs only the older set', async (t) => {
  let cs1Attempts = 0;
  const f = setup(t, {
    preflightUndo: ({ changeSetId }) => (changeSetId === 'cs2'
      ? preflight('cs2', [step('1.1', 'a.js')])
      : preflight('cs1', [step('1.1', 'c.js')])),
    undoChangeSet: ({ changeSetId }) => {
      if (changeSetId === 'cs1' && cs1Attempts++ === 0) {
        return { ok: false, reason: 'restore_io_failed', status: 'in_progress', message: 'Undo stopped before it finished.' };
      }
      return committed(changeSetId, changeSetId === 'cs2' ? ['a.js'] : ['c.js']);
    },
    preflightCheckpointFiles: { ok: true, files: [
      { path: 's.sh', inCheckpoint: 'tracked', exists: true, kind: 'file', size: 9, mtimeMs: 1, matchesCheckpoint: false, matchesAfter: true },
    ] },
    restoreCheckpointFiles: { ok: true, rollbackRef: 'd'.repeat(40), restored: ['s.sh'], removed: [], failed: [] },
  });
  const turn = { turnId: 't2', timeMs: 5000, title: 'Two sets and a script', changeSetIds: ['cs1', 'cs2'], files: [file('a.js'), file('c.js'), scriptFile('s.sh')] };

  await f.undo.openUndo(turn, {});
  await f.confirm();

  assert.deepEqual(f.callsOf('undoChangeSet').map((request) => request.changeSetId), ['cs2', 'cs1']);
  assert.deepEqual(f.callsOf('restoreCheckpointFiles'), [], 'checkpoint files wait for the stopped journal undo');
  assert.equal(f.toasts.at(-1).message, 'Undo stopped partway. Undo again to finish it.');
  assert.equal(f.toasts.at(-1).options.tone, 'warning');
  assert.equal(f.undo.canUndoTurn(turn), true, 'Undo stays available to finish it');
  assert.notEqual(f.undo.getUndoStates('session-1').t2?.status, 'undone');

  const preflightsBefore = f.callsOf('preflightUndo').length;
  await f.undo.openUndo(turn, {});
  assert.deepEqual(f.callsOf('preflightUndo').slice(preflightsBefore).map((request) => request.changeSetId), ['cs1'],
    'the finished newer set is not prepared again');
  await f.confirm();

  assert.deepEqual(f.callsOf('undoChangeSet').map((request) => request.changeSetId), ['cs2', 'cs1', 'cs1']);
  assert.equal(f.callsOf('restoreCheckpointFiles').length, 1);
  const state = f.undo.getUndoStates('session-1').t2;
  assert.equal(state.status, 'undone');
  assert.deepEqual(state.files, { 'a.js': 'undone', 'c.js': 'undone', 's.sh': 'undone' });
  assert.equal(state.canRedo, true);
  assert.equal(f.toasts.at(-1).message, 'Undid 3 files.');
});

// The older set's fresh preflight meets another running change once
// (`restore_workspace_busy`): the turn keeps the newer set's Undo, runs no
// checkpoint restore, and the retry runs only the older set.
test('a busy fresh preflight of an older set keeps the turn resumable and the retry skips the finished set', async (t) => {
  let cs1Preflights = 0;
  const f = setup(t, {
    preflightUndo: ({ changeSetId }) => {
      if (changeSetId === 'cs2') return preflight('cs2', [step('1.1', 'a.js')]);
      if (++cs1Preflights === 2) return { ok: false, reason: 'restore_workspace_busy', message: 'Another change is running.' };
      return preflight('cs1', [step('1.1', 'c.js')]);
    },
    undoChangeSet: ({ changeSetId }) => committed(changeSetId, changeSetId === 'cs2' ? ['a.js'] : ['c.js']),
    preflightCheckpointFiles: { ok: true, files: [
      { path: 's.sh', inCheckpoint: 'tracked', exists: true, kind: 'file', size: 9, mtimeMs: 1, matchesCheckpoint: false, matchesAfter: true },
    ] },
    restoreCheckpointFiles: { ok: true, rollbackRef: 'd'.repeat(40), restored: ['s.sh'], removed: [], failed: [] },
  });
  const turn = { turnId: 't6', timeMs: 5000, title: 'Two sets and a script', changeSetIds: ['cs1', 'cs2'], files: [file('a.js'), file('c.js'), scriptFile('s.sh')] };

  await f.undo.openUndo(turn, {});
  await f.confirm();

  assert.deepEqual(f.callsOf('undoChangeSet').map((request) => request.changeSetId), ['cs2']);
  assert.deepEqual(f.callsOf('restoreCheckpointFiles'), [], 'checkpoint files wait for the unfinished journal undo');
  assert.equal(f.toasts.at(-1).message, 'Undo stopped partway. Undo again to finish it.');
  assert.equal(f.undo.canUndoTurn(turn), true, 'Undo stays available to finish it');
  assert.notEqual(f.undo.getUndoStates('session-1').t6?.status, 'undone');

  await f.undo.openUndo(turn, {});
  await f.confirm();

  assert.deepEqual(f.callsOf('undoChangeSet').map((request) => request.changeSetId), ['cs2', 'cs1'], 'the finished set is not undone again');
  assert.equal(f.callsOf('restoreCheckpointFiles').length, 1);
  const state = f.undo.getUndoStates('session-1').t6;
  assert.equal(state.status, 'undone');
  assert.deepEqual(state.files, { 'a.js': 'undone', 'c.js': 'undone', 's.sh': 'undone' });
  assert.equal(f.toasts.at(-1).message, 'Undid 3 files.');
});

test('a restore that only needs finalizing can be finished from History with no file writes', async (t) => {
  const f = setup(t, {
    preflightUndo: () => ({
      ...preflight('cs1', []),
      resume: { restore_status: 'in_progress', completed_inverse_step_ids: ['1.1'] },
    }),
    undoChangeSet: { ...committed('cs1', ['c.js']), safety_copy: null },
  });
  const turn = { turnId: 't3', timeMs: 5000, title: 'Crashed before finalize', changeSetIds: ['cs1'], files: [file('c.js')] };

  await f.undo.openUndo(turn, {});
  const button = f.doc.querySelector('[data-step-modal-action="confirm"]');
  assert.equal(button.disabled, false, 'nothing is left to write, but the restore can still finish');
  assert.equal(button.textContent, 'Finish undo');
  await f.confirm();

  assert.deepEqual(f.callsOf('undoChangeSet').map((request) => request.changeSetId), ['cs1'], 'the confirm button finishes the restore');
  assert.equal(f.undo.getUndoStates('session-1').t3.status, 'undone');
  assert.equal(f.undo.canUndoTurn(turn), false);
});

// A stub recovery backend over a real folder: each Undo captures a safety copy
// of the paths it touches (missing or bytes), and restoreSafetyCopy puts back
// exactly the paths it is asked for, as the Electron store does.
function folderBackend(t, { stopOlderOnce = true } = {}) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'jenny-undo-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const at = (rel) => nodePath.join(root, rel);
  const read = (rel) => (fs.existsSync(at(rel)) ? fs.readFileSync(at(rel)) : null);
  const copies = new Map();
  const journal = { cs2: 'not_requested', cs1: 'not_requested' };
  let cs1Stops = stopOlderOnce ? 1 : 0;
  const capture = (paths) => {
    const token = String(copies.size + 1).repeat(32);
    copies.set(token, new Map(paths.map((rel) => [rel, read(rel)])));
    return { token, paths, unavailable: [] };
  };
  fs.writeFileSync(at('b.txt'), Buffer.from([0x6d, 0x6f, 0x76, 0x65, 0x64, 0x00, 0xff]));
  fs.writeFileSync(at('c.txt'), 'C after\n');
  const api = {
    listChangeSets: () => ({ ok: true, change_sets: Object.entries(journal).map(([id, status]) => ({ change_set_id: id, restore_status: status, updated_at: '2026-10-12T00:00:00Z' })) }),
    // cs2 (newest) moved a.txt -> b.txt; cs1 (older) edited c.txt.
    preflightUndo: ({ changeSetId }) => {
      if (journal[changeSetId] === 'committed') return { ok: false, reason: 'change_set_not_restorable' };
      return changeSetId === 'cs2'
        ? preflight('cs2', [{ sequence: 1, inverse_step_id: '1.1', kind: 'move_back', from_relative_path: 'b.txt', to_relative_path: 'a.txt', expected_current_signature: null }])
        : preflight('cs1', [step('1.1', 'c.txt')]);
    },
    undoChangeSet: ({ changeSetId }) => {
      if (changeSetId === 'cs1' && cs1Stops > 0) {
        cs1Stops -= 1;
        journal.cs1 = 'in_progress';
        return { ok: false, reason: 'restore_io_failed', status: 'in_progress', message: 'Undo stopped before it finished.' };
      }
      const paths = changeSetId === 'cs2' ? ['a.txt', 'b.txt'] : ['c.txt'];
      const safetyCopy = capture(paths);
      if (changeSetId === 'cs2') fs.renameSync(at('b.txt'), at('a.txt'));
      else fs.writeFileSync(at('c.txt'), 'C before\n');
      journal[changeSetId] = 'committed';
      return {
        ok: true, status: 'committed', change_set_id: changeSetId,
        restored: [{ inverse_step_id: '1.1', relative_path: changeSetId === 'cs2' ? 'a.txt' : 'c.txt' }],
        skipped: [], renamed_to: [], protected: [], outside_undo_set: [], safety_copy: safetyCopy,
      };
    },
    preflightSafetyCopy: ({ token }) => ({ ok: true, files: [...copies.get(token).keys()].map((rel) => ({ path: rel, unchanged: true, mtimeMs: 1 })) }),
    restoreSafetyCopy: ({ token, paths }) => {
      const before = capture(paths);
      for (const rel of paths) {
        const bytes = copies.get(token).get(rel);
        if (bytes === null) fs.rmSync(at(rel), { force: true });
        else fs.writeFileSync(at(rel), bytes);
      }
      return { ok: true, restored: paths, failed: [], safety_copy: before };
    },
    reapplyChangeSet: ({ changeSetId }) => {
      journal[changeSetId] = 'not_requested';
      return { ok: true, change_set_id: changeSetId };
    },
  };
  return { api, read, journal };
}

const movedTurn = () => ({ turnId: 't4', timeMs: 5000, title: 'A move and an edit', changeSetIds: ['cs1', 'cs2'], files: [file('a.txt'), file('b.txt'), file('c.txt')] });

test('Redo after a resumed Undo puts a moved file back at its destination', async (t) => {
  const backend = folderBackend(t);
  const f = setup(t, backend.api);
  const turn = movedTurn();

  await f.undo.openUndo(turn, {});
  await f.confirm();
  assert.equal(f.toasts.at(-1).message, 'Undo stopped partway. Undo again to finish it.');
  await f.undo.openUndo(turn, {});
  await f.confirm();
  assert.equal(f.undo.getUndoStates('session-1').t4.status, 'undone');
  assert.equal(backend.read('a.txt').toString('latin1'), 'moved\u0000\u00ff');

  await f.undo.redo(turn, {});

  assert.deepEqual(backend.read('b.txt'), Buffer.from([0x6d, 0x6f, 0x76, 0x65, 0x64, 0x00, 0xff]), 'the moved file is back at its destination');
  assert.equal(backend.read('a.txt'), null);
  assert.equal(backend.read('c.txt').toString(), 'C after\n');
});

test('after a restart, a stopped Undo resumes only the change sets the journal has not finished', async (t) => {
  const backend = folderBackend(t);
  const turn = movedTurn();
  const before = setup(t, backend.api);
  await before.undo.openUndo(turn, {});
  await before.confirm();
  assert.equal(backend.journal.cs2, 'committed');
  before.undo.dispose();

  const after = setup(t, backend.api); // a new renderer: nothing in memory
  assert.equal(after.undo.canUndoTurn(turn), true);
  await settle();
  await after.undo.openUndo(turn, {});
  assert.deepEqual(after.callsOf('preflightUndo').map((request) => request.changeSetId), ['cs1'], 'the finished newer set is not prepared');
  await after.confirm();

  assert.deepEqual(after.callsOf('undoChangeSet').map((request) => request.changeSetId), ['cs1']);
  assert.equal(backend.read('c.txt').toString(), 'C before\n');
  assert.equal(after.undo.getUndoStates('session-1').t4.status, 'undone');
});

// The real recovery IPC and safety-copy store, over a stub sidecar: one change
// set moved a.txt -> b.txt and edited c.txt. Its Undo moves b.txt back to
// a.txt, then stops before reverting c.txt; the resumed plan holds only c.txt
// and, as the sidecar's resume preflight does, names the completed move.
function oneSetMoveRig() {
  const CS = '01990f9a-8c51-7ad2-a8be-41190e0e2525';
  const MISSING = { kind: 'missing', byte_size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
  const OUTSIDE = { shell_mutations: '', explorer_rename: '', known_unjournaled_events: [], warning: '' };
  const root = createTrackedTempDir('jenny-undo-resume-move-');
  const at = (rel) => nodePath.join(root, rel);
  fs.writeFileSync(at('b.txt'), MOVED);
  fs.writeFileSync(at('c.txt'), 'C after\n');
  const moveStep = { sequence: 2, inverse_step_id: '2.1', kind: 'move_back', from_relative_path: 'b.txt', to_relative_path: 'a.txt', expected_current_signature: MISSING };
  const editStep = { sequence: 1, inverse_step_id: '1.1', kind: 'restore_object', from_relative_path: null, to_relative_path: 'c.txt', expected_current_signature: MISSING };
  const resume = {
    restore_status: 'in_progress',
    completed_inverse_step_ids: ['2.1'],
    completed_moves: [{ inverse_step_id: '2.1', from_relative_path: 'b.txt', to_relative_path: 'a.txt' }],
  };
  let stopped = false;
  const rig = createRecoveryHarness(root, {
    withGit: false,
    sidecar: async (method) => {
      if (method === 'workspace.list_change_sets') return { workspace_id: 'root_abc', change_sets: [], outside_undo_set: OUTSIDE };
      if (method === 'workspace.preflight_undo') {
        return {
          change_set_id: CS, status: 'preflight', conflicts: [], staging_entries: [], outside_undo_set: OUTSIDE,
          inverse_plan: stopped ? [editStep] : [moveStep, editStep],
          ...(stopped ? { resume } : {}),
        };
      }
      if (method === 'workspace.undo_change_set' && !stopped) {
        stopped = true;
        fs.renameSync(at('b.txt'), at('a.txt'));
        throw Object.assign(new Error('stopped'), { rpc: { message: 'Undo stopped.', data: { reason: 'restore_io_failed', status: 'in_progress' } } });
      }
      if (method === 'workspace.undo_change_set') {
        fs.writeFileSync(at('c.txt'), 'C before\n');
        return {
          change_set_id: CS, status: 'committed', skipped: [], renamed_to: [], protected: [], outside_undo_set: OUTSIDE,
          restored: [{ inverse_step_id: '2.1', relative_path: 'a.txt' }, { inverse_step_id: '1.1', relative_path: 'c.txt' }],
        };
      }
      if (method === 'workspace.reapply_change_set') {
        return { change_set_id: CS, state: 'committed', restore_status: 'not_requested', operation_count: 2, updated_at: '2026-10-12T00:00:00Z', partially_undoable: false, warning: '' };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  const methods = ['listChangeSets', 'preflightUndo', 'undoChangeSet', 'preflightSafetyCopy', 'restoreSafetyCopy', 'reapplyChangeSet'];
  const api = Object.fromEntries(methods.map((name) => [name, (payload) => rig.invoke(`workspaceRecovery.${name}`, payload)]));
  const turn = { turnId: 't5', timeMs: 5000, title: 'A move and an edit in one set', changeSetIds: [CS], files: [file('a.txt'), file('b.txt'), file('c.txt')] };
  return { api, at, turn };
}

const MOVED = Buffer.from([0x6d, 0x6f, 0x76, 0x65, 0x64, 0x00, 0xff]);

// Real file IO behind the IPC: wait for the next toast, not a fixed tick count.
async function toastAfter(f, count) {
  for (let tries = 0; f.toasts.length <= count && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  return f.toasts.at(-1);
}

async function undoStopsThenResumes(t, { reload }) {
  t.after(() => cleanupTrackedResources());
  const { api, at, turn } = oneSetMoveRig();
  let f = setup(t, api);
  await f.undo.openUndo(turn, {});
  await f.confirm();
  assert.equal((await toastAfter(f, 0)).message, 'Undo stopped partway. Undo again to finish it.');
  assert.equal(fs.readFileSync(at('a.txt')).equals(MOVED), true, 'the move ran before the stop');
  if (reload) {
    f.undo.dispose();
    f = setup(t, api); // a new renderer: nothing of the stopped Undo in memory
    await settle();
  }
  const count = f.toasts.length;
  await f.undo.openUndo(turn, {});
  await f.confirm();
  await toastAfter(f, count);
  assert.equal(f.undo.getUndoStates('session-1').t5.status, 'undone');

  await f.undo.redo(turn, {});

  assert.deepEqual(fs.readFileSync(at('b.txt')), MOVED, 'the moved file is back at its destination');
  assert.equal(fs.existsSync(at('a.txt')), false);
  assert.equal(fs.readFileSync(at('c.txt'), 'utf8'), 'C after\n');
}

test('Redo after a resume inside one change set still puts a moved file back at its destination', async (t) => {
  await undoStopsThenResumes(t, { reload: false });
});

test('after a reload, Redo of a resumed set still puts a move the stopped Undo finished back at its destination', async (t) => {
  await undoStopsThenResumes(t, { reload: true });
});
