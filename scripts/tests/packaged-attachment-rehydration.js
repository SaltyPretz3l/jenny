'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AttachmentAssetStore } = require('../../services/attachment-asset-store');
const { prepareAttachmentEntries } = require('../../services/attachment-service');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function createFixtureNativeImage() {
  return {
    createFromBuffer(buffer) {
      const valid = Buffer.isBuffer(buffer)
        && buffer.length === PNG_BYTES.length
        && buffer.equals(PNG_BYTES);
      return {
        isEmpty: () => !valid,
        getSize: () => ({ width: valid ? 1 : 0, height: valid ? 1 : 0 }),
      };
    },
  };
}

function writeEvidence(outputPath, evidence) {
  if (!outputPath) return;
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

function runPackagedAttachmentRehydration({ outputPath = '', tempRoot = '' } = {}) {
  const ownsRoot = !tempRoot;
  const rootDir = tempRoot
    ? path.resolve(tempRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-service-rehydrate-'));
  const profileDir = path.join(rootDir, 'profile');
  const importDir = path.join(rootDir, 'service-import');
  const sessionsPath = path.join(profileDir, 'sessions.json');
  const managedRoot = path.join(profileDir, 'attachments');
  fs.mkdirSync(importDir, { recursive: true });

  let firstStore = null;
  let restartedStore = null;
  try {
    const sourcePath = path.join(importDir, 'fixture.png');
    fs.writeFileSync(sourcePath, PNG_BYTES);
    const assetStore = new AttachmentAssetStore({
      rootDir: managedRoot,
      nativeImage: createFixtureNativeImage(),
    });
    const imported = prepareAttachmentEntries([sourcePath], {
      cwd: importDir,
      assetStore,
    });
    if (imported.accepted.length !== 1 || imported.rejected.length !== 0) {
      throw new Error('attachment service import did not produce one managed image attachment');
    }
    const attachment = imported.accepted[0];
    if (!assetStore.isManagedAssetPath(attachment.assetPath)) {
      throw new Error('attachment service import did not move the image into managed storage');
    }
    if (!fs.existsSync(attachment.assetPath)) {
      throw new Error('managed image asset is missing after import');
    }

    firstStore = new ElectronSessionStore(sessionsPath);
    const sessionId = 'session_service_rehydration';
    const created = firstStore.createSessionWithId(sessionId, {
      title: 'Service attachment rehydration',
      preferences: { preferred_model: 'vision-target' },
    });
    if (!created) throw new Error('failed to create the Electron-owned session');
    const appended = firstStore.appendMessage(sessionId, {
      id: 'user_w1a_image',
      role: 'user',
      kind: 'text',
      content: '[Image attached]',
      attachments: [attachment],
    });
    if (!appended) throw new Error('failed to persist the image message');
    firstStore.flush();
    firstStore.dispose();
    firstStore = null;

    // A same-process store reopen must rehydrate from the managed copy, not the original picker path.
    fs.unlinkSync(sourcePath);
    restartedStore = new ElectronSessionStore(sessionsPath);
    const messages = restartedStore.getSessionMessages(sessionId);
    const rehydrated = messages[0]?.attachments?.[0];
    const rehydratedManaged = Boolean(
      rehydrated
      && assetStore.isManagedAssetPath(rehydrated.assetPath)
      && fs.existsSync(rehydrated.assetPath)
    );
    if (messages.length !== 1 || !rehydratedManaged) {
      throw new Error('store reopen did not rehydrate the persisted managed image message');
    }

    const evidence = {
      schema_version: 1,
      gate: 'service_attachment_rehydration',
      status: 'passed',
      attachment_service_import: true,
      image_decoder: 'fixture',
      same_process_store_reopen: true,
      managed_attachment_storage: true,
      source_removed_before_reopen: true,
      session_message_count_after_reopen: messages.length,
      attachment_count_after_reopen: messages[0].attachments.length,
      attachment_exists_after_reopen: true,
      raw_paths_omitted: true,
      prompts_and_model_output_omitted: true,
    };
    writeEvidence(outputPath, evidence);
    return evidence;
  } finally {
    firstStore?.dispose();
    restartedStore?.dispose();
    if (ownsRoot) fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function parseOutputPath(argv) {
  const index = argv.indexOf('--output');
  return index >= 0 ? String(argv[index + 1] || '').trim() : '';
}

if (require.main === module) {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const evidence = runPackagedAttachmentRehydration({ outputPath });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

module.exports = {
  PNG_BYTES,
  runPackagedAttachmentRehydration,
};
