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

  function resolveTurnTreeProjectorModule() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererTurnTreeProjector) {
      return globalThis.rendererTurnTreeProjector;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-turn-tree-projector'); } catch (_error) { /* browser script mode */ }
    }
    return null;
  }

  function createStreamHandlerLifecycle(options = {}) {
    const {
      state,
      normalizeId,
      appendClientLog,
      handleStreamPayload,
      pendingStreamCommitQueue,
      runtime,
      approvalToastSessionIds,
      reasoningStreamMerger,
      streamRehydrateUtils,
      isRowModelEnabled,
      getLiveStateStore,
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
    let lastShellRef = null;
    let beforeUnloadRegistered = false;

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

    function removeBeforeUnloadListener() {
      if (!beforeUnloadRegistered) {
        return;
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('beforeunload', dispose);
      }
      beforeUnloadRegistered = false;
    }

    function registerStreamHandler(jennyShell) {
      lastShellRef = jennyShell || lastShellRef;
      // A subscription replacement is a renderer-ownership boundary. Abort
      // callbacks already executing under the prior listener before binding
      // the next one so they cannot mutate the new handler generation.
      streamMailbox.beginEpoch();
      safeUnsubscribeStream('resubscribe');
      removeBeforeUnloadListener();
      const chatBridge = lastShellRef?.chat || null;
      if (typeof chatBridge?.onStream !== 'function') {
        appendClientLog('WARN', 'stream.listener_unavailable', {
          hasLegacyBridge: false,
        });
        return null;
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('beforeunload', dispose);
        beforeUnloadRegistered = true;
      }
      const listener = (payload) => streamMailbox.enqueue(payload, async ({ guard, signal, rendererEpoch }) => {
        try { globalThis.rendererHealthPillController?.observeStreamPayload?.(payload); } catch (_error) { /* presentation tap */ }
        try {
          if (state.runtimeSendController?.acceptAdmission?.(payload) === false) return { buffered: false, terminal: false };
          // Desktop notifications see every admitted live payload once (a question request has no terminal).
          try { state.desktopNotificationsController?.onStreamPayload?.(payload); } catch (_error) { /* presentation tap */ }
          return await handleStreamPayload(payload, { continuationGuard: guard, signal, rendererEpoch });
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
      try {
        streamUnsubscribe = chatBridge.onStream.bind(chatBridge)(listener);
      } catch (error) {
        appendClientLog('WARN', 'stream.listener_subscribe_failed', {
          mode: 'legacy',
          message: String(error?.message || error).slice(0, 300),
        });
        streamUnsubscribe = null;
        removeBeforeUnloadListener();
        return null;
      }
      return streamUnsubscribe;
    }

    function dispose() {
      // Invalidate in-flight listener continuations before owned maps/queues
      // are cleared; late awaits then observe an aborted renderer epoch.
      streamMailbox.dispose();
      removeBeforeUnloadListener();
      safeUnsubscribeStream('dispose');
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

    // pendingPayloads are live events the backend still waits on for an
    // in-flight turn (an ask_user question after a renderer reload). They
    // re-enter through normal dispatch once the persisted log is seeded.
    function rehydrateSessionFromPersistedTurnEvents(sessionId, { pendingPayloads = [] } = {}) {
      const payloads = Array.isArray(pendingPayloads) ? pendingPayloads : [];
      const seeded = seedSessionFromPersistedTurnEvents(sessionId, normalizeId(payloads[0]?.turnId));
      for (const payload of payloads) {
        Promise.resolve(handleStreamPayload(payload)).catch((error) => {
          appendClientLog('WARN', 'stream.rehydrate_pending_payload_failed', {
            type: String(payload?.type || '').slice(0, 60),
            streamId: String(payload?.streamId || '').slice(0, 30),
            message: String(error?.message || error).slice(0, 200),
          });
        });
      }
      return seeded;
    }

    // F25 (gate A7): main persists an in-flight turn's events only when it
    // settles, so a reload mid-turn finds that turn's messages on disk but no
    // events for it. Seed it from the events its persisted messages project;
    // otherwise the live turn built from the replayed payloads alone replaces
    // those rows (Thought, tool) until the terminal.
    function withInFlightTurnMessageEvents(sessionId, persistedEvents, turnId) {
      if (!turnId || persistedEvents.some((event) => normalizeId(event?.turn_id || event?.turnId) === turnId)) {
        return persistedEvents;
      }
      const projector = resolveTurnTreeProjectorModule();
      const messages = state.messagesBySession instanceof Map ? state.messagesBySession.get(sessionId) : null;
      if (typeof projector?.projectTurnTree !== 'function' || !Array.isArray(messages) || !messages.length) {
        return persistedEvents;
      }
      let turn;
      try {
        const turns = projector.projectTurnTree({ messages })?.turns;
        turn = (Array.isArray(turns) ? turns : []).find((entry) => normalizeId(entry?.turn_id) === turnId) || null;
      } catch (_error) {
        turn = null;
      }
      const turnEvents = Array.isArray(turn?.events) ? turn.events : [];
      return turnEvents.length ? [...persistedEvents, ...turnEvents] : persistedEvents;
    }

    function seedSessionFromPersistedTurnEvents(sessionId, inFlightTurnId = '') {
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
      const persistedEvents = withInFlightTurnMessageEvents(
        normalizedSessionId,
        persistedPayload && Array.isArray(persistedPayload.turnEvents) ? persistedPayload.turnEvents : [],
        inFlightTurnId
      );
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
            // the reopen seed always stamps deterministic row_ids.
            deterministicRowId: true,
          },
          persistedPayload,
        ),
      );
    }

    return {
      registerStreamHandler,
      dispose,
      rehydrateSessionFromPersistedTurnEvents,
    };
  }

  return { createStreamHandlerLifecycle };
});
