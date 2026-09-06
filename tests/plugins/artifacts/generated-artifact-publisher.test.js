'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AttachmentAssetStore } = require('../../../services/attachment-asset-store');
const {
  MAX_GENERATED_ARTIFACT_BYTES,
  publishGeneratedArtifact,
  readValidatedPng,
  sha256,
} = require('../../../services/plugins/artifacts/generated-artifact-publisher');
const {
  readPngStructure,
} = require('../../../services/plugins/artifacts/png-validator');
const {
  sameFileSnapshot,
} = require('../../../services/plugins/artifacts/bounded-file-reader');
const { PNG_SIGNATURE, makeHeaderOnlyPng, makePng, pngChunk } = require('./png-fixtures');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-generated-artifact-'));
  const scratch = path.join(root, 'scratch');
  const assets = path.join(root, 'assets');
  fs.mkdirSync(scratch, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    scratch,
    store: new AttachmentAssetStore({ rootDir: assets, nativeImage: null }),
  };
}

function stage(directory, bytes, name = 'output.png') {
  const target = path.join(directory, name);
  fs.writeFileSync(target, bytes);
  return target;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test('publishes a validated PNG atomically with bounded plugin provenance', (t) => {
  const value = workspace(t);
  const bytes = makePng(64, 32);
  const staged = stage(value.scratch, bytes);
  const published = publishGeneratedArtifact({
    attachmentAssetStore: value.store,
    scratchDirectory: value.scratch,
    stagedFile: staged,
    expectedDigest: sha256(bytes),
    expectedWidth: 64,
    expectedHeight: 32,
    identity: {
      publisher_id: 'jenny-official',
      plugin_id: 'local-image-generation',
      plugin_version: '1.0.0',
      provider_contribution_id: 'local_image_generation',
    },
    operationId: 'operation-1',
    provenance: { model_id: 'model', model_revision: 'rev', seed: 42, prompt: 'secret' },
    nowMs: 1_700_000_000_000,
  });

  assert.equal(published.digest, sha256(bytes));
  assert.deepEqual(fs.readFileSync(published.attachment.assetPath), bytes);
  assert.equal(published.attachment.sourceKind, 'plugin_generation');
  assert.equal(published.attachment.provenance.operation_id, 'operation-1');
  assert.equal(published.attachment.provenance.seed, 42);
  assert.equal(Object.hasOwn(published.attachment.provenance, 'prompt'), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(published.attachment.assetPath)).filter((name) => name.endsWith('.part')),
    [],
  );
});

test('rejects traversal, realpath escape, digest mismatch, and dimension mismatch', (t) => {
  const value = workspace(t);
  const bytes = makePng(32, 16);
  const outside = stage(value.root, bytes, 'outside.png');
  expectCode(() => readValidatedPng({ scratchDirectory: value.scratch, stagedFile: outside }),
    'plugin_artifact_path_rejected');
  expectCode(() => readValidatedPng({
    scratchDirectory: value.scratch,
    stagedFile: path.join(value.scratch, '..', 'outside.png'),
  }), 'plugin_artifact_path_rejected');

  const staged = stage(value.scratch, bytes);
  expectCode(() => readValidatedPng({
    scratchDirectory: value.scratch, stagedFile: staged, expectedDigest: '0'.repeat(64),
  }), 'plugin_artifact_digest_mismatch');
  expectCode(() => readValidatedPng({
    scratchDirectory: value.scratch, stagedFile: staged, expectedWidth: 99, expectedHeight: 16,
  }), 'plugin_artifact_dimension_mismatch');

  const linked = path.join(value.scratch, 'linked');
  try {
    fs.symlinkSync(value.root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expectCode(() => readValidatedPng({
      scratchDirectory: value.scratch, stagedFile: path.join(linked, 'outside.png'),
    }), 'plugin_artifact_path_rejected');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
  }
});

test('rejects malformed PNG structure and decompression abuse', () => {
  assert.deepEqual(readPngStructure(makeHeaderOnlyPng(32, 32)), { ok: false, reason: 'no_idat' });
  const trailing = Buffer.concat([makePng(32, 32), Buffer.from('trailing payload')]);
  assert.equal(readPngStructure(trailing).reason, 'trailing_bytes');
  const corrupt = makePng(32, 32);
  corrupt.writeUInt32BE(33, 16);
  assert.equal(readPngStructure(corrupt).reason, 'crc_mismatch');
});

test('rejects a PNG scanline with an invalid filter byte', () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(0, 9);
  const invalid = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', require('node:zlib').deflateSync(Buffer.from([5, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  assert.deepEqual(readPngStructure(invalid), { ok: false, reason: 'invalid_filter_type' });
});

test('same-file snapshots require timestamps to remain stable when inode data is available', () => {
  const stat = (mtimeMs, ctimeMs) => ({
    size: 4, ino: 12, dev: 3, mtimeMs, ctimeMs, isFile: () => true,
  });
  assert.equal(sameFileSnapshot(stat(100, 100), stat(200, 200)), false);
});

test('enforces the 64 MiB file cap before reading', (t) => {
  const value = workspace(t);
  const staged = stage(value.scratch, makePng(8, 8));
  let reads = 0;
  const fsImpl = {
    ...fs,
    fstatSync(descriptor) {
      const stat = fs.fstatSync(descriptor);
      return {
        ...stat, size: MAX_GENERATED_ARTIFACT_BYTES + 1, isFile: () => true,
      };
    },
    readSync(...args) { reads += 1; return fs.readSync(...args); },
  };
  expectCode(() => readValidatedPng({ fsImpl, scratchDirectory: value.scratch, stagedFile: staged }),
    'plugin_artifact_size_rejected');
  assert.equal(reads, 0);
});

test('accepts a valid artifact above 4 MiB and detects a read/stat race', (t) => {
  const value = workspace(t);
  const bytes = makePng(16, 16, { ancillaryBytes: (4 * 1024 * 1024) + 1 });
  const staged = stage(value.scratch, bytes);
  assert.equal(readValidatedPng({
    scratchDirectory: value.scratch, stagedFile: staged, expectedDigest: sha256(bytes),
  }).buffer.length, bytes.length);

  let reads = 0;
  const fsImpl = {
    ...fs,
    readSync(...args) {
      reads += 1;
      const count = fs.readSync(...args);
      if (reads === 1) fs.appendFileSync(staged, Buffer.from([0]));
      return count;
    },
  };
  expectCode(() => readValidatedPng({ fsImpl, scratchDirectory: value.scratch, stagedFile: staged }),
    'plugin_artifact_raced');
  assert.ok(reads >= 1);
});

test('failed atomic rename leaves no partial attachment', (t) => {
  const value = workspace(t);
  const staged = stage(value.scratch, makePng(8, 8));
  const fsImpl = { ...fs, renameSync() { throw new Error('locked'); } };
  expectCode(() => publishGeneratedArtifact({
    fsImpl,
    attachmentAssetStore: value.store,
    scratchDirectory: value.scratch,
    stagedFile: staged,
  }), 'plugin_artifact_publish_failed');
  assert.deepEqual(fs.readdirSync(value.store.ensureKindDir('image')), []);
});
