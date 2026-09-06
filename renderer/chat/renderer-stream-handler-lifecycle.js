/* renderer/chat/renderer-stream-handler-lifecycle.js -- stream-handler register/dispose/rehydrate lifecycle helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerLifecycle = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function resolveStreamMailboxModule() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererStreamMailbox) {
      return globalThis.rendererStreamMailbox;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-stream-mailbox'); } catch (_error) { /* browser script mode */ }
    }
    return null;
  }

  function createStreamHandlerLifecycle(options = {}) {
    const {
      state,
      normalizeId,
      appendClientLog,
      handleStreamPayload,
      handleStreamEnvelope,
      handleStreamRecovery,
      pendingStreamCommitQueue,
      runtime,
      approvalToastSessionIds,
      reasoningStreamMerger,
      streamRehydrateUtils,
      isRowModelEnabled,
      getLiveStateStore,
      isStreamEnvelopeV2Enabled = () => false,
      streamEnvelopeReceiptTracker = null,
      clearBufferedStreamEvents,
    } = options || {};

    if (!state || typeof state !== 'object') {
      throw new Error('createStreamHandlerLifecycle requires options.state');
    }
    if (typeof normalizeId !== 'function') {
      throw new Error('createStreamHandlerLifecycle requires normalizeId');
    }
    if (typeof handleStreamPayload !== 'function') {
      throw new Error('createStreamHandlerLifecycle requires handleStreamPayload');
    }
    if (handleStreamEnvelope != null && typeof handleStreamEnvelope !== 'function') {
      throw new Error('createStreamHandlerLifecycle requires handleStreamEnvelope to be a function when provided');
    }
    if (handleStreamRecovery != null && typeof handleStreamRecovery !== 'function') {
      throw new Error('createStreamHandlerLifecycle requires handleStreamRecovery to be a function when provided');
    }
    if (typeof appendClientLog !== 'function') {
      throw new Error('createStreamHandlerLifecycle requires appendClientLog');
    }
    if (!pendingStreamCommitQueue || typeof pendingStreamCommitQueue.dispose !== 'function') {
      throw new Error('createStreamHandlerLifecycle requires pendingStreamCommitQueue');
    }
    if (!(approvalToastSessionIds instanceof Set)) {
      throw new Error('createStreamHandlerLifecycle requires approvalToastSessionIds (Set)');
    }
    if (typeof isRowModelEnabled !== 'function' || typeof getLiveStateStore !== 'function') {
      throw new Error('createStreamHandlerLifecycle requires row-model helpers');
    }
    const mailboxModule = resolveStreamMailboxModule();
    if (!mailboxModule || typeof mailboxModule.createStreamMailbox !== 'function') {
      throw new Error('renderer-stream-mailbox must load before renderer-stream-handler-lifecycle');
    }
    const streamMailbox = mailboxModule.createStreamMailbox();

    let streamUnsubscribe = null;
    let recoveryUnsubscribe = null;
    let featuresUnsubscribe = null;
    let currentEnvelopeMode = null;
    let lastShellRef = null;
    let beforeUnloadRegistered = false;
    let forcedLegacyReason = '';

    function safeUnsubscribeStream(reason) {
      if (typeof streamUnsubscribe !== 'function') {
        streamUnsubscribe = null;
        return false;
      }
      const unsubscribe = streamUnsubscribe;
      streamUnsubscribe = null;
      try {
        unsubscribe();
        return true;
      } catch (error) {
        appendClientLog('WARN', 'stream.unsubscribe_failed', {
          reason: String(reason || 'unknown').slice(0, 60),
          message: String(error?.message || error).slice(0, 300),
        });
        return false;
      }
    }

    function safeUnsubscribeRecovery(reason) {
      if (typeof recoveryUnsubscribe !== 'function') {
        recoveryUnsubscribe = null;
        return false;
      }
      const unsubscribe = recoveryUnsubscribe;
      recoveryUnsubscribe = null;
      try {
        unsubscribe();
        return true;
      } catch (error) {
        appendClientLog('WARN', 'stream.envelope_recovery_unsubscribe_failed', {
          reason: String(reason || 'unknown').slice(0, 60),
          message: String(error?.message || error).slice(0, 300),
        });
        return false;
      }
    }

    function removeBeforeUnloadListener() {
      if (!beforeUnloadRegistered) {
        return;
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('beforeunload', dispose);
      }
      beforeUnloadRegistered = false;
    }

    function removeFeaturesListener() {
      if (typeof featuresUnsubscribe !== 'function') {
        return;
      }
      try {
        featuresUnsubscribe();
      } catch (_error) {
        // best-effort
      }
      featuresUnsubscribe = null;
    }

    function readEnvelopeFlag() {
      try {
        return isStreamEnvelopeV2Enabled() === true && !forcedLegacyReason;
      } catch (error) {
        appendClientLog('WARN', 'stream.envelope_v2_flag_failed', {
          message: String(error?.message || error).slice(0, 300),
        });
        return false;
      }
    }

    // Re-check the envelope flag and re-register only when the desired mode
    // differs from the live subscription. The first registerStreamHandler call
    // can run against the bootstrap placeholder feature flags (before the
    // initial features.getState() pull resolves), and that pull does NOT fire
    // features.onChanged — so bind-time mode must never be latched permanently.
    // Shared by the onChanged push listener and the explicit post-bootstrap
    // resync in bootstrapAppShell.
    function resyncStreamSubscriptionMode() {
      if (!lastShellRef) {
        return null;
      }
      const nextMode = readEnvelopeFlag() ? 'envelope' : 'legacy';
      if (nextMode === currentEnvelopeMode) {
        return null;
      }
      appendClientLog('INFO', 'stream.envelope_v2_resubscribe', {
        from: currentEnvelopeMode || 'initial',
        to: nextMode,
      });
      return registerStreamHandler(lastShellRef);
    }

    function ensureFeaturesListener(jennyShell) {
      if (typeof featuresUnsubscribe === 'function') {
        return;
      }
      if (typeof jennyShell?.features?.onChanged !== 'function') {
        return;
      }
      try {
        featuresUnsubscribe = jennyShell.features.onChanged(() => {
          let rawEnvelopeEnabled = false;
          try {
            rawEnvelopeEnabled = isStreamEnvelopeV2Enabled() === true;
          } catch (_error) {
            // readEnvelopeFlag logs the actionable warning during resync.
          }
          if (!rawEnvelopeEnabled) {
            forcedLegacyReason = '';
          }
          // applyFeatureStatePayload runs in app.js's listener (registered earlier in
          // bootstrap) before this one fires, so the resync reads the fresh value.
          // Re-registering only on a mode change keeps every other
          // features.onChanged event cheap.
          resyncStreamSubscriptionMode();
        });
      } catch (error) {
        appendClientLog('WARN', 'stream.envelope_v2_features_subscribe_failed', {
          message: String(error?.message || error).slice(0, 300),
        });
      }
    }

    function registerStreamHandler(jennyShell) {
      lastShellRef = jennyShell || lastShellRef;
      // A subscription replacement is a renderer-ownership boundary. Abort
      // callbacks already executing under the prior listener before binding
      // the next mode so they cannot mutate the new handler generation.
      const rendererEpoch = streamMailbox.beginEpoch();
      safeUnsubscribeStream('resubscribe');
      safeUnsubscribeRecovery('resubscribe');
      removeBeforeUnloadListener();
      const chatBridge = lastShellRef?.chat || null;
      const wantsEnvelope = readEnvelopeFlag();
      const hasLegacyBridge = typeof chatBridge?.onStream === 'function';
      const hasEnvelopeBridge = typeof chatBridge?.onStreamEnvelope === 'function';
      const envelopeEnabled = wantsEnvelope
        && hasEnvelopeBridge
        && typeof handleStreamEnvelope === 'function';
      if (typeof chatBridge?.onStreamRecoveryRequired === 'function'
        && typeof handleStreamRecovery === 'function') {
        try {
          recoveryUnsubscribe = chatBridge.onStreamRecoveryRequired((ticket) => {
            const ticketEpoch = ticket?.renderer_epoch;
            if (!Number.isSafeInteger(ticketEpoch) || ticketEpoch !== streamMailbox.getRendererEpoch()) {
              appendClientLog('DEBUG', 'stream.envelope_recovery_stale_ticket', {
                recoveryId: String(ticket?.recovery_id || '').slice(0, 30),
                rendererEpoch: Number(ticketEpoch) || 0,
                currentRendererEpoch: streamMailbox.getRendererEpoch(),
              });
              return Promise.resolve({ ok: false, reason: 'stale_renderer_epoch' });
            }
            return Promise.resolve(handleStreamRecovery(ticket)).catch((error) => {
              appendClientLog('WARN', 'stream.envelope_recovery_handler_failed', {
                recoveryId: String(ticket?.recovery_id || '').slice(0, 30),
                message: String(error?.message || error).slice(0, 300),
              });
              return { ok: false, reason: 'recovery_handler_failed' };
            });
          });
        } catch (error) {
          recoveryUnsubscribe = null;
          appendClientLog('WARN', 'stream.envelope_recovery_subscribe_failed', {
            message: String(error?.message || error).slice(0, 300),
          });
        }
      }
      if (wantsEnvelope && !envelopeEnabled) {
        appendClientLog('WARN', 'stream.envelope_v2_unavailable', {
          hasEnvelopeBridge,
          hasEnvelopeHandler: typeof handleStreamEnvelope === 'function',
        });
      }
      if (!envelopeEnabled && !hasLegacyBridge) {
        currentEnvelopeMode = 'unavailable';
        streamEnvelopeReceiptTracker?.beginSubscription?.(rendererEpoch, 'legacy');
        appendClientLog('WARN', 'stream.listener_unavailable', {
          wantsEnvelope,
          hasLegacyBridge,
          hasEnvelopeBridge,
        });
        ensureFeaturesListener(lastShellRef);
        return null;
      }
      currentEnvelopeMode = envelopeEnabled ? 'envelope' : 'legacy';
      const subscribe = envelopeEnabled
        ? chatBridge.onStreamEnvelope.bind(chatBridge)
        : chatBridge.onStream.bind(chatBridge);
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('beforeunload', dispose);
        beforeUnloadRegistered = true;
      }
      function createListener(useEnvelopeHandler) {
        return (payload) => streamMailbox.enqueue(payload, async ({ guard, signal, rendererEpoch }) => {
          try {
            const continuation = { continuationGuard: guard, signal, rendererEpoch };
            if (useEnvelopeHandler) {
              return await handleStreamEnvelope(payload, continuation);
            }
            return await handleStreamPayload(payload, continuation);
          } catch (error) {
            appendClientLog('ERROR', 'stream.listener_exception', {
              type: String(payload?.type || payload?.eventKind || ''),
              channel: String(payload?.channel || '').slice(0, 30),
              streamId: String(payload?.streamId || '').slice(0, 30),
              message: String(error?.message || error).slice(0, 300),
            });
            return { buffered: false, terminal: false, handlerError: true };
          }
        });
      }
      try {
        streamUnsubscribe = subscribe(createListener(envelopeEnabled));
        streamEnvelopeReceiptTracker?.beginSubscription?.(rendererEpoch, currentEnvelopeMode);
      } catch (error) {
        appendClientLog('WARN', 'stream.listener_subscribe_failed', {
          mode: envelopeEnabled ? 'envelope' : 'legacy',
          message: String(error?.message || error).slice(0, 300),
        });
        if (envelopeEnabled && hasLegacyBridge) {
          try {
            currentEnvelopeMode = 'legacy';
            streamUnsubscribe = chatBridge.onStream.bind(chatBridge)(createListener(false));
            streamEnvelopeReceiptTracker?.beginSubscription?.(rendererEpoch, 'legacy');
            appendClientLog('INFO', 'stream.envelope_v2_legacy_fallback', {
              reason: 'subscribe_failed',
            });
            ensureFeaturesListener(lastShellRef);
            return streamUnsubscribe;
          } catch (legacyError) {
            appendClientLog('WARN', 'stream.listener_subscribe_failed', {
              mode: 'legacy',
              message: String(legacyError?.message || legacyError).slice(0, 300),
            });
          }
        }
        currentEnvelopeMode = 'unavailable';
        streamUnsubscribe = null;
        streamEnvelopeReceiptTracker?.beginSubscription?.(rendererEpoch, 'legacy');
        removeBeforeUnloadListener();
        ensureFeaturesListener(lastShellRef);
        return null;
      }
      ensureFeaturesListener(lastShellRef);
      return streamUnsubscribe;
    }

    function fallbackToLegacy(reason = 'envelope_fault') {
      if (currentEnvelopeMode === 'legacy') {
        return streamUnsubscribe;
      }
      const chatBridge = lastShellRef?.chat;
      if (typeof chatBridge?.onStream !== 'function') {
        appendClientLog('WARN', 'stream.envelope_v2_legacy_fallback_failed', {
          reason: String(reason || 'envelope_fault').slice(0, 80),
        });
        return null;
      }
      forcedLegacyReason = String(reason || 'envelope_fault').slice(0, 80);
      appendClientLog('WARN', 'stream.envelope_v2_legacy_fallback', {
        reason: forcedLegacyReason,
      });
      return registerStreamHandler(lastShellRef);
    }

    function dispose() {
      // Invalidate in-flight listener continuations before owned maps/queues
      // are cleared; late awaits then observe an aborted renderer epoch.
      streamMailbox.dispose();
      removeBeforeUnloadListener();
      removeFeaturesListener();
      safeUnsubscribeStream('dispose');
      safeUnsubscribeRecovery('dispose');
      currentEnvelopeMode = null;
      lastShellRef = null;
      pendingStreamCommitQueue.dispose();
      runtime?.disposeRenderQueue?.();
      approvalToastSessionIds.clear();
      try {
        reasoningStreamMerger?.clearAll?.();
      } catch (error) {
        appendClientLog('WARN', 'stream.reasoning_merge_dispose_failed', {
          message: String(error?.message || error).slice(0, 300),
        });
      }
      // CTL-014: a stream buffered precisely because its session did not
      // exist yet may never trigger a render, so nothing else clears this
      // map — disposal must reach it directly, and disarm the sweep timer
      // with it (clearBufferedStreamEvents does both).
      try {
        clearBufferedStreamEvents?.();
      } catch (error) {
        appendClientLog('WARN', 'stream.buffered_events_clear_failed', {
          message: String(error?.message || error).slice(0, 300),
        });
      }
    }

    function rehydrateSessionFromPersistedTurnEvents(sessionId) {
      if (!streamRehydrateUtils || typeof streamRehydrateUtils.rehydrateSessionLiveState !== 'function') {
        return null;
      }
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId || !isRowModelEnabled(normalizedSessionId)) {
        return null;
      }
      const turnEventsStore = state.turnEventsBySession;
      if (!(turnEventsStore instanceof Map)) {
        return null;
      }
      const persistedPayload = turnEventsStore.get(normalizedSessionId);
      const persistedEvents = persistedPayload && Array.isArray(persistedPayload.turnEvents)
        ? persistedPayload.turnEvents
        : [];
      if (!persistedEvents.length) {
        return null;
      }
      // Gate the seed to genuinely in-flight turns by forwarding the backend
      // summary's active_turn only when the stored payload carries the key — a
      // settled session (active_turn === null) then skips live seeding, so
      // reopening it never resurrects a phantom "Writing"/"Thinking" deck
      // (session-persistence audit #2). withActiveTurnForwarded is the shared
      // opt-in helper that preserves the key-presence contract. Production always writes
      // the key (setSessionTurnEventState), so production is always gated; payloads
      // constructed without it (e.g. test harnesses) keep legacy replay-all.
      return streamRehydrateUtils.rehydrateSessionLiveState(
        streamRehydrateUtils.withActiveTurnForwarded(
          {
            sessionId: normalizedSessionId,
            turnEvents: persistedEvents,
            liveStateStore: getLiveStateStore(),
            appendClientLog,
            // DC1 flicker cure: row model is already confirmed enabled above, so
            // the opt-in reduces to the global flag. Off by default =>
            // byte-identical reopen seed.
            deterministicRowId: state?.features?.featureFlags?.chat_timeline_deterministic_row_id === true,
          },
          persistedPayload,
        ),
      );
    }

    return {
      registerStreamHandler,
      resyncStreamSubscriptionMode,
      fallbackToLegacy,
      dispose,
      rehydrateSessionFromPersistedTurnEvents,
    };
  }

  return { createStreamHandlerLifecycle };
});
