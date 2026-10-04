'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { WorkspaceIdeService } = require('../services/workspace-ide-service');
const { normalizeWorkspaceRelPath } = require('../services/workspace-ide-path-guard');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');
const { VersionedWorkspaceFileService } = require('../services/versioned-workspace-file-service');
const { WorkspaceGitService } = require('../services/workspace-git-service');
const { WORKSPACE_GIT_ERROR_CODES } = require('../services/workspace-git-errors');
const { normalizeWatchedRelPath, isGitMetaPath } = require('../services/workspace-ide-watcher');
const { normalizeWorkspaceIdeRelativePath } = require('../services/workspace-ide-config-schema');
const ideState = require('../renderer/features/renderer-ide-state');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createIdeService(root, extra = {}) {
  const rootCoordinator = new WorkspaceRootCoordinator({
    initialRootPath: root,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => (value ? `root:${String(value).toLowerCase()}` : null),
  });
  return new WorkspaceIdeService({
    configService: {
      getToolsWorkspaceRoot: () => root,
      getState: () => ({ toolsWorkspaceRoot: root }),
      getWorkspaceRootStatus: () => ({ state: 'ready', message: '' }),
    },
    rootContextProvider: () => rootCoordinator,
    ...extra,
  });
}

function createVersionedService(root, platform = process.platform) {
  const context = Object.freeze({ rootPath: root, rootId: 'root-a', generation: 7, phase: 'ready' });
  let seq = 0;
  const rootContext = {
    captureContext: () => context,
    acquireOperation() {
      seq += 1;
      const controller = new AbortController();
      return {
        acquired: true,
        operationId: `op-${seq}`,
        context,
        signal: controller.signal,
        release: () => true,
        isCurrent: () => true,
      };
    },
    isCurrent: (candidate) => Boolean(candidate && candidate.rootId === context.rootId),
  };
  return new VersionedWorkspaceFileService({ rootContext, platform });
}

function assertPathInvalid(error) {
  assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID);
  return true;
}

test('IDE-014 P12: a leading-space file name addresses that file, never its trimmed sibling', async () => {
  const root = createTrackedTempDir('jenny-relpath-');
  fs.writeFileSync(path.join(root, ' target.txt'), 'spaced', 'utf8');
  fs.writeFileSync(path.join(root, 'target.txt'), 'plain', 'utf8');
  const trashed = [];
  const service = createIdeService(root, {
    trashItemImpl: async (target) => { trashed.push(target); },
  });

  const stat = await service.stat({ path: ' target.txt' });
  assert.equal(stat.size, 'spaced'.length);
  const read = await service.readFile({ path: ' target.txt' });
  assert.equal(read.content, 'spaced');

  const deleted = await service.delete({ path: ' target.txt' });
  assert.equal(deleted.path, ' target.txt');
  assert.equal(trashed.length, 1);
  assert.equal(path.basename(trashed[0]), ' target.txt');

  await service.rename({ from: ' target.txt', to: 'renamed.txt' });
  assert.equal(fs.existsSync(path.join(root, ' target.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'renamed.txt'), 'utf8'), 'spaced');
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'plain', 'the sibling is untouched');
});

test('IDE-014: search scope is typed input, so padding around it is still trimmed', async () => {
  const root = createTrackedTempDir('jenny-relpath-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'needle', 'utf8');
  fs.writeFileSync(path.join(root, 'b.txt'), 'needle', 'utf8');
  const service = createIdeService(root);

  const result = await service.searchInFiles({ query: 'needle', scope: '  src  ' });
  assert.deepEqual(
    result.results.map((entry) => entry.path),
    ['src/a.txt']
  );
});

test('IDE-014: versioned readText and writeText address the leading-space file', async () => {
  const root = createTrackedTempDir('jenny-relpath-');
  fs.writeFileSync(path.join(root, ' target.txt'), 'spaced', 'utf8');
  fs.writeFileSync(path.join(root, 'target.txt'), 'plain', 'utf8');
  const service = createVersionedService(root);

  const opened = await service.readText({ path: ' target.txt' });
  assert.equal(opened.content, 'spaced');
  await service.writeText({
    path: ' target.txt',
    content: 'edited',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  });
  assert.equal(fs.readFileSync(path.join(root, ' target.txt'), 'utf8'), 'edited');
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'plain');
});

test('IDE-014: versioned service rejects whitespace-only, padded absolutes and win32 trailing space/period', async () => {
  const root = createTrackedTempDir('jenny-relpath-');
  const linux = createVersionedService(root, 'linux');
  const win = createVersionedService(root, 'win32');
  for (const bad of ['   ', ' /abs', ' C:/x', 'a/../b', ' //unc/share']) {
    await assert.rejects(linux.readText({ path: bad }), assertPathInvalid, `linux ${JSON.stringify(bad)}`);
    await assert.rejects(win.readText({ path: bad }), assertPathInvalid, `win32 ${JSON.stringify(bad)}`);
  }
  for (const bad of ['a/b.txt ', 'dir./x']) {
    await assert.rejects(win.readText({ path: bad }), assertPathInvalid, `win32 ${JSON.stringify(bad)}`);
  }
  assert.equal(linux._normalizeRelPath('a/b.txt '), 'a/b.txt ');
  assert.equal(linux._normalizeRelPath('dir./x'), 'dir./x');
});

test('IDE-014: normalizeWorkspaceRelPath keeps whitespace and rejects Windows-aliasing trailing space/period', () => {
  for (const bad of ['a/b.txt ', 'dir./x', 'a/b.']) {
    assert.throws(
      () => normalizeWorkspaceRelPath(bad, { platform: 'win32' }),
      (error) => {
        assertPathInvalid(error);
        assert.equal(error.message, 'A name can\'t end with a space or a period on Windows.');
        return true;
      },
      JSON.stringify(bad)
    );
  }
  assert.equal(normalizeWorkspaceRelPath('a/b.txt ', { platform: 'linux' }), 'a/b.txt ');
  assert.equal(normalizeWorkspaceRelPath('dir./x', { platform: 'linux' }), 'dir./x');
  assert.equal(normalizeWorkspaceRelPath(' lead.txt', { platform: 'win32' }), ' lead.txt');
  assert.equal(normalizeWorkspaceRelPath(' sp ace /x y', { platform: 'linux' }), ' sp ace /x y');
  for (const platform of ['win32', 'linux']) {
    for (const bad of ['   ', ' /abs', ' C:/x', 'a/../b', '', 'a\0b']) {
      assert.throws(() => normalizeWorkspaceRelPath(bad, { platform }), assertPathInvalid, `${platform} ${JSON.stringify(bad)}`);
    }
  }
});

test('IDE-014: WorkspaceGitService keeps whitespace and still rejects padded absolutes', () => {
  const git = Object.create(WorkspaceGitService.prototype);
  assert.equal(git._normalizeRelPath(' a.txt'), ' a.txt');
  assert.equal(git._normalizeRelPath('a.txt '), 'a.txt ');
  for (const bad of ['   ', ' /abs', ' C:/x', 'a/../b']) {
    assert.throws(
      () => git._normalizeRelPath(bad),
      (error) => error.code === WORKSPACE_GIT_ERROR_CODES.PATH_INVALID,
      JSON.stringify(bad)
    );
  }
});

test('IDE-014: watcher and config-schema normalizers keep exact names', () => {
  assert.equal(normalizeWatchedRelPath(' a.txt'), ' a.txt');
  assert.equal(normalizeWatchedRelPath('   '), '');
  assert.equal(normalizeWatchedRelPath(' /abs'), '');
  assert.equal(normalizeWatchedRelPath(' C:/x'), '');
  assert.equal(isGitMetaPath(' .git/HEAD'), false, 'a space-led directory is not the .git directory');
  assert.equal(isGitMetaPath('.git/HEAD'), true);
  assert.equal(normalizeWorkspaceIdeRelativePath(' a.txt'), ' a.txt');
  assert.equal(normalizeWorkspaceIdeRelativePath('   '), '');
  assert.equal(normalizeWorkspaceIdeRelativePath(' /abs'), '');
  assert.equal(normalizeWorkspaceIdeRelativePath(' C:/x'), '');
});

test('IDE-014: renderer normalizeIdeRelativePath keeps exact names', () => {
  const utils = ideState;
  assert.equal(utils.normalizeIdeRelativePath(' a.txt'), ' a.txt');
  assert.equal(utils.normalizeIdeRelativePath('   '), '');
  assert.equal(utils.normalizeIdeRelativePath(' /abs'), '');
  assert.equal(utils.normalizeIdeRelativePath(' C:/x'), '');
});

test('IDE-014: the editor open path reads the exact leading-space name', async () => {
  const fileOperations = require('../renderer/features/renderer-ide-file-operations');
  const reads = [];
  const ops = fileOperations.createIdeFileOperations({
    platform: 'win32',
    getWorkspaceFsApi: () => ({
      readText: async ({ path: requested }) => { reads.push(requested); return { ok: false, code: 'X' }; },
    }),
  });
  const resolved = ops.resolvePath(ideState.normalizeIdeRelativePath(' target.txt'));
  const intent = ops.beginOpen(resolved);
  await ops.readForOpen(intent).catch(() => {});
  assert.equal(resolved, ' target.txt');
  assert.equal(intent.path, ' target.txt');
  assert.deepEqual(reads, [' target.txt']);
  assert.equal(ops.resolvePath('   '), '', 'whitespace-only is still no path');
});

test('IDE-014: an import destination keeps the folder name Explorer listed', () => {
  const { WorkspaceImportService } = require('../services/workspace-import-service');
  const service = new WorkspaceImportService({ rootContextProvider: () => null, isQolEnabled: () => true });
  assert.equal(service._validateDestination(' assets'), ' assets');
  assert.equal(service._validateDestination('   '), '');
});
