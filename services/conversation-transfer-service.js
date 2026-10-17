'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { FileJsonStore } = require('./backend/file-json-store');
const { ownedDirectory, decodeAsset, MAX_TOTAL_BYTES } = require('./conversation-transfer-assets');
const { MAX_SNAPSHOT_BYTES, fail, identity, direction, fingerprint, publicReceipt } = require('./conversation-transfer-contract');

// Snapshots written before compact persistence were indented; fingerprint() re-measures them
// compactly. Two-space indentation of an admitted snapshot has been measured at 2.4x the compact
// bytes (many small attachment records), so the pre-read bound is 4x; a legacy file past that is
// treated as unavailable (Astra w2a R1 residual).
const MAX_LEGACY_SNAPSHOT_FILE_BYTES = 4 * MAX_SNAPSHOT_BYTES;

class ConversationTransferService {
  constructor({ adapters, receiptStore, now = Date.now, log = () => {} } = {}) {
    Object.assign(this, { adapters, receiptStore, now, log });
    this.previews = new Map();
    this.inFlight = null;
    this.disposed = false;
  }
  assertOpen() {
    if (this.disposed) fail('disposed', 'Conversation transfer is closed.');
  }
  async list({ source } = {}) {
    this.assertOpen();
    if (!this.adapters[source]) fail('invalid_request', 'Select a transfer source.');
    return { ok: true, conversations: await this.adapters[source].list() };
  }
  savedSnapshot(record) {
    const folder = ownedDirectory(this.receiptStore.root, 'scratch/' + record.id);
    const snapshotFile = path.join(folder, 'snapshot.json');
    const fs = require('node:fs');
    if (!fs.existsSync(snapshotFile) || fs.lstatSync(snapshotFile).isSymbolicLink()
      || fs.statSync(snapshotFile).size > MAX_LEGACY_SNAPSHOT_FILE_BYTES) {
      fail('snapshot_unavailable', 'The saved transfer snapshot is unavailable. No duplicate was created.');
    }
    const loaded = new FileJsonStore(snapshotFile).readWithStatus(null);
    if (loaded.corrupted || loaded.unreadable || !loaded.value
      || fingerprint(loaded.value) !== record.snapshotHash) {
      fail('snapshot_unavailable', 'The saved transfer snapshot is unavailable. No duplicate was created.');
    }
    return loaded.value;
  }
  validateAssets(snapshot) {
    let bytes = 0;
    let count = 0;
    for (const message of snapshot.messages) {
      for (const asset of message.attachments || []) {
        if (!asset.data) continue;
        bytes += decodeAsset(asset).length;
        count += 1;
      }
    }
    if (bytes > MAX_TOTAL_BYTES || count > 256) fail('asset_limit', 'This chat exceeds the attachment transfer limit.');
    return { bytes, count };
  }
  async preview({ source, destination, sourceId, copyAgain = false } = {}) {
    this.assertOpen();
    direction(source, destination);
    identity(source, sourceId);
    this.receiptStore.assertWritable();
    const pending = this.receiptStore.records.findLast((row) => row.source === source && row.sourceId === sourceId
      && row.destination === destination && row.state !== 'completed');
    if (copyAgain && pending) fail('unfinished_transfer', 'Resolve the unfinished copy before copying again.');
    const snapshot = pending ? this.savedSnapshot(pending) : await this.adapters[source].snapshot(sourceId);
    this.assertOpen();
    if (!snapshot.messages.length) fail('empty_source', 'This conversation has no transferable dialogue.');
    const snapshotHash = fingerprint(snapshot);
    const assets = this.validateAssets(snapshot);
    for (const [token, value] of this.previews) if (value.expiresAt < this.now()) this.previews.delete(token);
    if (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value);
    const token = crypto.randomUUID();
    this.previews.set(token, { source, destination, sourceId, snapshot, snapshotHash,
      copyAgain: copyAgain === true, pendingId: pending?.id, expiresAt: this.now() + 300000 });
    const existing = pending || (!copyAgain && this.receiptStore.find(source, sourceId, destination, snapshotHash));
    return { ok: true, previewToken: token, title: snapshot.title,
      sourceWorkspace: snapshot.sourceWorkspace,
      destinationWorkspace: destination === 'jenny' ? 'General project (no project folder granted)'
        : 'New empty transfer workspace in local Codex storage (read-only)',
      messageCount: snapshot.messages.length, attachmentCount: assets.count, attachmentBytes: assets.bytes,
      warnings: [...snapshot.warnings, 'Completed tools become readable text; commands and approvals never replay.',
        'Copied images and files appear in an attachment appendix. Sensitive conversation text is redacted.',
        'Original copied files are available from Open copied attachments. Jenny includes up to 12,000 characters of retained text per file.',
        ...(pending ? ['This resumes the saved snapshot from ' + pending.createdAt + '.'] : [])],
      dialogue: snapshot.messages.map((message) => ({ role: message.role, content: message.content })),
      receipt: existing ? publicReceipt(existing) : null };
  }
  copy({ previewToken } = {}) {
    this.assertOpen();
    if (typeof previewToken !== 'string') fail('invalid_request', 'Preview this conversation before copying.');
    if (this.inFlight) {
      if (this.inFlight.token === previewToken) return this.inFlight.promise;
      fail('transfer_busy', 'Wait for the current copy to finish.');
    }
    const promise = this.performCopy(previewToken).finally(() => { this.inFlight = null; });
    this.inFlight = { token: previewToken, promise };
    return promise;
  }
  async performCopy(token) {
    const preview = this.previews.get(token);
    if (!preview || preview.expiresAt < this.now()) fail('preview_expired', 'Preview this conversation again before copying.');
    const { source, sourceId, destination, snapshot, snapshotHash } = preview;
    let record = preview.pendingId ? this.receiptStore.get(preview.pendingId)
      : !preview.copyAgain && this.receiptStore.find(source, sourceId, destination, snapshotHash);
    if (record?.state === 'completed') {
      if (!await this.adapters[destination].exists(record.destinationId)) {
        fail('destination_missing', 'The previous copy is unavailable. Choose Copy again to create another.');
      }
      return { ok: true, receipt: publicReceipt(record), reused: true };
    }
    if (!record) {
      const fresh = await this.adapters[source].snapshot(sourceId);
      this.assertOpen();
      if (fingerprint(fresh) !== snapshotHash) fail('source_changed', 'The source changed after preview. Preview it again.');
      const id = crypto.randomUUID();
      const folder = ownedDirectory(this.receiptStore.root, 'scratch/' + id);
      // Compact bytes match the fingerprint() admission measurement, so recovery can always reread them.
      const stored = new FileJsonStore(path.join(folder, 'snapshot.json'), { compact: true }).write(snapshot);
      if (stored?.durable !== true) fail('snapshot_write_failed', 'The transfer snapshot could not be saved.');
      record = { id, source, sourceId, destination, snapshotHash, state: 'prepared',
        createdAt: new Date(this.now()).toISOString() };
      this.receiptStore.save(record);
      preview.pendingId = record.id;
    }
    const update = (patch) => {
      this.assertOpen();
      const next = { ...record, ...patch };
      this.receiptStore.save(next);
      Object.assign(record, next);
    };
    const destinationId = await this.adapters[destination].copy(snapshot, record, update);
    this.assertOpen();
    identity(destination, destinationId);
    update({ destinationId, state: 'completed' });
    try { this.receiptStore.cleanup(record.id); } catch (_error) {
      this.log('WARN', 'conversation_transfer.scratch_cleanup_failed', { operationId: record.id });
    }
    this.log('INFO', 'conversation_transfer.completed', { operationId: record.id, source, destination });
    return { ok: true, receipt: publicReceipt(record), reused: false };
  }
  async open({ operationId } = {}) {
    this.assertOpen();
    const receipt = this.receiptStore.get(operationId);
    if (!receipt || receipt.state !== 'completed') fail('invalid_request', 'Complete a copy before opening its destination.');
    if (!await this.adapters[receipt.destination].exists(receipt.destinationId)) {
      fail('destination_missing', 'The copied destination no longer exists.');
    }
    return { ok: true, destination: receipt.destination, destinationId: receipt.destinationId };
  }
  async attachments(request) {
    const result = await this.open(request);
    return { ...result, operationId: request.operationId };
  }
  async dispose() {
    this.disposed = true;
    this.previews.clear();
    await Promise.all(Object.values(this.adapters).map((adapter) => adapter.dispose?.()));
    await this.inFlight?.promise.catch(() => {});
  }
}
module.exports = { ConversationTransferService };
