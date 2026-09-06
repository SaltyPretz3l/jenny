(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-turn-normalization-utils'),
      require('./renderer-stream-text-cursor')
    );
    return;
  }
  root.rendererStreamHandlerTools = factory(
    root.rendererTurnNormalizationUtils || {},
    root.rendererStreamTextCursor || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnNormalizationUtils, streamTextCursor) {
  const {
    extractToolCallId,
    normalizeGeneratedArtifact,
  } = turnNormalizationUtils;
  const { beginSegment } = streamTextCursor;

  const PILL_SOURCES = (typeof globalThis !== 'undefined'
    && globalThis.rendererTurnStatusPill
    && globalThis.rendererTurnStatusPill.SOURCES)
    || { TURN_RUNNING_TOOL: 'turn.running_tool', TURN_NEEDS_APPROVAL: 'turn.needs_approval' };

  const STRUCTURAL_RESULT_TOOL_NAMES = new Set([
    'ask_user',
    'bash',
    'run_command',
    'python_execute',
    'mermaid_generate',
    'monitor',
    // The spawn chip is markup the field-only live patch cannot inject, so task_board takes the full re-render path.
    'task_board',
    'web_search',
  ]);

  function markUserQuestionsStale(sessionId, questionRef, options = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedQuestionRef = String(questionRef || '').trim();
    const getSessionMessages = options.getSessionMessages || (() => []);
    const setSessionMessages = options.setSessionMessages || (() => {});
    if (!normalizedSessionId || !normalizedQuestionRef) return false;
    const messages = [...getSessionMessages(normalizedSessionId)];
    const index = messages.findIndex((message) => {
      const toolCall = message?.tool_call;
      return message?.kind === 'tool_use' && toolCall?.tool_name === 'ask_user'
        && toolCall?.status === 'pending_user_input'
        && String(toolCall?.question_ref || '').trim() === normalizedQuestionRef;
    });
    if (index < 0) return false;
    const staleState = { user_questions_result_kind: 'user_questions_stale', user_questions_stale: true };
    messages[index] = {
      ...messages[index],
      ...staleState,
      tool_call: { ...messages[index].tool_call, status: 'completed', ...staleState },
    };
    setSessionMessages(normalizedSessionId, messages, `session_${normalizedSessionId}`);
    return true;
  }

  function createStreamToolHandlers(options = {}) {
    const {
      state,
      syncThinkingIndicatorMode = () => {},
      streamSegmentState,
      getSessionMessages = () => [],
      setSessionMessages = () => {},
      createNormalizedMessage = (_role, _content, extra = {}) => ({ ...extra }),
      releaseApprovalToastSessions = () => {},
      clearSessionComposerNotice = () => {},
      setSessionTurnStatusPill = () => {},
      clearSessionTurnStatusPill = () => {},
      patchSessionSummary = () => {},
      queueSessionRender = () => {},
      scheduleLiveToolPatch = () => false,
      showApprovalToast = () => {},
      isCurrentSession = () => false,
      isRowModelEnabled = () => false,
      applyLiveTurnPayload = () => null,
      noteTimelineMessageCreated = () => false,
      invalidateProjectionStateForSession = () => 0,
      MESSAGE_STATUS = {},
      // Background Effects v3 S5 W1b: tool-start impulse, fired on every live
      // tool_use event whose status is 'running' (the same gate the
      // tool_executing reducer event uses).
      publishToolStartImpulse = () => {},
      // W2-1 live output tail: ephemeral DOM-patch callbacks — no row-model,
      // no session-store, no journaling. See renderer-stream-tool-live-tail.js.
      applyToolLiveOutputChunk = () => false,
      settleToolLiveOutput = () => {},
    } = options;

    function normalizeApprovalId(payload, callId) {
      return String(payload && payload.approvalId || '').trim()
        || String(payload && payload.approval_id || '').trim()
        || String(callId || '').trim();
    }

    function buildToolUseMessageId(payload, callId) {
      return String(payload && payload.toolUseMessageId || '').trim()
        || String(payload && payload.tool_use_message_id || '').trim()
        || (payload && payload.streamId ? `tool_use_${payload.streamId}_${callId}` : `tool_use_${callId}`);
    }

    function buildToolResultMessageId(payload, callId) {
      return String(payload && payload.toolResultMessageId || '').trim()
        || String(payload && payload.tool_result_message_id || '').trim()
        || (payload && payload.streamId ? `tool_result_${payload.streamId}_${callId}` : `tool_result_${callId}`);
    }

    function getToolMessageStreamId(message, kind) {
      if (kind === 'tool_use') {
        return String(message?.tool_call?.parent_stream_id || '').trim();
      }
      return String(message?.tool_result?.parent_stream_id || '').trim();
    }

    function getToolMessageCallId(message, kind) {
      if (kind === 'tool_use') {
        return String(message?.tool_call?.call_id || '').trim();
      }
      return String(message?.tool_result?.call_id || '').trim();
    }

    function findToolMessageIndex(messages, { kind, callId, streamId, preferredId = '' }) {
      const list = Array.isArray(messages) ? messages : [];
      const normalizedKind = String(kind || '').trim();
      const normalizedCallId = String(callId || '').trim();
      const normalizedStreamId = String(streamId || '').trim();
      const normalizedPreferredId = String(preferredId || '').trim();
      if (normalizedPreferredId) {
        const exactIndex = list.findIndex((message) => String(message?.id || '').trim() === normalizedPreferredId);
        if (exactIndex !== -1) {
          return exactIndex;
        }
      }
      if (!normalizedKind || !normalizedCallId) {
        return -1;
      }
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const message = list[index];
        if (String(message?.kind || '').trim() !== normalizedKind) {
          continue;
        }
        const candidateCallId = getToolMessageCallId(message, normalizedKind);
        if (candidateCallId !== normalizedCallId) {
          continue;
        }
        const candidateStreamId = getToolMessageStreamId(message, normalizedKind);
        if (normalizedStreamId && candidateStreamId !== normalizedStreamId) {
          continue;
        }
        return index;
      }
      return -1;
    }

    function hasStructuralToolResultPayload(payload, fallbackToolName = '') {
      const metadata = payload && payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : {};
      const toolName = String(payload?.toolName || payload?.tool_name || fallbackToolName).trim().toLowerCase();
      return (
        Array.isArray(payload?.generatedArtifacts) && payload.generatedArtifacts.length > 0
      ) || (
        Array.isArray(payload?.generated_artifacts) && payload.generated_artifacts.length > 0
      ) || Boolean(
        STRUCTURAL_RESULT_TOOL_NAMES.has(toolName)
        || metadata.diff
        || (Array.isArray(metadata.diffs) && metadata.diffs.length > 0)
        || metadata.monitor
        || (Array.isArray(metadata.generated_artifacts) && metadata.generated_artifacts.length > 0)
        || (Array.isArray(metadata.generatedArtifacts) && metadata.generatedArtifacts.length > 0)
        || metadata.stdout !== undefined
        || metadata.stderr !== undefined
        || metadata.exitCode != null
        || metadata.timedOut
        || metadata.killed
      );
    }

    function queueToolSessionRender(payload, eventType, flags, options = {}) {
      let livePatchAccepted = false;
      if (options.allowLivePatch !== false) {
        try {
          livePatchAccepted = scheduleLiveToolPatch(payload, { eventType }) === true;
        } catch (_error) {
          livePatchAccepted = false;
        }
      }
      queueSessionRender(payload.sessionId, {
        ...flags,
        messages: livePatchAccepted ? false : flags.messages === true,
      });
      return livePatchAccepted;
    }

    async function handleToolUse(payload) {
      syncThinkingIndicatorMode(payload.sessionId, 'tool-use');
      const callId = extractToolCallId(payload);
      const approvalId = normalizeApprovalId(payload, callId);
      const toolUseMessageId = buildToolUseMessageId(payload, callId);
      const policyScope = String(payload.policyScope || payload.policy_scope || '').trim();
      const policyConsequence = String(payload.policyConsequence || payload.policy_consequence || '').trim();
      const reason = String(payload.reason || '').trim();
      applyLiveTurnPayload(payload, {
        primaryToolMessageId: toolUseMessageId,
      });
      const segState = streamSegmentState.get(payload.streamId);
      const pendingId = state.pendingStreams.get(payload.streamId);
      if (pendingId && segState) {
        const pendingMessages = [...getSessionMessages(payload.sessionId)];
        const pendingIndex = pendingMessages.findIndex((message) => message.id === pendingId);
        if (pendingIndex !== -1) {
          const pendingMessage = pendingMessages[pendingIndex];
          const hasContent = String(pendingMessage?.content || '').trim();
          const hasReasoning = Array.isArray(pendingMessage?.reasoning?.entries) && pendingMessage.reasoning.entries.length > 0;
          const hasReasoningPhases = Array.isArray(pendingMessage?.reasoning_phases) && pendingMessage.reasoning_phases.length > 0;
          if (hasContent || (isRowModelEnabled(payload.sessionId) && (hasReasoning || hasReasoningPhases))) {
            pendingMessages[pendingIndex] = {
              ...pendingMessages[pendingIndex],
              status: MESSAGE_STATUS.COMPLETE,
              finalizedAt: new Date().toISOString(),
            };
          } else {
            pendingMessages.splice(pendingIndex, 1);
          }
          setSessionMessages(payload.sessionId, pendingMessages, `session_${payload.sessionId}`);
        }
        state.pendingStreams.delete(payload.streamId);
        segState.segmentIndex += 1;
        // The tool boundary opens a segment main has NOT named, so a reset's
        // authoritative-id latch (renderer-stream-handler-live-events.js) no
        // longer describes the current segment. Left set, the post-tool text
        // resolved to the PRE-tool id and merged into the row above it.
        segState.authoritativeAssistantMessageId = '';
        segState.authoritativeAssistantSegmentIndex = null;
        // New segment starts at the current cumulative aggregate length so a
        // mixed-iteration preamble isn't repeated in the post-tool segment (W3.6).
        beginSegment(segState);
      }
      const summary = String(payload.summary || '');
      const status = String(payload.status || 'running');
      if (status === 'running') {
        publishToolStartImpulse({ sessionId: payload.sessionId, streamId: payload.streamId, timeStamp: payload.timeStamp });
      }
      const input = payload.input && typeof payload.input === 'object' ? payload.input : {};
      const streamTools = state.toolCallsByStream.get(payload.streamId) || [];
      const existingToolEntry = streamTools.find((tool) => tool.callId === callId);
      if (existingToolEntry) {
        existingToolEntry.toolName = String(payload.toolName || existingToolEntry.toolName || '');
        existingToolEntry.status = status;
        existingToolEntry.input = Object.keys(input).length > 0 ? input : existingToolEntry.input;
        existingToolEntry.summary = summary || existingToolEntry.summary;
      } else {
        streamTools.push({ callId, toolName: String(payload.toolName || ''), status, input, summary });
      }
      state.toolCallsByStream.set(payload.streamId, streamTools);
      const activeMessages = [...getSessionMessages(payload.sessionId)];
      const toolUseIndex = findToolMessageIndex(activeMessages, {
        kind: 'tool_use',
        callId,
        streamId: payload.streamId,
        preferredId: toolUseMessageId,
      });
      let createdToolUseMessage = null;
      if (toolUseIndex !== -1) {
        const currentToolCall = activeMessages[toolUseIndex].tool_call || {};
        const nextInput = Object.keys(input).length > 0
          ? input
          : (
            currentToolCall.input
            && typeof currentToolCall.input === 'object'
            ? currentToolCall.input
            : {}
          );
        activeMessages[toolUseIndex] = {
          ...activeMessages[toolUseIndex],
          content: summary || activeMessages[toolUseIndex].content,
          tool_call: {
            ...currentToolCall,
            call_id: callId,
            approval_id: String(payload.approvalId || payload.approval_id || currentToolCall.approval_id || '').trim(),
            ...(policyScope ? { policy_scope: policyScope } : {}),
            ...(policyConsequence ? { policy_consequence: policyConsequence } : {}),
            ...(reason ? { reason } : {}),
            tool_name: String(payload.toolName || currentToolCall.tool_name || ''),
            input: nextInput,
            input_json: JSON.stringify(nextInput),
            summary: summary || String(currentToolCall.summary || ''),
            status,
            parent_stream_id: payload.streamId,
          },
        };
      } else {
        const toolUseMessage = createNormalizedMessage('assistant', summary, {
          id: toolUseMessageId,
          kind: 'tool_use',
          tool_call: {
            call_id: callId,
            approval_id: String(payload.approvalId || payload.approval_id || '').trim(),
            ...(policyScope ? { policy_scope: policyScope } : {}),
            ...(policyConsequence ? { policy_consequence: policyConsequence } : {}),
            ...(reason ? { reason } : {}),
            tool_name: String(payload.toolName || ''),
            input,
            input_json: JSON.stringify(input),
            summary,
            status,
            parent_stream_id: payload.streamId,
          },
          status: MESSAGE_STATUS.COMPLETE,
          finalizedAt: new Date().toISOString(),
        });
        createdToolUseMessage = toolUseMessage;
        activeMessages.push(toolUseMessage);
      }
      setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      if (createdToolUseMessage) {
        try {
          noteTimelineMessageCreated({
            sessionId: payload.sessionId,
            messageId: createdToolUseMessage.id,
            role: createdToolUseMessage.role,
            kind: createdToolUseMessage.kind,
            visible: true,
          });
        } catch (_error) { /* best-effort */ }
      }
      if (status !== 'pending_approval') {
        state.pendingToolApprovals.delete(approvalId);
        state.pendingToolApprovals.delete(callId);
        releaseApprovalToastSessions([payload.sessionId]);
      }
      const toolName = String(payload.toolName || existingToolEntry?.toolName || '').trim();
      const turnPhaseApi = (typeof globalThis !== 'undefined' && globalThis.rendererTurnPhase) || null;
      const composerCopy = turnPhaseApi && typeof turnPhaseApi.phaseToComposerCopy === 'function'
        ? (status === 'pending_approval'
          ? turnPhaseApi.phaseToComposerCopy('needs_approval', { approvalToolName: toolName })
          : turnPhaseApi.phaseToComposerCopy('running_tool', { toolName }))
        : null;
      const pillMessage = composerCopy && composerCopy.message
        ? composerCopy.message
        : (status === 'pending_approval' ? 'Approval needed' : 'Running tool\u2026');
      const pillSource = status === 'pending_approval' ? PILL_SOURCES.TURN_NEEDS_APPROVAL : PILL_SOURCES.TURN_RUNNING_TOOL;
      const otherPillSource = status === 'pending_approval' ? PILL_SOURCES.TURN_RUNNING_TOOL : PILL_SOURCES.TURN_NEEDS_APPROVAL;
      setSessionTurnStatusPill(payload.sessionId, pillSource, {
        message: pillMessage,
        tone: composerCopy ? composerCopy.tone : (status === 'pending_approval' ? 'warning' : 'pending'),
        spinner: composerCopy ? composerCopy.spinner : status !== 'pending_approval',
        badgeText: composerCopy ? composerCopy.badgeText : (status === 'pending_approval' ? 'Approval' : 'Tool'),
      });
      clearSessionTurnStatusPill(payload.sessionId, otherPillSource);
      queueToolSessionRender(payload, 'tool_use', {
        messages: true,
        composerStatus: true,
        composer: true,
        header: true,
        sessions: true,
      }, {
        allowLivePatch: !createdToolUseMessage,
      });
      return { buffered: false, terminal: false };
    }

    async function handleApprovalNeeded(payload) {
      const callId = extractToolCallId(payload);
      const approvalId = normalizeApprovalId(payload, callId);
      const toolUseMessageId = buildToolUseMessageId(payload, callId);
      const policyScope = String(payload.policyScope || payload.policy_scope || '').trim();
      const policyConsequence = String(payload.policyConsequence || payload.policy_consequence || '').trim();
      const reason = String(payload.reason || '').trim();
      applyLiveTurnPayload(payload, {
        primaryToolMessageId: toolUseMessageId,
      });
      state.pendingToolApprovals.set(approvalId, {
        approvalId,
        callId,
        toolName: String(payload.toolName || ''),
        input: payload.input,
        streamId: payload.streamId,
        sessionId: payload.sessionId,
        summary: String(payload.summary || ''),
        policyScope,
        policyConsequence,
        ...(reason ? { reason } : {}),
      });
      const activeMessages = [...getSessionMessages(payload.sessionId)];
      const toolUseIndex = findToolMessageIndex(activeMessages, {
        kind: 'tool_use',
        callId,
        streamId: payload.streamId,
        preferredId: toolUseMessageId,
      });
      if (toolUseIndex !== -1) {
        activeMessages[toolUseIndex] = {
          ...activeMessages[toolUseIndex],
          tool_call: {
            ...activeMessages[toolUseIndex].tool_call,
            status: 'pending_approval',
            ...(policyScope ? { policy_scope: policyScope } : {}),
            ...(policyConsequence ? { policy_consequence: policyConsequence } : {}),
            ...(reason ? { reason } : {}),
          },
        };
        setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      } else {
        // The approval event can win the race against the tool_use commit
        // (consecutive stream events with no render between them). Without a
        // message carrying pending_approval the structure signature never
        // changes, the queued render is a cache-hit no-op, and the Allow/Deny
        // block never surfaces — create the tool_use message here instead of
        // silently skipping.
        const approvalInput = payload.input && typeof payload.input === 'object' ? payload.input : {};
        const approvalSummary = String(payload.summary || '');
        activeMessages.push(createNormalizedMessage('assistant', approvalSummary, {
          id: toolUseMessageId,
          kind: 'tool_use',
          tool_call: {
            call_id: callId,
            approval_id: approvalId,
            tool_name: String(payload.toolName || ''),
            input: approvalInput,
            input_json: JSON.stringify(approvalInput),
            summary: approvalSummary,
            ...(policyScope ? { policy_scope: policyScope } : {}),
            ...(policyConsequence ? { policy_consequence: policyConsequence } : {}),
            ...(reason ? { reason } : {}),
            status: 'pending_approval',
            parent_stream_id: payload.streamId,
          },
          status: MESSAGE_STATUS.COMPLETE,
          finalizedAt: new Date().toISOString(),
        }));
        setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      }
      if (payload.planDocument && typeof payload.planDocument === 'object') {
        const planDocument = {
          ...payload.planDocument,
          approval_id: approvalId,
          tool_call_id: callId,
          state: 'pending',
          parent_stream_id: payload.streamId,
        };
        const planMessageId = `plan_document_${String(planDocument.plan_id || callId)}`;
        const existingPlanIndex = activeMessages.findIndex((message) => message.id === planMessageId);
        const planMessage = createNormalizedMessage('assistant', String(planDocument.title || 'Implementation plan'), {
          id: planMessageId,
          kind: 'plan_document',
          plan_document: planDocument,
          status: MESSAGE_STATUS.COMPLETE,
          // Rebuilds must not slide a divider-eligible node's timeline position.
          ...(existingPlanIndex >= 0 && activeMessages[existingPlanIndex].timestamp
            ? { timestamp: activeMessages[existingPlanIndex].timestamp }
            : {}),
          finalizedAt: new Date().toISOString(),
        });
        if (existingPlanIndex >= 0) activeMessages[existingPlanIndex] = planMessage;
        else activeMessages.push(planMessage);
        setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      }
      const approvalToolName = String(payload.toolName || '').trim();
      const approvalTurnPhaseApi = (typeof globalThis !== 'undefined' && globalThis.rendererTurnPhase) || null;
      const approvalCopy = approvalTurnPhaseApi && typeof approvalTurnPhaseApi.phaseToComposerCopy === 'function'
        ? approvalTurnPhaseApi.phaseToComposerCopy('needs_approval', { approvalToolName })
        : null;
      setSessionTurnStatusPill(payload.sessionId, PILL_SOURCES.TURN_NEEDS_APPROVAL, {
        message: approvalCopy && approvalCopy.message ? approvalCopy.message : 'Approval needed',
        tone: approvalCopy ? approvalCopy.tone : 'warning',
        spinner: approvalCopy ? approvalCopy.spinner : false,
        badgeText: approvalCopy ? approvalCopy.badgeText : 'Approval',
      });
      clearSessionTurnStatusPill(payload.sessionId, PILL_SOURCES.TURN_RUNNING_TOOL);
      if (!isCurrentSession(payload.sessionId)) {
        showApprovalToast(payload.sessionId);
      }
      // A pending tool_use can already have projected an approval-shaped row
      // before the explicit approval record becomes renderer authority. The
      // row fingerprint then stays unchanged even though its controls must be
      // rebuilt. Persist a full-render invalidation before queuing so a dropped
      // or coalesced frame self-heals on the next render.
      invalidateProjectionStateForSession(payload.sessionId);
      queueToolSessionRender(payload, 'tool_approval_needed', {
        messages: true,
        composerStatus: true,
        composer: true,
        header: true,
        sessions: true,
      }, {
        allowLivePatch: false,
      });
      return { buffered: false, terminal: false };
    }

    async function handleUserQuestionsRequested(payload) {
      const callId = extractToolCallId(payload);
      const toolUseMessageId = buildToolUseMessageId(payload, callId);
      const questionRef = String(payload.questionRef || payload.question_ref || '').trim();
      const questions = Array.isArray(payload.questions)
        ? payload.questions.map((question) => ({
            ...(question && typeof question === 'object' && !Array.isArray(question) ? question : {}),
            ...(Array.isArray(question?.options) ? { options: [...question.options] } : {}),
          }))
        : [];
      applyLiveTurnPayload(payload, { primaryToolMessageId: toolUseMessageId });
      const activeMessages = [...getSessionMessages(payload.sessionId)];
      const toolUseIndex = findToolMessageIndex(activeMessages, {
        kind: 'tool_use', callId, streamId: payload.streamId, preferredId: toolUseMessageId,
      });
      if (toolUseIndex !== -1) {
        activeMessages[toolUseIndex] = {
          ...activeMessages[toolUseIndex],
          tool_call: {
            ...activeMessages[toolUseIndex].tool_call,
            status: 'pending_user_input',
            user_questions: questions,
            question_ref: questionRef,
          },
        };
      } else {
        // The question request can win the race against the tool_use commit
        // (consecutive stream events with no render between them). Without a
        // message carrying pending_user_input the structure signature never
        // changes, the queued render is a cache-hit no-op, and the question
        // card never surfaces, so create the tool_use message here.
        const input = payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
          ? payload.input : { questions };
        const summary = String(payload.summary || '');
        activeMessages.push(createNormalizedMessage('assistant', summary, {
          id: toolUseMessageId,
          kind: 'tool_use',
          tool_call: {
            call_id: callId,
            tool_name: String(payload.toolName || 'ask_user'),
            input,
            input_json: JSON.stringify(input),
            summary,
            status: 'pending_user_input',
            user_questions: questions,
            question_ref: questionRef,
            parent_stream_id: payload.streamId,
          },
          status: MESSAGE_STATUS.COMPLETE,
          finalizedAt: new Date().toISOString(),
        }));
      }
      setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      invalidateProjectionStateForSession(payload.sessionId);
      queueToolSessionRender(payload, 'user_questions_requested', {
        messages: true,
        composerStatus: true,
        composer: true,
        header: true,
        sessions: true,
      }, { allowLivePatch: false });
      return { buffered: false, terminal: false };
    }

    async function handleToolOutputChunk(payload) {
      // W2-1: live tail for the running tool row. Only the visible session's
      // DOM is patched; chunks for other sessions are simply dropped — the
      // final tool_result carries the authoritative output everywhere.
      if (!isCurrentSession(payload.sessionId)) {
        return { buffered: false, terminal: false };
      }
      try {
        applyToolLiveOutputChunk(payload);
      } catch (_error) {
        // A broken tail must never disturb the stream pipeline.
      }
      return { buffered: false, terminal: false };
    }

    async function handleToolResult(payload) {
      const callId = extractToolCallId(payload);
      const approvalId = normalizeApprovalId(payload, callId);
      try {
        // W2-1: the settled row owns its Output panel — remove the live tail.
        settleToolLiveOutput(callId);
      } catch (_error) { /* ephemeral UI only */ }
      const toolUseMessageId = buildToolUseMessageId(payload, callId);
      const toolResultMessageId = buildToolResultMessageId(payload, callId);
      applyLiveTurnPayload(payload, {
        primaryToolMessageId: toolUseMessageId,
        toolResultMessageId,
      });
      state.pendingToolApprovals.delete(approvalId);
      state.pendingToolApprovals.delete(callId);
      releaseApprovalToastSessions([payload.sessionId]);
      const streamTools = state.toolCallsByStream.get(payload.streamId) || [];
      const input = payload.input && typeof payload.input === 'object' ? payload.input : {};
      const toolEntry = streamTools.find((tool) => tool.callId === callId);
      const fallbackToolName = String(toolEntry?.toolName || '').trim();
      if (toolEntry) {
        toolEntry.status = payload.approvalState === 'denied' ? 'denied' : (payload.isError ? 'error' : 'completed');
        if (Object.keys(input).length > 0) {
          toolEntry.input = input;
        }
      }
      const activeMessages = [...getSessionMessages(payload.sessionId)];
      const toolUseIndex = findToolMessageIndex(activeMessages, {
        kind: 'tool_use',
        callId,
        streamId: payload.streamId,
        preferredId: toolUseMessageId,
      });
      if (toolUseIndex !== -1) {
        const nextToolCallInput = Object.keys(input).length > 0
          ? input
          : (
            activeMessages[toolUseIndex].tool_call?.input
            && typeof activeMessages[toolUseIndex].tool_call.input === 'object'
            ? activeMessages[toolUseIndex].tool_call.input
            : {}
          );
        activeMessages[toolUseIndex] = {
          ...activeMessages[toolUseIndex],
          tool_call: {
            ...activeMessages[toolUseIndex].tool_call,
            input: nextToolCallInput,
            input_json: JSON.stringify(nextToolCallInput),
            status: payload.approvalState === 'denied' ? 'denied' : (payload.isError ? 'error' : 'completed'),
            approval_state: String(payload.approvalState || 'auto'),
            duration_ms: payload.durationMs || 0,
          },
        };
      }
      const toolResultMessage = createNormalizedMessage('tool', String(payload.summary || ''), {
        id: toolResultMessageId,
        kind: 'tool_result',
        tool_result: {
          call_id: callId,
          tool_name: String(payload.toolName || ''),
          output_text: String(payload.content || ''),
          summary: String(payload.summary || ''),
          is_error: Boolean(payload.isError),
          error_code: String(payload.errorCode || ''),
          exit_code: payload.metadata && payload.metadata.exitCode != null
            ? Number(payload.metadata.exitCode)
            : null,
          duration_ms: payload.durationMs || 0,
          parent_stream_id: payload.streamId,
          generated_artifacts: Array.isArray(payload.generatedArtifacts)
            ? payload.generatedArtifacts.map(normalizeGeneratedArtifact).filter(Boolean)
            : [],
          trusted_attachment_refs: Array.isArray(payload.trustedAttachments)
            ? payload.trustedAttachments.map((attachment) => ({
                id: String(attachment?.id || '').trim(),
                kind: String(attachment?.kind || '').trim(),
                mime_type: String(attachment?.mimeType || attachment?.mime_type || '').trim(),
                byte_length: Number(attachment?.byteLength ?? attachment?.byte_length ?? 0),
                width: Number(attachment?.width || 0),
                height: Number(attachment?.height || 0),
                asset_path: String(attachment?.assetPath || attachment?.asset_path || '').trim(),
              })).filter((attachment) => attachment.id && attachment.asset_path)
            : [],
          metadata: payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
            ? { ...payload.metadata } : {},
        },
        status: MESSAGE_STATUS.COMPLETE,
        finalizedAt: new Date().toISOString(),
      });
      const toolResultIndex = findToolMessageIndex(activeMessages, {
        kind: 'tool_result',
        callId,
        streamId: payload.streamId,
        preferredId: toolResultMessage.id,
      });
      if (toolResultIndex !== -1) {
        activeMessages[toolResultIndex] = {
          ...activeMessages[toolResultIndex],
          ...toolResultMessage,
          timestamp: activeMessages[toolResultIndex].timestamp || toolResultMessage.timestamp,
          id: activeMessages[toolResultIndex].id || toolResultMessage.id,
        };
      } else {
        activeMessages.push(toolResultMessage);
      }
      const resultToolName = String(payload.toolName || fallbackToolName || '').trim();
      if (resultToolName === 'exit_plan_mode' && payload.metadata?.result_kind === 'plan_mode_transition') {
        const decision = String(payload.metadata.plan_decision || (payload.isError ? 'abandoned' : '')).trim();
        for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
          const message = activeMessages[index];
          if (message?.kind !== 'plan_document'
            || String(message?.plan_document?.tool_call_id || '') !== callId) continue;
          activeMessages[index] = {
            ...message,
            plan_document: {
              ...message.plan_document,
              state: decision || 'abandoned',
              feedback: String(payload.metadata.plan_feedback || '').slice(0, 800),
            },
            finalizedAt: new Date().toISOString(),
          };
          break;
        }
      }
      if (
        resultToolName === 'exit_plan_mode'
        && payload.isError !== true
        && payload.metadata?.plan_mode_cleared === true
      ) {
        const restoredRunMode = payload.metadata.run_mode_restored === 'auto' ? 'auto' : 'ask';
        patchSessionSummary(payload.sessionId, {
          plan_mode: false,
          run_mode: restoredRunMode,
        });
      }
      // Follow the rendererTaskSessionActions globalThis precedent for optional task-board coordination.
      if (payload.metadata?.result_kind === 'task_board' && payload.isError !== true) {
        globalThis.rendererTaskBoard?.notifyMutation?.();
      }
      setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      clearSessionComposerNotice(payload.sessionId);
      clearSessionTurnStatusPill(payload.sessionId, PILL_SOURCES.TURN_RUNNING_TOOL);
      clearSessionTurnStatusPill(payload.sessionId, PILL_SOURCES.TURN_NEEDS_APPROVAL);
      queueToolSessionRender(payload, 'tool_result', {
        messages: true,
        composerStatus: true,
        composer: true,
        header: true,
        sessions: true,
      }, {
        allowLivePatch: !hasStructuralToolResultPayload(payload, fallbackToolName),
      });
      return { buffered: false, terminal: false };
    }

    return {
      handleToolUse,
      handleApprovalNeeded,
      handleUserQuestionsRequested,
      handleToolOutputChunk,
      handleToolResult,
    };
  }

  return { createStreamToolHandlers, markUserQuestionsStale };
});
