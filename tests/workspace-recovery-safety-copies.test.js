'use strict';

// Row 34 S5 step 4: the in-memory safety copy behind journal Undo, Redo and
// the second Undo. Unit tests cover the store's caps, eviction and single use;
// the end-to-end tests drive the real workspaceRecovery handlers against a temp
// workspace with the sidecar stubbed (it performs the "journal undo" on disk).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  MISSING_STATE,
  WorkspaceRecoverySafetyCopyStore,
  sha256Bytes,
  stateOfCapture,
} = require('../services/workspace-recovery-safety-copies');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { createRecoveryHarness, createTrash } = require('./helpers/workspace-recovery-harness');

const CHANGE_SET_ID = '01990f9a-8c51-7ad2-a8be-41190e0e2525';
const SIGNATURE = { kind: 'missing', byte_size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
// Not valid UTF-8, with CRLF and a NUL: only a byte-exact copy survives this.
const JENNY_BYTES = Buffer.from([0xff, 0xfe, 0x0d, 0x0a, 0x41, 0x00, 0x80, 0x0d, 0x0a, 0xc3]);
const CREATED_BYTES = Buffer.from('created by jenny\r\nline two\r\n', 'utf8');
const ORIGINAL_TEXT = 'original\n';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function outsideUndoSet() {
  return { shell_mutations: '', explorer_rename: '', known_unjournaled_events: [], warning: '' };
}

function preflightResult() {
  const step = (id, kind, from, to) => ({
    sequence: Number(id.split('.')[0]),
    inverse_step_id: id,
    kind,
    from_relative_path: from,
    to_relative_path: to,
    expected_current_signature: SIGNATURE,
  });
  return {
    change_set_id: CHANGE_SET_ID,
    status: 'preflight',
    conflicts: [],
    inverse_plan: [
      step('1.1', 'restore_object', null, 'src/a.txt'),
      step('2.1', 'remove_created', 'created.txt', null),
    ],
    staging_entries: [],
    outside_undo_set: outsideUndoSet(),
  };
}

function receipt(status = 'committed') {
  return {
    change_set_id: CHANGE_SET_ID,
    status,
    restored: [{ inverse_step_id: '1.1', relative_path: 'src/a.txt' }],
    skipped: [],
    renamed_to: [],
    protected: [],
    outside_undo_set: outsideUndoSet(),
  };
}

async function seedJennyTurn(root) {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.txt'), JENNY_BYTES);
  await fs.writeFile(path.join(root, 'created.txt'), CREATED_BYTES);
}

// The stub sidecar "journal": undo rewrites a.txt and deletes created.txt.
function journalSidecar(root, { undoStatus = 'committed', undoThrows = false } = {}) {
  return async (method) => {
    if (method === 'workspace.preflight_undo') return preflightResult();
    if (method === 'workspace.undo_change_set') {
      if (undoThrows) throw Object.assign(new Error('undo failed'), { rpc: { message: 'undo failed', data: { reason: 'restore_failed' } } });
      await fs.writeFile(path.join(root, 'src', 'a.txt'), ORIGINAL_TEXT, 'utf8');
      await fs.rm(path.join(root, 'created.txt'));
      return receipt(undoStatus);
    }
    throw new Error(`unexpected method ${method}`);
  };
}

async function undoWithCopy(rig) {
  return rig.invoke('workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, captureSafetyCopy: true });
}

describe('safety copy store (unit)', () => {
  const binding = { rootId: 'root:a', workspaceId: '1:2' };
  const file = (text) => ({ kind: 'file', bytes: Buffer.from(text), size: text.length, mtimeMs: 1, reason: '' });

  test('caps mark unavailable without partial capture; non-files are not_a_file', () => {
    const store = new WorkspaceRecoverySafetyCopyStore({ limits: { maxFileBytes: 4, maxCopyBytes: 6, maxCopies: 4 } });
    const draft = store.startCopy(binding);
    assert.equal(draft.record('big.txt', file('12345')), false);
    assert.equal(draft.record('a.txt', file('1234')), true);
    assert.equal(draft.record('b.txt', file('123')), false, 'the copy total cap refuses the whole file');
    assert.equal(draft.record('dir', { kind: 'directory' }), false);
    assert.equal(draft.record('gone.txt', { kind: 'missing' }), true);
    assert.equal(draft.record('huge.txt', { kind: 'file', bytes: null, reason: 'too_large' }), false);
    assert.equal(draft.totalBytes, 4);
    const sealed = store.commit(draft, new Map([
      ['a.txt', sha256Bytes(Buffer.from('x'))], ['gone.txt', MISSING_STATE],
    ]));
    assert.deepEqual(sealed.paths, ['a.txt', 'gone.txt']);
    assert.deepEqual(sealed.unavailable, [
      { path: 'big.txt', reason: 'too_large' },
      { path: 'b.txt', reason: 'too_large' },
      { path: 'dir', reason: 'not_a_file' },
      { path: 'huge.txt', reason: 'too_large' },
    ]);
  });

  test('a path without a usable post-state is unavailable; an empty copy issues no token', () => {
    const store = new WorkspaceRecoverySafetyCopyStore();
    const draft = store.startCopy(binding);
    draft.record('a.txt', file('a'));
    const sealed = store.commit(draft, new Map([['a.txt', { unavailable: 'too_large' }]]));
    assert.equal(sealed.token, null);
    assert.deepEqual(sealed.unavailable, [{ path: 'a.txt', reason: 'too_large' }]);
    assert.equal(store.size, 0);
  });

  test('oldest copies are evicted first; tokens are single-use and root-bound', () => {
    let next = 0;
    const store = new WorkspaceRecoverySafetyCopyStore({
      limits: { maxCopies: 2 },
      randomUUID: () => `00000000-0000-4000-8000-00000000000${next += 1}`,
    });
    const seal = () => {
      const draft = store.startCopy(binding);
      draft.record('a.txt', file('a'));
      return store.commit(draft, new Map([['a.txt', MISSING_STATE]])).token;
    };
    const [first, second, third] = [seal(), seal(), seal()];
    assert.equal(store.peek(first, binding).error, 'safety_copy_expired');
    assert.ok(store.peek(second, binding).copy);
    assert.equal(store.peek(third, { ...binding, rootId: 'root:b' }).error, 'root_changed');
    assert.equal(store.consume(third), true);
    assert.equal(store.peek(third, binding).error, 'safety_copy_expired');
    assert.equal(store.consume(third), false);
  });

  test('the store-wide byte cap evicts the oldest copies, never the newest', () => {
    let next = 0;
    const store = new WorkspaceRecoverySafetyCopyStore({
      limits: { maxFileBytes: 8, maxCopyBytes: 8, maxCopies: 16, maxTotalBytes: 10 },
      randomUUID: () => `00000000-0000-4000-8000-00000000000${next += 1}`,
    });
    const seal = (text) => {
      const draft = store.startCopy(binding);
      draft.record('a.txt', file(text));
      return store.commit(draft, new Map([['a.txt', MISSING_STATE]])).token;
    };
    const first = seal('aaaa');
    const second = seal('bbbb');
    assert.equal(store.totalBytes, 8);
    const third = seal('cccccc');
    assert.equal(store.peek(first, binding).error, 'safety_copy_expired');
    assert.ok(store.peek(second, binding).copy);
    assert.ok(store.peek(third, binding).copy);
    assert.equal(store.totalBytes, 10);
    store.consume(second);
    assert.equal(store.totalBytes, 6);
    const lone = new WorkspaceRecoverySafetyCopyStore({ limits: { maxFileBytes: 8, maxCopyBytes: 8, maxTotalBytes: 4 } });
    const draft = lone.startCopy(binding);
    draft.record('a.txt', file('eeeeee'));
    assert.ok(lone.peek(lone.commit(draft, new Map([['a.txt', MISSING_STATE]])).token, binding).copy,
      'the newest copy always survives');
  });

  test('stateOfCapture compares bytes, missing, or nothing', () => {
    assert.equal(stateOfCapture({ kind: 'missing' }), MISSING_STATE);
    assert.equal(stateOfCapture(file('abc')), sha256Bytes(Buffer.from('abc')));
    assert.equal(stateOfCapture({ kind: 'file', bytes: null, reason: 'too_large' }), null);
    assert.equal(stateOfCapture({ kind: 'symlink' }), null);
  });
});

describe('journal undo, redo and re-undo through the safety copy (temp workspace)', () => {
  test('captures before undo, redoes byte-exactly, then a fresh token reverses the redo', async () => {
    const root = createTrackedTempDir('jenny-safety-copy-');
    await seedJennyTurn(root);
    const rig = createRecoveryHarness(root, { sidecar: journalSidecar(root), withGit: false });

    const undone = await undoWithCopy(rig);
    assert.equal(undone.ok, true);
    assert.equal(undone.status, 'committed');
    assert.deepEqual(undone.safety_copy.paths, ['src/a.txt', 'created.txt']);
    assert.deepEqual(undone.safety_copy.unavailable, []);
    assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), ORIGINAL_TEXT);

    const preflight = await rig.invoke('workspaceRecovery.preflightSafetyCopy', { token: undone.safety_copy.token });
    assert.equal(preflight.ok, true);
    assert.deepEqual(preflight.files.map((item) => [item.path, item.unchanged]), [['src/a.txt', true], ['created.txt', true]]);
    assert.equal(typeof preflight.files[0].mtimeMs, 'number');

    const redo = await rig.invoke('workspaceRecovery.restoreSafetyCopy', {
      token: undone.safety_copy.token, paths: ['src/a.txt', 'created.txt'],
    });
    assert.equal(redo.ok, true);
    assert.deepEqual(redo.restored, ['src/a.txt', 'created.txt']);
    assert.deepEqual(redo.failed, []);
    assert.deepEqual(await fs.readFile(path.join(root, 'src', 'a.txt')), JENNY_BYTES, 'non-UTF-8 + CRLF bytes round-trip exactly');
    assert.deepEqual(await fs.readFile(path.join(root, 'created.txt')), CREATED_BYTES);

    const reused = await rig.invoke('workspaceRecovery.restoreSafetyCopy', {
      token: undone.safety_copy.token, paths: ['src/a.txt'],
    });
    assert.equal(reused.ok, false);
    assert.equal(reused.reason, 'safety_copy_expired', 'the used token is consumed');

    const reUndo = await rig.invoke('workspaceRecovery.restoreSafetyCopy', {
      token: redo.safety_copy.token, paths: ['src/a.txt', 'created.txt'],
    });
    assert.equal(reUndo.ok, true);
    assert.deepEqual(reUndo.restored, ['src/a.txt', 'created.txt']);
    assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), ORIGINAL_TEXT);
    await assert.rejects(fs.stat(path.join(root, 'created.txt')), { code: 'ENOENT' });
    assert.equal(rig.trash.items.length, 1, 'a "missing" captured state moves the file to the recycle bin');
    assert.deepEqual(await fs.readFile(rig.trash.items[0].to), CREATED_BYTES);
  });

  test('a file changed after the undo is refused with changed_since and keeps the user edit', async () => {
    const root = createTrackedTempDir('jenny-safety-copy-');
    await seedJennyTurn(root);
    const rig = createRecoveryHarness(root, { sidecar: journalSidecar(root), withGit: false });
    const undone = await undoWithCopy(rig);
    await fs.writeFile(path.join(root, 'src', 'a.txt'), 'user edit\n', 'utf8');

    const preflight = await rig.invoke('workspaceRecovery.preflightSafetyCopy', { token: undone.safety_copy.token });
    assert.deepEqual(preflight.files.map((item) => item.unchanged), [false, true]);
    const redo = await rig.invoke('workspaceRecovery.restoreSafetyCopy', {
      token: undone.safety_copy.token, paths: ['src/a.txt', 'created.txt'],
    });
    assert.equal(redo.ok, true);
    assert.deepEqual(redo.failed, [{ path: 'src/a.txt', reason: 'changed_since' }]);
    assert.deepEqual(redo.restored, ['created.txt']);
    assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), 'user edit\n');
    assert.deepEqual(redo.safety_copy.paths, ['created.txt'], 'the reverse copy covers only what was restored');
  });

  test('a missing state with no recycle bin is refused and the file stays', async () => {
    const root = createTrackedTempDir('jenny-safety-copy-');
    await seedJennyTurn(root);
    const rig = createRecoveryHarness(root, {
      sidecar: journalSidecar(root), withGit: false, trash: createTrash({ available: false }),
    });
    const undone = await undoWithCopy(rig);
    const redo = await rig.invoke('workspaceRecovery.restoreSafetyCopy', { token: undone.safety_copy.token, paths: ['created.txt'] });
    const reUndo = await rig.invoke('workspaceRecovery.restoreSafetyCopy', { token: redo.safety_copy.token, paths: ['created.txt'] });
    assert.deepEqual(reUndo.failed, [{ path: 'created.txt', reason: 'trash_unavailable' }]);
    assert.deepEqual(await fs.readFile(path.join(root, 'created.txt')), CREATED_BYTES);
  });

  test('caps mark over-size files unavailable instead of capturing part of them', async () => {
    const root = createTrackedTempDir('jenny-safety-copy-');
    await seedJennyTurn(root);
    const rig = createRecoveryHarness(root, {
      sidecar: journalSidecar(root), withGit: false, limits: { maxFileBytes: 16 },
    });
    const undone = await undoWithCopy(rig);
    assert.deepEqual(undone.safety_copy.paths, ['src/a.txt']);
    assert.deepEqual(undone.safety_copy.unavailable, [{ path: 'created.txt', reason: 'too_large' }]);
  });

  test('a failed undo discards the copy; a needs_review receipt keeps it', async () => {
    const failedRoot = createTrackedTempDir('jenny-safety-copy-');
    await seedJennyTurn(failedRoot);
    const failedRig = createRecoveryHarness(failedRoot, {
      sidecar: journalSidecar(failedRoot, { undoThrows: true }), withGit: false,
    });
    const failed = await undoWithCopy(failedRig);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'restore_failed');
    assert.equal(Object.hasOwn(failed, 'safety_copy'), false);
    assert.equal(failedRig.safetyCopies.size, 0);

    const reviewRoot = createTrackedTempDir('jenny-safety-copy-');
    await seedJennyTurn(reviewRoot);
    const reviewRig = createRecoveryHarness(reviewRoot, {
      sidecar: journalSidecar(reviewRoot, { undoStatus: 'needs_review' }), withGit: false,
    });
    const review = await undoWithCopy(reviewRig);
    assert.equal(review.ok, true);
    assert.equal(review.status, 'needs_review');
    assert.match(review.safety_copy.token, /^[0-9a-f-]{36}$/);
    assert.equal(reviewRig.safetyCopies.size, 1);
  });

  test('a workspace root change between calls fails closed', async () => {
    const root = createTrackedTempDir('jenny-safety-copy-');
    const other = createTrackedTempDir('jenny-safety-copy-other-');
    await seedJennyTurn(root);
    const rootPathRef = { value: root };
    const rig = createRecoveryHarness(root, { sidecar: journalSidecar(root), withGit: false, rootPathRef });
    const undone = await undoWithCopy(rig);
    rootPathRef.value = other;
    const preflight = await rig.invoke('workspaceRecovery.preflightSafetyCopy', { token: undone.safety_copy.token });
    const redo = await rig.invoke('workspaceRecovery.restoreSafetyCopy', { token: undone.safety_copy.token, paths: ['src/a.txt'] });
    assert.equal(preflight.reason, 'root_changed');
    assert.equal(redo.reason, 'root_changed');
    await assert.rejects(fs.stat(path.join(other, 'src', 'a.txt')), { code: 'ENOENT' });
  });

  test('payloads are strict: bad tokens, unknown keys and invalid paths never touch disk', async () => {
    const root = createTrackedTempDir('jenny-safety-copy-');
    await seedJennyTurn(root);
    const rig = createRecoveryHarness(root, { sidecar: journalSidecar(root), withGit: false });
    const undone = await undoWithCopy(rig);
    const token = undone.safety_copy.token;
    const cases = [
      [{ token: 'nope', paths: ['src/a.txt'] }, 'token_invalid'],
      [{ token, paths: ['src/a.txt'], extra: 1 }, 'payload_invalid'],
      [{ token, paths: [] }, 'paths_invalid'],
      [{ token, paths: ['../outside.txt'] }, 'paths_invalid'],
      [{ token, paths: ['C:/abs.txt'] }, 'paths_invalid'],
      [{ token, paths: ['\\\\server\\share\\x'] }, 'paths_invalid'],
      [{ token, paths: Array.from({ length: 501 }, (_v, i) => `f${i}.txt`) }, 'paths_invalid'],
    ];
    for (const [payload, reason] of cases) {
      const result = await rig.invoke('workspaceRecovery.restoreSafetyCopy', payload);
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason, JSON.stringify(payload).slice(0, 80));
    }
    const notInCopy = await rig.invoke('workspaceRecovery.restoreSafetyCopy', { token, paths: ['other.txt'] });
    assert.deepEqual(notInCopy.failed, [{ path: 'other.txt', reason: 'not_in_safety_copy' }]);
    assert.equal(await fs.readFile(path.join(root, 'src', 'a.txt'), 'utf8'), ORIGINAL_TEXT);
    assert.ok(!JSON.stringify(notInCopy).includes(root), 'no absolute path reaches the renderer');
  });
});
