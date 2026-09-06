'use strict';

const DEFAULT_LIMIT = 3;
const DEFAULT_WINDOW_MS = 600_000;
const MAX_IDENTITIES = 128;

function identityKey(identity) {
  return `${identity.publisher_id || ''}\0${identity.plugin_id || ''}\0${identity.contribution_id || ''}\0${identity.executable_digest || ''}`;
}

class CrashQuarantineController {
  constructor({ now = Date.now, limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS,
    persist = async () => {}, authorizeRelease = () => ({ ok: true }) } = {}) {
    this._now = now;
    this._limit = limit;
    this._windowMs = windowMs;
    this._persist = persist;
    this._authorizeRelease = authorizeRelease;
    this._entries = new Map();
    this._recordPersistence = Promise.resolve();
  }

  async recordCrash(identity, { expected = false } = {}) {
    if (expected) return { quarantined: false, crash_count: 0 };
    const key = identityKey(identity);
    const now = this._now();
    const previous = this._entries.get(key) || { times: [], quarantined: false };
    const times = previous.times.filter((value) => now - value <= this._windowMs);
    times.push(now);
    const entry = { times, quarantined: times.length >= this._limit };
    this._entries.set(key, entry);
    while (this._entries.size > MAX_IDENTITIES) this._entries.delete(this._entries.keys().next().value);
    const snapshot = this.exportState();
    const persistence = this._recordPersistence.then(() => this._persist(snapshot));
    this._recordPersistence = persistence.catch(() => {});
    await persistence;
    return { quarantined: entry.quarantined, crash_count: times.length };
  }

  isQuarantined(identity) { return this._entries.get(identityKey(identity))?.quarantined === true; }
  async clearAfterVerifiedUpgrade(identity) {
    const authorized = this._authorizeRelease(identity);
    if (!authorized?.ok) return authorized;
    this._entries.delete(identityKey(identity));
    await this._persist(this.exportState());
    return { ok: true };
  }
  hydrate(entries = []) {
    this._entries.clear();
    for (const item of entries.slice(-MAX_IDENTITIES)) {
      if (typeof item?.identity_key === 'string' && Array.isArray(item.times)) {
        this._entries.set(item.identity_key, { times: item.times.filter(Number.isFinite),
          quarantined: item.quarantined === true });
      }
    }
  }
  exportState() {
    return [...this._entries.entries()].map(([key, value]) => ({
      identity_key: key, times: [...value.times], quarantined: value.quarantined,
    }));
  }
  snapshot() {
    return [...this._entries.entries()].map(([key, value]) => ({
      identity_digest: require('node:crypto').createHash('sha256').update(key).digest('hex'),
      crash_count: value.times.length, quarantined: value.quarantined,
    }));
  }
}

module.exports = { DEFAULT_LIMIT, CrashQuarantineController };
