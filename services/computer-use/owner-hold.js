'use strict';

/* services/computer-use/owner-hold.js: the wait while the owner has the mouse (row 196, D1 A).
 *
 * A `computer` step that finds the owner paused it stays open here, with the turn's clocks suspended, so the
 * turn is still alive when the owner presses Resume on the pill or in the chat. Stop, the Stop chord, the
 * turn's abort and a long spell (the browser take-over's limit, 30 minutes) end the wait. One wait per chat;
 * timers are injected so this runs on a virtual clock in tests. */

const noop = () => {};
const HOLD_LIMIT_MS = 30 * 60 * 1000;

function createOwnerHold({ limitMs = HOLD_LIMIT_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const waits = new Map(); // sessionId -> finish(ended)

  /** True when this chat's step is waiting; `how` is 'resumed' or 'stopped'. */
  function release(sessionId, how) {
    const finish = waits.get(sessionId);
    if (!finish) return false;
    finish(how);
    return true;
  }

  /** @returns {Promise<{ ended: 'resumed'|'stopped'|'limit'|'cancelled', waitedMs: number }>} */
  async function wait(sessionId, { signal, suspendClocks } = {}) {
    if (waits.has(sessionId)) release(sessionId, 'stopped'); // never two waits for one chat
    const startedAt = now();
    let resumeClocks = noop;
    try { resumeClocks = typeof suspendClocks === 'function' ? (await suspendClocks()) || noop : noop; } catch (_error) { /* the wait still holds */ }
    let timer = null;
    let onAbort = noop;
    let mine = null;
    try {
      const ended = await new Promise((resolve) => {
        mine = resolve;
        waits.set(sessionId, resolve);
        onAbort = () => resolve('cancelled');
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimer(() => resolve('limit'), limitMs);
        timer?.unref?.();
      });
      return { ended, waitedMs: Math.max(0, now() - startedAt) };
    } finally {
      if (waits.get(sessionId) === mine) waits.delete(sessionId);
      if (timer !== null) clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      try { if (typeof resumeClocks === 'function') resumeClocks(); } catch (_error) { /* a clock that cannot resume must not hide the answer */ }
    }
  }

  return { wait, release, isHeld: (sessionId) => waits.has(sessionId) };
}

module.exports = { HOLD_LIMIT_MS, createOwnerHold };
