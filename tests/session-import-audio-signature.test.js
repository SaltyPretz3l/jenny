'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { AttachmentAssetStore } = require('../services/attachment-asset-store');
const {
  SESSION_IMPORT_ERROR_CODES,
  importSession,
} = require('../services/backend/session-export-import');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createStores(t) {
  const directory = createTrackedTempDir('jenny-import-audio-signature-');
  const store = new ElectronSessionStore(path.join(directory, 'sessions.json'), { writeDebounceMs: 0 });
  t.after(() => store.dispose());
  const attachmentStore = new AttachmentAssetStore({
    rootDir: path.join(directory, 'attachments'),
    nativeImage: { createFromBuffer: () => ({
      isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }),
    }) },
  });
  return { store, attachmentStore };
}

function importPayload(bytes, mimeType, kind = 'audio') {
  return JSON.stringify({
    format: 'jenny-session-export',
    format_version: 1,
    session: {
      title: 'Signature import',
      messages: [{
        id: 'msg_clip', role: 'user', content: 'Attachment',
        attachments: [{
          id: 'clip', kind, displayName: 'Claimed.mp3', mimeType,
          _exportedData: bytes.toString('base64'), _exportedMime: mimeType,
        }],
      }],
    },
  });
}

test('import rejects fake audio before persisting a session or asset file', (t) => {
  const { store, attachmentStore } = createStores(t);
  const audioDir = attachmentStore.ensureKindDir('audio');
  const payload = importPayload(Buffer.from('not audio at all'), 'audio/wav');

  assert.throws(() => importSession(store, payload, attachmentStore), (error) => {
    assert.equal(error.name, 'SessionImportError');
    assert.equal(error.code, SESSION_IMPORT_ERROR_CODES.ATTACHMENT_FAILED);
    assert.equal(error.reason, 'attachment_failed');
    assert.match(error.cause.message, /^Attachment is not a supported audio clip\.$/);
    return true;
  });
  assert.deepEqual(store._read().sessions, {});
  assert.deepEqual(fs.readdirSync(audioDir), []);
});

test('import persists the sniffed WAV MIME instead of the claimed MPEG MIME', (t) => {
  const { store, attachmentStore } = createStores(t);
  const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(4)]);
  const result = importSession(store, importPayload(bytes, 'audio/mpeg'), attachmentStore);
  const restored = store.getSession(result.id).messages[0].attachments[0];

  assert.equal(restored.mimeType, 'audio/wav');
  assert.equal(path.extname(restored.assetPath), '.wav');
  assert.deepEqual(fs.readFileSync(restored.assetPath), bytes);
  assert.equal(Object.hasOwn(restored, '_exportedData'), false);
  assert.equal(Object.hasOwn(restored, '_exportedMime'), false);
});

test('import persists the sniffed image MIME instead of the claimed JPEG MIME', (t) => {
  const { store, attachmentStore } = createStores(t);
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const result = importSession(store, importPayload(bytes, 'image/jpeg', 'image'), attachmentStore);
  const restored = store.getSession(result.id).messages[0].attachments[0];

  assert.equal(restored.mimeType, 'image/png');
  assert.equal(path.extname(restored.assetPath), '.png');
  assert.deepEqual(fs.readFileSync(restored.assetPath), bytes);
});
