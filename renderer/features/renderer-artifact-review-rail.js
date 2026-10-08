/**
 * renderer/features/renderer-artifact-review-rail.js
 *
 * The artifact-review rail's state machine (UMD), split out of the artifact
 * manager (renderer-artifacts-utils.js): the persisted preferences, the
 * visibility and layout sync, open / close / toggle across the rail modes
 * (artifact, tasks, code_review, file_preview, subagents), the per-chat
 * maximize and wrap, the resizer, focus hand-off, the auto-open wiring and
 * the session-switch rules. The manager keeps selection and rendering and
 * hands in the few hooks the rail needs (`manager`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-artifact-review-prefs'), require('./renderer-artifact-review-autoopen'));
    return;
  }
  root.rendererArtifactReviewRail = factory(root.rendererArtifactReviewPrefs, root.rendererArtifactReviewAutoopen);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (artifactReviewPrefs, artifactReviewAutoopenModule) {
  'use strict';

  // Below this chat-stage width the panel overlays chat as a drawer.
  const ARTIFACT_REVIEW_MIN_STAGE_WIDTH = 1080;
  const ARTIFACT_REVIEW_KEYBOARD_STEP = 24;

  function createArtifactReviewRail(deps) {
    const { state, dom = {}, callbacks = {}, manager = {} } = deps || {};
    const {
      workspace, sidebar, chatView,
      artifactSplitViewToggle, artifactReviewResizer, artifactReviewPanel, artifactReviewCollapseButton,
    } = dom;
    const {
      getActiveSession, setActiveView, updateComposerSafeOffset, renderAll, appendClientLog,
      // When this app run began (the shell bridge records it at boot; the
      // manager itself is built lazily): auto-open presents only artifacts
      // produced since, never a chat's history after a restart (D-2).
      getRunStartedAt = null,
      resetFilePreview = null,
      panelV2 = null,
      sidePanel = null, // split view W3-2 panel owner (shell artifact bridge); absent: the focused session
    } = callbacks;
    const {
      getArtifactsForSession = () => [],
      ensureSelectionForArtifacts = () => null,
      selectNewestArtifact = () => '',
      renderArtifactReviewPanel = () => {},
      getExistingEditor = () => null,
    } = manager;
    const {
      ARTIFACT_REVIEW_STORAGE_KEY, ARTIFACT_REVIEW_DEFAULT_WIDTH, ARTIFACT_REVIEW_MIN_WIDTH,
      clampArtifactReviewWidth, normalizeArtifactReviewMode, normalizeArtifactReviewPreferences,
      resolveArtifactReviewMaxWidth, resolveEffectiveArtifactReviewWidth, recordArtifactReviewWidth,
      resolveArtifactReviewMaximized, recordArtifactReviewMaximized, recordArtifactReviewDismissed, resolveArtifactReviewDismissed,
      resolveArtifactReviewTextWrap, setArtifactReviewTextWrap, pruneArtifactReviewSessionPreferences,
      rekeyArtifactReviewSessionPreferences,
    } = artifactReviewPrefs;
    const runStartedAt = Number(getRunStartedAt?.()) || Date.now();
    const resizeRuntime = { pointerId: null, startX: 0, startWidth: ARTIFACT_REVIEW_DEFAULT_WIDTH };
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
          width: existing.width,
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
    // width, maximize and Close, its spent presentation, and the render
    // bookkeeping (a rekey is not a session switch).
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
    function getWorkspaceWidth() {
      // Measure the chat stage because workspace width includes the sidebar and
      // can select the wrong layout.
      const workspaceWidth = Math.max(Number(workspace?.getBoundingClientRect?.().width || 0), 0);
      // The sidebar resizer overlays the panel edge on a 0-wide track, so it takes no width.
      const sidebarWidth = Number(sidebar?.getBoundingClientRect?.().width || 0);
      return Math.max(workspaceWidth - sidebarWidth, 0);
    }
    function isArtifactReviewEligible() {
      // No artifacts>0 clause (owner call 2026-07-05): an enabled panel with
      // zero artifacts shows its empty state instead of silently hiding;
      // auto-open keeps its own artifact-count gate.
      // No width clause (W1-5): with the studio fallback removed, a narrow
      // stage renders the panel as an overlay drawer (syncArtifactReviewLayout
      // stamps .artifact-review-overlay) instead of losing artifact access.
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      return state.ui?.activeView === 'chat' && Boolean(activeSession);
    }
    function isArtifactReviewVisible() {
      return getArtifactReviewState().enabled === true && isArtifactReviewEligible();
    }
    function getArtifactReviewWindowWidth() { return typeof window !== 'undefined' ? window.innerWidth : 0; }
    function getArtifactReviewLayoutWidth() {
      const stageWidth = getWorkspaceWidth();
      return stageWidth > 0 ? stageWidth : getArtifactReviewWindowWidth();
    }
    // The chat column the rail must leave: one pane keeps 320 + 10 resizer +
    // 30 slack; two visible panes keep 2*320 + 10 divider + 10 + 30; an
    // overlay drawer shares no chat column. The split folds to one pane by a
    // VIEWPORT media query (chat-panes.css, max-width: 1180px), not by stage.
    function getArtifactReviewReserve(stageWidth) {
      if (stageWidth < ARTIFACT_REVIEW_MIN_STAGE_WIDTH) return 0;
      return chatView?.dataset?.paneCount === '2' && getArtifactReviewWindowWidth() > 1180 ? 690 : 360;
    }
    // The APPLIED maximum (90% of the stage, less the reserve), so
    // drag/keyboard writes and layout agree.
    function getResolvedArtifactReviewMaxWidth(stageWidth = getArtifactReviewLayoutWidth()) {
      return resolveArtifactReviewMaxWidth(stageWidth, getArtifactReviewReserve(stageWidth));
    }
    function getEffectiveArtifactReviewWidth(prefs, stageWidth = getArtifactReviewLayoutWidth()) {
      return resolveEffectiveArtifactReviewWidth(prefs, getActiveSessionIdForReview(),
        { stageWidth, windowWidth: getArtifactReviewWindowWidth(), reserve: getArtifactReviewReserve(stageWidth) });
    }
    function isArtifactReviewMaximized() {
      return resolveArtifactReviewMaximized?.(getArtifactReviewState(), getActiveSessionIdForReview()) === true;
    }
    // Split view (row 34 S5, v2 §6): when the two visible panes can't each
    // keep about 40rem (text scale included) beside the panel, the review
    // opens over the pane of the chat that owns it and the other chat stays
    // usable. Returns that pane's id, or '' to sit beside both as before.
    function resolveReviewPaneOverlay(stageWidth, width) {
      const layout = state.panes;
      if (chatView?.dataset?.paneCount !== '2' || getArtifactReviewWindowWidth() <= 1180 || !Array.isArray(layout?.panes)) return '';
      const root = chatView.ownerDocument?.documentElement;
      const rem = (root && Number.parseFloat(globalThis.getComputedStyle?.(root)?.fontSize)) || 16;
      const ratio = Number.isFinite(layout.splitRatio) ? Math.min(Math.max(layout.splitRatio, 0), 1) : 0.5;
      const narrowestPane = (stageWidth - 20 - width) * Math.min(ratio, 1 - ratio);
      if (narrowestPane >= 40 * rem) return '';
      const ownerSessionId = String((sidePanel ? sidePanel.getSessionId() : getActiveSessionIdForReview()) || '');
      const index = layout.panes.findIndex((pane) => String(pane?.sessionId || '') === ownerSessionId);
      return index >= 0 ? String(index) : '';
    }
    function syncArtifactReviewLayout(options = {}) {
      const stageWidth = getArtifactReviewLayoutWidth();
      const prefs = getArtifactReviewState();
      const width = getEffectiveArtifactReviewWidth(prefs, stageWidth);
      const visible = isArtifactReviewVisible();
      const mode = normalizeArtifactReviewMode(prefs.mode);
      workspace?.style?.setProperty('--artifact-review-width', `${width}px`);
      artifactReviewPanel?.style?.setProperty('width', `${width}px`);
      artifactReviewPanel?.classList.toggle('hidden', !visible);
      // W1-5 narrow-stage fallback (studio removed): below the side-by-side
      // width threshold the panel overlays chat as a drawer instead of
      // becoming ineligible: same DOM, one modifier class. In overlay mode
      // chat keeps its full width (no artifact-review-open layout shift) and
      // the resizer is parked (drawer width is fixed by CSS).
      const overlay = visible && stageWidth < ARTIFACT_REVIEW_MIN_STAGE_WIDTH;
      const maximized = visible && !overlay && isArtifactReviewMaximized();
      const overPane = visible && !overlay && !maximized && mode === 'code_review' ? resolveReviewPaneOverlay(stageWidth, width) : '';
      if (overPane) {
        chatView.dataset.sidePanelPane = overPane;
        artifactReviewPanel?.style?.removeProperty('width');
      } else if (chatView?.dataset) {
        delete chatView.dataset.sidePanelPane;
      }
      artifactReviewPanel?.classList.toggle('artifact-review-overlay', overlay);
      if (artifactReviewPanel?.dataset) artifactReviewPanel.dataset.panelNarrow = width < 360 ? 'true' : 'false';
      artifactReviewPanel?.classList.toggle('code-review-mode', mode === 'code_review');
      if (artifactReviewPanel?.dataset) {
        artifactReviewPanel.dataset.artifactReviewMode = mode;
      }
      sidePanel?.syncOwnerLine?.(artifactReviewPanel, mode);
      artifactReviewResizer?.classList.toggle('hidden', !visible || overlay || maximized || Boolean(overPane));
      if (artifactReviewResizer) {
        artifactReviewResizer.tabIndex = (visible && !overlay && !maximized && !overPane) ? 0 : -1;
        // role="separator" value range: the max is the RESOLVED 90% bound, so
        // assistive tech reports the same ceiling the End key lands on.
        artifactReviewResizer.setAttribute('aria-valuemin', String(ARTIFACT_REVIEW_MIN_WIDTH));
        artifactReviewResizer.setAttribute('aria-valuemax', String(getResolvedArtifactReviewMaxWidth(stageWidth)));
        artifactReviewResizer.setAttribute('aria-valuenow', String(width));
      }
      // Pressed only while the rail shows artifacts; other modes own their state.
      if (artifactSplitViewToggle) {
        const artifactsShowing = visible && mode === 'artifact';
        artifactSplitViewToggle.setAttribute('aria-pressed', artifactsShowing ? 'true' : 'false');
        artifactSplitViewToggle.classList.toggle('active', artifactsShowing);
      }
      chatView?.classList.toggle('artifact-review-open', visible && !overlay && !overPane);
      chatView?.classList.toggle('artifact-review-mode', visible);
      chatView?.classList.toggle('code-review-open', visible && mode === 'code_review');
      chatView?.classList.toggle('artifact-review-maximized', maximized);
      updateComposerSafeOffset?.();
      if (options.refreshChatChrome) renderAll?.();
    }

    // ── maximize, width and wrap ──
    function toggleArtifactReviewMaximized(nextValue) {
      if (!getActiveSessionIdForReview()) return false;
      // Read the current value BEFORE capturing prefs: every state read swaps in
      // a fresh normalized object, so a read after the capture detaches it.
      const next = typeof nextValue === 'boolean' ? nextValue : !isArtifactReviewMaximized();
      const prefs = getArtifactReviewState();
      recordArtifactReviewMaximized?.(prefs, getActiveSessionIdForReview(), next);
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout();
      panelV2?.afterRender?.(manager.getSelectedArtifact?.() || null);
      return isArtifactReviewMaximized();
    }
    // Width writes go to widthBySession[activeSession]; the legacy global `width` stays the fallback seed.
    // Drag-time clamp: bound the WRITE by the resolved 90% max so persistence
    // never drifts above what the stage can actually show (the static clamp
    // inside recordArtifactReviewWidth is only the sanity ceiling now).
    function applyArtifactReviewWidth(prefs, nextWidth) {
      const numeric = Number(nextWidth);
      const bounded = Number.isFinite(numeric)
        ? Math.max(ARTIFACT_REVIEW_MIN_WIDTH, Math.min(getResolvedArtifactReviewMaxWidth(), Math.round(numeric)))
        : nextWidth;
      recordArtifactReviewWidth(prefs, getActiveSessionIdForReview(), bounded);
    }
    // One persisted wrap state per body kind ('output' | 'code'), never carried by
    // the body: the panel class flips text bodies, Monaco flips through its API.
    function applyArtifactTextWrap(kind) {
      const wrapped = resolveArtifactReviewTextWrap(getArtifactReviewState(), kind);
      artifactReviewPanel?.classList?.toggle('artifact-panel-nowrap', !wrapped);
      if (kind !== 'output') getExistingEditor('split')?.setWordWrap?.(wrapped);
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
      syncArtifactReviewLayout({ refreshChatChrome: true });
    }
    // W3-2 owner-pane close: no dismissal, so auto-open still works later.
    function collapseArtifactReview() { closeArtifactReview({ dismiss: false }); }

    // An explicit artifact open (every verb since the studio left, W1-5):
    // artifact mode, open, this chat's Close forgotten. Eligibility requires
    // the chat view, so opens from other views switch to chat first; narrow
    // stages get the overlay drawer via the layout sync.
    function enableForArtifactOpen(sessionId) {
      const prefs = getArtifactReviewState();
      prefs.mode = 'artifact';
      prefs.enabled = true;
      recordArtifactReviewDismissed(prefs, sessionId, false);
      if (state.ui?.activeView !== 'chat') setActiveView('chat');
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout();
    }

    // Shared open path for the non-artifact rail modes: everything an artifact
    // open does EXCEPT selecting an artifact. Callers (the file preview owner
    // today) hand it a mode; eligibility still requires the chat view, and
    // narrow stages get the overlay drawer via the layout sync.
    function openArtifactRail(mode) {
      rememberReviewFocus();
      if (sidePanel) { sidePanel.claim(); lastRenderedSessionId = String(sidePanel.getSessionId() || '').trim(); } // a claim is not a session switch
      const sessionId = getActiveSessionIdForReview();
      const prefs = getArtifactReviewState();
      prefs.mode = normalizeArtifactReviewMode(mode);
      prefs.enabled = true;
      // Only an artifact open clears this chat's artifact dismissal.
      if (prefs.mode === 'artifact') recordArtifactReviewDismissed(prefs, sessionId, false);
      if (state.ui?.activeView !== 'chat') {
        setActiveView('chat');
      }
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout();
      focusReview();
      return prefs.mode;
    }

    // The Subagent Monitor's close puts back the mode and open state it displaced.
    function restoreArtifactReviewPrefs(patch) {
      const prefs = getArtifactReviewState();
      Object.assign(prefs, { mode: normalizeArtifactReviewMode(patch?.mode), enabled: patch?.enabled === true });
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ refreshChatChrome: true });
      renderArtifactReviewPanel();
    }

    // Explicit artifact open: clears this chat's dismissal, selects an artifact if none is.
    function openArtifactsMode() {
      sidePanel?.claim();
      const sessionId = getActiveSessionIdForReview();
      const prefs = getArtifactReviewState();
      prefs.mode = 'artifact';
      prefs.enabled = true;
      prefs.width = clampArtifactReviewWidth(prefs.width);
      recordArtifactReviewDismissed(prefs, sessionId, false);
      const activeSession = typeof getActiveSession === 'function' ? getActiveSession() : null;
      if (activeSession) {
        const artifacts = getArtifactsForSession(activeSession.id);
        if (artifacts.length) ensureSelectionForArtifacts(artifacts);
      }
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ refreshChatChrome: true });
      renderArtifactReviewPanel();
      if (isArtifactReviewVisible()) focusReview();
    }

    // Generic toggle (the Tasks toggle's close path, the bridge's primer)
    // closes whatever rail mode shows (a dismissal only for artifacts). The
    // strip's Artifacts toggle passes artifactsOnly: from Tasks / code review /
    // file preview it switches to artifacts instead of closing that mode.
    function toggleArtifactReview(options) {
      rememberReviewFocus();
      const artifactsShowing = normalizeArtifactReviewMode(getArtifactReviewState().mode) === 'artifact';
      if (!isArtifactReviewVisible() || (options?.artifactsOnly === true && !artifactsShowing)) return openArtifactsMode();
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
      if (renderSessionId !== lastRenderedSessionId) {
        const hadSession = lastRenderedSessionId !== '';
        lastRenderedSessionId = renderSessionId;
        if (hadSession && normalizeArtifactReviewMode(getArtifactReviewState().mode) === 'file_preview') {
          getArtifactReviewState().mode = 'artifact';
          if (typeof resetFilePreview === 'function') resetFilePreview();
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
      ensureArtifactReviewAutoOpen()?.maybeAutoOpen();
      syncArtifactReviewLayout();
      return isArtifactReviewVisible();
    }

    // ── resizer and keys ──
    function finishArtifactReviewResize(event) {
      if (resizeRuntime.pointerId !== event.pointerId) return;
      artifactReviewResizer.classList.remove('dragging');
      artifactReviewResizer.releasePointerCapture(event.pointerId);
      resizeRuntime.pointerId = null;
      saveArtifactReviewPreferences();
      syncArtifactReviewLayout({ refreshChatChrome: true });
    }
    function handleArtifactReviewResizeMove(event) {
      if (resizeRuntime.pointerId !== event.pointerId) return;
      const delta = resizeRuntime.startX - event.clientX;
      applyArtifactReviewWidth(getArtifactReviewState(), resizeRuntime.startWidth + delta);
      syncArtifactReviewLayout();
    }
    function handleArtifactReviewResizeStart(event) {
      if (!isArtifactReviewVisible()) return;
      event.preventDefault();
      resizeRuntime.pointerId = event.pointerId;
      resizeRuntime.startX = event.clientX;
      resizeRuntime.startWidth = getEffectiveArtifactReviewWidth(getArtifactReviewState());
      artifactReviewResizer.classList.add('dragging');
      artifactReviewResizer.setPointerCapture(event.pointerId);
    }
    // Keyboard steps use the per-session helpers: arrows step the effective
    // width, Home lands on the default width and End on the resolved
    // 90%-of-stage max with the visible-pane reserve.
    function handleArtifactReviewResizeKeydown(event) {
      if (!isArtifactReviewVisible()) return;
      const prefs = getArtifactReviewState();
      const targets = {
        ArrowLeft: () => getEffectiveArtifactReviewWidth(prefs) + ARTIFACT_REVIEW_KEYBOARD_STEP,
        ArrowRight: () => getEffectiveArtifactReviewWidth(prefs) - ARTIFACT_REVIEW_KEYBOARD_STEP,
        Home: () => ARTIFACT_REVIEW_DEFAULT_WIDTH,
        End: () => getResolvedArtifactReviewMaxWidth(),
      };
      if (!Object.prototype.hasOwnProperty.call(targets, event.key)) return;
      event.preventDefault();
      applyArtifactReviewWidth(prefs, targets[event.key]());
      syncArtifactReviewLayout();
      saveArtifactReviewPreferences();
    }
    function handleArtifactPanelKeydown(event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (artifactReviewPanel?.classList.contains('artifact-review-overlay')) {
        event.preventDefault();
        artifactReviewCollapseButton?.click();
      } else if (isArtifactReviewMaximized()) {
        event.preventDefault();
        toggleArtifactReviewMaximized(false);
      }
    }

    // One table so bind and dispose cannot drift: [target, type, handler].
    function listenerTable() {
      return [
        [artifactReviewPanel, 'keydown', handleArtifactPanelKeydown],
        [artifactSplitViewToggle, 'click', handleArtifactsToggleClick],
        [artifactReviewResizer, 'pointerdown', handleArtifactReviewResizeStart],
        [artifactReviewResizer, 'pointermove', handleArtifactReviewResizeMove],
        [artifactReviewResizer, 'pointerup', finishArtifactReviewResize],
        [artifactReviewResizer, 'pointercancel', finishArtifactReviewResize],
        [artifactReviewResizer, 'keydown', handleArtifactReviewResizeKeydown],
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
      isArtifactReviewVisible, syncArtifactReviewLayout, isArtifactReviewMaximized, toggleArtifactReviewMaximized,
      closeArtifactReview, collapseArtifactReview, enableForArtifactOpen, openArtifactRail, restoreArtifactReviewPrefs,
      toggleArtifactReview, rememberReviewFocus, focusReview, restoreReviewFocus,
    };
  }

  return { ARTIFACT_REVIEW_MIN_STAGE_WIDTH, createArtifactReviewRail };
});
