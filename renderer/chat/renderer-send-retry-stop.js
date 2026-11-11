(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendRetryStop = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Failed-payload retry and the Stop protocol of the send controller. The dispatcher is resolved on use
  // (it is created after this module), exactly like the hoisted function it replaces.
  function createSendRetryStop(env) {
    const {
      sendReceipts, multiStreamController, isSessionBusy, showComposerActionError, startPromptSend,
      getCurrentSessionId, getSessionMessages, setSessionMessages, renderMessages, appendClientLog,
      getQueuedSend, restoreQueuedSendDraft, getDispatcher, publishCancelImpulse, busyReason,
    } = env;

    function getFailedPayloadRetryAvailability(payloadId) {
      const availability = sendReceipts.getRetryAvailability(payloadId);
      if (!availability.available) return availability;
      const payload = sendReceipts.getFailedPayload(payloadId);
      if (!payload || !payload.sessionId) {
      return { available: false, reason: jt('chat.send.failedPayloadNoDestination', 'The original failed payload has no destination chat.') };
      }
      return availability;
    }

    function dismissFailureMarkerForPayload(sessionId, payloadId) {
      const normalizedPayloadId = String(payloadId || '').trim();
      if (!normalizedPayloadId) return false;
      const messages = getSessionMessages(sessionId);
      let changed = false;
      const next = (Array.isArray(messages) ? messages : []).map((message) => {
        if (String(message?.send_failure?.payload_id || '').trim() !== normalizedPayloadId
          || message.send_failure.dismissed === true) return message;
        changed = true;
        return { ...message, send_failure: { ...message.send_failure, dismissed: true } };
      });
      if (changed) setSessionMessages(sessionId, next, `session_${sessionId}`);
      return changed;
    }

    async function retryFailedPayload(payloadId) {
      const availability = getFailedPayloadRetryAvailability(payloadId);
      if (!availability.available) return null;
      const payload = sendReceipts.getFailedPayload(payloadId);
      if (isSessionBusy(payload.sessionId)) {
        showComposerActionError(new Error(busyReason), jt('chat.send.retryUnavailableTitle', 'Retry Unavailable'));
        return null;
      }
      const result = await startPromptSend(payload.prompt, {
        visiblePrompt: payload.visiblePrompt,
        sessionIdOverride: payload.sessionId,
        runtimePreferencesSnapshot: payload.runtimePreferences,
        replayImageAttachments: payload.attachments,
        preserveComposerDraft: true,
        preserveCurrentSessionOnDispatch: getCurrentSessionId() !== payload.sessionId,
        restoreDraftOnStartStreamReject: false,
        mentionContentsSnapshot: payload.mentionContents || [],
        activeFileContextSnapshot: payload.activeFileContext || null,
        interactiveResponse: payload.interactiveResponse || null,
        skillInvocation: payload.skillInvocation || null,
        imagePromptPin: payload.imagePromptPin || null,
        failedPayloadId: payload.id,
      });
      const retryDidNotStart = !result || result.rejected === true
        || result.queued === true || result.failed === true;
      if (!retryDidNotStart && String(result.streamId || '').trim()
        && dismissFailureMarkerForPayload(payload.sessionId, payload.id)) {
        renderMessages();
      }
      return result;
    }

    function dismissFailedPayload(payloadId) {
      return sendReceipts.dismissFailedPayload(payloadId);
    }

    async function handleStopActiveStream(sessionIdInput) { // session-scoped callers (lockdown) share the Stop hold protocol
      const activeSessionId = (typeof sessionIdInput === 'string' && sessionIdInput.trim()) || getCurrentSessionId();
      const activeStreamId = String(
        multiStreamController?.getActiveStreamIdForCancel(activeSessionId) || ''
      ).trim();
      if (!activeStreamId) {
        return null;
      }
      appendClientLog('INFO', 'chat.cancel_requested', { streamId: activeStreamId, sessionId: activeSessionId });
      // Hold the drain BEFORE the round-trip: a cancelled terminal that lands
      // first must restore the queued entry to the composer, not send it.
      const queuedAtStop = getQueuedSend(activeSessionId) || null;
      if (queuedAtStop) getDispatcher().holdNextDispatch(activeSessionId, activeStreamId);
      let cancelResult;
      try {
        cancelResult = await window.jennyShell.chat.cancelStream(activeStreamId);
      } catch (error) {
        // A failed cancel leaves the stream running: its terminal must drain
        // the queued entry normally, not restore it as if Stop had worked.
        getDispatcher().releaseHold(activeSessionId, activeStreamId);
        throw error;
      }
      // CTL-009: a refused cancel (stream already finished/unknown by the time
      // this round-trip landed) is a no-op — don't report the success shape
      // that drives UI state for a cancellation that never happened. The
      // stream had ended, so its terminal drain runs as normal (hold released).
      // Refusal shape owned by isCancelStreamRefused.
      if (multiStreamController.isCancelStreamRefused(cancelResult)) {
        appendClientLog('WARN', 'chat.cancel_refused', { streamId: activeStreamId, sessionId: activeSessionId });
        getDispatcher().releaseHold(activeSessionId, activeStreamId);
        return null;
      }
      // The terminal may already have restored the head entry itself;
      // restoring whatever is queued NOW would act on the next entry and park
      // it as needs_review. Only the entry queued when Stop was pressed is ours.
      const queuedAfterCancel = getQueuedSend(activeSessionId) || null;
      if (queuedAtStop && queuedAfterCancel?.id === queuedAtStop.id && getCurrentSessionId() === activeSessionId) {
        getDispatcher().releaseHold(activeSessionId, activeStreamId);
        restoreQueuedSendDraft(activeSessionId);
      }
      // No stream payload exists at the cancel site — omit timeStamp so the
      // manager stamps the impulse with its own monotonic clock.
      publishCancelImpulse({ sessionId: activeSessionId, streamId: activeStreamId });
      return { streamId: activeStreamId, sessionId: activeSessionId };
    }

    return {
      getFailedPayloadRetryAvailability,
      retryFailedPayload,
      dismissFailedPayload,
      handleStopActiveStream,
    };
  }

  return { createSendRetryStop };
});
