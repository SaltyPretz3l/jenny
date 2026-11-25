/**
 * renderer/features/renderer-artifact-review-rail.js
 *
 * The artifact-review rail's state machine (UMD), split out of the artifact
 * manager (renderer-artifacts-utils.js): the persisted preferences, the
 * visibility sync, open / close / toggle across the rail modes (artifact,
 * tasks, code_review, file_preview, subagents), the per-chat wrap, focus
 * hand-off, the auto-open wiring and the session-switch rules. The panel's
 * place and size belong to the right stack of the room on screen
 * (`getLayoutHost`): the rail only tells it what to show. The manager keeps
 * selection and rendering and hands in the few hooks the rail needs (`manager`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-artifact-review-prefs'), require('./renderer-artifact-review-autoopen'));
    return;
  }
  root.rendererArtifactReviewRail = factory(root.rendererArtifactReviewPrefs, root.rendererArtifactReviewAutoopen);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (artifactReviewPrefs, artifactReviewAutoopenModule) {
  'use strict';

  function createArtifactReviewRail(deps) {
    const { state, dom = {}, callbacks = {}, manager = {} } = deps || {};
    const { chatView, artifactSplitViewToggle, artifactReviewPanel, artifactReviewCollapseButton } = dom;
    const {
      getActiveSession, setActiveView, updateComposerSafeOffset, renderAll, appendClientLog,
      // When this app run began (the shell bridge records it at boot; the
      // manager itself is built lazily): auto-open presents only artifacts
      // produced since, never a chat's history after a restart (D-2).
      getRunStartedAt = null,
      resetFilePreview = null,
      panelV2 = null,
      sidePanel = null, // split view W3-2 panel owner (shell artifact bridge); absent: the focused session
      getLayoutHost = null, // the right stack of the room on screen (renderer-chat-right-stack.js): it owns the panel's place and size; null presents nothing
    } = callbacks;
    const {
      getArtifactsForSession = () => [],
      ensureSelectionForArtifacts = () => null,
      selectNewestArtifact = () => '',
      renderArtifactReviewPanel = () => {},
      getExistingEditor = () => null,
    } = manager;
    const {
      ARTIFACT_REVIEW_STORAGE_KEY, normalizeArtifactReviewMode, normalizeArtifactReviewPreferences,
      recordArtifactReviewDismissed, resolveArtifactReviewDismissed,
      resolveArtifactReviewTextWrap, setArtifactReviewTextWrap, pruneArtifactReviewSessionPreferences,
      rekeyArtifactReviewSessionPreferences,
    } = artifactReviewPrefs;
    const runStartedAt = Number(getRunStartedAt?.()) || Date.now();
    let stateLoaded = false;
    let autoOpenController = null;
    let bound = false;
    // Session id last seen by beginRender: a switch invalidates the file-preview
    // rail (it was opened from another conversation).
    let lastRenderedSessionId = '';
    let reviewReturnFocus = null;

    // ── prefs ──
    function loadArtifactReviewPreferences() {
      return artifactReviewPrefs.loadArtifactReviewPreferences(typeof window !== 'undefined' ? window : null, ARTIFACT_REVIEW_STORAGE_KEY);
    }
    function ensureArtifactReviewState() {
      const existing = state.ui?.artifactReview && typeof state.ui.artifactReview === 'object'
        ? state.ui.artifactReview
        : {};
      if (!stateLoaded) {
        state.ui.artifactReview = normalizeArtifactReviewPreferences({
          ...existing,
          ...loadArtifactReviewPreferences(),
        });
        stateLoaded = true;
        return state.ui.artifactReview;
      }
      state.ui.artifactReview = normalizeArtifactReviewPreferences(existing);
      return state.ui.artifactReview;
    }
    function getArtifactReviewState() { return ensureArtifactReviewState(); }
    function saveArtifactReviewPreferences() {
      artifactReviewPrefs.saveArtifactReviewPreferences(typeof window !== 'undefined' ? window : null, ARTIFACT_REVIEW_STORAGE_KEY, ensureArtifactReviewState());
    }
    function setArtifactRailMode(nextMode) {
      const prefs = ensureArtifactReviewState();
      prefs.mode = normalizeArtifactReviewMode(nextMode);
      return prefs.mode;
    }
    function pruneSessionPreferences(allowedSessionIds) {
      const prefs = ensureArtifactReviewState();
      pruneArtifactReviewSessionPreferences?.(prefs, allowedSessionIds);
      saveArtifactReviewPreferences();
    }
    // A draft chat that gets its real id keeps its rail state: the per-chat
    // Close, its spent presentation, and the render bookkeeping (a rekey is
    // not a session switch).
    function rekeySession(fromSessionId, toSessionId) {
      const from = String(fromSessionId || '').trim();
      const to = String(toSessionId || '').trim();
      if (!from || !to || from === to) return;
      const prefs = ensureArtifactReviewState();
      rekeyArtifactReviewSessionPreferences(prefs, from, to);
      saveArtifactReviewPreferences();
      const presented = state.artifacts?.autoOpenedSessionIds;
      if (Array.isArray(presented) && presented.includes(from)) {
        state.artifacts.autoOpenedSessionIds = presented.filter((id) => id !== from && id !== to).concat(to);
      }
      if (lastRenderedSessionId === from) lastRenderedSessionId = to;
    }

    // ── focus ──
    function rememberReviewFocus() {
      const active = artifactReviewPanel?.ownerDocument?.activeElement;
      if (active && active !== active.ownerDocument?.body && !artifactReviewPanel?.contains(active)) reviewReturnFocus = active;
    }
    // Opening focuses the title, never Close, so a quick Enter or Space cannot dismiss it.
    function focusReview() {
      const title = artifactReviewPanel?.querySelector?.('#artifactReviewDetailTitle');
      (title || artifactReviewCollapseButton)?.focus?.({ preventScroll: true });
    }
    function restoreReviewFocus() {
      // Split view: with no remembered target a focused pane 1 keeps focus (pane 0's toggle would take it).
      const paneOne = artifactReviewPanel?.ownerDocument?.querySelector?.('.chat-pane[data-pane-focused="true"]:not([data-pane-id="0"])');
      const target = reviewReturnFocus?.isConnected ? reviewReturnFocus : (paneOne?.querySelector('[data-chat-node="chatInput"]') || artifactSplitViewToggle);
      target?.focus?.({ preventScroll: true });
      reviewReturnFocus = null;
    }

    // ── visibility and layout ──
    function getActiveSessionIdForReview() { return String((typeof getActiveSession === 'function' ? getActiveSession()?.id : '') || '').trim(); }
    function isArtifactReviewEligible() {
      // No artifacts>0 clause (owner call 2026-07-05): an enabled panel with
      // zero artifacts shows its empty state instead of silently hiding;
      // auto-open keeps its own artifact-count gate.
      // No width clause: the stack places the panel whatever the window width.
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      return (state.ui?.activeView === 'chat' || roomServes(state.ui?.artifactReview?.mode)) && Boolean(activeSession); // row 190 W4: or the room on screen has the mode's view
    }
    function roomServes(mode) { return getLayoutHost?.()?.serves?.(normalizeArtifactReviewMode(mode)) === true; }
    function isArtifactReviewVisible() {
      return getArtifactReviewState().enabled === true && isArtifactReviewEligible();
    }
    // Pressed only while the rail shows artifacts; other modes own their state.
    function syncSplitViewToggle(visible, mode) {
      if (!artifactSplitViewToggle) return;
      const artifactsShowing = visible && mode === 'artifact';
      artifactSplitViewToggle.setAttribute('aria-pressed', artifactsShowing ? 'true' : 'false');
      artifactSplitViewToggle.classList.toggle('active', artifactsShowing);
    }
    function park() {
      artifactReviewPanel?.classList?.toggle('hidden', true);
      chatView?.classList?.remove('artifact-review-mode', 'code-review-open');
    }
    // The rail keeps mode and open state; the room's right stack places the panel and sets its classes.
    // `options.animate` marks an explicit open or close (a click, an open verb, auto-open): the stack adds an
    // optional tab only for those. Without a host (before the room is built) nothing is presented.
    function syncArtifactReviewLayout(options = {}) {
      const host = getLayoutHost?.() || null;
      const mode = normalizeArtifactReviewMode(getArtifactReviewState().mode);
      const visible = isArtifactReviewVisible();
      sidePanel?.syncOwnerLine?.(artifactReviewPanel, mode);
      syncSplitViewToggle(visible, mode);
      if (host) host.present({ visible, mode, panel: artifactReviewPanel, chatView, explicit: options.animate === true });
      else park(); // no room stack on screen: nothing shows the panel
      updateComposerSafeOffset?.();
      if (options.refreshChatChrome) renderAll?.();
    }

    // ── wrap ──
    // One persisted wrap state per body kind ('output' | 'code' | 'diff'), never carried by
    // the body: the panel class flips text bodies, Monaco flips through its API.
    function applyArtifactTextWrap(kind) {
      const wrapped = resolveArtifactReviewTextWrap(getArtifactReviewState(), kind);
      artifactReviewPanel?.classList?.toggle('artifact-panel-nowrap', !wrapped);
      if (kind === 'code') getExistingEditor('split')?.setWordWrap?.(wrapped);
      return wrapped;
    }
    function toggleArtifactTextWrap(kind) {
      const prefs = getArtifactReviewState();
      setArtifactReviewTextWrap(prefs, kind, !resolveArtifactReviewTextWrap(prefs, kind));
      saveArtifactReviewPreferences();
      return applyArtifactTextWrap(kind);
    }

    // ── close and open ──
    // The one closed state (D1). `dismiss` (the user's Close) records the per-chat
    // dismissal auto-open respects, and only in artifact mode: closing Tasks etc.
    // never touches it, but spends the chat's presentation instead, so the next
    // render cannot reopen the rail on Artifacts under the user (D-1).
    function closeArtifactReview(options = {}) {
      const sessionId = getActiveSessionIdForReview();
      const prefs = getArtifactReviewState();
      prefs.enabled = false;
      if (options.dismiss === true) {
        if (normalizeArtifactReviewMode(prefs.mode) === 'artifact') recordArtifactReviewDismissed(prefs, sessionId, true);
        else ensureArtifactReviewAutoOpen()?.markPresented?.(sessionId);
      }
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ refreshChatChrome: true, animate: options.animate !== false });
    }
    // W3-2 owner-pane close: no dismissal, so auto-open still works later. A layout
    // reconcile, not a click, so it is not an explicit close.
    function collapseArtifactReview() { closeArtifactReview({ dismiss: false, animate: false }); }

    // An explicit artifact open (every verb since the studio left, W1-5):
    // artifact mode, open, this chat's Close forgotten. Eligibility requires
    // a room that serves the mode, so opens elsewhere switch to chat first.
    function enableForArtifactOpen(sessionId) {
      const prefs = getArtifactReviewState();
      prefs.mode = 'artifact';
      prefs.enabled = true;
      recordArtifactReviewDismissed(prefs, sessionId, false);
      if (state.ui?.activeView !== 'chat' && !roomServes(prefs.mode)) setActiveView('chat');
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ animate: true });
    }

    // Shared open path for the non-artifact rail modes: everything an artifact
    // open does EXCEPT selecting an artifact. Callers (the file preview owner
    // today) hand it a mode; eligibility still requires a room that serves it.
    function openArtifactRail(mode, options) {
      rememberReviewFocus();
      if (sidePanel) { sidePanel.claim(); lastRenderedSessionId = String(sidePanel.getSessionId() || '').trim(); } // a claim is not a session switch
      const sessionId = getActiveSessionIdForReview();
      const prefs = getArtifactReviewState();
      prefs.mode = normalizeArtifactReviewMode(mode);
      prefs.enabled = true;
      // Only an artifact open clears this chat's artifact dismissal.
      if (prefs.mode === 'artifact') recordArtifactReviewDismissed(prefs, sessionId, false);
      if (state.ui?.activeView !== 'chat' && !roomServes(prefs.mode)) setActiveView('chat');
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ animate: true });
      if (options?.focus !== false) focusReview(); // an automatic open must not take the keyboard from the composer
      return prefs.mode;
    }

    // The Subagent Monitor's close puts back the mode and open state it displaced.
    function restoreArtifactReviewPrefs(patch) {
      const prefs = getArtifactReviewState();
      Object.assign(prefs, { mode: normalizeArtifactReviewMode(patch?.mode), enabled: patch?.enabled === true });
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ refreshChatChrome: true, animate: true });
      renderArtifactReviewPanel();
    }

    // Explicit artifact open: clears this chat's dismissal, selects an artifact if none is.
    // options.focus === false: an open no click asked for here (a workbench tab, a saved layout) leaves focus alone.
    function openArtifactsMode(options) {
      sidePanel?.claim();
      const sessionId = getActiveSessionIdForReview();
      const prefs = getArtifactReviewState();
      prefs.mode = 'artifact';
      prefs.enabled = true;
      recordArtifactReviewDismissed(prefs, sessionId, false);
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      if (activeSession) {
        const artifacts = getArtifactsForSession(activeSession.id);
        if (artifacts.length) ensureSelectionForArtifacts(artifacts);
      }
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ refreshChatChrome: true, animate: true });
      renderArtifactReviewPanel();
      if (options?.focus !== false && isArtifactReviewVisible()) focusReview();
    }

    // Generic toggle (the Tasks toggle's close path, the bridge's primer)
    // closes whatever rail mode shows (a dismissal only for artifacts). The
    // strip's Artifacts toggle passes artifactsOnly: from Tasks / code review /
    // file preview it switches to artifacts instead of closing that mode.
    function toggleArtifactReview(options) {
      rememberReviewFocus();
      const artifactsShowing = normalizeArtifactReviewMode(getArtifactReviewState().mode) === 'artifact';
      if (!isArtifactReviewVisible() || (options?.artifactsOnly === true && !artifactsShowing)) return openArtifactsMode(options);
      closeArtifactReview({ dismiss: true });
      restoreReviewFocus();
    }
    function handleArtifactsToggleClick() { toggleArtifactReview({ artifactsOnly: true }); }

    // ── auto-open and the per-render session rules ──
    // W3-2: the owner's chat while the panel shows, else the focused one. Reads the prefs without normalizing:
    // maybeAutoOpen calls this after capturing them, and a getArtifactReviewState() here would detach its copy.
    function getAutoOpenSessionId() { const review = state.ui?.artifactReview; return sidePanel ? sidePanel.getAutoOpenSessionId(review?.enabled === true && isArtifactReviewEligible()) : getActiveSessionIdForReview(); }
    function ensureArtifactReviewAutoOpen() {
      if (autoOpenController || typeof artifactReviewAutoopenModule?.createArtifactReviewAutoOpen !== 'function') {
        return autoOpenController;
      }
      autoOpenController = artifactReviewAutoopenModule.createArtifactReviewAutoOpen({
        isAutoOpenEnabled: () => state.ui?.appearance?.artifactAutoOpen === true,
        getActiveSessionId: getAutoOpenSessionId,
        getArtifactReviewState,
        saveArtifactReviewPreferences,
        isArtifactReviewEligible,
        getArtifacts: () => getArtifactsForSession(getAutoOpenSessionId()),
        runStartedAt,
        onAutoOpened: (sessionId) => sidePanel?.claim(sessionId),
        getAutoOpenedSessionIds: () => (Array.isArray(state.artifacts.autoOpenedSessionIds) ? state.artifacts.autoOpenedSessionIds : []),
        setAutoOpenedSessionIds: (ids) => { state.artifacts.autoOpenedSessionIds = Array.isArray(ids) ? ids : []; },
        selectNewestArtifact: () => selectNewestArtifact(getAutoOpenSessionId()),
        appendClientLog: (...args) => appendClientLog?.(...args),
      });
      return autoOpenController;
    }

    // The rail's share of a render pass: the session-switch rules, the
    // auto-open, then the layout sync. Returns whether the panel shows.
    function beginRender() {
      // A session switch closes the file-preview rail: the preview belongs to
      // the conversation it was opened from, and surviving into an unrelated
      // session reads as a stuck panel (owner report 2026-08-20). First render
      // (no prior session) never resets; code_review keeps its own semantics.
      const renderSessionId = String((sidePanel ? sidePanel.getSessionId() : state.currentSessionId) || '').trim();
      const sessionSwitched = renderSessionId !== lastRenderedSessionId;
      if (sessionSwitched) {
        const hadSession = lastRenderedSessionId !== '';
        lastRenderedSessionId = renderSessionId;
        if (hadSession && normalizeArtifactReviewMode(getArtifactReviewState().mode) === 'file_preview') {
          getArtifactReviewState().mode = 'artifact';
          if (typeof resetFilePreview === 'function') resetFilePreview();
        }
        // The browser panel shows one chat's page: leaving closes the column and the page waits off screen.
        if (hadSession && normalizeArtifactReviewMode(getArtifactReviewState().mode) === 'browser') {
          Object.assign(getArtifactReviewState(), { mode: 'artifact', enabled: false });
          saveArtifactReviewPreferences();
        }
        // X-1: the artifact rail another chat left open does not undo this
        // chat's Close. An explicit reopen here clears the Close first, and
        // other rail modes (Tasks, code review) are not what it closed.
        const prefs = getArtifactReviewState();
        if (prefs.enabled === true && normalizeArtifactReviewMode(prefs.mode) === 'artifact'
          && resolveArtifactReviewDismissed(prefs, renderSessionId)) {
          prefs.enabled = false;
          saveArtifactReviewPreferences();
        }
      }
      // WS3 auto-open hook: artifacts are render-time-derived (no stream
      // artifact event), so the per-render pass is the only trigger point.
      // Runs BEFORE layout sync so an auto-open takes effect this pass.
      const wasEnabled = state.ui?.artifactReview?.enabled === true;
      ensureArtifactReviewAutoOpen()?.maybeAutoOpen();
      syncArtifactReviewLayout({ animate: !sessionSwitched && !wasEnabled && state.ui?.artifactReview?.enabled === true });
      return isArtifactReviewVisible();
    }

    // One table so bind and dispose cannot drift: [target, type, handler].
    function listenerTable() {
      return [
        [artifactSplitViewToggle, 'click', handleArtifactsToggleClick],
      ];
    }
    function bind() {
      if (bound) return;
      bound = true;
      syncArtifactReviewLayout();
      for (const [target, type, handler] of listenerTable()) target?.addEventListener(type, handler);
    }
    function dispose() {
      if (bound) {
        bound = false;
        for (const [target, type, handler] of listenerTable()) target?.removeEventListener(type, handler);
      }
      autoOpenController?.dispose?.();
      autoOpenController = null;
    }

    panelV2?.setTextWrapController?.({ apply: applyArtifactTextWrap, toggle: toggleArtifactTextWrap });

    return {
      bind, dispose, beginRender,
      getArtifactReviewState, saveArtifactReviewPreferences, setArtifactRailMode, pruneSessionPreferences, rekeySession,
      isArtifactReviewVisible, syncArtifactReviewLayout,
      closeArtifactReview, collapseArtifactReview, enableForArtifactOpen, openArtifactRail, restoreArtifactReviewPrefs,
      toggleArtifactReview, rememberReviewFocus, focusReview, restoreReviewFocus,
    };
  }

  return { createArtifactReviewRail };
});
