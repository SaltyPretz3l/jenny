/* renderer/shell/renderer-pane-layout-controller.js -- the split-view pane layout state machine (UMD) */
/**
 * The ONLY code that assigns `state.panes` (split view W1-4c).
 *
 * The layout itself is a value (renderer-pane-model.js normalizes it); this is
 * the state machine over it. Two storage modes keep the one-pane app exactly
 * what it was before split view:
 *
 *   - ONE pane: `state.panes` stays the BLANK one-pane layout, which every
 *     reader resolves to `state.currentSessionId` (renderer-pane-visibility-
 *     utils.js). The 21 legacy writers of `currentSessionId` keep meaning "the
 *     session on screen" without routing through here.
 *   - TWO panes: each pane holds its own session and `currentSessionId` is
 *     DERIVED from the focused pane ("the focused pane's session").
 *
 * Every change runs one path, `applyLayout`: normalize, store (frozen),
 * derive `currentSessionId`, persist once through the workspace-state
 * controller's single layout writer (`persistPaneLayout`, which debounces and
 * moves the rail's active tab with the focused pane), then
 * `onLayoutChanged(prev, next)` so the composition mounts, unmounts or
 * refocuses the pane roots. An unchanged layout does none of the three.
 *
 * `syncFocusedPaneFromState()` reconciles the legacy writers while two panes
 * are open: a `currentSessionId` another pane already holds FOCUSES that pane
 * (the rail rule W1-5 persists, `followRail`); any other id is placed in the
 * focused pane. With nothing changed it is a few property reads.
 *
 * `setSplitRatio` is the resizer's per-frame write: it stores the clamped
 * ratio and never persists (the resizer persists once per finished gesture).
 *
 * `placeSession(sessionId, side)` and `swapPanes()` are drag-to-split's
 * operations (W2-1): one `applyLayout` each, so one persist per drop.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-pane-model'), require('../chat/renderer-pane-visibility-utils'));
    return;
  }
  root.rendererPaneLayoutController = factory(root.rendererPaneModel, root.rendererPaneVisibilityUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (defaultPaneModel, paneVisibilityUtils) {
  'use strict';

  const normalizeId = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).normalizeId;

  function toPlain(layout) {
    return {
      panes: layout.panes.map(function copyPane(pane) { return { paneId: pane.paneId, sessionId: pane.sessionId }; }),
      focusedPaneId: layout.focusedPaneId,
      splitRatio: layout.splitRatio,
    };
  }

  function sameLayout(left, right) {
    if (!left || !right || left.panes.length !== right.panes.length) return false;
    if (left.focusedPaneId !== right.focusedPaneId || left.splitRatio !== right.splitRatio) return false;
    for (var index = 0; index < left.panes.length; index += 1) {
      if (left.panes[index].sessionId !== right.panes[index].sessionId) return false;
    }
    return true;
  }

  function createPaneLayoutController(deps) {
    var options = deps || {};
    var state = options.state;
    var paneModel = options.paneModel || defaultPaneModel;
    if (!state || typeof state !== 'object') throw new TypeError('createPaneLayoutController: state is required.');
    if (!paneModel || typeof paneModel.normalizePaneLayout !== 'function') {
      throw new TypeError('createPaneLayoutController: the pane model is required.');
    }
    var getWorkspaceStateController = typeof options.getWorkspaceStateController === 'function'
      ? options.getWorkspaceStateController
      : function () { return null; };
    var onLayoutChanged = typeof options.onLayoutChanged === 'function' ? options.onLayoutChanged : function () {};
    var normalize = paneModel.normalizePaneLayout;

    function storedPanes() {
      var layout = state.panes;
      return layout && Array.isArray(layout.panes) ? layout.panes : [];
    }

    function getPaneCount() {
      return Math.max(1, storedPanes().length);
    }

    function currentRatio() {
      var ratio = state.panes && state.panes.splitRatio;
      return typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : paneModel.DEFAULT_SPLIT_RATIO || 0.5;
    }

    /* The layout as the rest of the app means it: with one pane, pane 0 holds
       currentSessionId (the blank storage is an implementation detail). */
    function getLayout() {
      if (storedPanes().length < 2) {
        return normalize({ panes: [normalizeId(state.currentSessionId)], focusedPaneId: 0, splitRatio: currentRatio() });
      }
      return state.panes;
    }

    function persist(layout) {
      var controller;
      try { controller = getWorkspaceStateController(); } catch (_error) { controller = null; }
      if (controller && typeof controller.persistPaneLayout === 'function') {
        controller.persistPaneLayout(toPlain(layout));
      }
    }

    function store(next) {
      if (next.panes.length < 2) {
        var blank = state.panes;
        var keepBlank = blank && Array.isArray(blank.panes) && blank.panes.length === 1
          && !blank.panes[0].sessionId && blank.splitRatio === next.splitRatio;
        if (!keepBlank) state.panes = normalize({ panes: [''], focusedPaneId: 0, splitRatio: next.splitRatio });
        state.currentSessionId = next.panes[0].sessionId;
        return;
      }
      state.panes = next;
      state.currentSessionId = paneModel.deriveCurrentSessionId(next);
    }

    /**
     * The one layout write. `options.persist === false` skips the workspace
     * write (the per-frame ratio, a boot hydrate the store already holds).
     * @returns the effective layout after the write
     */
    function applyLayout(raw, applyOptions) {
      var prev = getLayout();
      var next = normalize(raw);
      if (sameLayout(prev, next)) return prev;
      store(next);
      var effective = getLayout();
      if (!applyOptions || applyOptions.persist !== false) persist(effective);
      // `reason` tells a listener why: 'reset' (the sign-out reset) or 'rekey'.
      onLayoutChanged(prev, effective, { reason: (applyOptions && applyOptions.reason) || '' });
      return effective;
    }

    function withPanes(sessionIds, focusedPaneId) {
      return { panes: sessionIds, focusedPaneId: focusedPaneId, splitRatio: currentRatio() };
    }

    function sessionIds() {
      return getLayout().panes.map(function readSession(pane) { return pane.sessionId; });
    }

    function isValidPaneId(paneId) {
      return Number.isInteger(paneId) && paneId >= 0 && paneId < getPaneCount();
    }

    function setFocusedPane(paneId) {
      if (!isValidPaneId(paneId) || getPaneCount() < 2) return false;
      if (state.panes.focusedPaneId === paneId) return false;
      applyLayout(withPanes(sessionIds(), paneId));
      return true;
    }

    /* The writer wins: any other pane holding `sessionId` is blanked first,
       because normalizePaneLayout would otherwise strip it from the LATER pane. */
    function setPaneSession(paneId, sessionId) {
      var id = normalizeId(sessionId);
      if (!isValidPaneId(paneId)) return false;
      if (getPaneCount() < 2) {
        state.currentSessionId = id;
        return true;
      }
      var ids = sessionIds().map(function place(existing, index) {
        if (index === paneId) return id;
        return existing === id ? '' : existing;
      });
      applyLayout(withPanes(ids, state.panes.focusedPaneId));
      return true;
    }

    function isSessionInPane(sessionId) {
      var id = normalizeId(sessionId);
      return Boolean(id) && sessionIds().indexOf(id) >= 0;
    }

    function openBeside(sessionId) {
      var id = normalizeId(sessionId);
      if (!id || isSessionInPane(id)) return false;
      if (getPaneCount() < 2) {
        var current = normalizeId(state.currentSessionId);
        applyLayout(withPanes([current, id], current ? 0 : 1));
        return true;
      }
      var focused = state.panes.focusedPaneId;
      var ids = sessionIds().map(function replaceOther(existing, index) { return index === focused ? existing : id; });
      applyLayout(withPanes(ids, focused));
      return true;
    }

    /* Drag-to-split (W2-1). `side` is the pane side: 'left' is pane 0 and
       'right' pane 1 (pane order IS the side; the caller maps a visual RTL
       half onto it). One pane: the dropped session takes that side and the
       one on screen moves to the other, keeping focus unless it was blank.
       Two panes: it replaces that side's session (focus stays put); the
       session the OTHER pane already holds swaps the panes instead. */
    function placeSession(sessionId, side) {
      var id = normalizeId(sessionId);
      if (!id || (side !== 'left' && side !== 'right')) return false;
      var index = side === 'left' ? 0 : 1;
      if (getPaneCount() < 2) {
        var current = normalizeId(state.currentSessionId);
        if (id === current) return false;
        var placed = index === 0 ? [id, current] : [current, id];
        applyLayout(withPanes(placed, current ? 1 - index : index));
        return true;
      }
      var ids = sessionIds();
      if (ids[index] === id) return false;
      if (ids[1 - index] === id) return swapPanes();
      ids[index] = id;
      applyLayout(withPanes(ids, state.panes.focusedPaneId));
      return true;
    }

    /* Two panes only: the sessions trade sides, the ratio stays with the
       sides, and focus follows the session that had it. */
    function swapPanes() {
      if (getPaneCount() < 2) return false;
      var ids = sessionIds();
      applyLayout(withPanes([ids[1], ids[0]], 1 - state.panes.focusedPaneId));
      return true;
    }

    function closePane(paneId) {
      if (!isValidPaneId(paneId) || getPaneCount() < 2) return false;
      var remaining = sessionIds().filter(function keep(_id, index) { return index !== paneId; });
      applyLayout(withPanes([remaining[0] || ''], 0));
      return true;
    }

    /* The rail rule the store applies (a pane shows an open tab only), live:
       after a tab close, a pane still showing a closed tab closes, as the boot
       hydrate closes a stored one. A blank pane is left alone. */
    function closePanesWithoutTab(openSessionIds) {
      if (getPaneCount() < 2 || !Array.isArray(openSessionIds)) return false;
      var open = openSessionIds.map(normalizeId);
      var ids = sessionIds();
      for (var index = ids.length - 1; index >= 0; index -= 1) {
        if (ids[index] && open.indexOf(ids[index]) < 0) return closePane(index);
      }
      return false;
    }

    function getSplitRatio() {
      return currentRatio();
    }

    function setSplitRatio(ratio) {
      var layout = getLayout();
      applyLayout({ panes: sessionIds(), focusedPaneId: layout.focusedPaneId, splitRatio: ratio }, { persist: false });
      return currentRatio();
    }

    function syncFocusedPaneFromState() {
      var panes = storedPanes();
      if (panes.length < 2) return false;
      var current = normalizeId(state.currentSessionId);
      var focused = state.panes.focusedPaneId;
      if (panes[focused] && panes[focused].sessionId === current) return false;
      for (var index = 0; index < panes.length; index += 1) {
        if (current && index !== focused && panes[index].sessionId === current) {
          applyLayout(withPanes(sessionIds(), index));
          return true;
        }
      }
      var ids = sessionIds();
      ids[focused] = current;
      applyLayout(withPanes(ids, focused));
      return true;
    }

    function resetPanes() {
      applyLayout(withPanes([''], 0), { persist: false, reason: 'reset' });
    }

    function rekey(sourceSessionId, targetSessionId) {
      var source = normalizeId(sourceSessionId);
      var target = normalizeId(targetSessionId);
      if (!source || !target || source === target || getPaneCount() < 2) return false;
      var ids = sessionIds();
      if (ids.indexOf(source) < 0) return false;
      // 'rekey': the same chat under its server id (a pane keeps its draft and selection).
      applyLayout(withPanes(ids.map(function swap(id) { return id === source ? target : id; }), state.panes.focusedPaneId), { reason: 'rekey' });
      return true;
    }

    function resolveSession(paneId) {
      if (paneVisibilityUtils && typeof paneVisibilityUtils.resolvePaneSessionId === 'function') {
        return paneVisibilityUtils.resolvePaneSessionId(state, paneId);
      }
      return paneId === 0 ? normalizeId(state.currentSessionId) : '';
    }

    /* The pane-bound W1-4b session context. With one pane, pane 0's context is
       today's default exactly (read currentSessionId, write currentSessionId). */
    function createSessionContext(paneId) {
      if (!Number.isInteger(paneId) || paneId < 0) {
        throw new TypeError('createSessionContext: paneId must be a non-negative integer.');
      }
      function getSessionId() { return resolveSession(paneId); }
      return Object.freeze({
        paneId: paneId,
        getSessionId: getSessionId,
        setSessionId: function setSessionId(id) { setPaneSession(paneId, id); },
        isCurrent: function isCurrent(id) { return getSessionId() === normalizeId(id); },
      });
    }

    return {
      getLayout: getLayout,
      getPaneCount: getPaneCount,
      applyLayout: applyLayout,
      setFocusedPane: setFocusedPane,
      setPaneSession: setPaneSession,
      isSessionInPane: isSessionInPane,
      openBeside: openBeside,
      placeSession: placeSession,
      swapPanes: swapPanes,
      closePane: closePane,
      closePanesWithoutTab: closePanesWithoutTab,
      getSplitRatio: getSplitRatio,
      setSplitRatio: setSplitRatio,
      syncFocusedPaneFromState: syncFocusedPaneFromState,
      resetPanes: resetPanes,
      rekey: rekey,
      createSessionContext: createSessionContext,
    };
  }

  return {
    createPaneLayoutController: createPaneLayoutController,
  };
});
