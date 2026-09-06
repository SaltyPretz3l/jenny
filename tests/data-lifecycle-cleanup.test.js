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
