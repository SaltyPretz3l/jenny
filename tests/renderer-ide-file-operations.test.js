'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeFileOperations } = require('../renderer/features/renderer-ide-file-operations');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function readResult(path, fileVersion = 'vf2_open') {
  return {
    ok: true,
    path,
    pathKey: path.toLowerCase(),
    requestedPath: path,
    requestedPathKey: path.toLowerCase(),
    content: `content:${path}`,
    size: path.length,
    mtimeMs: 10,
    eol: 'lf',
    rootId: 'root-a',
    generation: 4,
    fileVersion,
    encoding: 'utf-8',
    editable: true,
    truncated: false,
  };
}

function imageResult(path, fileVersion = 'vf2_image') {
  return {
    ok: true,
    path,
    pathKey: path.toLowerCase(),
    requestedPath: path,
    requestedPathKey: path.toLowerCase(),
    size: 8,
    mtimeMs: 10,
    rootId: 'root-a',
    generation: 4,
    fileVersion,
    kind: 'image',
    representation: 'base64',
    mime: 'image/png',
    base64: 'iVBORw0KGgo=',
    editable: false,
    truncated: false,
  };
}

async function openDocument(operations, path = 'src/File.js') {
  const intent = operations.beginOpen(path);
  const read = await operations.readForOpen(intent);
  assert.equal(read.stale, false);
  assert.ok(operations.commitOpen(intent, read.payload));
  return read.payload;
}

test('latest open intent wins and Windows casing aliases share one canonical document', async () => {
  const firstCalled = deferred();
  const firstResult = deferred();
  const calls = [];
  const api = {
    async readText(payload) {
      calls.push(payload);
      if (calls.length === 1) {
        firstCalled.resolve();
        return firstResult.promise;
      }
      return readResult('src/File.js');
    },
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  const firstIntent = operations.beginOpen('SRC/FILE.JS');
  const first = operations.readForOpen(firstIntent);
  await firstCalled.promise;
  const secondIntent = operations.beginOpen('src/file.js');
  const second = operations.readForOpen(secondIntent);
  firstResult.resolve(readResult('src/File.js'));

  assert.deepEqual(await first, { stale: true, payload: null });
  const winningRead = await second;
  assert.equal(winningRead.stale, false);
  const token = operations.commitOpen(secondIntent, winningRead.payload);
  assert.equal(token.path, 'src/File.js');
  assert.equal(token.pathKey, 'src/file.js');
  assert.equal(operations.resolvePath('SRC/file.JS'), 'src/File.js');
  assert.equal(calls.length, 2);
});

test('a mid-save edit stays dirty while the landed file version advances', async () => {
  const writeCalled = deferred();
  const writeResult = deferred();
  const writes = [];
  const api = {
    readText: async ({ path }) => readResult(path),
    async writeText(payload) {
      writes.push(payload);
      writeCalled.resolve();
      return writeResult.promise;
    },
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  await openDocument(operations);
  operations.noteEdit('SRC/file.js');
  operations.noteDirty('SRC/file.js', true);
  const snapshot = operations.captureSave('src/File.js', { content: 'first edit', savedVersionId: 7 });
  const pending = operations.write(snapshot);
  await writeCalled.promise;
  operations.noteEdit('src/file.js');
  operations.noteDirty('src/file.js', true);
  writeResult.resolve({
    ok: true, path: 'src/File.js', pathKey: 'src/file.js', size: 10, mtimeMs: 20,
    rootId: 'root-a', generation: 4, fileVersion: 'vf2_saved',
  });

  const result = await pending;
  assert.deepEqual(operations.acceptWrite(snapshot, result), { current: true, exactEdit: false });
  const token = operations.getDocumentToken('SRC/FILE.JS');
  assert.equal(token.fileVersion, 'vf2_saved');
  assert.equal(token.editVersion, 2);
  assert.equal(token.dirty, true);
  assert.equal(writes[0].expectedGeneration, 4);
  assert.equal(writes[0].expectedFileVersion, 'vf2_open');
  assert.equal(operations.captureSave('src/file.js', { content: 'second edit' }).fileVersion, 'vf2_saved');
});

test('closing a document during an async save prevents late renderer mutation', async () => {
  const writeCalled = deferred();
  const writeResult = deferred();
  const api = {
    readText: async ({ path }) => readResult(path),
    writeText: async () => { writeCalled.resolve(); return writeResult.promise; },
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  await openDocument(operations);
  operations.noteEdit('src/File.js');
  const snapshot = operations.captureSave('src/File.js', { content: 'saved' });
  const pending = operations.write(snapshot);
  await writeCalled.promise;
  operations.close('SRC/FILE.JS');
  writeResult.resolve({
    ok: true, path: 'src/File.js', pathKey: 'src/file.js', size: 5, mtimeMs: 20,
    rootId: 'root-a', generation: 4, fileVersion: 'vf2_saved',
  });
  const result = await pending;
  assert.deepEqual(operations.acceptWrite(snapshot, result), { current: false, exactEdit: false });
  assert.equal(operations.getDocumentToken('src/File.js'), null);
});

test('a clean watcher reload turns stale when an edit lands during its read', async () => {
  const reloadCalled = deferred();
  const reloadResult = deferred();
  let reads = 0;
  const api = {
    async readText({ path }) {
      reads += 1;
      if (reads === 1) return readResult(path);
      reloadCalled.resolve();
      return reloadResult.promise;
    },
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  await openDocument(operations);
  const snapshot = operations.captureReload('src/File.js');
  const pending = operations.readForReload(snapshot);
  await reloadCalled.promise;
  operations.noteEdit('src/File.js');
  reloadResult.resolve(readResult('src/File.js', 'vf2_external'));

  assert.deepEqual(await pending, { stale: true, payload: null });
  assert.equal(operations.getDocumentToken('src/File.js').fileVersion, 'vf2_open');
});

test('a confirmed git discard may reload the exact dirty revision and mark it clean', async () => {
  let reads = 0;
  const api = {
    readText: async ({ path }) => readResult(path, reads++ === 0 ? 'vf2_open' : 'vf2_restored'),
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  await openDocument(operations);
  operations.noteEdit('src/File.js');
  operations.noteDirty('src/File.js', true);
  assert.equal(operations.captureReload('src/File.js'), null, 'watcher reload still refuses dirty buffers');

  const options = { allowDirty: true };
  const snapshot = operations.captureReload('src/File.js', options);
  const read = await operations.readForReload(snapshot, options);
  assert.equal(read.stale, false);
  assert.equal(operations.canCommitReload(snapshot, read.payload, options), true);
  assert.equal(operations.commitReload(snapshot, read.payload, options), true);
  assert.equal(operations.getDocumentToken('src/File.js').dirty, false);
  assert.equal(operations.getDocumentToken('src/File.js').fileVersion, 'vf2_restored');
});

test('a new edit during confirmed-discard reload is never overwritten', async () => {
  const reloadCalled = deferred();
  const reloadResult = deferred();
  let reads = 0;
  const api = {
    async readText({ path }) {
      if (reads++ === 0) return readResult(path);
      reloadCalled.resolve();
      return reloadResult.promise;
    },
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  await openDocument(operations);
  operations.noteEdit('src/File.js');
  operations.noteDirty('src/File.js', true);
  const options = { allowDirty: true };
  const snapshot = operations.captureReload('src/File.js', options);
  const pending = operations.readForReload(snapshot, options);
  await reloadCalled.promise;
  operations.noteEdit('src/File.js');
  reloadResult.resolve(readResult('src/File.js', 'vf2_restored'));

  assert.deepEqual(await pending, { stale: true, payload: null });
  assert.equal(operations.getDocumentToken('src/File.js').dirty, true);
  assert.equal(operations.getDocumentToken('src/File.js').fileVersion, 'vf2_open');
});

test('a completed save invalidates an older confirmed-discard reload snapshot', async () => {
  const api = { readText: async ({ path }) => readResult(path) };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  await openDocument(operations);
  operations.noteEdit('src/File.js');
  operations.noteDirty('src/File.js', true);
  const options = { allowDirty: true };
  const reloadSnapshot = operations.captureReload('src/File.js', options);
  const saveSnapshot = operations.captureSave('src/File.js', { content: 'saved while discard waited' });
  operations.acceptWrite(saveSnapshot, { fileVersion: 'vf2_saved' });

  assert.deepEqual(await operations.readForReload(reloadSnapshot, options), { stale: true, payload: null });
  assert.equal(operations.getDocumentToken('src/File.js').fileVersion, 'vf2_saved');
});

test('dirty ownership follows editor notifications when an edit returns to saved content', async () => {
  const api = { readText: async ({ path }) => readResult(path) };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  await openDocument(operations);

  operations.noteDirty('src/File.js', true);
  operations.noteEdit('src/File.js');
  operations.noteDirty('src/File.js', false);
  operations.noteEdit('src/File.js');

  const token = operations.getDocumentToken('src/File.js');
  assert.equal(token.editVersion, 2);
  assert.equal(token.dirty, false);
  assert.ok(operations.captureReload('src/File.js'));
});

test('root reset detaches new operations from an unresolved old-root queue', async () => {
  const firstCalled = deferred();
  const firstResult = deferred();
  let calls = 0;
  const api = {
    async readText({ path }) {
      calls += 1;
      if (calls === 1) {
        firstCalled.resolve();
        return firstResult.promise;
      }
      return { ...readResult(path), rootId: 'root-b', generation: 5 };
    },
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  const oldIntent = operations.beginOpen('old.js');
  const oldRead = operations.readForOpen(oldIntent);
  await firstCalled.promise;

  operations.reset({ rootId: 'root-b', generation: 5 });
  const newIntent = operations.beginOpen('new.js');
  const newRead = await operations.readForOpen(newIntent);

  assert.equal(newRead.stale, false);
  assert.equal(calls, 2, 'new-root read starts without resolving the old-root read');
  firstResult.resolve(readResult('old.js'));
  await assert.rejects(oldRead, (error) => error.code === 'workspace_file_operation_stale');
});

test('an in-root canonical alias response requires the requested path identity', async () => {
  const api = {
    readText: async () => ({
      ...readResult('real/file.js'),
      requestedPath: 'alias/file.js',
      requestedPathKey: 'alias/file.js',
    }),
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  const intent = operations.beginOpen('ALIAS/FILE.JS');
  const read = await operations.readForOpen(intent);

  assert.equal(read.stale, false);
  const token = operations.commitOpen(intent, read.payload);
  assert.equal(token.path, 'real/file.js');
  assert.equal(token.pathKey, 'real/file.js');
});

test('image opens and watcher reloads share versioned document tokens and the central queue', async () => {
  const reloadStarted = deferred();
  const reloadResult = deferred();
  let reads = 0;
  const api = {
    async readImage({ path }) {
      reads += 1;
      if (reads === 1) return imageResult(path);
      reloadStarted.resolve();
      return reloadResult.promise;
    },
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  const intent = operations.beginOpen('ASSETS/LOGO.PNG');
  const opened = await operations.readImageForOpen(intent);
  const token = operations.commitImageOpen(intent, opened.payload);
  assert.equal(token.path, 'ASSETS/LOGO.PNG');
  assert.equal(token.documentKind, 'image');
  assert.equal(token.editable, false);

  const snapshot = operations.captureReload('assets/logo.png');
  const pending = operations.readImageForReload(snapshot);
  await reloadStarted.promise;
  operations.reset({ rootId: 'root-b', generation: 5 });
  reloadResult.resolve(imageResult('ASSETS/LOGO.PNG', 'vf2_external'));

  await assert.rejects(pending, (error) => error.code === 'workspace_file_operation_stale');
  assert.equal(operations.getDocumentToken('assets/logo.png'), null);
});

test('preview reads are bounded/versioned and watcher invalidation prevents a late stale paint', async () => {
  const readStarted = deferred();
  const readResultDeferred = deferred();
  const calls = [];
  const api = {
    async readText(payload) {
      calls.push(payload);
      readStarted.resolve();
      return readResultDeferred.promise;
    },
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  const intent = operations.beginPreview('DOCS/README.MD');
  const pending = operations.readForPreview(intent, { maxBytes: 1_500_000 });
  await readStarted.promise;
  operations.noteExternalChange('docs/readme.md');
  readResultDeferred.resolve({
    ...readResult('docs/readme.md', 'vf2_old'),
    requestedPath: 'DOCS/README.MD',
    requestedPathKey: 'docs/readme.md',
  });

  assert.deepEqual(await pending, { stale: true, payload: null });
  assert.deepEqual(calls, [{ path: 'DOCS/README.MD', intent: 'preview', maxBytes: 1_500_000 }]);
  assert.match(operations.getPreviewRequestSignature('docs/readme.md'), /docs\/readme\.md/);
});

test('an unrelated watcher change does not invalidate an in-flight preview read', async () => {
  const readStarted = deferred();
  const readResultDeferred = deferred();
  const api = {
    async readText() {
      readStarted.resolve();
      return readResultDeferred.promise;
    },
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  const intent = operations.beginPreview('docs/readme.md');
  const pending = operations.readForPreview(intent);
  await readStarted.promise;
  operations.noteExternalChange('src/app.js');
  readResultDeferred.resolve(readResult('docs/readme.md', 'vf2_current'));

  const result = await pending;
  assert.equal(result.stale, false);
  assert.equal(result.payload.fileVersion, 'vf2_current');
});

test('preview revision signatures evict old path keys without falling back to zero', () => {
  const operations = createIdeFileOperations({ platform: 'win32' });
  operations.noteExternalChange('generated/oldest.js');
  const initialRevision = Number(operations.getPreviewRequestSignature('generated/oldest.js').split(':').at(-1));

  for (let index = 0; index < 2_000; index += 1) {
    operations.noteExternalChange(`generated/file-${index}.js`);
  }

  const fallbackRevision = Number(operations.getPreviewRequestSignature('generated/oldest.js').split(':').at(-1));
  assert.ok(fallbackRevision > initialRevision);
});

test('malformed or arbitrary-binary image responses fail closed before document creation', async () => {
  const api = {
    readImage: async () => ({
      ...imageResult('payload.bin'),
      mime: 'application/octet-stream',
    }),
  };
  const operations = createIdeFileOperations({ getWorkspaceFsApi: () => api, platform: 'win32' });
  const intent = operations.beginOpen('payload.bin');

  await assert.rejects(
    operations.readImageForOpen(intent),
    (error) => error.code === 'workspace_file_result_invalid'
  );
  assert.equal(operations.getDocumentToken('payload.bin'), null);
});
