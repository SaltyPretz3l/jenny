'use strict';

// Explicit native compatibility check; synthetic chats, isolated Codex/Jenny homes.
// No credentials, inference, direct rollout reads/writes or real history mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { AttachmentAssetStore } = require('../../services/attachment-asset-store');
const { ConversationTransferStore } = require('../../services/conversation-transfer-store');
const { ConversationTransferService } = require('../../services/conversation-transfer-service');
const { JennyConversationAdapter } = require('../../services/jenny-conversation-adapter');
const { CodexConversationAdapter } = require('../../services/codex-conversation-adapter');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-transfer-native-'));
  const sourceDir = path.join(root, 'source');
  const destinationDir = path.join(root, 'destination');
  const codexHome = path.join(root, 'codex');
  const sessions = new ElectronSessionStore(path.join(sourceDir, 'sessions.json'));
  const assetStore = new AttachmentAssetStore({ rootDir: path.join(sourceDir, 'media') });
  const receipts = new ConversationTransferStore(path.join(root, 'receipts'));
  const codex = new CodexConversationAdapter({ codexHome, receiptStore: receipts,
    env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude') } });
  const jenny = new JennyConversationAdapter({ sessionStore: sessions, attachmentAssetStore: assetStore });
  const service = new ConversationTransferService({ adapters: { jenny, codex }, receiptStore: receipts });
  let importedStore;
  let reverse;
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
    const image = assetStore.saveImageBufferSync(png, { mimeType: 'image/png', displayName: 'source.png' });
    const source = sessions.createSession({ title: 'Native transfer fixture' });
    sessions.appendMessage(source.id, { role: 'user', content: 'Keep this history and image.', attachments: [{ ...image, kind: 'image', displayName: 'source.png' }] });
    sessions.appendMessage(source.id, { role: 'assistant', content: 'Completed answer.' });
    sessions.appendMessage(source.id, { role: 'tool', content: 'Completed tool output.' });
    const preview = await service.preview({ source: 'jenny', destination: 'codex', sourceId: source.id });
    assert.equal(preview.attachmentCount, 1);
    const copied = await service.copy({ previewToken: preview.previewToken });
    assert.equal(copied.receipt.state, 'completed');
    console.log('native Jenny -> Codex import completed');
    const listed = await codex.list();
    assert.ok(listed.some((row) => row.id === copied.receipt.destinationId));
    const snapshot = await codex.snapshot(copied.receipt.destinationId);
    assert.ok(snapshot.messages.some((message) => message.attachments.some((asset) => asset.kind === 'image')));
    assert.ok(snapshot.messages.some((message) => message.content.includes('Completed tool output.')));
    console.log('native new-process list/read preserves text, tool text and destination-owned image');
    sessions.dispose();
    fs.rmSync(sourceDir, { recursive: true, force: true });
    assert.ok((await codex.snapshot(copied.receipt.destinationId)).messages.some((row) => row.attachments.length));
    console.log('source removal does not affect Codex assets');
    importedStore = new ElectronSessionStore(path.join(destinationDir, 'sessions.json'));
    const importedAssets = new AttachmentAssetStore({ rootDir: path.join(destinationDir, 'media') });
    reverse = new ConversationTransferService({ receiptStore: new ConversationTransferStore(path.join(root, 'reverse-receipts')),
      adapters: { codex, jenny: new JennyConversationAdapter({ sessionStore: importedStore, attachmentAssetStore: importedAssets,
        transferAssetRoot: path.join(destinationDir, 'transfer-assets') }) } });
    const reversePreview = await reverse.preview({ source: 'codex', destination: 'jenny', sourceId: copied.receipt.destinationId });
    const reverseCopy = await reverse.copy({ previewToken: reversePreview.previewToken });
    const imported = importedStore.getSession(reverseCopy.receipt.destinationId);
    const importedImage = imported.messages.flatMap((message) => message.attachments || []).find((asset) => asset.kind === 'image');
    assert.deepEqual(fs.readFileSync(importedImage.assetPath), png);
    assert.equal(imported.project_id, 'project_general');
    importedStore.dispose();
    fs.rmSync(codexHome, { recursive: true, force: true });
    importedStore = new ElectronSessionStore(path.join(destinationDir, 'sessions.json'));
    assert.deepEqual(fs.readFileSync(importedStore.getSession(reverseCopy.receipt.destinationId).messages
      .flatMap((message) => message.attachments || []).find((asset) => asset.kind === 'image').assetPath), png);
    console.log('native Codex -> canonical Jenny import survives restart and Codex asset removal');
  } finally {
    await service.dispose();
    await reverse?.dispose();
    sessions.dispose();
    importedStore?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.reason || error.message); process.exitCode = 1; });
