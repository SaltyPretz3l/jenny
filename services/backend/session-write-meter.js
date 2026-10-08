'use strict';

const MAX_TRACKED_SESSIONS = 256;

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function emptyTotals() {
  return { bytes: 0, writes: 0, syncWrites: 0, syncMs: 0, maxSyncMs: 0, serializeMs: 0 };
}

// serializeMs counts every write: a debounced write does its file I/O off the
// main thread, but its JSON.stringify still blocks it.
function addWrite(totals, bytes, ms, sync, serializeMs) {
  totals.bytes += bytes;
  totals.writes += 1;
  totals.serializeMs += serializeMs;
  if (!sync) return;
  totals.syncWrites += 1;
  totals.syncMs += ms;
  if (ms > totals.maxSyncMs) totals.maxSyncMs = ms;
}

function toFields(prefix, totals) {
  return {
    [`${prefix}_bytes`]: totals.bytes,
    [`${prefix}_writes`]: totals.writes,
    [`${prefix}_sync_writes`]: totals.syncWrites,
    [`${prefix}_sync_ms`]: roundMs(totals.syncMs),
    [`${prefix}_max_sync_ms`]: roundMs(totals.maxSyncMs),
    [`${prefix}_serialize_ms`]: roundMs(totals.serializeMs),
  };
}

// Observation-only bridge for FileJsonStore: a missing or throwing callback
// never affects the write that was just measured.
function notifyWriteMeasured(callback, payload, startedAt, serializedAt, sync) {
  if (typeof callback !== 'function') return;
  try {
    callback({
      bytes: Buffer.byteLength(payload, 'utf8'),
      ms: performance.now() - startedAt,
      serializeMs: serializedAt - startedAt,
      sync,
    });
  } catch (callbackError) {
    void callbackError;
  }
}

// In-memory write-volume accounting for the session store. Pure: no fs.
function createSessionWriteMeter({ maxTrackedSessions = MAX_TRACKED_SESSIONS } = {}) {
  const cap = Math.max(1, Math.trunc(Number(maxTrackedSessions)) || MAX_TRACKED_SESSIONS);
  const perSession = new Map();
  let indexSinceTake = emptyTotals();
  const cumulativeSession = emptyTotals();
  const cumulativeIndex = emptyTotals();

  function record(input) {
    if (!input || typeof input !== 'object') return;
    const { kind, sessionId, bytes, ms, sync } = input;
    if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(ms) || ms < 0) return;
    const wasSync = sync === true;
    const serializeMs = Number.isFinite(input.serializeMs) && input.serializeMs > 0 ? input.serializeMs : 0;
    if (kind === 'index') {
      addWrite(indexSinceTake, bytes, ms, wasSync, serializeMs);
      addWrite(cumulativeIndex, bytes, ms, wasSync, serializeMs);
      return;
    }
    if (kind !== 'session' || typeof sessionId !== 'string' || !sessionId) return;
    let entry = perSession.get(sessionId);
    if (!entry) {
      entry = { totals: emptyTotals(), lastBytes: 0 };
      perSession.set(sessionId, entry);
      if (perSession.size > cap) perSession.delete(perSession.keys().next().value);
    }
    addWrite(entry.totals, bytes, ms, wasSync, serializeMs);
    entry.lastBytes = bytes;
    addWrite(cumulativeSession, bytes, ms, wasSync, serializeMs);
  }

  // The session part covers every write of that session since its previous
  // take, so it includes edits between turns and the writes of a turn that was
  // cancelled or failed its commit. Index writes are shared by every session,
  // so the index part is the index writes since the previous take of ANY session.
  function takeTurn(sessionId) {
    const entry = perSession.get(sessionId);
    perSession.delete(sessionId);
    const index = indexSinceTake;
    indexSinceTake = emptyTotals();
    return {
      ...toFields('session', entry ? entry.totals : emptyTotals()),
      ...toFields('index', index),
      last_session_bytes: entry ? entry.lastBytes : 0,
    };
  }

  function snapshot() {
    return {
      ...toFields('session', cumulativeSession),
      ...toFields('index', cumulativeIndex),
    };
  }

  return { record, takeTurn, snapshot };
}

module.exports = { createSessionWriteMeter, notifyWriteMeasured };
