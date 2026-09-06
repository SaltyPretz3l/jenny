(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendCompletion = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createSendCompletion(deps) {
    const { state, navigationIntent, sendReceipts, constants, callbacks, helpers } = deps;

    async function completeAcceptedSend(result, context) {
      const {
        activeFileContext, activeFileContextController, chatBridge,
        createdOptimisticSession, interactiveGuardrailFallback,
        isEditRegenerate, normalizedInteractiveResponse, operationState, optimisticSessionId,
        pendingBatchSnapshot, preflightState,
        preserveCurrentSessionOnDispatch, previousSessionId, sendNavigationToken,
        sendReceipt, settings,
      } = context;
      const resultStreamId = String(result?.streamId || '').trim();
      const authoritativeUserMessageId = String(result?.identity?.userMessageId || '').trim();
      const expectedEditedMessageId = String(settings.editedMessageId || '').trim();
      const acceptedEditedIdentity = Boolean(resultStreamId && authoritativeUserMessageId === expectedEditedMessageId);
      const cancelAcceptedEditStream = async () => {
        if (!resultStreamId) return;
        callbacks.dropBufferedStreamEvents(resultStreamId);
        await chatBridge?.cancelStream?.(resultStreamId, {
          cancel_reason: 'transport_abort',
        })?.catch?.(() => {});
      };
      const resultSessionId = String(result?.sessionId || '').trim();
      if (!result || typeof result !== 'object' || !resultStreamId || !resultSessionId) {
        await cancelAcceptedEditStream();
        await callbacks.refreshSessionSummaries(optimisticSessionId, { preserveCurrentSession: true }).catch(() => null);
        throw new Error('Chat start returned an incomplete acceptance receipt.');
      }
      if (!sendReceipts.isPending(sendReceipt)) {
        callbacks.dropBufferedStreamEvents(resultStreamId);
        await chatBridge.cancelStream(resultStreamId, { cancel_reason: 'transport_abort' }).catch(() => {});
        return null;
      }
      if (isEditRegenerate && !acceptedEditedIdentity) {
        await cancelAcceptedEditStream();
        throw new Error('Edit-and-regenerate did not return the edited user message identity.');
      }
      if (isEditRegenerate && typeof settings.onAuthoritativeStart === 'function') {
        let reconciliationAccepted = false;
        try {
          reconciliationAccepted = settings.onAuthoritativeStart(result) !== false;
        } catch {
          callbacks.appendClientLog('ERROR', 'chat.edit_authoritative_start_callback_failed', {
            sessionId: String(settings.sessionIdOverride || '').slice(0, 30),
            streamId: resultStreamId, failureClass: 'callback_error',
          });
        }
        if (!reconciliationAccepted) {
          await cancelAcceptedEditStream();
          throw new Error('Edit-and-regenerate could not reconcile the edited message.');
        }
      }
      operationState.acceptedStreamId = resultStreamId;

      let resolvedSessionId = String(result.sessionId || '').trim();
      const optimisticSessionStillPresent = state.sessions.some(
        (session) => String(session?.id || '').trim() === optimisticSessionId
      );
      if (createdOptimisticSession && (!optimisticSessionStillPresent || preflightState?.discarded === true)) {
        callbacks.clearSessionPreflight(preflightState, result.streamId);
        callbacks.clearChatSendLifecycle(optimisticSessionId);
        callbacks.dropBufferedStreamEvents(result.streamId);
        await chatBridge.cancelStream(result.streamId, {
          cancel_reason: 'transport_abort',
        }).catch(() => {});
        callbacks.clearOptimisticSendIndicator({ resetThinking: true });
        sendReceipts.settleFailed(sendReceipt, { retryable: true });
        return null;
      }
      // The acceptance survived renderer admission and optimistic-session
      // abandonment checks, so Electron's persisted message is now the asset
      // owner. Transfer before later awaits so disposal/reconciliation cannot
      // delete media still referenced by canonical session history.
      sendReceipts.transferAttachmentsToCanonicalHistory(sendReceipt);
      if (activeFileContext?.path) {
        activeFileContextController?.markTurnAccepted?.(activeFileContext.path);
      }
      if (createdOptimisticSession && resolvedSessionId && resolvedSessionId !== optimisticSessionId) {
        resolvedSessionId = callbacks.rekeySessionState(optimisticSessionId, resolvedSessionId) || resolvedSessionId;
        callbacks.rekeySessionOrigin(optimisticSessionId, resolvedSessionId);
        callbacks.moveChatSendLifecycle(optimisticSessionId, resolvedSessionId);
        callbacks.moveSessionPreflight(preflightState, resolvedSessionId);
      }
      resolvedSessionId = callbacks.resolveSessionId(resolvedSessionId || optimisticSessionId) || optimisticSessionId;
      operationState.resolvedSessionId = resolvedSessionId;
      callbacks.resolveSessionPreflight(preflightState, result.streamId, resolvedSessionId);
      // The backend identity is authoritative. Ordinary starts retain a
      // logged compatibility fallback for older runtimes and renderer fakes;
      // edit-and-regenerate must never guess because its anchor may be any id.
      let persistedUserId = authoritativeUserMessageId;
      if (!persistedUserId && resultStreamId && !isEditRegenerate) {
        persistedUserId = `user_${resultStreamId}`;
        callbacks.appendClientLog('DEBUG', 'chat.start_identity_legacy_fallback', {
          sessionId: resolvedSessionId,
          streamId: resultStreamId,
        });
      }
      if (
        !isEditRegenerate
        && operationState.optimisticUserMessageId
        && persistedUserId
        && persistedUserId !== operationState.optimisticUserMessageId
      ) {
        if (helpers.adoptPersistedUserMessageIdInStore(
          resolvedSessionId,
          operationState.optimisticUserMessageId,
          persistedUserId
        )) {
          // Keep the rollback annotation (failure path) pointed at the renamed row.
          operationState.optimisticUserMessageId = persistedUserId;
        }
      }
      callbacks.appendClientLog('DEBUG', 'chat.send_session_chain', {
        optimisticSessionId: String(optimisticSessionId || '').slice(0, 30),
        resolvedSessionId: String(resolvedSessionId || '').slice(0, 30),
        previousSessionId: String(previousSessionId || '').slice(0, 30),
        currentSessionId: String(state.currentSessionId || '').slice(0, 30),
        createdOptimisticSession,
        activeView: state.ui?.activeView,
      });
      callbacks.multiStreamController?.registerStream?.(resolvedSessionId, result.streamId);
      callbacks.setChatSendLifecycle(resolvedSessionId, 'streaming');
      if (!preserveCurrentSessionOnDispatch && navigationIntent.isCurrent(sendNavigationToken)) {
        state.currentSessionId = resolvedSessionId;
      }
      if (pendingBatchSnapshot) {
        callbacks.clearInteractiveDraft(resolvedSessionId);
      }
      // The immutable receipt already consumed the origin draft. Never read or
      // reset the live global composer here; it may now belong to another session.
      callbacks.patchSessionSummary(resolvedSessionId, {
        interactive_sequence_state: interactiveGuardrailFallback
          ? constants.INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED
          : callbacks.getInteractiveSequenceState(callbacks.getActiveSession()),
      });
      const bufferedFlushResult = await callbacks.flushBufferedStreamEvents(result.streamId);
      if (!sendReceipts.isPending(sendReceipt)) {
        callbacks.dropBufferedStreamEvents(result.streamId);
        await chatBridge.cancelStream(result.streamId, { cancel_reason: 'transport_abort' }).catch(() => {});
        return null;
      }
      callbacks.appendClientLog('DEBUG', 'chat.send_buffer_flush', {
        streamId: String(result.streamId || '').slice(0, 30),
        sessionId: String(resolvedSessionId || '').slice(0, 30),
        flushedCount: bufferedFlushResult?.flushedCount || 0,
        terminal: bufferedFlushResult?.terminal || false,
      });
      if (state.currentSessionId !== resolvedSessionId
        && !preserveCurrentSessionOnDispatch
        && navigationIntent.isCurrent(sendNavigationToken)) {
        callbacks.appendClientLog('WARN', 'chat.send_session_desync', {
          expected: String(resolvedSessionId || '').slice(0, 30),
          actual: String(state.currentSessionId || '').slice(0, 30),
        });
        state.currentSessionId = resolvedSessionId;
      } else if (state.currentSessionId !== resolvedSessionId && !preserveCurrentSessionOnDispatch) {
        await navigationIntent.navigateOrNotify(sendNavigationToken, resolvedSessionId, {
          navigate: (sessionId) => callbacks.activateWorkspaceSession(sessionId, { silent: true }),
          showToastMessage: callbacks.showToastMessage,
          message: 'Your message started in another chat while you were working here.',
          title: 'Message started',
          source: constants.TOAST_SOURCE.chatStream,
          dedupeKey: `${constants.TOAST_SOURCE.chatStream}:open:${resolvedSessionId}`,
        });
      }
      callbacks.renderMessages();
      callbacks.renderSessions();
      callbacks.renderHeader();
      callbacks.renderComposerState();
      callbacks.appendClientLog('INFO', 'chat.send', { sessionId: resolvedSessionId });
      if (interactiveGuardrailFallback && normalizedInteractiveResponse) {
        callbacks.appendClientLog('WARN', 'interactive.guardrail_fallback_requested', {
          sessionId: resolvedSessionId,
          roundIndex: normalizedInteractiveResponse.round_index,
          maxRounds: constants.MAX_INTERACTIVE_ROUNDS,
        });
      }
      if (!bufferedFlushResult?.terminal) {
        callbacks.refreshSessionSummaries(resolvedSessionId, { preserveCurrentSession: true }).catch((error) => {
          callbacks.appendClientLog('WARN', 'chat.post_send_session_refresh_failed', {
            sessionId: resolvedSessionId,
            message: error.message || String(error),
          });
        });
      }
      if (sendReceipts.settleAccepted(sendReceipt, { sessionId: resolvedSessionId }).ignored) {
        callbacks.dropBufferedStreamEvents(result.streamId);
        await chatBridge.cancelStream(result.streamId, { cancel_reason: 'transport_abort' }).catch(() => {});
        return null;
      }
      return {
        ...result,
        sessionId: resolvedSessionId,
      };
    }

    async function completeFailedSend(error, context) {
      const {
        chatBridge, createdOptimisticSession, isEditRegenerate, isOutboxDispatch, operationState,
        optimisticSessionId, pendingBatchSnapshot, previousSessionId,
        sendNavigationToken, sendReceipt, settings, visiblePrompt,
      } = context;
      const candidate = error && typeof error === 'object' ? error : {};
      const acceptedStreamId = String(operationState.acceptedStreamId || '').trim();
      if (acceptedStreamId) {
        callbacks.dropBufferedStreamEvents(acceptedStreamId);
        await chatBridge?.cancelStream?.(acceptedStreamId, {
          cancel_reason: 'transport_abort',
        })?.catch?.(() => {});
      }
      const rollbackSessionId = String(operationState.resolvedSessionId || optimisticSessionId).trim();
      const settlement = sendReceipts.settleFailed(sendReceipt, {
        sessionId: rollbackSessionId,
        retryable: candidate.retryable !== false,
      });
      if (settlement.ignored) return null;
      callbacks.clearSessionPreflight(context.preflightState);
      // A send that fails before acceptance never reaches finishPostworkWindow,
      // and only the current session's composer re-renders here — stamp the
      // turn clock now so an off-screen failure can't tick until the user
      // switches back and freeze an inflated total.
      const failedTurnClock = state.turnClockBySession?.get(rollbackSessionId);
      if (failedTurnClock && failedTurnClock.endedAt == null) failedTurnClock.endedAt = Date.now();
      callbacks.clearOptimisticSendIndicator({ resetThinking: true });
      const restoredDraft = settlement.restoredToComposer;
      if (isOutboxDispatch) callbacks.clearChatSendLifecycle(rollbackSessionId);
      else callbacks.setChatSendLifecycle(rollbackSessionId, 'failed');
      const failureMetadata = helpers.buildSendFailureMetadata(error, {
        restoredToComposer: restoredDraft,
        failedPayloadId: settlement.failedPayload?.id,
      });
      if (isOutboxDispatch) {
        helpers.discardOptimisticUserSend(rollbackSessionId, operationState.optimisticUserMessageId);
      } else if (!isEditRegenerate) {
        helpers.annotateOptimisticUserSendFailure(
          rollbackSessionId,
          operationState.optimisticUserMessageId,
          failureMetadata
        );
      }
      if (createdOptimisticSession) {
        const rollbackMessages = [...callbacks.getSessionMessages(rollbackSessionId)];
        let failureMessage = rollbackMessages.find(
          (message) => String(message?.role || '').trim() === 'assistant'
            && String(message?.status || '').trim() === 'error'
            && String(message?.stream_error || '').trim()
        ) || null;
        if (!failureMessage) {
          failureMessage = helpers.buildDurableFailureMessage(
            error,
            rollbackSessionId,
            callbacks.createNormalizedMessage
          );
          rollbackMessages.push(failureMessage);
          callbacks.setSessionMessages(
            rollbackSessionId,
            rollbackMessages,
            `session_${rollbackSessionId}`
          );
        }
        callbacks.patchSessionSummary(rollbackSessionId, {
          updated_at: String(failureMessage?.finalizedAt || failureMessage?.timestamp || new Date().toISOString()),
          message_count: rollbackMessages.length,
          last_message_preview: helpers.summarizeDurableFailurePreview(visiblePrompt, failureMessage),
        });
        if (navigationIntent.isCurrent(sendNavigationToken)) state.currentSessionId = rollbackSessionId;
      } else if (navigationIntent.isCurrent(sendNavigationToken)) {
        state.currentSessionId = previousSessionId;
      }
      if (pendingBatchSnapshot) {
        callbacks.patchSessionSummary(
          (createdOptimisticSession ? rollbackSessionId : previousSessionId) || rollbackSessionId,
          {
            pending_question_batch: pendingBatchSnapshot,
            interactive_sequence_state: constants.INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
            interactive_round_count: pendingBatchSnapshot.round_index,
          }
        );
      }
      callbacks.renderMessages();
      callbacks.renderSessions();
      callbacks.renderHeader();
      callbacks.renderComposerState();
      if (isEditRegenerate) {
        // The backend command is atomic: the editor remains open and owns the
        // retry draft, while the existing edited anchor remains untouched.
        // Electron IPC rejections lose custom error props, so the wrapped
        // message string is the only surviving detail — surface it instead of
        // masking every rejection behind the same generic sentence.
        const rejectionDetail = String(candidate.message || '').trim();
        callbacks.showComposerActionError(
          new Error(rejectionDetail
            ? `${constants.EDIT_REGENERATE_FAILURE_MESSAGE} (${rejectionDetail})`
            : constants.EDIT_REGENERATE_FAILURE_MESSAGE),
          'Edit Failed'
        );
      } else if (!createdOptimisticSession && !isOutboxDispatch) {
        callbacks.showComposerActionError(error, 'Send Failed');
      }
      callbacks.appendClientLog('ERROR', 'chat.send_failed', isEditRegenerate
        ? {
            sessionId: String(rollbackSessionId || '').slice(0, 30),
            editRegenerate: true,
            failureClass: 'edit_regenerate_rejected',
            errorCode: String(candidate.error_code || candidate.code || '').slice(0, 40),
            category: String(candidate.category || '').slice(0, 40),
            errorMessage: String(candidate.message || '').slice(0, 200),
          }
        : {
            sessionId: String(rollbackSessionId || '').slice(0, 30),
            editRegenerate: false,
            errorCode: String(candidate.error_code || candidate.code || 'CMP-CHAT-0002').slice(0, 40),
            category: String(candidate.category || 'transport').slice(0, 40),
            failedPayloadId: String(settlement.failedPayload?.id || '').slice(0, 50),
          });
      return null;
    }

    function finalizeSend() {
      if (sendReceipts.isDisposed()) return;
      callbacks.clearOptimisticSendIndicator();
      callbacks.syncComposerInputHeight();
      callbacks.syncComposerVisualState();
      callbacks.renderComposerState();
    }

    return { completeAcceptedSend, completeFailedSend, finalizeSend };
  }

  return { createSendCompletion };
});
