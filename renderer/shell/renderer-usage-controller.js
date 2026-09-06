(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-usage-markup-utils'));
  } else {
    root.rendererUsageController = factory(root.rendererUsageMarkupUtils);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (markupUtils) {
  'use strict';

  const PAGE_SIZE = 50;
  const INTERACTIVE_LIMIT = 200;
  const REFRESH_INTERVAL_MS = 2000;
  const STOPPED_OUTCOMES = new Set(['cancelled', 'interrupted', 'preempted', 'denied', 'timeout', 'error']);

  function safeString(value) {
    return String(value == null ? '' : value).trim();
  }

  function isUsageSnapshot(value) {
    return Boolean(value && typeof value === 'object'
      && value.persistence && typeof value.persistence === 'object'
      && value.retention && typeof value.retention === 'object'
      && value.today && typeof value.today === 'object'
      && value.session && typeof value.session === 'object'
      && value.cumulative && typeof value.cumulative === 'object'
      && Array.isArray(value.recent_turns));
  }

  function createUsageController(deps = {}) {
    const windowRef = deps.window || (typeof window !== 'undefined' ? window : null);
    const dom = deps.dom || {};
    const callbacks = deps.callbacks || {};
    const inventory = deps.inventory || windowRef?.inventory || {
      actionButton: windowRef?.inventoryActionButton,
      segmentedControl: windowRef?.inventorySegmentedControl,
    };
    const utils = deps.markupUtils || markupUtils || {};
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const setTimer = deps.setTimeout || windowRef?.setTimeout?.bind(windowRef) || setTimeout;
    const clearTimer = deps.clearTimeout || windowRef?.clearTimeout?.bind(windowRef) || clearTimeout;
    const state = {
      scope: 'today',
      snapshot: null,
      selectedModel: '',
      outcomeOnly: false,
      visibleCount: PAGE_SIZE,
      active: false,
      disposed: false,
      bound: false,
      busyAction: '',
      actionEpoch: 0,
      requestEpoch: 0,
      refreshTimer: null,
      lastRefreshAt: 0,
      lastPaintSignature: '',
    };
    const listeners = [];

    function addListener(target, type, listener) {
      if (!target?.addEventListener) return;
      target.addEventListener(type, listener);
      listeners.push(() => target.removeEventListener(type, listener));
    }

    function isVisible() {
      if (!state.active || state.disposed) return false;
      if (typeof callbacks.isVisible === 'function') return callbacks.isVisible() === true;
      return true;
    }

    function setStatus(message, { visuallyHidden = false } = {}) {
      if (dom.usageActionStatus && !state.disposed) {
        dom.usageActionStatus.textContent = safeString(message);
        dom.usageActionStatus.dataset.visual = visuallyHidden ? 'hidden' : 'visible';
      }
    }

    function logWarning(event, details = {}) {
      callbacks.appendClientLog?.('WARN', event, details);
    }

    function scopeTotals() {
      const snapshot = state.snapshot || {};
      if (state.scope === 'session') return snapshot.session || {};
      if (state.scope === 'all') return snapshot.cumulative || {};
      return snapshot.today || {};
    }

    function todayStart() {
      const date = new Date(now());
      return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    }

    function scopeRows() {
      const rows = Array.isArray(state.snapshot?.recent_turns) ? state.snapshot.recent_turns : [];
      const sessionId = safeString(callbacks.getCurrentSessionId?.());
      return rows.filter((row) => {
        if (state.scope === 'session') return Boolean(sessionId) && safeString(row?.session_id) === sessionId;
        if (state.scope === 'today') return Date.parse(row?.recorded_at || '') >= todayStart();
        return true;
      });
    }

    function filteredRows() {
      return scopeRows().filter((row) => {
        if (state.selectedModel && safeString(row?.model) !== state.selectedModel) return false;
        return !state.outcomeOnly || STOPPED_OUTCOMES.has(safeString(row?.outcome).toLowerCase());
      });
    }

    function retainedCount() {
      const totals = scopeTotals();
      return Math.max(Number(totals.turn_count) || 0, 0);
    }

    function paintScopeOnce() {
      if (!dom.usageScope || dom.usageScope.childElementCount > 0) return;
      dom.usageScope.innerHTML = utils.buildScopeMarkup?.(inventory, state.scope) || '';
    }

    function paintLoading() {
      paintScopeOnce();
      const statSkeleton = '<div class="usage-stat"><span class="skeleton skeleton--text-lg"></span></div>'.repeat(4);
      const rowSkeleton = '<div class="skeleton skeleton--row"></div>'.repeat(6);
      if (dom.usageStats) dom.usageStats.innerHTML = statSkeleton;
      if (dom.usageByModel) dom.usageByModel.innerHTML = rowSkeleton;
      if (dom.usageRecentTurns) dom.usageRecentTurns.innerHTML = rowSkeleton;
      if (dom.usageRecentMeta) dom.usageRecentMeta.textContent = 'Loading usage…';
      paintActions();
    }

    function paintActions() {
      if (!dom.usageActions) return;
      dom.usageActions.innerHTML = utils.buildActionsMarkup?.(inventory, state.busyAction) || '';
      const readOnly = Boolean(state.snapshot?.persistence?.read_only_reason);
      const clear = dom.usageActions.querySelector?.('[data-usage-action="clear"]');
      if (clear && readOnly) {
        clear.disabled = true;
        clear.title = 'Usage history is read-only.';
      }
      if (clear && !state.snapshot?.retention?.retained_turns) clear.disabled = true;
    }

    function paintRetention() {
      if (!dom.usageRetentionSummary) return;
      const persistence = state.snapshot?.persistence || {};
      const retention = state.snapshot?.retention || {};
      let copy;
      let tone = 'neutral';
      if (persistence.read_only_reason) {
        copy = 'usage-history.json could not be read. Existing rows are preserved and nothing new is being recorded.';
        tone = 'danger';
      } else if (Number(retention.retained_turns) >= Number(retention.max_turns) && Number(retention.max_turns) > 0) {
        const oldestMs = Date.parse(retention.oldest_at || '');
        const days = Number.isFinite(oldestMs) ? Math.max(1, Math.ceil((now() - oldestMs) / 86400000)) : 0;
        copy = `Holding the newest ${utils.formatInteger(retention.max_turns)} turns. Totals cover the last ${days} days, not ${utils.formatInteger(retention.max_age_days)}.`;
        tone = 'warning';
      } else {
        const oldestMs = Date.parse(retention.oldest_at || '');
        const ageDays = Number.isFinite(oldestMs) ? Math.max(0, Math.floor((now() - oldestMs) / 86400000)) : 0;
        copy = `Kept on this device: ${utils.formatInteger(retention.retained_turns)} of ${utils.formatInteger(retention.max_turns)} turns, oldest ${ageDays} ${ageDays === 1 ? 'day' : 'days'} ago.`;
      }
      dom.usageRetentionSummary.textContent = copy;
      dom.usageRetentionSummary.dataset.tone = tone;
      if (dom.usageRecordWarning) {
        dom.usageRecordWarning.textContent = state.snapshot?.last_record_error
          ? 'The most recent turn could not be saved.'
          : '';
      }
    }

    function paintEmpty() {
      if (dom.usageScope) dom.usageScope.hidden = true;
      const empty = '<div class="usage-empty"><div class="empty-state-claim">Nothing measured yet.</div>'
        + '<div class="empty-state-claim">Numbers appear here after your first retained turn.</div></div>';
      if (dom.usageStats) dom.usageStats.innerHTML = empty;
      if (dom.usageByModel) dom.usageByModel.innerHTML = '';
      if (dom.usageRecentMeta) dom.usageRecentMeta.textContent = '';
      if (dom.usageRecentTurns) dom.usageRecentTurns.innerHTML = '';
      if (dom.usageMore) dom.usageMore.innerHTML = '';
      paintRetention();
      paintActions();
    }

    function paintFilterPressedState() {
      dom.usageByModel?.querySelectorAll?.('[data-usage-model]').forEach((row) => {
        row.setAttribute('aria-pressed', safeString(row.dataset.usageModel) === state.selectedModel ? 'true' : 'false');
      });
      const outcomeControl = dom.usageStats?.querySelector?.('[data-usage-outcome-filter]');
      if (outcomeControl) outcomeControl.setAttribute('aria-pressed', state.outcomeOnly ? 'true' : 'false');
    }

    function paintRecent({ preserveTable = false, restoreMoreFocus = false } = {}) {
      const matched = filteredRows();
      const visible = matched.slice(0, state.visibleCount);
      const filteredEmpty = matched.length === 0 && (state.selectedModel || state.outcomeOnly);
      const body = dom.usageRecentTurns?.querySelector?.('[data-usage-recent-body]');
      if (preserveTable && body) {
        body.innerHTML = utils.buildRecentRowsMarkup?.(inventory, visible, filteredEmpty) || '';
      } else if (dom.usageRecentTurns) {
        dom.usageRecentTurns.innerHTML = (utils.buildRecentTableMarkup?.(inventory, visible, filteredEmpty) || '')
          + (utils.buildFootnotesMarkup?.(scopeTotals()) || '');
      }
      if (dom.usageRecentMeta) {
        dom.usageRecentMeta.innerHTML = utils.buildRecentMetaMarkup?.(inventory, {
          shown: visible.length,
          matched: matched.length,
          retained: retainedCount(),
          selectedModel: state.selectedModel,
          outcomeOnly: state.outcomeOnly,
        }) || '';
      }
      if (dom.usageMore) {
        dom.usageMore.innerHTML = utils.buildMoreMarkup?.(inventory, visible.length, matched.length) || '';
      }
      paintFilterPressedState();
      if (restoreMoreFocus) {
        dom.usageMore?.querySelector?.('[data-usage-action="more"]')?.focus?.();
      }
    }

    function paintSnapshot() {
      if (!state.snapshot) return;
      const available = state.snapshot.available !== false;
      if (dom.usageBadge) dom.usageBadge.textContent = available ? (state.snapshot.persistence?.durable ? 'Local' : 'Memory') : 'Unavailable';
      if (!available && !state.snapshot.retention?.retained_turns) {
        if (dom.usageScope) dom.usageScope.hidden = true;
        if (dom.usageStats) dom.usageStats.innerHTML = '<div class="usage-empty"><div class="empty-state-claim">Usage data is unavailable.</div></div>';
        if (dom.usageByModel) dom.usageByModel.innerHTML = '';
        if (dom.usageRecentMeta) dom.usageRecentMeta.textContent = '';
        if (dom.usageRecentTurns) dom.usageRecentTurns.innerHTML = '';
        if (dom.usageMore) dom.usageMore.innerHTML = '';
        paintRetention();
        paintActions();
        return;
      }
      if (state.snapshot.retention?.retained_turns === 0) {
        paintEmpty();
        return;
      }
      if (dom.usageScope) dom.usageScope.hidden = false;
      paintScopeOnce();
      const totals = scopeTotals();
      const signature = JSON.stringify([state.scope, totals]);
      if (signature !== state.lastPaintSignature) {
        state.lastPaintSignature = signature;
        if (dom.usageStats) dom.usageStats.innerHTML = utils.buildStatsMarkup?.(totals, state.outcomeOnly) || '';
        if (dom.usageByModel) dom.usageByModel.innerHTML = utils.buildModelTableMarkup?.(totals, state.selectedModel) || '';
      }
      paintRecent();
      paintRetention();
      paintActions();
    }

    function unavailableSnapshot() {
      return {
        available: false,
        persistence: { durable: false, read_only_reason: 'unavailable' },
        retention: { max_age_days: 30, max_turns: 500, retained_turns: 0, oldest_at: '' },
        today: {}, session: {}, cumulative: {}, recent_turns: [],
      };
    }

    async function refresh(options = {}) {
      if (!isVisible()) return null;
      const getSnapshot = windowRef?.jennyShell?.usage?.getSnapshot;
      const epoch = ++state.requestEpoch;
      state.lastRefreshAt = now();
      try {
        if (typeof getSnapshot !== 'function') throw new Error('bridge_unavailable');
        const snapshot = await getSnapshot({
          mode: 'interactive',
          sessionId: safeString(callbacks.getCurrentSessionId?.()),
          limit: INTERACTIVE_LIMIT,
        });
        if (epoch !== state.requestEpoch || !isVisible()) return null;
        const valid = isUsageSnapshot(snapshot);
        state.snapshot = valid ? snapshot : unavailableSnapshot();
        if (!valid) logWarning('settings.usage_snapshot_unavailable', { reason: 'invalid_response' });
        paintSnapshot();
        if (state.snapshot.available === false) {
          setStatus('Usage data is unavailable.');
          logWarning('settings.usage_snapshot_unavailable', { reason: 'unavailable_result' });
        } else if (!options.silent) {
          setFilterStatus();
        }
        return state.snapshot;
      } catch (_error) {
        if (epoch !== state.requestEpoch || !isVisible()) return null;
        state.snapshot = unavailableSnapshot();
        paintSnapshot();
        setStatus('Usage data is unavailable.');
        logWarning('settings.usage_snapshot_unavailable', { reason: 'transport_failure' });
        return state.snapshot;
      }
    }

    function activate() {
      if (state.disposed) return Promise.resolve(null);
      state.active = true;
      bind();
      if (!state.snapshot) paintLoading();
      return refresh({ silent: Boolean(state.snapshot) });
    }

    function deactivate() {
      state.active = false;
      state.actionEpoch += 1;
      state.busyAction = '';
      state.requestEpoch += 1;
      if (state.refreshTimer) clearTimer(state.refreshTimer);
      state.refreshTimer = null;
    }

    function notifyTurnSettled() {
      if (!isVisible()) {
        deactivate();
        return;
      }
      if (state.refreshTimer) return;
      const delay = Math.max(0, REFRESH_INTERVAL_MS - (now() - state.lastRefreshAt));
      state.refreshTimer = setTimer(() => {
        state.refreshTimer = null;
        refresh({ silent: true });
      }, delay);
    }

    function setFilterStatus() {
      setStatus(
        `Showing ${Math.min(filteredRows().length, state.visibleCount)} of ${retainedCount()} turns.`,
        { visuallyHidden: true }
      );
    }

    function toggleModel(model) {
      // Headline totals intentionally remain scoped only by time window; the selected
      // model row already presents that model's aggregate figures.
      state.selectedModel = state.selectedModel === model ? '' : model;
      state.visibleCount = PAGE_SIZE;
      paintRecent({ preserveTable: true });
      setFilterStatus();
    }

    function toggleOutcome() {
      state.outcomeOnly = !state.outcomeOnly;
      state.visibleCount = PAGE_SIZE;
      paintRecent({ preserveTable: true });
      setFilterStatus();
    }

    function clearFilters({ restoreFocus = false } = {}) {
      const previousModel = state.selectedModel;
      const previousOutcomeOnly = state.outcomeOnly;
      state.selectedModel = '';
      state.outcomeOnly = false;
      state.visibleCount = PAGE_SIZE;
      paintRecent({ preserveTable: true });
      setFilterStatus();
      if (restoreFocus) {
        const modelControl = [...(dom.usageByModel?.querySelectorAll?.('[data-usage-model]') || [])]
          .find((row) => safeString(row.dataset.usageModel) === previousModel);
        const outcomeControl = previousOutcomeOnly
          ? dom.usageStats?.querySelector?.('[data-usage-outcome-filter]')
          : null;
        (modelControl || outcomeControl)?.focus?.();
      }
    }

    async function confirmClear() {
      if (typeof callbacks.confirmClear === 'function') return callbacks.confirmClear();
      return windowRef?.confirm?.('Clear usage history? This permanently removes all retained local usage rows and totals.') === true;
    }

    function actionIsCurrent(actionEpoch) {
      return state.actionEpoch === actionEpoch
        && isVisible();
    }

    function finishAction(actionEpoch) {
      if (state.actionEpoch !== actionEpoch) return;
      state.busyAction = '';
      if (isVisible()) paintActions();
    }

    async function clearHistory() {
      if (state.busyAction) return;
      const actionEpoch = ++state.actionEpoch;
      state.busyAction = 'confirm';
      paintActions();
      try {
        const confirmed = await confirmClear();
        if (!confirmed || !actionIsCurrent(actionEpoch)) return;
        state.busyAction = 'clear';
        paintActions();
        const clear = windowRef?.jennyShell?.usage?.clearHistory;
        if (typeof clear !== 'function') throw new Error('bridge_unavailable');
        const result = await clear();
        if (!actionIsCurrent(actionEpoch)) return;
        if (!result?.ok) throw new Error('clear_failed');
        setStatus(`Cleared ${utils.formatInteger(result.cleared_turn_count)} retained turns.`);
        state.snapshot = null;
        state.lastPaintSignature = '';
        await refresh({ silent: true });
      } catch (_error) {
        if (actionIsCurrent(actionEpoch)) {
          setStatus('Usage history could not be cleared.');
          logWarning('settings.usage_clear_failed', { reason: 'operation_failed' });
        }
      } finally {
        finishAction(actionEpoch);
      }
    }

    async function exportCsv() {
      if (state.busyAction) return;
      const actionEpoch = ++state.actionEpoch;
      state.busyAction = 'export';
      paintActions();
      try {
        const getSnapshot = windowRef?.jennyShell?.usage?.getSnapshot;
        const saveFile = windowRef?.jennyShell?.dialog?.saveFile;
        if (typeof getSnapshot !== 'function' || typeof saveFile !== 'function') throw new Error('bridge_unavailable');
        const result = await getSnapshot({
          mode: 'export', scope: state.scope,
          sessionId: safeString(callbacks.getCurrentSessionId?.()),
        });
        if (!actionIsCurrent(actionEpoch)) return;
        if (!result?.ok || result.scope !== state.scope || !Array.isArray(result.rows)) {
          throw new Error('export_unavailable');
        }
        const date = new Date(now()).toISOString().slice(0, 10);
        const saved = await saveFile({
          defaultName: `jenny-usage-${state.scope}-${date}.csv`,
          content: utils.buildCsv?.(result.rows || []) || '',
          format: 'plain',
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (!actionIsCurrent(actionEpoch)) return;
        if (saved?.canceled) return;
        if (!saved || saved.canceled !== false) throw new Error('save_failed');
        setStatus(`Exported ${(result.rows || []).length} turns.`);
      } catch (_error) {
        if (actionIsCurrent(actionEpoch)) {
          setStatus('Usage export could not be saved.');
          logWarning('settings.usage_export_failed', { reason: 'operation_failed' });
        }
      } finally {
        finishAction(actionEpoch);
      }
    }

    function activateTarget(target) {
      const modelRow = target?.closest?.('[data-usage-model]');
      if (modelRow) return toggleModel(safeString(modelRow.dataset.usageModel));
      if (target?.closest?.('[data-usage-outcome-filter]')) return toggleOutcome();
      const action = target?.closest?.('[data-usage-action]');
      if (!action) return;
      const kind = action.dataset.usageAction;
      if (kind === 'more') {
        const restoreMoreFocus = windowRef?.document?.activeElement === action;
        state.visibleCount += PAGE_SIZE;
        paintRecent({ preserveTable: true, restoreMoreFocus });
        setFilterStatus();
      } else if (kind === 'clear-filters') {
        clearFilters({ restoreFocus: windowRef?.document?.activeElement === action });
      }
      else if (kind === 'clear') clearHistory();
      else if (kind === 'export') exportCsv();
      else if (kind === 'chat' && action.dataset.sessionId) callbacks.openSession?.(action.dataset.sessionId);
      else if (kind === 'trace' && action.dataset.streamId) callbacks.openTrace?.({
        streamId: action.dataset.streamId,
        traceId: action.dataset.traceId || '',
        sessionId: action.dataset.sessionId || '',
      });
    }

    function bind() {
      if (state.bound || state.disposed) return;
      state.bound = true;
      addListener(dom.usageScope, 'inv-segmented-change', (event) => {
        if (event?.detail?.id !== 'usage-scope') return;
        const nextScope = safeString(event.detail.value);
        if (!['session', 'today', 'all'].includes(nextScope)) return;
        state.scope = nextScope;
        state.selectedModel = '';
        state.outcomeOnly = false;
        state.visibleCount = PAGE_SIZE;
        state.lastPaintSignature = '';
        paintSnapshot();
        setFilterStatus();
      });
      const clickHosts = [dom.usageStats, dom.usageByModel, dom.usageRecentMeta, dom.usageRecentTurns, dom.usageMore, dom.usageActions];
      clickHosts.forEach((host) => addListener(host, 'click', (event) => activateTarget(event.target)));
      [dom.usageStats, dom.usageByModel].forEach((host) => addListener(host, 'keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (!event.target?.closest?.('[data-usage-model], [data-usage-outcome-filter]')) return;
        event.preventDefault();
        activateTarget(event.target);
      }));
    }

    function dispose() {
      if (state.disposed) return;
      deactivate();
      state.disposed = true;
      state.bound = false;
      while (listeners.length) listeners.pop()();
    }

    return {
      bind,
      activate,
      deactivate,
      refresh,
      notifyTurnSettled,
      dispose,
      getState: () => ({ ...state, refreshTimer: Boolean(state.refreshTimer) }),
    };
  }

  return { createUsageController };
});
