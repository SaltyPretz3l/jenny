'use strict';

/**
 * The wait while the user has the page (roadmap row 114). A browser step stays open through it, so
 * the turn is still alive when they hand the browser back. Stop ends the wait, and so does a long
 * spell with no input in the page. Timers are injected so this runs on a virtual clock in tests.
 */

const noop = () => {};

function createUserHold({ getLastActiveAt, idleLimitMs, now, setTimer, clearTimer }) {
  let held = null;
  let release = noop;

  function begin() {
    if (held) return;
    held = new Promise((resolve) => { release = resolve; });
  }

  function end() {
    const finish = release;
    held = null;
    release = noop;
    finish();
  }

  /**
   * @returns {Promise<{ended: 'released'|'stopped'|'idle', waitedMs: number}>} `released` covers
   * every way the hold can end from outside: a hand back, a crash and the page closing.
   */
  async function wait({ signal, suspendClocks } = {}) {
    if (!held) return { ended: 'released', waitedMs: 0 };
    const startedAt = now();
    const resumeClocks = typeof suspendClocks === 'function' ? suspendClocks() : noop;
    let timer = null;
    let onAbort = noop;
    try {
      const ended = await new Promise((resolve) => {
        held.then(() => resolve('released'));
        onAbort = () => resolve('stopped');
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        const check = () => {
          const left = idleLimitMs - Math.max(0, now() - getLastActiveAt());
          if (left <= 0) {
            resolve('idle');
            return;
          }
          timer = setTimer(check, left);
          timer?.unref?.();
        };
        check();
      });
      return { ended, waitedMs: Math.max(0, now() - startedAt) };
    } finally {
      if (timer !== null) clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      if (typeof resumeClocks === 'function') resumeClocks();
    }
  }

  return { begin, end, wait };
}

module.exports = { createUserHold };
