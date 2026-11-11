'use strict';

/**
 * Waits for a page to go quiet after an action, so the outline the model gets
 * back reflects the result and not the middle of it.
 */

const { isAbort, throwIfAborted, waitForAbortable } = require('../browser-session-input');

// A navigation the action triggers needs a moment to start before isLoading()
// can be trusted.
const INITIAL_WAIT_MS = 150;
const POLL_INTERVAL_MS = 120;
const QUIET_MS = 350;
const CAP_MS = Object.freeze({ action: 3000, navigation: 30000 });
// A carousel or ticker never goes quiet, and must not cost the full navigation
// cap on every step once its page has finished loading.
const QUIET_CAP_AFTER_LOAD_MS = 3000;

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function createSettler({ webContents, reader, sleep = defaultSleep, now = () => performance.now() }) {
  function isLoadingNow() {
    try {
      return webContents.isLoading();
    } catch (_error) {
      // The view went away mid-poll; the cap ends the wait.
      return true;
    }
  }

  async function isQuiet(signal) {
    try {
      const status = await waitForAbortable(reader.call('status'), signal);
      return Number(status?.msSinceMutation) >= QUIET_MS;
    } catch (error) {
      if (isAbort(error)) throw error;
      // The document was replaced mid-poll: the page is still loading.
      return false;
    }
  }

  async function waitForSettle({ mode, signal } = {}) {
    const cap = CAP_MS[mode] || CAP_MS.action;
    const started = now();
    let loadedAt = null;
    throwIfAborted(signal);
    await waitForAbortable(sleep(INITIAL_WAIT_MS), signal);
    for (;;) {
      throwIfAborted(signal);
      const loading = isLoadingNow();
      if (loading) loadedAt = null;
      else loadedAt ??= now();
      if (!loading && await isQuiet(signal)) return { settled: true, reason: 'quiet' };
      const deadline = loadedAt === null ? started + cap : Math.min(started + cap, loadedAt + QUIET_CAP_AFTER_LOAD_MS);
      const remaining = deadline - now();
      if (remaining <= 0) return { settled: false, reason: 'cap' };
      await waitForAbortable(sleep(Math.min(POLL_INTERVAL_MS, remaining)), signal);
    }
  }

  return { waitForSettle };
}

module.exports = { createSettler };
