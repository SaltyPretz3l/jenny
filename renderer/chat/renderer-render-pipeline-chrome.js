(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-composer-v2-state'),
      require('./renderer-composer-v2-render'),
      require('./renderer-turn-elapsed-clock'), require('./renderer-hero-model-state')
    );
    return;
  }
  root.rendererRenderPipelineChromeUtils = factory(
    root.rendererComposerV2State,
    root.rendererComposerV2Render,
    root.rendererTurnElapsedClock, root.rendererHeroModelState
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerState, composerV2Render, turnElapsedClock, heroModelState) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const { resolveDefaultTitle } = globalRef.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : {});
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
      jumpToTopButton = null,
      jumpToBottomButton = null,
      jumpToLastPromptButton = null,
      stopStreamButton = null,
      sendButton = null,
      composerModelSelectShell = null,
      composerEffortSelectShell = null,
      chatTimeline = null,
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
      isSendBusy = () => false,
      isSessionStreaming = () => false,
      hasPendingToolApprovalForSession = () => false,
      getPendingQuestionBatch = () => null,
      hasStalePendingQuestionBatch = () => false,
      getActivitySnapshot = () => null,
      getMostRecentActivity = () => null,
      isActivityBusy = () => false,
      applyActivityAttributes = () => {},
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
      if (origin && !hasAssistantReply) {
        chatOriginLabel.textContent = origin;
        chatOriginChip.classList.remove('hidden');
      } else {
        chatOriginChip.classList.add('hidden');
      }
    }

    let resumeSetupButton = null;
    let setupFootnote = null;
    let heroActions = null;
    let heroActionsHtml = '';
    const setHeroText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
    function handleResumeSetup() {
      if (typeof globalRef.jennySetupResume === 'function') globalRef.jennySetupResume();
    }

    function syncHeroSetupAction(show, footnote) {
      const canResume = show && typeof globalRef.jennySetupResume === 'function';
      const actionButton = globalRef.inventoryActionButton;
      const ownerDocument = heroSubtitle?.ownerDocument;
      if (canResume && !resumeSetupButton && ownerDocument && typeof actionButton === 'function') {
        const template = ownerDocument.createElement('template');
        template.innerHTML = actionButton({
          id: 'chat-resume-setup', variant: 'primary', className: 'hero-resume-setup',
          label: jt('chat.pipelineChrome.resumeSetup', 'Resume setup'),
        });
        resumeSetupButton = template.content.firstElementChild;
        resumeSetupButton.addEventListener('click', handleResumeSetup);
        heroSubtitle.after(resumeSetupButton);
      }
      if (show && !setupFootnote && ownerDocument) {
        setupFootnote = ownerDocument.createElement('p');
        setupFootnote.className = 'hero-setup-footnote';
        (resumeSetupButton || heroSubtitle).after(setupFootnote);
      }
      resumeSetupButton?.classList.toggle('hidden', !canResume);
      setHeroText(setupFootnote, footnote);
      setupFootnote?.classList.toggle('hidden', !show || !footnote);
    }

    function setupHeroSubtitle(snapshot) {
      const steps = snapshot.steps;
      if (!steps || typeof steps.workspaceRoot !== 'string'
        || (typeof steps.localModel !== 'string' && typeof steps.endpoint !== 'string')) {
        return jt('chat.pipelineChrome.setupModelAndFolder', 'Choose a model route and a workspace folder to finish.');
      }
      const modelMissing = steps.localModel !== 'done' && steps.endpoint !== 'done';
      const folderMissing = steps.workspaceRoot !== 'done';
      if (modelMissing && folderMissing) {
        return jt('chat.pipelineChrome.setupModelAndFolder', 'Choose a model route and a workspace folder to finish.');
      }
      if (modelMissing) return jt('chat.pipelineChrome.setupModel', 'Choose a model route to finish.');
      if (folderMissing) return jt('chat.pipelineChrome.setupFolder', 'Choose a workspace folder so file tools can work.');
      return jt('chat.pipelineChrome.setupOptionalSteps', 'A few optional steps are left.');
    }

    function renderHero() {
      const paneSessionId = getPaneSessionId();
      const activeSession = state.sessions.find((session) => session.id === paneSessionId);
      const sessionMessages = activeSession ? getVisibleSessionMessages(activeSession.id) : [];
      const hasMessages = sessionMessages.length > 0;
      const heroStage = heroTitle ? heroTitle.closest('.hero-stage') : null;
      const pluginSession = activeSession?.session_type === 'plugin';
      const setupSnapshot = state.setup || {};
      const setupIncomplete = setupSnapshot.loaded === true && setupSnapshot.setupComplete === false;
      const showSetup = !pluginSession && !hasMessages && setupIncomplete;
      heroStage?.classList.toggle('hero-setup-incomplete', showSetup);
      const view = !pluginSession && !hasMessages ? heroModelState.deriveHeroView(state) : null;
      syncHeroSetupAction(showSetup, showSetup ? heroModelState.setupFootnote(view) : '');
      const copy = view && !showSetup ? heroModelState.heroCopy(view) : null;
      if (copy?.actionsHtml && !heroActions && heroSubtitle) {
        heroActions = heroSubtitle.ownerDocument.createElement('div');
        heroActions.className = 'hero-actions';
        heroSubtitle.after(heroActions);
      }
      const actionsHtml = copy?.actionsHtml || '';
      if (heroActions && heroActionsHtml !== actionsHtml) {
        heroActions.innerHTML = actionsHtml;
        heroActionsHtml = actionsHtml;
      }
      heroActions?.classList.toggle('hidden', !actionsHtml);
      if (heroStage && copy) setDatasetIfChanged(heroStage, 'modelState', view.kind);
      else if (heroStage?.hasAttribute('data-model-state')) heroStage.removeAttribute('data-model-state');
      if (heroStage) heroStage.classList.toggle('hero-plugin-session', pluginSession);
      if (pluginSession) {
        if (heroStage) heroStage.classList.toggle('hidden', false);
        setHeroText(heroAvatar, 'J');
        heroAvatar.classList.toggle('hidden', !hasMessages);
        setHeroText(heroTitle, activeSession?.title || jt('chat.chrome.pluginSession', 'Plugin session'));
        setHeroText(heroSubtitle, hasMessages
          ? jt('chat.pipelineChrome.pluginTranscriptReadOnly', 'This saved plugin transcript is read-only in Jenny.')
          : jt('chat.pipelineChrome.openProviderWorkspace', 'Open the provider workspace to begin.'));
        if (heroRuntimeHint) {
          setHeroText(heroRuntimeHint, '');
          heroRuntimeHint.classList.toggle('hidden', true);
        }
        return;
      }
      if (heroStage) heroStage.classList.toggle('hidden', false);
      setHeroText(heroAvatar, 'J');
      heroAvatar.classList.toggle('hidden', !hasMessages);
      if (hasMessages) {
        setHeroText(heroTitle, resolveDefaultTitle(activeSession?.title));
        setHeroText(heroSubtitle, jt('chat.pipelineChrome.continueOrBranch', 'Continue the active conversation or begin a fresh branch.'));
      } else if (setupIncomplete) {
        setHeroText(heroTitle, jt('chat.pipelineChrome.finishSetup', "Let's finish setting up Jenny"));
        setHeroText(heroSubtitle, setupHeroSubtitle(setupSnapshot));
      } else {
        setHeroText(heroTitle, copy.title);
        setHeroText(heroSubtitle, copy.subtitle);
      }
      if (heroRuntimeHint) {
        setHeroText(heroRuntimeHint, copy?.hint || '');
        heroRuntimeHint.classList.toggle('hidden', !copy?.hint);
      }
    }

    function renderLogs() {
      if (logRenderer) {
        logRenderer.renderLogs();
      }
    }

    function renderComposerJumpControls() {
      const messages = getVisibleSessionMessages(getPaneSessionId());
      const hasMessages = messages.length > 0;
      const latestUserMessageId = getLatestUserMessageId(messages);
      const anyJumpButton = jumpToTopButton || jumpToLastPromptButton || jumpToBottomButton;
      const jumpTools = anyJumpButton?.closest('.composer-jump-tools') || null;
      const wayfinderActive = state.ui?.chatWayfinderVisible === true;
      const showJumpTools = hasMessages && !isFollowingLatest() && !wayfinderActive;
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

    function syncComposerTurnTimer() {
      const timer = documentRef?.getElementById?.('composerTurnTimer');
      if (!timer) return;
      const currentSessionId = getPaneSessionId();
      const entry = state.turnClockBySession?.get(currentSessionId) || null;
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

    /* Stable identity: the queue strip short-circuits an unchanged render by
     * comparing its handlers, so a fresh literal per frame would rebuild it. */
    let runtimeQueueActions = null;
    function getRuntimeQueueActions() {
      runtimeQueueActions = runtimeQueueActions || {
        withdraw: (row) => state.runtimeSendController?.withdraw?.(row.key),
        resume: (row) => state.runtimeSendController?.resume?.(row.key),
        restartEngine: (row) => state.runtimeSendController?.restartEngine?.(row.key),
        openChat: (row) => state.runtimeSendController?.openChat?.(row.wait?.blockingSessionId),
      };
      return runtimeQueueActions;
    }

    /* Rows for paused work come from a session-scoped snapshot the poller only
     * reads while something is pending. A conversation whose reply is already
     * paused has nothing pending, so the chrome asks once when the conversation
     * is activated -- never on a keystroke's render, never as a standing poll;
     * the controller's own reads keep the rows fresh while work is in flight. */
    let rowsReadFor = '';
    /* Pause is built beside Stop at boot by renderer-turn-pause-interaction.js
     * through the inventory primitive, after this pipeline exists, so it is
     * resolved on demand and re-resolved if it ever leaves the document. */
    let pauseTurnButton = null;
    function resolvePauseTurnButton() {
      if (pauseTurnButton?.isConnected) return pauseTurnButton;
      pauseTurnButton = stopStreamButton?.parentElement?.querySelector?.('.composer-pause-button') || null;
      return pauseTurnButton;
    }
    function syncPauseTurnButton(currentSessionId, showStop, pauseState) {
      const controller = state.runtimeSendController;
      const runtimeOwnsSends = state.features?.featureFlags?.session_runtime === true
        && typeof controller?.pauseSession === 'function';
      if (runtimeOwnsSends && currentSessionId && currentSessionId !== rowsReadFor
        && typeof controller.refreshSessionRows === 'function') {
        rowsReadFor = currentSessionId;
        Promise.resolve(controller.refreshSessionRows(currentSessionId)).catch(() => {});
      }
      const button = resolvePauseTurnButton();
      if (!button) return;
      // Only a reply the runtime admitted can be paused: an edit, a retry or a
      // legacy stream has no running work behind it, so Pause stays hidden.
      // Nor can a reply that is waiting by itself behind another chat: it is
      // not running, and Stop (which stays) is its way out.
      const show = showStop && runtimeOwnsSends && typeof controller.ownsStream === 'function'
        && controller.ownsStream(state.activeStreamId) === true
        && state.streamWaits?.isWaitingStream?.(state.activeStreamId) !== true;
      button.classList.toggle('hidden', !show);
      if (!show) return;
      // A requested pause is not a pause: the control says only that it was asked for.
      const requested = pauseState?.status === 'requested';
      const label = requested
        ? jt('composer.pauseRequested', 'Pause requested…')
        : jt('composer.pauseReply', 'Pause this reply');
      button.disabled = requested;
      button.title = requested ? label : jt('composer.pauseReplyTitle', 'Pause at the next approval');
      button.setAttribute('aria-label', label);
      if (requested) button.dataset.pauseState = 'requested';
      else delete button.dataset.pauseState;
    }

    // Split view W3-1: a preference save is keyed by the session it saves
    // (activity-utils sessionScope); read this pane's, reported under the bare
    // scope so the shell's data-activity-scope keeps the scope name.
    function getSessionActivitySnapshot(scope, sessionId) {
      const utils = globalRef.activityUtils || (typeof require === 'function' ? require('../shared/activity-utils') : null);
      const snapshot = getActivitySnapshot(typeof utils?.sessionScope === 'function' ? utils.sessionScope(scope, sessionId) : scope);
      return snapshot && snapshot.scope !== scope ? { ...snapshot, scope } : snapshot;
    }

    function renderComposerState() {
      const currentSessionId = getPaneSessionId();
      const activeSession = (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => session?.id === currentSessionId) || null;
      const pluginSessionReadOnly = activeSession?.session_type === 'plugin';
      const sendBusy = isSendBusy();
      const runtimePreferences = getPaneRuntimePreferences();
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
      // Durable Send owns its own pending list; the composer must read as
      // "queued" from either model, never only the legacy one-deep queue.
      const durablePending = state.runtimeSendController?.listPending?.(currentSessionId) || [];
      const runtimeSessionState = state.runtimeSendController?.getSessionRuntimeState?.(currentSessionId) || null;
      const queueEligible =
        ownsActiveStream
        && (!activeApprovalPending || dockApprovalSteer)
        && !interactiveBatchActive;
      const hasComposerDraft = Boolean(String(chatInput.value || '').trim())
        || Boolean(Array.isArray(state.attachments?.queued) && state.attachments.queued.length);
      const composerPreferredModelActivity = getSessionActivitySnapshot(ACTIVITY_SCOPE.composerPreferredModel, currentSessionId);
      const composerReasoningEffortActivity = getSessionActivitySnapshot(ACTIVITY_SCOPE.composerReasoningEffort, currentSessionId);
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
      const view = heroModelState.deriveHeroView(state);
      const copy = heroModelState.heroCopy(view);
      // The hero shows in a pane whose conversation is empty; a split pane may hold a
      // populated chat while pane 0's is empty, so each pane decides for itself.
      const setupBlocksHero = state.setup?.loaded === true && state.setup.setupComplete === false;
      const heroShowingFor = (sessionId) => {
        const id = String(sessionId || '');
        const session = (state.sessions || []).find((entry) => entry.id === id);
        return session?.session_type !== 'plugin' && !setupBlocksHero && getVisibleSessionMessages(id).length === 0;
      };
      const paneVisibility = globalRef.rendererPaneVisibilityUtils
        || (typeof require === 'function' ? require('./renderer-pane-visibility-utils') : null);
      const paneSession = (paneId) => paneVisibility?.resolvePaneSessionId?.(state, paneId) ?? (paneId === 0 ? state.currentSessionId : '');
      const modelLoadingLine = composerV2Render?.describeModelLoading?.(state.backend) || '';
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
        || (!modelLoadingLine && (view.kind === 'noModel' || view.kind === 'downloading'))
        || (sendBusy && !queueEligible)
        || !hasComposerDraft;
      // Status loader F6: the load is told under the input; Send's tooltip
      // re-reads its reason when the flag flips.
      const composerRender = globalThis.rendererComposerV2Render;
      const failureLine = !modelLoadingLine && composerRender?.describeModelFailure?.(state.backend) || '';
      const failureActions = failureLine ? composerRender?.buildModelFailureActions?.(state.backend) || '' : '';
      composerRender?.syncComposerLoadingLines?.(documentRef, (paneId) => (
        copy.composerLine && heroShowingFor(paneSession(paneId)) ? [copy.composerLine, '']
          : failureLine ? [failureLine, failureActions]
            : [modelLoadingLine, ''])); // the load is app-wide; the hero's words only where the hero shows
      setDatasetIfChanged(sendButton, 'modelLoading', modelLoadingLine ? 'true' : 'false');
      const visionGate = (globalThis.rendererComposerVisionGate || {}).syncComposerVisionGate?.({
        state, runtimePreferences, sendButton,
        reasonNode: documentRef?.getElementById?.('composerSendDisabledReason'),
        syncDisabledReason, setComposerStatusNotice, clearComposerStatusNotice,
      }) || null;
      if (queueEligible) {
        const queued = !hasComposerDraft && (currentQueuedSend || durablePending.length > 0);
        sendButton.textContent = queued ? jt('chat.pipelineChrome.queuedRunsIn', 'Queued — runs in {runMode}', { runMode: runModeLabel }) : jt('chat.pipelineChrome.queueRunsIn', 'Queue — runs in {runMode}', { runMode: runModeLabel });
        sendButton.setAttribute(
          'aria-label',
          queued ? jt('chat.pipelineChrome.queuedFollowUpRunsIn', 'Queued follow-up — runs in {runMode}', { runMode: runModeLabel }) : jt('chat.pipelineChrome.queueFollowUpRunsIn', 'Queue follow-up prompt — runs in {runMode}', { runMode: runModeLabel })
        );
      } else {
        sendButton.textContent = '\u2191';
        sendButton.setAttribute('aria-label', jt('chat.pipelineChrome.send', 'Send'));
      }
      sendButton.classList.toggle('composer-send-queue', queueEligible);
      sendButton.classList.toggle('composer-stop', false);
      chatInput.classList.toggle('hidden', interactiveBatchActive);
      sendButton.classList.toggle('hidden', interactiveBatchActive && !sendBusy);
      const currentSendLifecycle = resolveChatSendLifecycle(currentSessionId);
      const showStopButton = ownsActiveStream || isSendLifecycleInflight(currentSendLifecycle);
      if (stopStreamButton) {
        stopStreamButton.classList.toggle('hidden', !showStopButton);
        stopStreamButton.disabled = !ownsActiveStream || isSendPreflightPending();
        setDatasetIfChanged(stopStreamButton, 'sendLifecycle', currentSendLifecycle);
      }
      // Pause lives beside Stop and shares its visibility: there is nothing to
      // pause when no reply of this conversation's is in flight.
      syncPauseTurnButton(currentSessionId, showStopButton && !pluginSessionReadOnly, runtimeSessionState?.pause);
      if (composerWrap) composerWrap.classList.toggle('composer-plugin-read-only', pluginSessionReadOnly);
      if (pluginSessionReadOnly) {
        sendButton.setAttribute('aria-label', jt('chat.pipelineChrome.pluginSendingUnavailable', 'Chat sending is unavailable in a plugin transcript'));
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
      for (const [control, locked] of [
        [composerModelSelect, composerModelLocked],
        [composerEffortSelect, composerEffortLocked],
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
        ? jt('chat.chrome.controlsUnavailablePlugin', 'Session controls are unavailable in a plugin transcript.')
        : !state.auth.authenticated
          ? jt('chat.chrome.signInForControls', 'Sign in to change session controls.')
          : backendComposerOffline
            ? jt('chat.chrome.controlsUnavailableOffline', 'Session controls are unavailable while the local backend is offline.')
            : '';
      syncDisabledReason(
        composerModelSelect,
        documentRef?.getElementById?.('composerModelDisabledReason'),
      isActivityBusy(composerPreferredModelActivity) ? jt('chat.chrome.modelSelectionSaving', 'The model selection is being saved.') : sharedConfigReason
      );
      syncDisabledReason(
        composerEffortSelect,
        documentRef?.getElementById?.('composerEffortDisabledReason'),
        reasoningEffortUnsupported
        ? jt('chat.chrome.reasoningUnsupported', 'Reasoning effort is not supported by the selected model.')
        : isActivityBusy(composerReasoningEffortActivity) ? jt('chat.chrome.reasoningEffortSaving', 'The reasoning effort is being saved.') : sharedConfigReason
      );
      composerModelSelect.value = runtimePreferences.preferredModel;
      composerEffortSelect.dataset.requestedEffort = String(runtimePreferences.reasoningEffort || '');
      composerEffortSelect.value = runtimePreferences.reasoningEffort;
      // No matching option (a conversation switch onto a model without that
      // effort): let the effort control normalize and save it now, not at the
      // next popover open, so a stale effort never rides a send. Once per
      // effort/model pair: a failed save rolls back and re-renders, and must not
      // retry on every render.
      const effortReconcileKey = `${composerEffortSelect.dataset.requestedEffort}\u0000${composerModelSelect.value}`;
      if (composerEffortSelect.value === '' && composerEffortSelect.dataset.reconciledFor !== effortReconcileKey) {
        composerEffortSelect.dataset.reconciledFor = effortReconcileKey;
        globalRef.reasoningEffortControls?.reconcile?.();
      }
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
        actions: controllers.getSendOutboxActions?.(),
      });
      globalRef.rendererRuntimeQueueView?.renderRuntimeQueue?.({
        state,
        host: documentRef?.getElementById('runtimeQueue'),
        // Idle direct Sends retain pending ownership without entering the queue strip.
        rows: durablePending.filter(row => row.queued !== false),
        actions: getRuntimeQueueActions(),
        closing: runtimeSessionState?.closing === true,
      });
      // F20: a send held behind another chat says so where its reply will appear.
      globalRef.rendererAdmissionWaitLine?.syncAdmissionWaitLine?.({
        timeline: chatTimeline,
        state,
        rows: durablePending,
        onOpenChat: (sessionId) => state.runtimeSendController?.openChat?.(sessionId),
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
      // Sibling composer surfaces (the workspace-root nudge) follow the chat
      // switch and busy/idle transitions off this one bubbling event instead
      // of each polling state on its own cadence.
      const CustomEventCtor = chatInput?.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
      if (typeof CustomEventCtor === 'function' && typeof chatInput?.dispatchEvent === 'function') {
        chatInput.dispatchEvent(new CustomEventCtor('composer-state-rendered', { bubbles: true, detail: { sessionId: state.currentSessionId || '' } }));
      }
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
      renderCommandPopover();
    }

    function dispose() {
      resumeSetupButton?.removeEventListener('click', handleResumeSetup);
      resumeSetupButton?.remove();
      setupFootnote?.remove();
      heroActions?.remove();
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
