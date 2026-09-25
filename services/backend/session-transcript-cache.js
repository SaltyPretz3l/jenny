'use strict';

const MAX_TRANSCRIPT_CACHE_BYTES = 64 * 1024 * 1024;
const OMIT = Symbol('omit');

function stringJsonBytes(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function jsonBytes(value, cache, active, { arrayItem = false } = {}) {
  if (value === null) return 4;
  if (typeof value === 'string') return stringJsonBytes(value);
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') {
    return Buffer.byteLength(Number.isFinite(value) ? JSON.stringify(value) : 'null');
  }
  if (typeof value === 'bigint') throw new TypeError('transcript_cache_bigint_unsupported');
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return arrayItem ? 4 : OMIT;
  }
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  if (active.has(value)) throw new TypeError('transcript_cache_cycle');
  active.add(value);
  let bytes = 2;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) bytes += 1;
      bytes += jsonBytes(value[index], cache, active, { arrayItem: true });
    }
  } else {
    let included = 0;
    for (const key of Object.keys(value)) {
      const childBytes = jsonBytes(value[key], cache, active);
      if (childBytes === OMIT) continue;
      if (included > 0) bytes += 1;
      bytes += stringJsonBytes(key) + 1 + childBytes;
      included += 1;
    }
  }
  active.delete(value);
  cache.set(value, bytes);
  return bytes;
}

function measureTranscriptBytes(value) {
  return jsonBytes(value, new WeakMap(), new WeakSet());
}

class TranscriptCacheAccounting {
  constructor(limitBytes = MAX_TRANSCRIPT_CACHE_BYTES) {
    this.limitBytes = limitBytes;
    this.entries = new Map();
    this.accountedBytes = 0;
  }

  measure(sessionId, value) {
    this.remove(sessionId);
    const bytes = measureTranscriptBytes(value);
    this.entries.set(sessionId, { value, bytes });
    this.accountedBytes += bytes;
    return bytes;
  }

  invalidate(sessionId, value) {
    this.remove(sessionId);
    this.entries.set(sessionId, { value, bytes: null });
  }

  remove(sessionId) {
    const previous = this.entries.get(sessionId);
    if (previous?.bytes != null) this.accountedBytes -= previous.bytes;
    this.entries.delete(sessionId);
  }

  synchronize(sessions, isProtected) {
    for (const sessionId of this.entries.keys()) {
      if (!sessions.has(sessionId)) this.remove(sessionId);
    }
    for (const [sessionId, value] of sessions) {
      const previous = this.entries.get(sessionId);
      const protectedEntry = isProtected(sessionId);
      if (!previous || previous.value !== value) {
        if (protectedEntry) this.invalidate(sessionId, value);
        else this.measure(sessionId, value);
      } else if (previous.bytes == null && !protectedEntry) {
        this.measure(sessionId, value);
      }
    }
  }

  snapshot(isProtected) {
    let protectedBytes = 0;
    let unknownSessions = 0;
    for (const [sessionId, entry] of this.entries) {
      if (entry.bytes == null) unknownSessions += 1;
      else if (isProtected(sessionId)) protectedBytes += entry.bytes;
    }
    const loadedBytes = unknownSessions > 0 ? null : this.accountedBytes;
    const overLimitBytes = loadedBytes == null
      ? null
      : Math.max(0, loadedBytes - this.limitBytes);
    return Object.freeze({
      limitBytes: this.limitBytes,
      loadedSessions: this.entries.size,
      loadedBytes,
      accountedBytes: this.accountedBytes,
      cleanBytes: Math.max(0, this.accountedBytes - protectedBytes),
      protectedBytes,
      unknownSessions,
      overLimitBytes,
      backpressured: unknownSessions > 0 || overLimitBytes > 0,
    });
  }
}

module.exports = {
  MAX_TRANSCRIPT_CACHE_BYTES,
  TranscriptCacheAccounting,
  measureTranscriptBytes,
};
