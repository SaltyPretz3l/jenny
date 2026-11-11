(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendAssembly = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Paths and display names of accepted attachments (active-file dedupe input).
  function attachmentRefs(list) {
    const entries = Array.isArray(list) ? list : [];
    return {
      paths: entries.map((e) => String(e?.path || e?.assetPath || e?.absolute_path || e?.absolutePath || '').trim()).filter(Boolean),
      names: entries.map((e) => String(e?.displayName || e?.promptName || '').trim()).filter(Boolean),
    };
  }

  // Busy / backend-starting sends: the follow-up is captured into the session's queued-send slot (and
  // the outbox) instead of starting a turn. Everything here is synchronous on purpose: the queued entry
  // and the composer-draft consumption must land before the caller's next await.
  function createBusySendQueue(env) {
    const {
      state, chatInput, sendOutbox, sendSlashDispatch, stashQueuedSendForSession, canQueueForSession,
      consumePromptBlock, appendClientLog, setComposerStatusNotice, renderComposerState,
      syncComposerInputHeight, syncComposerVisualState,
    } = env;
    return function queueBusySend(c) {
      const {
        isEditRegenerate, isOutboxDispatch, queueUntilBackendReady, normalizedPrompt, attachmentBudget,
        requestedSessionId, requestedSession, preserveComposerDraft, prompt, runtimePreferences,
        skillInvocation, imageEditDraft, promptBlock, imagePromptPin, settings, sessionQueue,
      } = c;
      if (isEditRegenerate) {
        appendClientLog('INFO', 'chat.send_blocked', { sessionId: requestedSessionId, reason: 'session_busy_edit' });
        return { rejected: true, reason: 'session_busy', sessionId: requestedSessionId };
      }
      if (isOutboxDispatch) return null;
      if (
        (queueUntilBackendReady || canQueueForSession(requestedSessionId))
        && (normalizedPrompt || attachmentBudget.accepted.length)
      ) {
        // Legacy outbox capture and draft consumption must precede any await:
        // terminal dispatch may run while mention contents are still resolving.
        // Backfill only the same queued entry, deduping against resolved mentions.
        // A prompt that did not come from the composer (preserveComposerDraft)
        // takes none of its @-mentions and leaves its draft alone.
        const queuedRefs = attachmentRefs(attachmentBudget.accepted);
        const queuedMentionPaths = preserveComposerDraft ? [] : window.rendererIdeMentionAutocomplete?.collectMentionPaths?.(chatInput) || [];
        const queuedMentionContentsPromise = Promise.resolve(
          preserveComposerDraft ? [] : window.rendererIdeMentionAutocomplete?.collectMentionContents?.({ input: chatInput }) || []
        );
        // Initially dedupe only attachments; failed mention reads must not
        // discard the active-file snapshot from both context sources.
        const queuedActiveFileContext = window.rendererIdeActiveFileContext?.readActiveFileContextForTurn?.({
          mentionedPaths: [],
          attachedPaths: queuedRefs.paths,
          attachedNames: queuedRefs.names,
        }) || null;
        const queuedEntry = stashQueuedSendForSession(requestedSessionId, {
          prompt: String(prompt || ''),
          attachments: attachmentBudget.accepted,
          runtimePreferences,
          createdAt: Date.now(),
          status: 'capturing_context',
          sourceRevision: Number(state.composerSessionState?.get?.(requestedSessionId)?.generation || 0),
          targetSessionIncarnation: String(
            requestedSession?.session_incarnation || requestedSession?.sessionIncarnation || ''
          ),
          meta: {
            mentionContentsSnapshot: [],
            activeFileContextSnapshot: queuedActiveFileContext, skillInvocation, imageEditSnapshot: imageEditDraft, promptBlock,
            ...(imagePromptPin ? { imagePromptPin } : {}),
          },
        });
        if (!queuedEntry) {
          setComposerStatusNotice(jt('chat.send.outboxFull', 'The send outbox is full. Cancel or send an existing item first.'), {
            owner: 'send:outbox_full', tone: 'warning',
          });
          renderComposerState();
          return null;
        }
        if (queuedActiveFileContext?.path) {
          window.rendererIdeActiveFileContext?.markTurnAccepted?.(queuedActiveFileContext.path);
        }
        // Capture the stored entry by reference so the async backfill below can
        // target it by object IDENTITY — robust against a dispatch, clear, or a
        // newer queued send (which all replace/remove the Map entry), where a
        // createdAt timestamp could collide at ms resolution.
        consumePromptBlock(promptBlock); // the queued entry carries it now
        if (!preserveComposerDraft) {
          chatInput.value = '';
          sessionQueue.clearQueuedAttachments(state, requestedSessionId);
          syncComposerInputHeight();
          syncComposerVisualState();
        }
        renderComposerState();
        appendClientLog('INFO', 'chat.queue_created', {
          sessionId: requestedSessionId, ...(queueUntilBackendReady ? { reason: 'backend_starting' } : {}),
          attachmentCount: attachmentBudget.accepted.length,
          mentionCount: queuedMentionPaths.length,
        });
        // Backfill the resolved @-mention contents once the (time-boxed) reads
        // settle, and apply the resolved-mention dedupe to the active-file slice.
        sendOutbox.settleContextCapture(queuedEntry, queuedMentionContentsPromise.then((contents) => {
          const capturedContents = Array.isArray(contents) ? contents : [];
          const norm = (path) => String(path || '').trim().replace(/\\/g, '/');
          const activePath = queuedActiveFileContext?.path ? norm(queuedActiveFileContext.path) : '';
          const activeFileContextSnapshot = activePath && capturedContents.some((entry) => norm(entry?.path) === activePath)
            ? null
            : queuedActiveFileContext;
          return { mentionContentsSnapshot: capturedContents, activeFileContextSnapshot };
        }));
        const queuedResult = { queued: true, sessionId: requestedSessionId };
        sendSlashDispatch.clearAcceptedImagePrompt(queuedResult, imagePromptPin, requestedSessionId, settings);
        return queuedResult;
      }
      return null;
    };
  }

  // The optimistic half of a send that is starting now: the pending-question patch, the optimistic
  // session row and user bubble, the first renders and the render-latency record. Returns the timing
  // the start payload carries. The caller owns preflight state so a throw here still reaches its catch.
  function createOptimisticSendRenderer(env) {
    const {
      state, sessionContext, getCurrentSessionId, patchSessionSummary, upsertSessionSummary,
      attachPendingOriginToSession, setSessionMessages, getSessionMessages, optimisticAppend,
      onUserSendStarted, renderMessages, renderSessions, renderHeader, renderComposerState,
      appendClientLog, clipSessionTitle, buildOptimisticAttachmentMetadata,
      INTERACTIVE_SEQUENCE_IDLE, INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
    } = env;
    return function renderOptimisticSend(c) {
      const {
        interactiveGuardrailFallback, pendingBatchSnapshot, createdOptimisticSession, optimisticSessionId,
        optimisticTitleSource, visiblePrompt, acceptedAttachments, runtimePreferences, runModeProjection,
        shouldAnimateActivation, isEditRegenerate, editedMessageId, skillInvocation, imagePromptPin,
        operationState, preflightState,
      } = c;
      const sequenceState = interactiveGuardrailFallback ? INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED : INTERACTIVE_SEQUENCE_IDLE;
      if (pendingBatchSnapshot) {
        patchSessionSummary(createdOptimisticSession ? optimisticSessionId : getCurrentSessionId(), {
          pending_question_batch: null,
          interactive_sequence_state: sequenceState,
          interactive_round_count: pendingBatchSnapshot.round_index,
        });
      }
      if (createdOptimisticSession) {
        const timestamp = new Date().toISOString();
        upsertSessionSummary({
          id: optimisticSessionId,
          title: clipSessionTitle(optimisticTitleSource),
          session_type: 'chat',
          created_at: timestamp,
          updated_at: timestamp,
          message_count: visiblePrompt || acceptedAttachments.length ? 1 : 0,
          last_message_preview: String(visiblePrompt || '').slice(0, 160),
          last_model_used: '',
          preferred_model: runtimePreferences.preferredModel,
          reasoning_effort: runtimePreferences.reasoningEffort,
          conversation_mode: 'chat',
          pending_question_batch: null,
          interactive_sequence_state: sequenceState,
          interactive_round_count: pendingBatchSnapshot?.round_index || 0,
          run_mode: runModeProjection.runMode,
          plan_mode: runModeProjection.planMode,
          context_preferences: {
            history_scope: runtimePreferences.contextPreferences.historyScope,
            include_personality: runtimePreferences.contextPreferences.includePersonality !== false,
            include_memory: runtimePreferences.contextPreferences.includeMemory !== false, memory_opt_out: runtimePreferences.contextPreferences.memoryOptOut === true,
          },
          optimistic_local: true,
          local_draft: false,
        }, { prepend: true });
        sessionContext.setSessionId(optimisticSessionId);
        attachPendingOriginToSession(optimisticSessionId);
        setSessionMessages(optimisticSessionId, getSessionMessages(optimisticSessionId), `session_${optimisticSessionId}`);
      }
      state.ui.animateNextChatActivation = shouldAnimateActivation;
      if (visiblePrompt || acceptedAttachments.length) {
        operationState.optimisticUserMessageId = isEditRegenerate
          ? editedMessageId
          : `user_local_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
        if (!isEditRegenerate) {
          optimisticAppend(optimisticSessionId, 'user', visiblePrompt, {
            id: operationState.optimisticUserMessageId,
            attachments: buildOptimisticAttachmentMetadata(acceptedAttachments),
            ...(skillInvocation ? { skill_invocation: skillInvocation } : {}),
            ...(imagePromptPin ? { image_prompt_pin: imagePromptPin } : {}),
          });
        }
        onUserSendStarted({
          sessionId: optimisticSessionId,
          prompt: visiblePrompt,
          attachmentCount: acceptedAttachments.length,
        });
      }
      renderMessages();
      renderSessions();
      renderHeader();
      renderComposerState();
      const optimisticRenderedAtMs = Date.now();
      const localRenderLatencyMs = Math.max(
        optimisticRenderedAtMs - Number(preflightState?.startedAt || optimisticRenderedAtMs),
        0
      );
      appendClientLog('INFO', 'chat.send_optimistic_rendered', {
        sessionId: optimisticSessionId,
        localRenderLatencyMs,
      });
      return { optimisticRenderedAtMs, localRenderLatencyMs };
    };
  }

  // The chat.startStream / editAndRegenerate payload of a send.
  function buildStartPayload(c) {
    const {
      targetSessionId, effectivePrompt, visiblePrompt, editedMessageId, failureRetry, traceId,
      runtimePreferences, acceptedAttachments, activeFileContext, mentionContents,
      normalizedInteractiveResponse, interactiveRoundCount, runModeProjection, toolPreferences,
      approvalMode, preflightState, optimisticRenderedAtMs, localRenderLatencyMs, skillInvocation,
      imagePromptPin,
    } = c;
    return {
      sessionId: targetSessionId,
      prompt: effectivePrompt,
      visiblePrompt,
      // CTL-001 anchor reuse: an edit-resend re-anchors the edited durable
      // user message instead of persisting a second copy of the prompt.
      ...(editedMessageId
        ? { editedMessageId, ...(failureRetry === true ? { failureRetry: true } : {}) }
        : {}),
      traceId,
      preferredModel: runtimePreferences.preferredModel,
      reasoningEffort: runtimePreferences.reasoningEffort,
      attachments: acceptedAttachments,
      contextPreferences: runtimePreferences.contextPreferences,
      activeFileContext,
      mentionContents,
      interactiveResponse: normalizedInteractiveResponse,
      interactiveRoundCount,
      planMode: runModeProjection.planMode,
      toolPreferences,
      approvalMode,
      clientTiming: {
        send_started_at_ms: Number(preflightState?.startedAt || 0),
        optimistic_rendered_at_ms: optimisticRenderedAtMs,
        local_render_latency_ms: localRenderLatencyMs,
      },
      ...(skillInvocation?.id ? { skillInvocation: { id: skillInvocation.id } } : {}),
      ...(imagePromptPin ? { imagePromptPin } : {}),
    };
  }

  return { attachmentRefs, buildStartPayload, createBusySendQueue, createOptimisticSendRenderer };
});
