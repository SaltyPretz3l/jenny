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
  IMPORT_ERROR_CODES,
  WorkspaceImportService,
} = require('../services/workspace-import-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');
const { getBridgeChannel } = require('../services/ipc-contract');
const { registerWorkspaceFsIpcHandlers } = require('../services/main/workspace-ipc-registration');

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
    isImportEnabled: () => true,
    ...extra,
  });
}

function makeRoots() {
  return {
    workspace: createTrackedTempDir('jenny-external-workspace-'),
    outside: createTrackedTempDir('jenny-external-source-'),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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

function importPayload(importId, source, extra = {}) {
  return {
    importId,
    sources: [source],
    destination: '',
    onCollision: 'auto-rename',
    ...extra,
  };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('feature flag refusal is typed for preview, import, and cancel and writes nothing', async () => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'source.txt');
  fs.writeFileSync(source, 'source');
  const service = createService(workspace, { isImportEnabled: () => false });

  for (const operation of [
    () => service.previewImport({ sources: [source] }),
    () => service.importExternal(importPayload('disabled', source)),
    () => service.cancelImport({ importId: 'disabled' }),
  ]) {
    await assert.rejects(operation, (error) => error.code === IMPORT_ERROR_CODES.FEATURE_DISABLED);
  }
  assert.deepEqual(fs.readdirSync(workspace), []);
});

test('preview reports nested totals, basenames, truncation, and the injected huge-tree cap', async () => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'drop');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'one.txt'), 'abc');
  fs.writeFileSync(path.join(source, 'nested', 'two.txt'), '12345');
  const service = createService(workspace, { limits: { largeTreeFiles: 1 } });

  const result = await service.previewImport({ sources: [source] });
  assert.deepEqual(result.totals, {
    files: 2,
    directories: 2,
    bytes: 8,
    truncated: false,
    truncationReason: null,
  });
  assert.deepEqual(result.sources, [{ name: 'drop', kind: 'directory', bytes: 8, files: 2 }]);
  assert.ok(result.warnings.some((warning) => warning.code === 'huge_tree'));
  assert.ok(result.warnings.every((warning) => !warning.name.includes(path.sep)));

  const bounded = await service.previewImport({ sources: [source], maxEntries: 1 });
  assert.equal(bounded.totals.truncated, true);
  assert.equal(bounded.totals.truncationReason, 'entries');
});

test('preview warns only for top-level sensitive sources and generated directory names', async () => {
  const { workspace, outside } = makeRoots();
  const sensitive = path.join(outside, '.env');
  const generated = path.join(outside, 'node_modules');
  const ordinary = path.join(outside, 'ordinary');
  fs.writeFileSync(sensitive, 'TOKEN=redacted');
  fs.mkdirSync(generated);
  fs.mkdirSync(ordinary);
  fs.writeFileSync(path.join(ordinary, '.env'), 'nested=true');

  const result = await createService(workspace).previewImport({
    sources: [sensitive, generated, ordinary],
  });
  assert.deepEqual(
    result.warnings.filter((warning) => warning.code === 'sensitive_source'),
    [{ code: 'sensitive_source', name: '.env' }]
  );
  assert.ok(result.warnings.some(
    (warning) => warning.code === 'generated_dir' && warning.name === 'node_modules'
  ));
});

test('imports a mixed tree with auto-rename, nested symlink isolation, and no temp residue', async (t) => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'bundle');
  const nested = path.join(source, 'nested');
  const linkTarget = path.join(outside, 'link-target');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(linkTarget);
  fs.writeFileSync(path.join(source, 'root.txt'), 'root');
  fs.writeFileSync(path.join(nested, 'child.txt'), 'child');
  const linkPath = path.join(nested, 'linked');
  try {
    fs.symlinkSync(linkTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('symlink creation is unavailable on this host');
    throw error;
  }
  fs.mkdirSync(path.join(workspace, 'dest', 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'dest', 'bundle', 'existing.txt'), 'keep');

  const result = await createService(workspace).importExternal(importPayload('mixed', source, {
    destination: 'dest',
  }));
  assert.deepEqual(result.imported, [{
    source,
    path: 'dest/bundle (2)',
    kind: 'directory',
    renamedFrom: 'bundle',
  }]);
  assert.equal(fs.readFileSync(path.join(workspace, 'dest', 'bundle (2)', 'root.txt'), 'utf8'), 'root');
  assert.equal(
    fs.readFileSync(path.join(workspace, 'dest', 'bundle (2)', 'nested', 'child.txt'), 'utf8'),
    'child'
  );
  assert.ok(result.skipped.some(
    (entry) => entry.source === linkPath && entry.code === 'symlink_skipped'
  ));
  assert.deepEqual(await tempResidue(workspace), []);
});

test('a directory swapped to a junction between scan and copy is skipped while siblings land', async (t) => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'bundle');
  const changing = path.join(source, 'changing');
  const moved = path.join(outside, 'changing-original');
  const junctionTarget = path.join(outside, 'junction-target');
  const probe = path.join(outside, 'junction-probe');
  fs.mkdirSync(changing, { recursive: true });
  fs.mkdirSync(junctionTarget);
  fs.writeFileSync(path.join(changing, 'original.txt'), 'original');
  fs.writeFileSync(path.join(junctionTarget, 'escaped.txt'), 'escaped');
  fs.writeFileSync(path.join(source, 'sibling.txt'), 'sibling');
  try {
    fs.symlinkSync(junctionTarget, probe, process.platform === 'win32' ? 'junction' : 'dir');
    fs.rmSync(probe);
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('junction creation is unavailable on this host');
    throw error;
  }
  let changingReads = 0;
  const injectedFs = new Proxy(fsPromises, {
    get(target, property) {
      if (property !== 'readdir') return Reflect.get(target, property);
      return async (directory, ...args) => {
        if (path.resolve(directory) === path.resolve(changing) && ++changingReads === 2) {
          await fsPromises.rename(changing, moved);
          await fsPromises.symlink(
            junctionTarget, changing, process.platform === 'win32' ? 'junction' : 'dir'
          );
        }
        return fsPromises.readdir(directory, ...args);
      };
    },
  });

  const result = await createService(workspace, { fs: injectedFs })
    .importExternal(importPayload('junction-swap', source));

  assert.ok(result.skipped.some(
    (entry) => entry.source === changing && entry.code === IMPORT_ERROR_CODES.SOURCE_CHANGED
  ));
  assert.equal(fs.readFileSync(path.join(workspace, 'bundle', 'sibling.txt'), 'utf8'), 'sibling');
  assert.equal(fs.existsSync(path.join(workspace, 'bundle', 'changing', 'escaped.txt')), false);
});

test('copy growth beyond the scan ceiling fails with source_changed and no temp residue', async () => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'growing');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'seed.txt'), 'seed');
  let sourceReads = 0;
  const injectedFs = new Proxy(fsPromises, {
    get(target, property) {
      if (property !== 'readdir') return Reflect.get(target, property);
      return async (directory, ...args) => {
        if (path.resolve(directory) === path.resolve(source) && ++sourceReads === 2) {
          await Promise.all(Array.from({ length: 257 }, (_unused, index) => (
            fsPromises.writeFile(path.join(source, `extra-${String(index).padStart(3, '0')}.txt`), 'x')
          )));
        }
        return fsPromises.readdir(directory, ...args);
      };
    },
  });
  const progress = [];
  const service = createService(workspace, {
    fs: injectedFs,
    sendProgress: (payload) => progress.push(payload),
  });

  await assert.rejects(
    service.importExternal(importPayload('growing-source', source)),
    (error) => error.code === IMPORT_ERROR_CODES.SOURCE_CHANGED
  );
  assert.equal(progress.at(-1).phase, 'failed');
  assert.equal(progress.at(-1).terminal, true);
  assert.deepEqual(await tempResidue(workspace), []);
});

test('refuses a source inside the workspace before copying anything', async () => {
  const { workspace } = makeRoots();
  const source = path.join(workspace, 'inside.txt');
  fs.writeFileSync(source, 'inside');

  await assert.rejects(
    createService(workspace).importExternal(importPayload('inside', source, { destination: 'dest' })),
    (error) => error.code === IMPORT_ERROR_CODES.INSIDE_WORKSPACE
  );
  assert.equal(fs.existsSync(path.join(workspace, 'dest')), false);
});

test('large tree requires allowLargeTree and proceeds when explicitly allowed', async () => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'large');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'a.txt'), 'a');
  fs.writeFileSync(path.join(source, 'b.txt'), 'b');
  const service = createService(workspace, { limits: { largeTreeFiles: 1 } });

  await assert.rejects(
    service.importExternal(importPayload('large-refused', source)),
    (error) => error.code === IMPORT_ERROR_CODES.IMPORT_TOO_LARGE
  );
  assert.deepEqual(fs.readdirSync(workspace), []);
  const allowed = await service.importExternal(importPayload('large-allowed', source, {
    allowLargeTree: true,
  }));
  assert.equal(allowed.ok, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'large', 'b.txt'), 'utf8'), 'b');
});

test('sensitive source requires allowSensitive and proceeds when explicitly allowed', async () => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, '.env');
  fs.writeFileSync(source, 'SECRET=redacted');
  const service = createService(workspace);

  await assert.rejects(
    service.importExternal(importPayload('sensitive-refused', source)),
    (error) => error.code === IMPORT_ERROR_CODES.SENSITIVE_SOURCE
  );
  assert.deepEqual(fs.readdirSync(workspace), []);
  const allowed = await service.importExternal(importPayload('sensitive-allowed', source, {
    allowSensitive: true,
  }));
  assert.equal(allowed.imported[0].path, '.env');
  assert.equal(fs.readFileSync(path.join(workspace, '.env'), 'utf8'), 'SECRET=redacted');
});

test('cancellation keeps landed files, removes the in-flight temp, and sends terminal cancelled progress', async () => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'cancelled');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'a.txt'), 'first');
  fs.writeFileSync(path.join(source, 'b.txt'), 'second');
  const secondStarted = deferred();
  const releaseSecond = deferred();
  let copies = 0;
  const injectedFs = new Proxy(fsPromises, {
    get(target, property) {
      if (property !== 'copyFile') return Reflect.get(target, property);
      return async (...args) => {
        copies += 1;
        if (copies === 2) {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
        return fsPromises.copyFile(...args);
      };
    },
  });
  const progress = [];
  const service = createService(workspace, {
    fs: injectedFs,
    sendProgress: (payload) => progress.push(payload),
  });

  const pending = service.importExternal(importPayload('cancel-mid-copy', source));
  await secondStarted.promise;
  assert.deepEqual(await service.cancelImport({ importId: 'cancel-mid-copy' }), {
    ok: true,
    cancelled: true,
  });
  releaseSecond.resolve();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'cancelled', 'a.txt'), 'utf8'), 'first');
  assert.equal(fs.existsSync(path.join(workspace, 'cancelled', 'b.txt')), false);
  assert.deepEqual(await tempResidue(workspace), []);
  assert.equal(progress.at(-1).phase, 'cancelled');
  assert.equal(progress.at(-1).terminal, true);
});

test('progress always terminates, uses snake_case keys, and exposes basenames only', async () => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'progress.txt');
  fs.writeFileSync(source, 'progress');
  const progress = [];

  await createService(workspace, {
    sendProgress: (payload) => progress.push(payload),
  }).importExternal(importPayload('progress', source));

  assert.ok(progress.length >= 3);
  assert.deepEqual(Object.keys(progress.at(-1)).sort(), [
    'completed_bytes', 'completed_files', 'current_name', 'import_id', 'percent',
    'phase', 'terminal', 'total_bytes', 'total_files',
  ]);
  assert.equal(progress.at(-1).phase, 'done');
  assert.equal(progress.at(-1).terminal, true);
  assert.ok(progress.every((entry) => !entry.current_name.includes(path.sep)));
});

test('skipped-entry logs expose only the external source basename', async () => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'missing.txt');
  const logs = [];

  const result = await createService(workspace, {
    logger: (level, event, details) => logs.push({ level, event, details }),
  }).importExternal(importPayload('missing-log', source));

  assert.equal(result.skipped[0].source, source);
  const warning = logs.find((entry) => entry.event === 'workspace_fs.import_entry_skipped');
  assert.equal(warning.details.file_name, 'missing.txt');
  assert.equal(JSON.stringify(warning.details).includes(outside), false);
});

test('duplicate active importId is refused and cancelling an unknown id is a no-op', async () => {
  const { workspace, outside } = makeRoots();
  const source = path.join(outside, 'duplicate.txt');
  fs.writeFileSync(source, 'duplicate');
  const copyStarted = deferred();
  const releaseCopy = deferred();
  const injectedFs = new Proxy(fsPromises, {
    get(target, property) {
      if (property !== 'copyFile') return Reflect.get(target, property);
      return async (...args) => {
        copyStarted.resolve();
        await releaseCopy.promise;
        return fsPromises.copyFile(...args);
      };
    },
  });
  const service = createService(workspace, { fs: injectedFs });
  const pending = service.importExternal(importPayload('duplicate', source));
  await copyStarted.promise;

  await assert.rejects(
    service.importExternal(importPayload('duplicate', source)),
    (error) => error.code === IMPORT_ERROR_CODES.IMPORT_IN_PROGRESS
  );
  assert.deepEqual(await service.cancelImport({ importId: 'unknown' }), {
    ok: true,
    cancelled: false,
  });
  await service.cancelImport({ importId: 'duplicate' });
  releaseCopy.resolve();
  assert.equal((await pending).cancelled, true);
});

test('main registration forwards all three import invokes to the import service', async () => {
  const handlers = new Map();
  const calls = [];
  const importService = {
    previewImport: async (payload) => { calls.push(['previewImport', payload]); return payload; },
    importExternal: async (payload) => { calls.push(['importExternal', payload]); return payload; },
    cancelImport: async (payload) => { calls.push(['cancelImport', payload]); return payload; },
    copyEntry: async () => null,
  };
  registerWorkspaceFsIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {}, { importService });
  for (const method of ['previewImport', 'importExternal', 'cancelImport']) {
    const payload = { probe: method };
    await handlers.get(getBridgeChannel(`workspaceFs.${method}`, 'invoke'))(null, payload);
  }
  assert.deepEqual(calls, [
    ['previewImport', { probe: 'previewImport' }],
    ['importExternal', { probe: 'importExternal' }],
    ['cancelImport', { probe: 'cancelImport' }],
  ]);
});

test('preview rejects relative source paths with the house PATH_INVALID code', async () => {
  const { workspace } = makeRoots();
  await assert.rejects(
    createService(workspace).previewImport({ sources: ['relative.txt'] }),
    (error) => error.code === WORKSPACE_FS_ERROR_CODES.PATH_INVALID
  );
});

test('external import rejects a drive-root-style source with the house PATH_INVALID code', async () => {
  const { workspace } = makeRoots();
  const rootSource = path.parse(workspace).root;
  assert.equal(path.basename(rootSource), '');

  await assert.rejects(
    createService(workspace).importExternal(importPayload('drive-root', rootSource)),
    (error) => error.code === WORKSPACE_FS_ERROR_CODES.PATH_INVALID
      && error.details.reason === 'source_name_empty'
  );
});
