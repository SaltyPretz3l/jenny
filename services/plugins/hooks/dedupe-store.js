'use strict';

class HookDedupeStore {
  constructor({ now = Date.now, maximum = 4096, ttlMs = 86_400_000 } = {}) {
    this._now = now;
    this._maximum = maximum;
    this._ttlMs = ttlMs;
    this._ids = new Map();
  }

  seen(id) {
    const now = this._now();
    for (const [key, recorded] of this._ids) if (now - recorded > this._ttlMs) this._ids.delete(key);
    return this._ids.has(id);
  }

  record(id) {
    this._ids.set(id, this._now());
    while (this._ids.size > this._maximum) this._ids.delete(this._ids.keys().next().value);
  }
}

module.exports = { HookDedupeStore };
