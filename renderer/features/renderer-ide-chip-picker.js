/* renderer/features/renderer-ide-chip-picker.js
 *
 * Inventory-backed pickers used by the IDE: quick-picks behind the interactive
 * statusbar chips, plus the Workspace Chat Dock's session switcher.
 *
 * The popover is appended to the IDE shell (NOT the cursor-driven statusbar
 * markup, which re-renders on every cursor move and would otherwise destroy an
 * open popover). Buttons render through the inventory action-button. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeChipPicker = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const TAB_SIZES = [2, 4, 8];
  const EOL_OPTIONS = [['lf', 'LF'], ['crlf', 'CRLF']];
  const RECENT_SESSION_LIMIT = 12;
  const SEARCH_RESULT_LIMIT = 50;
  const CHEVRON_DOWN_GLYPH = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6-6"></path></svg>';

  function resolveInventoryPrimitive(globalName, requirePath) {
    if (typeof globalRef[globalName] === 'function') {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function sessionTitle(session) {
    return String(session?.title || '').trim() || 'New Chat';
  }

  function defaultEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createIdeChipPicker(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const editorHost = options.editorHost || null;
    const getActivePath = typeof options.getActivePath === 'function' ? options.getActivePath : () => '';
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : defaultEscape;
    const actionButton = typeof options.actionButton === 'function' ? options.actionButton : null;
    const popover = typeof options.popover === 'function' ? options.popover : null;
    const onAfterChange = typeof options.onAfterChange === 'function' ? options.onAfterChange : noop;

    let sessionTabSize = null; // null -> follow the file/editor default
    let sessionEol = null;
    let host = null;
    let bound = false;

    function ensureHost() {
      const shell = getDom().ideShell || null;
      if (!shell || !popover || typeof shell.appendChild !== 'function') {
        return null;
      }
      if (host && shell.contains(host)) {
        return host;
      }
      const docRef = shell.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!docRef) {
        return null;
      }
      const wrap = docRef.createElement('div');
      wrap.innerHTML = popover({ id: 'ideChipPicker', className: 'ide-chip-popover', ariaLabel: 'Editor setting' });
      host = wrap.firstChild;
      // The popover hosts single-select menuitemradio options, so it is a menu
      // (the popover primitive defaults to role="dialog"; its logic keys on the
      // .inv-popover class + hidden, not role, so this override is safe).
      if (host && typeof host.setAttribute === 'function') {
        host.setAttribute('role', 'menu');
      }
      shell.appendChild(host);
      if (typeof host.addEventListener === 'function') {
        host.addEventListener('click', handleHostClick);
      }
      return host;
    }

    function position(anchor) {
      const shell = getDom().ideShell || null;
      if (!host || !shell || typeof anchor?.getBoundingClientRect !== 'function') {
        return;
      }
      const a = anchor.getBoundingClientRect();
      const s = shell.getBoundingClientRect();
      host.style.left = `${Math.max(4, a.left - s.left)}px`;
      host.style.bottom = `${Math.max(0, s.bottom - a.top + 4)}px`;
    }

    function buildMenu(kind) {
      if (!actionButton) {
        return '';
      }
      if (kind === 'tab-size') {
        const current = Number(editorHost?.getTabSize?.()) || sessionTabSize || 2;
        // Single-select group -> menuitemradio; aria-checked is set imperatively
        // after render (openPicker) since the action-button primitive does not
        // emit aria-checked.
        return TAB_SIZES.map((size) => actionButton({
          plain: true,
          className: `ide-chip-option${size === current ? ' ide-chip-option--active' : ''}`,
          role: 'menuitemradio',
          trustedHtml: escapeHtml(`Spaces: ${size}`),
          dataset: { 'ide-chip-kind': 'tab-size', 'ide-chip-value': String(size) },
        })).join('');
      }
      const currentEol = editorHost?.getEol?.(getActivePath()) === 'crlf' ? 'crlf' : 'lf';
      return EOL_OPTIONS.map(([value, label]) => actionButton({
        plain: true,
        className: `ide-chip-option${value === currentEol ? ' ide-chip-option--active' : ''}`,
        role: 'menuitemradio',
        trustedHtml: escapeHtml(label),
        dataset: { 'ide-chip-kind': 'eol', 'ide-chip-value': value },
      })).join('');
    }

    function openPicker(kind, anchor) {
      const popEl = ensureHost();
      if (!popEl) {
        return;
      }
      // Re-clicking the same chip toggles the popover closed; restoreFocus
      // returns focus to the chip instead of stranding it.
      if (popover.isOpen(popEl) && popEl.__chipKind === kind) {
        popover.close(popEl, { restoreFocus: true });
        return;
      }
      popEl.__chipKind = kind;
      popEl.innerHTML = buildMenu(kind);
      // aria-checked tracks the active option (the primitive can't emit it).
      popEl.querySelectorAll('[data-ide-chip-value]').forEach((btn) => {
        btn.setAttribute(
          'aria-checked',
          btn.classList.contains('ide-chip-option--active') ? 'true' : 'false'
        );
      });
      position(anchor);
      popover.open(popEl, { trigger: anchor });
    }

    function apply(kind, value) {
      if (kind === 'tab-size') {
        const size = Number(value);
        if (size > 0) {
          sessionTabSize = size;
          editorHost?.setTabSize?.(size);
        }
      } else if (kind === 'eol') {
        const eol = value === 'crlf' ? 'crlf' : 'lf';
        sessionEol = eol;
        editorHost?.setEol?.(getActivePath(), eol);
      }
      // Notify the controller so it can persist the selected default.
      onAfterChange({ kind, value: kind === 'tab-size' ? sessionTabSize : sessionEol });
    }

    function handleHostClick(event) {
      const target = event.target;
      const btn = target && typeof target.closest === 'function'
        ? target.closest('[data-ide-chip-value]')
        : null;
      if (!btn) {
        return;
      }
      apply(btn.getAttribute('data-ide-chip-kind'), btn.getAttribute('data-ide-chip-value'));
      if (host) {
        popover.close(host, { restoreFocus: true });
      }
    }

    function initHandlers() {
      if (bound) {
        return;
      }
      const shell = getDom().ideShell || null;
      if (!shell || !popover) {
        return;
      }
      bound = true;
      popover.initPopoverHandlers(shell);
      ensureHost();
    }

    // Applies the session defaults (if the user changed them) to a freshly
    // opened file; called by the controller after the doc is activated.
    function applyDefaults(path) {
      if (sessionTabSize !== null) {
        editorHost?.setTabSize?.(sessionTabSize);
      }
      if (sessionEol !== null) {
        editorHost?.setEol?.(path, sessionEol);
      }
    }

    // Hydrate persisted defaults; null leaves the per-file setting unchanged.
    function seedDefaults({ tabSize = null, eol = null } = {}) {
      if (tabSize !== null && Number(tabSize) > 0) {
        sessionTabSize = Number(tabSize);
        editorHost?.setTabSize?.(sessionTabSize);
      }
      if (eol === 'lf' || eol === 'crlf') {
        sessionEol = eol;
        editorHost?.setEol?.(getActivePath(), sessionEol);
      }
    }

    function dispose() {
      if (host && typeof host.removeEventListener === 'function') {
        host.removeEventListener('click', handleHostClick);
      }
      if (host && host.parentNode) {
        host.parentNode.removeChild(host);
      }
      host = null;
      bound = false;
    }

    return {
      initHandlers,
      openTabSizePicker: (anchor) => openPicker('tab-size', anchor),
      openEolPicker: (anchor) => openPicker('eol', anchor),
      applyDefaults,
      seedDefaults,
      dispose,
    };
  }

  function createIdeChatSessionPicker(deps) {
    const state = deps?.state || {};
    const getHeader = typeof deps?.getHeader === 'function' ? deps.getHeader : () => null;
    const onSelectSession = typeof deps?.onSelectSession === 'function' ? deps.onSelectSession : noop;
    const showShellErrorToast = typeof deps?.showShellErrorToast === 'function' ? deps.showShellErrorToast : noop;
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const actionButton = resolveInventoryPrimitive('inventoryActionButton', '../inventory/action-button');
    const textField = resolveInventoryPrimitive('inventoryTextField', '../inventory/text-field');
    const popover = resolveInventoryPrimitive('inventoryPopover', '../inventory/popover');

    let boundHeader = null;
    let pickerQuery = '';
    let pickerListSignature = '';
    let switchingSessionId = '';
    let disposed = false;

    function activeSession() {
      const currentId = String(state.currentSessionId || '').trim();
      return (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => String(session?.id || '').trim() === currentId) || null;
    }

    function eligibleSessions() {
      const pendingDeletes = new Set(
        (Array.isArray(state.ui?.pendingSessionDeletes) ? state.ui.pendingSessionDeletes : [])
          .map((id) => String(id || '').trim()).filter(Boolean)
      );
      return (Array.isArray(state.sessions) ? state.sessions : [])
        .filter((session) => {
          const id = String(session?.id || '').trim();
          const type = String(session?.session_type || 'chat').trim().toLowerCase();
          return Boolean(id) && type === 'chat' && !session?.archived_at && !pendingDeletes.has(id);
        })
        .slice()
        .sort((left, right) => String(right?.updated_at || right?.created_at || '')
          .localeCompare(String(left?.updated_at || left?.created_at || '')));
    }

    function visibleSessions() {
      const sessions = eligibleSessions();
      const query = pickerQuery.trim().toLowerCase();
      if (query) {
        const matches = sessions.filter((session) => sessionTitle(session).toLowerCase().includes(query));
        return { sessions: matches.slice(0, SEARCH_RESULT_LIMIT), total: matches.length, searching: true };
      }
      const currentId = String(state.currentSessionId || '').trim();
      const current = sessions.find((session) => String(session.id || '').trim() === currentId);
      const recent = sessions.filter((session) => String(session.id || '').trim() !== currentId)
        .slice(0, current ? RECENT_SESSION_LIMIT - 1 : RECENT_SESSION_LIMIT);
      return { sessions: current ? [current, ...recent] : recent, total: sessions.length, searching: false };
    }

    function buildMarkup() {
      if (typeof actionButton !== 'function' || typeof textField !== 'function' || typeof popover !== 'function') {
        return '';
      }
      const trigger = actionButton({
        plain: true,
        className: 'ide-chat-dock-session-trigger',
        ariaLabel: 'Switch chat session',
        title: 'Switch chat session',
        ariaHaspopup: 'dialog',
        ariaExpanded: false,
        ariaControls: 'ideChatDockSessionPicker',
        dataset: { 'ide-chatdock-session-trigger': '1' },
        trustedHtml: '<span class="ide-chat-dock-label" data-ide-chatdock-session-title></span>' + CHEVRON_DOWN_GLYPH,
      });
      const search = textField({
        id: 'ide-chat-dock-session-search',
        placeholder: 'Search sessions...',
        ariaLabel: 'Search chat sessions',
        className: 'ide-chat-dock-session-search',
        dataset: { 'ide-chatdock-session-search': '1' },
      });
      const picker = popover({
        id: 'ide-chatdock-sessions',
        domId: 'ideChatDockSessionPicker',
        className: 'ide-chat-dock-session-picker',
        ariaLabel: 'Switch chat session',
        trustedHtml: search
          + '<div class="ide-chat-dock-session-list" id="ideChatDockSessionList" role="listbox" aria-label="Chat sessions"></div>'
          + '<div class="ide-chat-dock-session-status" role="status" aria-live="polite"></div>',
      });
      return `<div class="ide-chat-dock-session-control">${trigger}${picker}</div>`;
    }

    function renderPickerList() {
      const header = getHeader();
      const list = header?.querySelector?.('.ide-chat-dock-session-list');
      const status = header?.querySelector?.('.ide-chat-dock-session-status');
      if (!list || !status || typeof actionButton !== 'function') return;
      const result = visibleSessions();
      const currentId = String(state.currentSessionId || '').trim();
      const signature = [pickerQuery, currentId, switchingSessionId, result.total]
        .concat(result.sessions.map((session) => `${session.id}|${sessionTitle(session)}|${session.updated_at || ''}`))
        .join('\n');
      if (signature !== pickerListSignature) {
        pickerListSignature = signature;
        list.innerHTML = result.sessions.length
          ? result.sessions.map((session) => {
            const id = String(session.id || '').trim();
            const selected = id === currentId;
            return actionButton({
              plain: true,
              className: `ide-chat-dock-session-option${selected ? ' is-active' : ''}`,
              disabled: Boolean(switchingSessionId),
              role: 'option',
              ariaSelected: selected,
              title: 'Switch chat session',
              dataset: { 'ide-chatdock-session-id': id },
              trustedHtml: `<span class="ide-chat-dock-session-option-title">${actionButton.escapeHtml(sessionTitle(session))}</span>`
                + `<span class="ide-chat-dock-session-check" aria-hidden="true">${selected ? '&#10003;' : ''}</span>`,
            });
          }).join('')
          : '<div class="ide-chat-dock-session-empty" role="note">No chats found</div>';
      }
      let nextStatus = '';
      if (result.searching && result.total > SEARCH_RESULT_LIMIT) {
        nextStatus = `Showing first ${SEARCH_RESULT_LIMIT} of ${result.total} matches`;
      } else if (result.searching) {
        nextStatus = `${result.total} ${result.total === 1 ? 'match' : 'matches'}`;
      } else if (result.total > RECENT_SESSION_LIMIT) {
        nextStatus = `${RECENT_SESSION_LIMIT} recent chats`;
      }
      if (status.textContent !== nextStatus) status.textContent = nextStatus;
      status.hidden = !nextStatus;
    }

    function resetQuery() {
      pickerQuery = '';
      const input = getHeader()?.querySelector?.('[data-ide-chatdock-session-search]');
      if (input && input.value !== '') input.value = '';
      pickerListSignature = '';
    }

    function close(restoreFocus = false) {
      const picker = getHeader()?.querySelector?.('#ideChatDockSessionPicker');
      if (picker && typeof popover?.close === 'function') popover.close(picker, { restoreFocus });
    }

    function open() {
      const header = getHeader();
      const trigger = header?.querySelector?.('[data-ide-chatdock-session-trigger]');
      const picker = header?.querySelector?.('#ideChatDockSessionPicker');
      if (!trigger || !picker || typeof popover?.open !== 'function') return;
      resetQuery();
      renderPickerList();
      popover.open(picker, { trigger, focus: false });
      header.querySelector('[data-ide-chatdock-session-search]')?.focus?.();
    }

    function toggle() {
      const picker = getHeader()?.querySelector?.('#ideChatDockSessionPicker');
      if (!picker || typeof popover?.isOpen !== 'function') return;
      if (popover.isOpen(picker)) close(true);
      else open();
    }

    async function selectSession(sessionId) {
      const id = String(sessionId || '').trim();
      if (!id || switchingSessionId) return;
      if (id === String(state.currentSessionId || '').trim()) {
        close(true);
        return;
      }
      switchingSessionId = id;
      renderPickerList();
      close(true);
      try {
        await onSelectSession(id);
        if (disposed) return;
        const applied = String(state.currentSessionId || '').trim() === id;
        try {
          appendClientLog('INFO', applied ? 'ide_chat_dock.session_switched' : 'ide_chat_dock.session_switch_not_applied', { sessionId: id });
        } catch (_logError) { /* diagnostics are best-effort */ }
      } catch (error) {
        if (disposed) return;
        try {
          appendClientLog('WARN', 'ide_chat_dock.session_switch_failed', {
            sessionId: id,
            message: String(error?.message || error || '').slice(0, 200),
          });
        } catch (_logError) { /* diagnostics are best-effort */ }
        try {
          showShellErrorToast('Could not switch chat sessions. The current session remains open.', {
            title: 'Session Switch Failed',
            dedupeKey: 'ide-chat-dock:session-switch-failed',
          });
        } catch (_toastError) { /* feedback must not escape the click handler */ }
      } finally {
        if (!disposed) {
          switchingSessionId = '';
          pickerListSignature = '';
          render();
        }
      }
    }

    function render() {
      const header = getHeader();
      const title = sessionTitle(activeSession());
      const titleEl = header?.querySelector?.('[data-ide-chatdock-session-title]');
      const trigger = header?.querySelector?.('[data-ide-chatdock-session-trigger]');
      if (titleEl && titleEl.textContent !== `Jenny · ${title}`) titleEl.textContent = `Jenny · ${title}`;
      const triggerLabel = `Switch chat session. Current: ${title}`;
      if (trigger?.getAttribute?.('aria-label') !== triggerLabel
        || trigger?.getAttribute?.('title') !== triggerLabel) {
        trigger?.setAttribute?.('aria-label', triggerLabel);
        trigger?.setAttribute?.('title', triggerLabel);
      }
      const search = header?.querySelector?.('[data-ide-chatdock-session-search]');
      if (search?.getAttribute?.('aria-controls') !== 'ideChatDockSessionList') {
        search?.setAttribute?.('aria-controls', 'ideChatDockSessionList');
      }
      const picker = header?.querySelector?.('#ideChatDockSessionPicker');
      if (typeof popover?.isOpen === 'function' && popover.isOpen(picker)) renderPickerList();
    }

    function pickerOptions() {
      const list = getHeader()?.querySelector?.('.ide-chat-dock-session-list');
      return list ? [...list.querySelectorAll('[data-ide-chatdock-session-id]:not(:disabled)')] : [];
    }

    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('[data-ide-chatdock-session-trigger]')) {
        toggle();
        return;
      }
      const option = target.closest('[data-ide-chatdock-session-id]');
      if (option) void selectSession(option.dataset.ideChatdockSessionId);
    }

    function handleInput(event) {
      if (!event.target?.matches?.('[data-ide-chatdock-session-search]')) return;
      pickerQuery = String(event.target.value || '');
      pickerListSignature = '';
      renderPickerList();
    }

    function handleKeydown(event) {
      const search = event.target?.matches?.('[data-ide-chatdock-session-search]');
      const option = event.target?.closest?.('[data-ide-chatdock-session-id]');
      if (!search && !option) return;
      const options = pickerOptions();
      if (event.key === 'Escape') {
        close(true);
        event.preventDefault();
        return;
      }
      if (search && event.key === 'Enter') {
        options[0]?.click?.();
        event.preventDefault();
        return;
      }
      if (option && (event.key === 'Enter' || event.key === ' ')) {
        option.click?.();
        event.preventDefault();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !options.length) return;
      let nextIndex = search ? (event.key === 'ArrowUp' || event.key === 'End' ? options.length - 1 : 0) : options.indexOf(option);
      if (!search) {
        if (event.key === 'ArrowDown') nextIndex = (nextIndex + 1) % options.length;
        else if (event.key === 'ArrowUp') nextIndex = (nextIndex - 1 + options.length) % options.length;
        else if (event.key === 'Home') nextIndex = 0;
        else nextIndex = options.length - 1;
      }
      options[nextIndex]?.focus?.();
      event.preventDefault();
    }

    function handlePopoverToggle(event) {
      if (event.detail?.id === 'ide-chatdock-sessions' && event.detail.open === false) resetQuery();
    }

    function bindEvents(header = getHeader()) {
      if (!header || boundHeader) return;
      boundHeader = header;
      boundHeader.addEventListener('click', handleClick);
      boundHeader.addEventListener('input', handleInput);
      boundHeader.addEventListener('keydown', handleKeydown);
      boundHeader.addEventListener('inv-popover-toggle', handlePopoverToggle);
    }

    function dispose() {
      disposed = true;
      close(false);
      if (!boundHeader) return;
      boundHeader.removeEventListener('click', handleClick);
      boundHeader.removeEventListener('input', handleInput);
      boundHeader.removeEventListener('keydown', handleKeydown);
      boundHeader.removeEventListener('inv-popover-toggle', handlePopoverToggle);
      boundHeader = null;
    }

    return { bindEvents, buildMarkup, close, dispose, render };
  }

  return { createIdeChipPicker, createIdeChatSessionPicker };
});
