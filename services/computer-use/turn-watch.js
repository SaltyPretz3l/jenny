'use strict';

/* services/computer-use/turn-watch.js: the owner's watch, per turn (row 196).
 *
 * The helper runs one watch for the whole machine (native/jenny-computer/PROTOCOL.md, "The owner's watch").
 * This keeps what the service needs on top of it: whether it is running, and for each chat's turn whether
 * the owner has taken over. A new turn starts unpaused: the owner's message is the hand-back, so the
 * first input action of a turn sends `watch.resume`. A paused turn stays paused until the owner resumes it
 * (resume) or it ends; a Stop is never downgraded. */

const HELPER_TIMEOUT_MS = 5000;
// The Stop chord, sent to the helper so the chord it registers is the one the pill and Settings name.
const STOP_CHORD = 'ctrl+alt+shift+f12';

function createTurnWatch({ now = Date.now } = {}) {
  // sessionId -> { turnId, paused: null | 'owner' | 'stop' }
  const turns = new Map();
  let running = false;
  let registered = null; // the Stop chord, as the last watch.start answered: true, false or null (not started yet)
  let startedAt = null; // when the watch last started: the owner's input before it is not known

  return {
    running: () => running,

    /** When the running watch started (ms), or null. */
    startedAt: () => (running ? startedAt : null),

    /** Whether Windows gave the helper the Stop chord: true, false, or null before the watch first started. */
    registered: () => registered,

    /** Has this chat's turn already started the watch? */
    has(sessionId, turnId) {
      return turns.get(sessionId)?.turnId === turnId;
    },

    /** Start the watch if it is not running, then clear the owner's-input latch for this turn. */
    async begin(host, sessionId, turnId) {
      if (!running) {
        const started = await host.request('watch.start', { stop_chord: STOP_CHORD }, { timeoutMs: HELPER_TIMEOUT_MS });
        running = true;
        startedAt = now();
        if (typeof started?.stop_chord_registered === 'boolean') registered = started.stop_chord_registered;
      }
      // Recorded before the resume answers, so an event during it is not lost.
      turns.set(sessionId, { turnId, paused: null });
      try {
        await host.request('watch.resume', {}, { timeoutMs: HELPER_TIMEOUT_MS });
      } catch (error) {
        turns.delete(sessionId);
        throw error;
      }
    },

    /** 'owner', 'stop' or null. */
    pausedFor(sessionId) {
      return turns.get(sessionId)?.paused || null;
    },

    /** The owner took over. A stop is stronger than a pause and is never downgraded. */
    markPaused(sessionId, kind) {
      const turn = turns.get(sessionId);
      if (turn && turn.paused !== 'stop') turn.paused = kind;
    },

    /** The owner handed back control: clear the helper's latch, then the turn's pause. Only an owner pause resumes. */
    async resume(host, sessionId) {
      const turn = turns.get(sessionId);
      if (!turn || turn.paused !== 'owner') return false;
      await host.request('watch.resume', {}, { timeoutMs: HELPER_TIMEOUT_MS });
      if (turn.paused === 'owner') turn.paused = null; // a Stop during the request wins
      return turn.paused === null;
    },

    /** The helper lost the watch (it restarted, or answered `no_watch`): the next input starts it again. */
    lost(sessionId = null) {
      running = false;
      for (const [id, turn] of [...turns]) {
        if (!turn.paused || id === sessionId) turns.delete(id);
      }
    },

    /** The turn is over. The watch stops with the last holder; `othersHold` says another chat still has the mouse. */
    async end(host, sessionId, { othersHold = false } = {}) {
      turns.delete(sessionId);
      if (!running || othersHold) return;
      running = false;
      if (!host) return;
      try {
        await host.request('watch.stop', {}, { timeoutMs: HELPER_TIMEOUT_MS });
      } catch (_error) { /* a helper that is gone has stopped its watch */ }
    },
  };
}

module.exports = { STOP_CHORD, createTurnWatch };
