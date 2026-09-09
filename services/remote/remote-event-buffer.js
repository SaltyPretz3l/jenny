'use strict';

function createEventBuffer({ limits, now } = {}) {
  if (!limits || !Number.isFinite(limits.REPLAY_MAX_BYTES)
    || !Number.isFinite(limits.REPLAY_MAX_MS) || typeof now !== 'function') {
    throw new TypeError('Remote event buffer requires limits and a clock.');
  }
  const entries = [];
  let totalBytes = 0;
  let lastSeq = 0;

  function currentTime() {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError('now must return a finite number');
    return value;
  }

  function evict(at = currentTime()) {
    while (entries.length && (totalBytes > limits.REPLAY_MAX_BYTES
      || at - entries[0].at > limits.REPLAY_MAX_MS)) {
      totalBytes -= entries.shift().bytes;
    }
  }

  function push(event) {
    const seq = event?.event_seq;
    if (!Number.isSafeInteger(seq) || seq <= lastSeq) {
      throw new TypeError('Remote events require increasing event_seq values.');
    }
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    const at = currentTime();
    entries.push({ seq, bytes, at, event: structuredClone(event) });
    totalBytes += bytes;
    lastSeq = seq;
    evict(at);
    return seq;
  }

  function since(seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      return { ok: false, reason: 'resync_required' };
    }
    evict();
    if (seq > lastSeq) return { ok: false, reason: 'resync_required' };
    if (!entries.length) {
      return seq < lastSeq
        ? { ok: false, reason: 'resync_required' }
        : { ok: true, events: [] };
    }
    if (seq < entries[0].seq - 1) return { ok: false, reason: 'resync_required' };
    return {
      ok: true,
      events: entries.filter((entry) => entry.seq > seq)
        .map((entry) => structuredClone(entry.event)),
    };
  }

  function head() {
    return lastSeq;
  }

  function clear() {
    entries.length = 0;
    totalBytes = 0;
    lastSeq = 0;
  }

  return Object.freeze({ push, since, head, clear });
}

module.exports = { createEventBuffer };
