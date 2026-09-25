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
  DEFAULT_MAX_DOCUMENT_BYTES,
  VERSIONED_WORKSPACE_FILE_ERROR_CODES,
  VersionedWorkspaceFileService,
} = require('../services/versioned-workspace-file-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/backend/error-codes');
const { DOCUMENT_FORMATS } = require('../services/versioned-workspace-file-documents');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'documents');

function createRootCoordinator(rootPath, { rootId = 'root-a', generation = 7 } = {}) {
  const context = Object.freeze({ rootPath, rootId, generation, phase: 'ready' });
  let operationSequence = 0;
  const coordinator = {
    captureContext: () => context,
    acquireOperation({ kind, cancellable = false } = {}) {
      operationSequence += 1;
      return {
        acquired: true,
        operationId: `op-${operationSequence}`,
        context,
        signal: new AbortController().signal,
        kind,
        cancellable,
        release: () => true,
        isCurrent: () => coordinator.isCurrent(context),
      };
    },
    isCurrent(candidate) {
      return Boolean(candidate
        && candidate.rootId === context.rootId
        && candidate.generation === context.generation
        && context.phase === 'ready');
    },
  };
  return coordinator;
}

function createService(root, options = {}) {
  return new VersionedWorkspaceFileService({
    rootContext: options.rootContext || createRootCoordinator(root),
    ...options,
  });
}

function copyFixture(root, name, targetName = name) {
  const bytes = fs.readFileSync(path.join(FIXTURE_ROOT, name));
  fs.writeFileSync(path.join(root, targetName), bytes);
  return bytes;
}

function tempNames(root) {
  return fs.readdirSync(root).filter((name) => name.includes('.jenny-vfs-'));
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('readDocument opens DOCX bytes as editable base64 document metadata', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  const bytes = copyFixture(root, 'paragraphs.docx');
  const result = await createService(root).readDocument({ path: 'paragraphs.docx' });

  assert.equal(DEFAULT_MAX_DOCUMENT_BYTES, 32 * 1024 * 1024);
  assert.equal(
    VERSIONED_WORKSPACE_FILE_ERROR_CODES.DOCUMENT_UNSUPPORTED,
    WORKSPACE_FS_ERROR_CODES.DOCUMENT_UNSUPPORTED
  );
  assert.equal(
    VERSIONED_WORKSPACE_FILE_ERROR_CODES.DOCUMENT_TOO_LARGE,
    WORKSPACE_FS_ERROR_CODES.DOCUMENT_TOO_LARGE
  );
  assert.equal(result.kind, 'document');
  assert.equal(result.format, 'docx');
  assert.equal(result.mime, DOCUMENT_FORMATS.docx.mime);
  assert.equal(result.base64, bytes.toString('base64'));
  assert.equal(result.editable, true);
  assert.equal(result.truncated, false);
  assert.match(result.fileVersion, /^vf2_[A-Za-z0-9_-]{43}$/);
});

test('readDocument opens PDF bytes with the PDF descriptor', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  copyFixture(root, 'text.pdf');
  const result = await createService(root).readDocument({ path: 'text.pdf' });

  assert.equal(result.format, 'pdf');
  assert.equal(result.mime, 'application/pdf');
});

test('readDocument rejects unsupported extensions before opening a handle', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello', 'utf8');
  let opens = 0;
  const service = createService(root, {
    hooks: { afterTargetOpen: () => { opens += 1; } },
  });

  await rejectsWithCode(
    service.readDocument({ path: 'notes.txt' }),
    WORKSPACE_FS_ERROR_CODES.DOCUMENT_UNSUPPORTED
  );
  assert.equal(opens, 0);
});

test('readDocument rejects PDF and DOCX extensions over invalid bytes', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  fs.writeFileSync(path.join(root, 'evil.pdf'), 'hello', 'utf8');
  fs.writeFileSync(path.join(root, 'evil.docx'), 'not a zip', 'utf8');
  const service = createService(root);

  for (const name of ['evil.pdf', 'evil.docx']) {
    await rejectsWithCode(
      service.readDocument({ path: name }),
      WORKSPACE_FS_ERROR_CODES.DOCUMENT_UNSUPPORTED
    );
  }
});

test('document reads enforce the document cap independently of the text cap', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  const oversize = Buffer.alloc(17, 0x20);
  oversize.write('%PDF-');
  fs.writeFileSync(path.join(root, 'oversize.pdf'), oversize);
  await rejectsWithCode(
    createService(root, { maxDocumentBytes: 16 }).readDocument({ path: 'oversize.pdf' }),
    WORKSPACE_FS_ERROR_CODES.DOCUMENT_TOO_LARGE
  );

  const sixMiB = Buffer.alloc(6 * 1024 * 1024, 0x20);
  sixMiB.write('%PDF-');
  fs.writeFileSync(path.join(root, 'large.pdf'), sixMiB);
  const service = createService(root);
  assert.equal((await service.readDocument({ path: 'large.pdf' })).size, sixMiB.length);
  await rejectsWithCode(
    service.readText({ path: 'large.pdf' }),
    WORKSPACE_FS_ERROR_CODES.TOO_LARGE
  );
});

test('writeDocument replaces DOCX bytes and a later read returns the new version', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  copyFixture(root, 'paragraphs.docx');
  const replacement = fs.readFileSync(path.join(FIXTURE_ROOT, 'lists-tables.docx'));
  const service = createService(root);
  const opened = await service.readDocument({ path: 'paragraphs.docx' });

  const saved = await service.writeDocument({
    path: 'paragraphs.docx',
    base64: replacement.toString('base64'),
    format: 'docx',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  });

  assert.notEqual(saved.fileVersion, opened.fileVersion);
  assert.equal(saved.base64, undefined);
  assert.deepEqual(fs.readFileSync(path.join(root, 'paragraphs.docx')), replacement);
  const reopened = await service.readDocument({ path: 'paragraphs.docx' });
  assert.equal(reopened.base64, replacement.toString('base64'));
  assert.equal(reopened.fileVersion, saved.fileVersion);
});

test('writeDocument rejects a stale version without touching current bytes or temp files', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  copyFixture(root, 'paragraphs.docx');
  const currentBytes = fs.readFileSync(path.join(FIXTURE_ROOT, 'lists-tables.docx'));
  const attemptedBytes = fs.readFileSync(path.join(FIXTURE_ROOT, 'images-headers.docx'));
  const service = createService(root);
  const opened = await service.readDocument({ path: 'paragraphs.docx' });
  fs.writeFileSync(path.join(root, 'paragraphs.docx'), currentBytes);

  await rejectsWithCode(service.writeDocument({
    path: 'paragraphs.docx',
    base64: attemptedBytes.toString('base64'),
    format: 'docx',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  }), WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT);

  assert.deepEqual(fs.readFileSync(path.join(root, 'paragraphs.docx')), currentBytes);
  assert.deepEqual(tempNames(root), []);
});

test('writeDocument validates base64, format, magic, and size before creating temps', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  copyFixture(root, 'paragraphs.docx');
  const service = createService(root, { maxDocumentBytes: 16 });
  const common = {
    path: 'paragraphs.docx',
    format: 'docx',
    expectedGeneration: 7,
    expectedFileVersion: 'vf2_valid',
  };

  await rejectsWithCode(
    service.writeDocument({ ...common, base64: Buffer.from('hello').toString('base64') }),
    WORKSPACE_FS_ERROR_CODES.DOCUMENT_UNSUPPORTED
  );
  await rejectsWithCode(
    service.writeDocument({ ...common, format: 'pdf', base64: 'UEsDBA==' }),
    WORKSPACE_FS_ERROR_CODES.DOCUMENT_UNSUPPORTED
  );
  await rejectsWithCode(
    service.writeDocument({ ...common, base64: 'not base64' }),
    WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING
  );
  const tooLarge = Buffer.alloc(17, 0x20);
  tooLarge.write('PK\x03\x04', 0, 'binary');
  await rejectsWithCode(
    service.writeDocument({ ...common, base64: tooLarge.toString('base64') }),
    WORKSPACE_FS_ERROR_CODES.DOCUMENT_TOO_LARGE
  );
  assert.deepEqual(tempNames(root), []);
});

test('writeDocument returns metadata for identical bytes without rewriting', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  const bytes = copyFixture(root, 'paragraphs.docx');
  const target = path.join(root, 'paragraphs.docx');
  const service = createService(root);
  const opened = await service.readDocument({ path: 'paragraphs.docx' });
  const beforeMtime = fs.statSync(target).mtimeMs;

  const saved = await service.writeDocument({
    path: 'paragraphs.docx',
    base64: bytes.toString('base64'),
    format: 'docx',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  });

  assert.equal(saved.fileVersion, opened.fileVersion);
  assert.equal(fs.statSync(target).mtimeMs, beforeMtime);
  assert.deepEqual(tempNames(root), []);
});

test('writeDocument preserves original bytes and cleans its temp when rename fails', async () => {
  const root = createTrackedTempDir('jenny-versioned-document-');
  const original = copyFixture(root, 'paragraphs.docx');
  const replacement = fs.readFileSync(path.join(FIXTURE_ROOT, 'lists-tables.docx'));
  const target = path.join(root, 'paragraphs.docx');
  const fsAdapter = Object.create(fsPromises);
  fsAdapter.rename = async (from, to) => {
    if (path.resolve(to) === path.resolve(target)) {
      const error = new Error('injected replacement failure');
      error.code = 'EACCES';
      throw error;
    }
    return fsPromises.rename(from, to);
  };
  const service = createService(root, { fs: fsAdapter });
  const opened = await service.readDocument({ path: 'paragraphs.docx' });

  await rejectsWithCode(service.writeDocument({
    path: 'paragraphs.docx',
    base64: replacement.toString('base64'),
    format: 'docx',
    expectedGeneration: opened.generation,
    expectedFileVersion: opened.fileVersion,
  }), WORKSPACE_FS_ERROR_CODES.ATOMIC_WRITE_FAILED);

  assert.deepEqual(fs.readFileSync(target), original);
  assert.deepEqual(tempNames(root), []);
});
