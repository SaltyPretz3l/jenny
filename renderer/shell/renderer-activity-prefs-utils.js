/* renderer/shell/renderer-activity-prefs-utils.js — Activity + runtime-preference helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererActivityPrefsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function createActivityPrefsController(deps) {
    const { state } = deps;
    const { ACTIVITY_SCOPE } = deps.constants;
    const { composerStatusNotice } = deps.dom;
    const {
      getCurrentRuntimePreferences,
      getActiveSession,
      patchSessionSummary,
      syncRuntimeDraftFromActiveSession,
      beginActivity,
      resolveActivity,
      failActivity,
      getActivitySnapshot,
      getMostRecentActivity,
      applyActivityAttributes,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      renderComposerState,
      renderSettings,
      renderPersonalityEditor,
      syncBackendNotice,
      renderSessions,
      setSessionPreferences,
    } = deps.callbacks;

    // Persist through the injected session-preferences boundary instead of
    // reaching for window.jennyShell.sessions directly, so the persist path is
    // exercisable under jsdom. Fail closed: a missing wiring throws (mirroring
    // the previous direct-global TypeError) so runRuntimePreferenceActivity
    // rolls back the optimistic UI rather than masking a dropped write.
    const persistSessionPreferences = typeof setSessionPreferences === 'function'
      ? setSessionPreferences
      : () => { throw new Error('activity-prefs: setSessionPreferences callback not wired'); };
    let nextPreferenceReceiptSequence = 0;
    const latestPreferenceReceiptBySession = new Map();
    const latestPreferenceReceiptByScope = new Map();

    const COMPOSER_NOTICE_ACTIVITY_SCOPES = [
      ACTIVITY_SCOPE.composerRunMode,
    ];

    function getStatusRowRenderer() {
      return globalThis.inventory && typeof globalThis.inventory.statusRow === 'function'
        ? globalThis.inventory.statusRow
        : null;
    }

    function resolveActivityTone(snapshot) {
      if (!snapshot || !snapshot.state) {
        return 'default';
      }
      if (snapshot.state === 'pending') {
        return 'pending';
      }
      if (snapshot.state === 'success') {
        return 'success';
      }
      if (snapshot.state === 'error') {
        return 'danger';
      }
      return 'default';
    }

    function resolveActivityBadge(snapshot) {
      if (!snapshot || !snapshot.state) {
        return '';
      }
      if (snapshot.state === 'pending') {
        return 'Saving';
      }
      if (snapshot.state === 'success') {
        return 'Saved';
      }
      if (snapshot.state === 'error') {
        return 'Error';
      }
      return '';
    }

    function getActivityOwner(scope) {
      const resolvedScope = String(scope || '').trim();
      return resolvedScope ? `activity:${resolvedScope}` : '';
    }

    function getRuntimePreferenceSnapshot() {
      const current = getCurrentRuntimePreferences();
      return {
        preferredModel: current.preferredModel,
        reasoningEffort: current.reasoningEffort,
        runMode: current.runMode,
        planMode: current.planMode,
        contextPreferences: current.contextPreferences,
      };
    }

    function normalizeSessionId(value) {
      return String(value || '').trim();
    }

    function mergeRuntimePreferences(current, patch) {
      const source = current && typeof current === 'object' ? current : {};
      const nextPatch = patch && typeof patch === 'object' ? patch : {};
      return {
        ...source,
        ...nextPatch,
        contextPreferences: {
          ...(source.contextPreferences || {}),
          ...(nextPatch.contextPreferences || {}),
        },
      };
    }

    function toPersistedPreferences(preferences) {
      const persisted = {
        preferred_model: preferences.preferredModel,
        reasoning_effort: preferences.reasoningEffort,
        plan_mode: preferences.planMode,
        context_preferences: {
          history_scope: preferences.contextPreferences.historyScope,
          include_personality: preferences.contextPreferences.includePersonality,
          include_memory: preferences.contextPreferences.includeMemory,
        },
      };
      if (typeof preferences.runMode === 'string' && preferences.runMode.trim()) {
        persisted.run_mode = preferences.runMode;
      }
      return persisted;
    }

    function applyRuntimePreferenceSnapshot(sessionId, snapshot) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) {
        state.runtimeDraft = {
          ...snapshot,
        };
      } else {
        patchSessionSummary(normalizedSessionId, toPersistedPreferences(snapshot));
        if (normalizeSessionId(getActiveSession()?.id) === normalizedSessionId) {
          syncRuntimeDraftFromActiveSession();
        }
      }
    }

    function restoreRuntimePreferenceSnapshot(snapshot, sessionId) {
      applyRuntimePreferenceSnapshot(sessionId || getActiveSession()?.id, snapshot);
    }

    function beginPreferenceReceipt(patch, scopes) {
      const sessionId = normalizeSessionId(getActiveSession()?.id);
      const id = `preference_receipt_${Date.now().toString(36)}_${(++nextPreferenceReceiptSequence).toString(36)}`;
      const previousPreferences = mergeRuntimePreferences(getCurrentRuntimePreferences(), {});
      const receipt = Object.freeze({
        id,
        sessionId,
        previousPreferences: Object.freeze(previousPreferences),
        nextPreferences: Object.freeze(mergeRuntimePreferences(previousPreferences, patch)),
      });
      latestPreferenceReceiptBySession.set(sessionId || '__draft__', id);
      for (const scope of scopes) latestPreferenceReceiptByScope.set(scope, id);
      applyRuntimePreferenceSnapshot(sessionId, receipt.nextPreferences);
      renderComposerState();
      if (state.ui.activeView === 'settings') renderSettings();
      return receipt;
    }

    function isLatestPreferenceReceipt(receipt) {
      return Boolean(receipt && latestPreferenceReceiptBySession.get(receipt.sessionId || '__draft__') === receipt.id);
    }

    function finishPreferenceReceipt(receipt) {
      if (isLatestPreferenceReceipt(receipt)) latestPreferenceReceiptBySession.delete(receipt.sessionId || '__draft__');
    }

    function settleOwnedScopes(scopes, receipt, settle) {
      for (const scope of scopes) {
        if (latestPreferenceReceiptByScope.get(scope) !== receipt.id) continue;
        latestPreferenceReceiptByScope.delete(scope);
        settle(scope);
      }
    }

    function renderComposerStatusNoticeView() {
      if (!composerStatusNotice) {
        return;
      }
      const owner = String(state.ui.composerStatusNoticeOwner || '').trim();
      const scope = owner.startsWith('activity:') ? owner.slice('activity:'.length) : '';
      const compactionActivity = globalThis.rendererCompactionCoordinator?.getCompactionActivity?.(state, state.currentSessionId) || null;
      const snapshot = compactionActivity || (scope ? getActivitySnapshot(scope) : null);
      const message = String(compactionActivity?.message || state.ui.composerStatusNotice || '').trim();
      composerStatusNotice.classList.toggle('hidden', !message);
      if (!message) {
        composerStatusNotice.innerHTML = '';
      } else {
        const statusRow = getStatusRowRenderer();
        const fromActivity = Boolean(snapshot);
        const tone = compactionActivity
          ? String(compactionActivity.tone || 'default')
          : fromActivity ? resolveActivityTone(snapshot)
          : String(state.ui.composerStatusNoticeTone || 'default');
        const badgeText = compactionActivity
          ? (compactionActivity.pending ? 'Compacting' : 'Context')
          : fromActivity ? resolveActivityBadge(snapshot)
          : String(state.ui.composerStatusNoticeBadgeText || '');
        const spinner = fromActivity
          ? snapshot?.state === 'pending'
          : state.ui.composerStatusNoticeSpinner === true;
        composerStatusNotice.innerHTML = statusRow
          ? statusRow({
            tone,
            label: compactionActivity ? 'Context' : (fromActivity ? 'Composer' : ''),
            message,
            badgeText,
            spinner,
            compact: true,
          })
          : message;
        const row = composerStatusNotice.querySelector('.inv-status-row');
        if (row) {
          applyActivityAttributes(row, snapshot, { setAriaBusy: true });
        }
      }
      applyActivityAttributes(
        composerStatusNotice,
        (compactionActivity || owner.startsWith('activity:')) ? snapshot : null,
        { setAriaBusy: true }
      );
    }

    function syncComposerActivityNotice() {
      const winning = getMostRecentActivity(COMPOSER_NOTICE_ACTIVITY_SCOPES);
      const owner = winning ? getActivityOwner(winning.scope) : '';
      if (!winning || !String(winning.message || '').trim()) {
        if (String(state.ui.composerStatusNoticeOwner || '').startsWith('activity:')) {
          clearComposerStatusNotice({ owner: String(state.ui.composerStatusNoticeOwner || '') });
        }
        renderComposerStatusNoticeView();
        return;
      }
      setComposerStatusNotice(winning.message, {
        owner,
        at: winning.startedAt,
      });
      renderComposerStatusNoticeView();
    }

    function handleActivityChange(scope) {
      if (!scope) {
        return;
      }
      if (scope.startsWith('composer.')) {
        syncComposerActivityNotice();
        renderComposerState();
        if (
          scope === ACTIVITY_SCOPE.composerPreferredModel ||
          scope === ACTIVITY_SCOPE.composerReasoningEffort
        ) {
          renderSettings();
        }
        return;
      }
      if (scope.startsWith('settings.')) {
        renderSettings();
        return;
      }
      if (scope.startsWith('personality.')) {
        renderPersonalityEditor();
        return;
      }
      if (scope.startsWith('backend.')) {
        syncBackendNotice();
      }
    }

    async function runRuntimePreferenceActivity({ patch, scopes, previousValue, failureMessage, successMessage }) {
      const scopeList = Array.isArray(scopes) ? scopes.filter(Boolean) : [];
      const receipt = beginPreferenceReceipt(patch, scopeList);
      scopeList.forEach((scope) => beginActivity(scope, {
        emphasis: 'subtle',
        previousValue,
      }));

      try {
        await persistRuntimePreferences(patch, { receipt });
        settleOwnedScopes(scopeList, receipt, (scope) => resolveActivity(scope, {
          message: typeof successMessage === 'function' ? successMessage(scope) : String(successMessage || '').trim(),
        }));
      } catch (error) {
        if (!isLatestPreferenceReceipt(receipt)) {
          settleOwnedScopes(scopeList, receipt, (scope) => resolveActivity(scope, { message: '' }));
          return { ignored: true, reason: 'superseded' };
        }
        restoreRuntimePreferenceSnapshot(previousValue, receipt.sessionId);
        finishPreferenceReceipt(receipt);
        renderComposerState();
        if (state.ui.activeView === 'settings') {
          renderSettings();
        }
        settleOwnedScopes(scopeList, receipt, (scope) => failActivity(scope, {
          message: typeof failureMessage === 'function'
            ? failureMessage(error, scope)
            : String(failureMessage || '').trim(),
        }));
        throw error;
      }
    }

    // The Wave-G sticky plan-mode localStorage key is retired: the config
    // defaultRunMode (S4) owns new-chat defaults now.
    async function persistRuntimePreferences(patch, options = {}) {
      const receipt = options.receipt || beginPreferenceReceipt(patch, []);
      const nextPreferences = receipt.nextPreferences;

      if (!receipt.sessionId) {
        finishPreferenceReceipt(receipt);
        return { ignored: false, receipt };
      }

      const mappedPreferences = toPersistedPreferences(nextPreferences);
      let persisted;
      try {
        persisted = await persistSessionPreferences(receipt.sessionId, mappedPreferences);
      } catch (error) {
        if (!options.receipt && isLatestPreferenceReceipt(receipt)) {
          applyRuntimePreferenceSnapshot(receipt.sessionId, receipt.previousPreferences);
          finishPreferenceReceipt(receipt);
          renderComposerState();
          if (state.ui.activeView === 'settings') renderSettings();
        }
        throw error;
      }
      if (!isLatestPreferenceReceipt(receipt)) return { ignored: true, receipt };
      patchSessionSummary(receipt.sessionId, persisted || mappedPreferences);
      if (normalizeSessionId(getActiveSession()?.id) === receipt.sessionId) syncRuntimeDraftFromActiveSession();
      renderComposerState();
      if (state.ui.activeView === 'settings') {
        renderSettings();
      }
      renderSessions();
      finishPreferenceReceipt(receipt);
      return { ignored: false, receipt };
    }

    return {
      getActivityOwner,
      getRuntimePreferenceSnapshot,
      restoreRuntimePreferenceSnapshot,
      renderComposerStatusNotice: renderComposerStatusNoticeView,
      syncComposerActivityNotice,
      handleActivityChange,
      runRuntimePreferenceActivity,
      persistRuntimePreferences,
    };
  }

  return { createActivityPrefsController };
});
