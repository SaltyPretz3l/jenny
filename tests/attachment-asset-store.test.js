'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  AttachmentAssetStore,
  MAX_AUDIO_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
} = require('../services/attachment-asset-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('AttachmentAssetStore leaves an empty root unconfigured instead of resolving to the current working directory', () => {
  const store = new AttachmentAssetStore({ rootDir: '' });

  assert.equal(store.rootDir, '');
  assert.equal(store.isManagedAssetPath(process.cwd()), false);
  assert.throws(
    () => store.saveAudioBufferSync(Buffer.from('RIFF'), { mimeType: 'audio/wav' }),
    /not configured/i
  );
});

test('AttachmentAssetStore writes managed audio assets under the configured root', () => {
  const rootDir = createTrackedTempDir('jenny-attachment-assets-');
  const store = new AttachmentAssetStore({ rootDir });

  const saved = store.saveAudioBufferSync(Buffer.from('voice-bytes'), {
    displayName: 'Voice Clip',
    mimeType: 'audio/wav',
  });

  assert.equal(store.isManagedAssetPath(saved.assetPath), true);
  assert.equal(fs.existsSync(saved.assetPath), true);
  assert.equal(path.dirname(saved.assetPath), path.join(rootDir, 'audio'));
});

test('AttachmentAssetStore writes image assets after native image validation', () => {
  const rootDir = createTrackedTempDir('jenny-attachment-assets-image-');
  const store = new AttachmentAssetStore({
    rootDir,
    nativeImage: {
      createFromBuffer() {
        return {
          isEmpty: () => false,
          getSize: () => ({ width: 32, height: 16 }),
        };
      },
    },
  });

  const saved = store.saveImageBufferSync(Buffer.from('image-bytes'), {
    displayName: 'Capture.png',
    mimeType: 'image/png',
  });

  assert.equal(store.isManagedAssetPath(saved.assetPath), true);
  assert.equal(fs.existsSync(saved.assetPath), true);
  assert.equal(saved.width, 32);
  assert.equal(saved.height, 16);
});

test('AttachmentAssetStore rejects invalid image bytes from native image validation', () => {
  const rootDir = createTrackedTempDir('jenny-attachment-assets-bad-image-');
  const store = new AttachmentAssetStore({
    rootDir,
    nativeImage: {
      createFromBuffer() {
        return {
          isEmpty: () => true,
        };
      },
    },
  });

  assert.throws(
    () => store.saveImageBufferSync(Buffer.from('not-an-image'), { mimeType: 'image/png' }),
    /not a supported image/i
  );
});

test('AttachmentAssetStore rejects empty and oversized buffers', () => {
  const rootDir = createTrackedTempDir('jenny-attachment-assets-size-');
  const store = new AttachmentAssetStore({ rootDir });

  assert.throws(
    () => store.saveAudioBufferSync(Buffer.alloc(0), { mimeType: 'audio/wav' }),
    /bytes are empty/i
  );
  assert.throws(
    () => store.saveAudioBufferSync(Buffer.alloc(MAX_AUDIO_SIZE_BYTES + 1), { mimeType: 'audio/wav' }),
    /exceeds/i
  );
  assert.throws(
    () => store.saveImageBufferSync(Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1), { mimeType: 'image/png' }),
    /exceeds/i
  );
});

test('AttachmentAssetStore deleteAssets ignores paths outside the managed root', () => {
  const rootDir = createTrackedTempDir('jenny-attachment-assets-delete-');
  const outsideDir = createTrackedTempDir('jenny-attachment-assets-delete-outside-');
  const store = new AttachmentAssetStore({ rootDir });
  const saved = store.saveAudioBufferSync(Buffer.from('voice-bytes'), {
    displayName: 'Voice Clip',
    mimeType: 'audio/wav',
  });
  const outsidePath = path.join(outsideDir, 'keep.wav');
  fs.writeFileSync(outsidePath, 'outside');

  const result = store.deleteAssets([saved.assetPath, outsidePath]);

  assert.equal(result.deletedCount, 1);
  assert.equal(fs.existsSync(saved.assetPath), false);
  assert.equal(fs.existsSync(outsidePath), true);
});

test('AttachmentAssetStore prunes unreferenced managed assets from disk', () => {
  const rootDir = createTrackedTempDir('jenny-attachment-assets-prune-');
  const store = new AttachmentAssetStore({ rootDir });
  const referenced = store.saveAudioBufferSync(Buffer.from('keep'), {
    displayName: 'Keep.wav',
    mimeType: 'audio/wav',
  });
  const orphaned = store.saveAudioBufferSync(Buffer.from('remove'), {
    displayName: 'Remove.wav',
    mimeType: 'audio/wav',
  });

  const result = store.pruneUnreferencedAssets([referenced.assetPath], { minAgeMs: 0 });

  assert.equal(result.deletedCount, 1);
  assert.equal(fs.existsSync(referenced.assetPath), true);
  assert.equal(fs.existsSync(orphaned.assetPath), false);
});

test('AttachmentAssetStore resolves only managed asset paths for export', () => {
  const rootDir = createTrackedTempDir('jenny-attachment-assets-safe-');
  const outsideDir = createTrackedTempDir('jenny-attachment-assets-outside-');
  const store = new AttachmentAssetStore({ rootDir });
  const saved = store.saveAudioBufferSync(Buffer.from('voice-bytes'), {
    displayName: 'Voice Clip',
    mimeType: 'audio/wav',
  });
  const outsidePath = path.join(outsideDir, 'secret.wav');
  fs.writeFileSync(outsidePath, 'secret', 'utf8');

  assert.equal(store.resolveSafePath(saved.assetPath), saved.assetPath);
  assert.equal(store.resolveSafePath(outsidePath), '');
});

test('AttachmentAssetStore rejects symlinked managed audio paths that resolve outside the root', (t) => {
  const rootDir = createTrackedTempDir('jenny-attachment-assets-realpath-');
  const outsideDir = createTrackedTempDir('jenny-attachment-assets-realpath-outside-');
  const store = new AttachmentAssetStore({ rootDir });
  const audioDir = store.ensureKindDir('audio');
  const outsidePath = path.join(outsideDir, 'secret.wav');
  const symlinkPath = path.join(audioDir, 'linked-secret.wav');
  fs.writeFileSync(outsidePath, 'secret', 'utf8');
  try {
    fs.symlinkSync(outsidePath, symlinkPath);
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.code || error.message}`);
    return;
  }

  assert.equal(store.isManagedAssetPath(symlinkPath), true);
  assert.equal(store.resolveManagedAssetRealPath(symlinkPath, { kind: 'audio' }), '');
});
