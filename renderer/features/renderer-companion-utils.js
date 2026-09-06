(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCompanionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
  const stringUtils = typeof windowRef.stringUtils !== 'undefined'
    ? windowRef.stringUtils
    : typeof require === 'function'
      ? require('../shared/string-utils')
      : null;
  if (!stringUtils || typeof stringUtils.stripInlineMarkdownLabel !== 'function') {
    throw new Error('rendererCompanionUtils: renderer/shared/string-utils.js must load before this module');
  }
  const { stripInlineMarkdownLabel } = stringUtils;
  const {
    normalizeCompanionState = function fallbackNormalizeCompanionState(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    },
  } = companionStateUtils;

  function noop() {}
  function noopArray() { return []; }
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
    const {
      showToastMessage,
      showShellErrorToast,
      toErrorMessage,
      renderAll,
      renderComposerState,
      syncComposerInputHeight,
      setActiveView,
      openSettingsSection,
      activateWorkspaceSession,
      handleCreateSession,
      setSessionOrigin,
      setPendingOrigin,
      clearPendingOrigin,
      showSetupHelp = function noopShowSetupHelp() {},
    } = deps.callbacks;

    let bound = false;
    let archivedSectionExpanded = false;
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
        chatInput,
      },
      callbacks: {
        getCompanionState: () => getCompanionState(),
        applyCompanionPayload: (...args) => applyCompanionPayload(...args),
        renderHomePanel: () => renderHomePanel(),
        renderAll: (...args) => renderAll(...args),
        renderComposerState: (...args) => renderComposerState(...args),
        syncComposerInputHeight: (...args) => syncComposerInputHeight(...args),
        setActiveView: (...args) => setActiveView(...args),
        openSettingsSection: (...args) => openSettingsSection(...args),
        activateWorkspaceSession: (...args) => activateWorkspaceSession(...args),
        handleCreateSession: (...args) => handleCreateSession(...args),
        setSessionOrigin: (...args) => setSessionOrigin(...args),
        setPendingOrigin: (...args) => setPendingOrigin(...args),
        clearPendingOrigin: (...args) => clearPendingOrigin(...args),
        showSetupHelp: (...args) => showSetupHelp(...args),
        showToastMessage: (...args) => showToastMessage(...args),
        showShellErrorToast: (...args) => showShellErrorToast(...args),
        toErrorMessage: (...args) => toErrorMessage(...args),
        toggleArchivedSection: () => {
          archivedSectionExpanded = !archivedSectionExpanded;
          renderHomePanel();
        },
      },
    }) || {};
    const {
      getResolvableActions = noopArray,
      renderManualAddForm = noop,
      handleHomeClick = noopAsync,
      handleHomeSubmit = noopAsync,
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

    function createHomeSummaryItem() {
      const item = documentRef.createElement('article');
      item.className = 'home-summary-item';
      item.setAttribute('role', 'listitem');
      return item;
    }

    function createSummaryText(className, value) {
      const node = documentRef.createElement('div');
      node.className = className;
      node.textContent = value;
      return node;
    }

    /* Loop titles/bodies are captured from raw message text, and loops saved
     * before capture-time cleanup persist markdown markers — so display
     * cleanup has to happen here at render time, via the shared conservative
     * flattener that leaves identifiers like __init__.py intact.
     *
     * Save-from-message loops derive the title by clipping the body, so the
     * body line is pure repetition unless it extends past the title. */
    function isBodyRedundantWithTitle(title, body) {
      const strippedTitle = stripInlineMarkdownLabel(title).replace(/\.\.\.$/, '').trim();
      const strippedBody = stripInlineMarkdownLabel(body).trim();
      if (!strippedTitle || !strippedBody) {
        return false;
      }
      return strippedBody === strippedTitle;
    }

    function createActionButton(action, { primary = false } = {}) {
      const button = documentRef.createElement('button');
      button.className = `btn${primary ? ' btn--primary' : ''}`;
      button.type = 'button';
      button.dataset.companionActionId = action.id;
      button.textContent = action.label;
      return button;
    }

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

    function pluralize(count, singular, plural = `${singular}s`) {
      return `${count} ${count === 1 ? singular : plural}`;
    }

    function createMetadataBadge(text, modifier) {
      const badge = documentRef.createElement('span');
      badge.className = `home-loop-badge${modifier ? ` home-loop-badge--${modifier}` : ''}`;
      badge.textContent = text;
      return badge;
    }

    function createHistoryDisclosure(loop) {
      const entries = Array.isArray(loop.history) ? loop.history : [];
      if (!entries.length) {
        return null;
      }
      const details = documentRef.createElement('details');
      details.className = 'home-loop-history';
      const summary = documentRef.createElement('summary');
      summary.className = 'home-loop-history-toggle';
      summary.textContent = `History (${entries.length})`;
      details.append(summary);

      const list = documentRef.createElement('div');
      list.className = 'home-loop-history-list';
      entries.forEach((entry) => {
        const row = documentRef.createElement('div');
        row.className = 'home-loop-history-item';
        const when = new Date(entry.at);
        const label = Number.isNaN(when.valueOf())
          ? entry.at
          : when.toLocaleString();
        const kind = documentRef.createElement('div');
        kind.className = 'home-summary-label';
        kind.textContent = `${entry.kind} / ${label}`;
        row.append(kind);
        if (entry.detail) {
          row.append(createSummaryText('home-summary-meta', entry.detail));
        }
        list.append(row);
      });
      details.append(list);
      return details;
    }

    function renderLoopMetadata(loop) {
      const badges = [
        loop.sessionBadge ? createMetadataBadge(loop.sessionBadge, 'session') : null,
        loop.sourceBadge ? createMetadataBadge(loop.sourceBadge, 'source') : null,
      ].filter(Boolean);
      const hasContextLine = Boolean(loop.contextLine);
      if (!badges.length && !hasContextLine) {
        return null;
      }
      const wrapper = documentRef.createElement('div');
      wrapper.className = 'home-loop-meta-block';
      if (badges.length) {
        const badgeRow = documentRef.createElement('div');
        badgeRow.className = 'home-loop-badge-row';
        badges.forEach((badge) => badgeRow.append(badge));
        wrapper.append(badgeRow);
      }
      if (hasContextLine) {
        wrapper.append(createSummaryText('home-summary-meta', loop.contextLine));
      }
      return wrapper;
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

    function formatDeferredTiming(loop) {
      if (loop.timingLabel) {
        return loop.timingLabel;
      }
      const parsed = new Date(loop.deferredUntil);
      if (Number.isNaN(parsed.valueOf())) {
        return '';
      }
      /* Mirrors companion-service's short deferred format. */
      const time = parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return `Deferred until ${parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
    }

    function renderOpenLoopActionRow(loop) {
      const actions = Array.isArray(loop.actions) ? loop.actions : [];
      if (!actions.length) {
        return null;
      }
      const actionRow = documentRef.createElement('div');
      actionRow.className = 'home-action-row';
      const hasResumeAction = actions.some((action) => action?.type === 'continue_session');
      actions.forEach((action, index) => {
        const isPrimary = action.type === 'continue_session'
          || (!hasResumeAction && action.type === 'resolve_follow_up')
          || (!hasResumeAction && action.type === 'activate_follow_up')
          || (!hasResumeAction && action.type === 'unarchive_follow_up')
          || (index === 0 && action.type === 'prefill_chat');
        actionRow.append(createActionButton(action, { primary: isPrimary }));
      });
      return actionRow;
    }

    function createLoopSummaryItem(loop) {
      const item = createHomeSummaryItem();
      if (loop.followUpId) {
        item.dataset.followUpId = String(loop.followUpId);
      }
      item.dataset.loopStatus = loop.status;
      item.dataset.loopDue = loop.isDue ? 'true' : 'false';
      const kickerParts = ['open loop'];
      if (loop.isDue) {
        kickerParts.push('due now');
      } else if (loop.status === 'archived') {
        kickerParts.push('archived');
      } else if (loop.status === 'deferred') {
        kickerParts.push('deferred');
      } else if (loop.status === 'resolved') {
        kickerParts.push('completed');
      }
      item.append(createSummaryText('home-summary-label', kickerParts.join(' / ')));
      item.append(createSummaryText('home-summary-value', stripInlineMarkdownLabel(loop.title)));
      const metadata = renderLoopMetadata(loop);
      if (metadata) {
        item.append(metadata);
      }
      const timingLabel = loop.status === 'deferred' ? formatDeferredTiming(loop) : loop.timingLabel;
      if (timingLabel) {
        item.append(createSummaryText('home-summary-meta', timingLabel));
      }
      if (loop.body && !isBodyRedundantWithTitle(loop.title, loop.body)) {
        item.append(createSummaryText('home-card-note', stripInlineMarkdownLabel(loop.body)));
      }
      const historyDisclosure = createHistoryDisclosure(loop);
      if (historyDisclosure) {
        item.append(historyDisclosure);
      }
      const actionRow = renderOpenLoopActionRow(loop);
      if (actionRow) {
        item.append(actionRow);
      }
      return item;
    }

    function renderOpenLoopList(companionState) {
      const loopNodes = companionState.openLoopsBoard.active.map((loop, index) => {
        const node = createLoopSummaryItem(loop);
        node.classList.add('memory-commitment-item');
        if (index === 0) {
          node.classList.add('memory-commitment-item--first');
        }
        return node;
      });
      renderSummaryList(homeOpenLoopList, loopNodes);
    }

    function renderDeferredLoopList(companionState) {
      const deferredNodes = companionState.openLoopsBoard.deferred.map((loop) => createLoopSummaryItem(loop));
      renderSummaryList(homeDeferredLoopList, deferredNodes);
    }

    function renderRecentResolvedLoopList(companionState) {
      if (!homeRecentResolvedList) {
        return;
      }
      const resolvedNodes = companionState.openLoopsBoard.recentResolved.map((loop) => createLoopSummaryItem(loop));
      renderSummaryList(homeRecentResolvedList, resolvedNodes);
    }

    function renderArchivedLoopList(companionState) {
      if (!homeArchivedLoopList) {
        return;
      }
      const archivedNodes = archivedSectionExpanded
        ? companionState.openLoopsBoard.archived.map((loop) => createLoopSummaryItem(loop))
        : [];
      renderSummaryList(homeArchivedLoopList, archivedNodes);
      if (homeArchivedLoopList) {
        homeArchivedLoopList.hidden = !archivedSectionExpanded;
      }
      if (homeArchivedLoopToggle) {
        homeArchivedLoopToggle.setAttribute('aria-expanded', archivedSectionExpanded ? 'true' : 'false');
        homeArchivedLoopToggle.textContent = archivedSectionExpanded ? 'Hide' : 'Show';
        homeArchivedLoopToggle.title = archivedSectionExpanded ? 'Hide archived open loops' : 'Show archived open loops';
      }
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

    let lastHomePanelBusy = null;
    function applyHomePanelBusyState(isBusy) {
      const next = Boolean(isBusy);
      if (next === lastHomePanelBusy) {
        return;
      }
      lastHomePanelBusy = next;
      setPanelBusy(homeOpenLoopList, next);
      setPanelBusy(homeDeferredLoopList, next);
      setPanelBusy(homeRecentResolvedList, next);
      setPanelBusy(homeArchivedLoopList, next);
    }

    function renderHomePanel() {
      if (!homeView) {
        return;
      }
      if (state.ui?.activeView !== 'home') {
        return;
      }
      const companionState = getCompanionState();
      applyHomePanelBusyState(!companionState.loaded);

      if (!companionState.loaded) {
        homeOpenLoopCount.textContent = '0';
        homeOpenLoopCount.hidden = true;
        homeOpenLoopStatus.textContent = 'Loading open loops...';
        setSectionHidden(homeDeferredSection, true);
        setSectionHidden(homeRecentResolvedSection, true);
        setSectionHidden(homeArchivedSection, true);
        renderHomeLoadingSkeletons();
        renderManualAddForm(companionState);
        return;
      }

      const activeCount = companionState.openLoopsBoard.counts.active;
      const deferredCount = companionState.openLoopsBoard.counts.deferred;
      const recentResolvedCount = companionState.openLoopsBoard.counts.recentResolved;
      const dueCount = companionState.openLoopsBoard.active.filter((loop) => loop.isDue).length;
      homeOpenLoopCount.textContent = String(activeCount);
      /* A "0" pill next to the heading is noise when the status line already
       * says all loops are closed. */
      homeOpenLoopCount.hidden = activeCount === 0;
      homeOpenLoopStatus.textContent = activeCount
        ? dueCount
          ? `${pluralize(activeCount, 'active')}, ${pluralize(dueCount, 'due now', 'due now')}.`
          : `${pluralize(activeCount, 'active')}.`
        : 'All loops closed.';
      renderOpenLoopList(companionState);

      /* Empty subsections collapse entirely — when everything is closed the
       * board is just its header line instead of a tower of empty states. */
      setSectionHidden(homeDeferredSection, deferredCount === 0);
      if (homeDeferredLoopCount) {
        homeDeferredLoopCount.textContent = String(deferredCount);
      }
      if (homeDeferredLoopStatus) {
        homeDeferredLoopStatus.textContent = deferredCount
          ? `${pluralize(deferredCount, 'deferred')}. Returns here when due.`
          : 'Nothing set aside.';
      }
      renderDeferredLoopList(companionState);

      setSectionHidden(homeRecentResolvedSection, recentResolvedCount === 0);
      if (homeRecentResolvedCount) {
        homeRecentResolvedCount.textContent = String(recentResolvedCount);
      }
      if (homeRecentResolvedStatus) {
        /* The subsection header's count badge already says how many are shown;
         * a sentence restating it is noise, so the note only carries the
         * empty-state copy. */
        homeRecentResolvedStatus.textContent = recentResolvedCount
          ? ''
          : 'Nothing closed yet.';
      }
      renderRecentResolvedLoopList(companionState);

      const archivedCount = companionState.openLoopsBoard.counts.archived || 0;
      setSectionHidden(homeArchivedSection, archivedCount === 0);
      if (homeArchivedLoopCount) {
        homeArchivedLoopCount.textContent = String(archivedCount);
      }
      if (homeArchivedLoopStatus) {
        homeArchivedLoopStatus.textContent = archivedCount
          ? `${pluralize(archivedCount, 'archived')}.`
          : 'Nothing archived yet.';
      }
      renderArchivedLoopList(companionState);

      renderManualAddForm(companionState);
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
