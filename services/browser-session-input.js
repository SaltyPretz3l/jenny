'use strict';

/**
 * Pointer/keyboard operations and capture-frame freshness for
 * BrowserSessionService, plus the abort helpers both share. Each operation
 * receives the service (for its page-script, selector-probe and result
 * helpers) and runs inside the service's session operation, so session
 * locking, idle tracking and abort wiring stay owned by the service.
 */

const {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  MAX_BROWSER_ACTION_TIMEOUT_MS,
  PRESS_KEY_CODES,
  boundedPositiveInt,
  normalizePressKey,
  normalizeSelector,
} = require('./browser-interaction-utils');

// rAF only runs while frame production is held (see holdFrameProduction), so
// the page-side wait keeps a timer fallback and the Node-side await is bounded
// again just above it.
const FRAME_WAIT_PAGE_FALLBACK_MS = 250;
const FRAME_WAIT_NODE_TIMEOUT_MS = 1000;
const FRAME_WAIT_SCRIPT = `new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(true); } };
  setTimeout(finish, ${FRAME_WAIT_PAGE_FALLBACK_MS});
  requestAnimationFrame(() => requestAnimationFrame(finish));
})`;

function abortError() {
  const error = new Error('Browser operation aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

function waitForAbortable(promise, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') {
    return promise;
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function actionTimeoutMs(options) {
  return boundedPositiveInt(
    options.timeout_ms,
    DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
    MAX_BROWSER_ACTION_TIMEOUT_MS
  );
}

function notReadyResult(service, session, probe, extra) {
  return service._browserActionResult(session, probe.status || 'selector_miss', {
    ...extra,
    reason: probe.reason || probe.status || 'selector_not_ready',
  });
}

// sendInputEvent and page scripts travel separate IPC paths, so a later action's
// script could run before the renderer handled earlier keys: `focus #b` after
// `press Enter` on #a sometimes moved focus first and the Enter landed on #b.
// A key press arms a one-shot keyup listener, sends, then waits until the page
// saw the keyup plus one task (so its default action ran). Bounded and best
// effort: a page that cannot be armed or never answers only skips the wait.
const INPUT_ACK_PAGE_FALLBACK_MS = 500;
const INPUT_ACK_NODE_TIMEOUT_MS = 1000;
const INPUT_ACK_ARM_SCRIPT = `(() => {
  window.__jennyInputAck = new Promise((resolve) => {
    window.addEventListener('keyup', () => setTimeout(() => resolve(true), 0), { capture: true, once: true });
  });
  return true;
})()`;
const INPUT_ACK_WAIT_SCRIPT = `Promise.race([
  Promise.resolve(window.__jennyInputAck || false),
  new Promise((resolve) => setTimeout(() => resolve(false), ${INPUT_ACK_PAGE_FALLBACK_MS})),
]).then((seen) => { window.__jennyInputAck = null; return seen === true; })`;

async function pageScriptOrNull(service, session, script, signal) {
  try {
    return await waitForAbortable(service._executePageScript(
      session, script, INPUT_ACK_NODE_TIMEOUT_MS, 'Browser input acknowledgement timed out.'
    ), signal);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}

// keyDown, then char for Enter/Space (button activation and implicit form
// submit run on the keypress), then keyUp; returns once the page handled it.
async function sendKeyPress(service, session, signal, keyCode, { withChar }) {
  const sendInputEvent = session.webContents?.sendInputEvent;
  if (typeof sendInputEvent !== 'function') {
    throw new Error('Browser keyboard input is unavailable.');
  }
  const armed = await pageScriptOrNull(service, session, INPUT_ACK_ARM_SCRIPT, signal);
  throwIfAborted(signal);
  sendInputEvent.call(session.webContents, { type: 'keyDown', keyCode });
  if (withChar) sendInputEvent.call(session.webContents, { type: 'char', keyCode });
  sendInputEvent.call(session.webContents, { type: 'keyUp', keyCode });
  if (armed) await pageScriptOrNull(service, session, INPUT_ACK_WAIT_SCRIPT, signal);
  throwIfAborted(signal);
}

// A never-shown window composites nothing on its own: rAF stays parked and
// capturePage copies whichever surface was last produced, so the PNG can trail
// the DOM by an update. A frame subscription keeps the renderer producing and
// presenting frames until the returned release runs. Best effort: when the
// subscription is unavailable or throws, release is a no-op.
function holdFrameProduction(session) {
  const contents = session.webContents;
  try {
    if (typeof contents?.beginFrameSubscription !== 'function') return () => {};
    contents.beginFrameSubscription(true, () => {});
  } catch (_error) {
    return () => {};
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { contents.endFrameSubscription?.(); } catch (_error) { /* best effort */ }
  };
}

// Best effort: a failure or timeout here never blocks the capture, but an
// abort still propagates.
async function waitForFreshFrame(service, session, signal) {
  try {
    if (typeof session.webContents?.invalidate === 'function') {
      session.webContents.invalidate();
    }
  } catch (_error) { /* best effort */ }
  try {
    await waitForAbortable(
      service._executePageScript(
        session, FRAME_WAIT_SCRIPT, FRAME_WAIT_NODE_TIMEOUT_MS, 'Browser frame wait timed out.'
      ),
      signal
    );
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
  }
  throwIfAborted(signal);
}

async function hoverSelector(service, session, signal, options) {
  const selector = normalizeSelector(options.selector);
  const inspected = await service._inspectSelector(session, selector, actionTimeoutMs(options));
  throwIfAborted(signal);
  if (inspected.status !== 'ready') {
    return notReadyResult(service, session, inspected, { selector });
  }
  const sendInputEvent = session.webContents?.sendInputEvent;
  if (typeof sendInputEvent !== 'function') {
    throw new Error('Browser mouse input is unavailable.');
  }
  const centerX = Number(inspected.rect?.center_x);
  const centerY = Number(inspected.rect?.center_y);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    return service._browserActionResult(session, 'selector_hidden', {
      selector,
      reason: 'selector_has_no_hover_center',
    });
  }
  sendInputEvent.call(session.webContents, { type: 'mouseMove', x: centerX, y: centerY });
  return service._browserActionResult(session, 'hovered', { selector });
}

async function focusSelector(service, session, signal, options) {
  const selector = normalizeSelector(options.selector);
  const focused = await service._focusSelector(session, selector, {
    focusAny: true,
    timeoutMs: actionTimeoutMs(options),
  });
  throwIfAborted(signal);
  if (focused.status !== 'ready') {
    return notReadyResult(service, session, focused, { selector });
  }
  return service._browserActionResult(session, 'focused', { selector });
}

async function pressKey(service, session, signal, options) {
  const key = normalizePressKey(options.key);
  const selector = String(options.selector || '').trim() ? normalizeSelector(options.selector) : '';
  if (typeof session.webContents?.sendInputEvent !== 'function') {
    throw new Error('Browser keyboard input is unavailable.');
  }
  if (selector) {
    const focused = await service._focusSelector(session, selector, {
      focusAny: true,
      timeoutMs: actionTimeoutMs(options),
    });
    throwIfAborted(signal);
    if (focused.status !== 'ready') {
      return notReadyResult(service, session, focused, { selector, key });
    }
  }
  await sendKeyPress(service, session, signal, PRESS_KEY_CODES[key], { withChar: key === 'Enter' || key === 'Space' });
  return service._browserActionResult(session, 'pressed', { selector, key });
}

module.exports = {
  focusSelector,
  holdFrameProduction,
  hoverSelector,
  pressKey,
  sendKeyPress,
  throwIfAborted,
  waitForAbortable,
  waitForFreshFrame,
};
