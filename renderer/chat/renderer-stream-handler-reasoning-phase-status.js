/* renderer/chat/renderer-stream-handler-reasoning-phase-status.js -- stream reasoning phase/status handlers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerReasoningPhaseStatus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createStreamReasoningPhaseStatusHandlers(options = {}) {
    const {
      normalizeId = (value) => String(value || '').trim(),
      normalizeString = (value) => String(value || '').trim(),
      state = {},
      streamSegmentState = new Map(),
      setStreamThinkingStatus = () => {},
      syncThinkingIndicatorMode = () => {},
      ensureRenderableReasoningStreamEntry = () => -1,
      markHiddenRenderableEvent = () => {},
      isVisibleChatSession = () => false,
      queueRender = () => {},
      appendClientLog = () => {},
      applyLiveTurnPayload = () => null,
      buildAssistantShellMessageId = (streamId) => `assistant_${streamId}`,
      updateStreamPhaseState = () => [],
      syncPendingMessagePhaseState = () => null,
    } = options || {};

    function logHandlerFailure(operation, payload, error) {
      try {
        appendClientLog('ERROR', 'stream.reasoning_phase_handler_failed', {
          operation,
          streamId: normalizeId(payload?.streamId).slice(0, 60),
          sessionId: normalizeId(payload?.sessionId).slice(0, 30),
          message: String(error?.message || error).slice(0, 200),
        });
      } catch (_logError) {
        // Logging failures must not make stream parsing more fragile.
      }
    }

    function runGuarded(operation, payload, callback, fallback) {
      try {
        return callback();
      } catch (error) {
        logHandlerFailure(operation, payload, error);
        return fallback;
      }
    }

    function shouldMaterializePhaseShell(payload) {
      if (!normalizeId(payload?.sessionId) || !normalizeId(payload?.streamId)) {
        return false;
      }
      const phaseKind = normalizeString(payload?.phaseKind || payload?.phase_kind).toLowerCase();
      return phaseKind === 'reasoning' || phaseKind === 'text';
    }

    async function handleThinkingStatus(payload) {
      const normalizedStreamId = normalizeId(payload.streamId);
      const thinkingText = normalizeString(payload.text);
      const hadThinkingStatus = Boolean(
        normalizedStreamId
        && state.streamThinkingStatusByStream instanceof Map
        && state.streamThinkingStatusByStream.has(normalizedStreamId)
      );
      const shouldRenderThinkingStatus = Boolean(thinkingText || hadThinkingStatus);
      runGuarded('set_stream_thinking_status', payload, () => setStreamThinkingStatus(payload.streamId, payload.text, payload.thinkingId));
      if (thinkingText) {
        runGuarded('sync_thinking_indicator_mode', payload, () => syncThinkingIndicatorMode(payload.sessionId, 'thinking'));
        runGuarded('ensure_renderable_reasoning_entry', payload, () => ensureRenderableReasoningStreamEntry(payload));
      }
      if (shouldRenderThinkingStatus) {
        runGuarded('mark_hidden_renderable_event', payload, () => markHiddenRenderableEvent(payload, 'thinking_status'));
      }
      if (shouldRenderThinkingStatus && runGuarded('is_visible_chat_session', payload, () => isVisibleChatSession(payload.sessionId), false)) {
        runGuarded('queue_render', payload, () => queueRender({ messages: true }));
      }
      return { buffered: false, terminal: false };
    }

    function handlePhaseEvent(payload, eventType, completed) {
      const segmentIndex = Number(streamSegmentState.get(payload.streamId)?.segmentIndex) || 0;
      runGuarded('apply_live_turn_payload', payload, () => applyLiveTurnPayload(payload, {
        primaryAssistantMessageId: buildAssistantShellMessageId(payload.streamId, segmentIndex),
      }));
      runGuarded('update_stream_phase_state', payload, () => updateStreamPhaseState(payload, completed));
      if (shouldMaterializePhaseShell(payload)) {
        runGuarded('ensure_renderable_reasoning_entry', payload, () => ensureRenderableReasoningStreamEntry(payload));
      }
      runGuarded('sync_pending_message_phase_state', payload, () => syncPendingMessagePhaseState(payload));
      runGuarded('mark_hidden_renderable_event', payload, () => markHiddenRenderableEvent(payload, eventType));
      if (runGuarded('is_visible_chat_session', payload, () => isVisibleChatSession(payload.sessionId), false)) {
        runGuarded('queue_render', payload, () => queueRender({ messages: true }));
      } else {
        runGuarded('queue_render', payload, () => queueRender({ chrome: true }));
      }
      return { buffered: false, terminal: false };
    }

    async function handlePhaseStarted(payload) {
      return handlePhaseEvent(payload, 'phase_started', false);
    }

    async function handlePhaseCompleted(payload) {
      return handlePhaseEvent(payload, 'phase_completed', true);
    }

    return {
      handleThinkingStatus,
      handlePhaseStarted,
      handlePhaseCompleted,
    };
  }

  return { createStreamReasoningPhaseStatusHandlers };
});
