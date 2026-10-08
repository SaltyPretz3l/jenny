/* renderer/features/renderer-changes-view.js
 * Changes view controller (row 34 S5; suggested changes row 35 W2). One
 * instance per host: the IDE chat dock's "Changes" tab or the chat side
 * panel's code_review mode. Builds the History model from the change ledger
 * and, while a Propose batch is waiting, the suggested-changes state from the
 * shared suggestions client; renders through renderer-changes-view-render.js
 * and owns the keyboard model, the "?" popover, the side panel's detail pages
 * and the finish summary. Undo/Redo: renderer-changes-undo.js; decisions: the
 * bar controller; menus and Send: renderer-changes-suggested-actions.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-changes-view-render'),
      require('./renderer-changes-history-model'),
      require('./renderer-suggested-changes-model'),
      require('./renderer-changes-suggested-actions')
    );
    return;
  }
  root.rendererChangesView = factory(root.rendererChangesViewRender, root.rendererChangesHistoryModel, root.rendererSuggestedChangesModel, root.rendererChangesSuggestedActions);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (viewRender, historyModel, suggestedModel, suggestedActions) {
  'use strict';

  const TYPING_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
  const SUGGESTION_PREFIX = 's:';

  function isTyping(target) {
    return Boolean(target && typeof target.closest === 'function' && target.closest(TYPING_SELECTOR));
  }

  function createChangesView(deps = {}) {
    const host = deps.host === 'panel' ? 'panel' : 'dock';
    const noop = function () {};
    const getTurnViewModels = typeof deps.getTurnViewModels === 'function' ? deps.getTurnViewModels : () => [];
    const buildLedger = typeof deps.buildLedger === 'function' ? deps.buildLedger : null;
    const getSessionId = typeof deps.getSessionId === 'function' ? deps.getSessionId : () => '';
    const getWorkspaceId = typeof deps.getWorkspaceId === 'function' ? deps.getWorkspaceId : () => '';
    const getTurnTime = typeof deps.getTurnTime === 'function' ? deps.getTurnTime : null;
    const openChangeDiff = typeof deps.openChangeDiff === 'function' ? deps.openChangeDiff : noop;
    const openSuggestionDiff = typeof deps.openSuggestionDiff === 'function' ? deps.openSuggestionDiff : null;
    const openInWorkspace = typeof deps.openInWorkspace === 'function' ? deps.openInWorkspace : null;
    const getGitState = typeof deps.getGitState === 'function' ? deps.getGitState : null;
    const subscribeGit = typeof deps.subscribeGit === 'function' ? deps.subscribeGit : null;
    const openInGit = typeof deps.openInGit === 'function' ? deps.openInGit : null;
    const onBackToChat = typeof deps.onBackToChat === 'function' ? deps.onBackToChat : noop;
    // The undo controller may be created after the view, so it is read per use.
    const getUndo = typeof deps.getUndoController === 'function' ? deps.getUndoController : () => deps.undoController || null;
    const getClient = typeof deps.getSuggestedClient === 'function'
      ? deps.getSuggestedClient
      : () => globalThis.rendererSuggestedChangesClient?.getSharedClient?.() || null;
    const createBar = typeof deps.createBarController === 'function'
      ? deps.createBarController
      : (options) => globalThis.rendererSuggestionBarController?.createSuggestionBarController?.(options) || null;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const setIntervalFn = typeof deps.setInterval === 'function' ? deps.setInterval : globalThis.setInterval;
    const clearIntervalFn = typeof deps.clearInterval === 'function' ? deps.clearInterval : globalThis.clearInterval;
    const render = viewRender.createChangesViewRender({
      escapeHtml: deps.escapeHtml,
      formatTime: deps.formatTime,
      actionButton: deps.actionButton,
      renderDiffBody: deps.renderDiffBody,
    });

    let mountEl = null;
    let disposed = false;
    let sessionId = '';
    // history | detail (panel, applied change) | suggested | suggestion (panel, one suggestion) | finish
    let mode = 'history';
    let showHistory = false;
    let selectedKey = '';
    let focusKey = '';
    let detail = null;
    let popover = null;
    let changesByKey = new Map();
    let filesByKey = new Map();
    let lastHistory = { turns: [] };
    let lastSuggested = null;
    let lastBatchIds = [];
    let finish = null;
    let lastHtml = '';
    let bar = null;
    let unsubscribe = null;
    let unsubscribeGit = null;
    let elapsedTimer = null;
    const actions = suggestedActions.createSuggestedActions({
      getClient,
      getSessionId: () => sessionId,
      getRow: (id) => (lastSuggested ? lastSuggested.rows.find((row) => row.id === id) || null : null),
      contextMenu: deps.contextMenu,
      storage: deps.storage,
    });

    function resetForSession(nextSessionId) {
      sessionId = nextSessionId;
      mode = 'history';
      showHistory = false;
      selectedKey = '';
      focusKey = '';
      detail = null;
      finish = null;
      lastBatchIds = [];
      closePopover();
    }

    function buildHistory() {
      const turns = getTurnViewModels() || [];
      const ledger = buildLedger
        ? buildLedger(turns, { sessionId, workspaceId: getWorkspaceId() })
        : { changes: [], notices: [] };
      changesByKey = new Map();
      for (const change of Array.isArray(ledger.changes) ? ledger.changes : []) {
        // The last change per turn and file is what the file line opens.
        changesByKey.set(`${change.turnId}::${change.fileKey}`, change);
      }
      const history = historyModel.buildChangesHistory(ledger, turns, { getTurnTime });
      // Accepted suggestions were written outside a turn's tool calls.
      const applied = suggestedModel.buildAppliedHistory(suggestedList(), { workspaceId: getWorkspaceId() });
      for (const change of applied.changes) changesByKey.set(`${change.turnId}::${change.fileKey}`, change);
      if (applied.turns.length) history.turns = [...history.turns, ...applied.turns].sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0));
      filesByKey = new Map();
      const undo = getUndo();
      for (const turn of history.turns) {
        turn.canUndo = undo && typeof undo.canUndoTurn === 'function' ? undo.canUndoTurn(turn, sessionId) : false;
        for (const file of turn.files) filesByKey.set(`${turn.turnId}::${file.fileKey}`, { turn, file });
      }
      return history;
    }

    /* ── Suggested changes (row 35) ── */

    function suggestedList() {
      const client = getClient();
      return client && sessionId ? client.get(sessionId) : null;
    }

    function buildSuggested() {
      const client = getClient();
      if (!client || !sessionId || !suggestedModel) return null;
      const list = client.get(sessionId);
      const view = suggestedModel.buildSuggestedView(list, {
        currentId: client.getCurrent(sessionId),
        activity: client.activity(sessionId),
      });
      if (view) {
        lastBatchIds = view.rows.map((row) => row.id);
      } else if (lastBatchIds.length && list) {
        // The last waiting suggestion was just decided: show the summary until the person leaves.
        const ids = new Set(lastBatchIds);
        finish = suggestedModel.buildFinishSummary(list.entries.filter((entry) => ids.has(entry.id)));
        lastBatchIds = [];
      }
      return view;
    }

    function ensureBar() {
      if (bar || disposed) return bar;
      const client = getClient();
      if (!client) return null;
      bar = createBar({ client, onNavigate: (navSessionId, id) => { if (navSessionId === sessionId) openSuggestion(id); } });
      return bar;
    }

    function subscribe() {
      if (unsubscribe) return;
      const client = getClient();
      if (!client) return;
      unsubscribe = client.subscribe((changedSessionId) => {
        if (changedSessionId === sessionId) renderView();
      });
    }

    function itemKeys() {
      if (mode === 'suggested' && lastSuggested) return lastSuggested.rows.map((row) => SUGGESTION_PREFIX + row.id);
      const keys = [];
      for (const turn of lastHistory.turns) {
        for (const file of turn.files) keys.push(`${turn.turnId}::${file.fileKey}`);
      }
      return keys;
    }

    function resolveMode() {
      if (mode === 'suggestion') {
        // Only while its change is in the batch: deciding the last one shows the finish summary.
        const id = detail && detail.suggestionId;
        if (id && lastSuggested && lastSuggested.rows.some((row) => row.id === id)) return 'suggestion';
      }
      if (lastSuggested && !showHistory) return 'suggested';
      if (finish && !showHistory) return 'finish';
      if (mode === 'detail' && detail && changesByKey.has(detail.key)) return 'detail';
      return 'history';
    }

    function viewModel() {
      const undo = getUndo();
      const keys = itemKeys();
      if (mode === 'suggested' && lastSuggested && !keys.includes(focusKey)) {
        focusKey = SUGGESTION_PREFIX + lastSuggested.currentId;
      }
      if (!keys.includes(focusKey)) focusKey = keys.includes(selectedKey) ? selectedKey : (keys[0] || '');
      const footer = !lastSuggested ? null : (mode === 'suggested' ? lastSuggested.footer : (mode === 'history' ? { suggestedLink: true } : null));
      return {
        host,
        mode,
        history: lastHistory,
        suggested: lastSuggested,
        finish,
        selectedKey,
        focusKey,
        detail,
        getGitState, canOpenInGit: Boolean(openInGit),
        undoStates: undo && typeof undo.getUndoStates === 'function' ? undo.getUndoStates(sessionId) : {},
        footer,
      };
    }

    function renderView() {
      if (disposed || !mountEl) return;
      const nextSessionId = String(getSessionId() || '');
      if (nextSessionId !== sessionId) resetForSession(nextSessionId);
      lastHistory = buildHistory();
      lastSuggested = buildSuggested();
      mode = resolveMode();
      if (mode === 'suggestion') syncSuggestionDetail();
      if (mode !== 'detail' && mode !== 'suggestion') detail = null;
      const html = render.buildViewHtml(viewModel());
      syncElapsedTimer();
      // Hosts re-render on every chat render; unchanged markup keeps the DOM,
      // hover state and an open popover.
      if (html === lastHtml && mountEl.querySelector('.changes-view')) {
        renderBar();
        return;
      }
      lastHtml = html;
      const doc = mountEl.ownerDocument;
      const hadFocus = Boolean(doc && mountEl.contains(doc.activeElement));
      // An Undo/Redo button swaps for the other as the turn changes state.
      const focusedAction = hadFocus && typeof doc.activeElement.getAttribute === 'function'
        ? doc.activeElement.getAttribute('data-changes-undo') || doc.activeElement.getAttribute('data-changes-redo') || ''
        : '';
      const scroller = mountEl.querySelector('.changes-view-scroll');
      const scrollTop = scroller ? scroller.scrollTop : 0;
      closePopover();
      mountEl.innerHTML = html;
      const nextScroller = mountEl.querySelector('.changes-view-scroll');
      if (nextScroller && (mode === 'history' || mode === 'suggested')) nextScroller.scrollTop = scrollTop;
      renderBar();
      if (focusedAction) focusTurnAction(focusedAction);
      else if (hadFocus) focusCurrent();
    }

    const suggestionDetail = (id) => suggestedModel.buildSuggestionDetail(suggestedList(), lastSuggested, id);

    // A new revision replaces the page's diff and the bar's revision together.
    function syncSuggestionDetail() {
      const next = suggestionDetail(detail.suggestionId);
      if (next.revision !== detail.revision || next.index !== detail.index || next.total !== detail.total) detail = next;
    }

    // The side panel's suggestion page hosts the same decision bar as the editor.
    function renderBar() {
      if (mode !== 'suggestion' || !mountEl || !detail) return;
      const barHost = mountEl.querySelector('[data-changes-bar-host]');
      const controller = ensureBar();
      if (!barHost || !controller) return;
      controller.render(barHost, { sessionId, id: detail.suggestionId, revision: detail.revision });
    }

    function syncElapsedTimer() {
      const active = mode === 'suggested' && lastSuggested && lastSuggested.footer && lastSuggested.footer.activity;
      if (active && !elapsedTimer && typeof setIntervalFn === 'function') {
        elapsedTimer = setIntervalFn(() => {
          const el = mountEl && mountEl.querySelector('[data-changes-elapsed-start]');
          const start = el ? Number(el.getAttribute('data-changes-elapsed-start')) : 0;
          if (el && start) el.textContent = render.formatElapsed(Date.now() - start);
        }, 1000);
      } else if (!active && elapsedTimer) {
        clearIntervalFn(elapsedTimer);
        elapsedTimer = null;
      }
    }

    function itemElements() {
      return mountEl ? Array.from(mountEl.querySelectorAll('[data-changes-item]')) : [];
    }

    function focusCurrent() {
      if (!mountEl) return;
      const target = itemElements().find((el) => el.getAttribute('data-changes-item') === focusKey)
        || mountEl.querySelector('[data-changes-back]')
        || mountEl.querySelector('.changes-view');
      if (target && typeof target.focus === 'function') target.focus();
    }

    function moveFocus(nextKey) {
      if (!nextKey) return;
      for (const el of itemElements()) {
        const isTarget = el.getAttribute('data-changes-item') === nextKey;
        el.setAttribute('tabindex', isTarget ? '0' : '-1');
        if (isTarget) el.focus();
      }
      focusKey = nextKey;
      closePopover();
    }

    function openSuggestion(id) {
      const client = getClient();
      if (!client || !id) return;
      client.setCurrent(sessionId, id);
      selectedKey = SUGGESTION_PREFIX + id;
      focusKey = selectedKey;
      if (host === 'panel') {
        detail = suggestionDetail(id);
        mode = 'suggestion';
        renderView();
        return;
      }
      renderView();
      if (openSuggestionDiff) {
        Promise.resolve(openSuggestionDiff(sessionId, id)).catch((error) => {
          appendClientLog('WARN', 'changes_view.open_suggestion_failed', { message: String(error && error.message || error) });
        });
      }
    }

    function openItem(key) {
      if (String(key).startsWith(SUGGESTION_PREFIX)) { openSuggestion(String(key).slice(SUGGESTION_PREFIX.length)); return; }
      const change = changesByKey.get(key);
      if (!change) return;
      selectedKey = key;
      focusKey = key;
      if (host === 'panel') {
        const keys = itemKeys();
        detail = {
          key,
          change,
          changeId: change.changeId,
          path: change.path,
          index: keys.indexOf(key) + 1,
          total: keys.length,
          canOpenInWorkspace: Boolean(openInWorkspace),
        };
        mode = 'detail';
        renderView();
        focusCurrent();
        return;
      }
      renderView();
      Promise.resolve(openChangeDiff(change)).catch((error) => {
        appendClientLog('WARN', 'changes_view.open_diff_failed', { message: String(error && error.message || error) });
      });
    }

    function showList() {
      mode = 'history';
      detail = null;
      renderView();
      focusCurrent();
    }

    /* ── "?" popover: who wrote the file (History) or what and why (suggestions) ── */

    function closePopover() {
      if (popover && popover.parentNode) popover.parentNode.removeChild(popover);
      popover = null;
    }

    function popoverText(key) {
      if (String(key).startsWith(SUGGESTION_PREFIX)) {
        const id = String(key).slice(SUGGESTION_PREFIX.length);
        const entry = (suggestedList()?.entries || []).find((item) => item.id === id);
        return entry ? viewRender.explainText(entry) : '';
      }
      const entry = filesByKey.get(key);
      return entry ? viewRender.writtenByText(entry.file) : '';
    }

    function openPopover(key) {
      closePopover();
      const text = popoverText(key);
      const anchor = itemElements().find((el) => el.getAttribute('data-changes-item') === key);
      if (!text || !anchor || !mountEl) return;
      const doc = mountEl.ownerDocument;
      popover = doc.createElement('div');
      popover.className = 'changes-popover';
      popover.setAttribute('role', 'tooltip');
      popover.id = 'changes-popover';
      popover.textContent = text;
      anchor.setAttribute('aria-describedby', popover.id);
      anchor.insertAdjacentElement('afterend', popover);
    }

    /* ── Events ── */

    // The sheet closes after a re-render replaced the button that opened it,
    // so focus returns to the turn's current Undo/Redo button (or the view).
    function focusTurnAction(turnId) {
      if (!mountEl) return;
      const actions = mountEl.querySelectorAll('[data-changes-undo], [data-changes-redo]');
      const match = Array.prototype.find.call(actions, (el) => (
        el.getAttribute('data-changes-undo') === turnId || el.getAttribute('data-changes-redo') === turnId));
      const target = match || mountEl.querySelector('.changes-view');
      if (target && typeof target.focus === 'function') target.focus();
    }

    function undoOptions(turn) {
      return {
        sessionId,
        history: lastHistory,
        getChange: (turnId, fileKey) => changesByKey.get(`${turnId}::${fileKey}`) || null,
        restoreFocus: () => focusTurnAction(turn.turnId),
      };
    }

    function handleSuggestedClick(target) {
      if (actions.handleClick(target)) return true;
      if (target.closest('[data-changes-show-history]')) { showHistory = true; mode = 'history'; renderView(); focusCurrent(); return true; }
      if (target.closest('[data-changes-show-suggested]')) { showHistory = false; renderView(); focusCurrent(); return true; }
      if (target.closest('[data-changes-back-to-chat]')) { finish = null; renderView(); onBackToChat(); return true; }
      const explain = target.closest('[data-changes-explain]');
      if (explain) {
        const key = SUGGESTION_PREFIX + explain.getAttribute('data-changes-explain');
        if (popover) closePopover(); else openPopover(key);
        return true;
      }
      return false;
    }

    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function' || !mountEl || !mountEl.contains(target)) return;
      const barHost = target.closest('[data-changes-bar-host]');
      if (barHost) { if (bar) bar.handleClick(event, barHost); return; }
      if (handleSuggestedClick(target)) return;
      const undo = getUndo();
      for (const [attr, method] of [['data-changes-undo', 'openUndo'], ['data-changes-redo', 'redo']]) {
        const control = target.closest(`[${attr}]`);
        if (!control || !undo || typeof undo[method] !== 'function') continue;
        const turn = lastHistory.turns.find((item) => item.turnId === control.getAttribute(attr));
        if (turn) undo[method](turn, undoOptions(turn));
        return;
      }
      if (target.closest('[data-changes-back]')) { showList(); return; }
      const gitLink = target.closest('[data-changes-open-git]');
      if (gitLink) { if (openInGit) openInGit(gitLink.getAttribute('data-changes-open-git')); return; }
      const workspaceLink = target.closest('[data-changes-open-workspace]');
      if (workspaceLink && openInWorkspace) {
        openInWorkspace(workspaceLink.getAttribute('data-changes-open-workspace'));
        return;
      }
      const item = target.closest('[data-changes-item]');
      if (item) openItem(item.getAttribute('data-changes-item'));
    }

    function handleInput(event) {
      const barHost = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-changes-bar-host]') : null;
      if (barHost && bar) bar.handleInput(event, barHost);
    }

    function handleKeydown(event) {
      if (!mountEl || !mountEl.contains(event.target)) return;
      if (mode === 'suggestion' && bar) {
        const barHost = mountEl.querySelector('[data-changes-bar-host]');
        if (barHost && bar.handleKeydown(event, barHost)) return;
      }
      if (isTyping(event.target) || actions.handleKeydown(event)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') {
        if (popover) { closePopover(); event.preventDefault(); return; }
        if (mode === 'detail' || mode === 'suggestion') { showList(); event.preventDefault(); }
        return;
      }
      const item = event.target.closest && event.target.closest('[data-changes-item]');
      if (!item) return;
      const keys = itemElements().map((el) => el.getAttribute('data-changes-item'));
      const index = keys.indexOf(item.getAttribute('data-changes-item'));
      let next = '';
      if (event.key === 'ArrowDown') next = keys[Math.min(keys.length - 1, index + 1)];
      else if (event.key === 'ArrowUp') next = keys[Math.max(0, index - 1)];
      else if (event.key === 'Home') next = keys[0];
      else if (event.key === 'End') next = keys[keys.length - 1];
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openItem(keys[index]);
        return;
      } else if (event.key === '?') {
        event.preventDefault();
        if (popover) closePopover(); else openPopover(keys[index]);
        return;
      }
      if (next) {
        event.preventDefault();
        moveFocus(next);
      }
    }

    function handleFocusOut(event) {
      if (popover && mountEl && !mountEl.contains(event.relatedTarget)) closePopover();
    }

    function mount(element) {
      if (disposed || !element) return;
      if (mountEl === element) { renderView(); return; }
      unmount();
      mountEl = element;
      mountEl.addEventListener('click', handleClick);
      mountEl.addEventListener('keydown', handleKeydown);
      mountEl.addEventListener('focusout', handleFocusOut);
      mountEl.addEventListener('input', handleInput);
      mountEl.addEventListener('contextmenu', actions.handleContextMenu);
      subscribe();
      if (subscribeGit && !unsubscribeGit) unsubscribeGit = subscribeGit(() => renderView()) || null;
      renderView();
    }

    function unmount() {
      if (!mountEl) return;
      closePopover();
      for (const [name, fn] of [['click', handleClick], ['keydown', handleKeydown], ['focusout', handleFocusOut], ['input', handleInput], ['contextmenu', actions.handleContextMenu]]) mountEl.removeEventListener(name, fn);
      mountEl = null;
      // Leaving ends the finish summary and the elapsed timer.
      finish = null;
      lastHtml = '';
      if (elapsedTimer) { clearIntervalFn(elapsedTimer); elapsedTimer = null; }
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
      if (unsubscribeGit) unsubscribeGit();
      unsubscribeGit = null;
    }

    // A transcript "Review changes" affordance selects a turn (and file).
    function reveal({ turnId = '', fileKey = '' } = {}) {
      if (!mountEl) return false;
      showHistory = true;
      renderView();
      const turn = lastHistory.turns.find((item) => item.turnId === turnId) || lastHistory.turns[0];
      if (!turn) return false;
      const file = turn.files.find((item) => item.fileKey === fileKey) || turn.files[0];
      if (!file) return false;
      const key = `${turn.turnId}::${file.fileKey}`;
      selectedKey = key;
      focusKey = key;
      if (fileKey && host === 'panel') { openItem(key); return true; }
      mode = 'history';
      detail = null;
      renderView();
      const block = Array.from(mountEl.querySelectorAll('[data-changes-turn-block]'))
        .find((el) => el.getAttribute('data-changes-turn-block') === turn.turnId);
      if (block && typeof block.scrollIntoView === 'function') block.scrollIntoView({ block: 'nearest' });
      focusCurrent();
      return true;
    }

    // Shows the suggested changes (from a "Review suggestion" affordance).
    function revealSuggested({ id: wantedId = '', toolCallId = '' } = {}, retried = false) {
      if (!mountEl) return false;
      showHistory = false;
      renderView();
      const client = getClient();
      if (!suggestedList() && client && sessionId && !retried) {
        // First open of this chat: reveal once its list has loaded.
        const revealSession = sessionId;
        Promise.resolve(client.refresh(sessionId)).then(() => {
          if (!disposed && sessionId === revealSession) revealSuggested({ id: wantedId, toolCallId }, true);
        });
        return true;
      }
      if (!lastSuggested) return false;
      const byCall = toolCallId ? (suggestedList()?.entries || []).find((entry) => entry.tool_call_id === toolCallId) : null;
      const id = wantedId || (byCall ? byCall.id : '');
      const target = id && lastSuggested.rows.some((row) => row.id === id) ? id : lastSuggested.currentId;
      if (id && target === id) { openSuggestion(target); focusCurrent(); return true; }
      focusKey = SUGGESTION_PREFIX + target;
      renderView();
      focusCurrent();
      return true;
    }

    function dispose() {
      unmount();
      disposed = true;
      if (bar && typeof bar.dispose === 'function') bar.dispose();
      bar = null;
    }

    return {
      dispose,
      focus: focusCurrent,
      getHistory: () => lastHistory,
      getMode: () => mode,
      mount,
      render: renderView,
      reveal,
      revealSuggested,
      unmount,
    };
  }

  return { createChangesView, createTurnTimeLookup: historyModel.createTurnTimeLookup };
});
