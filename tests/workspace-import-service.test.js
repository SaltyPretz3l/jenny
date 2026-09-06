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
const {
  COPY_ERROR_CODES,
  WorkspaceImportService,
} = require('../services/workspace-import-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function createCoordinator(rootPath) {
  return new WorkspaceRootCoordinator({
    initialRootPath: rootPath,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => value ? `root:${String(value).toLowerCase()}` : null,
  });
}

function createService(rootPath, extra = {}) {
  const coordinator = extra.coordinator || createCoordinator(rootPath);
  return new WorkspaceImportService({
    rootContextProvider: () => coordinator,
    isQolEnabled: () => true,
    ...extra,
  });
}

async function tempResidue(rootPath) {
  const residue = [];
  async function visit(directory) {
    for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.name.includes('.tmp-')) residue.push(target);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(target);
    }
  }
  await visit(rootPath);
  return residue;
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('copies a file atomically and preserves its bytes', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.writeFileSync(path.join(root, 'source.bin'), Buffer.from([0, 1, 2, 255]));

  const result = await createService(root).copyEntry({
    from: 'source.bin',
    to: 'copies/landed.bin',
    onCollision: 'fail',
  });

  assert.deepEqual(result, {
    from: 'source.bin',
    to: 'copies/landed.bin',
    kind: 'file',
    renamed: false,
    skipped: [],
  });
  assert.deepEqual(
    fs.readFileSync(path.join(root, 'copies', 'landed.bin')),
    Buffer.from([0, 1, 2, 255])
  );
  assert.deepEqual(await tempResidue(root), []);
});

test('copies a 240-character filename without leaving temp residue', async () => {
  const root = createTrackedTempDir('jenny-import-');
  const longName = `${'a'.repeat(236)}.txt`;
  fs.writeFileSync(path.join(root, longName), 'long-name', 'utf8');

  const result = await createService(root).copyEntry({
    from: longName,
    to: `copies/${longName}`,
    onCollision: 'fail',
  });

  assert.equal(result.to, `copies/${longName}`);
  assert.equal(fs.readFileSync(path.join(root, 'copies', longName), 'utf8'), 'long-name');
  assert.deepEqual(await tempResidue(root), []);
});

test('an atomic landing collision preserves the concurrent file and auto-renames the copy', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.writeFileSync(path.join(root, 'source.txt'), 'copied bytes', 'utf8');
  let injected = false;
  const instrumentedFs = {
    ...fsPromises,
    async link(tempPath, targetPath) {
      if (!injected && path.basename(targetPath) === 'target.txt') {
        injected = true;
        await fsPromises.writeFile(targetPath, 'concurrent bytes', 'utf8');
      }
      return fsPromises.link(tempPath, targetPath);
    },
  };

  const result = await createService(root, { fs: instrumentedFs }).copyEntry({
    from: 'source.txt', to: 'target.txt', onCollision: 'auto-rename',
  });

  assert.equal(result.to, 'target (2).txt');
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'concurrent bytes');
  assert.equal(fs.readFileSync(path.join(root, 'target (2).txt'), 'utf8'), 'copied bytes');
  assert.deepEqual(await tempResidue(root), []);
});

test('copies directories depth-first and creates destination segments individually', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.mkdirSync(path.join(root, 'source', 'nested', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'source', 'root.txt'), 'root', 'utf8');
  fs.writeFileSync(path.join(root, 'source', 'nested', 'deep', 'leaf.txt'), 'leaf', 'utf8');
  const mkdirCalls = [];
  const instrumentedFs = {
    ...fsPromises,
    async mkdir(target, options) {
      mkdirCalls.push({ target, options });
      return fsPromises.mkdir(target, options);
    },
  };

  const result = await createService(root, { fs: instrumentedFs }).copyEntry({
    from: 'source',
    to: 'copies/clone',
  });

  assert.equal(result.kind, 'directory');
  assert.equal(fs.readFileSync(path.join(root, 'copies', 'clone', 'root.txt'), 'utf8'), 'root');
  assert.equal(
    fs.readFileSync(path.join(root, 'copies', 'clone', 'nested', 'deep', 'leaf.txt'), 'utf8'),
    'leaf'
  );
  assert.ok(mkdirCalls.some(({ target }) => target === path.join(root, 'copies')));
  assert.ok(mkdirCalls.some(({ target }) => target === path.join(root, 'copies', 'clone', 'nested')));
  assert.ok(mkdirCalls.every(({ options }) => options === undefined));
});

test('auto-renames files, dotfiles, and directories with Windows-style numbering', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.writeFileSync(path.join(root, 'source-report.xlsx'), 'new report', 'utf8');
  fs.writeFileSync(path.join(root, 'report.xlsx'), 'old report', 'utf8');
  fs.writeFileSync(path.join(root, 'source-env'), 'new env', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'old env', 'utf8');
  fs.mkdirSync(path.join(root, 'source-data'));
  fs.writeFileSync(path.join(root, 'source-data', 'row.txt'), 'row', 'utf8');
  fs.mkdirSync(path.join(root, 'data'));
  const service = createService(root);

  const second = await service.copyEntry({
    from: 'source-report.xlsx', to: 'report.xlsx', onCollision: 'auto-rename',
  });
  const third = await service.copyEntry({
    from: 'source-report.xlsx', to: 'report.xlsx', onCollision: 'auto-rename',
  });
  const dotfile = await service.copyEntry({
    from: 'source-env', to: '.env', onCollision: 'auto-rename',
  });
  const directory = await service.copyEntry({
    from: 'source-data', to: 'data', onCollision: 'auto-rename',
  });

  assert.equal(second.to, 'report (2).xlsx');
  assert.equal(third.to, 'report (3).xlsx');
  assert.equal(dotfile.to, '.env (2)');
  assert.equal(directory.to, 'data (2)');
  assert.equal(second.renamed && third.renamed && dotfile.renamed && directory.renamed, true);
  assert.equal(fs.readFileSync(path.join(root, 'report (3).xlsx'), 'utf8'), 'new report');
  assert.equal(fs.readFileSync(path.join(root, '.env (2)'), 'utf8'), 'new env');
  assert.equal(fs.readFileSync(path.join(root, 'data (2)', 'row.txt'), 'utf8'), 'row');
});

test('supports duplicate-to-self through auto-rename', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'duplicate me', 'utf8');

  const result = await createService(root).copyEntry({
    from: 'a.txt', to: 'a.txt', onCollision: 'auto-rename',
  });

  assert.equal(result.to, 'a (2).txt');
  assert.equal(result.renamed, true);
  assert.equal(fs.readFileSync(path.join(root, 'a (2).txt'), 'utf8'), 'duplicate me');
});

test('fail collision returns the IDE EXISTS shape without changing either file', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.writeFileSync(path.join(root, 'source.txt'), 'source', 'utf8');
  fs.writeFileSync(path.join(root, 'target.txt'), 'target', 'utf8');

  await assert.rejects(
    createService(root).copyEntry({ from: 'source.txt', to: 'target.txt' }),
    (error) => {
      assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.EXISTS);
      assert.equal(error.message, 'A file or folder with that name already exists.');
      assert.equal(error.details.file_name, 'target.txt');
      return true;
    }
  );
  assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'source');
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'target');
});

test('Windows trailing-dot aliases cannot bypass collision refusal', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only filename aliasing');
    return;
  }
  const root = createTrackedTempDir('jenny-import-');
  fs.writeFileSync(path.join(root, 'source.txt'), 'source', 'utf8');
  fs.writeFileSync(path.join(root, 'target'), 'original', 'utf8');

  await assert.rejects(
    createService(root).copyEntry({ from: 'source.txt', to: 'target.' }),
    // Strict destination names now refuse the trailing-dot alias before the
    // collision probe ever runs — the alias still cannot clobber the target.
    (error) => error.code === WORKSPACE_FS_ERROR_CODES.PATH_INVALID
  );
  assert.equal(fs.readFileSync(path.join(root, 'target'), 'utf8'), 'original');
});

test('skips nested symlinks and refuses a direct symlink source', async (t) => {
  const root = createTrackedTempDir('jenny-import-');
  fs.mkdirSync(path.join(root, 'source'));
  fs.writeFileSync(path.join(root, 'source', 'kept.txt'), 'kept', 'utf8');
  fs.mkdirSync(path.join(root, 'link-target'));
  fs.writeFileSync(path.join(root, 'link-target', 'linked.txt'), 'linked', 'utf8');
  try {
    const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(path.join(root, 'link-target'), path.join(root, 'source', 'nested-link'), linkKind);
    fs.symlinkSync(path.join(root, 'link-target'), path.join(root, 'direct-link'), linkKind);
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.code || error.message}`);
    return;
  }
  const service = createService(root);

  const result = await service.copyEntry({ from: 'source', to: 'clone' });
  assert.deepEqual(result.skipped, [{ path: 'source/nested-link', code: 'symlink_skipped' }]);
  assert.equal(fs.readFileSync(path.join(root, 'clone', 'kept.txt'), 'utf8'), 'kept');
  assert.equal(fs.existsSync(path.join(root, 'clone', 'nested-link')), false);
  await assert.rejects(
    service.copyEntry({ from: 'direct-link', to: 'copied-link' }),
    (error) => error.code === COPY_ERROR_CODES.SYMLINK_UNSUPPORTED
  );
});

test('rejects escape destinations before creating anything outside the root', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.writeFileSync(path.join(root, 'source.txt'), 'source', 'utf8');
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  const service = createService(root);

  for (const destination of ['../escape.txt', outside, 'C:\\escape.txt']) {
    await assert.rejects(
      service.copyEntry({ from: 'source.txt', to: destination }),
      (error) => error.code === WORKSPACE_FS_ERROR_CODES.PATH_INVALID
    );
  }
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(await tempResidue(root), []);
});

test('rejects a stale generation before moving any bytes', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.writeFileSync(path.join(root, 'source.txt'), 'source', 'utf8');

  await assert.rejects(
    createService(root).copyEntry({
      from: 'source.txt', to: 'target.txt', expectedGeneration: 99,
    }),
    (error) => error.code === WORKSPACE_FS_ERROR_CODES.STALE_GENERATION
  );
  assert.equal(fs.existsSync(path.join(root, 'target.txt')), false);
});

test('isolates a failed directory child and removes its partial temp file', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.mkdirSync(path.join(root, 'source'));
  fs.writeFileSync(path.join(root, 'source', 'bad.txt'), 'bad', 'utf8');
  fs.writeFileSync(path.join(root, 'source', 'good.txt'), 'good', 'utf8');
  const instrumentedFs = {
    ...fsPromises,
    async copyFile(source, target, flags) {
      if (path.basename(source) === 'bad.txt') {
        await fsPromises.copyFile(source, target, flags);
        const error = new Error('injected copy failure');
        error.code = 'EIO';
        throw error;
      }
      return fsPromises.copyFile(source, target, flags);
    },
  };

  const result = await createService(root, { fs: instrumentedFs }).copyEntry({
    from: 'source', to: 'clone',
  });

  assert.deepEqual(result.skipped, [{ path: 'source/bad.txt', code: 'EIO' }]);
  assert.equal(fs.existsSync(path.join(root, 'clone', 'bad.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'clone', 'good.txt'), 'utf8'), 'good');
  assert.deepEqual(await tempResidue(root), []);
});

test('feature flag refusal is typed and writes nothing', async () => {
  const root = createTrackedTempDir('jenny-import-');
  fs.writeFileSync(path.join(root, 'source.txt'), 'source', 'utf8');
  const service = createService(root, { isQolEnabled: () => false });

  await assert.rejects(
    service.copyEntry({ from: 'source.txt', to: 'target.txt' }),
    (error) => error.code === COPY_ERROR_CODES.FEATURE_DISABLED
  );
  assert.equal(fs.existsSync(path.join(root, 'target.txt')), false);
});
