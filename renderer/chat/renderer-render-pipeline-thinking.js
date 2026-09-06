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
    } = controllers;
    const {
      spriteRuntime = { frameHandle: 0, targetMessageId: '', visible: false, streaming: false, currentY: 0, targetY: 0 },
    } = runtime;
    const {
      getCurrentSessionMessages = () => [],
      getLatestUserMessageId = () => '',
      getLatestAssistantMessageId = () => '',
      escapeSelectorValue = (value) => String(value || ''),
      isSendPreflightPending = () => false,
      setSpriteHoloState = () => {},
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

    const SPRITE_REANCHOR_RETRY_LIMIT = 2;
    const SPRITE_NON_CONTENT_KINDS = new Set(['tool_use', 'tool_result']);
    let disposed = false;
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
    function createHiddenSpriteState({ clearTarget = false, reason = 'hidden' } = {}) {
      return {
        visible: false,
        targetMessageId: clearTarget ? '' : String(spriteRuntime.targetMessageId || ''),
        targetY: Math.round(Number(spriteRuntime.targetY || 0)),
        status: '',
        phase: 'hidden',
        suppressionReason: String(reason || 'hidden'),
      };
    }

    function createVisibleSpriteState(targetMessage, targetY) {
      return {
        visible: true,
        targetMessageId: String(targetMessage?.id || ''),
        targetY: Math.round(Math.max(Number(targetY) || 0, 0)),
        status: String(targetMessage?.status || ''),
        phase: normalizeSpritePhase(targetMessage),
        suppressionReason: '',
      };
    }

    function sameSpriteState(left, right) {
      return Boolean(
        left
        && right
        && left.visible === right.visible
        && left.targetMessageId === right.targetMessageId
        && left.targetY === right.targetY
        && left.status === right.status
        && left.phase === right.phase
        && left.suppressionReason === right.suppressionReason
      );
    }

    function syncSpriteHolo(nextState) {
      const live = nextState?.visible === true && nextState.phase === 'live';
      setSpriteHoloState(live, live ? 'inference' : 'idle');
    }

    function applySpriteViewState(nextState, { refreshHolo = false } = {}) {
      if (disposed || !chatSpriteLayer || !chatAssistantSprite || !nextState) {
        return false;
      }
      const previousState = spriteRuntime.viewState || null;
      if (sameSpriteState(previousState, nextState)) {
        if (refreshHolo) {
          syncSpriteHolo(nextState);
        }
        return false;
      }

      spriteRuntime.viewState = { ...nextState };
      spriteRuntime.visible = nextState.visible;
      spriteRuntime.streaming = nextState.phase === 'live';
      spriteRuntime.targetMessageId = nextState.targetMessageId;
      spriteRuntime.targetY = nextState.targetY;
      spriteRuntime.currentY = nextState.targetY;

      if (!nextState.visible) {
        chatSpriteLayer.classList.remove('visible');
        chatSpriteLayer.dataset.suppressionReason = nextState.suppressionReason;
        chatAssistantSprite.classList.remove('is-streaming');
        chatAssistantSprite.dataset.status = '';
        chatAssistantSprite.dataset.spriteState = 'hidden';
        syncSpriteHolo(nextState);
        clearLiveReasoningShimmer();
        return true;
      }

      chatAssistantSprite.style.transform = `translate3d(0, ${nextState.targetY}px, 0)`;
      chatAssistantSprite.classList.toggle('is-streaming', nextState.phase === 'live');
      chatAssistantSprite.dataset.status = nextState.status;
      chatAssistantSprite.dataset.spriteState = nextState.phase;
      delete chatSpriteLayer.dataset.suppressionReason;
      chatSpriteLayer.classList.add('visible');
      syncSpriteHolo(nextState);
      return true;
    }

    function getActiveThinkingStreamState(messages) {
      const currentSessionId = String(state?.currentSessionId || '').trim();
      const multiStreamController = globalThis.rendererMultiStreamController || null;
      const currentMessagesCandidate = messages === undefined
        ? getCurrentSessionMessages?.()
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

    function syncLiveReasoningStatusLabel(thinkingText, thinkingId, activeMessageId = '') {
      if (!chatTimeline || !thinkingId) return;
      const cleanedText = String(thinkingText || '').trim();
      const el = typeof chatThinkingUtils.resolveLiveReasoningStatusRow === 'function'
        ? chatThinkingUtils.resolveLiveReasoningStatusRow(chatTimeline, {
          thinkingId,
          activeMessageId,
          escapeSelectorValue,
        })
        : null;
      if (!el) return;
      const iterMatch = cleanedText.match(/^Starting iteration (\d+)\/(\d+)/);
      if (iterMatch) {
        if (el.getAttribute('data-reasoning-iteration') !== iterMatch[1]) {
          el.setAttribute('data-reasoning-iteration', iterMatch[1]);
        }
        return;
      }
      if (!cleanedText) return;
      const main = el.querySelector('.reasoning-row-main');
      if (!main) return;
      // Same label-flattening as the settled header: live GPT-style deltas
      // open with a bold markdown title that must not show its ** wrappers.
      const labelText = typeof chatThinkingUtils.markdownToPlainReasoningLabel === 'function'
        ? chatThinkingUtils.markdownToPlainReasoningLabel(cleanedText)
        : cleanedText;
      if (!labelText) return;
      if (main.textContent !== labelText) {
        main.textContent = labelText;
      }
      if (!main.classList.contains('shimmer-active')) {
        main.classList.add('shimmer-active');
      }
    }

    function renderLiveThinkingChip(thinkingState = null, activeMessageId = '') {
      const { activeStreamId, thinkingText, thinkingId } = thinkingState
        || getActiveThinkingStreamState();
      syncLiveReasoningStatusLabel(thinkingText, thinkingId, activeMessageId);

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

    function applyAssistantSprite(targetMessage, targetY, options = {}, thinkingState = null) {
      if (!chatSpriteLayer || !chatAssistantSprite || !targetMessage) {
        hideAssistantSprite({ reason: 'missing_target' });
        return;
      }
      spriteRuntime.reanchorRetryCount = 0;
      applySpriteViewState(createVisibleSpriteState(targetMessage, targetY), options);
      renderLiveThinkingChip(thinkingState, targetMessage.id);
    }

    function updateAssistantSpritePosition(messages, derivedState, options = {}) {
      if (disposed) {
        return;
      }
      if (messages === undefined) {
        messages = getCurrentSessionMessages();
      }
      messages = Array.isArray(messages) ? messages : [];
      positionRequestVersion += 1;
      const requestVersion = positionRequestVersion;
      if (spriteRuntime.frameHandle) {
        cancelFrame?.(spriteRuntime.frameHandle);
        spriteRuntime.frameHandle = 0;
      }

      const positionSprite = () => {
        if (disposed || requestVersion !== positionRequestVersion) {
          return;
        }
        spriteRuntime.frameHandle = 0;

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
        const sendPreflightActive = Boolean(isSendPreflightPending());
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
          if (
            uiState.activeView === 'chat'
            && typeof requestFrame === 'function'
            && Number(spriteRuntime.reanchorRetryCount || 0) < SPRITE_REANCHOR_RETRY_LIMIT
          ) {
            spriteRuntime.reanchorRetryCount = Number(spriteRuntime.reanchorRetryCount || 0) + 1;
            spriteRuntime.frameHandle = requestFrame(() => {
              if (disposed || requestVersion !== positionRequestVersion) {
                return;
              }
              spriteRuntime.frameHandle = 0;
              updateAssistantSpritePosition(messages, derivedState, options);
            });
            return;
          }
          spriteRuntime.reanchorRetryCount = 0;
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
        const targetMessage = usingThinkingFallback || (
          hasActiveSendAnchor
          && assistantAnchor.hasCurrentTurnAssistant
          && !anchorIsTerminalLatestContent
        )
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
          : baseTargetMessage;
        applyAssistantSprite(targetMessage, targetYValue, options, thinkingState);
      };

      if (typeof requestFrame === 'function') {
        spriteRuntime.frameHandle = requestFrame(positionSprite);
      } else {
        positionSprite();
      }
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      positionRequestVersion += 1;
      if (spriteRuntime.frameHandle) {
        cancelFrame?.(spriteRuntime.frameHandle);
        spriteRuntime.frameHandle = 0;
      }
      setSpriteHoloState(false, 'idle');
    }

    return {
      renderLiveThinkingChip,
      hideAssistantSprite,
      applyAssistantSprite,
      updateAssistantSpritePosition,
      dispose,
    };
  }

  return {
    createThinkingPipeline,
  };
});
