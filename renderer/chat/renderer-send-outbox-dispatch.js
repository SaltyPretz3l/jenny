/* renderer/chat/renderer-send-outbox-dispatch.js -- FIFO drain transition owner and the live-turn steering controller (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendOutboxDispatch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // A failed dispatch blocks the queue only while its auto-retries last; then it is parked and skipped.
  const MAX_QUEUED_SEND_AUTO_RETRIES = 3;
  const QUEUED_SEND_AUTO_RETRY_BASE_DELAY_MS = 2000;

  // Mirrors the composer chrome (renderer-render-pipeline-chrome.js).
  const BACKEND_USABLE_PHASES = ['ready', 'model_unavailable'];
  const BACKEND_STARTING_PHASES = ['sidecar_spawned', 'model_acquiring', 'model_loading', 'starting', 'retrying'];

  function phaseOf(value) {
    return String(value?.phase || '').trim();
  }

  // Row 62: a Send while the engine starts waits here and drains on a usable backend; one queue per pane.
  function createBackendStartQueue({ state, shell, isDisposed = () => false, getDispatch, setTimeoutImpl = setTimeout }) {
    const parkedSessionIds = new Set();
    const isBackendUsable = () => BACKEND_USABLE_PHASES.includes(phaseOf(state.backend));
    const isBackendStarting = () => BACKEND_STARTING_PHASES.includes(phaseOf(state.backend));

    function drain() {
      if (isDisposed() || !isBackendUsable()) return;
      const dispatch = getDispatch();
      for (const sessionId of [...parkedSessionIds]) {
        parkedSessionIds.delete(sessionId);
        Promise.resolve(dispatch(sessionId)).catch(() => {
          /* dispatch failures are recorded on the entry itself */
        });
      }
    }

    const unsubscribe = shell?.backend?.onStatus?.((payload) => {
      if (!parkedSessionIds.size || !BACKEND_USABLE_PHASES.includes(phaseOf(payload))) return;
      // The shell's own status listener stores the phase first; drain after it.
      setTimeoutImpl(drain, 0);
    });

    return {
      isBackendUsable,
      isBackendStarting,
      // True when this Send waits for the engine (edits, answers and replays never do).
      claim(sessionId, excluded) {
        const normalized = String(sessionId || '').trim();
        if (!normalized || excluded || isBackendUsable() || !isBackendStarting()) return false;
        parkedSessionIds.add(normalized);
        return true;
      },
      dispose() {
        if (typeof unsubscribe === 'function') unsubscribe();
        parkedSessionIds.clear();
      },
    };
  }

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
      isBackendStarting = () => false,
      setTimeoutImpl = setTimeout,
      clearTimeoutImpl = clearTimeout,
      maxAutoRetries = MAX_QUEUED_SEND_AUTO_RETRIES,
      autoRetryBaseDelayMs = QUEUED_SEND_AUTO_RETRY_BASE_DELAY_MS,
    } = deps;
    const autoRetryTimers = new Map();
    const pendingDispatches = new Map();
    const continuationOptionsBySession = new Map();
    const getDispatchableQueuedSend = typeof sendOutbox.firstDispatchable === 'function'
      ? (sessionId) => sendOutbox.firstDispatchable(sessionId)
      : getQueuedSend;
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
        const head = getDispatchableQueuedSend(sessionId);
        // Only retry the same still-failed head; anything else (removed,
        // edited, manually retried, replaced) owns its own transitions.
        if (!head || head.id !== failedEntryId || head.status !== 'failed') return;
        dispatchQueuedSendForSession(sessionId, options).catch(() => {
          /* dispatch failures are recorded on the entry itself */
        });
      }, delayMs));
    }

    async function runQueuedSendDispatch(normalizedSessionId, options) {
      let queuedSend = getDispatchableQueuedSend(normalizedSessionId);
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
      // Row 180: an offered item goes out as the next turn once the chat is idle.
      if (queuedSend.status === 'offered') {
        if (isSessionBusy(normalizedSessionId)) return null;
        queuedSend = sendOutbox.replace(queuedSend, { status: 'ready', steerReason: null });
        if (!queuedSend) return null;
      }
      if (!['ready', 'waiting_for_turn'].includes(queuedSend.status)) return null;
      // The engine is still starting: the entry waits (no failure, no
      // auto-retry) and the send controller drains it on the ready transition.
      if (isBackendStarting()) {
        sendOutbox.replace(queuedSend, { status: 'waiting_for_turn' });
        return null;
      }
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
      dispatchOptions.imageEditSnapshot = queuedMeta?.imageEditSnapshot || null;
      dispatchOptions.promptBlock = queuedMeta?.promptBlock || null;
      dispatchOptions.skillInvocation = queuedMeta?.skillInvocation && typeof queuedMeta.skillInvocation === 'object'
        ? queuedMeta.skillInvocation : null;
      dispatchOptions.imagePromptPin = queuedMeta?.imagePromptPin && typeof queuedMeta.imagePromptPin === 'object'
        ? queuedMeta.imagePromptPin : null;
      dispatchOptions.boardId = typeof queuedMeta?.boardId === 'string' ? queuedMeta.boardId : null; // row 150: the stamp it was typed with
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
          const parkedEntry = sendOutbox.replace(failedEntry, { status: 'needs_review' });
          if (parkedEntry) {
            appendClientLog('WARN', 'send.outbox_auto_retry_exhausted', {
              sessionId: normalizedSessionId.slice(0, 30),
              attempts: attempt,
              reason: 'auto_retry_exhausted',
            });
            continuationOptionsBySession.set(normalizedSessionId, options);
          }
        }
      }
      renderComposerState();
      renderSessions();
      return dispatchResult;
    }

    // Stop intent: a Stop hands the queued entry back to the composer. The terminal can beat the cancel IPC
    // here, so the stop path parks a hold the next drain consumes (null = "restore").
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
        const continuationOptions = continuationOptionsBySession.get(normalizedSessionId);
        if (!disposed && continuationOptions) {
          continuationOptionsBySession.delete(normalizedSessionId);
          dispatchQueuedSendForSession(normalizedSessionId, continuationOptions).catch(() => {
            /* dispatch failures are recorded on the entry itself */
          });
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
      continuationOptionsBySession.clear();
    }

    dispatchQueuedSendForSession.cancelAutoRetry = cancelAutoRetry;
    dispatchQueuedSendForSession.holdNextDispatch = holdNextDispatch;
    dispatchQueuedSendForSession.releaseHold = releaseHold;
    dispatchQueuedSendForSession.dispose = dispose;

    return dispatchQueuedSendForSession;
  }

  // ---- Row 180 agent steering (no new script tag).
  const TAKEN_ROW_MS = 4000;
  const OFFERABLE = ['ready', 'waiting_for_turn'];
  const SETTLED_AHEAD = ['offered', 'taken'];

  const same = (left, right) => String(left == null ? '' : left) === String(right == null ? '' : right);

  // Pure: live turn, nothing that needs a new turn, every item ahead offered or taken.
  function evaluateSteerEligibility({ item, queue, busy, liveRuntimePreferences } = {}) {
    if (!busy) return { eligible: false, reason: 'not_busy' };
    const meta = item && item.meta && typeof item.meta === 'object' ? item.meta : {};
    if (meta.skillInvocation) return { eligible: false, reason: 'slash_command' };
    if (meta.imageEditSnapshot || meta.promptBlock || meta.imagePromptPin || meta.boardId) {
      return { eligible: false, reason: 'needs_new_turn' };
    }
    if (Array.isArray(meta.mentionContentsSnapshot) && meta.mentionContentsSnapshot.length) {
      return { eligible: false, reason: 'mentions' };
    }
    const live = liveRuntimePreferences && typeof liveRuntimePreferences === 'object' ? liveRuntimePreferences : null;
    if (!live) return { eligible: false, reason: 'turn_unknown' };
    const wanted = item && item.runtimePreferences && typeof item.runtimePreferences === 'object' ? item.runtimePreferences : {};
    if (!same(wanted.preferredModel, live.preferredModel) || !same(wanted.reasoningEffort, live.reasoningEffort)) {
      return { eligible: false, reason: 'model_change' };
    }
    if (!same(wanted.runMode, live.runMode) || Boolean(wanted.planMode) !== Boolean(live.planMode)) {
      return { eligible: false, reason: 'mode_change' };
    }
    const list = Array.isArray(queue) ? queue : [];
    const index = list.findIndex((entry) => entry && item && entry.id === item.id);
    const ahead = index === -1 ? [] : list.slice(0, index);
    if (ahead.some((entry) => !SETTLED_AHEAD.includes(entry && entry.status))) {
      return { eligible: false, reason: 'behind_waiting_item' };
    }
    return { eligible: true };
  }

  function createSteerController(deps = {}) {
    const {
      state,
      sendOutbox,
      getBridge = () => null,
      isSessionBusy = () => false,
      getStreamId = () => '',
      dispatchQueuedSend = () => Promise.resolve(null),
      onChange = () => {},
      appendClientLog = () => {},
      setTimeoutImpl = setTimeout,
      clearTimeoutImpl = clearTimeout,
    } = deps;
    if (!(state.liveTurnRuntimePreferencesBySession instanceof Map)) state.liveTurnRuntimePreferencesBySession = new Map();
    const inflightBySession = new Map();
    // session -> stream main refused (unsupported/disabled).
    const refusedStreamBySession = new Map();
    const withdrawing = new Set();
    const takenTimers = new Map();
    let disposed = false;

    const norm = (value) => String(value || '').trim();
    const find = (sessionId, itemId) => sendOutbox.list(sessionId).find((entry) => entry.id === itemId) || null;
    const notify = () => { try { onChange(); } catch (_error) { /* a redraw never breaks steering */ } };

    function noteTurnStart(sessionId, runtimePreferences) {
      const id = norm(sessionId);
      if (!id) return;
      state.liveTurnRuntimePreferencesBySession.set(id, runtimePreferences && typeof runtimePreferences === 'object'
        ? JSON.parse(JSON.stringify(runtimePreferences)) : null);
    }

    function setReason(sessionId, itemId, reason) {
      const current = find(sessionId, itemId);
      if (!current || (current.steerReason || null) === (reason || null)) return current;
      return sendOutbox.replace(current, { steerReason: reason || null }) || current;
    }

    function backToQueue(sessionId, itemId, streamId, { blocked }) {
      const current = find(sessionId, itemId);
      if (!current || !['offered', 'taken'].includes(current.status)) return null;
      return sendOutbox.replace(current, {
        status: isSessionBusy(sessionId) ? 'waiting_for_turn' : 'ready',
        steerReason: null,
        ...(blocked ? { steerBlockedStreamId: norm(streamId) } : {}),
      });
    }

    async function sendOffer(sessionId, item, streamId) {
      const bridge = getBridge();
      const offered = sendOutbox.replace(item, { status: 'offered', steerReason: null });
      if (!offered) return;
      inflightBySession.set(sessionId, offered.id);
      notify();
      let result;
      try {
        result = await bridge.offerSteer({
          sessionId, itemId: offered.id, prompt: offered.prompt, attachments: offered.attachments || [],
        });
      } catch (_error) {
        result = { ok: false, reason: 'error' };
      }
      if (inflightBySession.get(sessionId) === offered.id) inflightBySession.delete(sessionId);
      if (disposed) return;
      const current = find(sessionId, offered.id);
      if (!current || current.status !== 'offered') { // taken/removed meanwhile: judge the next item here
        await maybeOffer(sessionId);
        return;
      }
      if (result && result.ok === true) {
        notify();
        await maybeOffer(sessionId);
        return;
      }
      backToQueue(sessionId, offered.id, streamId, { blocked: true });
      if (['unsupported', 'disabled'].includes(result && result.reason)) refusedStreamBySession.set(sessionId, streamId);
      appendClientLog('INFO', 'send.steer_offer_refused', {
        sessionId: sessionId.slice(0, 30), reason: norm(result && result.reason).slice(0, 40),
      });
      notify();
      await maybeOffer(sessionId); // the items behind it now say why they wait
    }

    // Offer the first eligible item, in order; refresh waiting reasons.
    async function maybeOffer(sessionId) {
      const id = norm(sessionId);
      if (disposed || !id) return;
      const bridge = getBridge();
      if (!bridge || typeof bridge.offerSteer !== 'function') return; // nothing to offer to: exactly as before
      const streamId = norm(getStreamId(id));
      const busy = Boolean(streamId) && isSessionBusy(id) === true;
      if (!busy) {
        state.liveTurnRuntimePreferencesBySession.delete(id);
        return void sendOutbox.releaseHeld?.(id);
      }
      if (inflightBySession.has(id) || refusedStreamBySession.get(id) === streamId) return;
      const live = state.liveTurnRuntimePreferencesBySession.get(id) || null;
      let changed = false;
      let offerNext = null;
      const total = sendOutbox.list(id).length;
      for (let index = 0; index < total; index += 1) {
        const queue = sendOutbox.list(id);
        const item = queue[index];
        if (!item) break;
        if (SETTLED_AHEAD.includes(item.status)) continue;
        if (!OFFERABLE.includes(item.status)) continue; // capturing, failed, needs review: blocks those behind it
        const verdict = evaluateSteerEligibility({ item, queue, busy, liveRuntimePreferences: live });
        const blocked = item.steerBlockedStreamId && item.steerBlockedStreamId === streamId;
        if (verdict.eligible && !blocked) {
          offerNext = item; // the rest are judged once this offer is answered
          break;
        }
        const reason = verdict.eligible ? null : verdict.reason; // an eligible but refused item shows no line
        const before = item.steerReason || null;
        setReason(id, item.id, reason);
        if (before !== (reason || null)) changed = true;
      }
      if (changed) notify();
      if (offerNext) await sendOffer(id, offerNext, streamId);
    }

    function clearTakenTimer(itemId) {
      const timer = takenTimers.get(itemId);
      if (timer === undefined) return;
      clearTimeoutImpl(timer);
      takenTimers.delete(itemId);
    }

    // The live turn read it: its attachments belong to the persisted row.
    function removeConsumed(sessionId, itemId) {
      clearTakenTimer(itemId);
      const current = find(sessionId, itemId);
      if (!current) return false;
      const sent = sendOutbox.replace(current, {
        status: 'sent', attachmentOwner: current.attachments && current.attachments.length ? 'send_receipt' : 'none',
      });
      return sent ? sendOutbox.remove(sent) : false;
    }

    async function withdraw(item) {
      const sessionId = norm(item && item.sessionId);
      const itemId = norm(item && item.id);
      const current = sessionId && itemId ? find(sessionId, itemId) : null;
      const bridge = getBridge();
      if (!current || current.status !== 'offered' || withdrawing.has(itemId)
        || !bridge || typeof bridge.withdrawSteer !== 'function') return false;
      withdrawing.add(itemId);
      let result;
      try {
        result = await bridge.withdrawSteer({ sessionId, itemId });
      } catch (_error) {
        withdrawing.delete(itemId);
        return false;
      }
      withdrawing.delete(itemId);
      const latest = find(sessionId, itemId);
      if (!latest || disposed) return false; // the user_steer payload won the race and removed the row
      if (result && result.ok === true) {
        (sendOutbox.removeHolding || sendOutbox.remove)(latest);
        notify();
        await maybeOffer(sessionId);
        return true;
      }
      if (result && result.reason === 'consumed') {
        const taken = sendOutbox.replace(latest, {
          status: 'taken', steerReason: null,
          attachmentOwner: latest.attachments && latest.attachments.length ? 'send_receipt' : 'none',
        });
        if (taken) {
          takenTimers.set(itemId, setTimeoutImpl(() => {
            takenTimers.delete(itemId);
            if (!disposed && removeConsumed(sessionId, itemId)) notify();
          }, TAKEN_ROW_MS));
        }
        notify();
        return false;
      }
      backToQueue(sessionId, itemId, getStreamId(sessionId), { blocked: true }); // unknown: treat as released
      notify();
      return false;
    }

    // Offered items go back to ready (a failure terminal sends no release).
    function handleTerminal(payload) {
      const sessionId = norm(payload && payload.sessionId);
      if (!sessionId) return 0;
      inflightBySession.delete(sessionId);
      // A turn started elsewhere records no preferences: its items wait.
      state.liveTurnRuntimePreferencesBySession.delete(sessionId);
      sendOutbox.releaseHeld?.(sessionId); // withdrawn items' files: the turn is over and did not take them
      let released = 0;
      for (const entry of sendOutbox.list(sessionId)) {
        if (entry.status !== 'offered') continue;
        const current = find(sessionId, entry.id);
        if (current && sendOutbox.replace(current, {
          status: 'ready', steerReason: null, steerBlockedStreamId: norm(payload.streamId),
        })) released += 1;
      }
      if (released) notify();
      return released;
    }

    function handleUserSteer(payload) {
      const message = payload && payload.message;
      const itemId = norm(message && message.outbox_item_id);
      const sessionId = norm(payload && payload.sessionId);
      if (!itemId || !sessionId) return false;
      sendOutbox.claimHeld?.(sessionId, itemId); // withdrawn but taken anyway: the row owns its files now
      const removed = removeConsumed(sessionId, itemId);
      if (removed) notify();
      return removed;
    }

    function handleReleased(payload) {
      const sessionId = norm(payload && payload.sessionId);
      const ids = Array.isArray(payload && payload.itemIds) ? payload.itemIds : [];
      if (!sessionId || !ids.length) return false;
      let released = 0;
      for (const rawId of ids) {
        const itemId = norm(rawId);
        clearTakenTimer(itemId);
        if (backToQueue(sessionId, itemId, payload.streamId, { blocked: true })) released += 1;
      }
      if (!released) return false;
      notify();
      if (!isSessionBusy(sessionId)) {
        Promise.resolve(dispatchQueuedSend(sessionId)).catch(() => { /* recorded on the entry itself */ });
      }
      return true;
    }

    const unsubscribe = typeof sendOutbox.onRemove === 'function'
      ? sendOutbox.onRemove((sessionId) => {
        // A head-of-queue change (a cancel, a withdraw) may free the item behind it.
        Promise.resolve().then(() => maybeOffer(sessionId)).catch(() => {});
      })
      : () => {};

    function dispose() {
      disposed = true;
      unsubscribe();
      for (const timer of takenTimers.values()) clearTimeoutImpl(timer);
      takenTimers.clear();
    }

    // Row 180: should a Send behind the live turn take the outbox (the durable queue is never offered)?
    function canOffer(sessionId) {
      const id = norm(sessionId);
      const bridge = getBridge();
      const streamId = norm(id && getStreamId(id));
      return Boolean(!disposed && streamId && bridge && typeof bridge.offerSteer === 'function'
        && state.features?.featureFlags?.mid_turn_steer !== false && refusedStreamBySession.get(id) !== streamId);
    }

    return { noteTurnStart, maybeOffer, canOffer, withdraw, handleUserSteer, handleReleased, handleTerminal, dispose };
  }

  return {
    BACKEND_USABLE_PHASES, BACKEND_STARTING_PHASES, createBackendStartQueue, createQueuedSendDispatcher,
    TAKEN_ROW_MS, evaluateSteerEligibility, createSteerController,
  };
});
