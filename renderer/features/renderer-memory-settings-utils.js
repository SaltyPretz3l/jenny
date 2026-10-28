(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(globalThis); return; }
  root.rendererMemorySettingsUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const MAX_RENDERED_MEMORIES = 200;
  const MAX_STATUS_REASONS = 8;
  const MAX_STATUS_REASON_INPUTS = 32;
  // Mirrors MAX_FORGOTTEN_SCOPES in sidecar/ai/memory/store.py.
  const MAX_FORGOTTEN_SCOPES = 64;

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function boundedCount(value, fallback = null) {
    return typeof value === 'number'
      && Number.isInteger(value)
      && value >= 0
      && value <= 1_000_000_000
      ? value
      : fallback;
  }

  function hasOwn(source, key) {
    return Object.prototype.hasOwnProperty.call(source, key);
  }

  function normalizeMemoryStatus(raw) {
    if (!isPlainObject(raw) || typeof raw.available !== 'boolean') return null;
    if (raw.counts !== undefined && !isPlainObject(raw.counts)) return null;
    if (raw.storage !== undefined && !isPlainObject(raw.storage)) return null;
    if (raw.degraded_reasons !== undefined && !Array.isArray(raw.degraded_reasons)) return null;
    const rawCounts = isPlainObject(raw.counts) ? raw.counts : {};
    const approved = boundedCount(rawCounts.approved);
    const pending = boundedCount(rawCounts.pending);
    if (raw.available && (approved === null || pending === null)) return null;
    const rawStorage = isPlainObject(raw.storage) ? raw.storage : {};
    for (const [source, key] of [
      [rawCounts, 'quarantined'],
      [rawStorage, 'physical_bytes'],
      [rawStorage, 'capacity_bytes'],
    ]) {
      if (hasOwn(source, key) && boundedCount(source[key]) === null) return null;
    }
    if (hasOwn(raw, 'schema_version') && raw.schema_version !== null && boundedCount(raw.schema_version) === null) return null;
    if (hasOwn(raw, 'recall_index') && typeof raw.recall_index !== 'string') return null;
    if (hasOwn(rawStorage, 'state')
      && (typeof rawStorage.state !== 'string' || !rawStorage.state.trim() || rawStorage.state.length > 40)) return null;
    const reasons = [];
    const rawReasons = Array.isArray(raw.degraded_reasons) ? raw.degraded_reasons : [];
    for (let index = 0; index < Math.min(rawReasons.length, MAX_STATUS_REASON_INPUTS); index += 1) {
      const rawReason = rawReasons[index];
      if (typeof rawReason !== 'string') return null;
      const reason = rawReason.trim().slice(0, 64);
      if (reason && !reasons.includes(reason)) reasons.push(reason);
      if (reasons.length >= MAX_STATUS_REASONS) break;
    }
    return {
      available: raw.available,
      schemaVersion: boundedCount(raw.schema_version),
      recallIndex: String(raw.recall_index || '').trim().slice(0, 40),
      counts: {
        approved,
        pending,
        quarantined: boundedCount(rawCounts.quarantined, 0),
      },
      storage: {
        state: String(rawStorage.state || 'unavailable').trim().slice(0, 40),
        physicalBytes: boundedCount(rawStorage.physical_bytes),
        capacityBytes: boundedCount(rawStorage.capacity_bytes),
      },
      preserved: raw.preserved === true,
      repairRequired: raw.repair_required === true,
      degradedReasons: reasons,
      alwaysOnBudget: normalizeAlwaysOnBudget(raw.always_on_budget),
      forgottenScopes: normalizeScopeIds(raw.forgotten_scopes),
    };
  }

  // Scopes whose rows are all forgotten keep their tab and Forgotten fold.
  function normalizeScopeIds(raw) {
    if (!Array.isArray(raw)) return [];
    const ids = raw.slice(0, MAX_FORGOTTEN_SCOPES)
      .filter((id) => typeof id === 'string' && /^[\w.:-]{1,128}$/u.test(id));
    return [...new Set(ids)];
  }

  // The always-on section's character budget (sidecar contracts.py); null
  // keeps the page's built-in defaults.
  function normalizeAlwaysOnBudget(raw) {
    if (!isPlainObject(raw)) return null;
    const budgetChars = boundedCount(raw.budget_chars);
    const headingReserve = boundedCount(raw.heading_reserve);
    const rowOverhead = boundedCount(raw.row_overhead);
    return budgetChars && headingReserve !== null && rowOverhead !== null && budgetChars <= 100_000
      ? { budgetChars, headingReserve, rowOverhead }
      : null;
  }

  function buildMemoryHealthMessages(status) {
    if (!status) return [jt('memory.health.detailsUnavailable', 'Memory health details are unavailable.')];
    const messages = [];
    for (const reason of status.degradedReasons) {
      if (reason === 'CMP-MEM-0008') {
        const count = status.counts.quarantined || 0;
        messages.push(jtn('memory.health.recordsNeedReview', count, { count }, '{count} memory record needs review in Diagnostics.', '{count} memory records need review in Diagnostics.'));
      } else if (reason === 'CMP-MEM-0007') {
        const capacity = status.storage.capacityBytes;
        messages.push(capacity === null
          ? jt('memory.health.capacityReached', 'Memory storage has reached its capacity; open Diagnostics for repair guidance.')
          : jt('memory.health.capacityReachedMb', 'Memory storage has reached its {capacity} MB capacity.', { capacity: Math.ceil(capacity / (1024 * 1024)) }));
      } else if (reason === 'recall_index_unavailable') {
        messages.push(jt('memory.health.recallIndexUnavailable', 'Fast recall indexing is unavailable; bounded fallback recall remains active.'));
      } else if (reason === 'recall_partial') {
        messages.push(jt('memory.health.recallPartial', 'The most recent recall completed with partial results.'));
      } else {
        messages.push(jt('memory.health.needsAttention', 'Memory health needs attention; open Diagnostics for details.'));
      }
    }
    if (!status.available && !messages.length) {
      messages.push(status.repairRequired
        ? jt('memory.health.repairRequired', 'Memory is unavailable and requires repair; open Diagnostics for guidance.')
        : jt('memory.health.detailsUnavailable', 'Memory health details are unavailable.'));
    } else if (!status.available) {
      messages.unshift(jt('memory.health.detailsUnavailable', 'Memory health details are unavailable.'));
    }
    return [...new Set(messages)];
  }

  function createMemorySettingsRenderer(deps) {
    const { state, escapeHtml = (value) => String(value || '') } = deps || {};
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const textField = root.inventoryTextField;
    const selectField = root.inventorySelectField;
    const settingsFoundation = root.rendererSettingsFoundation || {};
    const settingsSupport = root.rendererSettingsSupport || {};
    const pageViewUtils = root.rendererMemoryPageViewUtils
      || (typeof require === 'function' ? require('./renderer-memory-page-view-utils') : {});
    const kindOptions = Array.isArray(deps?.kindOptions) ? deps.kindOptions : [];
    const getProjectLabel = typeof deps?.getProjectLabel === 'function' ? deps.getProjectLabel : (projectId) => String(projectId || '');
    const MEMORY_POLICY_TOGGLE_IDS = ['memoryTakeNotes', 'memoryAskBeforeSaving', 'memoryPauseSaving', 'memoryUseInChats'];
    const view = pageViewUtils.createMemoryPageView?.({
      escapeHtml,
      getKindLabel: deps?.getKindLabel,
      chatTitle: (sessionId) => chatTitle(sessionId),
    }) || null;
    let scheduledPendingFocusKey = '';

    function findChat(sessionId) {
      const id = String(sessionId || '').trim();
      if (!id) return null;
      const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
      return sessions.find((row) => row && (row.id === id || row.session_id === id)) || null;
    }

    // The chat by its title; '' when it is gone or untitled (never a raw id).
    function chatTitle(sessionId) {
      return String(findChat(sessionId)?.title || '').trim().slice(0, 80);
    }

    function captureControlFocus(dom) {
      const active = root.document?.activeElement;
      if (!active || !dom.memorySection?.contains(active)) return null;
      let selector = '';
      if (['memoryManagerSearchInput', 'memoryManagerKindFilter'].includes(active.id) || /^memoryText\d+$/.test(active.id)) {
        selector = `#${active.id}`;
      } else if (MEMORY_POLICY_TOGGLE_IDS.includes(active.dataset?.invToggle) || /^memoryAlwaysOn-\d+$/.test(active.dataset?.invToggle || '')) {
        selector = `[data-inv-toggle="${active.dataset.invToggle}"]`;
      } else if (active.dataset?.memoryScope) {
        selector = `[data-memory-scope="${active.dataset.memoryScope}"]`;
      } else if (active.dataset?.memoryFold) {
        selector = `[data-memory-fold="${active.dataset.memoryFold}"]`;
      }
      return selector ? {
        selector,
        selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
      } : null;
    }

    function restoreControlFocus(dom, snapshot) {
      if (!snapshot) return;
      const control = dom.memorySection?.querySelector(snapshot.selector);
      if (!control || typeof control.focus !== 'function') return;
      try { control.focus({ preventScroll: true }); } catch (_error) { control.focus(); }
      if (snapshot.selectionStart !== null && typeof control.setSelectionRange === 'function') {
        control.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
      }
    }

    // Memory v2 switches (shell config `memory`); renderer-memory-actions-utils.js binds them.
    function renderPolicyToggles(dom) {
      const host = dom.memorySection?.querySelector?.('#memoryPolicyHost');
      if (!host || typeof settingsSupport.buildSettingsToggleListMarkup !== 'function') return;
      const memory = state.features?.memory || {};
      host.innerHTML = settingsSupport.buildSettingsToggleListMarkup({
        escapeHtml,
        toggleSwitch: root.inventoryToggleSwitch?.toggleSwitch,
        fields: [
          { id: 'memoryTakeNotes', checked: memory.takeNotes !== false },
          { id: 'memoryAskBeforeSaving', checked: memory.askBeforeSaving === true },
          { id: 'memoryPauseSaving', checked: memory.pauseSaving === true },
          { id: 'memoryUseInChats', checked: memory.useInChats !== false },
        ],
      });
    }

    function renderControls(dom) {
      renderPolicyToggles(dom);
      if (dom.memoryKindFilterHost && typeof selectField === 'function') {
        dom.memoryKindFilterHost.innerHTML = selectField({ id: 'memoryManagerKindFilter', label: jt('memory.settings.kindLabel', 'Kind'), value: state.memoryManager.filter, options: kindOptions });
      }
      if (dom.memorySearchHost && typeof textField === 'function') {
        dom.memorySearchHost.innerHTML = textField({ id: 'memoryManagerSearchInput', label: jt('memory.settings.searchLabel', 'Search'), value: state.memoryManager.searchQuery, placeholder: jt('memory.page.searchPlaceholder', 'Search memories'), maxLength: 120 });
      }
      if (dom.memoryFilesHost && view && !dom.memoryFilesHost.childElementCount) dom.memoryFilesHost.innerHTML = view.filesMarkup();
      const headerActions = dom.memorySection?.querySelector?.('#memoryHeaderActions');
      if (headerActions && !headerActions.childElementCount && typeof root.inventoryActionButton === 'function') {
        headerActions.innerHTML = root.inventoryActionButton({ id: 'memoryExportButton', label: jt('memory.page.export', 'Export as Markdown'), variant: 'secondary', size: 'sm', dataset: { 'memory-page-action': 'export' } });
      }
    }

    function renderStatus(dom, approvedFallback, pendingFallback) {
      const snapshot = state.memoryManager.statusSnapshot;
      const statusUnavailable = state.memoryManager.statusUnavailable === true;
      const status = statusUnavailable && snapshot?.available === true ? null : snapshot;
      const countStatus = statusUnavailable ? null : status;
      const approved = countStatus?.counts.approved ?? approvedFallback;
      const pending = countStatus?.counts.pending ?? pendingFallback;
      const approvedUnavailable = state.memoryManager.unavailable === true;
      const pendingUnavailable = state.memoryManager.pendingUnavailable === true;
      const listUnavailable = approvedUnavailable || pendingUnavailable;
      const allListsUnavailable = approvedUnavailable && pendingUnavailable;
      const degraded = Boolean(status && (status.degradedReasons.length || status.repairRequired)) || listUnavailable;
      const loading = state.memoryManager.statusLoading === true && !state.memoryManager.statusLoaded;
      settingsFoundation.applyBadgeState?.(dom.memoryBadge, loading
        ? { state: 'loading', srLabel: jt('memory.settings.loadingStatusLabel', 'Loading memory status') }
        : status?.available
          ? { state: degraded ? 'warn' : 'success', text: listUnavailable ? jt('memory.settings.badgePartial', 'Partial') : jt('memory.settings.savedCount', '{count} saved', { count: approved }) }
          : { state: 'error', text: jt('memory.settings.badgeUnavailable', 'Unavailable') });
      const tone = status?.available && !allListsUnavailable ? (degraded ? 'warning' : 'success') : 'danger';
      const message = loading
        ? jt('memory.settings.loadingStatus', 'Loading memory status...')
        : allListsUnavailable
          ? jt('memory.settings.dataUnavailable', 'Memory data is unavailable.')
          : jt('memory.settings.countSummary', '{approved} approved · {pending} pending{availability}', { approved, pending, availability: listUnavailable ? jt('memory.settings.partiallyAvailableSuffix', ' · partially available') : status?.available ? '' : jt('memory.settings.healthUnavailableSuffix', ' · health details unavailable') });
      // A healthy, loaded summary only repeated the header badge, so it shows
      // only while it says something more (loading, partial, unavailable or degraded).
      const summaryRedundant = !loading && Boolean(status?.available) && !degraded;
      if (dom.memorySummary) dom.memorySummary.hidden = summaryRedundant;
      if (summaryRedundant) {
        if (dom.memorySummary) dom.memorySummary.innerHTML = '';
      } else if (typeof settingsSupport.renderStatusRowContainer === 'function') {
        settingsSupport.renderStatusRowContainer(dom.memorySummary, settingsSupport.buildSettingsSummaryModel({
          tone, label: jt('memory.settings.summaryLabel', 'Memory'), message, badgeText: status?.available
            ? (degraded ? jt('memory.settings.badgeDegraded', 'Degraded') : jt('memory.settings.badgeReady', 'Ready'))
            : jt('memory.settings.badgeUnavailable', 'Unavailable'),
          spinner: loading,
        }), escapeHtml);
      } else if (dom.memorySummary) {
        dom.memorySummary.textContent = message;
      }
      const healthMessages = loading || (status?.available && !degraded) ? [] : buildMemoryHealthMessages(status);
      if (listUnavailable) healthMessages.push(jt('memory.health.recordsLoadFailed', 'Some memory records could not be loaded.'));
      if (dom.memoryHealthNote) {
        dom.memoryHealthNote.hidden = healthMessages.length === 0;
        dom.memoryHealthNote.innerHTML = healthMessages.length
          ? `<ul class="memory-health-list" role="list">${healthMessages.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
          : '';
      }
    }

    function applyPendingFocus(dom) {
      const focusKey = String(state.memoryManager.pendingFocusKey || '');
      if (!focusKey
        || state.memoryManager.pendingFocusAppliedKey === focusKey
        || scheduledPendingFocusKey === focusKey
        || !dom.memorySection?.classList.contains('settings-section-active')
        || state.memoryManager.pendingLoading
        || !state.memoryManager.pendingLoaded) {
        return;
      }
      scheduledPendingFocusKey = focusKey;
      const schedule = typeof root.requestAnimationFrame === 'function'
        ? root.requestAnimationFrame.bind(root)
        : (callback) => callback();
      schedule(() => {
        if (typeof deps?.canFocus === 'function' && !deps.canFocus()) return;
        scheduledPendingFocusKey = '';
        if (state.memoryManager.pendingFocusKey !== focusKey
          || state.memoryManager.pendingFocusAppliedKey === focusKey
          || !dom.memorySection?.classList.contains('settings-section-active')) {
          return;
        }
        const target = [...(dom.pendingMemoryHost?.querySelectorAll?.('[data-pending-memory-key]') || [])]
          .find((node) => node.dataset.pendingMemoryKey === focusKey)
          || dom.memoryPageHeading;
        if (!target || typeof target.focus !== 'function') return;
        target.tabIndex = -1;
        try { target.focus({ preventScroll: false }); } catch (_error) { target.focus(); }
        state.memoryManager.pendingFocusAppliedKey = focusKey;
      });
    }

    // Proposals show while "Ask before Jenny saves" is on, and after it is
    // turned off for as long as some still wait.
    function renderPending(dom, pendingAll) {
      if (!dom.pendingMemoryHost || !view) return;
      dom.pendingMemoryHost.innerHTML = pendingAll.length && !state.memoryManager.pendingUnavailable
        ? view.pendingMarkup(pendingAll.slice(0, MAX_RENDERED_MEMORIES), deps.buildPendingKey, state.memoryManager.pendingReviewActionByKey, getProjectLabel)
        : '';
      dom.pendingMemoryHost.hidden = !dom.pendingMemoryHost.innerHTML;
    }

    function listStatusText(scopeRows, filtered) {
      if (state.memoryManager.loading && !state.memoryManager.loaded) return jt('memory.page.loading', 'Loading…');
      if (state.memoryManager.unavailable) return state.memoryManager.status;
      if (!scopeRows.length) return jt('memory.page.empty', 'Jenny hasn’t remembered anything here yet. Tell her “remember that…” in a chat, or type /remember.');
      return filtered.length ? '' : jt('memory.page.noMatches', 'No memories match.');
    }

    function renderList(dom, scopeRows, filteredAll) {
      const limit = Math.max(Number(state.memoryManager.approvedVisibleLimit) || MAX_RENDERED_MEMORIES, MAX_RENDERED_MEMORIES);
      const filtered = filteredAll.slice(0, limit);
      const editingId = Number(state.memoryManager.editingMemoryId);
      if (dom.approvedMemoryList) {
        dom.approvedMemoryList.innerHTML = filtered.map((memory) => view.recordMarkup(memory, {
          editing: editingId === memory.id,
          draftText: deps.getFieldValue(memory, 'lesson_text'),
          busy: Boolean(state.memoryManager.pendingActionById.get(memory.id)),
          sourceAvailable: Boolean(findChat(memory.session_id)),
        })).join('');
        dom.approvedMemoryList.hidden = !filtered.length;
      }
      if (dom.approvedMemoryStatus) dom.approvedMemoryStatus.textContent = listStatusText(scopeRows, filtered);
      if (dom.approvedMemoryMoreHost) {
        dom.approvedMemoryMoreHost.innerHTML = filtered.length < filteredAll.length && typeof root.inventoryActionButton === 'function'
          ? root.inventoryActionButton({ id: 'show-more-approved-memories', label: jt('memory.settings.showMore', 'Show {count} more', { count: Math.min(MAX_RENDERED_MEMORIES, filteredAll.length - filtered.length) }), variant: 'secondary', dataset: { 'memory-list-action': 'show-more-approved' } })
          : '';
      }
    }

    // hasRows: the scope has active or forgotten rows.
    function renderFolds(dom, scope, scopeRows, hasRows) {
      const busy = typeof deps?.pageBusy === 'function' ? deps.pageBusy() : {};
      const archived = state.memoryManager.archivedByScope.get(scope) || [];
      if (dom.memoryForgottenHost) {
        dom.memoryForgottenHost.innerHTML = view.forgottenMarkup(archived, {
          open: state.memoryManager.forgottenOpen === true, loading: state.memoryManager.archivedLoading === true, busyIds: busy.archived || new Set(),
          deletedProject: pageViewUtils.isDeletedProjectScope(scope, state.memoryManager.projects),
        });
      }
      if (dom.memoryHistoryHost) {
        const byId = new Map([...scopeRows, ...archived].map((memory) => [memory.id, memory]));
        dom.memoryHistoryHost.innerHTML = view.historyMarkup(state.memoryManager.operationsByScope.get(scope) || [], byId, {
          open: state.memoryManager.historyOpen === true, loading: state.memoryManager.operationsLoading === true, busyIds: busy.operations || new Set(),
        });
      }
      // An empty tab has nothing forgotten or changed worth a fold, unless one is open.
      const showFolds = hasRows || archived.length > 0 || state.memoryManager.forgottenOpen === true || state.memoryManager.historyOpen === true;
      if (dom.memoryForgottenHost) dom.memoryForgottenHost.hidden = !showFolds;
      if (dom.memoryHistoryHost) dom.memoryHistoryHost.hidden = !showFolds;
    }

    function renderMemoryPage() {
      const dom = getDom() || {};
      if (!dom.memorySection || !view) return;
      const focusSnapshot = captureControlFocus(dom);
      renderControls(dom);
      const memories = Array.isArray(state.memoryManager.memories) ? state.memoryManager.memories : [];
      const projects = Array.isArray(state.memoryManager.projects) ? state.memoryManager.projects : [];
      // Until the user picks a tab, open on General or else the first scope with rows.
      if (!state.memoryManager.scopeTabChosen) {
        const general = pageViewUtils.GENERAL_PROJECT_ID;
        const hasGeneral = memories.some((memory) => pageViewUtils.memoryScope(memory) === general);
        state.memoryManager.scopeTab = hasGeneral || !memories.length ? general : pageViewUtils.memoryScope(memories[0]);
      }
      const scope = state.memoryManager.scopeTab || pageViewUtils.GENERAL_PROJECT_ID;
      const scopeRows = memories.filter((memory) => pageViewUtils.memoryScope(memory) === scope);
      const query = String(state.memoryManager.searchQuery || '').trim().toLowerCase();
      const kind = String(state.memoryManager.filter || 'all');
      const filteredAll = scopeRows.filter((memory) => (kind === 'all' || memory.lesson_kind === kind) && (!query || deps.searchText(memory).includes(query)));
      const pendingAll = deps.sortPending(state.memoryManager.pendingCandidates);
      renderStatus(dom, memories.length, pendingAll.length);
      const forgottenScopes = state.memoryManager.statusSnapshot?.forgottenScopes || [];
      if (dom.memoryTabsHost) {
        dom.memoryTabsHost.innerHTML = view.tabsMarkup(pageViewUtils.buildScopeTabs(memories, projects, scope, getProjectLabel, forgottenScopes), scope);
      }
      if (dom.memoryMeter) {
        dom.memoryMeter.innerHTML = view.meterMarkup(pageViewUtils.alwaysOnUsage(memories, scope, state.memoryManager.statusSnapshot?.alwaysOnBudget), scope);
        dom.memoryMeter.hidden = !dom.memoryMeter.innerHTML;
      }
      // Search and the kind filter only help once the tab has rows.
      const tools = dom.memoryKindFilterHost?.closest?.('.memory-page-filters');
      if (tools) tools.hidden = !scopeRows.length;
      renderPending(dom, pendingAll);
      renderList(dom, scopeRows, filteredAll);
      renderFolds(dom, scope, scopeRows, scopeRows.length > 0 || forgottenScopes.includes(scope));
      restoreControlFocus(dom, focusSnapshot);
      applyPendingFocus(dom);
    }

    return { renderMemoryPage };
  }

  return {
    createMemorySettingsRenderer,
    normalizeMemoryStatus,
    buildMemoryHealthMessages,
  };
});
