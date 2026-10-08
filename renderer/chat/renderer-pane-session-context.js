/* renderer/chat/renderer-pane-session-context.js
 * The pane session context: which conversation a pane-bound chat surface
 * (its shell controller, composer flow and send path) acts on. Split view
 * W1-4b.
 *
 *   { paneId, getSessionId(), setSessionId(id), isCurrent(id) }
 *
 * The chat shell controller builds one context and hands the SAME object to
 * every sub-controller, which reads its session through `getSessionId()`,
 * compares through `isCurrent(id)` and writes through `setSessionId(id)`
 * instead of touching `state.currentSessionId`. `state.currentSessionId` keeps
 * meaning "the FOCUSED pane's session"; only a writer that owns focus (the
 * pane-0 default here, or W1-4c's pane-bound context) may move it.
 *
 * The default built here is the one-pane app, unchanged: the read is
 * `resolvePaneSessionId(state, paneId)` (renderer-pane-visibility-utils.js),
 * which with a blank layout -- every runtime today -- is
 * `String(state.currentSessionId || '').trim()` for pane 0; the pane-0 write
 * is `state.currentSessionId = String(id || '').trim()`. A non-zero `paneId`
 * reads that pane's own entry but has NO writer: placing an id in pane N goes
 * through the pane layout (normalizePaneLayout + re-deriving currentSessionId),
 * which is W1-4c's pane-bound context, so the default for pane N ignores a
 * write rather than overwrite the focused pane's mirror.
 *
 * Until W1-4c adds this module's <script> tag to index.html, the browser has
 * no `rendererPaneSessionContext` global; the shell controller then builds the
 * same default inline and passes it down, so nothing below the shell needs
 * the global. Pure: no DOM, no timers, reads `state` only when asked.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-pane-visibility-utils'));
    return;
  }
  root.rendererPaneSessionContext = factory(root.rendererPaneVisibilityUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (paneVisibilityUtils) {
  'use strict';

  const normalizeId = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).normalizeId;

  function resolvePaneId(paneId) {
    if (paneId === undefined || paneId === null) return 0;
    if (!Number.isInteger(paneId) || paneId < 0) {
      throw new TypeError('createPaneSessionContext: paneId must be a non-negative integer.');
    }
    return paneId;
  }

  /**
   * The default context for pane `paneId` (0 when omitted) over `state`.
   * @returns {{ paneId: number, getSessionId: () => string, setSessionId: (id: unknown) => void, isCurrent: (id: unknown) => boolean }}
   */
  function createPaneSessionContext(options) {
    var state = options && options.state;
    var paneId = resolvePaneId(options && options.paneId);
    function getSessionId() {
      var utils = paneVisibilityUtils || globalThis.rendererPaneVisibilityUtils;
      if (utils && typeof utils.resolvePaneSessionId === 'function') return utils.resolvePaneSessionId(state, paneId);
      return paneId === 0 ? normalizeId(state && state.currentSessionId) : '';
    }
    function setSessionId(id) {
      if (paneId === 0) state.currentSessionId = normalizeId(id);
    }
    function isCurrent(id) {
      return getSessionId() === normalizeId(id);
    }
    return Object.freeze({
      paneId: paneId,
      getSessionId: getSessionId,
      setSessionId: setSessionId,
      isCurrent: isCurrent,
    });
  }

  return {
    createPaneSessionContext: createPaneSessionContext,
  };
});
