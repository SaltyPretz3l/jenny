'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorktreeService } = require('../services/worktree-service');

function createService({ porcelain, repositoryRoot, registryEntries = [] }) {
  let entries = registryEntries.map((entry) => ({ ...entry }));
  let saveCount = 0;
  const registry = {
    filePath: 'worktrees.json',
    listAll() {
      return entries.map((entry) => ({ ...entry }));
    },
    saveAll(nextEntries) {
      saveCount += 1;
      entries = nextEntries.map((entry) => ({ ...entry }));
      return true;
    },
  };
  const service = new WorktreeService({ registryService: registry });
  service._runGit = async (_cwd, args) => ({
    success: true,
    stdout: args[0] === 'rev-parse' ? `${repositoryRoot}\n` : porcelain,
    stderr: '',
    message: '',
  });
  return {
    service,
    getEntries: () => entries,
    getSaveCount: () => saveCount,
  };
}

test('listWorktrees persists reconciled missing state for describeStatus without dropping other repos', async (t) => {
  const repositoryRoot = path.resolve('C:/repo/current');
  // "definitely-missing" was a claim about a fixed shared path, not a guarantee.
  // A never-created child of a just-created directory is one.
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-worktree-missing-'));
  t.after(() => fs.rmSync(missingRoot, { recursive: true, force: true }));
  const missingPath = path.join(missingRoot, 'gone');
  const otherRoot = path.resolve('C:/repo/other');
  const porcelain = [
    `worktree ${repositoryRoot}`,
    'HEAD abc123',
    'branch refs/heads/main',
    '',
  ].join('\n');
  const { service, getEntries, getSaveCount } = createService({
    porcelain,
    repositoryRoot,
    registryEntries: [
      {
        id: 'current-missing',
        repository_root: repositoryRoot,
        worktree_path: missingPath,
        status: 'available',
        last_checked_at: 'old',
      },
      {
        id: 'other-repo',
        repository_root: otherRoot,
        worktree_path: path.join(otherRoot, 'worktree'),
        status: 'available',
        last_checked_at: 'other-old',
      },
    ],
  });

  const listed = await service.listWorktrees({ workspaceRoot: repositoryRoot });
  const status = service.describeStatus({ workspaceRoot: repositoryRoot });

  assert.equal(listed.success, true);
  assert.equal(getSaveCount(), 1);
  assert.equal(getEntries().find((entry) => entry.id === 'current-missing').status, 'missing');
  assert.notEqual(getEntries().find((entry) => entry.id === 'current-missing').last_checked_at, 'old');
  assert.equal(getEntries().find((entry) => entry.id === 'other-repo').last_checked_at, 'other-old');
  assert.equal(status.registry_count, 2);
  assert.equal(status.missing_count, 1);
});
