(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-composer-v2-state'),
      require('./renderer-composer-v2-render'),
      require('./renderer-turn-elapsed-clock')
    );
    return;
  }
  root.rendererRenderPipelineChromeUtils = factory(
    root.rendererComposerV2State,
    root.rendererComposerV2Render,
    root.rendererTurnElapsedClock
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerState, composerV2Render, turnElapsedClock) {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const windowRef = globalRef.window || globalRef;
  const documentRef = windowRef.document || null;
  const { formatElapsedLabel } = turnElapsedClock;
  function syncDisabledReason(control, reasonNode, reason) {
    if (!control || !reasonNode) return;
    const locked = control.disabled === true || control.getAttribute?.('aria-disabled') === 'true';
    const message = locked ? String(reason || '').trim() : '';
    reasonNode.textContent = message;
    if (message) control.setAttribute('aria-describedby', reasonNode.id);
    else control.removeAttribute('aria-describedby');
  }
  function createChromePipeline(deps) {
    const {
      state,
      constants = {},
      dom = {},
      controllers = {},
      callbacks = {},
    } = deps || {};
    const { ACTIVITY_SCOPE = {}, MESSAGE_STATUS = {} } = constants;
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
      composerModelSelect = null,
      composerEffortSelect = null,
      composerSettingsButton = null,
      jumpToTopButton = null,
      jumpToBottomButton = null,
      jumpToLastPromptButton = null,
      stopStreamButton = null,
      sendButton = null,
      composerModelSelectShell = null,
      composerEffortSelectShell = null,
    } = dom;
    const {
      logRenderer = null,
    } = controllers;
    const {
      renderHeader = () => {},
      renderPrompts = () => {},
      renderMessages = () => {},
      applySurfaceEffect = () => {},
      syncBackendNotice = () => {},
      publishLifecycleStatus = () => {},
      renderTurnStatusPill = () => {},
      renderSettings = () => {},
      renderIde = () => {},
      layoutIdeEditor = () => {},
      renderAttachmentTray = () => {},
      renderComposerStatusNotice = () => {},
      setComposerStatusNotice = () => {},
      clearComposerStatusNotice = () => {},
      renderToastViewport = () => {},
      renderComposerPopover = () => {},
      renderCommandPopover = () => {},
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
      getCurrentVisibleMessages = () => [],
      getCurrentRuntimePreferences = () => ({ contextPreferences: {} }),
      isSendBusy = () => false,
      isSessionStreaming = () => false,
      hasPendingToolApprovalForSession = () => false,
      getPendingQuestionBatch = () => null,
      hasStalePendingQuestionBatch = () => false,
      getActivitySnapshot = () => null,
      getMostRecentActivity = () => null,
      isActivityBusy = () => false,
      applyActivityAttributes = () => {},
      syncComposerModelSelectWidth = () => {},
      renderComposerInteractivePanel = () => {},
      closeComposerPopover = () => {},
      syncComposerInputHeight = () => {},
      setComposerHoloState = () => {},
      updateComposerSafeOffset = () => {},
      renderLiveThinkingChip = () => {},
      renderComposerEnhancements = null,
      resolveChatSendLifecycle = () => 'idle',
      syncStableChatSurfaceState = () => {},
      getLatestUserMessageId = () => '',
      isSendPreflightPending = () => false,
      syncTurnElapsedClock = () => {},
      stopFallbackRotation = () => {},
      // Chat-dock host reconcile (ide_chat_dock): re-homes the chat subtree
      // between #chatView and the Workspace dock; returns true on a real move.
      reconcileChatDockHost = () => false,
      rebuildChatVirtualizer = () => {},
    } = callbacks;

    const sessionOriginMap = new Map();
    let visionNoticeShown = false;
    let pendingOriginLabel = '';

    function isSendLifecycleInflight(lifecycle) {
      return lifecycle === 'preflight' || lifecycle === 'streaming' || lifecycle === 'settling';
    }

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
      const currentSessionId = String(state.currentSessionId || '').trim();
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
        && state.ui.followLatest === false
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

    function renderOriginChip() {
      sweepSessionOrigins();
      if (!chatOriginChip || !chatOriginLabel) return;
      const currentSessionId = String(state.currentSessionId || '').trim();
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
      if (origin && !hasAssistantReply) {
        chatOriginLabel.textContent = origin;
        chatOriginChip.classList.remove('hidden');
      } else {
        chatOriginChip.classList.add('hidden');
      }
    }

    function renderHero() {
      const activeSession = state.sessions.find((session) => session.id === state.currentSessionId);
      const sessionMessages = activeSession ? getVisibleSessionMessages(activeSession.id) : [];
      const hasMessages = sessionMessages.length > 0;
      const heroStage = heroTitle ? heroTitle.closest('.hero-stage') : null;
      const pluginSession = activeSession?.session_type === 'plugin';
      if (heroStage) heroStage.classList.toggle('hero-plugin-session', pluginSession);
      if (pluginSession) {
        if (heroStage) heroStage.classList.remove('hidden');
        heroAvatar.textContent = 'J';
        heroAvatar.classList.toggle('hidden', !hasMessages);
        heroTitle.textContent = activeSession?.title || 'Plugin session';
        heroSubtitle.textContent = hasMessages
          ? 'This saved plugin transcript is read-only in Jenny.'
          : 'Open the provider workspace to begin.';
        if (heroRuntimeHint) {
          heroRuntimeHint.textContent = '';
          heroRuntimeHint.classList.add('hidden');
        }
        return;
      }
      if (heroStage) heroStage.classList.remove('hidden');
      heroAvatar.textContent = 'J';
      heroAvatar.classList.toggle('hidden', !hasMessages);
      const setupSnapshot = state.setup || {};
      const setupIncomplete = setupSnapshot.loaded === true && setupSnapshot.setupComplete === false;
      let showRuntimeHint = false;
      if (hasMessages) {
        heroTitle.textContent = activeSession?.title || 'New Chat';
        heroSubtitle.textContent = 'Continue the active conversation or begin a fresh branch.';
      } else if (setupIncomplete) {
        heroTitle.textContent = 'Welcome — let’s set Jenny up';
        heroSubtitle.textContent = 'A few quick steps on Companion Home make Jenny yours. Pick up where you left off below.';
      } else {
        heroTitle.textContent = 'New session';
        heroSubtitle.textContent = 'Ask Jenny anything to begin';
        /* Empty chat, backend ready, model not yet warmed: surface the
         * "loads on first message" hint here in the hero instead of the
         * floating backend banner. */
        showRuntimeHint = state.backend?.phase === 'ready' && state.status?.model_loaded === false;
      }
      if (heroRuntimeHint) {
        if (showRuntimeHint) {
          heroRuntimeHint.textContent = 'Model loads with your first message';
          heroRuntimeHint.classList.remove('hidden');
        } else {
          heroRuntimeHint.textContent = '';
          heroRuntimeHint.classList.add('hidden');
        }
      }
    }

    function renderLogs() {
      if (logRenderer) {
        logRenderer.renderLogs();
      }
    }

    function renderComposerJumpControls() {
      const messages = getCurrentVisibleMessages();
      const hasMessages = messages.length > 0;
      const latestUserMessageId = getLatestUserMessageId(messages);
      const anyJumpButton = jumpToTopButton || jumpToLastPromptButton || jumpToBottomButton;
      const jumpTools = anyJumpButton?.closest('.composer-jump-tools') || null;
      const wayfinderActive = state.ui?.chatWayfinderVisible === true;
      const showJumpTools = hasMessages && state.ui.followLatest === false && !wayfinderActive;
      const wayfinderHost = documentRef?.getElementById('composerWayfinderHost') || null;

      if (jumpTools) {
        jumpTools.classList.toggle('hidden', !showJumpTools);
        jumpTools.setAttribute('aria-hidden', showJumpTools ? 'false' : 'true');
      }
      if (wayfinderHost) {
        wayfinderHost.hidden = !wayfinderActive;
      }
      if (jumpToTopButton) jumpToTopButton.disabled = !hasMessages;
      if (jumpToBottomButton) jumpToBottomButton.disabled = !hasMessages;
      if (jumpToLastPromptButton) jumpToLastPromptButton.disabled = !latestUserMessageId;
    }

    function syncComposerAccessoryVisibility() {
      renderComposerJumpControls();
    }

    function syncComposerVisualState() {
      const typing = !chatInput.disabled && Boolean(chatInput.value.trim());
      const lifecycle = resolveChatSendLifecycle(state.currentSessionId);
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

    function syncComposerTurnTimer() {
      const timer = documentRef?.getElementById?.('composerTurnTimer');
      if (!timer) return;
      const currentSessionId = String(state.currentSessionId || '').trim();
      const entry = state.turnClockBySession?.get(currentSessionId) || null;
      if (state.features?.featureFlags?.composer_turn_timer === false) {
        timer.removeAttribute('data-turn-elapsed');
        timer.removeAttribute('data-elapsed-started-at');
        timer.dataset.turnTimerState = 'idle';
        timer.textContent = '';
        return;
      }
      const sendBusy = isSendBusy();
      if (entry && entry.endedAt == null && !sendBusy) entry.endedAt = Date.now();
      if (entry && entry.endedAt == null && sendBusy) {
        timer.setAttribute('data-turn-elapsed', 'true');
        timer.setAttribute('data-elapsed-started-at', String(entry.startedAt));
        timer.dataset.turnTimerState = 'running';
        timer.textContent = formatElapsedLabel(Date.now() - entry.startedAt);
        syncTurnElapsedClock();
        return;
      }
      timer.removeAttribute('data-turn-elapsed');
      timer.removeAttribute('data-elapsed-started-at');
      if (entry && entry.endedAt != null) {
        timer.dataset.turnTimerState = 'done';
        timer.textContent = formatElapsedLabel(entry.endedAt - entry.startedAt);
        return;
      }
      timer.dataset.turnTimerState = 'idle';
      timer.textContent = '';
    }

    function renderComposerState() {
      const currentSessionId = String(state.currentSessionId || '').trim();
      const activeSession = (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => session?.id === currentSessionId) || null;
      const pluginSessionReadOnly = activeSession?.session_type === 'plugin';
      const sendBusy = isSendBusy();
      const runtimePreferences = getCurrentRuntimePreferences();
      const runModeProjection = composerState.projectRunMode(runtimePreferences.runMode, {
        planModeFallback: runtimePreferences.planMode === true,
      });
      const runModeLabel = runModeProjection.runMode[0].toUpperCase() + runModeProjection.runMode.slice(1);
      const interactiveBatchActive = Boolean(getPendingQuestionBatch() && !hasStalePendingQuestionBatch());
      const ownsActiveStream = isSessionStreaming(currentSessionId);
      const activeApprovalPending = hasPendingToolApprovalForSession(currentSessionId);
      // Dock-scoped approval-steer (ide_chat_dock, plan §17 decision 7): while
      // the Workspace dock is the live chat surface, a pending approval keeps
      // the composer LIVE (steer while she waits) and a typed send becomes
      // queue-eligible one-deep. Main chat (activeView==='chat') keeps the
      // pre-dock hard lock — this term is false there by construction.
      const dockApprovalSteer = activeApprovalPending
        && state.ui.activeView === 'ide'
        && (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state) === true;
      const currentQueuedSend = state.queuedSendBySession?.get(currentSessionId) || null;
      const queueEligible =
        ownsActiveStream
        && (!activeApprovalPending || dockApprovalSteer)
        && !interactiveBatchActive;
      const hasComposerDraft = Boolean(String(chatInput.value || '').trim())
        || Boolean(Array.isArray(state.attachments?.queued) && state.attachments.queued.length);
      const composerPreferredModelActivity = getActivitySnapshot(ACTIVITY_SCOPE.composerPreferredModel);
      const composerReasoningEffortActivity = getActivitySnapshot(ACTIVITY_SCOPE.composerReasoningEffort);
      const composerRunModeActivity = getActivitySnapshot(ACTIVITY_SCOPE.composerRunMode);
      const composerPrimaryActivity = getMostRecentActivity([ACTIVITY_SCOPE.composerRunMode]);
      // model_unavailable keeps the composer usable: sending IS the retry —
      // the backend re-attempts the configured default model on the next
      // turn (resolveModel), so a failed lazy load never demands a manual
      // model load from Settings. Mirrored in renderer-send-utils.js gates.
      const backendComposerUsable =
        state.backend.phase === 'ready' || state.backend.phase === 'model_unavailable';
      const backendComposerPreparing = [
        'sidecar_spawned', 'model_acquiring', 'model_loading', 'starting', 'retrying',
      ].includes(state.backend.phase);
      const backendComposerOffline = !backendComposerUsable && !backendComposerPreparing;
      chatInput.disabled =
        interactiveBatchActive
        || isSendPreflightPending()
        || pluginSessionReadOnly
        || backendComposerOffline
        || !state.auth.authenticated
        || (activeApprovalPending && !dockApprovalSteer)
        || (sendBusy && !queueEligible);
      sendButton.disabled =
        interactiveBatchActive
        || isSendPreflightPending()
        || pluginSessionReadOnly
        || !state.auth.authenticated
        || !backendComposerUsable
        || (sendBusy && !queueEligible)
        || !hasComposerDraft;
      const visionGate = (globalThis.rendererComposerVisionGate || {}).syncComposerVisionGate?.({
        state, runtimePreferences, sendButton,
        reasonNode: documentRef?.getElementById?.('composerSendDisabledReason'),
        syncDisabledReason, setComposerStatusNotice, clearComposerStatusNotice,
      }) || null;
      if (queueEligible) {
        const queued = !hasComposerDraft && currentQueuedSend;
        sendButton.textContent = `${queued ? 'Queued' : 'Queue'} — runs in ${runModeLabel}`;
        sendButton.setAttribute(
          'aria-label',
          `${queued ? 'Queued follow-up' : 'Queue follow-up prompt'} — runs in ${runModeLabel}`
        );
      } else {
        sendButton.textContent = '\u2191';
        sendButton.setAttribute('aria-label', 'Send');
      }
      sendButton.classList.toggle('composer-send-queue', queueEligible);
      sendButton.classList.toggle('composer-stop', false);
      chatInput.classList.toggle('hidden', interactiveBatchActive);
      sendButton.classList.toggle('hidden', interactiveBatchActive && !sendBusy);
      if (stopStreamButton) {
        const currentSendLifecycle = resolveChatSendLifecycle(currentSessionId);
        const showStopButton = ownsActiveStream || isSendLifecycleInflight(currentSendLifecycle);
        stopStreamButton.classList.toggle('hidden', !showStopButton);
        stopStreamButton.disabled = !ownsActiveStream || isSendPreflightPending();
        setDatasetIfChanged(stopStreamButton, 'sendLifecycle', currentSendLifecycle);
      }
      if (composerWrap) composerWrap.classList.toggle('composer-plugin-read-only', pluginSessionReadOnly);
      if (pluginSessionReadOnly) {
        sendButton.setAttribute('aria-label', 'Chat sending is unavailable in a plugin transcript');
        if (stopStreamButton) stopStreamButton.classList.add('hidden');
      }
      globalThis.rendererPluginSessions?.instance?.syncFallbackNotice?.();
      const composerModelLocked =
        pluginSessionReadOnly
        || !state.auth.authenticated
        || backendComposerOffline
        || isActivityBusy(composerPreferredModelActivity);
      const reasoningEffortUnsupported = composerEffortSelect.dataset.reasoningSupported === 'false';
      if (composerEffortSelectShell) composerEffortSelectShell.hidden = reasoningEffortUnsupported;
      const composerEffortLocked =
        pluginSessionReadOnly
        || !state.auth.authenticated
        || backendComposerOffline
        || reasoningEffortUnsupported
        || isActivityBusy(composerReasoningEffortActivity);
      const composerSettingsLocked = pluginSessionReadOnly
        || !state.auth.authenticated || backendComposerOffline;
      for (const [control, locked] of [
        [composerModelSelect, composerModelLocked],
        [composerEffortSelect, composerEffortLocked],
        [composerSettingsButton, composerSettingsLocked],
      ]) {
        control.disabled = false;
        control.classList.toggle('composer-control-inert', locked);
        // A wrapping <label> shell forwards clicks to the control even through
        // the control's own pointer-events: none — lock the shell with it.
        control.closest?.('.composer-select-shell')?.classList.toggle('composer-control-inert', locked);
        if (locked) {
          control.setAttribute('aria-disabled', 'true');
          control.setAttribute('tabindex', '-1');
        } else {
          control.removeAttribute('aria-disabled');
          control.removeAttribute('tabindex');
        }
      }
      const sharedConfigReason = pluginSessionReadOnly
        ? 'Session controls are unavailable in a plugin transcript.'
        : !state.auth.authenticated
          ? 'Sign in to change session controls.'
          : backendComposerOffline
            ? 'Session controls are unavailable while the local backend is offline.'
            : '';
      syncDisabledReason(
        composerModelSelect,
        documentRef?.getElementById?.('composerModelDisabledReason'),
        isActivityBusy(composerPreferredModelActivity) ? 'The model selection is being saved.' : sharedConfigReason
      );
      syncDisabledReason(
        composerEffortSelect,
        documentRef?.getElementById?.('composerEffortDisabledReason'),
        reasoningEffortUnsupported
          ? 'Reasoning effort is not supported by the selected model.'
          : isActivityBusy(composerReasoningEffortActivity) ? 'The reasoning effort is being saved.' : sharedConfigReason
      );
      syncDisabledReason(
        composerSettingsButton,
        documentRef?.getElementById?.('composerSettingsDisabledReason'),
        sharedConfigReason
      );
      composerModelSelect.value = runtimePreferences.preferredModel;
      syncComposerModelSelectWidth();
      composerEffortSelect.value = runtimePreferences.reasoningEffort;
      globalRef.rendererComposerModelPicker?.instance?.renderIfOpen?.();
      composerV2Render.syncRunModeChip(runModeProjection.runMode, documentRef);
      syncComposerTurnTimer();
      const runModeChip = documentRef?.getElementById?.('composerRunModeChip');
      if (runModeChip) {
        runModeChip.disabled = pluginSessionReadOnly;
        runModeChip.classList.toggle('inv-chip--disabled', pluginSessionReadOnly);
        applyActivityAttributes(runModeChip, composerRunModeActivity);
      }
      composer.classList.toggle('composer-plan-active', runModeProjection.planMode);
      applyActivityAttributes(composerModelSelectShell, composerPreferredModelActivity, { setAriaBusy: true });
      applyActivityAttributes(composerEffortSelectShell, composerReasoningEffortActivity, { setAriaBusy: true });
      applyActivityAttributes(composer, composerPrimaryActivity, { setAriaBusy: true });

      renderComposerInteractivePanel();
      globalRef.rendererSendOutboxRender?.renderSendOutbox?.({
        state,
        host: documentRef?.getElementById('sendOutbox'),
        actions: controllers.sendOutboxActions,
      });
      syncComposerAccessoryVisibility();
      renderComposerEnhancements?.();
      if ((pluginSessionReadOnly || !state.auth.authenticated) && state.ui.composerPopoverOpen) {
        closeComposerPopover();
      }
      syncComposerInputHeight();
      syncComposerVisualState();
      updateComposerSafeOffset();
      renderLiveThinkingChip();
      const shouldRenderVisionNotice = Boolean(visionGate?.notice || visionNoticeShown);
      visionNoticeShown = Boolean(visionGate?.notice);
      if (shouldRenderVisionNotice) renderComposerStatusNotice();
    }


    function renderAll(options) {
      renderLayout();
      syncSurfaceStates();
      renderOriginChip();
      renderHeader();
      if (state.ui.activeView === 'home' || shouldRenderHomePanel()) {
        renderHomePanel();
      }
      renderHero();
      renderPrompts();
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
      if (typeof publishLifecycleStatus === 'function') {
        publishLifecycleStatus();
      }
      if (typeof renderTurnStatusPill === 'function') {
        renderTurnStatusPill();
      }
      if (state.ui.activeView === 'logs') {
        renderLogs();
      }
      renderSettings();
      renderAttachmentTray();
      renderComposerStatusNotice();
      renderToastViewport();
      renderComposerState();
      renderComposerPopover();
      renderCommandPopover();
    }

    return {
      renderLayout,
      renderHeader,
      renderPrompts,
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
      stopFallbackRotation,
    };
  }

  return {
    createChromePipeline,
    syncDisabledReason,
  };
});
