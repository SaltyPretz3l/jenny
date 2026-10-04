/* renderer/chat/renderer-side-panel-owner.js
 * Which conversation the side panel (artifact review or context panel; they
 * share one column) shows. Split view W3-2, owner decision 2026-09-26 "C":
 * one panel that stays with the chat that opened it.
 *
 * One pane: the panel shows `state.currentSessionId`, exactly as before split
 * view; no owner is stored. Two panes: `state.ui.sidePanelOwnerSessionId`
 * names the owning session and focus alone never changes it. An explicit open
 * (an artifact chip, the panel toggle, the context panel) claims the focused
 * session; the layout reconcile keeps the owner across focus moves and swaps,
 * follows the owning PANE when its session is replaced (a rail tab switch or a
 * drop onto that pane), and asks the caller to collapse the panel when the
 * owning pane closes.
 *
 * The owner is a session id, not a pane id, so a swap (sessions trade sides)
 * keeps the panel on the chat the reader was looking at.
 *
 * Pure: no DOM, no timers. Layouts are the pane model's value
 * ({ panes: [{ paneId, sessionId }], focusedPaneId, splitRatio }) as the
 * layout controller's `getLayout()` returns them; with one pane that is
 * `{ panes: [currentSessionId] }`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSidePanelOwner = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function sessionsOf(layout) {
    var panes = layout && Array.isArray(layout.panes) ? layout.panes : [];
    return panes.map(function readSession(pane) { return normalizeId(pane && pane.sessionId); });
  }

  function isSplit(state) {
    return sessionsOf(state && state.panes).length >= 2;
  }

  function ensureUi(state) {
    if (!state.ui || typeof state.ui !== 'object') state.ui = {};
    return state.ui;
  }

  function readOwner(state) {
    return normalizeId(state && state.ui && state.ui.sidePanelOwnerSessionId);
  }

  function writeOwner(state, sessionId) {
    ensureUi(state).sidePanelOwnerSessionId = normalizeId(sessionId);
  }

  function focusedSessionId(state) {
    return normalizeId(state && state.currentSessionId);
  }

  function isHeld(layout, sessionId) {
    return Boolean(sessionId) && sessionsOf(layout).indexOf(sessionId) >= 0;
  }

  /** The session the side panel shows. */
  function resolvePanelSessionId(state) {
    if (!isSplit(state)) return focusedSessionId(state);
    var owner = readOwner(state);
    return isHeld(state.panes, owner) ? owner : focusedSessionId(state);
  }

  /** An explicit open from `sessionId`'s pane. No-op with one pane. */
  function claimPanelOwner(state, sessionId) {
    var id = normalizeId(sessionId);
    if (!isSplit(state) || !isHeld(state.panes, id)) return false;
    if (readOwner(state) === id) return false;
    writeOwner(state, id);
    return true;
  }

  /**
   * Keep the owner consistent with a layout change. Call with the layout
   * controller's `prev` and `next` after `state` holds `next`.
   * @returns {'none' | 'collapse'} 'collapse' when the owning pane closed
   */
  function reconcilePanelOwner(state, prev, next) {
    var before = sessionsOf(prev);
    var after = sessionsOf(next);
    var owner = readOwner(state);
    if (after.length < 2) {
      if (owner) writeOwner(state, '');
      var remaining = after[0] || '';
      return before.length >= 2 && owner && remaining !== owner ? 'collapse' : 'none';
    }
    if (before.length < 2) {
      var onScreen = before[0] || '';
      writeOwner(state, isHeld(next, onScreen) ? onScreen : focusedSessionId(state));
      return 'none';
    }
    if (!owner) {
      writeOwner(state, focusedSessionId(state));
      return 'none';
    }
    if (isHeld(next, owner)) return 'none';
    // Both sessions replaced at once (a workspace or root switch): no pane
    // followed the owner, so the panel collapses instead of adopting a chat
    // nobody opened it from.
    if (!before.some(function (id) { return id && isHeld(next, id); })) {
      writeOwner(state, '');
      return 'collapse';
    }
    var index = before.indexOf(owner);
    var successor = index >= 0 ? (after[index] || '') : '';
    writeOwner(state, successor);
    return successor ? 'none' : 'collapse';
  }

  /**
   * The session auto-open evaluates: the owner's while the panel is visible,
   * the focused chat's while it is hidden. After a successful auto-open with
   * two panes, claim this session.
   */
  function resolveAutoOpenSessionId(state, panelVisible) {
    return panelVisible ? resolvePanelSessionId(state) : focusedSessionId(state);
  }

  return {
    resolvePanelSessionId: resolvePanelSessionId,
    claimPanelOwner: claimPanelOwner,
    reconcilePanelOwner: reconcilePanelOwner,
    resolveAutoOpenSessionId: resolveAutoOpenSessionId,
  };
});
