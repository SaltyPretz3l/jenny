'use strict';

/*
 * display-capture-slot.js — the capture gate's two checks (row 197 S1).
 *
 * Every screen capture used to go through the person's own picker, which made
 * capture safe by accident. The live run view needs a capture without the
 * picker (main chooses the run's window), so:
 *
 *   - isMainFrameCaptureRequest: a getDisplayMedia request is answered only for
 *     the main window's own main frame on the app page. Model-written artifact
 *     and sketch pages live in the same session and must never capture.
 *   - createDisplayCaptureSlot: a capture without the picker happens only
 *     through a slot main arms, for one window source, once, for a couple of
 *     seconds, in answer to the panel's own request. The renderer never names
 *     what is captured: the caller that arms the slot (main) chooses it.
 */

const { trustedMainFrameUrl, MAIN_DOCUMENT_PATH } = require('./ipc-sender-authorization');

const ARM_TTL_MS = 2000;
const WINDOW_SOURCE_ID_RE = /^window:[1-9][0-9]{0,15}:0$/u;

function isWindowSourceId(value) {
  return typeof value === 'string' && WINDOW_SOURCE_ID_RE.test(value);
}

/*
 * True only when Electron's display-media request comes from the main window's
 * main frame and both the frame and the window show the app page. Fails closed
 * on any throw or missing input.
 */
function isMainFrameCaptureRequest({ request, getMainWindow, documentPath = MAIN_DOCUMENT_PATH }) {
  try {
    const frame = request?.frame;
    if (!frame) return false;
    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!mainWindow || mainWindow.isDestroyed?.() === true) return false;
    const contents = mainWindow.webContents;
    if (!contents || contents.isDestroyed?.() === true) return false;
    if (frame !== contents.mainFrame) return false;
    return trustedMainFrameUrl(frame.url, documentPath)
      && trustedMainFrameUrl(contents.getURL?.(), documentPath);
  } catch (_error) {
    return false;
  }
}

/*
 * One armed source at a time. arm() refuses a live slot rather than replacing
 * it, so two arming callers cannot swap each other's window.
 */
function createDisplayCaptureSlot({ ttlMs = ARM_TTL_MS, now = Date.now } = {}) {
  let armed = null; // { sourceId, expiresAt }

  function live() {
    if (armed && now() > armed.expiresAt) armed = null;
    return armed;
  }

  return {
    arm(sourceId) {
      if (!isWindowSourceId(sourceId) || live()) return false;
      armed = { sourceId, expiresAt: now() + ttlMs };
      return true;
    },
    take() {
      const entry = live();
      armed = null;
      return entry ? { sourceId: entry.sourceId } : null;
    },
    isArmed() {
      return live() !== null;
    },
    disarm() {
      armed = null;
    },
  };
}

module.exports = {
  ARM_TTL_MS,
  createDisplayCaptureSlot,
  isMainFrameCaptureRequest,
  isWindowSourceId,
};
