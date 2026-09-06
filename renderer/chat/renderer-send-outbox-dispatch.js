/* renderer/chat/renderer-send-outbox-dispatch.js -- FIFO drain transition owner (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendOutboxDispatch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // A failed head blocks every queued send behind it (FIFO is deliberate —
  // §9), and for a non-current session there is no composer affordance and no
  // further turn terminal to re-trigger a drain. Bounded self-scheduled
  // retries cover transient failures; a persistently failing head stays
  // visible for manual retry (which resets the budget via failure: null).
  const MAX_QUEUED_SEND_AUTO_RETRIES = 3;
  const QUEUED_SEND_AUTO_RETRY_BASE_DELAY_MS = 2000;

  function createQueuedSendDispatcher(deps) {
    const {
      sendOutbox,
      getQueuedSend,
      isSessionBusy,
      hasPendingToolApprovalForSession,
      isDockApprovalSteerActive,
      startPromptSend,
      renderComposerState,
      renderSessions,
      appendClientLog = () => {},
      setTimeoutImpl = setTimeout,
      clearTimeoutImpl = clearTimeout,
      maxAutoRetries = MAX_QUEUED_SEND_AUTO_RETRIES,
      autoRetryBaseDelayMs = QUEUED_SEND_AUTO_RETRY_BASE_DELAY_MS,
    } = deps;
    const autoRetryTimers = new Map();
    const pendingDispatches = new Map();
    let disposed = false;

    function cancelAutoRetry(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const timer = autoRetryTimers.get(normalizedSessionId);
      if (timer === undefined) return false;
      clearTimeoutImpl(timer);
      autoRetryTimers.delete(normalizedSessionId);
      return true;
    }

    function scheduleAutoRetry(sessionId, failedEntryId, attempt, options) {
      if (disposed) return;
      cancelAutoRetry(sessionId);
      const delayMs = autoRetryBaseDelayMs * (2 ** (attempt - 1));
      appendClientLog('WARN', 'send.outbox_auto_retry_scheduled', {
        sessionId: String(sessionId).slice(0, 30),
        attempt,
        delayMs,
      });
      autoRetryTimers.set(sessionId, setTimeoutImpl(() => {
        autoRetryTimers.delete(sessionId);
        if (disposed) return;
        const head = getQueuedSend(sessionId);
        // Only retry the same still-failed head; anything else (removed,
        // edited, manually retried, replaced) owns its own transitions.
        if (!head || head.id !== failedEntryId || head.status !== 'failed') return;
        dispatchQueuedSendForSession(sessionId, options).catch(() => {
          /* dispatch failures are recorded on the entry itself */
        });
      }, delayMs));
    }

    async function runQueuedSendDispatch(normalizedSessionId, options) {
      let queuedSend = getQueuedSend(normalizedSessionId);
      if (disposed || !normalizedSessionId || !queuedSend) return null;
      queuedSend = await sendOutbox.awaitContextCapture(queuedSend);
      if (disposed || !queuedSend) return null;
      const priorAutoRetries = Number(queuedSend.failure?.autoRetryCount) || 0;
      if (queuedSend.status === 'failed') {
        if (priorAutoRetries > maxAutoRetries) return null;
        // Re-enter the drain while keeping the failure record (and its
        // auto-retry budget) until the dispatch outcome replaces it.
        queuedSend = sendOutbox.replace(queuedSend, { status: 'ready' });
        if (!queuedSend) return null;
      }
      if (!['ready', 'waiting_for_turn'].includes(queuedSend.status)) return null;
      if (isSessionBusy(normalizedSessionId)
        || (hasPendingToolApprovalForSession(normalizedSessionId) && !isDockApprovalSteerActive())) {
        sendOutbox.replace(queuedSend, { status: 'waiting_for_turn' });
        return null;
      }
      cancelAutoRetry(normalizedSessionId);
      const sendingEntry = sendOutbox.replace(queuedSend, {
        status: 'sending',
        failure: null,
        attachmentOwner: queuedSend.attachments?.length ? 'send_receipt' : 'none',
      });
      if (!sendingEntry) return null;
      const dispatchOptions = {
        sessionIdOverride: normalizedSessionId,
        replayImageAttachments: queuedSend.attachments,
        preserveComposerDraft: true,
        restoreDraftOnStartStreamReject: false,
        recordFailedPayload: false,
        outboxDispatch: true,
        preserveCurrentSessionOnDispatch: options.preserveCurrentSessionOnDispatch === true,
        runtimePreferencesSnapshot: queuedSend.runtimePreferences || null,
      };
      const queuedMeta = sendingEntry.meta && typeof sendingEntry.meta === 'object' ? sendingEntry.meta : null;
      if (queuedMeta && Object.prototype.hasOwnProperty.call(queuedMeta, 'mentionContentsSnapshot')) {
        dispatchOptions.mentionContentsSnapshot = Array.isArray(queuedMeta.mentionContentsSnapshot)
          ? queuedMeta.mentionContentsSnapshot
          : [];
      }
      if (queuedMeta && Object.prototype.hasOwnProperty.call(queuedMeta, 'activeFileContextSnapshot')) {
        dispatchOptions.activeFileContextSnapshot = queuedMeta.activeFileContextSnapshot || null;
      }
      let dispatchResult = null;
      try {
        dispatchResult = await startPromptSend(sendingEntry.prompt, dispatchOptions);
      } catch (error) {
        appendClientLog('ERROR', 'send.outbox_dispatch_failed', {
          sessionId: normalizedSessionId.slice(0, 30),
          errorName: String(error?.name || 'Error').slice(0, 80),
        });
      }
      if (disposed) return dispatchResult;
      if (dispatchResult) {
        const sentEntry = sendOutbox.replace(sendingEntry, { status: 'sent', failure: null });
        if (sentEntry) sendOutbox.remove(sentEntry);
      } else {
        const attempt = priorAutoRetries + 1;
        const failedEntry = sendOutbox.replace(sendingEntry, {
          status: 'failed',
          attachmentOwner: sendingEntry.attachments?.length ? 'outbox' : 'none',
          failure: {
            reason: 'dispatch_failed',
            failedAt: new Date().toISOString(),
            autoRetryCount: attempt,
          },
        });
        if (failedEntry && attempt <= maxAutoRetries) {
          scheduleAutoRetry(normalizedSessionId, failedEntry.id, attempt, options);
        } else if (failedEntry) {
          appendClientLog('WARN', 'send.outbox_auto_retry_exhausted', {
            sessionId: normalizedSessionId.slice(0, 30),
            attempts: attempt,
          });
        }
      }
      renderComposerState();
      renderSessions();
      return dispatchResult;
    }

    // Stop intent: a user Stop must hand the queued entry back to the
    // composer, never send it as a new turn. The cancelled terminal can land
    // before the cancel IPC resolves and reach this drain first, so the stop
    // path parks a hold here; the next drain consumes it and returns null, which
    // the terminal handler treats as "restore". Released on a refused cancel or
    // once the stop path restored the entry itself.
    const dispatchHoldBySession = new Map();

    function holdNextDispatch(sessionId, streamId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (normalizedSessionId) dispatchHoldBySession.set(normalizedSessionId, String(streamId || '').trim());
    }

    function releaseHold(sessionId, streamId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (dispatchHoldBySession.get(normalizedSessionId) === String(streamId || '').trim()) {
        dispatchHoldBySession.delete(normalizedSessionId);
      }
    }

    function dispatchQueuedSendForSession(sessionId, options = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (disposed || !normalizedSessionId) return Promise.resolve(null);
      if (dispatchHoldBySession.has(normalizedSessionId)) {
        const heldStreamId = dispatchHoldBySession.get(normalizedSessionId);
        const terminalStreamId = String(options.streamId || '').trim();
        if (heldStreamId && terminalStreamId !== heldStreamId) return Promise.resolve(null);
        dispatchHoldBySession.delete(normalizedSessionId);
        appendClientLog('INFO', 'send.outbox_dispatch_held_after_stop', {
          sessionId: normalizedSessionId.slice(0, 30),
        });
        return Promise.resolve(null);
      }
      const pending = pendingDispatches.get(normalizedSessionId);
      if (pending) return pending;
      const operation = runQueuedSendDispatch(normalizedSessionId, options).finally(() => {
        if (pendingDispatches.get(normalizedSessionId) === operation) {
          pendingDispatches.delete(normalizedSessionId);
        }
      });
      pendingDispatches.set(normalizedSessionId, operation);
      return operation;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of autoRetryTimers.values()) clearTimeoutImpl(timer);
      autoRetryTimers.clear();
      pendingDispatches.clear();
    }

    dispatchQueuedSendForSession.cancelAutoRetry = cancelAutoRetry;
    dispatchQueuedSendForSession.holdNextDispatch = holdNextDispatch;
    dispatchQueuedSendForSession.releaseHold = releaseHold;
    dispatchQueuedSendForSession.dispose = dispose;

    return dispatchQueuedSendForSession;
  }

  return { createQueuedSendDispatcher };
});
