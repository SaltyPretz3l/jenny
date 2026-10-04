(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCompanionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  // Load-time ambient fallback only. Per-manager code shadows this with the
  // owner document of its deps.dom hosts -- see createCompanionManager.
  const ambientDocumentRef = windowRef.document || null;
  const companionStateUtils = typeof windowRef.rendererCompanionStateUtils !== 'undefined'
    ? windowRef.rendererCompanionStateUtils
    : typeof require === 'function'
      ? require('./renderer-companion-state-utils')
      : {};
  const companionActionUtils = typeof windowRef.rendererCompanionActionUtils !== 'undefined'
    ? windowRef.rendererCompanionActionUtils
    : typeof require === 'function'
      ? require('./renderer-companion-action-utils')
      : {};
  const openLoopRow = typeof windowRef.rendererOpenLoopRow !== 'undefined'
    ? windowRef.rendererOpenLoopRow
    : typeof require === 'function'
      ? require('./renderer-open-loop-row')
      : null;
  if (!openLoopRow || typeof openLoopRow.createOpenLoopRowRenderer !== 'function') {
    throw new Error('rendererCompanionUtils: renderer/features/renderer-open-loop-row.js must load before this module');
  }
  const { cssAttrValue, loopRowSelector } = openLoopRow;
  const {
    normalizeCompanionState = function fallbackNormalizeCompanionState(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    },
  } = companionStateUtils;

  /* Recently Completed previews the newest few; "Show all" reveals the rest. */
  const RECENT_RESOLVED_PREVIEW_COUNT = 5;
  /* A due-time refresh never fires sooner than this (clock skew, bursts) nor
   * later than a day (timer drift across sleep). */
  const DUE_REFRESH_MIN_MS = 30 * 1000;
  const DUE_REFRESH_MAX_MS = 24 * 60 * 60 * 1000;

  function noop() {}
  function noopAsync() { return Promise.resolve(); }

  function createCompanionManager(deps) {
    const { state } = deps;
    const {
      homeView,
      homeOpenLoopCount,
      homeOpenLoopStatus,
      homeOpenLoopList,
      homeDeferredSection,
      homeDeferredLoopCount,
      homeDeferredLoopStatus,
      homeDeferredLoopList,
      homeRecentResolvedSection,
      homeRecentResolvedCount,
      homeRecentResolvedStatus,
      homeRecentResolvedList,
      homeArchivedSection,
      homeArchivedLoopCount,
      homeArchivedLoopStatus,
      homeArchivedLoopList,
      homeArchivedLoopToggle,
      homeOpenLoopAddButton,
      homeOpenLoopForm,
      homeOpenLoopFormHeading,
      homeOpenLoopFormNote,
      homeOpenLoopTitleInput,
      homeOpenLoopNotesInput,
      homeOpenLoopDeferSelect,
      homeOpenLoopSaveButton,
      homeOpenLoopCancelButton,
      chatInput,
    } = deps.dom;
    // Shadows the module-level ambient ref, which is captured at LOAD time and
    // so cannot be corrected by any caller. Every node below is created here
    // and appended into one of the deps.dom hosts, so it must come from the
    // document that owns them.
    const documentRef = (homeView && homeView.ownerDocument)
      || (homeOpenLoopList && homeOpenLoopList.ownerDocument)
      || ambientDocumentRef;
    const homeRecentResolvedToggle = homeRecentResolvedSection?.querySelector?.('[data-home-resolved-toggle]') || null;
    const renderAll = typeof deps.callbacks?.renderAll === 'function' ? deps.callbacks.renderAll : noop;

    let bound = false;
    let archivedSectionExpanded = false;
    let resolvedSectionExpanded = false;
    let dueRefreshTimer = null;
    let dueRefreshAt = 0;
    let listResizeObserver = null;
    /* Per-row disclosure state lives here, keyed by followUpId, so a re-render
     * (any mutation, toast, or stream event) keeps what the user opened. */
    const expandedHistoryIds = new Set();
    const expandedBodyIds = new Set();

    function toggleSetMember(set, id) {
      const key = String(id || '');
      if (!key) {
        return;
      }
      if (set.has(key)) {
        set.delete(key);
      } else {
        set.add(key);
      }
      renderHomePanel();
    }

    const actionHandlers = companionActionUtils.createCompanionActionUtils?.({
      state,
      windowRef,
      documentRef,
      dom: {
        homeOpenLoopAddButton,
        homeOpenLoopForm,
        homeOpenLoopFormHeading,
        homeOpenLoopFormNote,
        homeOpenLoopTitleInput,
        homeOpenLoopNotesInput,
        homeOpenLoopDeferSelect,
        homeOpenLoopSaveButton,
        homeOpenLoopCancelButton,
        homeOpenLoopList,
        homeView,
        chatInput,
      },
      callbacks: {
        ...deps.callbacks,
        getCompanionState,
        applyCompanionPayload,
        renderHomePanel,
        refreshCompanionState,
        toggleArchivedSection: () => {
          archivedSectionExpanded = !archivedSectionExpanded;
          renderHomePanel();
        },
        toggleResolvedSection: () => {
          resolvedSectionExpanded = !resolvedSectionExpanded;
          renderHomePanel();
        },
        toggleLoopHistory: (followUpId) => toggleSetMember(expandedHistoryIds, followUpId),
        toggleLoopBody: (followUpId) => toggleSetMember(expandedBodyIds, followUpId),
        forgetLoop: (followUpId) => {
          expandedHistoryIds.delete(String(followUpId || ''));
          expandedBodyIds.delete(String(followUpId || ''));
        },
      },
    }) || {};
    const {
      renderManualAddForm = noop,
      handleHomeClick = noopAsync,
      handleHomeSubmit = noopAsync,
      isLoopPendingDelete = () => false,
      syncOpenOverflowTrigger = noop,
      dispose: disposeActionHandlers = noop,
    } = actionHandlers;

    function getCompanionState() {
      const normalizedState = normalizeCompanionState(state.companion || {});
      state.companion = normalizedState;
      return normalizedState;
    }

    function applyCompanionPayload(payload) {
      state.companion = normalizeCompanionState(payload);
      return state.companion;
    }

    async function refreshCompanionState() {
      const payload = await windowRef.jennyShell.companion.getState();
      applyCompanionPayload(payload);
      return state.companion;
    }

    const { createLoopSummaryItem, syncBodyToggles } = openLoopRow.createOpenLoopRowRenderer({
      documentRef,
      isHistoryExpanded: (followUpId) => expandedHistoryIds.has(followUpId),
      isBodyExpanded: (followUpId) => expandedBodyIds.has(followUpId),
    });

    function createSkeletonNode(variant = 'row') {
      const node = documentRef.createElement('span');
      node.className = `skeleton skeleton--${variant}`;
      node.setAttribute('aria-hidden', 'true');
      return node;
    }

    function renderSkeletonStack(container, variants) {
      if (!container) {
        return;
      }
      container.textContent = '';
      const stack = documentRef.createElement('div');
      stack.className = 'skeleton-stack home-skeleton-stack';
      for (const variant of variants) {
        stack.append(createSkeletonNode(variant));
      }
      container.append(stack);
    }

    /* Empty lists stay empty — the section status line already carries the
     * empty-state copy, so a placeholder item would duplicate it. */
    function renderSummaryList(container, nodes) {
      if (!container) {
        return;
      }
      container.textContent = '';
      for (const node of nodes) {
        container.append(node);
      }
    }

    function setSectionHidden(section, hidden) {
      if (section) {
        section.hidden = hidden;
      }
    }

    function visibleLoops(loops) {
      return (Array.isArray(loops) ? loops : []).filter((loop) => !isLoopPendingDelete(loop.followUpId));
    }

    function renderHomeLoadingSkeletons() {
      renderSkeletonStack(homeOpenLoopList, ['row', 'row']);
    }

    function setPanelBusy(node, isBusy) {
      if (!node || typeof node.setAttribute !== 'function') {
        return;
      }
      if (isBusy) {
        node.setAttribute('aria-busy', 'true');
      } else {
        node.removeAttribute('aria-busy');
      }
    }

    /* The accessible name starts with the visible label (WCAG 2.5.3) and
     * names the section, since every subsection has a "Show" toggle. */
    function syncSectionToggle(toggle, expanded, { section, collapsedLabel, expandedLabel, collapsedTitle, expandedTitle }) {
      if (!toggle) {
        return;
      }
      const label = expanded ? expandedLabel : collapsedLabel;
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.textContent = label;
      toggle.title = expanded ? expandedTitle : collapsedTitle;
      const sectionName = String(section?.querySelector?.('h4')?.textContent || '').trim();
      toggle.setAttribute('aria-label', sectionName
        ? jt('companion.openLoops.sectionToggleLabel', '{action}: {section}', { action: label, section: sectionName })
        : label);
    }

    /* Subsections (Deferred / Recently Completed / Archived) share one render
     * path: hide when empty, count, status line, list. */
    const SUBSECTIONS = [
      {
        key: 'deferred',
        section: homeDeferredSection,
        count: homeDeferredLoopCount,
        status: homeDeferredLoopStatus,
        list: homeDeferredLoopList,
        statusText: (total) => (total
          ? jtn('companion.openLoops.deferredSummary', total, { count: total }, '{count} deferred. Returns here when due.', '{count} deferred. Returns here when due.')
          : jt('companion.openLoops.nothingDeferred', 'Nothing set aside.')),
        shown: (loops) => loops,
      },
      {
        key: 'recentResolved',
        section: homeRecentResolvedSection,
        count: homeRecentResolvedCount,
        status: homeRecentResolvedStatus,
        list: homeRecentResolvedList,
        /* The header count already says how many; the note only carries the
         * empty-state copy. */
        statusText: (total) => (total ? '' : jt('companion.openLoops.nothingClosed', 'Nothing closed yet.')),
        shown: (loops) => (resolvedSectionExpanded ? loops : loops.slice(0, RECENT_RESOLVED_PREVIEW_COUNT)),
        syncToggle: (loops) => {
          if (!homeRecentResolvedToggle) {
            return;
          }
          homeRecentResolvedToggle.hidden = loops.length <= RECENT_RESOLVED_PREVIEW_COUNT;
          syncSectionToggle(homeRecentResolvedToggle, resolvedSectionExpanded, {
            section: homeRecentResolvedSection,
            collapsedLabel: jt('companion.openLoops.showAll', 'Show all'),
            expandedLabel: jt('companion.openLoops.showLess', 'Show less'),
            collapsedTitle: jt('companion.openLoops.showAllResolvedTitle', 'Show all recently completed loops'),
            expandedTitle: jt('companion.openLoops.showFewerResolvedTitle', 'Show fewer recently completed loops'),
          });
        },
      },
      {
        key: 'archived',
        section: homeArchivedSection,
        count: homeArchivedLoopCount,
        status: homeArchivedLoopStatus,
        list: homeArchivedLoopList,
        statusText: (total, loops) => {
          if (!total) {
            return jt('companion.openLoops.nothingArchived', 'Nothing archived yet.');
          }
          /* The service caps the archived list; say so instead of implying
           * the list is complete. */
          return loops.length < total
            ? jt('companion.openLoops.archivedCapped', 'Showing the newest {shown} of {count} archived.', { shown: loops.length, count: total })
            : jtn('companion.openLoops.archivedCount', total, { count: total }, '{count} archived.', '{count} archived.');
        },
        shown: (loops) => (archivedSectionExpanded ? loops : []),
        syncToggle: () => {
          if (homeArchivedLoopList) {
            homeArchivedLoopList.hidden = !archivedSectionExpanded;
          }
          syncSectionToggle(homeArchivedLoopToggle, archivedSectionExpanded, {
            section: homeArchivedSection,
            collapsedLabel: jt('common.show', 'Show'),
            expandedLabel: jt('common.hide', 'Hide'),
            collapsedTitle: jt('companion.openLoops.showArchivedTitle', 'Show archived open loops'),
            expandedTitle: jt('companion.openLoops.hideArchivedTitle', 'Hide archived open loops'),
          });
        },
      },
    ];

    let lastHomePanelBusy = null;
    function applyHomePanelBusyState(isBusy) {
      const next = Boolean(isBusy);
      if (next === lastHomePanelBusy) {
        return;
      }
      lastHomePanelBusy = next;
      setPanelBusy(homeOpenLoopList, next);
      for (const subsection of SUBSECTIONS) {
        setPanelBusy(subsection.list, next);
      }
    }

    function focusKeyFor(element) {
      const { dataset = {} } = element;
      if (dataset.companionActionId) return `[data-companion-action-id="${cssAttrValue(dataset.companionActionId)}"]`;
      if (dataset.loopOverflow) return '[data-loop-overflow]';
      if (dataset.loopHistoryToggle) return '[data-loop-history-toggle]';
      if (dataset.loopBodyToggle) return '[data-loop-body-toggle]';
      return '';
    }

    /* Every render rebuilds the rows, which would drop keyboard focus to
     * <body>. Remember which row/control held it so it can come back. */
    function captureLoopFocus() {
      const active = documentRef?.activeElement;
      const item = active?.closest?.('.home-summary-item[data-follow-up-id]');
      const list = item?.parentElement;
      if (!item || !list || !homeView?.contains?.(item)) {
        return null;
      }
      return {
        followUpId: item.dataset.followUpId,
        control: focusKeyFor(active),
        list,
        index: Array.prototype.indexOf.call(list.children, item),
      };
    }

    /* Focus stays in the list it was in: a loop that moved sections (Done,
     * Archive) hands focus to the row now at its position, never to its new
     * row elsewhere on the page. */
    function restoreLoopFocus(snapshot) {
      if (!snapshot) {
        return;
      }
      const active = documentRef.activeElement;
      if (active && active !== documentRef.body && active.isConnected !== false) {
        return;
      }
      const sameRow = snapshot.list.querySelector?.(loopRowSelector(snapshot.followUpId)) || null;
      const target = (sameRow && snapshot.control && sameRow.querySelector(snapshot.control))
        || firstRowAction(sameRow)
        || firstRowAction(snapshot.list.children[Math.min(snapshot.index, snapshot.list.children.length - 1)])
        || homeOpenLoopAddButton;
      target?.focus?.({ preventScroll: true });
    }

    /* A row's first action button (the primary when it has one), else its
     * History or menu button. */
    function firstRowAction(row) {
      return row?.querySelector?.('.home-loop-actions [data-companion-action-id], .home-loop-actions button') || null;
    }

    /* The board is computed at fetch time, so a deferred loop would never
     * turn "Due now" while Home stays open. Refetch once the earliest
     * deferral lapses. */
    function clearDueRefresh() {
      if (dueRefreshTimer !== null) {
        clearTimeout(dueRefreshTimer);
        dueRefreshTimer = null;
      }
      dueRefreshAt = 0;
    }

    /* Renders are frequent (every toggle), so an unchanged deadline keeps its
     * running timer; re-arming would push the refresh out by the minimum
     * delay each time. */
    function scheduleDueRefresh(deferredLoops) {
      const nextDue = deferredLoops
        .map((loop) => openLoopRow.parseIsoDate(loop.deferredUntil)?.valueOf() || 0)
        .filter((at) => at > 0)
        .sort((left, right) => left - right)[0] || 0;
      if (dueRefreshTimer !== null && nextDue === dueRefreshAt) {
        return;
      }
      clearDueRefresh();
      if (!nextDue) {
        return;
      }
      const delay = Math.min(DUE_REFRESH_MAX_MS, Math.max(DUE_REFRESH_MIN_MS, nextDue - Date.now()));
      dueRefreshAt = nextDue;
      dueRefreshTimer = setTimeout(() => {
        dueRefreshTimer = null;
        dueRefreshAt = 0;
        if (state.ui?.activeView !== 'home') {
          return;
        }
        refreshCompanionState()
          .then(() => renderAll())
          .catch(() => {
            // Try again after the minimum delay rather than going quiet.
            if (dueRefreshTimer === null && state.ui?.activeView === 'home') {
              scheduleDueRefresh(visibleLoops(getCompanionState().openLoopsBoard?.deferred));
            }
          });
      }, delay);
    }

    /* Width, zoom and type-scale changes move the clamp; a list resize
     * re-measures its "Show more" toggles on the next frame (never inside
     * the observer callback, which would re-trigger it). */
    function observeListSizes() {
      const Observer = windowRef.ResizeObserver;
      if (listResizeObserver || typeof Observer !== 'function') {
        return;
      }
      const pending = new Set();
      let frame = 0;
      const flush = () => {
        frame = 0;
        for (const list of pending) {
          syncBodyToggles(list);
        }
        pending.clear();
      };
      listResizeObserver = new Observer((entries) => {
        for (const entry of entries) {
          pending.add(entry.target);
        }
        if (!frame) {
          frame = typeof windowRef.requestAnimationFrame === 'function'
            ? windowRef.requestAnimationFrame(flush)
            : setTimeout(flush, 0);
        }
      });
      for (const list of [homeOpenLoopList, ...SUBSECTIONS.map((subsection) => subsection.list)]) {
        if (list) {
          listResizeObserver.observe(list);
        }
      }
    }

    function renderHomePanel() {
      if (!homeView) {
        return;
      }
      if (state.ui?.activeView !== 'home') {
        clearDueRefresh();
        return;
      }
      const companionState = getCompanionState();
      applyHomePanelBusyState(!companionState.loaded);

      if (!companionState.loaded) {
        homeOpenLoopCount.textContent = '0';
        homeOpenLoopCount.hidden = true;
        homeOpenLoopStatus.textContent = jt('companion.openLoops.loading', 'Loading open loops...');
        for (const subsection of SUBSECTIONS) {
          setSectionHidden(subsection.section, true);
        }
        renderHomeLoadingSkeletons();
        renderManualAddForm(companionState);
        return;
      }

      const focusSnapshot = captureLoopFocus();
      const board = companionState.openLoopsBoard;
      const active = visibleLoops(board.active);
      const hiddenActive = board.active.length - active.length;
      const activeCount = Math.max(0, board.counts.active - hiddenActive);
      const dueCount = active.filter((loop) => loop.isDue).length;
      homeOpenLoopCount.textContent = String(activeCount);
      /* A "0" pill next to the heading is noise when the status line already
       * says all loops are closed. */
      homeOpenLoopCount.hidden = activeCount === 0;
      homeOpenLoopStatus.textContent = activeCount
        ? dueCount
          ? jtn('companion.openLoops.activeDueCount', activeCount, { activeCount, dueCount }, '{activeCount} active, {dueCount} due now.', '{activeCount} active, {dueCount} due now.')
          : jtn('companion.openLoops.activeCount', activeCount, { count: activeCount }, '{count} active.', '{count} active.')
        : jt('companion.openLoops.allClosed', 'All loops closed.');
      renderSummaryList(homeOpenLoopList, active.map((loop) => createLoopSummaryItem(loop, 'active')));
      syncBodyToggles(homeOpenLoopList);

      /* Empty subsections collapse entirely — when everything is closed the
       * board is just its header line instead of a tower of empty states. */
      for (const subsection of SUBSECTIONS) {
        const allLoops = Array.isArray(board[subsection.key]) ? board[subsection.key] : [];
        const loops = visibleLoops(allLoops);
        const total = Math.max(0, (board.counts[subsection.key] || 0) - (allLoops.length - loops.length));
        setSectionHidden(subsection.section, total === 0);
        if (subsection.count) {
          subsection.count.textContent = String(total);
        }
        if (subsection.status) {
          subsection.status.textContent = subsection.statusText(total, loops);
        }
        renderSummaryList(subsection.list, subsection.shown(loops).map((loop) => createLoopSummaryItem(loop, subsection.key)));
        syncBodyToggles(subsection.list);
        subsection.syncToggle?.(loops);
      }

      scheduleDueRefresh(visibleLoops(board.deferred));
      observeListSizes();
      renderManualAddForm(companionState);
      syncOpenOverflowTrigger();
      restoreLoopFocus(focusSnapshot);
    }

    function bind() {
      if (bound || !homeView) {
        return;
      }
      bound = true;
      homeView.addEventListener('click', handleHomeClick);
      homeView.addEventListener('submit', handleHomeSubmit);
    }

    function dispose() {
      clearDueRefresh();
      listResizeObserver?.disconnect?.();
      listResizeObserver = null;
      disposeActionHandlers();
      if (!bound || !homeView) {
        return;
      }
      bound = false;
      homeView.removeEventListener('click', handleHomeClick);
      homeView.removeEventListener('submit', handleHomeSubmit);
    }

    return {
      normalizeCompanionState,
      applyCompanionPayload,
      refreshCompanionState,
      renderHomePanel,
      bind,
      dispose,
    };
  }

  return { createCompanionManager };
});
