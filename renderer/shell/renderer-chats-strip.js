/* renderer/shell/renderer-chats-strip.js – collapsed chats strip (nav overhaul W11)
   The 56px collapsed treatment of the chat sessions panel: an icon-only New Chat
   on top, then pinned + recent sessions as monogram chips (state-colored, capped)
   with a hover/focus quick-peek flyout built on the inventory popover primitive.
   Constructed and synced by renderer-top-nav-shell.js; it mounts only while the
   chats panel is collapsed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatsStrip = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Keep in lockstep with --view-panel-strip-width (styles/foundation.css).
  // renderer-top-nav-shell.js feeds this into the panel registry's collapsed
  // width so the JS width vars and the CSS grid column cannot drift.
  var STRIP_WIDTH = 56;
  var STRIP_MAX_CHIPS = 12;
  var STATE_LABELS = { open: 'Open', streaming: 'Streaming', approval: 'Approval' };

  function escapeHtmlText(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function createChatsStripController(deps) {
    const { state } = deps;
    const viewPanel = deps.dom?.viewPanel || null;
    const documentRef = deps.documentRef
      || viewPanel?.ownerDocument
      || (typeof document !== 'undefined' ? document : null);
    const rootRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const {
      getSessionMonogram,
      escapeHtml = escapeHtmlText,
      openSession,
      newChat,
      showMoreChats,
      expandPanel,
      appendClientLog,
    } = deps.callbacks || {};

    let stripEl = null;
    let chipsEl = null;
    let peekEl = null;
    let _chipsSignature = '';
    let _peekSessionId = '';
    let _peekInteraction = '';
    let _peekTrigger = null;
    let _closingPeekInternally = false;
    let disposed = false;
    const boundListeners = [];

    function addListener(target, type, handler, options) {
      if (!target) return;
      target.addEventListener(type, handler, options);
      boundListeners.push({ target, type, handler, options });
    }

    // The expanded controller owns calendar-aware relative time. Keep an
    // absent-safe fallback for isolated harnesses that load this module alone.
    function formatRelativeTime(value) {
      const sharedFormatter = rootRef.rendererChatsPanel?.formatSessionTime;
      if (typeof sharedFormatter === 'function') return sharedFormatter(value);
      const parsed = value ? new Date(value) : null;
      if (!parsed || Number.isNaN(parsed.valueOf())) return '';
      const now = new Date();
      const minutes = Math.floor(Math.max(now.valueOf() - parsed.valueOf(), 0) / 60000);
      if (minutes < 1) return 'now';
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h`;
      const parsedDay = Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      const days = Math.max(Math.floor((nowDay - parsedDay) / 86400000), 1);
      if (days < 7) return `${days}d`;
      const options = { month: 'short', day: 'numeric' };
      if (parsed.getFullYear() !== now.getFullYear()) options.year = 'numeric';
      return parsed.toLocaleDateString('en-US', options);
    }

    function formatModelLabel(session) {
      const deriveDisplayState = rootRef.rendererShellRuntimeUtils?.deriveCanonicalSessionDisplayState;
      const displayState = typeof deriveDisplayState === 'function'
        ? deriveDisplayState(state, session?.id)
        : null;
      const model = String(
        displayState?.model || session?.last_model_used || session?.preferred_model || 'pending'
      ).replace(/\s+/g, ' ').trim();
      return model.length <= 26 ? model : `${model.slice(0, 23).trim()}...`;
    }

    function formatMessageCount(session) {
      const deriveDisplayState = rootRef.rendererShellRuntimeUtils?.deriveCanonicalSessionDisplayState;
      const displayState = typeof deriveDisplayState === 'function'
        ? deriveDisplayState(state, session?.id)
        : null;
      const count = Math.max(Number(displayState?.messageCount ?? session?.message_count ?? 0), 0);
      return `${count} message${count === 1 ? '' : 's'}`;
    }

    // Pinned first (each bucket by recency), archived and pending-delete
    // sessions excluded, capped — the strip is a glanceable shortlist, not the
    // full panel.
    function listChipSessions() {
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const pendingDeletes = new Set(
        Array.isArray(state.ui?.pendingSessionDeletes) ? state.ui.pendingSessionDeletes : []
      );
      const byRecency = (left, right) => String(right?.updated_at || right?.created_at || '')
        .localeCompare(String(left?.updated_at || left?.created_at || ''));
      const live = sessions.filter(
        (session) => session?.id && !session.archived_at && !pendingDeletes.has(session.id)
      );
      const sorted = live.filter((session) => session.pinned === true).sort(byRecency)
        .concat(live.filter((session) => session.pinned !== true).sort(byRecency));
      return { items: sorted.slice(0, STRIP_MAX_CHIPS), total: sorted.length };
    }

    function runtimeSessionIds(methodName, fallback) {
      try {
        const values = rootRef.rendererMultiStreamController?.[methodName]?.();
        if (Array.isArray(values)) return values;
      } catch (_error) { /* degrade to the bounded state fallback */ }
      return fallback;
    }

    // The strip lists recent sessions independently of the expanded panel's
    // query/scope, so runtime state must not depend on mounted history rows.
    // Resolve only the bounded chip ids from canonical runtime collections.
    function chipStateById(sessionIds) {
      const map = new Map();
      const ids = Array.isArray(sessionIds) ? sessionIds : [];
      const openIds = Array.isArray(state.workspace?.openSessionIds) ? state.workspace.openSessionIds : [];
      const streamingIds = runtimeSessionIds(
        'getStreamingSessionIds',
        state.activeStreamSessionId ? [state.activeStreamSessionId] : []
      );
      const fallbackApprovalIds = [...(state.pendingToolApprovals?.values?.() || [])]
        .map((approval) => String(approval?.sessionId || '').trim())
        .filter(Boolean);
      const approvalIds = runtimeSessionIds('getApprovalPendingSessionIds', fallbackApprovalIds);
      const resolvePresentation = rootRef.rendererWorkspaceChromeUtils?.resolveSessionPresentation;
      const openSet = new Set(openIds.map((id) => String(id || '').trim()).filter(Boolean));
      const streamingSet = new Set(streamingIds.map((id) => String(id || '').trim()).filter(Boolean));
      const approvalSet = new Set(approvalIds.map((id) => String(id || '').trim()).filter(Boolean));
      ids.forEach((rawId) => {
        const id = String(rawId || '').trim();
        if (!id) return;
        if (typeof resolvePresentation === 'function') {
          map.set(id, resolvePresentation(id, {
            openIds: openSet,
            streamingIds: streamingSet,
            approvalIds: approvalSet,
          }).dominantState);
          return;
        }
        map.set(id, approvalSet.has(id) ? 'approval'
          : (streamingSet.has(id) ? 'streaming' : (openSet.has(id) ? 'open' : 'idle')));
      });
      return map;
    }

    function clearPeekState() {
      _peekTrigger?.removeAttribute?.('aria-describedby');
      if (peekEl?.id && chipsEl) {
        [...chipsEl.querySelectorAll('[aria-describedby]')].forEach((chip) => {
          if (chip.getAttribute('aria-describedby') === peekEl.id) {
            chip.removeAttribute('aria-describedby');
          }
        });
      }
      _peekTrigger = null;
      _peekSessionId = '';
      _peekInteraction = '';
    }

    function handlePeekToggle(event) {
      if (event.target !== peekEl || event.detail?.open !== false || _closingPeekInternally) return;
      clearPeekState();
    }

    function closePeek(options = {}) {
      const popover = rootRef.inventoryPopover;
      const trigger = _peekTrigger || peekEl?.__invPopoverTrigger;
      if (peekEl && popover?.isOpen?.(peekEl)) {
        _closingPeekInternally = true;
        try { popover.close(peekEl); }
        finally { _closingPeekInternally = false; }
      }
      if (options.clearSession !== false) {
        clearPeekState();
      } else {
        trigger?.removeAttribute?.('aria-describedby');
        _peekTrigger = null;
      }
    }

    function positionPeek(chip) {
      if (!peekEl || !chip || peekEl.hidden) return;
      const chipRect = chip.getBoundingClientRect?.();
      const peekRect = peekEl.getBoundingClientRect?.();
      if (!chipRect || !peekRect) return;
      const margin = 8;
      const left = Math.min(chipRect.right + margin, Math.max(margin, windowRefWidth() - peekRect.width - margin));
      const top = Math.max(margin, Math.min(chipRect.top, windowRefHeight() - peekRect.height - margin));
      peekEl.style.left = `${Math.round(left)}px`;
      peekEl.style.top = `${Math.round(top)}px`;
    }

    function windowRefWidth() {
      return Number(documentRef?.defaultView?.innerWidth) || 0;
    }

    function windowRefHeight() {
      return Number(documentRef?.defaultView?.innerHeight) || 0;
    }

    function repositionOpenPeek() {
      if (!_peekSessionId || !chipsEl) return;
      const chip = [...chipsEl.querySelectorAll('[data-strip-session-id]')]
        .find((entry) => entry.dataset.stripSessionId === _peekSessionId);
      if (chip) positionPeek(chip);
      else closePeek();
    }

    function refreshPeekState(chip) {
      if (!peekEl || !chip) return;
      const stateLabel = STATE_LABELS[chip.dataset.sessionDominantState]
        || (chip.classList.contains('chats-strip__chip--pinned') ? 'Pinned' : '');
      const stateRow = peekEl.querySelector('#chatsStripPeekState');
      stateRow.textContent = stateLabel;
      stateRow.hidden = !stateLabel;
    }

    function openPeekForChip(chip, interaction = 'pointer') {
      const popover = rootRef.inventoryPopover;
      if (!peekEl || typeof popover !== 'function') return;
      const sessionId = chip.dataset.stripSessionId;
      const session = (Array.isArray(state.sessions) ? state.sessions : [])
        .find((entry) => entry?.id === sessionId);
      if (!session) return;
      closePeek({ clearSession: false });
      peekEl.querySelector('#chatsStripPeekTitle').textContent = session.title || 'New Chat';
      peekEl.querySelector('#chatsStripPeekMeta').textContent = [
        formatRelativeTime(session.updated_at || session.created_at),
        formatModelLabel(session),
        formatMessageCount(session),
      ].filter(Boolean).join(' · ');
      refreshPeekState(chip);
      // Never steal focus on hover; the peek is informational.
      popover.open(peekEl, { trigger: chip, focus: false });
      chip.setAttribute('aria-describedby', peekEl.id);
      _peekTrigger = chip;
      _peekSessionId = sessionId;
      _peekInteraction = interaction;
      positionPeek(chip);
    }

    function findChip(event) {
      const chip = event.target?.closest?.('[data-strip-session-id]');
      return chip && chipsEl?.contains(chip) ? chip : null;
    }

    function handleChipClick(event) {
      const more = event.target?.closest?.('[data-strip-more]');
      if (more && chipsEl?.contains(more)) {
        closePeek();
        showMoreChats?.();
        appendClientLog?.('INFO', 'nav.chats_strip_more', {});
        return;
      }
      const chip = findChip(event);
      if (!chip) return;
      closePeek();
      openSession?.(chip.dataset.stripSessionId);
      appendClientLog?.('INFO', 'nav.chats_strip_open', { sessionId: chip.dataset.stripSessionId });
    }

    function handleChipPointerOver(event) {
      const chip = findChip(event);
      if (!chip) return;
      if (event.relatedTarget && chip.contains(event.relatedTarget)) return;
      openPeekForChip(chip, event.type === 'focusin' ? 'focus' : 'pointer');
    }

    function handleChipPointerOut(event) {
      const chip = findChip(event);
      if (!chip) return;
      const next = event.relatedTarget;
      if (next && chip.contains(next)) return;
      closePeek();
    }

    function handleNewChatClick() {
      closePeek();
      newChat?.();
      appendClientLog?.('INFO', 'nav.chats_strip_new_chat', {});
    }

    function handlePanelExpandClick() {
      closePeek();
      expandPanel?.();
      appendClientLog?.('INFO', 'nav.chats_strip_panel_expand', {});
    }

    function ensureDom() {
      if (disposed || stripEl || !viewPanel || !documentRef) return;
      const actionButton = rootRef.inventoryActionButton;
      const popover = rootRef.inventoryPopover;
      if (typeof actionButton !== 'function' || typeof popover !== 'function') return;
      stripEl = documentRef.createElement('div');
      stripEl.id = 'chatsStrip';
      stripEl.className = 'chats-strip';
      stripEl.hidden = true;
      stripEl.setAttribute('aria-label', 'Collapsed chats');
      // The expand toggle leads the strip (a fixed sibling of #chatsStripChips,
      // so chip re-renders never touch it); its collapse counterpart lives in
      // the expanded panel's header (renderer-top-nav-shell.js).
      stripEl.innerHTML = actionButton({
        id: 'chats-strip-panel-toggle',
        plain: true,
        className: 'icon-button chats-strip__panel-toggle',
        domId: 'chatsStripPanelToggle',
        ariaLabel: 'Expand chats panel',
        ariaControls: 'viewPanel',
        ariaExpanded: false,
        title: 'Expand chats panel (Ctrl+B)',
        trustedHtml: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M6 2.75v10.5" /></svg>',
      }) + actionButton({
        id: 'chats-strip-new-chat',
        plain: true,
        className: 'icon-button chats-strip__new-chat',
        domId: 'chatsStripNewChat',
        ariaLabel: 'New chat',
        title: 'New chat (Ctrl+N)',
        trustedHtml: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>',
      })
        + '<div class="chats-strip__chips" id="chatsStripChips"></div>';
      const peekHost = documentRef.createElement('div');
      peekHost.innerHTML = popover({
          id: 'chats-strip-peek',
          domId: 'chatsStripPeek',
          className: 'chats-strip__peek',
          ariaLabel: 'Chat preview',
          trustedHtml: '<div class="chats-strip__peek-title" id="chatsStripPeekTitle"></div>'
            + '<div class="chats-strip__peek-meta" id="chatsStripPeekMeta"></div>'
            + '<div class="chats-strip__peek-state" id="chatsStripPeekState" hidden></div>',
        });
      viewPanel.appendChild(stripEl);
      chipsEl = stripEl.querySelector('#chatsStripChips');
      peekEl = peekHost.firstElementChild;
      peekEl.setAttribute('role', 'tooltip');
      peekEl.removeAttribute('aria-modal');
      documentRef.body.appendChild(peekEl);
      addListener(peekEl, 'inv-popover-toggle', handlePeekToggle);
      addListener(stripEl.querySelector('#chatsStripPanelToggle'), 'click', handlePanelExpandClick);
      addListener(stripEl.querySelector('#chatsStripNewChat'), 'click', handleNewChatClick);
      addListener(chipsEl, 'click', handleChipClick);
      addListener(chipsEl, 'mouseover', handleChipPointerOver);
      addListener(chipsEl, 'mouseout', handleChipPointerOut);
      addListener(chipsEl, 'focusin', handleChipPointerOver);
      addListener(chipsEl, 'focusout', handleChipPointerOut);
      addListener(documentRef.defaultView, 'resize', repositionOpenPeek);
      addListener(documentRef.defaultView, 'scroll', repositionOpenPeek, true);
    }

    function renderChips() {
      const actionButton = rootRef.inventoryActionButton;
      if (disposed || !chipsEl || typeof actionButton !== 'function') return;
      const listed = listChipSessions();
      const items = listed.items;
      const stateById = chipStateById(items.map((session) => session.id));
      const isOfflineLockdownVisible = (session) => (
        state.features?.featureFlags?.session_offline_lockdown === true
        && session?.lockdown === true
      );
      const reduceMotion = documentRef?.defaultView
        ?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
      // afterRenderSessions fires on every sidebar refresh (including
      // signature-skipped ones); rebuild only when the visible chip facts
      // change so streaming frames cannot churn the strip or its open peek.
      const signature = JSON.stringify({
        total: listed.total,
        items: items.map((session) => ({
          id: session.id,
          title: session.title || '',
          pinned: session.pinned === true,
          active: session.id === state.currentSessionId,
          dominantState: stateById.get(session.id) || 'idle',
          timestamp: session.updated_at || session.created_at || '',
          model: formatModelLabel(session),
          messageCount: formatMessageCount(session),
          preview: session.last_message_preview || '',
          type: session.session_type || '',
          provider: session.plugin_session?.provider_name || '',
          icon: session.plugin_session?.icon_token || '',
          lockdown: isOfflineLockdownVisible(session),
        })),
      });
      if (signature === _chipsSignature) return;
      _chipsSignature = signature;
      const openPeekSessionId = _peekSessionId;
      const openPeekInteraction = _peekInteraction;
      const focusedChip = documentRef?.activeElement?.closest?.('[data-strip-session-id]');
      const focusedSessionId = focusedChip && chipsEl.contains(focusedChip)
        ? focusedChip.dataset.stripSessionId
        : '';
      closePeek({ clearSession: false });
      chipsEl.innerHTML = items.map((session) => {
        const title = session.title || 'New Chat';
        const isActive = session.id === state.currentSessionId;
        const isPluginSession = session.session_type === 'plugin';
        const usesPhotoIcon = isPluginSession && session.plugin_session?.icon_token === 'image';
        const lockdown = isOfflineLockdownVisible(session);
        const monogram = typeof getSessionMonogram === 'function'
          ? getSessionMonogram(title)
          : title.slice(0, 2).toUpperCase();
        const monogramHtml = usesPhotoIcon
          ? '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><circle cx="6" cy="7" r="1" /><path d="M13 10.5 10.25 7.75 5.5 12.5" /></svg>'
          : escapeHtml(monogram);
        const lockdownHtml = lockdown
          ? '<span class="session-offline-lockdown-badge chats-strip__lockdown-badge'
            + (reduceMotion ? '' : ' session-offline-lockdown-badge--fade')
            + '" title="Offline lockdown" aria-hidden="true">'
            + '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="7" rx="1.5"></rect><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"></path></svg>'
            + '</span>'
          : '';
        return actionButton({
          id: 'chats-strip-chip',
          plain: true,
          className: 'chats-strip__chip'
            + (isActive ? ' chats-strip__chip--active' : '')
            + (session.pinned === true ? ' chats-strip__chip--pinned' : ''),
          ariaLabel: `Open ${isPluginSession ? `${session.plugin_session?.provider_name || 'plugin'} session` : 'session'} ${title}`
            + (lockdown ? ', Offline lockdown' : ''),
          title: lockdown ? 'Offline lockdown' : `Open ${title}`,
          dataset: {
            'strip-session-id': session.id,
            'session-dominant-state': stateById.get(session.id) || 'idle',
            'session-lockdown': lockdown ? 'true' : 'false',
          },
          trustedHtml: `<span class="chats-strip__chip-monogram${usesPhotoIcon ? ' chats-strip__chip-monogram--provider-icon' : ''}" aria-hidden="true">${monogramHtml}</span>${lockdownHtml}`,
        });
      }).join('') + (listed.total > STRIP_MAX_CHIPS ? actionButton({
        id: 'chats-strip-more',
        plain: true,
        className: 'chats-strip__chip chats-strip__more',
        ariaLabel: `Show ${listed.total - STRIP_MAX_CHIPS} more chats`,
        title: 'Expand and search chats',
        dataset: { 'strip-more': 'true' },
        trustedHtml: `<span aria-hidden="true">+${listed.total - STRIP_MAX_CHIPS}</span>`,
      }) : '');
      chipsEl.querySelector('.chats-strip__chip--active')?.setAttribute('aria-current', 'true');
      const refreshedFocusedChip = focusedSessionId && [...chipsEl.querySelectorAll('[data-strip-session-id]')]
        .find((chip) => chip.dataset.stripSessionId === focusedSessionId);
      if (refreshedFocusedChip) {
        try { refreshedFocusedChip.focus({ preventScroll: true }); }
        catch (_error) { refreshedFocusedChip.focus(); }
      }
      const refreshedPeekChip = [...chipsEl.querySelectorAll('[data-strip-session-id]')]
        .find((chip) => chip.dataset.stripSessionId === openPeekSessionId);
      const shouldRestorePeek = refreshedPeekChip
        && (
          (openPeekInteraction === 'focus' && refreshedPeekChip === documentRef.activeElement)
          || (openPeekInteraction === 'pointer' && refreshedPeekChip.matches?.(':hover'))
        );
      if (shouldRestorePeek) {
        openPeekForChip(refreshedPeekChip, openPeekInteraction);
      } else {
        closePeek();
      }
    }

    // Single entry point: the flip controller computes visibility (flag on +
    // chat-sessions panel collapsed) and calls this on chrome changes and on
    // every afterRenderSessions pass.
    function sync({ visible } = {}) {
      if (disposed) return;
      if (visible !== true) {
        if (stripEl) {
          closePeek();
          stripEl.hidden = true;
        }
        return;
      }
      ensureDom();
      if (!stripEl) return;
      stripEl.hidden = false;
      renderChips();
    }

    // Streaming/status frames must not read, filter, or sort full history.
    // Resolve canonical state only for the mounted chips (at most 12).
    function patchRuntimeState() {
      if (disposed || !stripEl || stripEl.hidden || !chipsEl) return;
      const chips = [...chipsEl.querySelectorAll('[data-strip-session-id]')];
      const stateById = chipStateById(chips.map((chip) => chip.dataset.stripSessionId));
      chips.forEach((chip) => {
        chip.dataset.sessionDominantState = stateById.get(chip.dataset.stripSessionId) || 'idle';
      });
      const openChip = _peekSessionId && [...chipsEl.querySelectorAll('[data-strip-session-id]')]
        .find((chip) => chip.dataset.stripSessionId === _peekSessionId);
      if (openChip) refreshPeekState(openChip);
      repositionOpenPeek();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      closePeek();
      while (boundListeners.length) {
        const { target, type, handler, options } = boundListeners.pop();
        try { target.removeEventListener(type, handler, options); } catch (_err) { /* noop */ }
      }
      stripEl?.remove();
      peekEl?.remove();
      stripEl = null;
      chipsEl = null;
      peekEl = null;
      _chipsSignature = '';
      _peekSessionId = '';
      _peekInteraction = '';
      _peekTrigger = null;
      _closingPeekInternally = false;
    }

    return { sync, patchRuntimeState, dispose };
  }

  return { createChatsStripController, STRIP_WIDTH, STRIP_MAX_CHIPS };
});
