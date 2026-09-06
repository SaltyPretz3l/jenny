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
 * Redaction (AGENTS.md §7): window/screen titles (source.name) and
 * thumbnail image bytes are never logged — only counts, requestId, and
 * kind ('screen'/'window').
 */

const DEFAULT_TIMEOUT_MS = 25000;
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
 * @returns {{installHandler(session):boolean, resolvePick(number,string):boolean, dispose():void}}
 */
function createDisplayMediaSourceHandler({
  desktopCapturer,
  sendToRenderer,
  sendCancel = () => {},
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  thumbnailSize = DEFAULT_THUMBNAIL_SIZE,
} = {}) {
  const capturer =
    desktopCapturer && typeof desktopCapturer.getSources === 'function' ? desktopCapturer : null;
  const pushToRenderer = typeof sendToRenderer === 'function' ? sendToRenderer : null;
  const pushCancel = typeof sendCancel === 'function' ? sendCancel : () => {};

  let installedSession = null;
  let installationGeneration = 0;
  let nextRequestId = 1;
  const pending = new Map(); // requestId -> { callback, timer, grants }

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

  function installHandler(session) {
    const targetSession =
      session && typeof session.setDisplayMediaRequestHandler === 'function' ? session : null;
    if (!targetSession || !capturer || !pushToRenderer) {
      return false;
    }

    installationGeneration += 1;
    const installedGeneration = installationGeneration;
    targetSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      let sources;
      try {
        sources = await capturer.getSources({ types: ['screen', 'window'], thumbnailSize });
      } catch (error) {
        log('ERROR', 'display_media.get_sources_failed', {
          message: error && error.message,
        });
        callback({});
        return;
      }

      if (installedSession !== targetSession || installationGeneration !== installedGeneration) {
        callback({});
        return;
      }

      if (!Array.isArray(sources) || sources.length === 0) {
        log('WARN', 'display_media.no_sources', {});
        callback({});
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

  function dispose() {
    installationGeneration += 1;
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

  return { installHandler, resolvePick, dispose };
}

module.exports = { createDisplayMediaSourceHandler };
