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
    this._live = new Set();
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

  reserve({ session = {} } = {}) {
    return this._record({ session, result: { cleanup_status: 'launch_reserved' },
      reason: 'host_launch_reserved' }, true);
  }

  record(record = {}) { return this._record(record, false); }

  _record({ session = {}, result = {}, reason = 'termination_unproven' } = {}, live = false) {
    return this._exclusive(async () => {
      const key = JSON.stringify([session.session_id, session.session_epoch]);
      if (!live) this._live.delete(key);
      const state = await this._read();
      if (typeof session.session_id !== 'string' || !session.session_id
        || !Number.isSafeInteger(session.session_epoch) || session.session_epoch < 1) {
        return { ok: false, reason: 'cleanup_receipt_invalid' };
      }
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
      const existingIndex = state.receipts.findIndex((item) => item && typeof item === 'object' && (
        item.session_id === receipt.session_id && item.session_epoch === receipt.session_epoch
      ));
      if (live && existingIndex >= 0) return { ok: false, reason: 'cleanup_receipt_identity_exists' };
      if (existingIndex < 0 && state.receipts.length >= MAX_RECEIPTS) {
        return { ok: false, reason: 'cleanup_receipt_store_capacity' };
      }
      if (existingIndex >= 0) {
        receipt.recorded_at = new Date(this._now()).toISOString();
        state.receipts[existingIndex] = { ...state.receipts[existingIndex],
          ...Object.fromEntries(Object.entries(receipt).filter(([, value]) => value !== undefined)) };
      } else state.receipts.push(receipt);
      await writeJsonFileAtomic(this._facade, this._dir, FILE_NAME, state);
      if (live) this._live.add(key);
      return { ok: true, receipt };
    }).catch(() => ({ ok: false, reason: 'cleanup_receipt_store_unavailable' }));
  }

  list({ includeLive = false } = {}) {
    return this._exclusive(async () => ({ ok: true, receipts: (await this._read()).receipts
      .filter((item) => includeLive || !this._live.has(JSON.stringify([
        item?.session_id, item?.session_epoch,
      ]))) }))
      .catch(() => ({ ok: false, reason: 'cleanup_receipt_store_unavailable', receipts: [] }));
  }

  settle(receipt = {}) {
    return this._exclusive(async () => {
      this._live.delete(JSON.stringify([receipt.session_id, receipt.session_epoch]));
      const state = await this._read();
      state.receipts = state.receipts.filter((item) => !(item && typeof item === 'object' && (
        item.session_id === receipt.session_id && item.session_epoch === receipt.session_epoch
      )));
      await writeJsonFileAtomic(this._facade, this._dir, FILE_NAME, state);
      return { ok: true };
    }).catch(() => ({ ok: false, reason: 'cleanup_receipt_store_unavailable' }));
  }
}

module.exports = { FILE_NAME, MAX_RECEIPTS, FullHostCleanupReceiptStore };
