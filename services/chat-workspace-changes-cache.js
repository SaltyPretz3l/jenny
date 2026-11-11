'use strict';

/* services/chat-workspace-changes-cache.js - the per-session, single-flight,
 * briefly cached Changes read behind ChatWorkspaceService. One instance owns one
 * scope's results (working tree or whole branch), so the two can never serve each
 * other's data. A failed read after an earlier success reports the last good data
 * as `stale` unless the reason says there is no workspace to be stale about.
 * Invalidation marks an in-flight read dirty (its result predates the change and
 * the session is told to read again) or expires a settled one.
 */

const MAX_TRACKED = 64;

function boundedSet(map, key, value, limit = MAX_TRACKED) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

class ChangesCache {
  constructor({ now, freshMs, noStaleReasons, notify, isDisposed = () => false }) {
    this._now = now;
    this._freshMs = freshMs;
    this._noStaleReasons = noStaleReasons;
    this._notify = notify;
    this._isDisposed = isDisposed;
    this._records = new Map(); // sessionId -> { key, at, promise, value, lastAvailable, dirty }
  }

  // `load` is `async () => result`; a throw becomes an unavailable `git_failed`.
  read(sessionId, key, load) {
    const entry = this._records.get(sessionId);
    const nowMs = this._now().getTime();
    if (entry && entry.key === key) {
      if (entry.promise) return entry.promise;
      if (entry.value && nowMs - entry.at < this._freshMs) return Promise.resolve(entry.value);
    }
    const previous = entry && entry.key === key ? entry.lastAvailable : null;
    const record = { key, at: nowMs, promise: null, value: null, lastAvailable: previous };
    const run = (async () => {
      let result;
      try {
        result = await load();
      } catch {
        result = { state: 'unavailable', reason: 'git_failed', sampled_at: this._now().toISOString(), data: null };
      }
      if (result.state === 'available') {
        record.lastAvailable = result;
      } else if (result.state === 'unavailable' && record.lastAvailable && !this._noStaleReasons.has(result.reason)) {
        result = { ...result, state: 'stale', data: record.lastAvailable.data, sampled_at: record.lastAvailable.sampled_at };
      }
      record.value = result;
      // Invalidated while the read ran: the result predates the change, so it is not fresh and the
      // session is told to read again.
      record.at = record.dirty ? 0 : this._now().getTime();
      record.promise = null;
      if (record.dirty && !this._isDisposed()) this._notify(sessionId);
      record.dirty = false;
      return result;
    })();
    record.promise = run;
    boundedSet(this._records, sessionId, record);
    return run;
  }

  expire(sessionId) {
    const entry = this._records.get(sessionId);
    if (!entry) return;
    if (entry.promise) entry.dirty = true;
    else entry.at = 0;
  }

  clear() {
    this._records.clear();
  }
}

module.exports = { ChangesCache, boundedSet };
