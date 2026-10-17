'use strict';

// A19-F3 / A16-F3: a journal Undo that stopped partway (the sidecar keeps the
// restore resumable) keeps its pre-undo safety copy, and the resumed Undo
// extends it, so Redo still puts back every file the whole undo changed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { createRecoveryHarness } = require('./helpers/workspace-recovery-harness');

const CHANGE_SET_ID = '01990f9a-8c51-7ad2-a8be-41190e0e2525';
const SIGNATURE = { kind: 'missing', byte_size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
const JENNY_BYTES = Buffer.from([0xff, 0xfe, 0x0d, 0x0a, 0x41, 0x00]);
const CREATED_BYTES = Buffer.from('created by jenny\r\n', 'utf8');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function outsideUndoSet() {
  return { shell_mutations: '', explorer_rename: '', known_unjournaled_events: [], warning: '' };
}

const step = (id, kind, from, to) => ({
  sequence: Number(id.split('.')[0]), inverse_step_id: id, kind, from_relative_path: from, to_relative_path: to,
  expected_current_signature: SIGNATURE,
});

// The stub journal: the first undo rewrites a.txt, then stops (an OSError in
// the sidecar); its preflight then reports only the remaining step, and the
// resumed undo removes created.txt.
function stoppingSidecar(root) {
  let stopped = false;
  return async (method) => {
    if (method === 'workspace.preflight_undo') {
      const plan = stopped
        ? [step('2.1', 'remove_created', 'created.txt', null)]
        : [step('1.1', 'restore_object', null, 'src/a.txt'), step('2.1', 'remove_created', 'created.txt', null)];
      return { change_set_id: CHANGE_SET_ID, status: 'preflight', conflicts: [], inverse_plan: plan, staging_entries: [], outside_undo_set: outsideUndoSet() };
    }
    if (method === 'workspace.undo_change_set' && !stopped) {
      stopped = true;
      await fs.writeFile(path.join(root, 'src', 'a.txt'), 'original\n', 'utf8');
      throw Object.assign(new Error('stopped'), {
        rpc: { message: 'Undo stopped before it finished; run Undo again to resume it.', data: { reason: 'restore_io_failed', status: 'in_progress' } },
      });
    }
    if (method === 'workspace.undo_change_set') {
      await fs.rm(path.join(root, 'created.txt'));
      return {
        change_set_id: CHANGE_SET_ID, status: 'committed',
        restored: [{ inverse_step_id: '1.1', relative_path: 'src/a.txt' }, { inverse_step_id: '2.1', relative_path: 'created.txt' }],
        skipped: [], renamed_to: [], protected: [], outside_undo_set: outsideUndoSet(),
      };
    }
    throw new Error(`unexpected method ${method}`);
  };
}

test('a resumed undo keeps the stopped attempt\'s copy, so Redo restores every file', async () => {
  const root = createTrackedTempDir('jenny-safety-copy-resume-');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.txt'), JENNY_BYTES);
  await fs.writeFile(path.join(root, 'created.txt'), CREATED_BYTES);
  const rig = createRecoveryHarness(root, { sidecar: stoppingSidecar(root), withGit: false });
  const undo = () => rig.invoke('workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, captureSafetyCopy: true });

  const stopped = await undo();
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, 'restore_io_failed');

  const resumed = await undo();
  assert.equal(resumed.ok, true);
  assert.deepEqual([...resumed.safety_copy.paths].sort(), ['created.txt', 'src/a.txt']);

  const redo = await rig.invoke('workspaceRecovery.restoreSafetyCopy', { token: resumed.safety_copy.token, paths: ['src/a.txt', 'created.txt'] });
  assert.equal(redo.ok, true);
  assert.deepEqual(redo.failed, []);
  assert.deepEqual(await fs.readFile(path.join(root, 'src', 'a.txt')), JENNY_BYTES, 'the bytes from before the first attempt');
  assert.deepEqual(await fs.readFile(path.join(root, 'created.txt')), CREATED_BYTES);
});

// One file edited twice (A0 -> A1 -> A2): the first undo writes A1 and stops
// between the two inverse edits; the resumed plan still targets that file.
function twiceEditedSidecar(root) {
  let stopped = false;
  const file = path.join(root, 'a.txt');
  return async (method) => {
    if (method === 'workspace.preflight_undo') {
      const plan = stopped
        ? [step('1.1', 'restore_object', null, 'a.txt')]
        : [step('2.1', 'restore_object', null, 'a.txt'), step('1.1', 'restore_object', null, 'a.txt')];
      return { change_set_id: CHANGE_SET_ID, status: 'preflight', conflicts: [], inverse_plan: plan, staging_entries: [], outside_undo_set: outsideUndoSet() };
    }
    if (method === 'workspace.undo_change_set' && !stopped) {
      stopped = true;
      await fs.writeFile(file, 'A1\n', 'utf8');
      throw Object.assign(new Error('stopped'), {
        rpc: { message: 'Undo stopped before it finished; run Undo again to resume it.', data: { reason: 'restore_io_failed', status: 'in_progress' } },
      });
    }
    if (method === 'workspace.undo_change_set') {
      await fs.writeFile(file, 'A0\n', 'utf8');
      return {
        change_set_id: CHANGE_SET_ID, status: 'committed',
        restored: [{ inverse_step_id: '2.1', relative_path: 'a.txt' }, { inverse_step_id: '1.1', relative_path: 'a.txt' }],
        skipped: [], renamed_to: [], protected: [], outside_undo_set: outsideUndoSet(),
      };
    }
    throw new Error(`unexpected method ${method}`);
  };
}

test('a resume between two inverse edits of one file keeps the first capture for Redo', async () => {
  const root = createTrackedTempDir('jenny-safety-copy-resume-');
  await fs.writeFile(path.join(root, 'a.txt'), 'A2\n', 'utf8');
  const rig = createRecoveryHarness(root, { sidecar: twiceEditedSidecar(root), withGit: false });
  const undo = () => rig.invoke('workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, captureSafetyCopy: true });

  assert.equal((await undo()).reason, 'restore_io_failed');
  const resumed = await undo();
  assert.equal(resumed.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'A0\n');

  const redo = await rig.invoke('workspaceRecovery.restoreSafetyCopy', { token: resumed.safety_copy.token, paths: ['a.txt'] });
  assert.equal(redo.ok, true);
  assert.deepEqual(redo.failed, []);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'A2\n', 'Redo puts back the bytes from before the first attempt');
});

// w2f5-R2: the retry passed preflight, but another change set became active
// before the Undo ran; the busy refusal keeps the stopped attempt's copy.
function busyOnSecondUndo(sidecar) {
  let undos = 0;
  return async (method, params) => {
    if (method === 'workspace.undo_change_set' && ++undos === 2) {
      throw Object.assign(new Error('busy'), {
        rpc: { message: 'Another change set is being restored.', data: { reason: 'restore_workspace_busy', status: 'busy' } },
      });
    }
    return sidecar(method, params);
  };
}

test('a busy refusal between a stopped undo and its resume keeps the first capture for Redo', async () => {
  const root = createTrackedTempDir('jenny-safety-copy-resume-');
  await fs.writeFile(path.join(root, 'a.txt'), 'A2\n', 'utf8');
  const rig = createRecoveryHarness(root, { sidecar: busyOnSecondUndo(twiceEditedSidecar(root)), withGit: false });
  const undo = () => rig.invoke('workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, captureSafetyCopy: true });

  assert.equal((await undo()).reason, 'restore_io_failed');
  assert.equal((await undo()).reason, 'restore_workspace_busy');
  const resumed = await undo();
  assert.equal(resumed.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'A0\n');

  const redo = await rig.invoke('workspaceRecovery.restoreSafetyCopy', { token: resumed.safety_copy.token, paths: ['a.txt'] });
  assert.equal(redo.ok, true);
  assert.deepEqual(redo.failed, []);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'A2\n', 'Redo puts back the bytes from before the first attempt');
});

test('a failure that is not resumable still discards the copy', async () => {
  const root = createTrackedTempDir('jenny-safety-copy-resume-');
  await fs.writeFile(path.join(root, 'created.txt'), CREATED_BYTES);
  const rig = createRecoveryHarness(root, {
    withGit: false,
    sidecar: async (method) => {
      if (method === 'workspace.preflight_undo') {
        return { change_set_id: CHANGE_SET_ID, status: 'preflight', conflicts: [], inverse_plan: [step('2.1', 'remove_created', 'created.txt', null)], staging_entries: [], outside_undo_set: outsideUndoSet() };
      }
      throw Object.assign(new Error('refused'), { rpc: { message: 'no', data: { reason: 'restore_decisions_incomplete' } } });
    },
  });
  const failed = await rig.invoke('workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, captureSafetyCopy: true });
  assert.equal(failed.reason, 'restore_decisions_incomplete');
  assert.equal(rig.safetyCopies.size, 0);
});

// The sidecar persisted the last inverse step, then the app exited before the
// restore was committed: the resumable preflight has nothing left to write.
test('a restore awaiting only finalization keeps its resume block and finishes with no writes', async () => {
  const root = createTrackedTempDir('jenny-safety-copy-resume-');
  await fs.writeFile(path.join(root, 'a.txt'), 'A0\n', 'utf8');
  const methods = [];
  const rig = createRecoveryHarness(root, {
    withGit: false,
    sidecar: async (method) => {
      methods.push(method);
      if (method === 'workspace.preflight_undo') {
        return {
          change_set_id: CHANGE_SET_ID, status: 'preflight', conflicts: [], inverse_plan: [], staging_entries: [], outside_undo_set: outsideUndoSet(),
          resume: {
            restore_status: 'in_progress',
            completed_inverse_step_ids: ['2.1', '1.1'],
            decisions: [],
            receipt: { restored: [{ inverse_step_id: '2.1', relative_path: 'a.txt' }], skipped: [], renamed_to: [], protected: [] },
          },
        };
      }
      if (method === 'workspace.undo_change_set') {
        return {
          change_set_id: CHANGE_SET_ID, status: 'committed',
          restored: [{ inverse_step_id: '2.1', relative_path: 'a.txt' }, { inverse_step_id: '1.1', relative_path: 'a.txt' }],
          skipped: [], renamed_to: [], protected: [], outside_undo_set: outsideUndoSet(),
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });

  const review = await rig.invoke('workspaceRecovery.preflightUndo', { changeSetId: CHANGE_SET_ID });
  assert.equal(review.ok, true);
  assert.deepEqual(review.inverse_plan, []);
  assert.deepEqual(review.resume, { restore_status: 'in_progress', completed_inverse_step_ids: ['2.1', '1.1'] });

  const finished = await rig.invoke('workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, captureSafetyCopy: true });
  assert.equal(finished.ok, true);
  assert.equal(finished.status, 'committed');
  assert.deepEqual(methods.filter((method) => method === 'workspace.undo_change_set'), ['workspace.undo_change_set']);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'A0\n', 'nothing was written again');
});

test('a malformed resume block is not passed through', async () => {
  const root = createTrackedTempDir('jenny-safety-copy-resume-');
  const rig = createRecoveryHarness(root, {
    withGit: false,
    sidecar: async () => ({
      change_set_id: CHANGE_SET_ID, status: 'preflight', conflicts: [], inverse_plan: [], staging_entries: [], outside_undo_set: outsideUndoSet(),
      resume: { restore_status: 'in_progress', completed_inverse_step_ids: ['../x'] },
    }),
  });
  const review = await rig.invoke('workspaceRecovery.preflightUndo', { changeSetId: CHANGE_SET_ID });
  assert.equal(review.ok, false);
  assert.equal(review.reason, 'recovery_response_invalid');
});

// A reloaded renderer rebuilds a completed move's Redo from `completed_moves`.
function resumeRig(completedMoves) {
  const root = createTrackedTempDir('jenny-safety-copy-resume-');
  return createRecoveryHarness(root, {
    withGit: false,
    sidecar: async () => ({
      change_set_id: CHANGE_SET_ID, status: 'preflight', conflicts: [], inverse_plan: [], staging_entries: [], outside_undo_set: outsideUndoSet(),
      resume: { restore_status: 'in_progress', completed_inverse_step_ids: ['2.1'], completed_moves: completedMoves },
    }),
  });
}

test('the completed moves of a resumable restore are passed through', async () => {
  const moves = [{ inverse_step_id: '2.1', from_relative_path: 'b.txt', to_relative_path: 'a.txt' }];
  const review = await resumeRig(moves).invoke('workspaceRecovery.preflightUndo', { changeSetId: CHANGE_SET_ID });
  assert.equal(review.ok, true);
  assert.deepEqual(review.resume, { restore_status: 'in_progress', completed_inverse_step_ids: ['2.1'], completed_moves: moves });
});

test('a completed move without both ends, or for a step that did not run, is refused', async () => {
  for (const moves of [
    [{ inverse_step_id: '2.1', from_relative_path: 'b.txt', to_relative_path: null }],
    [{ inverse_step_id: '1.1', from_relative_path: 'b.txt', to_relative_path: 'a.txt' }],
    'b.txt',
  ]) {
    const review = await resumeRig(moves).invoke('workspaceRecovery.preflightUndo', { changeSetId: CHANGE_SET_ID });
    assert.equal(review.reason, 'recovery_response_invalid', JSON.stringify(moves));
  }
});
