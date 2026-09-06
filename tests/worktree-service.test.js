'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  WorktreeRegistryService,
} = require('../services/worktree-registry-service');
const {
  WorktreePathPolicy,
} = require('../services/worktree-path-policy');
const {
  WorktreeService,
  parseGitStatusPorcelainSummary,
} = require('../services/worktree-service');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
  trackDirectory,
} = require('./helpers/resource-cleanup');

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
  });
}

async function createGitRepo(prefix = 'jenny-worktree-repo-') {
  const repoRoot = createTrackedTempDir(prefix);
  trackDirectory(path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`));
  await git(repoRoot, ['init']);
  await git(repoRoot, ['config', 'user.email', 'jenny@example.invalid']);
  await git(repoRoot, ['config', 'user.name', 'Jenny Tests']);
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  await git(repoRoot, ['add', 'README.md']);
  await git(repoRoot, ['commit', '-m', 'initial']);
  return repoRoot;
}

function createService() {
  const userData = createTrackedTempDir('jenny-worktree-userdata-');
  const registry = new WorktreeRegistryService(path.join(userData, 'worktrees.json'));
  return {
    registry,
    service: new WorktreeService({
      registryService: registry,
      gitTimeoutMs: 30000,
      logger() {},
    }),
  };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('WorktreeRegistryService', () => {
  test('refuses to overwrite a forward-version registry during mutation', async () => {
    const userData = createTrackedTempDir('jenny-worktree-registry-forward-');
    const registryPath = path.join(userData, 'worktrees.json');
    const original = JSON.stringify({ version: 999, worktrees: [{ future: true }] });
    await fs.writeFile(registryPath, original, 'utf8');
    const registry = new WorktreeRegistryService(registryPath);

    assert.throws(
      () => registry.add({
        id: 'wt_new',
        repository_root: userData,
        worktree_path: path.join(userData, 'new'),
      }),
      /newer than supported/
    );
    assert.equal(await fs.readFile(registryPath, 'utf8'), original);
  });
});

describe('WorktreePathPolicy', () => {
  test('rejects traversal outside the configured parent', async () => {
    const root = createTrackedTempDir('jenny-worktree-policy-');
    const parent = path.join(root, 'parent');
    await fs.mkdir(parent, { recursive: true });

    const policy = new WorktreePathPolicy();
    await assert.rejects(
      () => policy.resolveTarget({
        repositoryRoot: root,
        parentPath: parent,
        name: '../escape',
      }),
      /traversal segments/
    );
  });

  test('rejects traversal segments even when the resolved target stays inside parent', async () => {
    const root = createTrackedTempDir('jenny-worktree-policy-inner-traversal-');
    const parent = path.join(root, 'parent');
    await fs.mkdir(parent, { recursive: true });

    const policy = new WorktreePathPolicy();
    await assert.rejects(
      () => policy.resolveTarget({
        repositoryRoot: root,
        parentPath: parent,
        name: 'nested/../target',
      }),
      /traversal segments/
    );
  });

  test('rejects realpath escapes through linked directories', async (t) => {
    const root = createTrackedTempDir('jenny-worktree-link-policy-');
    const parent = path.join(root, 'parent');
    const outside = path.join(root, 'outside');
    const link = path.join(parent, 'link');
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink unavailable in this environment: ${error.message}`);
      return;
    }

    const policy = new WorktreePathPolicy();
    await assert.rejects(
      () => policy.resolveTarget({
        repositoryRoot: root,
        parentPath: parent,
        name: path.join('link', 'escape'),
      }),
      /linked path escapes/
    );
  });

  test('rejects symlinked or junction worktree parents', async (t) => {
    const root = createTrackedTempDir('jenny-worktree-parent-link-policy-');
    const outside = path.join(root, 'outside');
    const parent = path.join(root, 'parent-link');
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink unavailable in this environment: ${error.message}`);
      return;
    }

    const policy = new WorktreePathPolicy();
    await assert.rejects(
      () => policy.resolveTarget({
        repositoryRoot: root,
        parentPath: parent,
        name: 'target',
      }),
      /parent path must not be a symbolic link or junction/
    );
  });

  test('rejects paths longer than the injected platform limit', async () => {
    const root = createTrackedTempDir('jenny-worktree-length-policy-');
    const parent = path.join(root, 'parent');
    await fs.mkdir(parent, { recursive: true });

    const policy = new WorktreePathPolicy({ maxPathLength: parent.length + 10 });
    await assert.rejects(
      () => policy.resolveTarget({
        repositoryRoot: root,
        parentPath: parent,
        name: 'feature-with-a-long-name',
      }),
      /path is too long/
    );
  });
});

describe('WorktreeService', () => {
  test('parseGitStatusPorcelainSummary counts modified, staged, and untracked rows', () => {
    assert.deepEqual(
      parseGitStatusPorcelainSummary(' M README.md\nM  package.json\n?? scratch.txt\nA  added.txt\n'),
      {
        modified_count: 1,
        staged_count: 2,
        untracked_count: 1,
        ignored_count: 0,
      }
    );
  });

  test('createWorktree adds a codex-prefixed worktree and records it without changing the active root', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();

    const result = await service.createWorktree({
      workspaceRoot: repoRoot,
      name: 'Feature Alpha',
      baseRef: 'HEAD',
      owner: { session_id: 'session_1', task_id: 'call_1' },
    });

    assert.equal(result.success, true);
    assert.equal(result.worktree.branch, 'jenny/feature-alpha');
    assert.equal(result.worktree.repository_root, path.resolve(repoRoot));
    assert.equal(result.worktree.base_ref, 'HEAD');
    assert.equal(result.active_root_changed, false);
    assert.match(result.worktree.id, /^wt_/);

    const stat = await fs.stat(result.worktree.worktree_path);
    assert.equal(stat.isDirectory(), true);

    const entries = registry.listAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, result.worktree.id);
    assert.equal(entries[0].status, 'available');
  });

  test('listWorktrees merges git-discovered worktrees with registry state', async () => {
    const repoRoot = await createGitRepo();
    const { service } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/list-fixture',
      baseRef: 'HEAD',
    });

    const listed = await service.listWorktrees({ workspaceRoot: repoRoot });

    assert.equal(listed.success, true);
    assert.equal(listed.repository_root, path.resolve(repoRoot));
    assert.ok(listed.worktrees.some((entry) => entry.path === path.resolve(repoRoot)));
    const createdEntry = listed.worktrees.find(
      (entry) => entry.path === created.worktree.worktree_path
    );
    assert.ok(createdEntry);
    assert.equal(createdEntry.branch, 'codex/list-fixture');
    assert.equal(createdEntry.registry_id, created.worktree.id);
    assert.equal(createdEntry.status, 'available');
  });

  test('describeStatus returns bounded registry counts without paths', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/status-fixture',
      baseRef: 'HEAD',
    });
    registry.saveAll([
      {
        ...created.worktree,
        status: 'stale',
      },
      {
        ...created.worktree,
        id: `${created.worktree.id}_missing`,
        worktree_path: path.join(path.dirname(created.worktree.worktree_path), 'missing'),
        status: 'missing',
      },
    ]);

    const status = service.describeStatus({ workspaceRoot: repoRoot });

    assert.deepEqual(status, {
      kind: 'worktree',
      active_root_configured: true,
      registry_count: 2,
      stale_count: 1,
      missing_count: 1,
      registry_readable: true,
    });
    assert.equal(JSON.stringify(status).includes(repoRoot), false);
  });

  test('resolveSelectableWorktree returns a registry-owned available worktree', async () => {
    const repoRoot = await createGitRepo();
    const { service } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/select-fixture',
      baseRef: 'HEAD',
    });

    const selected = await service.resolveSelectableWorktree({
      workspaceRoot: repoRoot,
      worktreeId: created.worktree.id,
    });

    assert.equal(selected.success, true);
    assert.equal(selected.result_kind, 'worktree_select');
    assert.equal(selected.worktree.id, created.worktree.id);
    assert.equal(selected.worktree_path, created.worktree.worktree_path);
  });

  test('worktree operations resolve the primary repository when started inside a linked worktree', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/linked-root',
      baseRef: 'HEAD',
    });

    const listed = await service.listWorktrees({
      workspaceRoot: created.worktree.worktree_path,
    });
    const selected = await service.resolveSelectableWorktree({
      workspaceRoot: created.worktree.worktree_path,
      worktreeId: created.worktree.id,
    });
    const deleted = await service.deleteWorktree({
      workspaceRoot: created.worktree.worktree_path,
      worktreeId: created.worktree.id,
    });

    assert.equal(listed.success, true);
    assert.equal(listed.repository_root, path.resolve(repoRoot));
    assert.ok(listed.worktrees.some((entry) => entry.registry_id === created.worktree.id));
    assert.equal(selected.success, true);
    assert.equal(selected.repository_root, path.resolve(repoRoot));
    assert.equal(deleted.success, true);
    assert.equal(deleted.status, 'deleted');
    assert.deepEqual(registry.listAll(), []);
  });

  test('resolveSelectableWorktree rejects unknown and missing registry entries', async () => {
    const repoRoot = await createGitRepo();
    const { service } = createService();

    const unknown = await service.resolveSelectableWorktree({
      workspaceRoot: repoRoot,
      worktreeId: 'wt_missing',
    });

    assert.equal(unknown.success, false);
    assert.equal(unknown.reason, 'worktree_not_found');

    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/select-missing',
      baseRef: 'HEAD',
    });
    await fs.rm(created.worktree.worktree_path, { recursive: true, force: true });

    const missing = await service.resolveSelectableWorktree({
      workspaceRoot: repoRoot,
      worktreeId: created.worktree.id,
    });

    assert.equal(missing.success, false);
    assert.equal(missing.reason, 'worktree_missing');
  });

  test('resolveSelectableWorktree rejects registry paths that escape the worktree parent', async (t) => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    const parent = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`);
    const outside = path.join(path.dirname(repoRoot), 'outside-selected-worktree');
    const link = path.join(parent, 'linked-selection');
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink unavailable in this environment: ${error.message}`);
      return;
    }
    registry.add({
      id: 'wt_escape',
      repository_root: path.resolve(repoRoot),
      worktree_path: link,
      branch: 'codex/escape',
      base_ref: 'HEAD',
      status: 'available',
    });

    const selected = await service.resolveSelectableWorktree({
      workspaceRoot: repoRoot,
      worktreeId: 'wt_escape',
    });

    assert.equal(selected.success, false);
    assert.equal(selected.reason, 'path_policy_rejected');
  });

  test('deleteWorktree removes a clean registry-owned worktree', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/delete-clean',
      baseRef: 'HEAD',
    });

    const deleted = await service.deleteWorktree({
      workspaceRoot: repoRoot,
      worktreeId: created.worktree.id,
    });

    assert.equal(deleted.success, true);
    assert.equal(deleted.result_kind, 'worktree_delete');
    assert.equal(deleted.status, 'deleted');
    assert.deepEqual(registry.listAll(), []);
    await assert.rejects(
      () => fs.stat(created.worktree.worktree_path),
      /ENOENT/
    );
  });

  test('deleteWorktree serializes concurrent deletes for the same registry id', async () => {
    const repoRoot = createTrackedTempDir('jenny-worktree-concurrent-delete-');
    const worktreeParent = path.join(
      path.dirname(repoRoot),
      `${path.basename(repoRoot)}-worktrees`
    );
    const worktreePath = path.join(worktreeParent, 'duplicate-delete');
    trackDirectory(worktreeParent);
    await fs.mkdir(worktreePath, { recursive: true });
    const { service, registry } = createService();
    const entry = registry.add({
      id: 'wt_concurrent_delete',
      repository_root: repoRoot,
      worktree_path: worktreePath,
      branch: 'codex/concurrent-delete',
      base_ref: 'HEAD',
      status: 'available',
    });
    let statusCalls = 0;
    let removeCalls = 0;
    let releaseStatusBarrier;
    const statusBarrier = new Promise((resolve) => {
      releaseStatusBarrier = resolve;
    });
    service._runGit = async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { success: true, stdout: `${repoRoot}\n`, stderr: '', message: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          success: true,
          stdout: `worktree ${repoRoot}\nHEAD fixture\nbranch refs/heads/main\n\n`,
          stderr: '',
          message: '',
        };
      }
      if (args[0] === 'status') {
        statusCalls += 1;
        if (statusCalls === 2) {
          releaseStatusBarrier();
        }
        await Promise.race([
          statusBarrier,
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
        return { success: true, stdout: '', stderr: '', message: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeCalls += 1;
        if (removeCalls === 1) {
          return { success: true, stdout: '', stderr: '', message: '' };
        }
        return {
          success: false,
          reason: 'git_failed',
          stdout: '',
          stderr: 'worktree is already gone',
          message: 'worktree is already gone',
        };
      }
      assert.fail(`Unexpected git command: ${args.join(' ')}`);
    };

    const results = await Promise.all([
      service.deleteWorktree({ workspaceRoot: repoRoot, worktreeId: entry.id }),
      service.deleteWorktree({ workspaceRoot: repoRoot, worktreeId: entry.id }),
    ]);

    assert.equal(registry.listAll().some((row) => row.id === entry.id), false);
    assert.equal(
      results.some((result) => result.rollback?.registry_restored === true),
      false
    );
    assert.equal(removeCalls, 1);
    assert.deepEqual(results.map((result) => result.success), [true, true]);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ['already_deleted', 'deleted']
    );
  });

  test('deleteWorktree publishes same-id serialization before repository resolution', async () => {
    const repoRoot = createTrackedTempDir('jenny-worktree-delete-resolution-');
    const worktreeParent = path.join(
      path.dirname(repoRoot),
      `${path.basename(repoRoot)}-worktrees`
    );
    const worktreePath = path.join(worktreeParent, 'delayed-resolution');
    trackDirectory(worktreeParent);
    await fs.mkdir(worktreePath, { recursive: true });
    const { service, registry } = createService();
    const entry = registry.add({
      id: 'wt_delayed_resolution',
      repository_root: repoRoot,
      worktree_path: worktreePath,
      branch: 'codex/delayed-resolution',
      base_ref: 'HEAD',
      status: 'available',
    });
    let resolveCalls = 0;
    let releaseRemoveCompletion;
    const removeCompletion = new Promise((resolve) => {
      releaseRemoveCompletion = resolve;
    });
    service._runGit = async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        resolveCalls += 1;
        if (resolveCalls > 1) {
          await removeCompletion;
          return {
            success: false,
            reason: 'git_failed',
            stdout: '',
            stderr: 'worktree is already gone',
            message: 'worktree is already gone',
          };
        }
        return { success: true, stdout: `${repoRoot}\n`, stderr: '', message: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          success: true,
          stdout: `worktree ${repoRoot}\nHEAD fixture\nbranch refs/heads/main\n\n`,
          stderr: '',
          message: '',
        };
      }
      if (args[0] === 'status') {
        return { success: true, stdout: '', stderr: '', message: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        releaseRemoveCompletion();
        return { success: true, stdout: '', stderr: '', message: '' };
      }
      assert.fail(`Unexpected git command: ${args.join(' ')}`);
    };

    const results = await Promise.all([
      service.deleteWorktree({ workspaceRoot: repoRoot, worktreeId: entry.id }),
      service.deleteWorktree({ workspaceRoot: repoRoot, worktreeId: entry.id }),
    ]);

    assert.equal(resolveCalls, 1);
    assert.equal(registry.listAll().some((row) => row.id === entry.id), false);
    assert.equal(
      results.some((result) => result.rollback?.registry_restored === true),
      false
    );
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ['already_deleted', 'deleted']
    );
  });

  test('deleteWorktree fails closed when registry removal fails before disk deletion', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/delete-registry-fails',
      baseRef: 'HEAD',
    });
    registry.removeById = () => {
      throw new Error('registry locked');
    };

    const deleted = await service.deleteWorktree({
      workspaceRoot: repoRoot,
      worktreeId: created.worktree.id,
    });
    const stat = await fs.stat(created.worktree.worktree_path);

    assert.equal(deleted.success, false);
    assert.equal(deleted.reason, 'registry_remove_failed');
    assert.equal(stat.isDirectory(), true);
    assert.equal(registry.listAll().length, 1);
  });

  test('deleteWorktree restores registry entry when git removal fails after eviction', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/delete-git-fails',
      baseRef: 'HEAD',
    });
    const runGit = service._runGit.bind(service);
    service._runGit = (cwd, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return Promise.resolve({
          success: false,
          reason: 'git_failed',
          stdout: '',
          stderr: 'remove failed',
          message: 'remove failed',
        });
      }
      return runGit(cwd, args, options);
    };

    const deleted = await service.deleteWorktree({
      workspaceRoot: repoRoot,
      worktreeId: created.worktree.id,
    });

    assert.equal(deleted.success, false);
    assert.equal(deleted.reason, 'git_remove_failed');
    assert.deepEqual(deleted.rollback, {
      registry_restored: true,
      registry_restore_failed: false,
    });
    assert.equal(registry.listAll()[0].id, created.worktree.id);
  });

  test('deleteWorktree refuses dirty worktrees with bounded dirty summary', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/delete-dirty',
      baseRef: 'HEAD',
    });
    await fs.writeFile(
      path.join(created.worktree.worktree_path, 'scratch.txt'),
      'dirty\n',
      'utf8'
    );

    const deleted = await service.deleteWorktree({
      workspaceRoot: repoRoot,
      worktreeId: created.worktree.id,
    });

    assert.equal(deleted.success, false);
    assert.equal(deleted.reason, 'dirty_worktree');
    assert.deepEqual(deleted.dirty_summary, {
      modified_count: 0,
      staged_count: 0,
      untracked_count: 1,
      ignored_count: 0,
    });
    assert.equal(registry.listAll().length, 1);
  });

  test('createWorktree reports a committed effect when registry persistence fails', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    registry.add = () => {
      throw new Error('registry unavailable');
    };

    const result = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/registry-failure',
      baseRef: 'HEAD',
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'registry_add_failed');
    assert.equal(result.effect_committed, true);
    assert.equal(result.registry_persisted, false);
    assert.equal((await fs.stat(result.worktree.worktree_path)).isDirectory(), true);
  });

  test('deleteWorktree refuses ignored local files', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/delete-ignored',
      baseRef: 'HEAD',
    });
    await fs.writeFile(
      path.join(created.worktree.worktree_path, '.gitignore'),
      'scratch.log\n',
      'utf8'
    );
    await git(created.worktree.worktree_path, ['add', '.gitignore']);
    await git(created.worktree.worktree_path, ['commit', '-m', 'ignore scratch logs']);
    await fs.writeFile(
      path.join(created.worktree.worktree_path, 'scratch.log'),
      'must survive\n',
      'utf8'
    );

    const deleted = await service.deleteWorktree({
      workspaceRoot: repoRoot,
      worktreeId: created.worktree.id,
    });

    assert.equal(deleted.success, false);
    assert.equal(deleted.reason, 'dirty_worktree');
    assert.equal(deleted.dirty_summary.ignored_count, 1);
    assert.equal(registry.listAll().length, 1);
    assert.equal(
      await fs.readFile(path.join(created.worktree.worktree_path, 'scratch.log'), 'utf8'),
      'must survive\n'
    );
  });

  test('deleteWorktree prunes missing registry entries without deleting disk paths', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();
    const created = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/delete-missing',
      baseRef: 'HEAD',
    });
    await fs.rm(created.worktree.worktree_path, { recursive: true, force: true });

    const deleted = await service.deleteWorktree({
      workspaceRoot: repoRoot,
      worktreeId: created.worktree.id,
    });

    assert.equal(deleted.success, true);
    assert.equal(deleted.status, 'pruned_missing');
    assert.equal(deleted.reason, 'worktree_missing_pruned');
    assert.equal(deleted.registry_persisted, true);
    assert.deepEqual(registry.listAll(), []);
  });

  test('deleteWorktree rejects unknown registry ids', async () => {
    const repoRoot = await createGitRepo();
    const { service } = createService();

    const deleted = await service.deleteWorktree({
      workspaceRoot: repoRoot,
      worktreeId: 'wt_nope',
    });

    assert.equal(deleted.success, false);
    assert.equal(deleted.reason, 'worktree_not_found');
  });

  test('createWorktree fails closed before git add when the branch already exists', async () => {
    const repoRoot = await createGitRepo();
    await git(repoRoot, ['branch', 'codex/existing']);
    const { service, registry } = createService();

    const result = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/existing',
      baseRef: 'HEAD',
    });

    assert.equal(result.success, false);
    assert.equal(result.error_code, 'CMP-TOOL-0002');
    assert.equal(result.reason, 'branch_exists');
    assert.deepEqual(registry.listAll(), []);
  });

  test('git helper classifies aborts without noisy failure logs', async () => {
    const { service } = createService();
    const controller = new AbortController();
    const logs = [];
    service._logger = (level, event, payload) => {
      logs.push({ level, event, payload });
    };
    controller.abort();

    const result = await service._runGit(process.cwd(), ['--version'], {
      signal: controller.signal,
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'aborted');
    assert.equal(logs.some((entry) => entry.event === 'worktree.git_failed'), false);
  });

  test('createWorktree rejects unsafe branch syntax before target creation', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();

    const result = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'bad..branch',
      name: 'bad branch',
      baseRef: 'HEAD',
    });

    assert.equal(result.success, false);
    assert.equal(result.error_code, 'CMP-TOOL-0002');
    assert.equal(result.reason, 'branch_invalid');
    assert.deepEqual(registry.listAll(), []);
  });

  test('createWorktree rejects unsafe base refs before target creation', async () => {
    const repoRoot = await createGitRepo();
    const { service, registry } = createService();

    const result = await service.createWorktree({
      workspaceRoot: repoRoot,
      branch: 'codex/bad-base',
      name: 'bad base',
      baseRef: '--detach',
    });

    assert.equal(result.success, false);
    assert.equal(result.error_code, 'CMP-TOOL-0002');
    assert.equal(result.reason, 'base_ref_invalid');
    assert.deepEqual(registry.listAll(), []);
  });
});
