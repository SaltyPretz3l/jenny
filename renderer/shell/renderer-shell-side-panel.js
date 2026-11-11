/* renderer/shell/renderer-shell-side-panel.js - the shell side panel's owner resolution.
 *
 * Split out of renderer-shell-artifact-bridge.js (which builds one per bridge and hands `sidePanel` to the
 * artifact surface and rails): which chat the single side panel shows (split view), the panel claim, the
 * jump target and the owner line.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellSidePanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const jt = (globalRef.jennyI18n && globalRef.jennyI18n.t) || globalRef.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function createShellSidePanel(deps) {
    const { state, windowRef, sidePanelOwner, getActiveSession, getSubagentRailController } = deps;

    // Split view W3-2 (spec W3_SPEC_2026-09-26 §3): the one
    // side panel (artifact review, or the context panel sharing its column)
    // shows the session renderer-side-panel-owner.js resolves: with two panes
    // the chat that opened it, whichever pane has focus. With one pane every
    // answer here is exactly the pre-split one (the focused session), and the
    // owner line is never inserted.
    function isSplitLayout() {
      return Boolean(sidePanelOwner) && (Array.isArray(state.panes?.panes) ? state.panes.panes.length : 0) > 1;
    }
    function findSession(sessionId) {
      return (Array.isArray(state.sessions) ? state.sessions : []).find((session) => session?.id === sessionId) || null;
    }
    function getPanelSession() {
      return isSplitLayout() ? findSession(sidePanelOwner.resolvePanelSessionId(state)) : getActiveSession();
    }
    // The owner line names the chat the way its pane kicker does (the summary
    // title, else "New session"). Rebuilt only when the owner, its title or
    // the line's presence changes; `mode` is the artifact rail mode, or
    // 'context' for the context panel. Code review and file preview are
    // workspace-level, so they carry no line.
    const ownerLineKeys = new WeakMap();
    function syncOwnerLine(panelEl, mode) {
      if (!panelEl || typeof panelEl.querySelector !== 'function') return;
      // The Subagent Monitor's record ends with its mode, its panel or its session (renderer-subagent-rail.js).
      if (mode !== 'context' && mode !== 'activity') getSubagentRailController()?.handleLayoutSync?.(mode, !panelEl.classList?.contains('hidden'));
      // Changes (code_review) and Activity name their owner in one-pane view too (row 59 checkpoint 2).
      const named = mode === 'code_review' || mode === 'activity' || (isSplitLayout() && (mode === 'artifact' || mode === 'context' || mode === 'subagents' || mode === 'browser'));
      const sessionId = Boolean(sidePanelOwner) && named ? sidePanelOwner.resolvePanelSessionId(state) : '';
      const title = sessionId
        ? String(findSession(sessionId)?.title || '').trim() || jt('chat.empty.newSession', 'New session')
        : '';
      const key = sessionId ? `${sessionId}\n${title}` : '';
      const previous = ownerLineKeys.get(panelEl) || '';
      if (!key && !previous) return; // nothing inserted, nothing to read (one pane lands here)
      let line = panelEl.querySelector(':scope > .side-panel-owner-line');
      if (key === previous && line) return;
      ownerLineKeys.set(panelEl, key);
      if (!key) {
        line?.remove();
        return;
      }
      const documentRef = panelEl.ownerDocument;
      if (!line) {
        line = documentRef.createElement('p');
        line.className = 'side-panel-owner-line';
        panelEl.prepend(line);
      }
      // The localized template is split around {title} so the title alone
      // sits in the ellipsizing span, wherever a language places it.
      const [before = '', after = ''] = String(jt('artifacts.panel.fromChat', 'From {title}')).split('{title}');
      const titleEl = documentRef.createElement('span');
      titleEl.className = 'side-panel-owner-title';
      titleEl.setAttribute('dir', 'auto'); // an English title keeps LTR inside RTL chrome
      titleEl.textContent = title;
      titleEl.title = title;
      line.replaceChildren(...[before.trim(), titleEl, after.trim()].filter(Boolean));
    }
    // An explicit open presents the panel for its chat, so auto-open must not
    // present it again on the next render and swap the artifact just chosen
    // for the newest (a second pane's chat was never auto-presented: the hook
    // only runs for the chat the panel shows). Same FIFO as the auto-open.
    function markPresented(sessionId) {
      const id = String(sessionId || '').trim();
      const presented = state.artifacts?.autoOpenedSessionIds;
      if (!id || !Array.isArray(presented) || presented.includes(id)) return;
      state.artifacts.autoOpenedSessionIds = presented.concat(id).slice(-50);
    }
    const sidePanel = {
      getSessionId: () => (isSplitLayout() ? sidePanelOwner.resolvePanelSessionId(state) : state.currentSessionId),
      // No argument: an explicit open from the focused pane (a pointerdown or
      // focusin in a pane focuses it before its click runs). With one: the
      // session an auto-open presented. A no-op with one pane.
      claim: (sessionId) => {
        if (!isSplitLayout()) return false;
        if (sessionId !== undefined) return sidePanelOwner.claimPanelOwner(state, sessionId);
        markPresented(state.currentSessionId);
        return sidePanelOwner.claimPanelOwner(state, state.currentSessionId);
      },
      getAutoOpenSessionId: (panelVisible) => (isSplitLayout()
        ? sidePanelOwner.resolveAutoOpenSessionId(state, panelVisible)
        : String((typeof getActiveSession === 'function' ? getActiveSession()?.id : '') || '').trim()),
      syncOwnerLine,
      // "Jump to chat" (artifact and code review) scrolls the pane showing the
      // panel's chat; null = pane 0's own timeline (always with one pane).
      getJumpTarget: () => (isSplitLayout()
        ? (windowRef?.rendererAppPaneComposition || globalRef.rendererAppPaneComposition)?.getPaneComposition?.()
          ?.getSessionPaneTarget?.(sidePanelOwner.resolvePanelSessionId(state)) || null
        : null),
    };

    return { sidePanel, getPanelSession };
  }

  return { createShellSidePanel };
});
