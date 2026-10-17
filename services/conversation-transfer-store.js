'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FileJsonStore } = require('./backend/file-json-store');
const { removeTreeSync } = require('./fs-remove-no-follow');
const { UUID, fail, identity, direction } = require('./conversation-transfer-contract');

class ConversationTransferStore {
  constructor(root) {
    this.root = root;
    this.file = new FileJsonStore(path.join(root, 'receipts.json'));
    const receiptPath = path.join(root, 'receipts.json');
    if (fs.existsSync(receiptPath) && (fs.lstatSync(receiptPath).isSymbolicLink() || fs.statSync(receiptPath).size > 1000000)) {
      this.blocked = true; this.records = []; return;
    }
    const loaded = this.file.readWithStatus({ version: 1, records: [] });
    this.blocked = loaded.corrupted || loaded.unreadable || loaded.value?.version !== 1
      || !Array.isArray(loaded.value?.records) || loaded.value.records.length > 200
      || loaded.value.records.some((row) => !UUID.test(row?.id || '')
        || !['prepared', 'importing', 'imported', 'completed'].includes(row.state));
    this.records = this.blocked ? [] : loaded.value.records;
    try {
      for (const row of this.records) {
        identity(row.source, row.sourceId); direction(row.source, row.destination);
        if (row.destinationId) identity(row.destination, row.destinationId);
        if (!/^[a-f0-9]{64}$/.test(row.snapshotHash) || typeof row.createdAt !== 'string'
          || row.createdAt.length > 40 || (row.importId && !UUID.test(row.importId))) throw new Error('receipt');
      }
    } catch (_error) { this.blocked = true; this.records = []; }
  }
  assertWritable() {
    if (this.blocked) fail('receipt_store_unavailable', 'Transfer receipts are unreadable. Restore them before copying again.');
  }
  get(id) {
    this.assertWritable();
    return this.records.find((record) => record.id === id) || null;
  }
  save(record) {
    this.assertWritable();
    const records = this.records.filter((row) => row.id !== record.id);
    if (records.length >= 200) {
      const index = records.findIndex((row) => row.state === 'completed');
      if (index < 0) fail('receipt_limit', 'Resolve unfinished transfers before starting another.');
      records.splice(index, 1);
    }
    records.push(structuredClone(record));
    const result = this.file.write({ version: 1, records });
    if (result?.durable !== true) fail('receipt_write_failed', 'The transfer receipt could not be saved.');
    this.records = records;
  }
  find(source, sourceId, destination, snapshotHash) {
    this.assertWritable();
    return this.records.findLast((row) => row.source === source && row.sourceId === sourceId
      && row.destination === destination && row.snapshotHash === snapshotHash);
  }
  scratch(id) {
    if (!UUID.test(id)) fail('invalid_request', 'Invalid transfer operation.');
    return path.join(this.root, 'scratch', id);
  }
  cleanup(id) {
    const target = this.scratch(id);
    if (!fs.existsSync(target)) return;
    const root = fs.realpathSync(this.root);
    const actual = fs.realpathSync(target);
    if (!actual.startsWith(root + path.sep) || fs.lstatSync(target).isSymbolicLink()) {
      fail('unsafe_asset_path', 'The transfer scratch folder was redirected.');
    }
    removeTreeSync(target);
  }
}
module.exports = { ConversationTransferStore };
