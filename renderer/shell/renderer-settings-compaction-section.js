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

  function describeCompactionResult(result) {
    const status = String(result?.status || '').trim();
    if (status === 'ok') {
      if (result?.compacted === false) {
        return { state: 'success', message: jt('settings.compaction.nothingToCompact', 'Nothing to compact.'), tone: 'default', reason: 'not_needed' };
      }
      if (result?.compacted !== true) {
        return { state: 'error', message: jt('settings.compaction.invalidResult', 'Compaction returned an invalid result.'), tone: 'danger', reason: 'malformed_result' };
      }
      const before = Number.isFinite(Number(result?.tokens_before)) ? Number(result.tokens_before) : null;
      const after = Number.isFinite(Number(result?.tokens_after)) ? Number(result.tokens_after) : null;
      const base = before != null && after != null ? jt('settings.compaction.completedWithTokenCounts', 'Compacted: {before} -> {after} tokens.', { before, after }) : 'Compacted.';
      if (result?.snapshot_persisted === true) {
        return { state: 'success', message: jt('settings.compaction.persisted', '{result} Future turns use the compact context.', { result: base }), tone: 'success', reason: 'persisted' };
      }
      if (result?.snapshot_persisted === false) {
        return { state: 'error', message: jt('settings.compaction.notPersisted', '{result} Could not save it for future turns.', { result: base }), tone: 'warning', reason: 'snapshot_not_persisted' };
      }
      return { state: 'error', message: jt('settings.compaction.persistenceUnknown', '{result} Could not confirm it was saved for future turns.', { result: base }), tone: 'warning', reason: 'snapshot_persistence_unknown' };
    }

    const reason = String(result?.reason || '').trim();
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

    function render() {
      callbacks.renderComposerState?.();
      callbacks.renderComposerStatusNotice?.();
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
      render();
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

      const described = describeCompactionResult(result);
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
      render();
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

  function bindCompactionSection({
    container, state, renderSettings, registerListener, listenerOptions,
    resolveCompactionFieldChangeEvent, showSessionActionError,
  } = {}) {
    if (!container || !state || typeof registerListener !== 'function') return;
    const rerender = typeof renderSettings === 'function' ? renderSettings : function noop() {};
    const resolveField = typeof resolveCompactionFieldChangeEvent === 'function'
      ? resolveCompactionFieldChangeEvent : function fallbackResolve() { return null; };
    const reportError = typeof showSessionActionError === 'function' ? showSessionActionError : function noop() {};
    let disposed = listenerOptions?.signal?.aborted === true;
    listenerOptions?.signal?.addEventListener?.('abort', () => { disposed = true; }, { once: true });
    if (disposed) return;
    let compactionTuningHydrated = false;
    function ensureCompactionTuning() {
      if (compactionTuningHydrated || state.compactionTuning) return;
      compactionTuningHydrated = true;
      const api = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.compaction) || null;
      if (!api || typeof api.getTuning !== 'function') return;
      Promise.resolve().then(() => api.getTuning()).then((tuning) => {
        if (!disposed && tuning && typeof tuning === 'object') {
          state.compactionTuning = tuning;
          rerender();
        }
      }).catch((error) => {
        if (disposed) return;
        state.compactionTuningActivity = {
          pending: false, message: jt('settings.compaction.guidanceUnavailable', 'Summarization guidance is unavailable.'), tone: 'warning',
        };
        rerender();
        reportError(error, jt('settings.compaction.tuningLoadFailed', 'Compaction Tuning Load Failed'));
      });
    }
    ensureCompactionTuning();

    function applyTuningPayload(api, payload) {
      if (state.compactionTuningActivity?.pending === true) {
        return Promise.resolve({ status: 'rejected', reason: 'update_in_progress' });
      }
      state.compactionTuningActivity = {
        pending: true, message: jt('settings.compaction.applyingGuidance', 'Applying summarization guidance…'), tone: 'pending',
      };
      rerender();
      return Promise.resolve().then(() => api.setTuning(payload)).then((result) => {
        if (disposed) return { status: 'rejected', reason: 'disposed' };
        const applied = result?.status === 'applied';
        const tuning = result?.state;
        state.compactionTuningActivity = !applied
          ? { pending: false, message: jt('settings.compaction.guidanceNotAppliedReason', 'Not applied: {reason}.', { reason: String(result?.reason || result?.status || 'invalid response').replaceAll('_', ' ') }), tone: 'warning' }
          : { pending: false, message: jt('settings.compaction.guidanceApplied', 'Summarization guidance applied.'), tone: 'success' };
        state.compactionTuning = tuning || null;
        rerender();
      }).catch((error) => {
        if (disposed) return { status: 'rejected', reason: 'disposed' };
        state.compactionTuningActivity = {
          pending: false, message: jt('settings.compaction.guidanceNotApplied', 'Summarization guidance was not applied.'), tone: 'warning',
        };
        rerender();
        reportError(error, jt('settings.compaction.tuningUpdateFailed', 'Compaction Tuning Update Failed'));
        return { status: 'rejected', reason: 'request_failed' };
      });
    }

    registerListener(container, 'change', (event) => {
      const resolved = resolveField(event);
      if (!resolved || resolved.field !== 'customPrompt') return;
      const api = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.compaction) || null;
      if (!api || typeof api.setTuning !== 'function') return;
      void applyTuningPayload(api, { customPrompt: resolved.value });
    }, listenerOptions);

    registerListener(container, 'click', (event) => {
      const resetTarget = event?.target?.closest?.('[data-action="reset-compaction-prompt"]');
      if (resetTarget) {
        const api = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.compaction) || null;
        if (api && typeof api.setTuning === 'function') void applyTuningPayload(api, { customPrompt: '' });
        return;
      }
    }, listenerOptions);
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
