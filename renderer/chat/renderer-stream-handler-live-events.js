/* renderer/chat/renderer-stream-handler-live-events.js -- non-terminal live stream event handlers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-stream-text-cursor'));
    return;
  }
  root.rendererStreamHandlerLiveEvents = factory(root.rendererStreamTextCursor || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (streamTextCursor) {
  const {
    createTextCursor,
    resetCursor,
    readDelta,
    usesAggregate,
  } = streamTextCursor;

  function createStreamLiveEventHandlers(deps = {}) {
    const {
      state,
      normalizeId,
      normalizeString,
      appendClientLog = () => {},
      MESSAGE_STATUS = {},
      streamSegmentState,
      streamPhaseState,
      reasoningStreamMerger,
      multiStreamController = null,
      pendingStreamCommitQueue,
      appendAgentStatusStep = () => [],
      notePreflightEvent = () => {},
      clearStreamThinkingStatus = () => {},
      flushPendingStreamCommit = () => {},
      applyLiveTurnPayload = () => null,
      buildAssistantShellMessageId = () => '',
      setChatSendLifecycle = () => 'idle',
      syncThinkingIndicatorMode = () => {},
      queueSessionRender = () => {},
      queueRender = () => {},
      ensurePendingStreamEntry = () => -1,
      getSessionMessages = () => [],
      setSessionMessages = () => {},
      updatePendingMessage = () => false,
      markHiddenRenderableEvent = () => {},
      isVisibleChatSession = () => false,
      isCurrentSession = () => false,
      isRowModelEnabled = () => false,
      getReasoningPhasesForStream = () => [],
      completeThinkingIndicator = () => {},
      updateContextUsage = () => {},
      // Background Effects v3 S5 W1b: first-token impulse, fired exactly once
      // per stream (guarded by streamSegmentState's firstDeltaSeen flag).
      publishFirstTokenImpulse = () => {},
    } = deps;

    async function handleStarted(payload) {
      appendClientLog('DEBUG', 'stream.handle_started', {
        streamId: payload.streamId,
        sessionId: String(payload.sessionId || '').slice(0, 30),
        currentSessionId: String(state.currentSessionId || '').slice(0, 30),
        activeView: state.ui?.activeView,
      });
      notePreflightEvent(payload, 'started');
      clearStreamThinkingStatus(payload.streamId);
      flushPendingStreamCommit(payload.streamId); // flush staged commits; drop skips it (#33)
      reasoningStreamMerger.drop(payload.streamId);
      streamSegmentState.set(payload.streamId, {
        segmentIndex: 0,
        ...createTextCursor(),
        firstDeltaSeen: false,
      });
      streamPhaseState.delete(normalizeId(payload.streamId));
      applyLiveTurnPayload(payload, {
        primaryAssistantMessageId: buildAssistantShellMessageId(payload.streamId, 0),
      });
      multiStreamController?.registerStream?.(payload.sessionId, payload.streamId);
      setChatSendLifecycle(payload.sessionId, 'streaming');
      syncThinkingIndicatorMode(payload.sessionId, 'thinking');
      queueSessionRender(payload.sessionId, { composer: true, header: true });
      return { buffered: false, terminal: false };
    }

    async function handleAgentStatus(payload) {
      notePreflightEvent(payload, 'agent_status');
      setChatSendLifecycle(payload.sessionId, 'streaming');
      const snapshot = {
        streamId: payload.streamId,
        sessionId: payload.sessionId,
        requestId: normalizeString(payload.requestId),
        taskId: normalizeString(payload.taskId),
        agentId: normalizeString(payload.agentId || payload.agent_id),
        parentAgentId: normalizeString(payload.parentAgentId || payload.parent_agent_id),
        toolCallId: normalizeString(payload.toolCallId || payload.tool_call_id),
        childTaskId: normalizeString(payload.childTaskId || payload.child_task_id),
        childAgentId: normalizeString(payload.childAgentId || payload.child_agent_id),
        childOrdinal: Number.isSafeInteger(payload.childOrdinal) ? payload.childOrdinal : null,
        childCount: Number.isSafeInteger(payload.childCount) ? payload.childCount : null,
        childLabel: normalizeString(payload.childLabel || payload.child_label).slice(0, 80),
        childTerminal: payload.childTerminal === true || payload.child_terminal === true,
        childSuccess: payload.childSuccess === true || payload.child_success === true,
        model: normalizeString(payload.model).slice(0, 96),
        provider: normalizeString(payload.provider).slice(0, 96),
        usage: payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
          ? payload.usage
          : null,
        terminalReason: normalizeString(payload.terminalReason || payload.terminal_reason).slice(0, 64),
        taskType: normalizeString(payload.taskType),
        source: normalizeString(payload.source),
        status: normalizeString(payload.status),
        stage: normalizeString(payload.stage),
        percent: Number.isFinite(Number(payload.percent))
          ? Math.min(100, Math.max(0, Math.round(Number(payload.percent))))
          : 0,
        summary: normalizeString(payload.summary),
        terminal: payload.terminal === true,
        success: payload.success === true,
      };
      const pendingIndex = ensurePendingStreamEntry(payload);
      const pendingStepsMessages = pendingIndex !== -1 ? getSessionMessages(payload.sessionId) : null; // one read (#36)
      const priorSteps = pendingStepsMessages && Array.isArray(pendingStepsMessages[pendingIndex]?.agent_status_steps)
        ? pendingStepsMessages[pendingIndex].agent_status_steps
        : [];
      const nextSteps = appendAgentStatusStep(priorSteps, {
        taskId: snapshot.taskId,
        agentId: snapshot.agentId,
        parentAgentId: snapshot.parentAgentId,
        toolCallId: snapshot.toolCallId,
        childTaskId: snapshot.childTaskId,
        childAgentId: snapshot.childAgentId,
        childOrdinal: snapshot.childOrdinal,
        childCount: snapshot.childCount,
        childLabel: snapshot.childLabel,
        childTerminal: snapshot.childTerminal,
        childSuccess: snapshot.childSuccess,
        model: snapshot.model,
        provider: snapshot.provider,
        usage: snapshot.usage,
        terminalReason: snapshot.terminalReason,
        streamId: snapshot.streamId,
        taskType: snapshot.taskType,
        source: snapshot.source,
        status: snapshot.status,
        stage: snapshot.stage,
        percent: snapshot.percent,
        summary: snapshot.summary,
        terminal: snapshot.terminal,
        success: snapshot.success,
      });
      const updated = updatePendingMessage(payload, {
        agent_status: snapshot,
        agent_status_steps: nextSteps,
        status: MESSAGE_STATUS.STREAMING,
        finalizedAt: null,
      });
      if (updated) {
        markHiddenRenderableEvent(payload, 'agent_status');
      }
      if (updated && isVisibleChatSession(payload.sessionId)) {
        queueRender({ messages: true });
      } else {
        queueRender({ chrome: true });
      }
      return { buffered: false, terminal: false };
    }

    // `assistant_<streamId>` (segment 0) and `assistant_<streamId>_seg<n>` are
    // the only two shapes main mints for an assistant shell message. Recover
    // <n> from an authoritative id so segState keeps counting from the index
    // main is actually on; anything else leaves the local counter alone.
    function parseAssistantSegmentIndex(streamId, messageId, fallbackIndex) {
      const normalizedStreamId = normalizeId(streamId);
      const normalizedId = normalizeString(messageId);
      if (!normalizedStreamId || !normalizedId) {
        return fallbackIndex;
      }
      const baseId = `assistant_${normalizedStreamId}`;
      if (normalizedId === baseId) {
        return 0;
      }
      const segPrefix = `${baseId}_seg`;
      if (!normalizedId.startsWith(segPrefix)) {
        return fallbackIndex;
      }
      const suffix = normalizedId.slice(segPrefix.length);
      return /^\d+$/.test(suffix) ? Number(suffix) : fallbackIndex;
    }

    async function handleStreamReset(payload) {
      flushPendingStreamCommit(payload.streamId);
      reasoningStreamMerger.drop(payload.streamId);
      const segState = streamSegmentState.get(payload.streamId);
      const localSegmentIndex = Number(segState?.segmentIndex) || 0;
      // Main is the authority for the id the post-reset text gets persisted
      // under and publishes it as `next_assistant_message_id`. Deriving it
      // locally as segmentIndex + 1 drifts whenever main's textSegmentIndex
      // did NOT advance across the reset (a discarding reset never rewinds or
      // bumps it): the live rows then streamed under a `_seg+1` id while the
      // canonical message landed on the previous index, so the same text
      // painted twice until terminal reconcile deleted the stale rows. Fall
      // back to the local counter when the field is absent (older main).
      const authoritativeNextAssistantMessageId = normalizeString(
        payload.next_assistant_message_id || payload.nextAssistantMessageId || ''
      );
      const nextAssistantMessageId = authoritativeNextAssistantMessageId
        || buildAssistantShellMessageId(payload.streamId, localSegmentIndex + 1);
      applyLiveTurnPayload(payload, {
        // Resolved against the PRE-reset segState, so this still names the row
        // the outgoing deltas were keyed by (including a prior reset's
        // authoritative id).
        primaryAssistantMessageId: buildAssistantShellMessageId(payload.streamId, localSegmentIndex),
        nextAssistantMessageId,
      });
      streamPhaseState.delete(normalizeId(payload.streamId));
      clearStreamThinkingStatus(payload.streamId);
      if (segState) {
        segState.segmentIndex = authoritativeNextAssistantMessageId
          ? parseAssistantSegmentIndex(
            payload.streamId,
            authoritativeNextAssistantMessageId,
            localSegmentIndex + 1
          )
          : localSegmentIndex + 1;
        // Latched so every id derived from THIS segment index — text deltas,
        // reasoning phases — resolves to main's exact spelling (main writes
        // `_seg0` where the renderer's own scheme writes the bare base id).
        // The index is latched ALONGSIDE the id and is what
        // buildAssistantShellMessageId matches on: segState.segmentIndex also
        // moves at every tool boundary (renderer-stream-handler-tools.js), and
        // a latch keyed on that mutable counter answered the NEXT segment's
        // question with the PREVIOUS segment's id — post-tool text merged
        // straight back into the pre-tool row. Cleared on the fallback path so
        // absent authority means byte-identical legacy behaviour.
        segState.authoritativeAssistantMessageId = authoritativeNextAssistantMessageId;
        segState.authoritativeAssistantSegmentIndex = authoritativeNextAssistantMessageId
          ? segState.segmentIndex
          : null;
        resetCursor(segState);
      }
      const pendingId = state.pendingStreams.get(payload.streamId);
      if (pendingId) {
        const sessionMessages = [...getSessionMessages(payload.sessionId)];
        const idx = sessionMessages.findIndex((m) => m.id === pendingId);
        if (idx !== -1) {
          sessionMessages[idx] = {
            ...sessionMessages[idx],
            content: '',
            reasoning: { source: 'none', entries: [] },
            reasoning_phases: [],
            agent_status: null,
            agent_status_steps: [],
          };
          setSessionMessages(payload.sessionId, sessionMessages, `session_${payload.sessionId}`);
        }
        if (isRowModelEnabled(payload.sessionId)) {
          state.pendingStreams.delete(payload.streamId);
        }
      }
      if (isVisibleChatSession(payload.sessionId)) {
        queueRender({ messages: true });
      }
      return { buffered: false, terminal: false };
    }

    async function handleContextCompacted(payload) {
      flushPendingStreamCommit(payload.streamId);
      // History accumulates per pending message, i.e. per assistant segment.
      // A tool call clears pendingStreams (renderer-stream-handler-tools.js),
      // so a compaction after it lands on the NEXT segment's bubble, in turn
      // order, rather than folding into the earlier notice. Two compactions
      // share a notice only when nothing opened a new segment between them.
      const pendingMessageId = state.pendingStreams.get(payload.streamId);
      const currentMessage = pendingMessageId
        ? getSessionMessages(payload.sessionId).find((message) => message.id === pendingMessageId)
        : null;
      const existingCompactions = Array.isArray(currentMessage?.context_compactions)
        ? currentMessage.context_compactions
        : [];
      const contextCompacted = {
        strategy: String(payload.strategy || 'micro'),
        tokensBefore: Number(payload.tokensBefore || 0) || 0,
        tokensAfter: Number(payload.tokensAfter || 0) || 0,
        phase: String(payload.phase || 'preflight'),
        summaryStatus: String(payload.summaryStatus || 'not_created'),
        reasonCode: String(payload.reasonCode || '').slice(0, 80),
        inputComplete: payload.inputComplete !== false,
        droppedMessages: Math.max(0, Number(payload.droppedMessages || 0) || 0),
        droppedBytes: Math.max(0, Number(payload.droppedBytes || 0) || 0),
        summaryPersisted: payload.summaryPersisted === true,
        historyScopeFallback: String(payload.historyScopeFallback || ''),
        occurredAt: new Date().toISOString(),
      };
      const updated = updatePendingMessage(payload, {
        context_compacted: contextCompacted,
        context_compactions: [...existingCompactions, contextCompacted].slice(-20),
        status: MESSAGE_STATUS.STREAMING,
        finalizedAt: null,
      });
      if (updated && isVisibleChatSession(payload.sessionId)) {
        queueRender({ messages: true });
      } else {
        queueRender({ chrome: true });
      }
      return { buffered: false, terminal: false };
    }

    // Mid-turn composer context-ring snapshot. EPHEMERAL, like
    // tool_output_chunk: it touches NO message state (no pending-message
    // mutation, no reasoning, no row model) and is never buffered for replay —
    // a stale meter reading has no value once the turn has moved on. The store
    // owns terminal-vs-mid-turn precedence; this handler only forwards.
    async function handleContextUsage(payload) {
      updateContextUsage(payload.sessionId, payload);
      queueRender({ chrome: true });
      return { buffered: false, terminal: false };
    }

    async function handleDelta(payload, options = {}) {
      completeThinkingIndicator(payload.sessionId);
      notePreflightEvent(payload, 'delta');
      setChatSendLifecycle(payload.sessionId, 'streaming');
      // Track aggregate length and compute the row-model text delta. The
      // backend sends `content` as the token delta and `aggregate` as the
      // cumulative visible text; live row reducers must append only the delta.
      const segState = streamSegmentState.get(payload.streamId) || {
        segmentIndex: 0,
        ...createTextCursor(),
        firstDeltaSeen: false,
      };
      if (!streamSegmentState.has(payload.streamId)) {
        streamSegmentState.set(payload.streamId, segState);
      }
      if (!segState.firstDeltaSeen) {
        segState.firstDeltaSeen = true;
        publishFirstTokenImpulse({ sessionId: payload.sessionId, streamId: payload.streamId, timeStamp: payload.timeStamp });
      }
      const index = ensurePendingStreamEntry(payload);
      const message = getSessionMessages(payload.sessionId)[index] || {};
      const hasExistingProviderReasoning = String(message?.reasoning?.source || '').trim() === 'provider'
        && Array.isArray(message?.reasoning?.entries)
        && message.reasoning.entries.length > 0;
      const hasReasoningDelta = Array.isArray(payload?.reasoning?.entriesDelta)
        && payload.reasoning.entriesDelta.length > 0;
      const hasProviderReasoningDelta = String(payload?.reasoning?.source || '').trim() === 'provider'
        && hasReasoningDelta;
      let basisContent = '';
      if (!usesAggregate(payload)) {
        const stagedEntry = pendingStreamCommitQueue.peek(normalizeId(payload.streamId));
        const stagedContent = stagedEntry && stagedEntry.patch
          ? String(stagedEntry.patch.content || '')
          : '';
        basisContent = stagedContent || String(message.content || '');
      }
      const { regressed, segmentContent, pendingContent, lengthMismatch } = readDelta(
        segState,
        payload,
        { basisContent }
      );
      // The producer's authoritative length disagrees with what this cursor
      // accumulated locally -- the in-band signal that a frame lost text. It is
      // silent by construction (no throw, regressed stays false), so log it once
      // per segment: enough to make the class observable in a field report,
      // bounded so a persistent mismatch cannot flood the log on every frame.
      if (lengthMismatch && !segState.lengthMismatchLogged) {
        segState.lengthMismatchLogged = true;
        appendClientLog('WARN', 'stream.aggregate_length_mismatch', {
          streamId: normalizeId(payload.streamId),
          producerLength: payload.aggregateLength,
          localLength: segState.aggregateOffset,
        });
      }
      if (regressed) {
        if (hasProviderReasoningDelta) {
          flushPendingStreamCommit(payload.streamId);
          const updatedReasoning = updatePendingMessage(payload, {
            reasoning: reasoningStreamMerger.merge(payload.streamId, message, payload.reasoning),
          });
          if (updatedReasoning && isVisibleChatSession(payload.sessionId)) {
            queueRender({ messages: true });
          } else if (updatedReasoning && isCurrentSession(payload.sessionId)) {
            queueRender({ chrome: true });
          } else if (updatedReasoning) {
            queueRender({ chrome: true });
          }
        }
        return { buffered: false, terminal: false };
      }
      applyLiveTurnPayload(payload, {
        primaryAssistantMessageId: buildAssistantShellMessageId(payload.streamId, segState.segmentIndex),
        segmentText: segmentContent,
        segmentIndex: segState.segmentIndex,
      });
      // Generic streams should clear their live thinking label once text arrives.
      // Provider-reasoning streams keep the label visible until terminal events so
      // the live chip and inline toggle stay anchored while reasoning is still active.
      if (String(payload.content || '').trim() && !hasExistingProviderReasoning && !hasProviderReasoningDelta) {
        clearStreamThinkingStatus(payload.streamId);
      }
      const pendingEntry = {
        payload,
        aggregate: payload.aggregate,
        visible: isVisibleChatSession(payload.sessionId),
        current: isCurrentSession(payload.sessionId),
        reasoningChanged: hasReasoningDelta,
        patch: {
          content: pendingContent,
          status: MESSAGE_STATUS.STREAMING,
          stream_error: '',
          finalizedAt: null,
          reasoning: reasoningStreamMerger.merge(payload.streamId, message, payload.reasoning),
          reasoning_phases: getReasoningPhasesForStream(payload.streamId),
        },
      };
      markHiddenRenderableEvent(payload, 'delta');
      if (options.coalesce === false) {
        pendingStreamCommitQueue.flush(normalizeId(payload.streamId));
        pendingStreamCommitQueue.commitNow(pendingEntry);
      } else {
        pendingStreamCommitQueue.stage(
          normalizeId(payload.streamId),
          pendingEntry,
          function mergePendingDelta(prevEntry, nextEntry) {
            // Content is cumulative; reasoning was already folded into the
            // per-stream state, so this avoids same-frame rescans.
            return {
              ...nextEntry,
              patch: {
                ...nextEntry.patch,
                reasoning: nextEntry.reasoningChanged
                  ? nextEntry.patch?.reasoning
                  : (prevEntry?.patch?.reasoning || nextEntry.patch?.reasoning),
              },
            };
          }
        );
      }
      return { buffered: false, terminal: false };
    }

    return {
      handleStarted,
      handleAgentStatus,
      handleStreamReset,
      handleContextCompacted,
      handleContextUsage,
      handleDelta,
    };
  }

  return { createStreamLiveEventHandlers };
});
