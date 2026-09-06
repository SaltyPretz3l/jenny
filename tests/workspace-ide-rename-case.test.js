'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { WorkspaceIdeService } = require('../services/workspace-ide-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function createService(workspaceRoot) {
  const rootCoordinator = new WorkspaceRootCoordinator({
    initialRootPath: workspaceRoot,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => value ? `root:${String(value).toLowerCase()}` : null,
  });
  return new WorkspaceIdeService({
    configService: {
      getToolsWorkspaceRoot: () => workspaceRoot,
      getState: () => ({ toolsWorkspaceRoot: workspaceRoot }),
      getWorkspaceRootStatus: () => ({ state: 'ready', message: '' }),
    },
    rootContextProvider: () => rootCoordinator,
  });
}

function probeCaseInsensitive(root) {
  const lowerPath = path.join(root, 'a.tmp');
  fs.writeFileSync(lowerPath, 'probe', 'utf8');
  try {
    fs.statSync(path.join(root, 'A.TMP'));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  } finally {
    fs.rmSync(lowerPath, { force: true });
  }
}

async function assertExistsRefusal(promise) {
  await assert.rejects(promise, (error) => {
    assert.deepEqual(
      [error.code, error.message],
      [WORKSPACE_FS_ERROR_CODES.EXISTS, 'A file or folder with that name already exists.']
    );
    return true;
  });
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('workspace-ide-service case-only rename succeeds on a case-insensitive filesystem', async (t) => {
  const root = createTrackedTempDir('jenny-ide-rename-case-');
  const caseInsensitive = probeCaseInsensitive(root);
  fs.writeFileSync(path.join(root, 'Foo.js'), 'content', 'utf8');

  const result = await createService(root).rename({ from: 'Foo.js', to: 'foo.js' });

  assert.deepEqual(result, { from: 'Foo.js', to: 'foo.js', kind: 'file' });
  assert.equal(fs.readFileSync(path.join(root, 'foo.js'), 'utf8'), 'content');
  if (!caseInsensitive) {
    t.diagnostic('case-insensitive-specific path skipped; normal case-sensitive rename succeeded');
  }
});

test('workspace-ide-service rename still refuses a different existing file', async () => {
  const root = createTrackedTempDir('jenny-ide-rename-case-');
  fs.writeFileSync(path.join(root, 'source.js'), 'source', 'utf8');
  fs.writeFileSync(path.join(root, 'target.js'), 'target', 'utf8');
  const service = createService(root);

  await assertExistsRefusal(service.rename({ from: 'source.js', to: 'target.js' }));

  assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'source');
  assert.equal(fs.readFileSync(path.join(root, 'target.js'), 'utf8'), 'target');
});

test('workspace-ide-service rename refuses a hardlink sibling without removing either entry', async (t) => {
  const root = createTrackedTempDir('jenny-ide-rename-case-');
  const sourcePath = path.join(root, 'a.txt');
  const targetPath = path.join(root, 'b.txt');
  fs.writeFileSync(sourcePath, 'shared', 'utf8');
  try {
    fs.linkSync(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    t.skip(`hardlink creation unavailable: ${error.code || error.message}`);
    return;
  }

  await assertExistsRefusal(createService(root).rename({ from: 'a.txt', to: 'b.txt' }));

  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(fs.existsSync(targetPath), true);
});

test('workspace-ide-service exact same-name rename still refuses', async () => {
  const root = createTrackedTempDir('jenny-ide-rename-case-');
  fs.writeFileSync(path.join(root, 'same.js'), 'content', 'utf8');
  const service = createService(root);

  await assertExistsRefusal(service.rename({ from: 'same.js', to: 'same.js' }));

  assert.equal(fs.readFileSync(path.join(root, 'same.js'), 'utf8'), 'content');
});

test('workspace-ide-service case-only rename preserves new casing without temp residue', async (t) => {
  const root = createTrackedTempDir('jenny-ide-rename-case-');
  const caseInsensitive = probeCaseInsensitive(root);
  fs.writeFileSync(path.join(root, 'MixedCase.txt'), 'content', 'utf8');

  await createService(root).rename({ from: 'MixedCase.txt', to: 'mixedcase.txt' });

  const entries = fs.readdirSync(root);
  assert.equal(entries.includes('mixedcase.txt'), true);
  assert.equal(entries.includes('MixedCase.txt'), false);
  assert.equal(entries.some((entry) => entry.includes('.tmp-rename-')), false);
  if (!caseInsensitive) {
    t.diagnostic('case-insensitive-specific path skipped; directory casing asserted after normal rename');
  }
});

test('case-only rename bounds its temp hint for a 240-character filename', async (t) => {
  const root = createTrackedTempDir('jenny-ide-rename-case-');
  if (!probeCaseInsensitive(root)) return t.skip('case-only rename temp path requires a case-insensitive filesystem');
  const from = `${'a'.repeat(236)}.txt`;
  const to = `${'A'.repeat(236)}.txt`;
  fs.writeFileSync(path.join(root, from), 'long-name', 'utf8');

  await createService(root).rename({ from, to });

  assert.equal(fs.readFileSync(path.join(root, to), 'utf8'), 'long-name');
  assert.equal(fs.readdirSync(root).some((entry) => entry.includes('.tmp-rename-')), false);
});
