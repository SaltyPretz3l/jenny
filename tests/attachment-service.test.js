const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const {
  MAX_ATTACHMENTS,
  MAX_FILE_CHARS,
  MAX_FILE_SIZE_BYTES,
  budgetAttachmentEntries,
  collectAssetPaths,
  collectImageAssetPaths,
  isSensitiveAttachmentPath,
  normalizeAttachmentMetadata,
  prepareAttachmentEntries,
} = require('../services/attachment-service');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function writeTempFile(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('prepareAttachmentEntries accepts readable files and rejects unsupported extensions', () => {
  const tempDir = createTrackedTempDir('jenny-shell-attachments-');
  const textFile = writeTempFile(tempDir, 'notes.txt', 'hello world');
  const imageFile = writeTempFile(tempDir, 'image.png', 'not really an image');

  const payload = prepareAttachmentEntries([textFile, imageFile], {
    cwd: tempDir,
    assetStore: {
      saveImportedImage(filePath) {
        return {
          id: 'image_1',
          kind: 'image',
          displayName: path.basename(filePath),
          mimeType: 'image/png',
          sizeBytes: 128,
          width: 16,
          height: 16,
          assetPath: path.join(tempDir, 'managed-image.png'),
        };
      },
    },
  });

  assert.equal(payload.accepted.length, 2);
  assert.equal(payload.accepted[0].promptName, 'notes.txt');
  assert.equal(payload.accepted[1].kind, 'image');
  assert.equal(payload.rejected.length, 0);
});

test('prepareAttachmentEntries rejects sensitive credential-shaped paths', () => {
  const tempDir = createTrackedTempDir('jenny-shell-attachments-sensitive-');
  const sshDir = path.join(tempDir, '.ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  const privateKey = writeTempFile(sshDir, 'id_ed25519', 'PRIVATE KEY');
  const envFile = writeTempFile(tempDir, '.env.local', 'TOKEN=secret');
  const regularFile = writeTempFile(tempDir, 'notes.txt', 'hello world');

  const payload = prepareAttachmentEntries([privateKey, envFile, regularFile], {
    cwd: tempDir,
  });

  assert.equal(payload.accepted.length, 1);
  assert.equal(payload.accepted[0].displayName, 'notes.txt');
  assert.equal(payload.rejected.length, 2);
  assert.ok(payload.rejected.every((entry) => /sensitive/i.test(entry.reason)));
  assert.equal(isSensitiveAttachmentPath(privateKey), true);
  assert.equal(isSensitiveAttachmentPath(regularFile), false);
});

test('prepareAttachmentEntries rejects images under sensitive paths outside the workspace root', () => {
  const tempDir = createTrackedTempDir('jenny-shell-attachments-sensitive-image-');
  const sshDir = path.join(tempDir, '.ssh');
  const workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(sshDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const imageFile = writeTempFile(sshDir, 'capture.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const payload = prepareAttachmentEntries([imageFile], { cwd: workspaceDir });

  assert.equal(payload.accepted.length, 0);
  assert.equal(payload.rejected.length, 1);
  assert.match(payload.rejected[0].reason, /sensitive/i);
});

test('prepareAttachmentEntries rejects audio clips at intake with the not-supported message', () => {
  const tempDir = createTrackedTempDir('jenny-shell-audio-attachments-');
  const audioFile = writeTempFile(tempDir, 'voice.webm', 'pretend webm bytes');

  let stored = 0;
  const payload = prepareAttachmentEntries([audioFile], {
    cwd: tempDir,
    assetStore: {
      saveImportedAudio() {
        stored += 1;
        return { id: 'audio_1', kind: 'audio' };
      },
    },
  });

  assert.equal(payload.accepted.length, 0, 'audio is never accepted');
  assert.equal(stored, 0, 'the asset store is never asked to persist the clip');
  assert.equal(payload.rejected.length, 1);
  assert.match(payload.rejected[0].reason, /Audio attachments are not supported/);
  assert.match(payload.rejected[0].reason, /never reach the model/);
});

test('prepareAttachmentEntries truncates oversized readable files to the per-file cap', () => {
  const tempDir = createTrackedTempDir('jenny-shell-attachments-truncate-');
  const filePath = writeTempFile(tempDir, 'long.md', 'a'.repeat(MAX_FILE_CHARS + 500));

  const payload = prepareAttachmentEntries([filePath], { cwd: tempDir });

  assert.equal(payload.accepted.length, 1);
  assert.equal(payload.accepted[0].truncated, true);
  assert.match(payload.accepted[0].text, /\.\.\.\[truncated\]$/);
});

test('prepareAttachmentEntries rejects bytes beyond the cap when stat is stale', (t) => {
  const filePath = path.resolve('growing.log');
  const fileBytes = Buffer.alloc(MAX_FILE_SIZE_BYTES + 500, 'a');
  let readOffset = 0;

  t.mock.method(fs, 'statSync', () => ({
    isFile: () => true,
    size: 10,
  }));
  t.mock.method(fs, 'readFileSync', () => fileBytes);
  t.mock.method(fs, 'openSync', () => 41);
  t.mock.method(fs, 'readSync', (fileDescriptor, target, targetOffset, length) => {
    assert.equal(fileDescriptor, 41);
    const bytesToRead = Math.min(length, fileBytes.length - readOffset);
    fileBytes.copy(target, targetOffset, readOffset, readOffset + bytesToRead);
    readOffset += bytesToRead;
    return bytesToRead;
  });
  t.mock.method(fs, 'closeSync', (fileDescriptor) => {
    assert.equal(fileDescriptor, 41);
  });

  const payload = prepareAttachmentEntries([filePath], { cwd: path.dirname(filePath) });

  assert.equal(payload.accepted.length, 0);
  assert.equal(payload.rejected.length, 1);
  assert.equal(payload.rejected[0].reason, 'File exceeds the 1 MB attachment limit.');
  assert.equal(payload.rejected[0].sizeBytes, MAX_FILE_SIZE_BYTES + 1);
  assert.equal(readOffset, MAX_FILE_SIZE_BYTES + 1);
});

test('prepareAttachmentEntries records accepted bytes instead of stale stat size', (t) => {
  const tempDir = createTrackedTempDir('jenny-shell-attachments-stale-stat-');
  const fileBytes = Buffer.from('accepted bytes', 'utf8');
  const filePath = writeTempFile(tempDir, 'changing.txt', fileBytes);
  const statSync = fs.statSync;

  t.mock.method(fs, 'statSync', (target, ...args) => {
    if (path.resolve(String(target)) === filePath) {
      return { isFile: () => true, size: 1 };
    }
    return statSync(target, ...args);
  });

  const payload = prepareAttachmentEntries([filePath], { cwd: tempDir });

  assert.equal(payload.rejected.length, 0);
  assert.equal(payload.accepted.length, 1);
  assert.equal(payload.accepted[0].text, fileBytes.toString('utf8'));
  assert.equal(payload.accepted[0].sizeBytes, fileBytes.length);
});

test('attachment truncation markers stay inside per-file and total character limits', () => {
  const tempDir = createTrackedTempDir('jenny-shell-attachments-truncate-budget-');
  const filePath = writeTempFile(tempDir, 'long.md', 'a'.repeat(MAX_FILE_CHARS + 500));
  const prepared = prepareAttachmentEntries([filePath], { cwd: tempDir });
  const budgeted = budgetAttachmentEntries([{ id: 'small', kind: 'text', text: 'abcdefghij' }], {
    totalCharLimit: 5,
  });

  assert.equal(prepared.accepted[0].text.length, MAX_FILE_CHARS);
  assert.equal(budgeted.accepted[0].text.length, 5);
  assert.equal(budgeted.usedChars, 5);
  assert.equal(budgeted.remainingChars, 0);
});

test('budgetAttachmentEntries preserves order and skips later files after the total cap is exhausted', () => {
  const payload = budgetAttachmentEntries([
    { id: 'img', kind: 'image', displayName: 'capture.png', assetPath: 'C:/capture.png' },
    { id: 'a', kind: 'text', displayName: 'a.txt', text: 'a'.repeat(20_000) },
    { id: 'b', kind: 'text', displayName: 'b.txt', text: 'b'.repeat(25_000) },
    { id: 'c', displayName: 'c.txt', text: 'c'.repeat(10_000) },
  ]);

  assert.equal(payload.accepted.length, 3);
  assert.equal(payload.accepted[0].id, 'img');
  assert.equal(payload.accepted[1].budgetTruncated, false);
  assert.equal(payload.accepted[2].budgetTruncated, true);
  assert.equal(payload.skipped.length, 1);
  assert.equal(payload.skipped[0].id, 'c');
});

test('budgetAttachmentEntries marks empty attachment bodies as skipped', () => {
  const payload = budgetAttachmentEntries([{ id: 'empty', displayName: 'empty.txt', text: '' }]);

  assert.equal(payload.accepted.length, 0);
  assert.equal(payload.skipped.length, 1);
  assert.match(payload.skipped[0].skippedReason, /empty/i);
});

test('prepareAttachmentEntries rejects files beyond the queue cap', () => {
  const tempDir = createTrackedTempDir('jenny-shell-attachment-cap-');
  const filePaths = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) =>
    writeTempFile(tempDir, `note-${index}.txt`, `file ${index}`)
  );

  const payload = prepareAttachmentEntries(filePaths, { cwd: tempDir });

  assert.equal(payload.accepted.length, MAX_ATTACHMENTS);
  assert.equal(payload.rejected.length, 1);
  assert.match(payload.rejected[0].reason, /limit reached/i);
});

test('normalizeAttachmentMetadata strips unsafe fields from image attachments', () => {
  const normalized = normalizeAttachmentMetadata({
    id: 'image_unsafe',
    kind: 'image',
    displayName: 'capture.png',
    mimeType: 'image/png',
    sizeBytes: 2048,
    width: 400,
    height: 300,
    assetPath: 'C:/safe/capture.png',
    sourceKind: 'capture',
    bytes: [1, 2, 3],
    text: 'should not persist',
  });

  assert.deepEqual(normalized, {
    id: 'image_unsafe',
    kind: 'image',
    displayName: 'capture.png',
    mimeType: 'image/png',
    sizeBytes: 2048,
    width: 400,
    height: 300,
    assetPath: 'C:/safe/capture.png',
    sourceKind: 'capture',
  });
});

test('normalizeAttachmentMetadata keeps bounded provenance for generated images only', () => {
  const generated = normalizeAttachmentMetadata({
    id: 'image_gen',
    kind: 'image',
    displayName: 'Generated Image',
    mimeType: 'image/png',
    sizeBytes: 4096,
    width: 2048,
    height: 2048,
    assetPath: 'C:/safe/generated.png',
    sourceKind: 'image_generation',
    provenance: {
      model_id: 'HiDream-ai/HiDream-O1-Image',
      model_revision: '2c2d29ff729e48f33e41f49edfdbd81d5ac103b4',
      quant: 'nf4',
      seed: 42,
      width: 2048,
      height: 2048,
      steps: 8,
      app_version: '0.9.1',
      prompt: 'must not persist',
      staging_dir: 'C:/must/not/persist',
    },
  });

  assert.equal(generated.generated, true);
  assert.deepEqual(generated.provenance, {
    model_id: 'HiDream-ai/HiDream-O1-Image',
    model_revision: '2c2d29ff729e48f33e41f49edfdbd81d5ac103b4',
    quant: 'nf4',
    seed: 42,
    width: 2048,
    height: 2048,
    steps: 8,
    app_version: '0.9.1',
  }, 'only the eight C4 keys survive; prompt and paths drop');

  // A plain (non-generated) image never gains the provenance surface, even
  // when a caller supplies one.
  const plain = normalizeAttachmentMetadata({
    id: 'image_plain',
    kind: 'image',
    displayName: 'capture.png',
    assetPath: 'C:/safe/capture.png',
    sourceKind: 'capture',
    provenance: { model_id: 'spoofed' },
  });
  assert.equal(plain.generated, undefined);
  assert.equal(plain.provenance, undefined);
});

test('normalizeAttachmentMetadata keeps the preview derivative path for generated images only', () => {
  const generated = normalizeAttachmentMetadata({
    kind: 'image',
    assetPath: 'C:/safe/generated.png',
    sourceKind: 'image_generation',
    previewAssetPath: 'C:/safe/generated_preview.png',
  });
  assert.equal(generated.previewAssetPath, 'C:/safe/generated_preview.png');

  const plain = normalizeAttachmentMetadata({
    kind: 'image',
    assetPath: 'C:/safe/capture.png',
    sourceKind: 'capture',
    previewAssetPath: 'C:/spoofed/preview.png',
  });
  assert.equal(plain.previewAssetPath, undefined, 'non-generated images never gain the preview surface');
});

test('normalizeAttachmentMetadata preserves safe audio transcript metadata', () => {
  const normalized = normalizeAttachmentMetadata({
    id: 'audio_unsafe',
    kind: 'audio',
    displayName: 'voice.webm',
    mimeType: 'audio/webm',
    sizeBytes: 4096,
    durationMs: 4200,
    assetPath: 'C:/safe/voice.webm',
    sourceKind: 'microphone',
    transcriptText: 'hello there',
    transcriptStatus: 'complete',
    transcriptLanguage: 'EN',
    bytes: [1, 2, 3],
  });

  assert.deepEqual(normalized, {
    id: 'audio_unsafe',
    kind: 'audio',
    displayName: 'voice.webm',
    mimeType: 'audio/webm',
    sizeBytes: 4096,
    durationMs: 4200,
    assetPath: 'C:/safe/voice.webm',
    sourceKind: 'microphone',
    transcriptText: 'hello there',
    transcriptStatus: 'complete',
    transcriptLanguage: 'en',
  });
});

test('collectAssetPaths returns managed image and audio asset paths', () => {
  const assetPaths = collectAssetPaths([
    { id: 'image_1', kind: 'image', displayName: 'capture.png', assetPath: 'C:/safe/capture.png' },
    { id: 'audio_1', kind: 'audio', displayName: 'voice.webm', assetPath: 'C:/safe/voice.webm' },
    { id: 'text_1', kind: 'text', displayName: 'notes.txt', text: 'hello' },
  ]);

  assert.deepEqual(assetPaths, [
    'C:/safe/capture.png',
    'C:/safe/voice.webm',
  ]);
});

test('asset path collectors include generated image previews after their originals', () => {
  const entries = [{
    kind: 'image',
    assetPath: 'C:/safe/generated.png',
    sourceKind: 'image_generation',
    previewAssetPath: 'C:/safe/generated_preview.png',
  }];

  assert.deepEqual(collectAssetPaths(entries), [
    'C:/safe/generated.png',
    'C:/safe/generated_preview.png',
  ]);
  assert.deepEqual(collectImageAssetPaths(entries), [
    'C:/safe/generated.png',
    'C:/safe/generated_preview.png',
  ]);
});

test('asset path collectors emit one path for an image without a preview', () => {
  const entries = [{
    kind: 'image',
    assetPath: 'C:/safe/capture.png',
  }];

  assert.deepEqual(collectAssetPaths(entries), ['C:/safe/capture.png']);
  assert.deepEqual(collectImageAssetPaths(entries), ['C:/safe/capture.png']);
});

test('asset path collectors preserve flat per-entry ordering for mixed attachments', () => {
  const entries = [
    {
      kind: 'image',
      assetPath: 'C:/safe/generated.png',
      sourceKind: 'image_generation',
      previewAssetPath: 'C:/safe/generated_preview.png',
    },
    { kind: 'image', assetPath: 'C:/safe/capture.png' },
    { kind: 'audio', assetPath: 'C:/safe/voice.webm' },
  ];

  assert.deepEqual(collectAssetPaths(entries), [
    'C:/safe/generated.png',
    'C:/safe/generated_preview.png',
    'C:/safe/capture.png',
    'C:/safe/voice.webm',
  ]);
  assert.deepEqual(collectImageAssetPaths(entries), [
    'C:/safe/generated.png',
    'C:/safe/generated_preview.png',
    'C:/safe/capture.png',
  ]);
});
