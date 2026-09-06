'use strict';

const { joinPath } = require('../store/fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('../store/json-file-io');

const FILE_NAME = 'secret-delivery-grants-v6.json';
const MAX_GRANTS = 256;

class SecretDeliveryGrantStore {
  constructor({ facade, baseDir, now = Date.now, maximum = MAX_GRANTS } = {}) {
    this._facade = facade;
    this._dir = joinPath(baseDir, 'runtime');
    this._now = now;
    this._maximum = maximum;
    this._chain = Promise.resolve();
  }

  _exclusive(operation) {
    const next = this._chain.then(operation, operation);
    this._chain = next.catch(() => {});
    return next;
  }

  async _read() {
    const read = await readJsonFile(this._facade, joinPath(this._dir, FILE_NAME));
    if (read.status === 'missing') return { schema_version: 1, grants: [] };
    if (read.status !== 'ok' || read.value?.schema_version !== 1 || !Array.isArray(read.value.grants)) {
      throw new Error('secret_delivery_grant_store_corrupt');
    }
    return read.value;
  }

  async _write(state) {
    await writeJsonFileAtomic(this._facade, this._dir, FILE_NAME, state);
  }

  prepare(grant) {
    return this._exclusive(async () => {
      const state = await this._read();
      if (state.grants.some((item) => item.grant_id === grant.grant_id)) {
        return { ok: false, reason: 'secret_grant_duplicate' };
      }
      const now = this._now();
      const retained = state.grants.filter((item) => Date.parse(item.expires_at) > now);
      retained.push({ ...grant, spent: false });
      state.grants = retained.slice(-this._maximum);
      await this._write(state);
      return { ok: true, grant_id: grant.grant_id };
    }).catch(() => ({ ok: false, reason: 'secret_grant_store_unavailable' }));
  }

  spend(grantId, binding) {
    return this._exclusive(async () => {
      const state = await this._read();
      const grant = state.grants.find((item) => item.grant_id === grantId);
      if (!grant || grant.spent === true || Date.parse(grant.expires_at) <= this._now()) {
        return { ok: false, reason: 'secret_grant_spent_or_missing' };
      }
      if (grant.session_id !== binding.session_id || grant.session_epoch !== binding.session_epoch
        || grant.active_generation_id !== binding.active_generation_id
        || grant.commit_epoch !== binding.commit_epoch) {
        return { ok: false, reason: 'secret_grant_binding_mismatch' };
      }
      grant.spent = true;
      grant.spent_at = new Date(this._now()).toISOString();
      await this._write(state);
      return { ok: true, grant: Object.freeze({ ...grant }) };
    }).catch(() => ({ ok: false, reason: 'secret_grant_store_unavailable' }));
  }

  revokeSession(sessionId) {
    return this._exclusive(async () => {
      const state = await this._read();
      let changed = false;
      for (const grant of state.grants) {
        if (grant.session_id === sessionId && grant.spent !== true) {
          grant.spent = true;
          grant.spent_at = new Date(this._now()).toISOString();
          changed = true;
        }
      }
      if (changed) await this._write(state);
      return { ok: true, changed };
    }).catch(() => ({ ok: false, reason: 'secret_grant_store_unavailable' }));
  }

  revokeAll() {
    return this._exclusive(async () => {
      const state = await this._read();
      let changed = false;
      for (const grant of state.grants) {
        if (grant.spent === true) continue;
        grant.spent = true;
        grant.spent_at = new Date(this._now()).toISOString();
        changed = true;
      }
      if (changed) await this._write(state);
      return { ok: true, changed };
    }).catch(() => ({ ok: false, reason: 'secret_grant_store_unavailable' }));
  }
}

module.exports = { FILE_NAME, SecretDeliveryGrantStore };
