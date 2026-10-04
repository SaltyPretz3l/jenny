/* renderer/shell/renderer-activity-prefs-utils.js — Activity + runtime-preference helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererActivityPrefsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const activityUtilsRef = () => globalThis.activityUtils
    || (typeof require === 'function' ? require('../shared/activity-utils') : null);

  function createActivityPrefsController(deps) {
    const { state } = deps;
    const { ACTIVITY_SCOPE } = deps.constants;
    const { composerStatusNotice } = deps.dom;
    const {
      getCurrentRuntimePreferences,
      // Split view W2-2a: a pane's rail names ITS session; its record is read
      // through the lifecycle's getRuntimePreferencesFromSession.
      getRuntimePreferencesFromSession,
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
      // Split view W2-2a: re-syncs the composer of a pane that is not pane 0
      // showing `sessionId` (the pane composition's composer route; a no-op
      // with one pane). renderComposerState is pane 0's.
      renderSessionComposer = () => {},
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
    // Split view W3-1: the preference saves a pane's rail shows as busy. Their
    // activity is keyed by the saved session (activity-utils sessionScope) so a
    // save on pane 1's session never marks pane 0's controls busy.
    const SESSION_KEYED_SCOPES = new Set([
      ACTIVITY_SCOPE.composerPreferredModel,
      ACTIVITY_SCOPE.composerReasoningEffort,
    ]);

    function activityScopeFor(scope, sessionId) {
      if (!SESSION_KEYED_SCOPES.has(scope)) return scope;
      const utils = activityUtilsRef();
      return typeof utils?.sessionScope === 'function' ? utils.sessionScope(scope, sessionId) : scope;
    }

    // `composer.preferredModel:<session>` -> ['composer.preferredModel', '<session>'].
    function splitSessionScope(scope) {
      for (const base of SESSION_KEYED_SCOPES) {
        if (scope === base) return [base, ''];
        if (scope.startsWith(`${base}:`)) return [base, scope.slice(base.length + 1)];
      }
      return [scope, ''];
    }

    // The session a pane shows (renderer-pane-visibility-utils.js); with one
    // pane, pane 0 is currentSessionId and pane 1 holds nothing.
    function paneSessionIdOf(paneId) {
      const visibility = globalThis.rendererPaneVisibilityUtils;
      if (typeof visibility?.resolvePaneSessionId === 'function') return visibility.resolvePaneSessionId(state, paneId);
      return paneId === 0 ? normalizeSessionId(state.currentSessionId) : '';
    }

    // Split view W3-1: the one notice slot records its session
    // (state.ui.composerStatusNoticeSessionId). A notice keyed to the session
    // pane 1 shows (and pane 0 does not) is pane 1's, and with two panes one
    // keyed to a session neither shows is no pane's (gate §D: pane 1 switched
    // away). Every unkeyed notice is pane 0's, and with one pane so is every
    // keyed one -- one pane is unchanged. Closing pane 1 drops its session's
    // notice (renderer-app-pane-composition.js handleLayoutChanged).
    function isNoticeOwnedByOtherPane() {
      const noticeSessionId = normalizeSessionId(state.ui.composerStatusNoticeSessionId);
      if (!noticeSessionId || noticeSessionId === paneSessionIdOf(0)) return false;
      return Boolean(paneSessionIdOf(1));
    }

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

    // The preferences of the session `sessionId` names, or null (no id, no
    // reader, or a session not in the list): callers then take today's path.
    function getSessionRuntimePreferences(sessionId) {
      const id = String(sessionId || '').trim();
      if (!id || typeof getRuntimePreferencesFromSession !== 'function') return null;
      const session = (Array.isArray(state.sessions) ? state.sessions : [])
        .find((entry) => String(entry?.id || '').trim() === id);
      return session ? getRuntimePreferencesFromSession(session) : null;
    }

    function getRuntimePreferenceSnapshot(sessionId) {
      const current = getSessionRuntimePreferences(sessionId) || getCurrentRuntimePreferences();
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

    function beginPreferenceReceipt(patch, scopes, targetSessionId) {
      const targetPreferences = getSessionRuntimePreferences(targetSessionId);
      const sessionId = targetPreferences
        ? normalizeSessionId(targetSessionId)
        : normalizeSessionId(getActiveSession()?.id);
      const id = `preference_receipt_${Date.now().toString(36)}_${(++nextPreferenceReceiptSequence).toString(36)}`;
      const previousPreferences = mergeRuntimePreferences(targetPreferences || getCurrentRuntimePreferences(), {});
      const receipt = Object.freeze({
        id,
        sessionId,
        previousPreferences: Object.freeze(previousPreferences),
        nextPreferences: Object.freeze(mergeRuntimePreferences(previousPreferences, patch)),
      });
      latestPreferenceReceiptBySession.set(sessionId || '__draft__', id);
      for (const scope of scopes) latestPreferenceReceiptByScope.set(activityScopeFor(scope, sessionId), id);
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

    /* No argument: pane 0's #composerStatusNotice (a notice another pane owns
     * renders nothing here). A target `{ node, sessionId }` renders the notice
     * keyed to that pane's session into the pane's own node (split view W3-1). */
    function renderComposerStatusNoticeView(target) {
      if (target && typeof target === 'object' && target.node) {
        renderPaneComposerStatusNotice(target);
        return;
      }
      if (!composerStatusNotice) {
        return;
      }
      const ownNotice = !isNoticeOwnedByOtherPane();
      const owner = ownNotice ? String(state.ui.composerStatusNoticeOwner || '').trim() : '';
      const scope = owner.startsWith('activity:') ? owner.slice('activity:'.length) : '';
      const compactionActivity = globalThis.rendererCompactionCoordinator?.getCompactionActivity?.(state, paneSessionIdOf(0)) || null;
      const snapshot = compactionActivity || (scope ? getActivitySnapshot(scope) : null);
      const message = String(compactionActivity?.message || (ownNotice ? state.ui.composerStatusNotice : '') || '').trim();
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
            label: compactionActivity ? jt('shell.activity.context', 'Context') : (fromActivity ? jt('shell.activity.composer', 'Composer') : ''),
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

    const paneNoticeSignatures = new WeakMap();
    function renderPaneComposerStatusNotice({ node, sessionId }) {
      const wanted = normalizeSessionId(sessionId);
      const ownSession = Boolean(wanted) && wanted !== paneSessionIdOf(0);
      const keyed = ownSession && normalizeSessionId(state.ui.composerStatusNoticeSessionId) === wanted;
      // Gate §D follow-up: this pane's session's compaction progress wins over
      // the slot, exactly as pane 0 renders its own (the coordinator's render
      // routes a composer sync to the pane showing the compacting session).
      const compaction = (ownSession && globalThis.rendererCompactionCoordinator?.getCompactionActivity?.(state, wanted)) || null;
      const message = String(compaction?.message || (keyed ? state.ui.composerStatusNotice : '') || '').trim();
      const tone = compaction ? String(compaction.tone || 'default') : String(state.ui.composerStatusNoticeTone || 'default');
      const badgeText = compaction
        ? (compaction.pending ? 'Compacting' : 'Context')
        : String(state.ui.composerStatusNoticeBadgeText || '');
      const spinner = compaction ? compaction.state === 'pending' : state.ui.composerStatusNoticeSpinner === true;
      const label = compaction ? jt('shell.activity.context', 'Context') : '';
      const signature = message ? [message, tone, badgeText, spinner, label, compaction?.state || ''].join('\u0000') : '';
      if (paneNoticeSignatures.get(node) === signature) return;
      paneNoticeSignatures.set(node, signature);
      node.classList.toggle('hidden', !message);
      applyActivityAttributes(node, message ? compaction : null, { setAriaBusy: true });
      if (!message) {
        node.innerHTML = '';
        return;
      }
      const statusRow = getStatusRowRenderer();
      if (statusRow) node.innerHTML = statusRow({ tone, label, message, badgeText, spinner, compact: true });
      else node.textContent = message;
      const row = node.querySelector('.inv-status-row');
      if (row && compaction) applyActivityAttributes(row, compaction, { setAriaBusy: true });
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
        const [baseScope, scopeSessionId] = splitSessionScope(scope);
        if (
          baseScope === ACTIVITY_SCOPE.composerPreferredModel ||
          baseScope === ACTIVITY_SCOPE.composerReasoningEffort
        ) {
          if (scopeSessionId) renderSessionComposer(scopeSessionId); // W3-1: the pane showing that session
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

    async function runRuntimePreferenceActivity({ patch, scopes, previousValue, failureMessage, successMessage, sessionId }) {
      const receipt = beginPreferenceReceipt(patch, Array.isArray(scopes) ? scopes.filter(Boolean) : [], sessionId);
      // W3-1: begin/resolve/fail the session-keyed scope a pane's rail reads.
      const scopeList = (Array.isArray(scopes) ? scopes.filter(Boolean) : []).map((scope) => activityScopeFor(scope, receipt.sessionId));
      scopeList.forEach((scope) => beginActivity(scope, {
        emphasis: 'subtle',
        previousValue,
      }));
      renderSessionComposer(receipt.sessionId);

      try {
        await persistRuntimePreferences(patch, { receipt });
        settleOwnedScopes(scopeList, receipt, (scope) => resolveActivity(scope, {
          message: typeof successMessage === 'function' ? successMessage(scope) : String(successMessage || '').trim(),
        }));
        renderSessionComposer(receipt.sessionId);
      } catch (error) {
        if (!isLatestPreferenceReceipt(receipt)) {
          settleOwnedScopes(scopeList, receipt, (scope) => resolveActivity(scope, { message: '' }));
          renderSessionComposer(receipt.sessionId);
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
        renderSessionComposer(receipt.sessionId);
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
