(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-render-pipeline-chrome-composer'),
      require('./renderer-render-pipeline-chrome-hero')
    );
    return;
  }
  root.rendererRenderPipelineChromeUtils = factory(
    root.rendererRenderPipelineChromeComposer,
    root.rendererRenderPipelineChromeHero
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerChromeUtils, heroChromeUtils) {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const windowRef = globalRef.window || globalRef;
  const documentRef = windowRef.document || null;
  const { syncDisabledReason } = composerChromeUtils;
  // Split view W2-2a: the runtime preferences of the session a pane shows. One
  // pane (or no reader, or a session not in the list): the current preferences,
  // the same shape and values the composer read before panes.
  function resolvePaneRuntimePreferences({ state, sessionId, fromSession, current }) {
    const id = String(sessionId || '').trim();
    const session = id && typeof fromSession === 'function'
      ? (Array.isArray(state?.sessions) ? state.sessions : []).find((entry) => entry?.id === id)
      : null;
    return session ? fromSession(session) : current();
  }
  function createChromePipeline(deps) {
    const {
      state,
      constants = {},
      dom = {},
      controllers = {},
      callbacks = {},
    } = deps || {};
    const { MESSAGE_STATUS = {} } = constants;
    const {
      homeView = null,
      chatView = null,
      ideView = null,
      logsView = null,
      settingsView = null,
      homeNavButton = null,
      chatThreadStage = null,
      composerWrap = null,
      chatOriginChip = null,
      chatOriginLabel = null,
      heroAvatar = null,
      heroTitle = null,
      heroSubtitle = null,
      heroRuntimeHint = null,
      chatInput = null,
      composer = null,
    } = dom;
    const {
      logRenderer = null,
    } = controllers;
    const {
      renderHeader = () => {},
      renderMessages = () => {},
      applySurfaceEffect = () => {},
      syncBackendNotice = () => {},
      renderSettings = () => {},
      renderComposerCarriers = () => {},
      renderIde = () => {},
      layoutIdeEditor = () => {},
      renderAttachmentTray = () => {},
      renderComposerStatusNotice = () => {},
      renderToastViewport = () => {},
      renderComposerPopover = () => {},
      renderHomePanel = () => {},
      shouldRenderHomePanel = () => false,
      renderContextPanel = null,
      // Body-level sticky-note overlay (renderer-scratchpad-pin.js); view-independent,
      // so it refreshes on every full repaint like the other optional chrome renderers.
      renderPinnedNotes = null,
      renderWorkspaceChrome = () => {},
      renderSessions = () => {},
      renderArtifactReviewPanel = () => {},
      getVisibleSessionMessages = () => [],
      // Split view W1-4a: the session this pane shows (one pane: currentSessionId).
      getPaneSessionId = () => String(state.currentSessionId || '').trim(),
      // This pane's follow intent (one pane: state.ui.followLatest).
      isFollowingLatest = () => state.ui.followLatest !== false,
      getCurrentRuntimePreferences = () => ({ contextPreferences: {} }),
      getRuntimePreferencesFromSession = null,
      // The composer's own controls (model, effort, run mode) read the session
      // THIS pane shows, so a focus change never repaints another pane's rail.
      getPaneRuntimePreferences = () => resolvePaneRuntimePreferences({
        state, sessionId: getPaneSessionId(), fromSession: getRuntimePreferencesFromSession, current: getCurrentRuntimePreferences,
      }),
      isSessionStreaming = () => false,
      hasPendingToolApprovalForSession = () => false,
      setComposerHoloState = () => {},
      resolveChatSendLifecycle = () => 'idle',
      syncStableChatSurfaceState = () => {},
      // Chat-dock host reconcile (ide_chat_dock): re-homes the chat subtree
      // between #chatView and the Workspace dock; returns true on a real move.
      reconcileChatDockHost = () => false,
      rebuildChatVirtualizer = () => {},
    } = callbacks;

    const sessionOriginMap = new Map();
    let pendingOriginLabel = '';

    function setDatasetIfChanged(node, key, value) {
      if (!node || !node.dataset) return;
      if (node.dataset[key] === value) return;
      node.dataset[key] = value;
    }

    function renderLayout() {
      const activeView = state.ui.activeView;
      // Chat-dock host reconcile (ide_chat_dock) MUST run before any
      // visibility toggle below: when leaving Workspace the chat nodes have to
      // be back inside the becoming-visible #chatView BEFORE #ideView gains
      // view-offscreen (content-visibility:hidden would zero-size them
      // mid-paint). Idempotent — a no-op when hosts already match.
      // A real move leaves the virtualizer's height cache measured against the
      // old container — schedule a rAF rebuild (plan §10).
      if (reconcileChatDockHost() === true) {
        if (typeof windowRef.requestAnimationFrame === 'function') {
          windowRef.requestAnimationFrame(() => rebuildChatVirtualizer());
        } else {
          rebuildChatVirtualizer();
        }
      }
      homeView?.classList.toggle('hidden', activeView !== 'home');
      homeView?.classList.toggle('active-view', activeView === 'home');
      chatView?.classList.toggle('hidden', activeView !== 'chat');
      chatView?.classList.toggle('active-view', activeView === 'chat');
      if (ideView) {
        const ideWasOffscreen = ideView.classList.contains('view-offscreen');
        ideView.classList.toggle('view-offscreen', activeView !== 'ide');
        ideView.classList.remove('hidden');
        ideView.classList.toggle('active-view', activeView === 'ide');
        ideView.inert = activeView !== 'ide';
        ideView.setAttribute('aria-hidden', activeView !== 'ide' ? 'true' : 'false');
        if (activeView === 'ide' && ideWasOffscreen && typeof windowRef.requestAnimationFrame === 'function') {
          // content-visibility:hidden zero-sizes the editor host; re-layout once it has real dimensions.
          windowRef.requestAnimationFrame(() => layoutIdeEditor());
        }
      }
      if (logsView) {
        logsView.classList.toggle('view-offscreen', activeView !== 'logs');
        logsView.classList.remove('hidden');
        logsView.classList.toggle('active-view', activeView === 'logs');
        logsView.inert = activeView !== 'logs';
        logsView.setAttribute('aria-hidden', activeView !== 'logs' ? 'true' : 'false');
      }
      if (settingsView) {
        settingsView.classList.toggle('view-offscreen', activeView !== 'settings');
        settingsView.classList.remove('hidden');
        settingsView.classList.toggle('active-view', activeView === 'settings');
        settingsView.inert = activeView !== 'settings';
        settingsView.setAttribute('aria-hidden', activeView !== 'settings' ? 'true' : 'false');
      }
      homeNavButton?.classList.toggle('active-link', activeView === 'home');
      if (homeNavButton) {
        if (activeView === 'home') {
          homeNavButton.setAttribute('aria-current', 'page');
        } else {
          homeNavButton.removeAttribute('aria-current');
        }
      }
      applySurfaceEffect();
      renderWorkspaceChrome();
    }

    function writeSurfaceState(node, tokens) {
      if (!node) return;
      const normalizedTokens = Array.isArray(tokens) && tokens.length ? tokens : ['idle'];
      node.dataset.surfaceState = normalizedTokens.join(' ');
    }

    function isCalmTerminalMessage(message) {
      const classification = String(message?.recovery_class || message?.terminal_status || message?.terminalStatus || '').trim().toLowerCase();
      return classification === 'cancelled' || classification === 'canceled' || classification === 'denied';
    }

    function syncSurfaceStates() {
      const currentSessionId = getPaneSessionId();
      const currentSendLifecycle = resolveChatSendLifecycle(currentSessionId);
      const threadTokens = [];
      if (isSessionStreaming(currentSessionId) || hasPendingToolApprovalForSession(currentSessionId)) {
        threadTokens.push('busy');
      }
      if (currentSendLifecycle !== 'idle') {
        threadTokens.push(currentSendLifecycle);
      }
      const sessionMessages = currentSessionId ? getVisibleSessionMessages(currentSessionId) : [];
      const hasMessages = sessionMessages.length > 0;
      for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
        if (String(sessionMessages[index].kind || '') === 'assistant') {
          // A user-intent terminal (stop/deny) keeps MESSAGE_STATUS.ERROR for
          // retry affordances but must not light the red thread glow — mirror
          // the calm-card classification (renderer-error-recovery-utils).
          if (sessionMessages[index].status === MESSAGE_STATUS.ERROR && !isCalmTerminalMessage(sessionMessages[index])) {
            threadTokens.push('error');
          }
          break;
        }
      }
      if (
        // Widened render gate (ide_chat_dock): the 'active' surface token also
        // applies while the Workspace dock is the live chat surface.
        ((globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state)
          ?? (state.ui.activeView === 'chat'))
        && hasMessages
        && !isFollowingLatest()
      ) {
        threadTokens.push('active');
      }
      writeSurfaceState(chatThreadStage, threadTokens);

      const composerTokens = [];
      const composerFocused = Boolean(documentRef && documentRef.activeElement === chatInput);
      const hasComposerDraft = Boolean(String(chatInput?.value || '').trim())
        || Boolean(Array.isArray(state.attachments?.queued) && state.attachments.queued.length);
      const composerActive = composerFocused || hasComposerDraft;
      if (composerActive) {
        composerTokens.push('active');
      }
      if (composerFocused) {
        composerTokens.push('focused');
      }
      if (hasComposerDraft) {
        composerTokens.push('draft');
      }
      if (currentSendLifecycle !== 'idle') {
        composerTokens.push(currentSendLifecycle);
      }
      writeSurfaceState(composerWrap, composerTokens);
      if (composer) {
        composer.dataset.composerActive = composerActive ? 'true' : 'false';
      }
      syncStableChatSurfaceState();
    }

    function setSessionOrigin(sessionId, label) {
      if (sessionId && label) sessionOriginMap.set(sessionId, label);
    }

    function getSessionOrigin(sessionId) {
      return sessionOriginMap.get(sessionId) || '';
    }

    function sweepSessionOrigins() {
      const activeSessionIds = new Set(
        (Array.isArray(state.sessions) ? state.sessions : [])
          .map((session) => String(session?.id || '').trim())
          .filter(Boolean)
      );
      for (const sessionId of sessionOriginMap.keys()) {
        if (!activeSessionIds.has(sessionId)) {
          sessionOriginMap.delete(sessionId);
        }
      }
    }

    function setPendingOrigin(label) {
      pendingOriginLabel = String(label || '').trim();
    }

    function getPendingOrigin() {
      return pendingOriginLabel;
    }

    function clearPendingOrigin() {
      pendingOriginLabel = '';
    }

    function attachPendingOriginToSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId || !pendingOriginLabel) {
        return '';
      }
      sessionOriginMap.set(normalizedSessionId, pendingOriginLabel);
      const attachedLabel = pendingOriginLabel;
      pendingOriginLabel = '';
      return attachedLabel;
    }

    function rekeySessionOrigin(fromSessionId, toSessionId) {
      const fromId = String(fromSessionId || '').trim();
      const toId = String(toSessionId || '').trim();
      if (!fromId || !toId || fromId === toId) {
        return '';
      }
      const origin = sessionOriginMap.get(fromId) || '';
      if (origin) {
        sessionOriginMap.set(toId, origin);
      }
      sessionOriginMap.delete(fromId);
      return origin;
    }

    function startedFromLabel(sessionId) {
      const rows = globalRef.rendererSessionMessageRows || (typeof require === 'function' ? require('./renderer-session-message-rows') : null);
      const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
      return rows?.buildStartedFromLabel?.(sessions.find((entry) => String(entry?.id || '') === sessionId), sessions) || '';
    }

    function renderOriginChip() {
      sweepSessionOrigins();
      if (!chatOriginChip || !chatOriginLabel) return;
      const currentSessionId = getPaneSessionId();
      const sessionMessages = currentSessionId ? getVisibleSessionMessages(currentSessionId) : [];
      const hasAssistantReply = sessionMessages.some((message) => {
        const role = String(message?.role || '').trim();
        const kind = String(message?.kind || '').trim();
        return role === 'assistant'
          && kind !== 'interactive_round_recap'
          && kind !== 'question_batch'
          && (
            Boolean(String(message?.content || '').trim())
            || Boolean(String(message?.stream_error || '').trim())
            || (Array.isArray(message?.reasoning?.entries) && message.reasoning.entries.length > 0)
          );
      });
      if (hasAssistantReply) {
        sessionOriginMap.delete(currentSessionId);
      }
      let origin = getSessionOrigin(currentSessionId);
      if (!origin && !currentSessionId && state.ui.activeView === 'chat') {
        const draftPrompt = String(chatInput?.value || '').trim();
        if (draftPrompt) {
          origin = getPendingOrigin();
        } else if (getPendingOrigin()) {
          clearPendingOrigin();
        }
      }
      // A chat a parent started (checkpoint 5a, summary spawned_from) keeps "Started from {parent}" at the top for good.
      const startedFrom = origin && !hasAssistantReply ? '' : startedFromLabel(currentSessionId);
      if (origin && !hasAssistantReply) {
        chatOriginLabel.textContent = origin;
        chatOriginChip.classList.remove('hidden');
      } else if (startedFrom) {
        chatOriginLabel.textContent = startedFrom;
        chatOriginChip.classList.remove('hidden');
      } else {
        chatOriginChip.classList.add('hidden');
      }
    }

    const heroChrome = heroChromeUtils.createHeroChrome({
      state,
      dom: { heroAvatar, heroTitle, heroSubtitle, heroRuntimeHint },
      getPaneSessionId,
      getVisibleSessionMessages,
      setDatasetIfChanged,
    });
    const { renderHero } = heroChrome;

    function renderLogs() {
      if (logRenderer) {
        logRenderer.renderLogs();
      }
    }

    function syncComposerVisualState() {
      const typing = !chatInput.disabled && Boolean(chatInput.value.trim());
      const lifecycle = resolveChatSendLifecycle(getPaneSessionId());
      const composerWaiting = lifecycle === 'preflight';
      const composerInferenceActive = lifecycle === 'streaming' || lifecycle === 'settling';
      composer.classList.toggle('composer-active', typing);
      const holoActive = typing || composerWaiting || composerInferenceActive;
      const holoMode = composerInferenceActive
        ? 'inference'
        : composerWaiting
        ? 'waiting'
        : 'typing';
      setComposerHoloState(holoActive, holoMode);
      syncSurfaceStates();
      renderOriginChip();
      syncComposerAccessoryVisibility();
    }

    const composerChrome = composerChromeUtils.createComposerChrome({
      state,
      constants,
      dom,
      controllers,
      callbacks,
      documentRef,
      getPaneSessionId,
      isFollowingLatest,
      getPaneRuntimePreferences,
      setDatasetIfChanged,
      syncComposerVisualState,
    });
    const { renderComposerState, renderComposerJumpControls, syncComposerAccessoryVisibility } = composerChrome;

    function renderAll(options) {
      renderLayout();
      syncSurfaceStates();
      renderOriginChip();
      renderHeader();
      if (state.ui.activeView === 'home' || shouldRenderHomePanel()) {
        renderHomePanel();
      }
      renderHero();
      renderSessions();
      renderMessages(options);
      if (state.ui.activeView === 'chat') {
        if (typeof renderArtifactReviewPanel === 'function') {
          renderArtifactReviewPanel();
        }
      }
      if (state.ui.activeView === 'ide') {
        renderIde();
      }
      if (typeof renderContextPanel === 'function') {
        renderContextPanel();
      }
      if (typeof renderPinnedNotes === 'function') {
        renderPinnedNotes();
      }
      syncBackendNotice();
      if (state.ui.activeView === 'logs') {
        renderLogs();
      }
      // The Settings page (which rebuilds the carriers itself) paints only while it is the active view.
      if (state.ui.activeView === 'settings') renderSettings();
      else renderComposerCarriers();
      renderAttachmentTray();
      renderComposerStatusNotice();
      renderToastViewport();
      renderComposerState();
      renderComposerPopover();
    }

    function dispose() {
      heroChrome.dispose();
    }

    return {
      renderLayout,
      renderHeader,
      syncSurfaceStates,
      setSessionOrigin,
      setPendingOrigin,
      clearPendingOrigin,
      attachPendingOriginToSession,
      rekeySessionOrigin,
      renderOriginChip,
      renderHero,
      renderLogs,
      syncComposerVisualState,
      renderComposerJumpControls,
      renderComposerState,
      renderAll,
      dispose,
    };
  }

  return {
    createChromePipeline,
    resolvePaneRuntimePreferences,
    syncDisabledReason,
  };
});
