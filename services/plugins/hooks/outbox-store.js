'use strict';

const { joinPath } = require('../store/fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('../store/json-file-io');

const FILE_NAME = 'hook-outbox-v6.json';
const MAX_RECEIPTS = 4096;
const RETENTION_MS = 86_400_000;

class HookOutboxStore {
  constructor({ facade, baseDir, now = Date.now, maximum = MAX_RECEIPTS,
    retentionMs = RETENTION_MS } = {}) {
    this._facade = facade;
    this._dir = joinPath(baseDir, 'runtime');
    this._now = now;
    this._maximum = maximum;
    this._retention = retentionMs;
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
      || !Array.isArray(read.value.receipts)) throw new Error('hook_outbox_corrupt');
    return read.value;
  }

  async _write(state) {
    await writeJsonFileAtomic(this._facade, this._dir, FILE_NAME, state);
  }

  putPending(event) {
    return this._exclusive(async () => {
      const state = await this._read();
      if (state.receipts.some((item) => item.event_id === event.event_id)) {
        return { ok: true, duplicate: true };
      }
      const cutoff = this._now() - this._retention;
      state.receipts = state.receipts.filter((item) => Date.parse(item.updated_at) >= cutoff);
      state.receipts.push({ event_id: event.event_id, event, status: 'pending', attempts: 0,
        updated_at: new Date(this._now()).toISOString() });
      state.receipts = state.receipts.slice(-this._maximum);
      await this._write(state);
      return { ok: true, duplicate: false };
    }).catch(() => ({ ok: false, reason: 'hook_outbox_unavailable' }));
  }

  settle(eventId, status, attempts, reason = '') {
    return this._exclusive(async () => {
      const state = await this._read();
      const receipt = state.receipts.find((item) => item.event_id === eventId);
      if (!receipt) return { ok: false, reason: 'hook_receipt_missing' };
      receipt.status = status;
      receipt.attempts = attempts;
      receipt.reason = String(reason || '').slice(0, 120);
      receipt.updated_at = new Date(this._now()).toISOString();
      await this._write(state);
      return { ok: true };
    }).catch(() => ({ ok: false, reason: 'hook_outbox_unavailable' }));
  }

  settleInterruptedPending() {
    return this._exclusive(async () => {
      const state = await this._read();
      let count = 0;
      for (const receipt of state.receipts) {
        if (receipt.status !== 'pending') continue;
        receipt.status = 'indeterminate';
        receipt.reason = 'hook_delivery_interrupted';
        receipt.updated_at = new Date(this._now()).toISOString();
        count += 1;
      }
      if (count) await this._write(state);
      return { ok: true, settled_count: count };
    }).catch(() => ({ ok: false, reason: 'hook_outbox_unavailable' }));
  }
}

module.exports = { FILE_NAME, HookOutboxStore, MAX_RECEIPTS };
