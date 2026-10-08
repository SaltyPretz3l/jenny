const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildCleanupTargets,
  cleanupJennyData,
  validateCleanupTarget,
} = require('../services/data-lifecycle/cleanup-service');
const { WORKSPACE_PORTABLE_NAMES } = require('../services/data-lifecycle/data-inventory');
const { HomeAiJournalStore } = require('../services/home-ai-journal-store');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-cleanup-'));
}

describe('cleanupJennyData', () => {
  it('removes fixed Jenny data while retaining unknown runtime and workspace files', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      const runtimePath = path.join(root, '.companion');
      const workspaceRoot = path.join(root, 'workspace');
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.writeFileSync(path.join(userDataPath, 'sessions.json'), '{}');
      for (const name of ['session-runtime', 'session-runtime-budgets', 'session-runtime-checkpoints']) {
        fs.mkdirSync(path.join(userDataPath, name));
        fs.writeFileSync(path.join(userDataPath, name, 'record.json'), '{}');
      }
      fs.writeFileSync(path.join(userDataPath, 'unknown-profile.txt'), 'retain');
      fs.mkdirSync(runtimePath, { recursive: true });
      fs.writeFileSync(path.join(runtimePath, 'jenny_memory.db'), 'memory');
      fs.writeFileSync(path.join(runtimePath, 'unknown.txt'), 'retain');
      fs.mkdirSync(path.join(workspaceRoot, '.jenny'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, '.jenny', 'artifact.json'), '{}');
      fs.writeFileSync(path.join(workspaceRoot, 'project.txt'), 'retain');

      const result = await cleanupJennyData({ userDataPath, runtimePath, workspaceRoot });
      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(path.join(userDataPath, 'sessions.json')), false);
      assert.equal(fs.existsSync(path.join(userDataPath, 'session-runtime')), false);
      assert.equal(fs.existsSync(path.join(userDataPath, 'session-runtime-budgets')), false);
      assert.equal(fs.existsSync(path.join(userDataPath, 'session-runtime-checkpoints')), false);
      assert.equal(fs.existsSync(path.join(userDataPath, 'unknown-profile.txt')), true);
      assert.equal(fs.existsSync(path.join(runtimePath, 'jenny_memory.db')), false);
      assert.equal(fs.existsSync(path.join(runtimePath, 'unknown.txt')), true);
      assert.equal(fs.existsSync(path.join(workspaceRoot, '.jenny')), true);
      assert.deepEqual(result.unknownRuntimeChildren, ['unknown.txt']);
      assert.deepEqual(result.unknownUserDataChildren, ['unknown-profile.txt']);

      const repeated = await cleanupJennyData({ userDataPath, runtimePath, workspaceRoot });
      assert.equal(repeated.ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('F5: removes the model catalog cache and its meta sidecar, and does not flag them as unknown', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.writeFileSync(path.join(userDataPath, 'model-recommendation-catalog.json'), '{}');
      fs.writeFileSync(path.join(userDataPath, 'model-recommendation-catalog.json.meta.json'), '{}');

      const result = await cleanupJennyData({ userDataPath });

      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(path.join(userDataPath, 'model-recommendation-catalog.json')), false);
      assert.equal(fs.existsSync(path.join(userDataPath, 'model-recommendation-catalog.json.meta.json')), false);
      assert.deepEqual(result.unknownUserDataChildren, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes workspace metadata only when explicitly selected', () => {
    const targets = buildCleanupTargets({
      userDataPath: 'C:\\Temp\\JennyProfile',
      workspaceRoot: 'C:\\Temp\\Project',
      removeWorkspaceData: true,
      workspaceRemovalScope: 'all',
    });
    assert.equal(targets.some((target) => target.kind === 'workspace_metadata'), true);
    assert.equal(targets.every(validateCleanupTarget), true);

    // "only when" needs the negative: a workspaceRoot alone must not opt in.
    const withoutOptIn = buildCleanupTargets({
      userDataPath: 'C:\\Temp\\JennyProfile',
      workspaceRoot: 'C:\\Temp\\Project',
    });
    assert.equal(withoutOptIn.some((target) => target.kind === 'workspace_metadata'), false);
  });

  it('removes only the archived .jenny children by default and keeps everything else', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const metadata = path.join(workspaceRoot, '.jenny');
      fs.mkdirSync(path.join(metadata, 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(metadata, 'artifacts', 'included.txt'), 'archived');
      fs.writeFileSync(path.join(metadata, 'omissions.db'), 'archived');
      fs.mkdirSync(path.join(metadata, 'omissions'));
      fs.writeFileSync(path.join(metadata, 'omissions', 'omissions.db'), 'cache');
      fs.mkdirSync(path.join(metadata, 'notes'));
      fs.writeFileSync(path.join(metadata, 'notes', 'keep.md'), 'keep');
      fs.mkdirSync(path.join(metadata, 'skills'));

      for (const workspaceRemovalScope of [undefined, 'archived', 'unexpected']) {
        const result = await cleanupJennyData({
          workspaceRoot,
          removeWorkspaceData: true,
          includeUserData: false,
          ...(workspaceRemovalScope ? { workspaceRemovalScope } : {}),
        });
        assert.equal(result.ok, true);
        assert.equal(result.status, 'complete');
        assert.equal(result.results.some((entry) => entry.status === 'retained'), false);
        assert.deepEqual(result.retainedWorkspaceChildren, ['notes', 'skills']);
        assert.deepEqual(result.warnings, ['Kept 2 workspace .jenny item(s) that are not part of the archive.']);
        assert.equal(fs.existsSync(path.join(metadata, 'artifacts')), false);
        assert.equal(fs.existsSync(path.join(metadata, 'omissions.db')), false);
        // The omission cache is never archived but goes with the archived data.
        assert.equal(fs.existsSync(path.join(metadata, 'omissions')), false);
        assert.deepEqual(
          result.results.filter((entry) => entry.kind === 'workspace_cache_child')
            .map((entry) => [entry.name, entry.status]),
          [['omissions', 'removed']]
        );
        assert.equal(fs.readFileSync(path.join(metadata, 'notes', 'keep.md'), 'utf8'), 'keep');
        // Restore the archived children so the next scope value starts from the same state.
        fs.mkdirSync(path.join(metadata, 'artifacts'));
        fs.writeFileSync(path.join(metadata, 'omissions.db'), 'archived');
        fs.mkdirSync(path.join(metadata, 'omissions'));
        fs.writeFileSync(path.join(metadata, 'omissions', 'omissions.db'), 'cache');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes .jenny itself once only archived children were in it', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const metadata = path.join(workspaceRoot, '.jenny');
      fs.mkdirSync(path.join(metadata, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(metadata, 'artifact-manifest.json'), '{}');
      fs.writeFileSync(path.join(workspaceRoot, 'project.txt'), 'retain');

      const result = await cleanupJennyData({
        workspaceRoot, removeWorkspaceData: true, includeUserData: false, workspaceRemovalScope: 'archived',
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.retainedWorkspaceChildren, []);
      assert.deepEqual(result.warnings, []);
      assert.equal(fs.existsSync(metadata), false);
      assert.equal(fs.readFileSync(path.join(workspaceRoot, 'project.txt'), 'utf8'), 'retain');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes all of .jenny only for the explicit all scope', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const metadata = path.join(workspaceRoot, '.jenny');
      fs.mkdirSync(path.join(metadata, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(metadata, 'notes', 'gone.md'), 'gone');
      fs.mkdirSync(path.join(metadata, 'artifacts'));

      const result = await cleanupJennyData({
        workspaceRoot, removeWorkspaceData: true, includeUserData: false, workspaceRemovalScope: 'all',
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.retainedWorkspaceChildren, []);
      assert.equal(fs.existsSync(metadata), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds archived-child targets, never whole-.jenny, for a missing or unknown scope', () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const metadata = path.join(workspaceRoot, '.jenny');
      fs.mkdirSync(path.join(metadata, 'artifacts'), { recursive: true });
      fs.mkdirSync(path.join(metadata, 'notes'));
      fs.writeFileSync(path.join(metadata, 'omissions.db'), '');
      for (const scope of [undefined, 'archived', 'ALL', 'everything']) {
        const targets = buildCleanupTargets({
          workspaceRoot, removeWorkspaceData: true, includeUserData: false,
          ...(scope ? { workspaceRemovalScope: scope } : {}),
        });
        assert.equal(targets.some((target) => target.kind === 'workspace_metadata'), false);
        assert.deepEqual(
          targets.map((target) => [target.kind, target.name, target.path]),
          [
            ['workspace_archived_child', 'artifacts', path.join(metadata, 'artifacts')],
            ['workspace_archived_child', 'omissions.db', path.join(metadata, 'omissions.db')],
          ]
        );
        assert.equal(targets.every((target) => target.root === metadata), true);
        assert.equal(targets.every(validateCleanupTarget), true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects forged workspace_archived_child targets', () => {
    const metadata = path.join(os.tmpdir(), 'ws', '.jenny');
    const valid = {
      kind: 'workspace_archived_child', root: metadata, name: 'artifacts', path: path.join(metadata, 'artifacts'),
    };
    assert.equal(validateCleanupTarget(valid), true);
    assert.equal(validateCleanupTarget({ ...valid, name: 'notes', path: path.join(metadata, 'notes') }), false);
    assert.equal(validateCleanupTarget({ ...valid, path: path.join(metadata, 'artifacts', 'deep') }), false);
    assert.equal(validateCleanupTarget({ ...valid, path: path.join(metadata, 'backups') }), false);
    assert.equal(validateCleanupTarget({
      ...valid, root: path.dirname(metadata), path: path.join(path.dirname(metadata), 'artifacts'),
    }), false);
    assert.equal(validateCleanupTarget({ ...valid, root: path.join(os.tmpdir(), 'ws', 'other') }), false);
    assert.deepEqual([...WORKSPACE_PORTABLE_NAMES].sort(), [
      'artifact-manifest.json', 'artifacts', 'backups', 'omissions.db', 'tool-results',
    ]);
  });

  it('fails closed when .jenny itself is a link during archived removal', async (t) => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const externalPath = path.join(root, 'external');
      fs.mkdirSync(workspaceRoot);
      fs.mkdirSync(path.join(externalPath, 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(externalPath, 'artifacts', 'keep.txt'), 'keep');
      try {
        fs.symlinkSync(externalPath, path.join(workspaceRoot, '.jenny'), 'junction');
      } catch (error) {
        t.skip(`junction creation unavailable: ${error.code || 'unknown'}`);
        return;
      }
      const result = await cleanupJennyData({
        workspaceRoot, removeWorkspaceData: true, includeUserData: false, workspaceRemovalScope: 'archived',
      });
      assert.equal(result.ok, false);
      assert.equal(result.results[0].reason, 'reparse_or_symlink');
      assert.equal(fs.readFileSync(path.join(externalPath, 'artifacts', 'keep.txt'), 'utf8'), 'keep');
      assert.equal(fs.existsSync(path.join(workspaceRoot, '.jenny')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the Home journal, todo lists and Ollama catalog cache from the profile and runtime roots', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      const runtimePath = path.join(root, '.companion');
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.mkdirSync(runtimePath, { recursive: true });
      new HomeAiJournalStore({ userDataPath }).append({
        id: 'jnl_1',
        entity: 'reminder',
        entityId: 'r1',
        op: 'delete',
        label: 'Removed reminder',
        inverse: { kind: 'restore', payload: { title: 'private text' } },
      }, new Date(1760000000000));
      assert.equal(fs.existsSync(path.join(userDataPath, 'home-ai-journal.json')), true);
      fs.mkdirSync(path.join(userDataPath, 'todo-lists'));
      fs.writeFileSync(path.join(userDataPath, 'todo-lists', '0123456789abcdef0123456789abcdef.json'), '{}');
      fs.writeFileSync(path.join(userDataPath, 'ollama-catalog.json'), '{}');
      fs.writeFileSync(path.join(runtimePath, 'ollama-catalog.json'), '{}');

      const result = await cleanupJennyData({ userDataPath, runtimePath });

      assert.equal(result.status, 'complete');
      assert.deepEqual(result.unknownUserDataChildren, []);
      assert.deepEqual(result.unknownRuntimeChildren, []);
      assert.equal(fs.existsSync(userDataPath), false);
      assert.equal(fs.existsSync(path.join(runtimePath, 'ollama-catalog.json')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the per-project notes directory and its atomic-write leftovers', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      const notesDir = path.join(userDataPath, 'project-notes');
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(path.join(notesDir, 'project_alpha.json'), '{"version":1}');
      fs.writeFileSync(path.join(notesDir, 'project_alpha.json.1760000000000.0123456789ab.tmp'), '{}');

      const result = await cleanupJennyData({ userDataPath });

      assert.equal(result.status, 'complete');
      assert.deepEqual(result.unknownUserDataChildren, []);
      assert.equal(fs.existsSync(notesDir), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes preserved damaged copies, migration backups and orphaned write temps of known files', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath, { recursive: true });
      const owned = [
        'shell-config.json.corrupt-1760000000000',
        'sessions.json.migrated-1760000000000',
        'sessions.json.1760000000000.0123456789ab.tmp',
      ];
      for (const name of owned) fs.writeFileSync(path.join(userDataPath, name), 'private');

      const targets = buildCleanupTargets({ userDataPath });
      assert.equal(targets.every(validateCleanupTarget), true);
      const result = await cleanupJennyData({ userDataPath });

      assert.equal(result.status, 'complete');
      assert.deepEqual(result.unknownUserDataChildren, []);
      assert.equal(owned.some((name) => fs.existsSync(path.join(userDataPath, name))), false);
      assert.equal(fs.existsSync(userDataPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains names that only resemble owned derived files and reports them unknown', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath, { recursive: true });
      const lookAlikeFiles = [
        'notes.json.corrupt-1760000000000',
        'sessions.json.migrated-abc',
        'notes.json.1760000000000.0123456789ab.tmp',
        'sessions.json.1760000000000.0123456789AB.tmp',
        'my-notes.txt',
      ];
      for (const name of lookAlikeFiles) fs.writeFileSync(path.join(userDataPath, name), 'keep');
      const damagedDirectory = 'shell-config.json.corrupt-1760000000000';
      fs.mkdirSync(path.join(userDataPath, damagedDirectory));
      fs.writeFileSync(path.join(userDataPath, damagedDirectory, 'inner.txt'), 'keep');

      assert.equal(buildCleanupTargets({ userDataPath }).length, 0);
      const result = await cleanupJennyData({ userDataPath });

      assert.equal(result.status, 'complete');
      assert.deepEqual(result.unknownUserDataChildren, [damagedDirectory, ...lookAlikeFiles].sort());
      assert.deepEqual(result.warnings, [`Retained ${lookAlikeFiles.length + 1} unknown profile item(s).`]);
      for (const name of lookAlikeFiles) assert.equal(fs.readFileSync(path.join(userDataPath, name), 'utf8'), 'keep');
      assert.equal(fs.readFileSync(path.join(userDataPath, damagedDirectory, 'inner.txt'), 'utf8'), 'keep');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects forged derived-child targets', () => {
    const root = path.join(os.tmpdir(), 'profile');
    const valid = {
      kind: 'user_data_derived_child',
      root,
      name: 'sessions.json.migrated-1760000000000',
      path: path.join(root, 'sessions.json.migrated-1760000000000'),
    };
    assert.equal(validateCleanupTarget(valid), true);
    assert.equal(validateCleanupTarget({
      ...valid, name: 'notes.json.corrupt-1760000000000', path: path.join(root, 'notes.json.corrupt-1760000000000'),
    }), false);
    assert.equal(validateCleanupTarget({ ...valid, path: path.join(root, 'sub', valid.name) }), false);
    assert.equal(validateCleanupTarget({ ...valid, name: 'sessions.json', path: path.join(root, 'sessions.json') }), false);
  });

  it('removes an empty known-only profile root and remains idempotent', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath);
      fs.writeFileSync(path.join(userDataPath, 'sessions.json'), '{}');
      assert.equal((await cleanupJennyData({ userDataPath })).ok, true);
      assert.equal(fs.existsSync(userDataPath), false);
      assert.equal((await cleanupJennyData({ userDataPath })).ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a profile root retained when the final removal finds late content', async () => {
    const root = makeTempRoot();
    const originalRmdir = fs.promises.rmdir;
    try {
      const userDataPath = path.join(root, 'profile');
      const lateChildPath = path.join(userDataPath, 'late-child.txt');
      fs.mkdirSync(userDataPath);
      fs.promises.rmdir = async function failNonEmptyRemoval(targetPath) {
        assert.equal(path.resolve(targetPath), path.resolve(userDataPath));
        fs.writeFileSync(lateChildPath, 'retain');
        throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
      };

      const result = await cleanupJennyData({ userDataPath });
      assert.notEqual(result.status, 'complete');
      assert.equal(fs.existsSync(lateChildPath), true);
      assert.deepEqual(
        result.results.filter((entry) => entry.status === 'retained'),
        [{ kind: 'profile_root', name: 'Jenny profile', status: 'retained', reason: 'ENOTEMPTY' }]
      );
    } finally {
      fs.promises.rmdir = originalRmdir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects roots and forged child targets', () => {
    assert.throws(() => buildCleanupTargets({ userDataPath: path.parse(process.cwd()).root }), /filesystem root/);
    assert.equal(validateCleanupTarget({ kind: 'user_data_child', path: path.parse(process.cwd()).root }), false);
    assert.equal(validateCleanupTarget({
      kind: 'runtime_child', root: process.cwd(), name: 'logs', path: path.dirname(process.cwd()),
    }), false);
  });

  it('fails closed when a selected recursive target contains a link', async (t) => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      const externalPath = path.join(root, 'external');
      fs.mkdirSync(userDataPath);
      fs.mkdirSync(externalPath);
      fs.writeFileSync(path.join(externalPath, 'keep.txt'), 'keep');
      try {
        fs.symlinkSync(externalPath, path.join(userDataPath, 'sessions'), 'junction');
      } catch (error) {
        t.skip(`junction creation unavailable: ${error.code || 'unknown'}`);
        return;
      }
      const result = await cleanupJennyData({ userDataPath });
      assert.equal(result.ok, false);
      assert.equal(result.results[0].reason, 'reparse_or_symlink');
      assert.equal(fs.readFileSync(path.join(externalPath, 'keep.txt'), 'utf8'), 'keep');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates inspection failures and continues removing later fixed targets', async () => {
    const root = makeTempRoot();
    const originalReaddirSync = fs.readdirSync;
    try {
      const userDataPath = path.join(root, 'profile');
      const sessionsPath = path.join(userDataPath, 'sessions');
      fs.mkdirSync(sessionsPath, { recursive: true });
      fs.writeFileSync(path.join(sessionsPath, 'one.json'), '{}');
      fs.writeFileSync(path.join(userDataPath, 'sessions.json'), '{}');
      fs.readdirSync = function failSelectedInspection(targetPath, ...args) {
        if (path.resolve(targetPath) === path.resolve(sessionsPath)) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return originalReaddirSync.call(fs, targetPath, ...args);
      };

      const result = await cleanupJennyData({ userDataPath });
      assert.equal(result.ok, false);
      assert.equal(fs.existsSync(sessionsPath), true);
      assert.equal(fs.existsSync(path.join(userDataPath, 'sessions.json')), false);
      assert.deepEqual(
        result.results.find((entry) => entry.name === 'sessions'),
        { kind: 'user_data_child', name: 'sessions', status: 'retained', reason: 'EACCES' }
      );
    } finally {
      fs.readdirSync = originalReaddirSync;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
