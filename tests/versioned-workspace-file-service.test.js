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
  DEFAULT_MAX_IMAGE_BYTES,
  VersionedWorkspaceFileService,
  VERSIONED_WORKSPACE_FILE_ERROR_CODES,
} = require('../services/versioned-workspace-file-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/backend/error-codes');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRootCoordinator(rootPath, { rootId = 'root-a', generation = 7 } = {}) {
  let context = Object.freeze({ rootPath, rootId, generation, phase: 'ready' });
  let operationSequence = 0;

  const coordinator = {
    captureContext() {
      return context;
    },

    acquireOperation({ kind, cancellable = false } = {}) {
      const acquiredContext = context;
      if (acquiredContext.phase !== 'ready') {
        return {
          acquired: false,
          code: 'root_transitioning',
          context: acquiredContext,
        };
      }
      const controller = new AbortController();
      let released = false;
      operationSequence += 1;
      return {
        acquired: true,
        operationId: `op-${operationSequence}`,
        context: acquiredContext,
        signal: controller.signal,
        kind,
        cancellable,
        release() {
          if (released) return false;
          released = true;
          return true;
        },
        isCurrent() {
          return coordinator.isCurrent(acquiredContext);
        },
      };
    },

    isCurrent(candidate) {
      return Boolean(
        candidate
        && context.phase === 'ready'
        && candidate.rootId === context.rootId
        && candidate.generation === context.generation
      );
    },

    update(patch) {
      context = Object.freeze({ ...context, ...patch });
      return context;
    },
  };
  return coordinator;
}

function createService(root, options = {}) {
  const rootContext = options.rootContext || createRootCoordinator(root);
  return {
    rootContext,
    service: new VersionedWorkspaceFileService({
      rootContext,
      ...options,
    }),
  };
}

function tempNames(root) {
  return fs.readdirSync(root).filter((name) => name.includes('.jenny-vfs-'));
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('a root change during post-replace cleanup cannot mask a completed save', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const folder = path.join(root, 'nested');
  const target = path.join(folder, 'saved.txt');
  fs.mkdirSync(folder);
  fs.writeFileSync(target, 'before', 'utf8');
  const rootContext = createRootCoordinator(root);
  let changedDuringCleanup = false;
  const fsAdapter = {
    ...fsPromises,
    async open(filePath, flags, mode) {
      const handle = await fsPromises.open(filePath, flags, mode);
      if (path.resolve(filePath) !== path.resolve(folder) || flags !== 'r') return handle;
      return {
        stat: (...args) => handle.stat(...args),
        sync: (...args) => handle.sync(...args),
        async close() {
          await handle.close();
          if (!changedDuringCleanup && fs.readFileSync(target, 'utf8') === 'after') {
            changedDuringCleanup = true;
            rootContext.update({ generation: 8 });
          }
        },
      };
    },
  };
  const { service } = createService(root, { rootContext, fs: fsAdapter });
  const opened = await service.readText({ path: 'nested/saved.txt' });

  const saved = await service.writeText({
    path: 'nested/saved.txt',
    content: 'after',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  });

  assert.equal(changedDuringCleanup, true);
  assert.equal(saved.fileVersion.startsWith('vf2_'), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'after');
});

test('writeText reads file content only once and uses handle snapshots around replacement', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const target = path.join(root, 'bounded.txt');
  fs.writeFileSync(target, 'before', 'utf8');
  let readCalls = 0;
  const fsAdapter = {
    ...fsPromises,
    async open(filePath, flags, mode) {
      const handle = await fsPromises.open(filePath, flags, mode);
      if (path.resolve(filePath) !== path.resolve(target) || flags !== 'r') return handle;
      return {
        stat: (...args) => handle.stat(...args),
        close: (...args) => handle.close(...args),
        read: (...args) => { readCalls += 1; return handle.read(...args); },
      };
    },
  };
  const { service } = createService(root, { fs: fsAdapter });
  const opened = await service.readText({ path: 'bounded.txt' });
  readCalls = 0;

  await service.writeText({
    path: 'bounded.txt',
    content: 'after',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  });

  assert.equal(readCalls, 2, 'one bounded content read plus EOF; snapshot checks never consume bytes');
  assert.equal(fs.readFileSync(target, 'utf8'), 'after');
});

test('versioned workspace error codes are canonical WORKSPACEFS registry exports', () => {
  assert.equal(VERSIONED_WORKSPACE_FILE_ERROR_CODES.ROOT_TRANSITIONING, WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING);
  assert.equal(VERSIONED_WORKSPACE_FILE_ERROR_CODES.STALE_GENERATION, WORKSPACE_FS_ERROR_CODES.STALE_GENERATION);
  assert.equal(VERSIONED_WORKSPACE_FILE_ERROR_CODES.INVALID_UTF8, WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING);
  assert.equal(VERSIONED_WORKSPACE_FILE_ERROR_CODES.IMAGE_UNSUPPORTED, WORKSPACE_FS_ERROR_CODES.IMAGE_UNSUPPORTED);
  assert.equal(VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT, WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT);
  assert.equal(VERSIONED_WORKSPACE_FILE_ERROR_CODES.ATOMIC_WRITE_FAILED, WORKSPACE_FS_ERROR_CODES.ATOMIC_WRITE_FAILED);
  assert.equal(VERSIONED_WORKSPACE_FILE_ERROR_CODES.IO_FAILED, WORKSPACE_FS_ERROR_CODES.IO_FAILED);
  assert.equal(VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_QUEUE_FULL, WORKSPACE_FS_ERROR_CODES.WRITE_QUEUE_FULL);
});

test('versioned image reads return only bounded allowlisted image bytes with stable identity metadata', async () => {
  const root = createTrackedTempDir('jenny-versioned-image-');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.mkdirSync(path.join(root, 'Assets'));
  fs.writeFileSync(path.join(root, 'Assets', 'Logo.PNG'), bytes);
  const { service } = createService(root, { platform: 'win32' });

  const result = await service.readImage({ path: 'Assets/Logo.PNG' });

  assert.equal(DEFAULT_MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.deepEqual(Object.keys(result).sort(), [
    'base64', 'editable', 'fileVersion', 'generation', 'kind', 'mime', 'mtimeMs',
    'path', 'pathKey', 'representation', 'requestedPath', 'requestedPathKey',
    'rootId', 'size', 'truncated',
  ]);
  assert.equal(result.path, 'Assets/Logo.PNG');
  assert.equal(result.pathKey, 'assets/logo.png');
  assert.equal(result.requestedPath, 'Assets/Logo.PNG');
  assert.equal(result.requestedPathKey, 'assets/logo.png');
  assert.equal(result.kind, 'image');
  assert.equal(result.representation, 'base64');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.base64, bytes.toString('base64'));
  assert.equal(result.size, bytes.length);
  assert.equal(result.editable, false);
  assert.equal(result.truncated, false);
  assert.equal(result.rootId, 'root-a');
  assert.equal(result.generation, 7);
  assert.match(result.fileVersion, /^vf2_[A-Za-z0-9_-]{43}$/);
});

test('versioned image reads reject unsupported extensions before opening arbitrary bytes', async () => {
  const root = createTrackedTempDir('jenny-versioned-image-refusal-');
  fs.writeFileSync(path.join(root, 'payload.bin'), Buffer.from([0, 1, 2, 3]));
  let opens = 0;
  const fsProxy = Object.create(fsPromises);
  fsProxy.open = async (...args) => {
    opens += 1;
    return fsPromises.open(...args);
  };
  const { service } = createService(root, { fs: fsProxy });

  await assert.rejects(service.readImage({ path: 'payload.bin' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.IMAGE_UNSUPPORTED);
    return true;
  });
  assert.equal(opens, 0, 'unsupported binary content is never opened or read');
});

test('an allowlisted image extension cannot smuggle arbitrary non-image bytes', async () => {
  const root = createTrackedTempDir('jenny-versioned-image-signature-');
  const target = path.join(root, 'payload.png');
  const original = Buffer.from('not really a png');
  fs.writeFileSync(target, original);
  const { service } = createService(root);

  await assert.rejects(service.readImage({ path: 'payload.png' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.IMAGE_UNSUPPORTED);
    return true;
  });
  assert.deepEqual(fs.readFileSync(target), original);
});

test('image and preview reads enforce their own byte caps while ordinary edit reads keep the editor cap', async () => {
  const root = createTrackedTempDir('jenny-versioned-media-caps-');
  fs.writeFileSync(path.join(root, 'large.png'), Buffer.from('12345'));
  fs.writeFileSync(path.join(root, 'large.md'), '12345', 'utf8');
  const { service } = createService(root, {
    maxReadBytes: 64,
    maxImageBytes: 4,
  });

  await assert.rejects(service.readImage({ path: 'large.png' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.IMAGE_TOO_LARGE);
    assert.equal(error.details.max_bytes, 4);
    return true;
  });
  await assert.rejects(
    service.readText({ path: 'large.md', intent: 'preview', maxBytes: 4 }),
    (error) => error.code === WORKSPACE_FS_ERROR_CODES.TOO_LARGE
  );
  assert.equal((await service.readText({ path: 'large.md', intent: 'edit' })).content, '12345');
});

test('versioned image read refuses a path replacement after the handle opens', async () => {
  const root = createTrackedTempDir('jenny-versioned-image-swap-');
  const target = path.join(root, 'image.png');
  const originalPath = path.join(root, 'image-original.png');
  const original = Buffer.from('ORIGINAL-IMAGE');
  const replacement = Buffer.from('REPLACEMENT-IMAGE');
  fs.writeFileSync(target, original);
  let swapped = false;
  const { service } = createService(root, {
    hooks: {
      async afterTargetOpen({ stage }) {
        if (stage !== 'read-image' || swapped) return;
        swapped = true;
        fs.renameSync(target, originalPath);
        fs.writeFileSync(target, replacement);
      },
    },
  });

  await assert.rejects(service.readImage({ path: 'image.png' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT);
    return true;
  });
  assert.deepEqual(fs.readFileSync(originalPath), original);
  assert.deepEqual(fs.readFileSync(target), replacement);
});

test('versioned workspace reads return canonical identity metadata, strict EOL, and preserved UTF-8 BOM policy', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  fs.writeFileSync(path.join(root, 'MixedCase.txt'), 'line one\r\nline two\r\n', 'utf8');
  fs.writeFileSync(path.join(root, 'bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('hello\n')]));
  fs.writeFileSync(path.join(root, 'lf.txt'), 'one\ntwo\n', 'utf8');
  const { service } = createService(root, { platform: 'win32' });

  const crlf = await service.readText({ path: 'MixedCase.txt' });
  assert.deepEqual(Object.keys(crlf).sort(), [
    'content', 'editable', 'encoding', 'eol', 'fileVersion', 'generation',
    'mtimeMs', 'path', 'pathKey', 'requestedPath', 'requestedPathKey', 'rootId',
    'size', 'truncated',
  ]);
  assert.equal(crlf.path, 'MixedCase.txt');
  assert.equal(crlf.pathKey, 'mixedcase.txt');
  assert.equal(crlf.content, 'line one\r\nline two\r\n');
  assert.equal(crlf.eol, 'crlf');
  assert.equal(crlf.encoding, 'utf-8');
  assert.equal(crlf.editable, true);
  assert.equal(crlf.rootId, 'root-a');
  assert.equal(crlf.generation, 7);
  assert.match(crlf.fileVersion, /^vf2_[A-Za-z0-9_-]{43}$/);

  const lf = await service.readText({ path: 'lf.txt' });
  assert.equal(lf.eol, 'lf');

  const bom = await service.readText({ path: 'bom.txt' });
  assert.equal(bom.content, 'hello\n', 'the BOM is metadata, not an editor character');
  assert.equal(bom.encoding, 'utf-8-bom');
  const saved = await service.writeText({
    path: 'bom.txt',
    content: 'hello again\n',
    expectedGeneration: bom.generation,
    expectedFileVersion: bom.fileVersion,
  });
  assert.equal(saved.encoding, 'utf-8-bom');
  assert.deepEqual(
    fs.readFileSync(path.join(root, 'bom.txt')),
    Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('hello again\n')]),
    'a UTF-8 BOM survives the atomic replacement'
  );
});

test('an in-root link alias keeps requested identity while returning canonical file identity', async (t) => {
  const root = createTrackedTempDir('jenny-versioned-alias-');
  const inside = path.join(root, 'inside');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'note.txt'), 'inside\n', 'utf8');
  try {
    fs.symlinkSync(inside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const { service } = createService(root, { platform: process.platform });

  const result = await service.readText({ path: 'alias/note.txt' });

  assert.equal(result.path, 'inside/note.txt');
  assert.equal(result.requestedPath, 'alias/note.txt');
  assert.notEqual(result.pathKey, result.requestedPathKey);
  assert.equal(result.content, 'inside\n');
});

test('versioned workspace versions ignore metadata-only timestamp changes but detect byte changes', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const target = path.join(root, 'stable.txt');
  fs.writeFileSync(target, 'same bytes', 'utf8');
  const { service } = createService(root);

  const opened = await service.readText({ path: 'stable.txt' });
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(target, future, future);
  const touched = await service.readText({ path: 'stable.txt' });
  assert.notEqual(touched.mtimeMs, opened.mtimeMs);
  assert.equal(touched.fileVersion, opened.fileVersion);

  fs.writeFileSync(target, 'new bytes', 'utf8');
  const changed = await service.readText({ path: 'stable.txt' });
  assert.notEqual(changed.fileVersion, opened.fileVersion);
});

test('versioned workspace previews unsupported bytes without making them editable', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const target = path.join(root, 'legacy.bin');
  const original = Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]);
  fs.writeFileSync(target, original);
  const { service } = createService(root);

  await assert.rejects(service.readText({ path: 'legacy.bin' }), (error) => {
    assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.INVALID_UTF8);
    return true;
  });
  const preview = await service.readText({ path: 'legacy.bin', intent: 'preview' });
  assert.equal(preview.editable, false);
  assert.equal(preview.encoding, 'utf-16-le');
  assert.equal(preview.truncated, false);
  assert.match(preview.content, /^00000000\s+ff fe 61 00 62 00/);

  await assert.rejects(
    service.writeText({
      path: 'legacy.bin',
      content: 'replacement',
      expectedGeneration: preview.generation,
      expectedFileVersion: preview.fileVersion,
    }),
    (error) => {
      assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.INVALID_UTF8);
      return true;
    }
  );
  assert.deepEqual(fs.readFileSync(target), original);
});

test('versioned workspace reports a missing configured root distinctly from a transition', async () => {
  const rootContext = createRootCoordinator('', { rootId: null, generation: 3 });
  const { service } = createService('', { rootContext });

  await assert.rejects(service.readText({ path: 'note.txt' }), (error) => {
    assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.ROOT_MISSING);
    assert.deepEqual(error.details, {});
    return true;
  });
});

test('versioned workspace refuses stale generation and stale identity/hash versions without changing bytes', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const target = path.join(root, 'notes.txt');
  fs.writeFileSync(target, 'version-one', 'utf8');
  const { service, rootContext } = createService(root);
  const opened = await service.readText({ path: 'notes.txt' });

  rootContext.update({ generation: opened.generation + 1 });
  await assert.rejects(
    service.writeText({
      path: 'notes.txt',
      content: 'generation-clobber',
      expectedGeneration: opened.generation,
      expectedFileVersion: opened.fileVersion,
    }),
    (error) => {
      assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.STALE_GENERATION);
      return true;
    }
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'version-one');

  rootContext.update({ generation: opened.generation });
  fs.writeFileSync(target, 'external-two', 'utf8');
  await assert.rejects(
    service.writeText({
      path: 'notes.txt',
      content: 'version-clobber',
      expectedGeneration: opened.generation,
      expectedFileVersion: opened.fileVersion,
    }),
    (error) => {
      assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT);
      assert.match(error.details.current_file_version, /^vf2_/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'external-two');
  assert.deepEqual(tempNames(root), []);
});

test('versioned workspace refuses invalid UTF-8 and read/write oversize paths byte-for-byte', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const invalid = path.join(root, 'invalid.txt');
  const tooLarge = path.join(root, 'large.txt');
  const writable = path.join(root, 'small.txt');
  fs.writeFileSync(invalid, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  fs.writeFileSync(tooLarge, '123456789', 'utf8');
  fs.writeFileSync(writable, 'small', 'utf8');
  const { service } = createService(root, { maxReadBytes: 8, maxWriteBytes: 8 });

  await assert.rejects(service.readText({ path: 'invalid.txt' }), (error) => {
    assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.INVALID_UTF8);
    return true;
  });
  assert.deepEqual(fs.readFileSync(invalid), Buffer.from([0x63, 0x61, 0x66, 0xe9]));

  await assert.rejects(service.readText({ path: 'large.txt' }), (error) => {
    assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.TOO_LARGE);
    return true;
  });
  assert.equal(fs.readFileSync(tooLarge, 'utf8'), '123456789');

  const opened = await service.readText({ path: 'small.txt' });
  await assert.rejects(
    service.writeText({
      path: 'small.txt',
      content: '123456789',
      expectedGeneration: opened.generation,
      expectedFileVersion: opened.fileVersion,
    }),
    (error) => {
      assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.TOO_LARGE);
      return true;
    }
  );
  assert.equal(fs.readFileSync(writable, 'utf8'), 'small');
});

test('versioned workspace rejects a deterministic junction/symlink swap after open with both files unchanged', async (t) => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const outside = createTrackedTempDir('jenny-versioned-outside-');
  const inside = path.join(root, 'inside');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'note.txt'), 'inside-original', 'utf8');
  fs.writeFileSync(path.join(outside, 'note.txt'), 'outside-original', 'utf8');

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(inside, alias, linkType);
  } catch (error) {
    t.skip(`directory-link creation unavailable: ${error.code || error.message}`);
    return;
  }

  let swapped = false;
  const { service } = createService(root, {
    hooks: {
      async afterTargetOpen({ stage }) {
        if (stage !== 'write-current' || swapped) return;
        swapped = true;
        if (process.platform === 'win32') fs.rmdirSync(alias);
        else fs.unlinkSync(alias);
        fs.symlinkSync(outside, alias, linkType);
      },
    },
  });
  const opened = await service.readText({ path: 'alias/note.txt' });

  await assert.rejects(
    service.writeText({
      path: 'alias/note.txt',
      content: 'must-not-land',
      expectedGeneration: opened.generation,
      expectedFileVersion: opened.fileVersion,
    }),
    (error) => {
      assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.PATH_OUTSIDE_ROOT);
      return true;
    }
  );
  assert.equal(fs.readFileSync(path.join(inside, 'note.txt'), 'utf8'), 'inside-original');
  assert.equal(fs.readFileSync(path.join(outside, 'note.txt'), 'utf8'), 'outside-original');
  assert.deepEqual(tempNames(root), []);
});

test('versioned workspace serializes same-path writers so only the matching version can replace', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const target = path.join(root, 'shared.txt');
  fs.writeFileSync(target, 'base', 'utf8');
  const firstAtReplace = createDeferred();
  const allowFirstReplace = createDeferred();
  const secondQueued = createDeferred();
  let queuedCount = 0;
  let replaceCount = 0;
  const { service } = createService(root, {
    hooks: {
      async afterWriteQueued() {
        queuedCount += 1;
        if (queuedCount === 2) secondQueued.resolve();
      },
      async beforeReplace() {
        replaceCount += 1;
        if (replaceCount === 1) {
          firstAtReplace.resolve();
          await allowFirstReplace.promise;
        }
      },
    },
  });
  const opened = await service.readText({ path: 'shared.txt' });
  const first = service.writeText({
    path: 'shared.txt',
    content: 'first-writer',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  });
  await firstAtReplace.promise;

  const second = service.writeText({
    path: 'shared.txt',
    content: 'second-writer',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  });
  await secondQueued.promise;
  assert.equal(replaceCount, 1, 'the queued writer cannot reach replacement concurrently');
  allowFirstReplace.resolve();

  const saved = await first;
  assert.equal(saved.content, undefined, 'write metadata does not echo editor content');
  await assert.rejects(second, (error) => {
    assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT);
    return true;
  });
  assert.equal(fs.readFileSync(target, 'utf8'), 'first-writer');
  assert.equal(replaceCount, 1, 'the stale writer refuses before allocating a temp');
  assert.deepEqual(tempNames(root), []);
});

test('versioned workspace cleans exclusive temps on replacement failure and preserves existing mode on success', async (t) => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const target = path.join(root, 'mode.txt');
  fs.writeFileSync(target, 'original', 'utf8');
  if (process.platform !== 'win32') fs.chmodSync(target, 0o640);
  const originalMode = fs.statSync(target).mode & 0o7777;
  let failReplace = true;
  const fsAdapter = Object.create(fsPromises);
  fsAdapter.rename = async (from, to) => {
    if (failReplace && path.resolve(to) === path.resolve(target)) {
      const error = new Error('injected replacement failure');
      error.code = 'EACCES';
      throw error;
    }
    return fsPromises.rename(from, to);
  };
  const { service } = createService(root, { fs: fsAdapter });
  const opened = await service.readText({ path: 'mode.txt' });

  await assert.rejects(
    service.writeText({
      path: 'mode.txt',
      content: 'failed-write',
      expectedGeneration: opened.generation,
      expectedFileVersion: opened.fileVersion,
    }),
    (error) => {
      assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.ATOMIC_WRITE_FAILED);
      assert.equal(error.details.os_code, 'EACCES');
      return true;
    }
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.equal(fs.statSync(target).mode & 0o7777, originalMode);
  assert.deepEqual(tempNames(root), [], 'failed atomic replacement removes its exclusive temp');

  failReplace = false;
  const fresh = await service.readText({ path: 'mode.txt' });
  await service.writeText({
    path: 'mode.txt',
    content: 'successful-write',
    expectedGeneration: fresh.generation,
    expectedFileVersion: fresh.fileVersion,
  });
  assert.equal(fs.readFileSync(target, 'utf8'), 'successful-write');
  if (process.platform === 'win32') {
    t.diagnostic('POSIX permission bits are not meaningful on Windows; successful replace still covers the chmod path');
  } else {
    assert.equal(fs.statSync(target).mode & 0o7777, originalMode);
  }
  assert.deepEqual(tempNames(root), []);
});

test('versioned workspace distinguishes unsupported parent fsync from durability failure', async (t) => {
  for (const scenario of [
    { osCode: 'EINVAL', platform: 'linux', supported: false },
    { osCode: 'EPERM', platform: 'win32', supported: false },
    { osCode: 'EPERM', platform: 'linux', supported: true },
    { osCode: 'EIO', platform: 'linux', supported: true },
  ]) {
    await t.test(`${scenario.platform}-${scenario.osCode}`, async () => {
      const root = createTrackedTempDir('jenny-versioned-file-');
      const target = path.join(root, 'durable.txt');
      fs.writeFileSync(target, 'before', 'utf8');
      const logs = [];
      const observerCalls = [];
      const fsAdapter = Object.create(fsPromises);
      fsAdapter.open = async (filePath, flags, mode) => {
        const handle = await fsPromises.open(filePath, flags, mode);
        if (flags !== 'r' || path.resolve(filePath) !== path.resolve(root)) return handle;
        return {
          stat: handle.stat.bind(handle),
          close: handle.close.bind(handle),
          async sync() {
            const error = new Error(`injected parent sync ${scenario.osCode}`);
            error.code = scenario.osCode;
            throw error;
          },
        };
      };
      const { service } = createService(root, {
        fs: fsAdapter,
        platform: scenario.platform,
        logger: (level, event, details) => logs.push({ level, event, details }),
        writeObserver: {
          begin: (identity) => { observerCalls.push(['begin', identity]); return 'ticket-1'; },
          commit: (ticket, stats) => { observerCalls.push(['commit', ticket, stats.size]); return true; },
          abort: (ticket) => { observerCalls.push(['abort', ticket]); return true; },
        },
      });
      const opened = await service.readText({ path: 'durable.txt' });
      const write = service.writeText({
        path: 'durable.txt',
        content: `after-${scenario.osCode}`,
        expectedGeneration: opened.generation,
        expectedFileVersion: opened.fileVersion,
      });

      if (!scenario.supported) {
        await write;
        assert.equal(logs.at(-1).event, 'workspace_file.write');
        assert.ok(logs.some((entry) => entry.event === 'workspace_file.parent_sync_unsupported'));
        assert.deepEqual(observerCalls.map(([method]) => method), ['begin', 'commit']);
      } else {
        await assert.rejects(write, (error) => {
          assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.IO_FAILED);
          assert.equal(error.details.operation, 'sync_parent');
          assert.equal(error.details.bytes_replaced, true);
          assert.equal(error.details.durability_uncertain, true);
          return true;
        });
        assert.ok(logs.some((entry) => entry.event === 'workspace_file.parent_sync_failed'));
        assert.deepEqual(observerCalls.map(([method]) => method), ['begin', 'abort']);
      }
      assert.equal(fs.readFileSync(target, 'utf8'), `after-${scenario.osCode}`);
      assert.deepEqual(tempNames(root), []);
    });
  }
});

test('versioned workspace never deletes an unowned exclusive-temp collision', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const target = path.join(root, 'collision.txt');
  fs.writeFileSync(target, 'original', 'utf8');
  let collisionPath = '';
  const fsAdapter = Object.create(fsPromises);
  fsAdapter.open = async (filePath, flags, mode) => {
    if (flags === 'wx' && !collisionPath) {
      collisionPath = filePath;
      fs.writeFileSync(collisionPath, 'unowned-sentinel', 'utf8');
      const error = new Error('injected exclusive-name collision');
      error.code = 'EEXIST';
      throw error;
    }
    return fsPromises.open(filePath, flags, mode);
  };
  const { service } = createService(root, { fs: fsAdapter });
  const opened = await service.readText({ path: 'collision.txt' });

  await service.writeText({
    path: 'collision.txt',
    content: 'saved-after-collision',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  });

  assert.equal(fs.readFileSync(target, 'utf8'), 'saved-after-collision');
  assert.equal(fs.readFileSync(collisionPath, 'utf8'), 'unowned-sentinel');
  assert.deepEqual(tempNames(root), [path.basename(collisionPath)]);
});

// This deterministically covers an external write before the final version
// recheck. Node has no portable compare-and-rename primitive, so an edit in
// the smaller interval after that check and before rename remains documented
// as a residual race rather than receiving a non-atomic fallback.
test('versioned workspace rechecks the version immediately before replace and preserves a deferred external edit', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  const target = path.join(root, 'external-race.txt');
  fs.writeFileSync(target, 'opened-version', 'utf8');
  let injected = false;
  const { service } = createService(root, {
    hooks: {
      async beforeReplace() {
        assert.equal(injected, false);
        injected = true;
        fs.writeFileSync(target, 'external-winner', 'utf8');
      },
    },
  });
  const opened = await service.readText({ path: 'external-race.txt' });

  await assert.rejects(
    service.writeText({
      path: 'external-race.txt',
      content: 'stale-editor',
      expectedGeneration: opened.generation,
      expectedFileVersion: opened.fileVersion,
    }),
    (error) => {
      assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT);
      return true;
    }
  );
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'external-winner');
  assert.deepEqual(tempNames(root), [], 'refusal cleans the already-fsynced temp');
});

test('versioned workspace releases a positive lease that is already stale at acquisition', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  fs.writeFileSync(path.join(root, 'note.txt'), 'untouched', 'utf8');
  const context = Object.freeze({ rootPath: root, rootId: 'root-a', generation: 7, phase: 'ready' });
  let releaseCount = 0;
  let released = false;
  const rootContext = {
    captureContext: () => context,
    acquireOperation: () => ({
      acquired: true,
      operationId: 'stale-op',
      context,
      signal: new AbortController().signal,
      isCurrent: () => false,
      release() {
        if (released) return false;
        released = true;
        releaseCount += 1;
        return true;
      },
    }),
    isCurrent: () => true,
  };
  const { service } = createService(root, { rootContext });

  await assert.rejects(service.readText({ path: 'note.txt' }), (error) => {
    assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.ROOT_TRANSITIONING);
    assert.equal(error.details.reason, 'root_changed');
    return true;
  });
  assert.equal(releaseCount, 1);
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'untouched');
});

test('an acquired mutation lease remains authoritative while a root transition waits for it to drain', async () => {
  const root = createTrackedTempDir('jenny-versioned-lease-drain-');
  fs.writeFileSync(path.join(root, 'held.txt'), 'held bytes\n', 'utf8');
  const context = Object.freeze({ rootPath: root, rootId: 'root-held', generation: 9, phase: 'ready' });
  let released = false;
  const rootContext = {
    captureContext: () => context,
    isCurrent: () => false,
    acquireOperation: () => ({
      acquired: true,
      operationId: 'held-op',
      context,
      signal: new AbortController().signal,
      isCurrent: () => true,
      release() { released = true; return true; },
    }),
  };
  const service = new VersionedWorkspaceFileService({ rootContext });

  const result = await service.readText({ path: 'held.txt' });

  assert.equal(result.content, 'held bytes\n');
  assert.equal(result.generation, 9);
  assert.equal(released, true);
});

test('versioned workspace closes a deferred read handle when its cancellable lease aborts', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  fs.writeFileSync(path.join(root, 'note.txt'), 'untouched', 'utf8');
  const context = Object.freeze({ rootPath: root, rootId: 'root-a', generation: 7, phase: 'ready' });
  const controller = new AbortController();
  const openCalled = createDeferred();
  const finishOpen = createDeferred();
  let closeCount = 0;
  let releaseCount = 0;
  let released = false;
  const handle = {
    async close() {
      closeCount += 1;
    },
  };
  const fsAdapter = Object.create(fsPromises);
  fsAdapter.open = async () => {
    openCalled.resolve();
    return finishOpen.promise;
  };
  const rootContext = {
    captureContext: () => context,
    acquireOperation: () => ({
      acquired: true,
      operationId: 'cancelled-read',
      context,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      release() {
        if (released) return false;
        released = true;
        releaseCount += 1;
        return true;
      },
    }),
    isCurrent: () => true,
  };
  const { service } = createService(root, { rootContext, fs: fsAdapter });
  const read = service.readText({ path: 'note.txt' });
  await openCalled.promise;
  controller.abort();
  finishOpen.resolve(handle);

  await assert.rejects(read, (error) => {
    assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.ROOT_TRANSITIONING);
    assert.equal(error.details.reason, 'operation_cancelled');
    return true;
  });
  assert.equal(closeCount, 1);
  assert.equal(releaseCount, 1);
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'untouched');
});

test('versioned workspace returns a structured refusal when the root coordinator will not lease', async () => {
  const root = createTrackedTempDir('jenny-versioned-file-');
  fs.writeFileSync(path.join(root, 'note.txt'), 'untouched', 'utf8');
  const context = Object.freeze({ rootPath: root, rootId: 'root-a', generation: 7, phase: 'ready' });
  const rootContext = {
    captureContext: () => context,
    acquireOperation: () => ({ acquired: false, code: 'root_transitioning', context }),
    isCurrent: (candidate) => candidate === context,
  };
  const { service } = createService(root, { rootContext });

  await assert.rejects(service.readText({ path: 'note.txt' }), (error) => {
    assert.equal(error.code, VERSIONED_WORKSPACE_FILE_ERROR_CODES.ROOT_TRANSITIONING);
    assert.equal(error.details.reason, 'root_transitioning');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'untouched');
});
