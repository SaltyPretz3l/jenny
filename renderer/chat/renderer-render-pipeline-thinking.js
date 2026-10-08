(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineThinkingUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const windowRef = globalRef.window || globalRef;
  const turnShellUtils = globalRef.rendererTurnShell
    || (typeof require === 'function' ? require('./renderer-turn-shell') : null)
    || {};
  const chatThinkingUtils = globalRef.chatThinkingUtils
    || (typeof require === 'function' ? require('./chat-thinking-utils') : null)
    || {};
  const terminalStatusVocabulary = globalRef.chatTerminalStatusVocabulary
    || (typeof require === 'function' ? require('./chat-terminal-status-vocabulary') : null)
    || {};
  const spriteActivityUtils = globalRef.rendererSpriteActivity
    || (typeof require === 'function' ? require('./renderer-sprite-activity') : null)
    || {};
  const spriteMorphUtils = globalRef.rendererSpriteMorph
    || (typeof require === 'function' ? require('./renderer-sprite-morph') : null)
    || {};
  const warningSpriteStatuses = new Set([
    terminalStatusVocabulary.CANCELLED_STATUS || 'cancelled',
    terminalStatusVocabulary.DENIED_STATUS || 'denied',
    terminalStatusVocabulary.PREEMPTED_STATUS || 'preempted',
    terminalStatusVocabulary.INTERRUPTED_STATUS || 'interrupted',
  ]);
  const errorSpriteStatuses = new Set([
    terminalStatusVocabulary.ERROR_STATUS || 'error',
    terminalStatusVocabulary.TIMEOUT_STATUS || 'timeout',
    terminalStatusVocabulary.UNKNOWN_STATUS || 'unknown',
  ]);
  // Calm recovery classes (mirrors resolveErrorSeverity in
  // renderer-error-recovery-utils.js, which this pipeline does not load): a
  // stop the person or Jenny's own closing caused is the square stopped dot,
  // never the red "!" (live gate F9 recheck, 2026-10-05).
  const calmRecoveryClasses = new Set(['app_restart', 'app_restart_rerun', 'run_mode_changed', 'cancelled', 'denied']);
  function createThinkingPipeline(deps) {
    const {
      state,
      constants = {},
      dom = {},
      controllers = {},
      runtime = {},
      callbacks = {},
    } = deps || {};
    const { MESSAGE_STATUS = {} } = constants;
    const {
      chatTimeline = null,
      chatThreadColumn = null,
      chatSpriteLayer = null,
      chatAssistantSprite = null,
    } = dom;
    const {
      thinkingIndicator = null,
      // This pane's durable send controller (pane 0's is the state slot).
      getRuntimeSendController = () => state?.runtimeSendController || null,
    } = controllers;
    const {
      spriteRuntime = { frameHandle: 0, targetMessageId: '', targetY: 0 },
    } = runtime;
    const {
      getCurrentSessionMessages = () => [],
      // Split view W1-4a: this pane's session and its messages (one pane: current).
      getPaneSessionId = () => String(state?.currentSessionId || '').trim(),
      getSessionMessages = () => getCurrentSessionMessages?.(),
      getLatestUserMessageId = () => '',
      getLatestAssistantMessageId = () => '',
      escapeSelectorValue = (value) => String(value || ''),
    } = callbacks;
    const requestFrame = deps?.requestAnimationFrame
      || (typeof globalRef.requestAnimationFrame === 'function'
        ? globalRef.requestAnimationFrame.bind(globalRef)
        : null)
      || (typeof windowRef.requestAnimationFrame === 'function'
        ? windowRef.requestAnimationFrame.bind(windowRef)
        : null);
    const cancelFrame = deps?.cancelAnimationFrame
      || (typeof globalRef.cancelAnimationFrame === 'function'
        ? globalRef.cancelAnimationFrame.bind(globalRef)
        : null)
      || (typeof windowRef.cancelAnimationFrame === 'function'
        ? windowRef.cancelAnimationFrame.bind(windowRef)
        : null);
    const resolveVisibleMessageDomTarget = typeof turnShellUtils.resolveVisibleMessageDomTarget === 'function'
      ? turnShellUtils.resolveVisibleMessageDomTarget
      : function fallbackResolveVisibleMessageDomTarget(container, messageId) {
        const normalizedMessageId = String(messageId || '').trim();
        if (!container || !normalizedMessageId || typeof container.querySelector !== 'function') {
          return null;
        }
        return container.querySelector(
          `[data-message-id="${escapeSelectorValue(normalizedMessageId)}"]`
        );
      };

    const SPRITE_NON_CONTENT_KINDS = new Set(['tool_use', 'tool_result']);
    let disposed = false;
    spriteRuntime.sessionId = getPaneSessionId();
    let positionRequestVersion = 0;
    function normalizeSpritePhase(message) {
      const status = String(message?.status || '').trim().toLowerCase();
      const terminalStatus = String(
        message?.terminal_status
        || message?.terminalStatus
        || message?.recovery_class
        || ''
      ).trim().toLowerCase();
      const normalizeTerminalStatus = terminalStatusVocabulary.normalizeTerminalStatus;
      const canonicalTerminalStatus = typeof normalizeTerminalStatus === 'function'
        ? normalizeTerminalStatus(terminalStatus)
        : terminalStatus;
      const canonicalRowStatus = typeof normalizeTerminalStatus === 'function'
        ? normalizeTerminalStatus(status)
        : status;
      if (
        warningSpriteStatuses.has(canonicalTerminalStatus)
        || warningSpriteStatuses.has(canonicalRowStatus)
      ) {
        return 'cancelled';
      }
      if (calmRecoveryClasses.has(String(message?.recovery_class || '').trim().toLowerCase())) {
        return 'cancelled';
      }
      if (
        errorSpriteStatuses.has(canonicalTerminalStatus)
        || errorSpriteStatuses.has(canonicalRowStatus)
      ) {
        return 'error';
      }
      if (canonicalRowStatus === (terminalStatusVocabulary.STREAMING_STATUS || 'streaming')) {
        return 'live';
      }
      return 'complete';
    }
    const spriteTracker = spriteActivityUtils.createSpriteActivityTracker();
    const spriteMorph = chatAssistantSprite
      ? spriteMorphUtils.createSpriteMorph(chatAssistantSprite)
      : null;
    const {
      createHiddenSpriteState,
      createVisibleSpriteState,
      applySpriteViewState,
    } = spriteActivityUtils.createSpriteViewApplier({
      chatSpriteLayer,
      chatAssistantSprite,
      spriteRuntime,
      normalizeSpritePhase,
      morph: spriteMorph,
      isDisposed: () => disposed,
      onHidden: () => {
        spriteTracker.invalidate();
        if (!getActiveThinkingStreamState().activeStreamId) clearLiveReasoningShimmer(); // keep a live row's shimmer
      },
    });
    // state.streamWaits is created after this pipeline and can be replaced or nulled later.
    let typedActivitySource = null;
    let unsubscribeTypedActivity = null;
    function syncTypedActivitySubscription() {
      const next = state?.streamWaits || null;
      if (next === typedActivitySource) return;
      unsubscribeTypedActivity?.();
      typedActivitySource = next;
      unsubscribeTypedActivity = next?.onTypedActivityChange?.((event) => {
        if (String(event?.sessionId || '').trim() === getPaneSessionId()) updateAssistantSpritePosition();
      }) || null;
    }

    function getActiveThinkingStreamState(messages) {
      const currentSessionId = getPaneSessionId();
      const multiStreamController = globalThis.rendererMultiStreamController || null;
      const currentMessagesCandidate = messages === undefined
        ? getSessionMessages(currentSessionId)
        : messages;
      const currentSessionMessages = Array.isArray(currentMessagesCandidate) ? currentMessagesCandidate : [];
      let latestStreamingMessageStreamId = '';
      for (let index = currentSessionMessages.length - 1; index >= 0; index -= 1) {
        const message = currentSessionMessages[index];
        if (String(message?.status || '').trim() === MESSAGE_STATUS.STREAMING) {
          latestStreamingMessageStreamId = String(message?.streamId || '').trim();
          if (latestStreamingMessageStreamId) {
            break;
          }
        }
      }
      let fallbackThinkingStreamId = '';
      const thinkingStatusMap = state?.streamThinkingStatusByStream;
      if (currentSessionId && thinkingStatusMap?.size && typeof thinkingStatusMap.entries === 'function') {
        for (const [candidateStreamId] of thinkingStatusMap.entries()) {
          const mappedSessionId = String(
            multiStreamController?.getSessionIdForStream?.(candidateStreamId) || ''
          ).trim();
          if (mappedSessionId && mappedSessionId === currentSessionId) {
            fallbackThinkingStreamId = String(candidateStreamId || '').trim();
            break;
          }
        }
      }
      const activeStreamId = String(
        (currentSessionId && multiStreamController?.getStreamIdForSession?.(currentSessionId))
        || (currentSessionId
          && String(state?.activeStreamSessionId || '').trim() === currentSessionId
          && String(state?.activeStreamId || '').trim())
        || (currentSessionId && multiStreamController?.getPreflight?.(currentSessionId)?.streamId)
        || latestStreamingMessageStreamId
        || fallbackThinkingStreamId
      ).trim();
      const statusEntry = activeStreamId
        ? thinkingStatusMap?.get?.(activeStreamId)
        : null;
      const thinkingText = statusEntry
        ? (typeof statusEntry === 'object' ? String(statusEntry.text || '') : String(statusEntry || '')).trim()
        : '';
      const thinkingId = statusEntry && typeof statusEntry === 'object' ? String(statusEntry.thinkingId || '') : '';
      return {
        activeStreamId,
        thinkingText,
        thinkingId,
      };
    }

    function isThinkingIndicatorActive(indicatorState) {
      const mode = String(indicatorState?.mode || '').trim();
      return Boolean(
        mode
        && mode !== 'idle'
        && (
          indicatorState.shouldShow === true
          || indicatorState.shimmerActive === true
          || indicatorState.durationText
        )
      );
    }

    function hasRenderableAssistantContent(message) {
      const kind = String(message?.kind || '').trim();
      if (String(message?.role || '').trim() !== 'assistant' || SPRITE_NON_CONTENT_KINDS.has(kind)) {
        return false;
      }
      return Boolean(
        String(message?.content || '').trim()
        || (
          Array.isArray(message?.reasoning?.entries)
          && message.reasoning.entries.length
        )
      );
    }

    function resolveAssistantSpriteAnchor(messages, latestAssistantMessageId, idToIndex) {
      const latestAssistantId = String(latestAssistantMessageId || '').trim();
      if (!latestAssistantId) {
        return { message: null, hasCurrentTurnAssistant: false };
      }
      const indexedAssistantPosition = idToIndex?.has?.(latestAssistantId)
        ? Number(idToIndex.get(latestAssistantId))
        : -1;
      const latestAssistantPosition = Number.isInteger(indexedAssistantPosition)
        && indexedAssistantPosition >= 0
        ? indexedAssistantPosition
        : messages.findIndex((message) => String(message?.id || '').trim() === latestAssistantId);
      if (latestAssistantPosition < 0) {
        return { message: null, hasCurrentTurnAssistant: false };
      }

      let latestUserPosition = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (String(messages[index]?.role || '').trim() === 'user') {
          latestUserPosition = index;
          break;
        }
      }
      const latestAssistantMessage = messages[latestAssistantPosition] || null;
      const hasCurrentTurnAssistant = latestAssistantPosition > latestUserPosition;
      if (!hasCurrentTurnAssistant) {
        return { message: latestAssistantMessage, hasCurrentTurnAssistant: false };
      }

      // Tool-loop plumbing may become the newest assistant message even though
      // its visual rows belong to the same active turn. Keep the rail sprite on
      // the newest prose/reasoning anchor in that turn instead of bouncing to
      // the prompt or between transient tool rows. A tool-only first phase still
      // anchors to its assistant article until prose exists.
      for (let index = latestAssistantPosition; index > latestUserPosition; index -= 1) {
        if (hasRenderableAssistantContent(messages[index])) {
          return { message: messages[index], hasCurrentTurnAssistant: true };
        }
      }
      return { message: latestAssistantMessage, hasCurrentTurnAssistant: true };
    }

    function clearLiveReasoningShimmer() {
      if (typeof chatThinkingUtils.clearLiveReasoningShimmer === 'function') {
        chatThinkingUtils.clearLiveReasoningShimmer(chatTimeline);
      }
    }

    function renderLiveThinkingChip(thinkingState = null, activeMessageId = '') {
      if (disposed) return;
      const { activeStreamId, thinkingText, thinkingId } = thinkingState
        || getActiveThinkingStreamState();
      const labelOptions = {
        thinkingText, thinkingId, activeMessageId, escapeSelectorValue,
      };
      chatThinkingUtils.syncLiveReasoningStatusLabel?.(chatTimeline, labelOptions);
      const activeRow = chatThinkingUtils.resolveLiveReasoningStatusRow?.(chatTimeline, labelOptions);
      const activeLabel = String(thinkingText || '').trim()
        ? activeRow?.querySelector?.('.reasoning-row-main') : null;
      // Unchanged-token classList add/remove still queues a mutation record (observer loop).
      const promoted = chatTimeline?.querySelectorAll?.('.reasoning-row-main--live-status') || [];
      for (const label of promoted) {
        if (label !== activeLabel) label.classList.remove('reasoning-row-main--live-status');
      }
      if (activeLabel && !activeLabel.classList.contains('reasoning-row-main--live-status')) {
        activeLabel.classList.add('reasoning-row-main--live-status');
      }

      const indicatorState = thinkingIndicator ? thinkingIndicator.getDisplayState() : null;
      if (
        thinkingIndicator
        && indicatorState
        && indicatorState.mode !== 'idle'
        && !activeStreamId
        && !String(thinkingText || '').trim()
      ) {
        thinkingIndicator.resetIndicator();
        return;
      }

      if (
        indicatorState
        && indicatorState.mode === 'idle'
        && !activeStreamId
        && !String(thinkingText || '').trim()
        && indicatorState.shouldAutoHide
      ) {
        controllers.thinkingController?.autoCollapseAll?.();
        thinkingIndicator.resetIndicator();
        clearLiveReasoningShimmer();
      }
    }

    function hideAssistantSprite({ clearTarget = false, reason = 'hidden' } = {}) {
      applySpriteViewState(createHiddenSpriteState({ clearTarget, reason }));
    }

    function applyAssistantSprite(targetMessage, targetY, thinkingState = null, spriteActivity = '') {
      if (!chatSpriteLayer || !chatAssistantSprite || !targetMessage) {
        hideAssistantSprite({ reason: 'missing_target' });
        return;
      }
      applySpriteViewState(createVisibleSpriteState(targetMessage, targetY, spriteActivity));
      renderLiveThinkingChip(thinkingState, targetMessage.id);
    }

    function updateAssistantSpritePosition(messages, derivedState) {
      if (disposed) {
        return;
      }
      syncTypedActivitySubscription();
      const sessionId = getPaneSessionId();
      if (messages === undefined) {
        messages = getSessionMessages(sessionId);
      }
      messages = Array.isArray(messages) ? messages : [];
      positionRequestVersion += 1;
      const requestVersion = positionRequestVersion;
      if (spriteRuntime.sessionId !== sessionId) {
        spriteRuntime.sessionId = sessionId;
        hideAssistantSprite({ clearTarget: true, reason: 'session_changed' });
      }
      if (spriteRuntime.frameHandle) {
        cancelFrame?.(spriteRuntime.frameHandle);
        spriteRuntime.frameHandle = 0;
      }

      const positionSprite = () => {
        if (disposed || requestVersion !== positionRequestVersion) {
          return;
        }
        spriteRuntime.frameHandle = 0;
        if (sessionId !== getPaneSessionId()) {
          hideAssistantSprite({ clearTarget: true, reason: 'session_changed' });
          return;
        }

        const uiState = state?.ui || {};
        if (
          !chatTimeline
          || !chatThreadColumn
          || !chatSpriteLayer
          || !chatAssistantSprite
          || uiState.activeView !== 'chat'
          || uiState.chatMode !== 'thread'
        ) {
          const offThreadMode = uiState.activeView === 'chat' && uiState.chatMode !== 'thread';
          hideAssistantSprite({
            clearTarget: offThreadMode,
            reason: offThreadMode ? 'non_thread_mode' : 'inactive_view',
          });
          return;
        }

        const nextTargetId = derivedState
          ? derivedState.latestAssistantMessageId
          : getLatestAssistantMessageId(messages);
        const thinkingState = getActiveThinkingStreamState(messages);
        const indicatorState = thinkingIndicator && typeof thinkingIndicator.getDisplayState === 'function'
          ? thinkingIndicator.getDisplayState()
          : null;
        const indicatorActive = isThinkingIndicatorActive(indicatorState);
        const sendPreflightActive = Boolean(
          globalThis.rendererMultiStreamController?.getPreflight?.(sessionId)?.pending
          || spriteActivityUtils.findPaneAdmissionWait(
            { state, runtimeSendController: getRuntimeSendController() }, sessionId, messages)
        );
        const candidateIndex = derivedState?.idToIndex;
        const idToIndex = candidateIndex
          && typeof candidateIndex.has === 'function'
          && typeof candidateIndex.get === 'function'
          ? candidateIndex
          : null;
        const assistantAnchor = resolveAssistantSpriteAnchor(messages, nextTargetId, idToIndex);
        const assistantTargetMessage = assistantAnchor.message;
        const hasActiveSendAnchor = Boolean(
          thinkingState.thinkingText
          || thinkingState.activeStreamId
          || indicatorActive
          || sendPreflightActive
        );
        const fallbackTargetId = sendPreflightActive && !assistantAnchor.hasCurrentTurnAssistant
          ? getLatestUserMessageId(messages)
          : '';
        const usingThinkingFallback = Boolean(fallbackTargetId);
        const resolvedTargetId = usingThinkingFallback
          ? fallbackTargetId
          : String(assistantTargetMessage?.id || '').trim();
        if (!resolvedTargetId) {
          hideAssistantSprite({ clearTarget: true, reason: 'empty_thread' });
          return;
        }

        const baseTargetMessage = usingThinkingFallback
          ? (idToIndex && idToIndex.has(resolvedTargetId)
            ? messages[idToIndex.get(resolvedTargetId)]
            : messages.find((message) => message?.id === resolvedTargetId))
          : assistantTargetMessage;
        const targetNode = resolveVisibleMessageDomTarget(chatTimeline, resolvedTargetId, {
          preferRow: !usingThinkingFallback,
          rowKind: !usingThinkingFallback ? 'assistant_text' : '',
        });
        if (!baseTargetMessage || !targetNode) {
          hideAssistantSprite({ reason: 'missing_target' });
          return;
        }

        const spriteDisplay = windowRef.getComputedStyle?.(chatSpriteLayer)?.display || '';
        if (spriteDisplay === 'none') {
          hideAssistantSprite({ reason: 'responsive_hidden' });
          return;
        }

        const layerRect = chatSpriteLayer.getBoundingClientRect?.();
        const targetRect = targetNode.getBoundingClientRect?.();
        if (!layerRect || !targetRect) {
          hideAssistantSprite({ reason: 'missing_geometry' });
          return;
        }
        let targetYValue = Math.max(targetRect.top - layerRect.top, 0);
        if (usingThinkingFallback) {
          const bubbleNode = targetNode.querySelector?.('.chat-bubble') || targetNode;
          const bubbleRect = bubbleNode.getBoundingClientRect?.() || targetRect;
          const timelineStyle = windowRef.getComputedStyle?.(chatTimeline) || {};
          const rawGap = String(timelineStyle.rowGap || timelineStyle.gap || '').trim();
          const parsedGap = Number.parseFloat(rawGap);
          const laneOffset = Number.isFinite(parsedGap)
            ? Math.max(parsedGap * 0.5, 12)
            : 20;
          targetYValue = Math.max((bubbleRect.bottom - layerRect.top) + laneOffset, 0);
        }
        const spriteRect = chatAssistantSprite.getBoundingClientRect?.();
        const layerHeight = Math.max(Number(layerRect.height) || (layerRect.bottom - layerRect.top), 0);
        const spriteHeight = Math.max(Number(spriteRect?.height) || 0, 0);
        if (layerHeight > 0 && spriteHeight > 0) {
          targetYValue = Math.min(targetYValue, Math.max(layerHeight - spriteHeight, 0));
        }
        const resolvedLatestAssistantId = String(nextTargetId || '').trim();
        const anchorIsTerminalLatestContent = Boolean(
          resolvedTargetId === resolvedLatestAssistantId
          && hasRenderableAssistantContent(baseTargetMessage)
          && normalizeSpritePhase(baseTargetMessage) !== 'live'
        );
        // Geometry follows prose, but the newest assistant row owns the outcome.
        const latestMessage = messages.find((message) => message?.id === resolvedLatestAssistantId);
        const outcomeMessage = assistantAnchor.hasCurrentTurnAssistant && latestMessage
          ? latestMessage : baseTargetMessage;
        const terminalOutcome = ['error', 'cancelled'].includes(normalizeSpritePhase(outcomeMessage));
        const targetMessage = !terminalOutcome && (usingThinkingFallback || (
          hasActiveSendAnchor
          && assistantAnchor.hasCurrentTurnAssistant
          && !anchorIsTerminalLatestContent
        ))
          ? {
            ...baseTargetMessage,
            status: MESSAGE_STATUS.STREAMING,
            streamId: String(
              thinkingState.activeStreamId
              || assistantTargetMessage?.streamId
              || baseTargetMessage.streamId
              || ''
            ).trim(),
          }
          : { ...outcomeMessage, id: baseTargetMessage.id };
        const { activity: spriteActivity } = spriteTracker.derive(
          spriteActivityUtils.gatherSpriteActivityInput({ state, runtimeSendController: getRuntimeSendController() }, sessionId, {
            messages,
            streamId: targetMessage.streamId,
            status: baseTargetMessage.status,
            outcome: normalizeSpritePhase(outcomeMessage),
          }),
          { turnKey: `${sessionId}|${getLatestUserMessageId(messages)}`, visible: true },
        );
        applyAssistantSprite(targetMessage, targetYValue, thinkingState, spriteActivity);
      };

      if (typeof requestFrame === 'function') {
        spriteRuntime.frameHandle = requestFrame(positionSprite);
      } else {
        positionSprite();
      }
    }

    // Reconcile from current session data after layout or virtualizer changes;
    // no polling deadline and no stale message snapshot retained by a retry.
    const reconcileLayout = () => {
      if (!disposed && state?.ui?.activeView === 'chat') updateAssistantSpritePosition();
    };
    const resizeObserver = typeof windowRef.ResizeObserver === 'function'
      ? new windowRef.ResizeObserver(reconcileLayout) : null;
    if (chatThreadColumn) resizeObserver?.observe(chatThreadColumn);
    if (chatTimeline) resizeObserver?.observe(chatTimeline);
    const mountObserver = typeof windowRef.MutationObserver === 'function'
      ? new windowRef.MutationObserver(reconcileLayout) : null;
    if (chatTimeline) mountObserver?.observe(chatTimeline, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'open', 'class', 'style'],
    });
    chatTimeline?.addEventListener?.('load', reconcileLayout, true);
    windowRef.addEventListener?.('resize', reconcileLayout);

    function dispose() {
      if (disposed) {
        return;
      }
      resizeObserver?.disconnect();
      mountObserver?.disconnect();
      chatTimeline?.removeEventListener?.('load', reconcileLayout, true);
      windowRef.removeEventListener?.('resize', reconcileLayout);
      unsubscribeTypedActivity?.();
      hideAssistantSprite({ clearTarget: true, reason: 'disposed' });
      spriteMorph?.dispose();
      disposed = true;
      positionRequestVersion += 1;
      if (spriteRuntime.frameHandle) {
        cancelFrame?.(spriteRuntime.frameHandle);
        spriteRuntime.frameHandle = 0;
      }
    }

    return {
      renderLiveThinkingChip,
      hideAssistantSprite,
      updateAssistantSpritePosition,
      dispose,
    };
  }

  return {
    createThinkingPipeline,
  };
});
