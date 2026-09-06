(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWorkspaceChromeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const motionPreferenceUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionPreferenceUtils)
    || (typeof require === 'function' ? require('../shared/renderer-motion-preference-utils') : null)
    || {};
  // UIUX-030: sole smooth-scroll gate — 'auto' (instant) under prefers-reduced-motion.
  const resolveScrollBehavior = typeof motionPreferenceUtils.resolveScrollBehavior === 'function'
    ? motionPreferenceUtils.resolveScrollBehavior
    : function fallbackResolveScrollBehavior() { return 'smooth'; };

  function normalizeId(value) { return String(value || '').trim(); }
  function toIdSet(values) {
    const source = values instanceof Set ? [...values] : (Array.isArray(values) ? values : []);
    return new Set(source.map(normalizeId).filter(Boolean));
  }

  function getLinkedCount(linkedCounts, sessionId) {
    const id = normalizeId(sessionId);
    if (!id) return 0;
    const value = linkedCounts instanceof Map
      ? linkedCounts.get(id)
      : (
        linkedCounts && typeof linkedCounts === 'object' && Object.prototype.hasOwnProperty.call(linkedCounts, id)
          ? linkedCounts[id]
          : 0
      );
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  function resolveSessionPresentation(sessionId, source = {}) {
    const id = normalizeId(sessionId);
    const openSet = toIdSet(source.openIds || source.openSessionIds || source.openSet);
    const streamingSet = toIdSet(source.streamingIds || source.streamingSessionIds || source.streamingSet);
    const approvalSet = toIdSet(source.approvalIds || source.approvalSessionIds || source.approvalSet);
    const isOpen = openSet.has(id);
    const isStreaming = streamingSet.has(id);
    const isApproval = approvalSet.has(id);
    const linkedCount = getLinkedCount(source.linkedCounts || source.linkedMap, id);
    const dominantState = isApproval ? 'approval' : (isStreaming ? 'streaming' : (isOpen ? 'open' : 'idle'));
    const badgeLabels = [];
    if (isOpen) badgeLabels.push('Open');
    if (isStreaming) badgeLabels.push('Streaming');
    if (isApproval) badgeLabels.push('Approval');
    if (linkedCount > 0) badgeLabels.push(`Linked ${linkedCount}`);
    return {
      sessionId: id,
      isOpen,
      isStreaming,
      isApproval,
      linkedCount,
      dominantState,
      railIndicatorLabel: isApproval ? 'Approval' : (isStreaming ? 'Streaming' : ''),
      badgeLabels,
    };
  }

  var POPOVER_GAP = 8;
  var POPOVER_MARGIN = 16;
  var POPOVER_LIST_MAX_HEIGHT = '240px';

  var ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  var ICON_LINK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.5 9.5a3.536 3.536 0 0 0 5 0l2-2a3.536 3.536 0 0 0-5-5L7.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M9.5 6.5a3.536 3.536 0 0 0-5 0l-2 2a3.536 3.536 0 0 0 5 5l1-1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  var ICON_PLUS = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  var ICON_CHEVRON_LEFT = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_CHEVRON_RIGHT = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function createWorkspaceChromeController(deps) {
    const containerEl = deps?.containerEl || null;
    const getSessionSummary = typeof deps?.getSessionSummary === 'function' ? deps.getSessionSummary : () => null;
    const isSessionBusy = typeof deps?.isSessionBusy === 'function' ? deps.isSessionBusy : () => false;
    let popoverEl = null;
    let popoverCleanup = [];
    let contextMenuEl = null;
    let contextMenuCleanup = [];

    let railEl = null;
    let newTabBtn = null;
    let scrollLeftArrow = null;
    let scrollRightArrow = null;
    let railAbortController = null;
    let resizeObserver = null;
    let tabDragController = null;
    let overflowFrame = 0;
    const tabRefs = new Map(); // sessionId -> { el, titleBtn, titleSpan, indicatorSpan, closeBtn, linkBtn }
    const sidebarBadgeState = new WeakMap();

    function clearPopover() {
      while (popoverCleanup.length) {
        try { popoverCleanup.pop()(); } catch (_error) { /* best-effort cleanup */ }
      }
      if (popoverEl) popoverEl.remove();
      popoverEl = null;
    }

    function clearContextMenu() {
      while (contextMenuCleanup.length) {
        try { contextMenuCleanup.pop()(); } catch (_error) { /* best-effort cleanup */ }
      }
      if (contextMenuEl) contextMenuEl.remove();
      contextMenuEl = null;
    }

    function showTabContextMenu(sessionId, anchorX, anchorY) {
      clearPopover();
      clearContextMenu();
      if (!containerEl) return;
      const doc = containerEl.ownerDocument;
      const view = doc.defaultView || globalThis;
      const busy = isSessionBusy(sessionId);
      contextMenuEl = doc.createElement('div');
      contextMenuEl.className = 'workspace-tab-context-menu';
      contextMenuEl.setAttribute('role', 'menu');

      function addItem(label, action, disabled) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'workspace-tab-context-menu-item';
        btn.setAttribute('role', 'menuitem');
        btn.textContent = label;
        btn.disabled = !!disabled;
        if (!disabled) btn.addEventListener('click', () => { clearContextMenu(); Promise.resolve(action()).catch(() => {}); });
        contextMenuEl.appendChild(btn);
        return btn;
      }
      addItem('Close', () => deps?.onSessionClosed?.(sessionId), busy);
      addItem('Close Others', () => deps?.onCloseOtherSessions?.(sessionId));
      addItem('Close to the Right', () => deps?.onCloseSessionsToRight?.(sessionId));
      const sep = doc.createElement('div');
      sep.className = 'workspace-tab-context-menu-separator';
      sep.setAttribute('role', 'separator');
      contextMenuEl.appendChild(sep);
      addItem('Close All', () => deps?.onCloseAllSessions?.());

      doc.body.appendChild(contextMenuEl);
      const menuRect = contextMenuEl.getBoundingClientRect();
      const left = Math.max(0, Math.min(anchorX, view.innerWidth - menuRect.width - 4));
      const top = Math.max(0, Math.min(anchorY, view.innerHeight - menuRect.height - 4));
      contextMenuEl.style.left = left + 'px';
      contextMenuEl.style.top = top + 'px';

      const items = [...contextMenuEl.querySelectorAll('.workspace-tab-context-menu-item:not(:disabled)')];
      if (items.length) items[0].focus();

      const handleMenuKeydown = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); clearContextMenu(); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const focused = doc.activeElement;
          const idx = items.indexOf(focused);
          const next = event.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
          items[next]?.focus();
        }
      };
      const handleOutsidePointerDown = (event) => {
        if (!contextMenuEl?.contains(event.target)) clearContextMenu();
      };
      doc.addEventListener('mousedown', handleOutsidePointerDown, true);
      doc.addEventListener('keydown', handleMenuKeydown, true);
      contextMenuCleanup = [
        () => doc.removeEventListener('mousedown', handleOutsidePointerDown, true),
        () => doc.removeEventListener('keydown', handleMenuKeydown, true),
      ];
    }

    function updateOverflowArrows() {
      if (!railEl || !scrollLeftArrow || !scrollRightArrow) return;
      const overflows = railEl.scrollWidth > railEl.clientWidth;
      scrollLeftArrow.hidden = !overflows || railEl.scrollLeft <= 0;
      scrollRightArrow.hidden = !overflows || railEl.scrollLeft + railEl.clientWidth >= railEl.scrollWidth - 1;
    }

    function scheduleOverflowArrowUpdate() {
      if (overflowFrame || !railEl) return;
      const view = railEl.ownerDocument?.defaultView || globalThis;
      const requestFrame = typeof view.requestAnimationFrame === 'function'
        ? view.requestAnimationFrame.bind(view)
        : (callback) => view.setTimeout(callback, 0);
      overflowFrame = requestFrame(() => {
        overflowFrame = 0;
        updateOverflowArrows();
      });
    }

    function delegatedKeydownHandler(e) {
      const currentBtn = e.target.closest('[data-workspace-activate]');
      if (!currentBtn) return;
      const tabs = [...railEl.querySelectorAll('[data-workspace-activate]')];
      if (!tabs.length) return;
      const currentIndex = tabs.indexOf(currentBtn);
      let nextIndex;
      if (e.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (e.key === 'Home') {
        nextIndex = 0;
      } else if (e.key === 'End') {
        nextIndex = tabs.length - 1;
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        Promise.resolve(deps?.onSessionActivated?.(currentBtn.dataset.workspaceActivate)).catch(() => {});
        return;
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const rect = currentBtn.getBoundingClientRect();
        showTabContextMenu(currentBtn.dataset.workspaceActivate, rect.left, rect.bottom);
        return;
      } else {
        return;
      }
      e.preventDefault();
      tabs[nextIndex]?.focus();
    }

    function delegatedClickHandler(e) {
      if (tabDragController?.shouldSuppressClick?.()) return;
      const activate = e.target.closest('[data-workspace-activate]');
      if (activate) { Promise.resolve(deps?.onSessionActivated?.(activate.dataset.workspaceActivate)).catch(() => {}); return; }
      const close = e.target.closest('[data-workspace-close]');
      if (close && !close.disabled) { e.stopPropagation(); Promise.resolve(deps?.onSessionClosed?.(close.dataset.workspaceClose)).catch(() => {}); return; }
      const link = e.target.closest('[data-workspace-links]');
      if (link) { Promise.resolve(deps?.onLinkSessionsRequested?.(link.dataset.workspaceLinks, link)).catch(() => {}); }
    }

    function createTab(doc, id, summary, busy, isActive) {
      const tab = doc.createElement('div');
      const titleBtn = doc.createElement('button');
      const indicatorSpan = doc.createElement('span');
      const titleSpan = doc.createElement('span');
      const closeBtn = doc.createElement('button');

      tab.className = `workspace-rail-tab${isActive ? ' active' : ''}`;
      tab.dataset.sessionId = id;

      titleBtn.type = 'button';
      titleBtn.className = 'workspace-rail-tab-button';
      titleBtn.dataset.workspaceActivate = id;
      titleBtn.title = String(summary?.title || 'New Chat');
      titleBtn.setAttribute('role', 'tab');

      indicatorSpan.className = 'workspace-rail-indicator';
      indicatorSpan.textContent = '';

      titleSpan.className = 'workspace-rail-title';
      titleSpan.textContent = String(summary?.title || 'New Chat');

      titleBtn.append(indicatorSpan, titleSpan);
      tab.appendChild(titleBtn);

      let linkBtn = null;
      if (typeof deps?.onLinkSessionsRequested === 'function') {
        linkBtn = doc.createElement('button');
        linkBtn.type = 'button';
        linkBtn.className = 'workspace-rail-link-button';
        linkBtn.dataset.workspaceLinks = id;
        linkBtn.innerHTML = ICON_LINK;
        linkBtn.title = 'Link sessions';
        linkBtn.hidden = !isActive;
        tab.appendChild(linkBtn);
      }

      closeBtn.type = 'button';
      closeBtn.className = 'workspace-rail-close-button';
      closeBtn.dataset.workspaceClose = id;
      closeBtn.innerHTML = ICON_CLOSE;
      closeBtn.disabled = busy;
      closeBtn.title = busy ? 'Cannot close a busy session.' : 'Close session';
      tab.appendChild(closeBtn);

      railEl.appendChild(tab);
      tabRefs.set(id, { el: tab, titleBtn, titleSpan, indicatorSpan, closeBtn, linkBtn });
    }

    function patchTab(id, summary, busy, isActive, streamingIds, approvalIds) {
      const refs = tabRefs.get(id);
      const presentation = resolveSessionPresentation(id, {
        openIds: [id],
        streamingIds,
        approvalIds,
      });
      refs.el.classList.toggle('active', isActive);
      refs.titleBtn.title = String(summary?.title || 'New Chat');
      refs.titleBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      refs.titleBtn.tabIndex = isActive ? 0 : -1;
      refs.titleSpan.textContent = String(summary?.title || 'New Chat');
      refs.indicatorSpan.textContent = presentation.railIndicatorLabel;
      refs.closeBtn.disabled = busy;
      refs.closeBtn.title = busy ? 'Cannot close a busy session.' : 'Close session';
      if (refs.linkBtn) refs.linkBtn.hidden = !isActive;
    }

    // The rail shell's own children (scroll arrows, the rail, the + button) are
    // built unconditionally on first render, so `.workspace-rail-shell:empty`
    // stops matching the moment the chat view paints and can never collapse the
    // band again. Publish the live tab count instead and let CSS hide the band
    // below two tabs -- one open session is already marked by the sidebar's
    // active row, so a lone tab chip is pure chrome.
    function publishTabCount() {
      if (!containerEl?.dataset) return;
      containerEl.dataset.tabCount = String(tabRefs.size);
    }

    function renderRail(openSessionIds, activeSessionId, sessionSummaries, streamingSessionIds, approvalSessionIds) {
      if (!containerEl) return;
      const doc = containerEl.ownerDocument;
      const summaryMap = new Map((Array.isArray(sessionSummaries) ? sessionSummaries : []).map((entry) => [normalizeId(entry?.id), entry]));
      const streamingIds = toIdSet(streamingSessionIds);
      const approvalIds = toIdSet(approvalSessionIds);
      const activeId = normalizeId(activeSessionId);

      if (!railEl) {
        const win = doc.defaultView || globalThis;
        railAbortController = typeof win.AbortController === 'function' ? new win.AbortController() : null;
        const sig = railAbortController?.signal;
        const listenerOpts = sig ? { signal: sig } : undefined;

        scrollLeftArrow = doc.createElement('button');
        scrollLeftArrow.type = 'button';
        scrollLeftArrow.className = 'workspace-rail-scroll-arrow';
        scrollLeftArrow.innerHTML = ICON_CHEVRON_LEFT;
        scrollLeftArrow.title = 'Scroll tabs left';
        scrollLeftArrow.setAttribute('aria-label', 'Scroll tabs left');
        scrollLeftArrow.hidden = true;
        scrollLeftArrow.addEventListener('click', () => railEl.scrollBy({ left: -200, behavior: resolveScrollBehavior(null, win) }), listenerOpts);
        containerEl.appendChild(scrollLeftArrow);

        railEl = doc.createElement('div');
        railEl.className = 'workspace-rail';
        railEl.setAttribute('role', 'tablist');
        railEl.setAttribute('aria-label', 'Open sessions');
        containerEl.appendChild(railEl);
        railEl.addEventListener('click', delegatedClickHandler, listenerOpts);
        railEl.addEventListener('keydown', delegatedKeydownHandler, listenerOpts);
        railEl.addEventListener('scroll', updateOverflowArrows, listenerOpts);
        railEl.addEventListener('auxclick', function (e) {
          if (e.button !== 1) return;
          const tab = e.target.closest('.workspace-rail-tab');
          if (!tab) return;
          if (e.target.closest('.workspace-rail-close-button, .workspace-rail-link-button')) return;
          e.preventDefault();
          const id = tab.dataset.sessionId;
          if (id && !isSessionBusy(id)) Promise.resolve(deps?.onSessionClosed?.(id)).catch(() => {});
        }, listenerOpts);
        railEl.addEventListener('contextmenu', function (e) {
          const tab = e.target.closest('.workspace-rail-tab');
          if (!tab) return;
          e.preventDefault();
          const id = tab.dataset.sessionId;
          if (id) showTabContextMenu(id, e.clientX, e.clientY);
        }, listenerOpts);

        const ResizeObserverClass = typeof win.ResizeObserver === 'function' ? win.ResizeObserver : null;
        if (ResizeObserverClass) {
          resizeObserver = new ResizeObserverClass(() => updateOverflowArrows());
          resizeObserver.observe(railEl);
        }

        scrollRightArrow = doc.createElement('button');
        scrollRightArrow.type = 'button';
        scrollRightArrow.className = 'workspace-rail-scroll-arrow';
        scrollRightArrow.innerHTML = ICON_CHEVRON_RIGHT;
        scrollRightArrow.title = 'Scroll tabs right';
        scrollRightArrow.setAttribute('aria-label', 'Scroll tabs right');
        scrollRightArrow.hidden = true;
        scrollRightArrow.addEventListener('click', () => railEl.scrollBy({ left: 200, behavior: resolveScrollBehavior(null, win) }), listenerOpts);
        containerEl.appendChild(scrollRightArrow);

        if (typeof deps?.onNewSessionRequested === 'function') {
          newTabBtn = doc.createElement('button');
          newTabBtn.type = 'button';
          newTabBtn.className = 'workspace-rail-new-button';
          newTabBtn.dataset.workspaceNew = '';
          newTabBtn.innerHTML = ICON_PLUS;
          newTabBtn.title = 'New chat (Ctrl+N)';
          newTabBtn.setAttribute('aria-label', 'New chat');
          containerEl.appendChild(newTabBtn);
          newTabBtn.addEventListener('click', () => deps.onNewSessionRequested(), listenerOpts);
        }

        if (typeof deps?.onSessionReordered === 'function') {
          const tabDragUtils = (typeof globalThis !== 'undefined' ? globalThis : {}).rendererWorkspaceTabDragUtils;
          tabDragController = tabDragUtils?.createTabDragController?.({
            railEl, tabRefs,
            onDragStart() { clearPopover(); clearContextMenu(); },
            onReorder: deps.onSessionReordered,
          }) || null;
        }
      }

      if (!Array.isArray(openSessionIds) || !openSessionIds.length) {
        for (const [id, refs] of tabRefs) { refs.el.remove(); tabRefs.delete(id); }
        publishTabCount();
        return;
      }

      const nextIds = new Set(openSessionIds.map(normalizeId).filter(Boolean));
      for (const [id, refs] of tabRefs) {
        if (!nextIds.has(id)) { refs.el.remove(); tabRefs.delete(id); }
      }

      for (const rawId of openSessionIds) {
        const id = normalizeId(rawId);
        if (!id) continue;
        const summary = summaryMap.get(id) || getSessionSummary(id) || {};
        const busy = isSessionBusy(id);
        const isActive = id === activeId;
        if (tabRefs.has(id)) {
          patchTab(id, summary, busy, isActive, streamingIds, approvalIds);
        } else {
          createTab(doc, id, summary, busy, isActive);
          patchTab(id, summary, busy, isActive, streamingIds, approvalIds);
        }
      }

      // Reorder: walk openSessionIds, insertBefore any out-of-position nodes
      let cursor = railEl.firstChild;
      for (const rawId of openSessionIds) {
        const id = normalizeId(rawId);
        const el = tabRefs.get(id)?.el;
        if (!el) continue;
        if (el !== cursor) {
          railEl.insertBefore(el, cursor);
        } else {
          cursor = el.nextSibling;
        }
      }

      publishTabCount();
      updateOverflowArrows();
    }

    function patchRailRuntime(activeSessionId, streamingSessionIds, approvalSessionIds) {
      const activeId = normalizeId(activeSessionId);
      const streamingIds = toIdSet(streamingSessionIds);
      const approvalIds = toIdSet(approvalSessionIds);
      for (const [id, refs] of tabRefs) {
        patchTab(
          id,
          { title: refs.titleSpan?.textContent || 'New Chat' },
          isSessionBusy(id),
          id === activeId,
          streamingIds,
          approvalIds
        );
      }
      scheduleOverflowArrowUpdate();
    }

    function renderSidebarBadges(sessionElements, openIds, streamingIds, approvalIds, linkedCounts) {
      const openSet = toIdSet(openIds);
      const streamingSet = toIdSet(streamingIds);
      const approvalSet = toIdSet(approvalIds);
      const linkedMap = linkedCounts instanceof Map ? linkedCounts : new Map(Object.entries(linkedCounts || {}));
      Array.from(sessionElements || []).forEach((element) => {
        const titleRow = element.querySelector('.conversation-title');
        if (!titleRow) return;
        const sessionId = normalizeId(element.dataset.sessionId);
        const presentation = resolveSessionPresentation(sessionId, {
          openIds: openSet,
          streamingIds: streamingSet,
          approvalIds: approvalSet,
          linkedCounts: linkedMap,
        });
        const openTarget = element.querySelector('[data-session-open]') || element;
        const titleText = element.querySelector('.session-row__title-text')?.textContent
          || element.getAttribute('title')
          || titleRow.textContent;
        const rawTitle = String(titleText || 'New Chat').replace(/\s+/g, ' ').trim() || 'New Chat';
        const title = rawTitle.length <= 120 ? rawTitle : `${rawTitle.slice(0, 117).trim()}...`;
        const statusLabels = presentation.badgeLabels.slice();
        if (element.dataset.sessionPinned === 'true') statusLabels.push('Pinned');
        const outboxLabel = element.querySelector('.send-outbox-badge')?.getAttribute('aria-label');
        if (outboxLabel) statusLabels.push(String(outboxLabel).slice(0, 80));
        const uniqueStatusLabels = [...new Set(statusLabels)];
        const statusSuffix = uniqueStatusLabels.length
          ? `. Status: ${uniqueStatusLabels.join(', ')}`
          : '';
        const providerName = String(element.dataset.sessionProviderName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const sessionNoun = element.dataset.sessionType === 'plugin'
          ? `${providerName || 'plugin'} session` : 'session';
        const signature = JSON.stringify({
          dominantState: presentation.dominantState,
          linkedCount: presentation.linkedCount,
          badges: presentation.badgeLabels,
          title,
          providerName,
          sessionNoun,
          status: uniqueStatusLabels,
        });
        const visibleBadges = titleRow.querySelectorAll('.conversation-state-badge');
        visibleBadges.forEach((node) => node.remove());
        const previous = sidebarBadgeState.get(element);
        if (previous?.signature === signature && previous?.titleRow === titleRow && !visibleBadges.length) return;
        element.dataset.sessionDominantState = presentation.dominantState;
        element.dataset.sessionLinkedCount = String(presentation.linkedCount);
        openTarget.setAttribute('aria-label', `Open ${sessionNoun} ${title}${statusSuffix}`);
        sidebarBadgeState.set(element, { signature, titleRow });
      });
    }

    function showLinkedSessionPopover(activeSessionId, allSessions, currentLinks, onLinksChanged) {
      clearPopover();
      clearContextMenu();
      const activeId = normalizeId(activeSessionId);
      if (!activeId || !containerEl) return;
      const doc = containerEl.ownerDocument;
      const selected = new Set((Array.isArray(currentLinks) ? currentLinks : []).map(normalizeId).filter(Boolean));
      const sessions = (Array.isArray(allSessions) ? allSessions : []).filter((entry) => normalizeId(entry?.id) && normalizeId(entry?.id) !== activeId);
      const anchor = containerEl.querySelector(`[data-workspace-links="${activeId}"]`) || containerEl;
      const view = doc.defaultView || globalThis;
      const countLabel = doc.createElement('div');
      const searchInput = doc.createElement('input');
      const list = doc.createElement('div');
      popoverEl = doc.createElement('div');
      popoverEl.className = 'composer-popover workspace-linked-popover';
      countLabel.className = 'composer-popover-copy';
      searchInput.className = 'approved-memory-input';
      searchInput.type = 'search';
      searchInput.placeholder = 'Search sessions by title';
      list.style.maxHeight = POPOVER_LIST_MAX_HEIGHT;
      list.style.overflow = 'auto';
      popoverEl.append(countLabel, searchInput, list);
      doc.body.appendChild(popoverEl);
      const anchorRect = anchor.getBoundingClientRect();
      const popRect = popoverEl.getBoundingClientRect();
      popoverEl.style.top = `${Math.min(anchorRect.bottom + POPOVER_GAP, view.innerHeight - popRect.height - POPOVER_MARGIN)}px`;
      popoverEl.style.left = `${Math.max(Math.min(anchorRect.left, view.innerWidth - popRect.width - POPOVER_MARGIN), POPOVER_MARGIN)}px`;
      // rerender destroys and rebuilds every row (simplest correct re-filter),
      // which would otherwise drop keyboard focus off the just-toggled checkbox
      // on every change. focusId names the row whose checkbox should reclaim
      // focus once the rebuild lands (WIDE-056a).
      const renderList = (focusId) => {
        const query = normalizeId(searchInput.value).toLowerCase();
        countLabel.textContent = `Linked sessions: ${selected.size}`;
        list.textContent = '';
        sessions.filter((entry) => String(entry?.title || 'New Chat').toLowerCase().includes(query)).forEach((entry) => {
          const id = normalizeId(entry.id);
          const row = doc.createElement('label');
          const checkbox = doc.createElement('input');
          const copy = doc.createElement('span');
          row.className = 'composer-popover-row workspace-linked-row';
          checkbox.type = 'checkbox';
          checkbox.dataset.linkedSessionId = id;
          checkbox.checked = selected.has(id);
          checkbox.addEventListener('change', () => {
            const wasChecked = !checkbox.checked;
            if (checkbox.checked) selected.add(id); else selected.delete(id);
            renderList(id);
            Promise.resolve(onLinksChanged?.(Array.from(selected))).catch(() => {
              // Persistence failed: roll back the optimistic toggle and
              // reconcile the UI rather than leaving it stuck out of sync.
              if (wasChecked) selected.add(id); else selected.delete(id);
              renderList(id);
            });
          });
          copy.textContent = String(entry?.title || 'New Chat');
          row.append(checkbox, copy);
          list.appendChild(row);
        });
        if (focusId) {
          list.querySelector(`input[data-linked-session-id="${focusId}"]`)?.focus();
        }
      };
      const handlePointerDown = (event) => {
        if (!popoverEl?.contains(event.target) && !anchor.contains(event.target)) clearPopover();
      };
      const handleKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          clearPopover();
        }
      };
      searchInput.addEventListener('input', renderList);
      doc.addEventListener('mousedown', handlePointerDown, true);
      doc.addEventListener('keydown', handleKeydown, true);
      popoverCleanup = [
        () => searchInput.removeEventListener('input', renderList),
        () => doc.removeEventListener('mousedown', handlePointerDown, true),
        () => doc.removeEventListener('keydown', handleKeydown, true),
      ];
      renderList();
      searchInput.focus();
    }

    return {
      renderRail,
      patchRailRuntime,
      renderSidebarBadges,
      showLinkedSessionPopover,
      hideLinkedSessionPopover: clearPopover,
      dispose() {
        clearPopover();
        clearContextMenu();
        if (overflowFrame) {
          const view = railEl?.ownerDocument?.defaultView || globalThis;
          if (typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(overflowFrame);
          else view.clearTimeout?.(overflowFrame);
          overflowFrame = 0;
        }
        if (tabDragController) { tabDragController.dispose(); tabDragController = null; }
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
        if (railAbortController) { railAbortController.abort(); railAbortController = null; }
        tabRefs.clear();
        if (scrollLeftArrow) { scrollLeftArrow.remove(); scrollLeftArrow = null; }
        if (railEl) { railEl.remove(); railEl = null; }
        if (scrollRightArrow) { scrollRightArrow.remove(); scrollRightArrow = null; }
        if (newTabBtn) { newTabBtn.remove(); newTabBtn = null; }
        delete containerEl?.dataset?.tabCount;
      },
    };
  }

  return { createWorkspaceChromeController, resolveSessionPresentation };
});
