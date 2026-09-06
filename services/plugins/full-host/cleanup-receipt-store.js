'use strict';

const { joinPath } = require('../store/fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('../store/json-file-io');

const FILE_NAME = 'full-host-cleanup-v6.json';
const MAX_RECEIPTS = 256;

class FullHostCleanupReceiptStore {
  constructor({ facade, baseDir, now = Date.now } = {}) {
    this._facade = facade;
    this._dir = joinPath(baseDir, 'runtime');
    this._now = now;
    this._chain = Promise.resolve();
  }

  _exclusive(operation) {
    const next = this._chain.then(operation, operation);
    this._chain = next.catch(() => {});
    return next;
  }

  async _read() {
    const read = await readJsonFile(this._facade, joinPath(this._dir, FILE_NAME));
    if (read.status === 'missing') return { schema_version: 1, receipts: [] };
    if (read.status !== 'ok' || read.value?.schema_version !== 1
      || !Array.isArray(read.value.receipts)) throw new Error('cleanup_receipt_store_corrupt');
    return read.value;
  }

  record({ session = {}, result = {}, reason = 'termination_unproven' } = {}) {
    return this._exclusive(async () => {
      const state = await this._read();
      const receipt = {
        session_id: session.session_id,
        session_epoch: session.session_epoch,
        active_generation_id: session.authority?.active_generation_id,
        commit_epoch: session.authority?.commit_epoch,
        publisher_id: session.publisher_id,
        plugin_id: session.plugin_id,
        contribution_id: session.contribution_id,
        reason: String(reason).slice(0, 64),
        cleanup_status: result.cleanup_status || 'termination_failed',
        recorded_at: new Date(this._now()).toISOString(),
      };
      state.receipts = state.receipts.filter((item) => !(
        item.session_id === receipt.session_id && item.session_epoch === receipt.session_epoch
      ));
      state.receipts.push(receipt);
      state.receipts = state.receipts.slice(-MAX_RECEIPTS);
      await writeJsonFileAtomic(this._facade, this._dir, FILE_NAME, state);
      return { ok: true, receipt };
    }).catch(() => ({ ok: false, reason: 'cleanup_receipt_store_unavailable' }));
  }

  list() {
    return this._exclusive(async () => ({ ok: true, receipts: (await this._read()).receipts }))
      .catch(() => ({ ok: false, reason: 'cleanup_receipt_store_unavailable', receipts: [] }));
  }

  settle(receipt = {}) {
    return this._exclusive(async () => {
      const state = await this._read();
      state.receipts = state.receipts.filter((item) => !(
        item.session_id === receipt.session_id && item.session_epoch === receipt.session_epoch
      ));
      await writeJsonFileAtomic(this._facade, this._dir, FILE_NAME, state);
      return { ok: true };
    }).catch(() => ({ ok: false, reason: 'cleanup_receipt_store_unavailable' }));
  }
}

module.exports = { FILE_NAME, MAX_RECEIPTS, FullHostCleanupReceiptStore };
