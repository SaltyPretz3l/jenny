// Attachment lifecycle for backendService.editUserMessageAndTruncate: which
// managed files a truncation is allowed to delete, and which it must keep.
// Separate from electron-session-store-truncate.test.js, which owns the store /
// shadow / journal contract — this file owns the destructive-delete rules.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SessionShadowStore,
} = require('../services/backend/session-shadow-store');
const {
  AttachmentAssetStore,
} = require('../services/attachment-asset-store');
const {
  cleanupTrackedResources,
} = require('./helpers/resource-cleanup');
const {
  freshStore,
  seedConversation,
} = require('./helpers/session-truncate-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('editUserMessageAndTruncate prunes original and preview assets orphaned by truncation', async () => {
  const { editUserMessageAndTruncate } = require('../services/backend/backend-session-truncate');
  const { store, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Asset prune' });
  seedConversation(store, sessionId);
  const attachmentAssetStore = new AttachmentAssetStore({
    rootDir: path.join(userDataPath, 'attachments'),
  });
  const imageDir = attachmentAssetStore.ensureKindDir('image');
  const assetPath = path.join(imageDir, 'generated.png');
  const previewAssetPath = path.join(imageDir, 'generated-preview.png');
  fs.writeFileSync(assetPath, 'original');
  fs.writeFileSync(previewAssetPath, 'preview');
  store.updateMessage(sessionId, 'msg_ai_2', {
    attachments: [{
      id: 'image_generated',
      kind: 'image',
      displayName: 'Generated.png',
      mimeType: 'image/png',
      assetPath,
      previewAssetPath,
      sourceKind: 'image_generation',
      generated: true,
    }],
  });

  const result = await editUserMessageAndTruncate({
    sessionStore: store,
    attachmentAssetStore,
  }, sessionId, 'msg_user_2', { content: 'edited second prompt' });

  assert.ok(result);
  assert.equal(fs.existsSync(assetPath), false);
  assert.equal(fs.existsSync(previewAssetPath), false);
});

test('editUserMessageAndTruncate keeps an asset referenced by a surviving message', async () => {
  const { editUserMessageAndTruncate } = require('../services/backend/backend-session-truncate');
  const { store, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Shared asset' });
  seedConversation(store, sessionId);
  const attachmentAssetStore = new AttachmentAssetStore({
    rootDir: path.join(userDataPath, 'attachments'),
  });
  const attachment = attachmentAssetStore.saveAudioBufferSync(Buffer.from('shared-audio'), {
    displayName: 'Shared.wav',
    mimeType: 'audio/wav',
  });
  store.updateMessage(sessionId, 'msg_user_1', { attachments: [attachment] });
  store.updateMessage(sessionId, 'msg_ai_2', { attachments: [attachment] });

  const result = await editUserMessageAndTruncate({
    sessionStore: store,
    attachmentAssetStore,
  }, sessionId, 'msg_user_2', { content: 'edited second prompt' });

  assert.ok(result);
  assert.equal(fs.existsSync(attachment.assetPath), true);
});

test('editUserMessageAndTruncate does not prune assets when journal purge rolls back', async () => {
  const { editUserMessageAndTruncate } = require('../services/backend/backend-session-truncate');
  const { store, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Asset rollback' });
  seedConversation(store, sessionId);
  const realAssetStore = new AttachmentAssetStore({
    rootDir: path.join(userDataPath, 'attachments'),
  });
  const attachment = realAssetStore.saveAudioBufferSync(Buffer.from('rollback-audio'), {
    displayName: 'Rollback.wav',
    mimeType: 'audio/wav',
  });
  store.updateMessage(sessionId, 'msg_ai_2', { attachments: [attachment] });
  let pruneCalls = 0;
  const attachmentAssetStore = {
    async pruneAssetPaths(candidatePaths, referencedPaths) {
      pruneCalls += 1;
      return realAssetStore.pruneAssetPaths(candidatePaths, referencedPaths);
    },
  };

  const result = await editUserMessageAndTruncate({
    sessionStore: store,
    attachmentAssetStore,
    turnEventJournal: {
      purgeTurnsAfter() {
        return { ok: false, durable: false, purged: 0, reason: 'disk_failed' };
      },
    },
  }, sessionId, 'msg_user_2', { content: 'must roll back' });

  assert.equal(result, null);
  assert.equal(pruneCalls, 0);
  assert.equal(fs.existsSync(attachment.assetPath), true);
});

test('editUserMessageAndTruncate succeeds and warns when asset pruning fails', async () => {
  const { editUserMessageAndTruncate } = require('../services/backend/backend-session-truncate');
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Asset prune failure' });
  seedConversation(store, sessionId);
  store.updateMessage(sessionId, 'msg_ai_2', {
    attachments: [{
      id: 'audio_failure',
      kind: 'audio',
      displayName: 'Failure.wav',
      mimeType: 'audio/wav',
      assetPath: 'C:\\managed\\failure.wav',
    }],
  });
  const logs = [];

  const result = await editUserMessageAndTruncate({
    sessionStore: store,
    attachmentAssetStore: {
      async pruneAssetPaths() {
        throw new Error('prune_failed');
      },
    },
    _emitServiceLog(level, event, data) { logs.push({ level, event, data }); },
  }, sessionId, 'msg_user_2', { content: 'edited second prompt' });

  assert.ok(result);
  assert.equal(logs.some((entry) => entry.level === 'WARN'
    && entry.event === 'session.truncate_asset_prune_failed'
    && entry.data.reason === 'prune_failed'), true);
});

test('editUserMessageAndTruncate keeps an asset the mirror store still references', async () => {
  const { editUserMessageAndTruncate } = require('../services/backend/backend-session-truncate');
  const { store, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Mirror lag' });
  seedConversation(store, sessionId);
  const attachmentAssetStore = new AttachmentAssetStore({
    rootDir: path.join(userDataPath, 'attachments'),
  });
  const attachment = attachmentAssetStore.saveAudioBufferSync(Buffer.from('mirror-audio'), {
    displayName: 'Mirror.wav',
    mimeType: 'audio/wav',
  });
  store.updateMessage(sessionId, 'msg_ai_2', { attachments: [attachment] });

  // The mirror carries the asset but not the truncation target, so its own
  // truncate refuses (replication lag is a WARN, not a failure). The canonical
  // side drops the message; the mirror still points at the file, so the file
  // must survive.
  const shadowStore = new SessionShadowStore(path.join(userDataPath, 'shadow-mirror-lag.json'));
  shadowStore.upsertSession(sessionId, {
    title: 'Mirror lag',
    messages: [store.getSession(sessionId).messages.at(-1)],
  });

  const result = await editUserMessageAndTruncate({
    sessionStore: store,
    shadowStore,
    attachmentAssetStore,
  }, sessionId, 'msg_user_2', { content: 'edited second prompt' });

  assert.ok(result);
  assert.equal(
    store.getSession(sessionId).messages.some(
      (message) => message.id === 'msg_ai_2'
    ),
    false,
    'canonical dropped the message carrying the asset'
  );
  assert.equal(fs.existsSync(attachment.assetPath), true);
});
