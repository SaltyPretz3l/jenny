'use strict';

/* services/chat-workspace-change-notifier.js - per-session invalidation
 * coalescing for `chatWorkspace.onChanged` (row 59 checkpoint 2). A session's
 * first invalidation after a quiet period is emitted at once; further ones
 * inside the interval collapse into one trailing emit, so a session never emits
 * more than 1000 / intervalMs times per second (default 4). Event-driven: the
 * only timers are one-shot trailing flushes, never a poll.
 */

const DEFAULT_INTERVAL_MS = 250;
const MAX_TRACKED_SESSIONS = 256;

function createChangeNotifier({
  emit,
  getRevision = () => 0,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  if (typeof emit !== 'function') throw new TypeError('createChangeNotifier requires emit');
  const state = new Map(); // sessionId -> { lastEmitAt, timer }
  let disposed = false;

  function revisionOf(sessionId) {
    try {
      const revision = getRevision(sessionId);
      return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
    } catch {
      return 0;
    }
  }

  function send(sessionId) {
    const entry = state.get(sessionId) || { lastEmitAt: 0, timer: null };
    entry.timer = null;
    entry.lastEmitAt = now();
    state.set(sessionId, entry);
    try {
      emit({ schema_version: 1, session_id: sessionId, revision: revisionOf(sessionId) });
    } catch {
      // A throwing bridge (window mid-teardown) must never break the writer.
    }
  }

  function prune() {
    if (state.size <= MAX_TRACKED_SESSIONS) return;
    const cutoff = now() - intervalMs;
    for (const [sessionId, entry] of state) {
      if (!entry.timer && entry.lastEmitAt <= cutoff) state.delete(sessionId);
      if (state.size <= MAX_TRACKED_SESSIONS) break;
    }
  }

  function notify(sessionId) {
    if (disposed || typeof sessionId !== 'string' || !sessionId) return;
    const entry = state.get(sessionId);
    if (entry?.timer) return; // a trailing emit is already pending and will carry the latest revision
    const wait = entry ? entry.lastEmitAt + intervalMs - now() : 0;
    if (wait <= 0) {
      send(sessionId);
      prune();
      return;
    }
    const pending = entry;
    pending.timer = setTimer(() => send(sessionId), wait);
    pending.timer?.unref?.();
  }

  function dispose() {
    disposed = true;
    for (const entry of state.values()) {
      if (entry.timer) clearTimer(entry.timer);
      entry.timer = null;
    }
    state.clear();
  }

  return { notify, dispose };
}

module.exports = { DEFAULT_INTERVAL_MS, createChangeNotifier };
