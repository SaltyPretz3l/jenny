/* renderer/chat/renderer-render-pipeline-chrome-composer.js
 * The composer half of the chrome pipeline: Send/Stop/Pause, the model and
 * effort controls, the turn timer, the queue strip and the jump controls.
 * Split out of renderer-render-pipeline-chrome.js, which composes it. The
 * chrome hands in its document (resolved when the chrome module loads) so a
 * test that reloads the chrome under a fresh window keeps one document.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-composer-v2-state'),
      require('./renderer-composer-v2-render'),
      require('./renderer-turn-elapsed-clock'),
      require('./renderer-hero-model-state')
    );
    return;
  }
  root.rendererRenderPipelineChromeComposer = factory(
    root.rendererComposerV2State,
    root.rendererComposerV2Render,
    root.rendererTurnElapsedClock,
    root.rendererHeroModelState
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerState, composerV2Render, turnElapsedClock, heroModelState) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const { formatElapsedLabel } = turnElapsedClock;
  function syncDisabledReason(control, reasonNode, reason) {
    if (!control || !reasonNode) return;
    const locked = control.disabled === true || control.getAttribute?.('aria-disabled') === 'true';
    const message = locked ? String(reason || '').trim() : '';
    reasonNode.textContent = message;
    if (message) control.setAttribute('aria-describedby', reasonNode.id);
    else control.removeAttribute('aria-describedby');
  }
  function createComposerChrome(deps) {
    const {
      state,
      constants = {},
      dom = {},
      controllers = {},
      callbacks = {},
      documentRef = null,
      getPaneSessionId,
      isFollowingLatest,
      getPaneRuntimePreferences,
      setDatasetIfChanged,
      syncComposerVisualState,
    } = deps;
    const { ACTIVITY_SCOPE = {} } = constants;
    const {
      chatInput = null,
      composer = null,
      composerModelSelect = null,
      composerEffortSelect = null,
      composerWrap = null,
      jumpToTopButton = null,
      jumpToBottomButton = null,
      stopStreamButton = null,
      sendButton = null,
      composerModelSelectShell = null,
      composerEffortSelectShell = null,
      chatTimeline = null,
    } = dom;
    const {
      renderComposerStatusNotice = () => {},
      setComposerStatusNotice = () => {},
      clearComposerStatusNotice = () => {},
      getVisibleSessionMessages = () => [],
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
      updateComposerSafeOffset = () => {},
      renderLiveThinkingChip = () => {},
      renderComposerEnhancements = null,
      resolveChatSendLifecycle = () => 'idle',
      isSendPreflightPending = () => false,
      syncTurnElapsedClock = () => {},
    } = callbacks;

    let visionNoticeShown = false;

    function isSendLifecycleInflight(lifecycle) {
      return lifecycle === 'preflight' || lifecycle === 'streaming' || lifecycle === 'settling';
    }

    // The bottom-edge control is one circle, shown only once the reader has left the live end: first unread when
    // the wayfinder's model names this pane's session, otherwise "Latest". The wayfinder's own "latest" is not a
    // pick: the top button stays available beside it.
    const LATEST_JUMP = Object.freeze({ visible: true, state: 'latest', label: '' });

    function getWayfinderPick() {
      const published = state.ui?.chatWayfinder;
      if (jumpToBottomButton?.dataset.jumpLatestOnly === 'true') return null; // a second pane has no wayfinder
      return published?.visible === true && published.state !== 'latest'
        && String(published.sessionId || '') === String(getPaneSessionId() || '') ? published : null;
    }


    function syncJumpPill(button, model) {
      if (!model) return;
      const kind = model.state;
      const isLatest = kind === 'latest';
      const name = isLatest ? jt('chat.wayfinder.returnToLatest', 'Return to latest') : String(model.label || '');
      if (button.dataset.jumpState !== kind) button.dataset.jumpState = kind;
      if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
      // data-tooltip, not title: the tooltip system deletes title on hover, and each render would restore it.
      if (button.getAttribute('data-tooltip') !== name) {
        button.setAttribute('data-tooltip', name);
        globalThis.inventoryTooltip?.refresh?.(button); // the tooltip is the only words: one left open must not go stale
      }
    }

    function renderComposerJumpControls() {
      const messages = getVisibleSessionMessages(getPaneSessionId());
      const hasMessages = messages.length > 0;
      const anyJumpButton = jumpToTopButton || jumpToBottomButton;
      const jumpTools = anyJumpButton?.closest('.composer-jump-tools') || null;
      const awayFromLatest = hasMessages && !isFollowingLatest();
      const jumpModel = awayFromLatest ? getWayfinderPick() || LATEST_JUMP : null;
      const showJumpTools = jumpModel === LATEST_JUMP;

      if (jumpTools) {
        jumpTools.classList.toggle('hidden', !showJumpTools);
        jumpTools.setAttribute('aria-hidden', showJumpTools ? 'false' : 'true');
      }
      if (jumpToTopButton) jumpToTopButton.disabled = !hasMessages;
      if (jumpToBottomButton) {
        const showJump = Boolean(jumpModel);
        jumpToBottomButton.disabled = !hasMessages;
        syncJumpPill(jumpToBottomButton, jumpModel);
        const visible = String(showJump);
        if (!showJump && jumpToBottomButton.matches?.(':hover')) globalThis.inventoryTooltip?.hide?.(); // no mouseleave once it fades
        if (jumpToBottomButton.dataset.visible !== visible) jumpToBottomButton.dataset.visible = visible; // runs per scroll frame
        // Keep focus off the hidden button.
        if (!showJump && documentRef?.activeElement === jumpToBottomButton) chatInput?.focus?.();
        jumpToBottomButton.toggleAttribute('inert', !showJump);
      }
    }

    function syncComposerAccessoryVisibility() {
      renderComposerJumpControls();
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
        putDraft: (texts) => globalRef.rendererRuntimeQueueView?.putBackInComposer?.(chatInput, texts),
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
      // the Workspace dock is the live chat surface, a typed send during a
      // pending approval becomes queue-eligible one-deep. Elsewhere Send waits.
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
        || (sendBusy && !queueEligible && !activeApprovalPending); // the draft stays editable while deciding
      sendButton.disabled =
        interactiveBatchActive
        || isSendPreflightPending()
        || pluginSessionReadOnly
        || !state.auth.authenticated
        // While the engine starts, Send queues into the outbox (renderer-send-utils.js).
        || !(backendComposerUsable || (backendComposerPreparing && Boolean(currentSessionId)))
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
      // Option C: a queued send is its own greyed bubble in the conversation;
      // the strip keeps only what has no bubble there.
      const inBubbles = globalRef.rendererRuntimeQueueView?.syncQueuedBubbles?.({
        timeline: chatTimeline,
        rows: durablePending,
        actions: getRuntimeQueueActions(),
        closing: runtimeSessionState?.closing === true,
      }) || new Set();
      globalRef.rendererRuntimeQueueView?.renderRuntimeQueue?.({
        state,
        host: documentRef?.getElementById('runtimeQueue'),
        // Idle direct Sends retain pending ownership without entering the queue strip.
        rows: durablePending.filter(row => row.queued !== false && !inBubbles.has(row.key)),
        actions: getRuntimeQueueActions(),
        closing: runtimeSessionState?.closing === true,
      });
      // F20: a send held behind another chat says so where its reply will appear.
      globalRef.rendererAdmissionWaitLine?.syncAdmissionWaitLine?.({
        timeline: chatTimeline,
        state,
        rows: durablePending,
        onOpenChat: (sessionId) => state.runtimeSendController?.openChat?.(sessionId),
        onStopChat: (sessionId) => state.runtimeSendController?.stopChat?.(sessionId),
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

    return {
      renderComposerState,
      renderComposerJumpControls,
      syncComposerAccessoryVisibility,
    };
  }

  return { createComposerChrome, syncDisabledReason };
});
