'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { WorkspaceIdeService } = require('../services/workspace-ide-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function createService(workspaceRoot, extra = {}) {
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
    ...extra,
  });
}

function assertPathInvalid(error, message) {
  assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID);
  if (message) assert.equal(error.message, message);
  return true;
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('createFile and createDirectory reject illegal and reserved destination names', async () => {
  const root = createTrackedTempDir('jenny-ide-name-');
  const service = createService(root);

  await assert.rejects(
    service.createFile({ path: 'foo:bar' }),
    (error) => assertPathInvalid(error, 'A name can\'t contain any of: \\ / : * ? " < > |')
  );
  await assert.rejects(
    service.createDirectory({ path: 'CON' }),
    (error) => assertPathInvalid(error, '"CON" is a reserved name in Windows.')
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test('rename rejects reserved names and trailing dots or spaces', async () => {
  const root = createTrackedTempDir('jenny-ide-name-');
  const sourceName = process.platform === 'win32' ? `${'s'.repeat(240)}.txt` : 'source.txt';
  fs.writeFileSync(path.join(root, sourceName), 'source', 'utf8');
  const service = createService(root);

  for (const target of ['con.txt', 'lpt9.log']) {
    await assert.rejects(
      service.rename({ from: sourceName, to: target }),
      (error) => assertPathInvalid(error, `"${target}" is a reserved name in Windows.`)
    );
  }
  for (const target of ['evil.', 'evil ']) {
    await assert.rejects(
      service.rename({ from: sourceName, to: target }),
      (error) => assertPathInvalid(error, 'A name can\'t end with a space or a period.')
    );
  }
  assert.equal(fs.readFileSync(path.join(root, sourceName), 'utf8'), 'source');
});

test('rename validates only the destination leaf', async () => {
  const root = createTrackedTempDir('jenny-ide-name-');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'source.txt'), 'source', 'utf8');
  const service = createService(root);

  const result = await service.rename({ from: 'source.txt', to: 'sub/newname.txt' });
  assert.deepEqual(result, { from: 'source.txt', to: 'sub/newname.txt', kind: 'file' });
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'newname.txt'), 'utf8'), 'source');
});

// NOTE: trailing-space/dot names are NOT usable through this service on any
// platform — the lenient normalizer has always trimmed the string's ends, so
// `trailing. ` was unaddressable before this wave too. The operability
// guarantee covers untrimmed lenient names like `what?.txt` / `a:b` only.
test('POSIX-existing lenient names remain readable, listable, movable, and deletable', {
  skip: process.platform === 'win32' ? 'Windows cannot create the lenient-only fixture name' : false,
}, async () => {
  const root = createTrackedTempDir('jenny-ide-name-');
  const lenientName = 'what?.txt';
  fs.writeFileSync(path.join(root, lenientName), 'legacy', 'utf8');
  const service = createService(root, {
    trashItemImpl: (target) => fsPromises.rm(target),
  });

  const stats = await service.stat({ path: lenientName });
  assert.equal(stats.exists, true);
  assert.equal((await service.readFile({ path: lenientName })).content, 'legacy');
  assert.ok((await service.listDirectory()).entries.some((entry) => entry.name === lenientName));

  const moved = await service.rename({ from: lenientName, to: 'clean.txt' });
  assert.equal(moved.from, lenientName);
  assert.equal(fs.readFileSync(path.join(root, 'clean.txt'), 'utf8'), 'legacy');

  fs.writeFileSync(path.join(root, lenientName), 'delete me', 'utf8');
  const deleted = await service.delete({ path: lenientName });
  assert.equal(deleted.trashed, true);
  assert.equal(fs.existsSync(path.join(root, lenientName)), false);
});

test('relocation keeps a lenient legacy leaf movable while renames stay strict', () => {
  const { normalizeWorkspaceRelPath } = require('../services/workspace-ide-path-guard');
  // Moving without renaming is not a naming act: same leaf passes strict mode.
  assert.equal(
    normalizeWorkspaceRelPath('sub/what?.txt', { strictName: true, relocationFrom: 'what?.txt' }),
    'sub/what?.txt'
  );
  assert.equal(
    normalizeWorkspaceRelPath('sub/trailing. ', { strictName: true, relocationFrom: 'dir/trailing. ' }),
    'sub/trailing.'
  );
  // A CHANGED leaf is a naming act and stays strict.
  assert.throws(
    () => normalizeWorkspaceRelPath('sub/what2?.txt', { strictName: true, relocationFrom: 'what?.txt' }),
    (error) => assertPathInvalid(error)
  );
  assert.throws(
    () => normalizeWorkspaceRelPath('foo:bar', { strictName: true, relocationFrom: 'clean.txt' }),
    (error) => assertPathInvalid(error)
  );
});

test('writeFile validates strictly only when creating a new file', async () => {
  const root = createTrackedTempDir('jenny-ide-name-');
  const service = createService(root);

  await assert.rejects(
    service.writeFile({ path: 'foo:bar', content: 'ads' }),
    (error) => assertPathInvalid(error)
  );
  // Strict create validates the CALLER'S name: a trailing space is rejected,
  // never silently trimmed into a different name (matches createFile).
  await assert.rejects(
    service.writeFile({ path: 'draft ', content: 'x' }),
    (error) => assertPathInvalid(error)
  );
  assert.deepEqual(fs.readdirSync(root), []);

  // Saving over an existing file stays lenient (legacy names remain savable).
  fs.writeFileSync(path.join(root, 'plain.txt'), 'v1', 'utf8');
  await service.writeFile({ path: 'plain.txt', content: 'v2' });
  assert.equal(fs.readFileSync(path.join(root, 'plain.txt'), 'utf8'), 'v2');
});
