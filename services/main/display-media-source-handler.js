'use strict';

/*
 * display-media-source-handler.js — bridges Electron's screen-share source
 * picker to the renderer's in-app modal.
 *
 * Out of the box, navigator.mediaDevices.getDisplayMedia() rejects in
 * Electron unless session.setDisplayMediaRequestHandler() is registered to
 * supply a source (Electron has no native OS picker like Chrome). This
 * module installs that handler, lists the available screens/windows via
 * desktopCapturer.getSources(), pushes a serialized (thumbnail-safe) list to
 * the renderer for display in its own picker modal
 * (renderer/features/renderer-attachment-event-utils.js triggers the
 * composer "capture screen" flow), and resolves the pending
 * getDisplayMedia() call once the user picks a source (or cancels, or the
 * request times out).
 *
 * Each in-flight request is tracked by an incrementing requestId so the
 * renderer's async round-trip (main -> renderer picker -> main) can be
 * matched back to the correct Electron callback. Exactly one of
 * {timeout, resolvePick, dispose} ever invokes a given request's callback,
 * and only once — the delete-before-callback ordering in _resolve() is what
 * keeps a timeout racing a late user pick from double-firing.
 *
 * The capture gate (row 197 S1): a request is answered only when
 * isTrustedRequest(request) says it comes from the main window's main frame
 * (fails closed when no check is given), and a capture without the picker
 * happens only through the one-use slot main arms with armWindowCapture()
 * (services/main/display-capture-slot.js). An armed request lists window
 * sources with no thumbnails, so nothing else on the desktop is photographed.
 *
 * Redaction (AGENTS.md §7): window/screen titles (source.name) and
 * thumbnail image bytes are never logged — only counts, requestId, and
 * kind ('screen'/'window').
 */

const { createDisplayCaptureSlot, isWindowSourceId } = require('./display-capture-slot');

const DEFAULT_TIMEOUT_MS = 25000;
const NO_THUMBNAIL = Object.freeze({ width: 0, height: 0 });
const DEFAULT_THUMBNAIL_SIZE = Object.freeze({ width: 192, height: 108 });

function serializeSource(source) {
  const displayId = String(source.display_id || '');
  const kind = displayId ? 'screen' : 'window';

  let thumbnailDataUrl = '';
  const thumbnail = source.thumbnail;
  if (thumbnail && typeof thumbnail.toDataURL === 'function') {
    const isEmpty = typeof thumbnail.isEmpty === 'function' && thumbnail.isEmpty();
    if (!isEmpty) {
      thumbnailDataUrl = thumbnail.toDataURL();
    }
  }

  return {
    id: String(source.id),
    name: String(source.name || ''),
    displayId,
    kind,
    thumbnailDataUrl,
  };
}

/**
 * Create a display-media source handler bound to a desktopCapturer and a
 * pair of renderer-facing push functions.
 *
 * @param {object} options
 * @param {object} options.desktopCapturer                Electron's desktopCapturer module (getSources()).
 * @param {function({requestId:number, sources:object[]}):void} options.sendToRenderer
 *   Push the serialized source list to the renderer's picker modal.
 * @param {function({requestId:number}):void} [options.sendCancel]
 *   Notify the renderer that a request was resolved without it (timeout) so
 *   a stale modal can be dismissed.
 * @param {function(string,string,object=):void} [options.log] Redacted logger.
 * @param {number} [options.timeoutMs] How long to wait for a renderer pick before cancelling.
 * @param {{width:number,height:number}} [options.thumbnailSize] Passed through to getSources().
 * @param {function(object):boolean} [options.isTrustedRequest] True when Electron's request comes
 *   from the main window's main frame; without it every request is refused.
 * @param {object} [options.slot] The one-use capture slot (createDisplayCaptureSlot()).
 * @returns {{installHandler(session):boolean, resolvePick(number,string):boolean,
 *   armWindowCapture(string):{ok:boolean, reason?:string}, dispose():void}}
 */
function createDisplayMediaSourceHandler({
  desktopCapturer,
  sendToRenderer,
  sendCancel = () => {},
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  thumbnailSize = DEFAULT_THUMBNAIL_SIZE,
  isTrustedRequest = null,
  slot = createDisplayCaptureSlot(),
} = {}) {
  const capturer =
    desktopCapturer && typeof desktopCapturer.getSources === 'function' ? desktopCapturer : null;
  const pushToRenderer = typeof sendToRenderer === 'function' ? sendToRenderer : null;
  const pushCancel = typeof sendCancel === 'function' ? sendCancel : () => {};

  let installedSession = null;
  let installationGeneration = 0;
  let nextRequestId = 1;
  const pending = new Map(); // requestId -> { callback, timer, grants }
  let listing = 0; // picker requests still listing sources (not yet in `pending`)

  function _resolve(requestId, sourceId) {
    const entry = pending.get(requestId);
    if (!entry) {
      return false;
    }
    // Atomic: remove the entry and disarm the timer BEFORE invoking the
    // callback, so a timeout racing a late pick (or a double-call) can
    // never fire the Electron callback twice.
    pending.delete(requestId);
    clearTimeout(entry.timer);

    let streams = {};
    if (typeof sourceId === 'string' && entry.grants.has(sourceId)) {
      streams = { video: entry.grants.get(sourceId) };
    }

    try {
      entry.callback(streams);
    } catch (error) {
      log('ERROR', 'display_media.callback_threw', {
        requestId,
        message: error && error.message,
      });
    }
    return true;
  }

  function isTrusted(request) {
    try {
      return typeof isTrustedRequest === 'function' && isTrustedRequest(request) === true;
    } catch (_error) {
      return false;
    }
  }

  // An Electron callback that throws (a session torn down mid-request) must not escape the async handler.
  function answer(callback, streams) {
    try {
      callback(streams);
    } catch (error) {
      log('ERROR', 'display_media.callback_threw', { message: error && error.message });
    }
  }

  // `stillInstalled` says whether the handler that took the slot is still the installed one after the await.
  async function answerArmed(sourceId, callback, stillInstalled) {
    let sources;
    try {
      sources = await capturer.getSources({ types: ['window'], thumbnailSize: NO_THUMBNAIL });
    } catch (error) {
      log('ERROR', 'display_media.get_sources_failed', { message: error && error.message });
      answer(callback, {});
      return;
    }
    if (!stillInstalled()) {
      answer(callback, {});
      return;
    }
    const source = Array.isArray(sources) ? sources.find((entry) => String(entry?.id) === sourceId) : null;
    if (!source) {
      log('WARN', 'display_media.armed_source_missing', {});
      answer(callback, {});
      return;
    }
    log('INFO', 'display_media.armed_capture_granted', {});
    answer(callback, { video: { id: String(source.id), name: String(source.name || '') } });
  }

  function installHandler(session) {
    const targetSession =
      session && typeof session.setDisplayMediaRequestHandler === 'function' ? session : null;
    if (!targetSession || !capturer || !pushToRenderer) {
      return false;
    }

    installationGeneration += 1;
    const installedGeneration = installationGeneration;
    const stillInstalled = () => installedSession === targetSession && installationGeneration === installedGeneration;
    targetSession.setDisplayMediaRequestHandler(async (request, callback) => {
      if (!isTrusted(request)) {
        log('WARN', 'display_media.request_refused', { reason: 'untrusted_frame' });
        answer(callback, {});
        return;
      }
      const armed = slot.take();
      if (armed) {
        await answerArmed(armed.sourceId, callback, stillInstalled);
        return;
      }
      let sources;
      listing += 1; // an arm made while the picker lists its sources is refused as picker_open
      try {
        sources = await capturer.getSources({ types: ['screen', 'window'], thumbnailSize });
      } catch (error) {
        log('ERROR', 'display_media.get_sources_failed', {
          message: error && error.message,
        });
        answer(callback, {});
        return;
      } finally {
        listing -= 1;
      }

      if (!stillInstalled()) {
        answer(callback, {});
        return;
      }

      if (!Array.isArray(sources) || sources.length === 0) {
        log('WARN', 'display_media.no_sources', {});
        answer(callback, {});
        return;
      }

      const requestId = nextRequestId;
      nextRequestId += 1;

      const grants = new Map();
      const serialized = sources.map((source) => {
        grants.set(String(source.id), { id: String(source.id), name: String(source.name || '') });
        return serializeSource(source);
      });

      const timer = setTimeout(() => {
        const resolved = _resolve(requestId, null);
        if (resolved) {
          log('WARN', 'display_media.request_timed_out', { requestId });
          pushCancel({ requestId });
        }
      }, timeoutMs);

      pending.set(requestId, { callback, timer, grants });

      log('INFO', 'display_media.sources_listed', {
        requestId,
        count: serialized.length,
        kinds: serialized.reduce((acc, s) => {
          acc[s.kind] = (acc[s.kind] || 0) + 1;
          return acc;
        }, {}),
      });

      pushToRenderer({ requestId, sources: serialized });
    });

    installedSession = targetSession;
    log('INFO', 'display_media.handler_installed', {});
    return true;
  }

  function resolvePick(requestId, sourceId) {
    const resolved = _resolve(requestId, sourceId);
    if (resolved) {
      log('INFO', 'display_media.request_resolved', {
        requestId,
        granted: typeof sourceId === 'string',
      });
    }
    return resolved;
  }

  // Arm a capture without the picker for one window source. Main chooses the
  // source; the renderer only asks for the run's picture.
  function armWindowCapture(sourceId) {
    if (!installedSession) return { ok: false, reason: 'unavailable' };
    if (!isWindowSourceId(sourceId)) return { ok: false, reason: 'invalid_source' };
    if (pending.size > 0 || listing > 0) return { ok: false, reason: 'picker_open' };
    if (!slot.arm(sourceId)) return { ok: false, reason: 'already_armed' };
    return { ok: true };
  }

  function dispose() {
    installationGeneration += 1;
    slot.disarm();
    if (installedSession && typeof installedSession.setDisplayMediaRequestHandler === 'function') {
      try {
        installedSession.setDisplayMediaRequestHandler(null);
      } catch (error) {
        log('ERROR', 'display_media.dispose_unregister_failed', {
          message: error && error.message,
        });
      }
    }
    installedSession = null;

    for (const requestId of Array.from(pending.keys())) {
      _resolve(requestId, null);
    }

    log('INFO', 'display_media.disposed', {});
  }

  return { installHandler, resolvePick, armWindowCapture, dispose };
}

module.exports = { createDisplayMediaSourceHandler };
