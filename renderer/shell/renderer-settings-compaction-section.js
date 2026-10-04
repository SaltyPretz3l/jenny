/* Shared session-compaction coordinator and Settings > Context binder. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rendererCompactionCoordinator = api;
  root.rendererSettingsCompactionSection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const MAX_SESSION_ACTIVITIES = 32;

  function getActivityMap(state) {
    if (!(state?.compactionActivities instanceof Map)) state.compactionActivities = new Map();
    return state.compactionActivities;
  }

  function getCompactionActivity(state, sessionId) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId || !(state?.compactionActivities instanceof Map)) return null;
    const activity = state.compactionActivities.get(normalizedSessionId);
    return activity && typeof activity === 'object' ? activity : null;
  }

  // `options.overheadTokens`: the meter's fixed prompt-block estimate (system
  // prompt, overlays, tool schemas). Compaction never shrinks it, so when it
  // outweighs the compacted conversation the message says so (sweep W3-F11).
  function describeCompactionResult(result, options = {}) {
    const status = String(result?.status || '').trim();
    if (status === 'ok') {
      if (result?.compacted === false) {
        if (String(result?.reason || '') === 'single_round') {
          return { state: 'success', message: jt('settings.compaction.singleRound', 'Nothing to compact yet. The latest exchange is always kept in full; earlier ones can be summarized after your next message.'), tone: 'default', reason: 'not_needed' };
        }
        return { state: 'success', message: jt('settings.compaction.nothingToCompact', 'Nothing to compact.'), tone: 'default', reason: 'not_needed' };
      }
      if (result?.compacted !== true) {
        return { state: 'error', message: jt('settings.compaction.invalidResult', 'Compaction returned an invalid result.'), tone: 'danger', reason: 'malformed_result' };
      }
      const before = Number.isFinite(Number(result?.tokens_before)) ? Number(result.tokens_before) : null;
      const after = Number.isFinite(Number(result?.tokens_after)) ? Number(result.tokens_after) : null;
      const overhead = Math.max(Number(options.overheadTokens) || 0, 0);
      const note = overhead > 0 && after != null && overhead > after
        ? ' ' + jt('settings.compaction.promptBlockNote', 'Instructions and tools add about {overhead} tokens that compaction does not shrink.', { overhead })
        : '';
      const sourceOmitted = Number(result?.summary_source_dropped_messages) > 0
        ? ' ' + jt('chat.thinking.summarizerInputOmitted', 'Some older messages were omitted from the summarizer input') + '.'
        : '';
      const base = (before != null && after != null ? jt('settings.compaction.completedWithTokenCounts', 'Compacted: {before} -> {after} tokens.', { before, after }) : 'Compacted.') + note + sourceOmitted;
      if (result?.snapshot_persisted === true) {
        return { state: 'success', message: jt('settings.compaction.persisted', '{result} Future turns use the compact context.', { result: base }), tone: 'success', reason: 'persisted' };
      }
      if (result?.snapshot_persisted === false) {
        return { state: 'error', message: jt('settings.compaction.notPersisted', '{result} Could not save it for future turns.', { result: base }), tone: 'warning', reason: 'snapshot_not_persisted' };
      }
      return { state: 'error', message: jt('settings.compaction.persistenceUnknown', '{result} Could not confirm it was saved for future turns.', { result: base }), tone: 'warning', reason: 'snapshot_persistence_unknown' };
    }

    const reason = String(result?.reason || '').trim();
    // A summary that would not be smaller than the chat it replaces (the
    // sidecar's `no_reduction`, request_dispatch_compact.py) means the chat is
    // already short: nothing to do, not a failure.
    if (reason === 'compaction_failed' && String(result?.detail || '').trim() === 'no_reduction') {
      return { state: 'success', message: jt('settings.compaction.nothingToCompactShort', 'Nothing to compact yet — this chat is already short.'), tone: 'default', reason: 'not_needed' };
    }
    if (reason === 'circuit_breaker_open') {
      const retryAfter = Number(result?.retry_after_seconds);
      return {
        state: 'error',
        message: Number.isFinite(retryAfter) ? jt('settings.compaction.cooldownSeconds', 'Compaction cooling down, retry in {seconds}s.', { seconds: Math.max(0, retryAfter) }) : jt('settings.compaction.cooldownShortly', 'Compaction cooling down, try again shortly.'),
        tone: 'warning', reason,
      };
    }
    const known = {
      no_active_turn: [jt('settings.compaction.noConversation', 'No conversation to compact.'), 'default'],
      session_busy: [jt('settings.compaction.waitForReply', 'Wait for the current reply to finish, then compact.'), 'warning'],
      feature_disabled: [jt('settings.compaction.turnedOff', 'Compaction is turned off for this session.'), 'warning'],
      sidecar_unavailable: [jt('settings.compaction.backendUnavailable', 'Compaction is unavailable right now (backend not ready).'), 'warning'],
      session_offline_lockdown: [jt('settings.compaction.localEngineRequired', 'This session is locked to local engines; switch to a local engine to compact.'), 'warning'],
      model_unavailable: [jt('settings.compaction.chatModelUnavailable', "This chat's model could not be loaded, so nothing was compacted."), 'warning'],
      compaction_failed: [jt('settings.compaction.failed', 'Compaction failed.'), 'danger'],
      request_failed: [jt('settings.compaction.requestFailed', 'Compaction request failed.'), 'danger'],
    };
    if (known[reason]) return { state: 'error', message: known[reason][0], tone: known[reason][1], reason };
    return { state: 'error', message: jt('settings.compaction.unknownFailure', 'Compaction failed for an unknown reason.'), tone: 'danger', reason: reason ? 'unknown_reason' : 'malformed_result' };
  }

  function createCompactionCoordinator(options = {}) {
    const state = options.state || {};
    const getChatApi = typeof options.getChatApi === 'function' ? options.getChatApi : () => null;
    const callbacks = options.callbacks || {};
    const activities = getActivityMap(state);
    let disposed = false;

    // `sessionId`: split view (gate §D) -- the composer of a pane other than
    // pane 0 showing that session renders its progress too.
    function render(sessionId) {
      callbacks.renderComposerState?.();
      callbacks.renderComposerStatusNotice?.();
      if (sessionId) callbacks.renderSessionComposer?.(sessionId);
      callbacks.renderSettings?.();
    }

    function makeRoom(sessionId) {
      if (activities.has(sessionId) || activities.size < MAX_SESSION_ACTIVITIES) return true;
      for (const [candidateId, activity] of activities) {
        if (activity?.pending !== true) {
          activities.delete(candidateId);
          return true;
        }
      }
      return false;
    }

    function setActivity(sessionId, activity) {
      activities.delete(sessionId);
      activities.set(sessionId, Object.freeze({ sessionId, ...activity }));
      render(sessionId);
      return activities.get(sessionId);
    }

    async function invoke(sessionId, invokeOptions = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      const source = String(invokeOptions?.source || 'unknown').trim().slice(0, 24) || 'unknown';
      const log = (level, event, details) => callbacks.appendClientLog?.(level, event, details);
      if (disposed) return { accepted: false, reason: 'disposed' };
      if (!normalizedSessionId) return { accepted: false, reason: 'no_session' };
      if (getCompactionActivity(state, normalizedSessionId)?.pending === true) {
        log('INFO', 'chat.compaction_deduped', { sessionId: normalizedSessionId, source, reason: 'already_pending' });
        return { accepted: false, reason: 'already_pending', activity: getCompactionActivity(state, normalizedSessionId) };
      }
      if (!makeRoom(normalizedSessionId)) {
        log('WARN', 'chat.compaction_refused', { sessionId: normalizedSessionId, source, reason: 'activity_capacity' });
        return { accepted: false, reason: 'activity_capacity' };
      }

      const startedAt = Date.now();
      setActivity(normalizedSessionId, {
        state: 'pending', pending: true, message: jt('settings.compaction.compacting', 'Compacting context…'), tone: 'pending',
        reason: '', source, startedAt, updatedAt: startedAt, scope: 'session.compaction', emphasis: 'subtle',
      });
      log('INFO', 'chat.compaction_started', { sessionId: normalizedSessionId, source });

      let result;
      try {
        const api = getChatApi();
        result = api && typeof api.compactNow === 'function'
          ? await api.compactNow(normalizedSessionId)
          : { status: 'error', reason: 'sidecar_unavailable' };
      } catch (_error) {
        result = { status: 'error', reason: 'request_failed' };
      }
      if (disposed) return { accepted: true, reason: 'disposed' };

      const described = describeCompactionResult(result, { overheadTokens: state.ui?.contextOverheadTokens });
      if (
        described.state === 'success'
        && result?.compacted === true
        && result?.snapshot_persisted === true
        && typeof callbacks.onCompactionPersisted === 'function'
      ) {
        try {
          callbacks.onCompactionPersisted(normalizedSessionId, result);
        } catch (_error) {
          log('WARN', 'chat.compaction_meter_update_failed', {
            sessionId: normalizedSessionId,
            source,
          });
        }
      }
      const settledAt = Date.now();
      const activity = setActivity(normalizedSessionId, {
        ...described, pending: false, source, startedAt, settledAt, updatedAt: settledAt,
        scope: 'session.compaction', emphasis: described.state === 'error' ? 'strong' : 'subtle',
      });
      log(described.state === 'success' ? 'INFO' : 'WARN', 'chat.compaction_settled', {
        sessionId: normalizedSessionId, source, status: described.state, reason: described.reason,
      });
      return { accepted: true, activity };
    }

    function clearSettled(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const activity = getCompactionActivity(state, normalizedSessionId);
      if (!activity || activity.pending === true) return false;
      activities.delete(normalizedSessionId);
      render(normalizedSessionId);
      return true;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      activities.clear();
    }

    return {
      invoke,
      getActivity: (sessionId) => getCompactionActivity(state, sessionId),
      isPending: (sessionId) => getCompactionActivity(state, sessionId)?.pending === true,
      clearSettled,
      dispose,
    };
  }

  function createAppCompactionCoordinator(ctx = {}) {
    return createCompactionCoordinator({
      state: ctx.state,
      getChatApi: () => ctx.window?.jennyShell?.chat,
      callbacks: {
        renderComposerState: (...args) => ctx.renderComposerState?.(...args),
        renderComposerStatusNotice: (...args) => ctx.renderComposerStatusNotice?.(...args),
        renderSessionComposer: (sessionId) => ctx.window?.rendererAppPaneComposition?.getPaneComposition?.()?.renderSessionPane?.(sessionId, 'composer'),
        renderSettings: (...args) => ctx.renderSettings?.(...args),
        appendClientLog: (...args) => ctx.appendClientLog?.(...args),
        onCompactionPersisted: (sessionId, result) => {
          const usageModule = ctx.window?.rendererContextUsageUtils;
          usageModule?.updateCompactionUsage?.(sessionId, result, {
            contextLimit: Number(ctx.state?.status?.effective_context_length || 0) || 0,
            model: String(
              ctx.state?.runtimeDraft?.preferredModel
              || ctx.state?.status?.model
              || ''
            ).trim(),
          });
          Promise.resolve(ctx.refreshSessionSummaries?.()).catch(() => {
            ctx.appendClientLog?.('WARN', 'chat.compaction_summary_refresh_failed', {
              sessionId,
            });
          });
        },
      },
    });
  }

  const PROMPT_ADAPTER_ID = 'compactionTuning';
  function fieldModules() {
    const load = (name, file) => globalThis[name] || (typeof require === 'function' ? require(file) : null);
    return {
      binding: load('rendererSettingsFieldBinding', './renderer-settings-field-binding.js'),
      descriptors: load('rendererSettingsFieldDescriptors', './renderer-settings-field-descriptors.js'),
    };
  }
  function compactionApi() { return (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.compaction) || null; }

  /* Adapter for the shared coordinator (renderer-settings-field-binding.js):
   * the guidance is saved by the compaction tuning transaction and adopted only
   * when it answers `applied` with the same text. Its echoed state replaces
   * state.compactionTuning on both outcomes, as the service's current truth:
   * a refused save the service could not roll back still holds the new text. */
  function createCompactionPromptAdapter(live) {
    let echoed = null;
    return {
      id: PROMPT_ADAPTER_ID,
      mode: 'patch',
      optimistic: false,
      read: () => ({ customPrompt: String(live.state.compactionTuning?.customPrompt || '') }),
      // Trimmed like the service stores it, so the echo can match what was sent.
      normalize: (source) => ({ customPrompt: String(source?.customPrompt || '').trim() }),
      write: (patch) => {
        const api = compactionApi();
        if (typeof api?.setTuning !== 'function') throw new Error(jt('settings.compaction.guidanceUnavailable', 'Summarization guidance is unavailable.'));
        return Promise.resolve(api.setTuning({ customPrompt: patch.customPrompt })).then((result) => result || {});
      },
      ack: (result, patch) => {
        echoed = result.state && typeof result.state === 'object' ? result.state : null;
        if (result.status !== 'applied') {
          throw new Error(jt('settings.compaction.guidanceNotAppliedReason', 'Not applied: {reason}.', { reason: String(result.reason || result.status || 'invalid response').replaceAll('_', ' ') }));
        }
        if (typeof echoed?.customPrompt !== 'string' || echoed.customPrompt !== patch.customPrompt) {
          throw new Error(jt('settings.compaction.guidanceNotApplied', 'Summarization guidance was not applied.'));
        }
        return { customPrompt: patch.customPrompt };
      },
      apply: (next) => {
        if (live.disposed) return;
        const owner = echoed;
        echoed = null;
        const customPrompt = typeof owner?.customPrompt === 'string' ? owner.customPrompt : next.customPrompt;
        live.state.compactionTuning = { ...(owner || live.state.compactionTuning || {}), customPrompt };
        live.rerender();
      },
    };
  }

  function bindCompactionSection({
    container, state, renderSettings, registerListener, listenerOptions,
    showSessionActionError,
  } = {}) {
    if (!container || !state || typeof registerListener !== 'function') return;
    const { binding, descriptors } = fieldModules();
    const descriptor = descriptors?.getSettingDescriptor?.('compactionPromptField');
    if (typeof binding?.bindSettingFields !== 'function' || !descriptor) return;
    const rerender = typeof renderSettings === 'function' ? renderSettings : function noop() {};
    const reportError = typeof showSessionActionError === 'function' ? showSessionActionError : function noop() {};
    // One coordinator per app state across bind generations; the adapter reaches
    // the current binding through `live` (see the binding module).
    const shared = binding.sharedRegistryFor(state, PROMPT_ADAPTER_ID);
    const live = shared.live;
    Object.assign(live, { state, rerender, disposed: listenerOptions?.signal?.aborted === true });
    listenerOptions?.signal?.addEventListener?.('abort', () => { live.disposed = true; }, { once: true });
    if (live.disposed) return;
    const setActivity = (message, tone) => {
      if (live.disposed) return;
      state.compactionTuningActivity = { pending: false, message, tone };
      rerender();
    };
    if (!state.compactionTuning && typeof compactionApi()?.getTuning === 'function') {
      Promise.resolve().then(() => compactionApi().getTuning()).then((tuning) => {
        if (!live.disposed && tuning && typeof tuning === 'object') {
          state.compactionTuning = tuning;
          rerender();
        }
      }).catch((error) => {
        if (live.disposed) return;
        setActivity(jt('settings.compaction.guidanceUnavailable', 'Summarization guidance is unavailable.'), 'warning');
        reportError(error, jt('settings.compaction.tuningLoadFailed', 'Compaction Tuning Load Failed'));
      });
    }
    if (!shared.registry.has(PROMPT_ADAPTER_ID)) shared.registry.register(createCompactionPromptAdapter(live));
    binding.bindSettingFields({
      container,
      descriptors: [descriptor],
      registry: shared.registry,
      registerListener,
      listenerOptions,
      onApplied: () => setActivity(jt('settings.compaction.guidanceApplied', 'Summarization guidance applied.'), 'success'),
      // The row shows the reason; the note keeps it across the next repaint.
      onError: (_descriptor, error) => setActivity(error?.message || jt('settings.compaction.guidanceNotApplied', 'Summarization guidance was not applied.'), 'warning'),
    });
  }

  return {
    MAX_SESSION_ACTIVITIES,
    bindCompactionSection,
    createAppCompactionCoordinator,
    createCompactionCoordinator,
    describeCompactionResult,
    getCompactionActivity,
  };
});
