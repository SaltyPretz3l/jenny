/* renderer/chat/renderer-pane-visibility-utils.js
 * "Is this session on screen?", asked per pane (split view).
 *
 * This composes, and never re-implements, the answer that already exists:
 * `isChatSurfaceLive(state)` (renderer-chat-surface-live-utils.js) decides
 * whether a chat surface is showing AT ALL; the pane layout in `state.panes`
 * (the frozen value renderer/shell/renderer-pane-model.js produces) decides
 * WHICH conversation each pane is showing. A session is visible when some
 * pane holds it and the surface is live -- which, with one pane, is exactly
 * what the stream handler's old `isCurrentSession(sessionId) &&
 * isChatSurfaceLive(state)` returned.
 *
 * The fallback carries the whole one-pane guarantee. W0-2 seeds `state.panes`
 * but does NOT move the writers of `state.currentSessionId`, so at runtime the
 * seeded layout stays blank while `currentSessionId` moves. A layout holding
 * no session therefore means "ask currentSessionId", not "nothing is visible"
 * -- the same rule the retained set in renderer-render-pipeline-projection-
 * cache.js uses. A state with no `panes` field at all (every pre-W0-2 fixture)
 * takes the same path.
 *
 * Blank ids: the fallback branch compares them, not guards them, because the
 * expression this replaces matched a blank id against a blank current session
 * and an invisible refactor does not get to tighten that. The pane branch, a
 * NEW answer, does guard: a blank pane holds nothing, so a payload with no
 * session id is never "visible" just because a pane is empty.
 *
 * This runs on the per-delta path (queueSessionRender and the live-event
 * handlers ask it for every payload), so it reads the layout in place and
 * allocates nothing. Pure state -> boolean; no DOM, no mutation, no global
 * beyond the export.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-surface-live-utils'));
    return;
  }
  root.rendererPaneVisibilityUtils = factory(root.rendererChatSurfaceLiveUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatSurfaceLiveUtils) {
  'use strict';

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function isChatSurfaceLive(state) {
    return (chatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state)
      ?? (state?.ui?.activeView === 'chat');
  }

  function paneSessionId(pane) {
    return normalizeId(pane && pane.sessionId);
  }

  /* The pane array when at least one pane holds a session, else null (ask
   * currentSessionId). Blank entries stay in place so pane ids keep meaning. */
  function panesInUse(state) {
    var layout = state && state.panes;
    var panes = layout && Array.isArray(layout.panes) ? layout.panes : null;
    if (!panes) return null;
    for (var index = 0; index < panes.length; index += 1) {
      if (paneSessionId(panes[index])) return panes;
    }
    return null;
  }

  /**
   * Is `sessionId` the conversation pane `paneId` is showing, on a live surface?
   * @returns {boolean}
   */
  function isSessionVisibleInPane(state, sessionId, paneId) {
    if (!Number.isInteger(paneId) || paneId < 0) return false;
    var wanted = normalizeId(sessionId);
    var panes = panesInUse(state);
    if (!panes) {
      return paneId === 0
        && wanted === normalizeId(state && state.currentSessionId)
        && isChatSurfaceLive(state);
    }
    if (!wanted || paneId >= panes.length) return false;
    return paneSessionId(panes[paneId]) === wanted && isChatSurfaceLive(state);
  }

  /**
   * Is `sessionId` showing in ANY pane? This is the render gate the stream
   * handler hands to its DI submodules; with one pane it is the old predicate.
   * @returns {boolean}
   */
  function isSessionVisibleInAnyPane(state, sessionId) {
    var wanted = normalizeId(sessionId);
    var panes = panesInUse(state);
    if (!panes) {
      return wanted === normalizeId(state && state.currentSessionId) && isChatSurfaceLive(state);
    }
    if (!wanted) return false;
    for (var index = 0; index < panes.length; index += 1) {
      if (paneSessionId(panes[index]) === wanted) return isChatSurfaceLive(state);
    }
    return false;
  }

  return {
    isSessionVisibleInPane: isSessionVisibleInPane,
    isSessionVisibleInAnyPane: isSessionVisibleInAnyPane,
  };
});
