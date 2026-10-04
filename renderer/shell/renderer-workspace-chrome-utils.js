(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWorkspaceChromeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const motionPreferenceUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionPreferenceUtils)
    || (typeof require === 'function' ? require('../shared/renderer-motion-preference-utils') : null)
    || {};
  // UIUX-030: sole smooth-scroll gate — 'auto' (instant) under prefers-reduced-motion.
  const resolveScrollBehavior = typeof motionPreferenceUtils.resolveScrollBehavior === 'function'
    ? motionPreferenceUtils.resolveScrollBehavior
    : function fallbackResolveScrollBehavior() { return 'smooth'; };
  // Tab rename reuses the sidebar's inline title editor primitive.
  const inlineTitleEditorUtils = (typeof globalThis !== 'undefined' && globalThis.inventoryInlineTitleEditor)
    || (typeof require === 'function' ? require('../inventory/inline-title-editor') : null)
    || null;

  const { resolveDefaultTitle, selectLinkedRecallSessions } = (typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null);

  function normalizeId(value) { return String(value || '').trim(); }

  // The linked sessions recall reads (buildLinkedSessionContext's own rule).
  function resolveRecallSessionIds(activeSummary, linkedIds, sessionsById) {
    return new Set(selectLinkedRecallSessions(activeSummary, linkedIds, (id) => sessionsById.get(id))
      .map((entry) => normalizeId(entry.id)));
  }
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

  // "{title}. Status: {statuses}" for an accessible name. A title that already
  // ends in a sentence mark would read "words.. Status", so the mark goes.
  function withStatusSuffix(title, statuses) {
    const base = String(title || '');
    if (!statuses) return base;
    return base.replace(/[.!?…。！？]+$/u, '')
      + jt('shell.workspaceChrome.statusSuffix', '. Status: {statuses}', { statuses });
  }

  function sessionStatusLabel(state) {
    switch (state) {
      case 'plan_review': return jt('shell.workspaceChrome.planReview', 'Plan review');
      case 'approval': return jt('shell.workspaceChrome.approvalNeeded', 'Approval needed');
      case 'input_needed': return jt('shell.workspaceChrome.inputNeeded', 'Input needed');
      case 'streaming': return jt('shell.workspaceChrome.streaming', 'Streaming');
      case 'open': return jt('shell.workspaceChrome.open', 'Open');
      default: return '';
    }
  }

  function resolveSessionPresentation(sessionId, source = {}) {
    const id = normalizeId(sessionId);
    const openSet = toIdSet(source.openIds || source.openSessionIds || source.openSet);
    const streamingSet = toIdSet(source.streamingIds || source.streamingSessionIds || source.streamingSet);
    const approvalSet = toIdSet(source.approvalIds || source.approvalSessionIds || source.approvalSet);
    const isOpen = openSet.has(id);
    const isStreaming = streamingSet.has(id);
    const attention = source.attentionStates?.get?.(id);
    const isApproval = source.attentionStates
      ? attention === 'approval' || attention === 'plan_review'
      : approvalSet.has(id);
    const linkedCount = getLinkedCount(source.linkedCounts || source.linkedMap, id);
    const outcome = source.outcomeBySession instanceof Map
      ? source.outcomeBySession.get(id)
      : (
        source.outcomeBySession && typeof source.outcomeBySession === 'object' && Object.prototype.hasOwnProperty.call(source.outcomeBySession, id)
          ? source.outcomeBySession[id]
          : ''
      );
    const lastOutcome = outcome === 'failed' ? 'failed' : (outcome === 'completed' || outcome === 'cancelled' ? 'completed' : '');
    const waitingState = ['approval', 'plan_review', 'input_needed'].includes(attention) ? attention : '';
    const dominantState = waitingState || (isApproval ? 'approval' : (isStreaming ? 'streaming' : (isOpen ? 'open' : 'idle')));
    const statusLabel = sessionStatusLabel(dominantState);
    const badgeLabels = statusLabel ? [statusLabel] : [];
    if (linkedCount > 0) badgeLabels.push(jt('shell.workspaceChrome.linkedCount', 'Linked {count}', { count: linkedCount }));
    return {
      sessionId: id,
      isOpen,
      isStreaming,
      isApproval,
      linkedCount,
      lastOutcome,
      dominantState,
      statusLabel,
      railIndicatorLabel: dominantState === 'open' || dominantState === 'idle' ? '' : statusLabel,
      badgeLabels,
    };
  }

  var POPOVER_GAP = 8;
  var POPOVER_MARGIN = 16;

  var ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  var ICON_PLUS = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  var ICON_CHEVRON_LEFT = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_CHEVRON_RIGHT = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_SEARCH = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L13 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  function createWorkspaceChromeController(deps) {
    const containerEl = deps?.containerEl || null;
    const getSessionSummary = typeof deps?.getSessionSummary === 'function' ? deps.getSessionSummary : () => null;
    const isSessionBusy = typeof deps?.isSessionBusy === 'function' ? deps.isSessionBusy : () => false;
    let popoverEl = null;
    let popoverCleanup = [];
    let popoverOpener = null; // focus returns here when the popover closes around it
    let popoverRailAnchored = false;
    let contextMenuEl = null;
    let contextMenuCleanup = [];

    let railEl = null;
    let newTabBtn = null;
    let scrollLeftArrow = null;
    let scrollRightArrow = null;
    let railAbortController = null;
    let resizeObserver = null;
    let tabDragController = null;
    let paneDropTarget = null; // split view W2-1: the chat view's drop zones, once the pane composition exists
    let overflowFrame = 0;
    let revealedActiveId = '';
    const renameHandler = typeof deps?.onRenameSession === 'function' ? deps.onRenameSession : null;
    const tabRefs = new Map(); // sessionId -> { el, titleBtn, titleSpan, dot, closeBtn, statusLabel }
    const sidebarBadgeState = new WeakMap();

    function clearPopover() {
      while (popoverCleanup.length) {
        try { popoverCleanup.pop()(); } catch (_error) { /* best-effort cleanup */ }
      }
      const doc = popoverEl?.ownerDocument;
      const focusInside = Boolean(doc && popoverEl.contains(doc.activeElement));
      if (popoverEl) popoverEl.remove();
      popoverEl = null;
      const opener = popoverOpener;
      popoverOpener = null;
      if (focusInside && opener?.isConnected) opener.focus();
    }

    // The rail hides outside the chat view; a popover opened from a sidebar
    // row (the plugin view's row menu) stays with the row instead.
    function hideLinkedSessionPopover(options) {
      if (options?.keepRowAnchored === true && popoverEl && !popoverRailAnchored) return;
      clearPopover();
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
      // Split view W1-4c: "Open beside" leads when the composition wires it,
      // disabled for a session a pane already shows (one session, one pane).
      if (typeof deps?.onOpenBeside === 'function') {
        const inPane = typeof deps.isSessionInPane === 'function' && deps.isSessionInPane(sessionId) === true;
        addItem(jt('shell.workspaceChrome.openBeside', 'Open beside'), () => deps.onOpenBeside(sessionId), inPane).title = jt('chat.panes.toggleShortcutHint', 'Ctrl+Shift+\\ opens or closes the side-by-side pane');
        const splitSep = doc.createElement('div');
        splitSep.className = 'workspace-tab-context-menu-separator';
        splitSep.setAttribute('role', 'separator');
        contextMenuEl.appendChild(splitSep);
      }
      const canRename = typeof renameHandler === 'function' && Boolean(inlineTitleEditorUtils);
      const canLink = typeof deps?.onLinkSessionsRequested === 'function';
      if (canRename) addItem(jt('shell.workspaceChrome.renameTab', 'Rename…'), () => beginTabRename(sessionId));
      if (canLink) {
        const linkedCount = (getSessionSummary(sessionId)?.linked_session_ids || []).filter(Boolean).length;
        addItem(linkedCount > 0
          ? jt('shell.workspaceChrome.linkSessionsLinkedCount', 'Link sessions… · {count} linked', { count: linkedCount })
          : jt('shell.workspaceChrome.linkSessionsMenu', 'Link sessions…'), () => deps.onLinkSessionsRequested(sessionId, { x: anchorX, y: anchorY }));
      }
      if (canRename || canLink) {
        const editSep = doc.createElement('div');
        editSep.className = 'workspace-tab-context-menu-separator';
        editSep.setAttribute('role', 'separator');
        contextMenuEl.appendChild(editSep);
      }
      addItem(jt('shell.workspaceChrome.close', 'Close'), () => deps?.onSessionClosed?.(sessionId), busy);
      addItem(jt('shell.workspaceChrome.closeOthers', 'Close Others'), () => deps?.onCloseOtherSessions?.(sessionId));
      addItem(jt('shell.workspaceChrome.closeToRight', 'Close to the Right'), () => deps?.onCloseSessionsToRight?.(sessionId));
      const sep = doc.createElement('div');
      sep.className = 'workspace-tab-context-menu-separator';
      sep.setAttribute('role', 'separator');
      contextMenuEl.appendChild(sep);
      addItem(jt('shell.workspaceChrome.closeAll', 'Close All'), () => deps?.onCloseAllSessions?.());

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
      // Logical edges for the CSS fade: RTL scrollLeft runs negative.
      const offset = Math.abs(Number(railEl.scrollLeft) || 0);
      railEl.toggleAttribute('data-overflow-start', overflows && offset > 0);
      railEl.toggleAttribute('data-overflow-end', overflows && offset + railEl.clientWidth < railEl.scrollWidth - 1);
    }

    // Keep the active tab on screen when it changes (sidebar open, Ctrl+Tab,
    // "+"), without yanking a rail the user scrolled while it stayed put.
    function revealActiveTab(activeId) {
      if (!activeId || activeId === revealedActiveId) return;
      const el = tabRefs.get(activeId)?.el;
      if (!el || typeof el.scrollIntoView !== 'function') return;
      revealedActiveId = activeId;
      const view = el.ownerDocument?.defaultView || globalThis;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: resolveScrollBehavior(null, view) });
    }

    // A window resize can leave the revealed active tab clipped (the rail
    // shrank under it); bring it back without the once-per-activation guard.
    function keepActiveTabInView() {
      const el = revealedActiveId ? tabRefs.get(revealedActiveId)?.el : null;
      if (!railEl || !el || typeof el.scrollIntoView !== 'function') return;
      const rail = railEl.getBoundingClientRect();
      const tab = el.getBoundingClientRect();
      if (tab.left >= rail.left - 1 && tab.right <= rail.right + 1) return;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
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
      if (close) { e.stopPropagation(); Promise.resolve(deps?.onSessionClosed?.(close.dataset.workspaceClose)).catch(() => {}); }
    }

    function delegatedDoubleClickHandler(e) {
      const activate = e.target.closest('[data-workspace-activate]');
      if (activate && beginTabRename(activate.dataset.workspaceActivate)) e.preventDefault();
    }

    // Rename in place through the sidebar's inline title editor; the handler
    // persists through the same sessions path the sidebar rename uses.
    function beginTabRename(sessionId) {
      const refs = tabRefs.get(normalizeId(sessionId));
      if (!refs || typeof renameHandler !== 'function' || !inlineTitleEditorUtils) return false;
      const doc = refs.el.ownerDocument;
      const settleFocus = () => {
        if (!doc.activeElement || doc.activeElement === doc.body) refs.titleBtn.focus();
      };
      const editor = inlineTitleEditorUtils.startInlineTitleEdit({
        titleEl: refs.titleBtn,
        initialValue: refs.titleSpan.textContent,
        ariaLabel: jt('sidebar.sessionActions.renameChat', 'Rename chat'),
        onCommit: (value) => {
          settleFocus();
          Promise.resolve(renameHandler(normalizeId(sessionId), value))
            .catch((error) => deps?.onRenameFailed?.(error, jt('sidebar.sessionActions.renameFailed', 'Rename Failed')));
        },
        onCancel: settleFocus,
      });
      return Boolean(editor);
    }

    function createTab(doc, id, isActive) {
      const tab = doc.createElement('div');
      const titleBtn = doc.createElement('button');
      const dot = doc.createElement('span');
      const titleSpan = doc.createElement('span');

      tab.className = `workspace-rail-tab${isActive ? ' active' : ''}`;
      tab.dataset.sessionId = id;

      titleBtn.type = 'button';
      titleBtn.className = 'workspace-rail-tab-button';
      titleBtn.dataset.workspaceActivate = id;
      titleBtn.setAttribute('role', 'tab');

      // Tab anatomy: [state dot][title][×]. The state word lives in the
      // tooltip and the accessible name, never in the tab's width.
      dot.className = 'workspace-rail-state-dot';
      dot.setAttribute('aria-hidden', 'true');
      titleSpan.className = 'workspace-rail-title';

      titleBtn.append(dot, titleSpan);
      tab.appendChild(titleBtn);
      railEl.appendChild(tab);
      tabRefs.set(id, { el: tab, titleBtn, titleSpan, dot, closeBtn: null, statusLabel: '' });
    }

    // A busy tab has no × at all (the dot says why); it returns once idle.
    function syncCloseButton(id, refs, busy) {
      if (busy) {
        if (refs.closeBtn) { refs.closeBtn.remove(); refs.closeBtn = null; }
        return;
      }
      if (refs.closeBtn) return;
      const closeBtn = refs.el.ownerDocument.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'workspace-rail-close-button';
      closeBtn.dataset.workspaceClose = id;
      closeBtn.innerHTML = ICON_CLOSE;
      closeBtn.title = jt('shell.workspaceChrome.closeSession', 'Close session');
      refs.el.appendChild(closeBtn);
      refs.closeBtn = closeBtn;
    }

    function applyTabTitle(refs, title, statusLabel) {
      if (refs.titleSpan.textContent !== title) refs.titleSpan.textContent = title;
      refs.statusLabel = statusLabel;
      refs.titleBtn.title = statusLabel
        ? jt('shell.workspaceChrome.tabStatusTooltip', '{status} · {title}', { status: statusLabel, title })
        : title;
      refs.titleBtn.setAttribute('aria-label', withStatusSuffix(title, statusLabel));
    }

    function patchTab(id, summary, busy, isActive, streamingIds, approvalIds, attentionStates) {
      const refs = tabRefs.get(id);
      const presentation = resolveSessionPresentation(id, {
        openIds: [id],
        streamingIds,
        approvalIds,
        attentionStates,
      });
      refs.el.classList.toggle('active', isActive);
      refs.titleBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      refs.titleBtn.tabIndex = isActive ? 0 : -1;
      refs.el.dataset.sessionDominantState = presentation.dominantState;
      refs.dot.dataset.sessionDominantState = presentation.dominantState;
      applyTabTitle(refs, resolveDefaultTitle(summary?.title), presentation.railIndicatorLabel);
      syncCloseButton(id, refs, busy);
    }

    // A sessions render (auto-title, rename) reaches the rail through here.
    function syncTabTitles() {
      for (const [id, refs] of tabRefs) {
        const summary = getSessionSummary(id);
        if (!summary) continue;
        const title = resolveDefaultTitle(summary.title);
        if (title !== refs.titleSpan.textContent) applyTabTitle(refs, title, refs.statusLabel);
      }
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

    function renderRail(openSessionIds, activeSessionId, sessionSummaries, streamingSessionIds, approvalSessionIds, attentionStates) {
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
        scrollLeftArrow.title = jt('shell.workspaceChrome.scrollTabsLeft', 'Scroll tabs left');
        scrollLeftArrow.setAttribute('aria-label', jt('shell.workspaceChrome.scrollTabsLeft', 'Scroll tabs left'));
        scrollLeftArrow.hidden = true;
        scrollLeftArrow.addEventListener('click', () => railEl.scrollBy({ left: -200, behavior: resolveScrollBehavior(null, win) }), listenerOpts);
        containerEl.appendChild(scrollLeftArrow);

        railEl = doc.createElement('div');
        railEl.className = 'workspace-rail';
        railEl.setAttribute('role', 'tablist');
        railEl.setAttribute('aria-label', jt('shell.workspaceChrome.openSessions', 'Open sessions'));
        containerEl.appendChild(railEl);
        railEl.addEventListener('click', delegatedClickHandler, listenerOpts);
        railEl.addEventListener('dblclick', delegatedDoubleClickHandler, listenerOpts);
        railEl.addEventListener('keydown', delegatedKeydownHandler, listenerOpts);
        railEl.addEventListener('scroll', updateOverflowArrows, listenerOpts);
        railEl.addEventListener('auxclick', function (e) {
          if (e.button !== 1) return;
          const tab = e.target.closest('.workspace-rail-tab');
          if (!tab) return;
          if (e.target.closest('.workspace-rail-close-button, .inv-inline-title-editor')) return;
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
          resizeObserver = new ResizeObserverClass(() => {
            keepActiveTabInView();
            updateOverflowArrows();
          });
          resizeObserver.observe(railEl);
        }

        scrollRightArrow = doc.createElement('button');
        scrollRightArrow.type = 'button';
        scrollRightArrow.className = 'workspace-rail-scroll-arrow';
        scrollRightArrow.innerHTML = ICON_CHEVRON_RIGHT;
        scrollRightArrow.title = jt('shell.workspaceChrome.scrollTabsRight', 'Scroll tabs right');
        scrollRightArrow.setAttribute('aria-label', jt('shell.workspaceChrome.scrollTabsRight', 'Scroll tabs right'));
        scrollRightArrow.hidden = true;
        scrollRightArrow.addEventListener('click', () => railEl.scrollBy({ left: 200, behavior: resolveScrollBehavior(null, win) }), listenerOpts);
        containerEl.appendChild(scrollRightArrow);

        if (typeof deps?.onNewSessionRequested === 'function') {
          newTabBtn = doc.createElement('button');
          newTabBtn.type = 'button';
          newTabBtn.className = 'workspace-rail-new-button';
          newTabBtn.dataset.workspaceNew = '';
          newTabBtn.innerHTML = ICON_PLUS;
          newTabBtn.title = jt('shell.workspaceChrome.newChatShortcut', 'New chat (Ctrl+N)');
          newTabBtn.setAttribute('aria-label', jt('shell.workspaceChrome.newChat', 'New chat'));
          containerEl.appendChild(newTabBtn);
          newTabBtn.addEventListener('click', () => deps.onNewSessionRequested(), listenerOpts);
        }

        if (typeof deps?.onSessionReordered === 'function') {
          const tabDragUtils = (typeof globalThis !== 'undefined' ? globalThis : {}).rendererWorkspaceTabDragUtils;
          tabDragController = tabDragUtils?.createTabDragController?.({
            railEl, tabRefs,
            onDragStart() { clearPopover(); clearContextMenu(); },
            onReorder: deps.onSessionReordered,
            dropTarget: () => paneDropTarget,
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
        if (!tabRefs.has(id)) createTab(doc, id, isActive);
        patchTab(id, summary, busy, isActive, streamingIds, approvalIds, attentionStates);
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
      revealActiveTab(activeId);
    }

    function patchRailRuntime(activeSessionId, streamingSessionIds, approvalSessionIds, attentionStates) {
      const activeId = normalizeId(activeSessionId);
      const streamingIds = toIdSet(streamingSessionIds);
      const approvalIds = toIdSet(approvalSessionIds);
      for (const [id, refs] of tabRefs) {
        // The live summary, not the tab's own text: an auto-title that landed
        // mid-stream must reach the rail on the next runtime pass.
        patchTab(
          id,
          getSessionSummary(id) || { title: refs.titleSpan.textContent },
          isSessionBusy(id),
          id === activeId,
          streamingIds,
          approvalIds,
          attentionStates
        );
      }
      revealActiveTab(activeId);
      scheduleOverflowArrowUpdate();
    }

    function renderSidebarBadges(sessionElements, openIds, streamingIds, approvalIds, linkedCounts, attentionStates, outcomeBySession) {
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
          attentionStates,
          outcomeBySession,
        });
        const openTarget = element.querySelector('[data-session-open]') || element;
        const titleText = element.querySelector('.session-row__title-text')?.textContent
          || element.getAttribute('title')
          || titleRow.textContent;
        const rawTitle = resolveDefaultTitle(String(titleText || '').replace(/\s+/g, ' ').trim());
        const title = rawTitle.length <= 120 ? rawTitle : `${rawTitle.slice(0, 117).trim()}...`;
        const statusLabels = presentation.badgeLabels.slice();
        if (element.dataset.sessionPinned === 'true') statusLabels.push(jt('shell.workspaceChrome.pinned', 'Pinned'));
        const outboxLabel = element.querySelector('.send-outbox-badge')?.getAttribute('aria-label');
        if (outboxLabel) statusLabels.push(String(outboxLabel).slice(0, 80));
        const uniqueStatusLabels = [...new Set(statusLabels)];
        const labelledTitle = withStatusSuffix(title, uniqueStatusLabels.join(', '));
        const providerName = String(element.dataset.sessionProviderName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const sessionNoun = element.dataset.sessionType === 'plugin'
          ? jt('shell.workspaceChrome.pluginSessionType', '{provider} session', { provider: providerName || jt('shell.workspaceChrome.pluginFallback', 'plugin') }) : jt('shell.workspaceChrome.sessionType', 'session');
        const signature = JSON.stringify({
          dominantState: presentation.dominantState,
          lastOutcome: presentation.lastOutcome,
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
        if (presentation.lastOutcome) element.dataset.sessionLastOutcome = presentation.lastOutcome;
        else delete element.dataset.sessionLastOutcome;
        // "open" (a tab, nothing louder to say) rings the dot slot (chats-panel.css).
        element.dataset.sessionDominantState = presentation.dominantState;
        element.dataset.sessionLinkedCount = String(presentation.linkedCount);
        const dot = element.querySelector('.session-row__dot');
        if (dot) dot.setAttribute('title', presentation.statusLabel);
        openTarget.setAttribute('aria-label', jt('shell.workspaceChrome.openSessionLabel', 'Open {sessionNoun} {title}{statusSuffix}', { sessionNoun, title: labelledTitle, statusSuffix: '' }));
        sidebarBadgeState.set(element, { signature, titleRow });
      });
    }

    // `anchor` is an element or a { x, y } point (the tab menu's origin);
    // without one the popover opens at the session's tab.
    function showLinkedSessionPopover(activeSessionId, allSessions, currentLinks, onLinksChanged, anchor) {
      clearPopover();
      clearContextMenu();
      const activeId = normalizeId(activeSessionId);
      if (!activeId || !containerEl) return;
      const doc = containerEl.ownerDocument;
      const selected = new Set((Array.isArray(currentLinks) ? currentLinks : []).map(normalizeId).filter(Boolean));
      const allEntries = (Array.isArray(allSessions) ? allSessions : []).filter((entry) => normalizeId(entry?.id));
      const sessionsById = new Map(allEntries.map((entry) => [normalizeId(entry.id), entry]));
      const activeSummary = sessionsById.get(activeId) || getSessionSummary(activeId);
      const activeProject = String(activeSummary?.project_id ?? '');
      const others = allEntries.filter((entry) => normalizeId(entry.id) !== activeId);
      const isSameProject = (entry) => String(entry?.project_id ?? '') === activeProject;
      // Order is fixed at open so rows never jump under the pointer: linked
      // first, then same-project chats (only they can be recalled). Stable sort.
      const rank = (entry) => (selected.has(normalizeId(entry.id)) ? 0 : 2) + (isSameProject(entry) ? 0 : 1);
      const sessions = others.slice().sort((left, right) => rank(left) - rank(right));
      const anchorSource = anchor || tabRefs.get(activeId)?.el || containerEl;
      const anchorEl = anchorSource && typeof anchorSource.getBoundingClientRect === 'function' ? anchorSource : null;
      const anchorPoint = { left: Number(anchorSource?.x) || 0, top: Number(anchorSource?.y) || 0, bottom: Number(anchorSource?.y) || 0 };
      const anchorRect = anchorEl ? anchorEl.getBoundingClientRect() : anchorPoint;
      popoverRailAnchored = !anchorEl || containerEl.contains(anchorEl);
      popoverOpener = popoverRailAnchored ? (tabRefs.get(activeId)?.titleBtn || null) : anchorEl;
      const view = doc.defaultView || globalThis;
      const titleText = jt('shell.workspaceChrome.linkSessionsTitle', 'Link sessions');
      const make = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
      };
      popoverEl = doc.createElement('div');
      popoverEl.className = 'composer-popover workspace-linked-popover';
      popoverEl.setAttribute('role', 'dialog');
      popoverEl.setAttribute('aria-label', titleText);
      const header = make('div', 'workspace-linked-header');
      header.append(
        make('div', 'workspace-linked-title', titleText),
        make('div', 'workspace-linked-subtitle', jt('shell.workspaceChrome.linkSessionsSubtitle', 'Jenny recalls the 3 newest linked chats from this project.'))
      );
      const search = make('label', 'workspace-linked-search');
      search.innerHTML = ICON_SEARCH;
      const searchInput = make('input');
      searchInput.type = 'search';
      searchInput.placeholder = jt('shell.workspaceChrome.searchSessionsPlaceholder', 'Search sessions by title');
      searchInput.setAttribute('aria-label', searchInput.placeholder);
      search.appendChild(searchInput);
      const list = make('div', 'workspace-linked-list');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', titleText);
      const footer = make('div', 'workspace-linked-footer');
      popoverEl.append(header, search, list, footer);
      const formatTime = typeof globalThis.logViewUtils?.formatRelativeTime === 'function'
        ? globalThis.logViewUtils.formatRelativeTime
        : null;
      // First match wins; data-hint names the reason for tests and styling.
      const describeRow = (entry, id, recallIds) => {
        if (recallIds.has(id)) return ['recall', jt('shell.workspaceChrome.linkUsedForRecall', 'Used for recall')];
        if (!isSameProject(entry)) return ['other-project', jt('shell.workspaceChrome.linkOtherProject', 'Other project')];
        if (selected.has(id)) return ['not-recall', jt('shell.workspaceChrome.linkNotUsedForRecall', 'Not used for recall')];
        const when = formatTime && entry?.updated_at ? formatTime(entry.updated_at) : '';
        return when && when !== '--' ? ['time', when] : ['', ''];
      };
      const escapeId = (id) => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&'));
      const focusRow = (id) => list.querySelector(`input[data-linked-session-id="${escapeId(id)}"]`)?.focus();
      let visibleIds = [];
      let toggle = () => {};
      // rerender destroys and rebuilds every row (simplest correct re-filter),
      // which would otherwise drop keyboard focus off the just-toggled checkbox
      // on every change. focusId names the row whose checkbox should reclaim
      // focus once the rebuild lands (WIDE-056a).
      const renderList = (focusId) => {
        const query = normalizeId(searchInput.value).toLowerCase();
        const recallIds = resolveRecallSessionIds(activeSummary, selected, sessionsById);
        footer.textContent = jt('shell.workspaceChrome.linkSessionsFooter', 'Linked: {linked} · In recall: {recall}', { linked: selected.size, recall: recallIds.size });
        list.textContent = '';
        const matches = sessions.filter((entry) => resolveDefaultTitle(entry?.title).toLowerCase().includes(query));
        visibleIds = matches.map((entry) => normalizeId(entry.id));
        if (!matches.length) {
          list.appendChild(make('div', 'workspace-linked-empty', sessions.length
            ? jt('shell.workspaceChrome.linkSessionsNoMatch', 'No sessions match.')
            : jt('shell.workspaceChrome.linkSessionsNoOthers', 'No other sessions yet.')));
        }
        matches.forEach((entry) => {
          const id = normalizeId(entry.id);
          const title = resolveDefaultTitle(entry?.title);
          const row = make('label', 'workspace-linked-row');
          const checkbox = make('input');
          checkbox.type = 'checkbox';
          checkbox.dataset.linkedSessionId = id;
          checkbox.checked = selected.has(id);
          checkbox.addEventListener('change', () => toggle(id, checkbox.checked));
          const copy = make('span', 'workspace-linked-row-title', title);
          copy.title = title;
          row.append(checkbox, copy);
          const [hintKind, hintText] = describeRow(entry, id, recallIds);
          if (hintKind) {
            const hint = make('span', 'workspace-linked-row-hint', hintText);
            hint.dataset.hint = hintKind;
            row.appendChild(hint);
          }
          list.appendChild(row);
        });
        if (typeof focusId === 'string' && focusId) focusRow(focusId);
      };
      toggle = (id, checked) => {
        if (checked) selected.add(id); else selected.delete(id);
        renderList(id);
        Promise.resolve(onLinksChanged?.(Array.from(selected))).catch(() => {
          // Persistence failed: roll back the optimistic toggle and
          // reconcile the UI rather than leaving it stuck out of sync.
          if (checked) selected.delete(id); else selected.add(id);
          renderList(id);
        });
      };
      const handleInput = () => renderList();
      // Arrows walk search -> rows; Enter in search toggles a lone match.
      const handlePopoverKeydown = (event) => {
        if (event.isComposing || event.keyCode === 229) return; // IME owns Enter/arrows mid-composition
        const fromSearch = event.target === searchInput;
        const rowId = event.target?.dataset?.linkedSessionId || '';
        if (fromSearch && event.key === 'Enter') {
          event.preventDefault();
          if (visibleIds.length === 1) toggle(visibleIds[0], !selected.has(visibleIds[0]));
          return;
        }
        if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || (!fromSearch && !rowId)) return;
        event.preventDefault();
        const next = (fromSearch ? -1 : visibleIds.indexOf(rowId)) + (event.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) searchInput.focus();
        else if (next < visibleIds.length) focusRow(visibleIds[next]);
      };
      const handlePointerDown = (event) => {
        if (!popoverEl?.contains(event.target) && !anchorEl?.contains?.(event.target)) clearPopover();
      };
      const handleKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          clearPopover();
        }
      };
      searchInput.addEventListener('input', handleInput);
      popoverEl.addEventListener('keydown', handlePopoverKeydown);
      doc.addEventListener('mousedown', handlePointerDown, true);
      doc.addEventListener('keydown', handleKeydown, true);
      popoverCleanup = [
        () => searchInput.removeEventListener('input', handleInput),
        () => doc.removeEventListener('mousedown', handlePointerDown, true),
        () => doc.removeEventListener('keydown', handleKeydown, true),
      ];
      renderList();
      doc.body.appendChild(popoverEl);
      // Measure the filled popover: below the anchor when it fits, else above,
      // then clamp inside the viewport.
      const popRect = popoverEl.getBoundingClientRect();
      const below = anchorRect.bottom + POPOVER_GAP;
      const above = (Number(anchorRect.top) || 0) - POPOVER_GAP - popRect.height;
      const maxTop = view.innerHeight - popRect.height - POPOVER_MARGIN;
      const top = below <= maxTop || above < POPOVER_MARGIN ? below : above;
      popoverEl.style.top = `${Math.max(Math.min(top, maxTop), POPOVER_MARGIN)}px`;
      popoverEl.style.left = `${Math.max(Math.min(anchorRect.left, view.innerWidth - popRect.width - POPOVER_MARGIN), POPOVER_MARGIN)}px`;
      searchInput.focus();
    }

    return {
      renderRail,
      patchRailRuntime,
      syncTabTitles,
      renderSidebarBadges,
      showLinkedSessionPopover,
      hideLinkedSessionPopover,
      setPaneDropTarget(target) { paneDropTarget = target || null; },
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
        revealedActiveId = '';
        if (scrollLeftArrow) { scrollLeftArrow.remove(); scrollLeftArrow = null; }
        if (railEl) { railEl.remove(); railEl = null; }
        if (scrollRightArrow) { scrollRightArrow.remove(); scrollRightArrow = null; }
        if (newTabBtn) { newTabBtn.remove(); newTabBtn = null; }
        delete containerEl?.dataset?.tabCount;
      },
    };
  }

  return { createWorkspaceChromeController, resolveSessionPresentation, sessionStatusLabel, withStatusSuffix };
});
