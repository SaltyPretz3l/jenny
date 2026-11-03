/* renderer/shell/renderer-app-view-controller.js -- the renderer half of `app_view` (row 94 P3, UMD).
 *
 * Main sends ONE `appView.onRequest` push per tool call (services/app-view-service.js): the Jenny chat asks to
 * open Settings at a section, a chat, a project file at a line, the terminal, Activity or a chat's detail panel,
 * or to close a panel, split view or collapse the sidebar. This controller decides, like the workspace
 * presentation controller does for the IDE:
 *
 *   apply at once only when SAFE: the user is on the Jenny chat in the chat view, has not typed for 4 s, no
 *     approval card is waiting, and Jenny has not moved the view 3 times in the last 20 s; or
 *   a NON-STEALING chip above the composer, "Jenny wants to open ..." with Open and dismiss (aria-live polite,
 *     no focus move, newest wins). The chip's Open always applies.
 *
 * Every decision is reported on `appView.reportOutcome` (shown / shown_by_user / prompted / dismissed /
 * superseded / rejected / dropped); a chip still up when the user leaves the Jenny chat reports `dropped`.
 * It also reports the current layout (ids and booleans only) on `appView.reportLayout` when it changes, for
 * app_view's `state`. The openers are injected from the shell composition; this module owns no surface.
 *
 * createTerminalRunHandler (row 94 P4): the renderer half of `terminal_run`. Main pushes `terminalTools.onRunRequest`
 * only after the user approved that exact command on its card, so it runs at once (no idle rule, no chip): the IDE
 * opens a terminal of its own for it (an idle Jenny terminal or a new one, never a shell the user is using), starts
 * its shell and sends the line, then reports `{ ok, session_id }` or a reason on `terminalTools.reportRun`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppViewController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const TYPING_GUARD_MS = 4000;
  const OSCILLATION_MAX = 3;
  const OSCILLATION_WINDOW_MS = 20_000; // the owner's V1 pick: 3 moves in 20 s (workspace_present uses 10 s)
  const LAYOUT_POLL_MS = 1500;
  const PENDING_APPROVAL_SELECTOR = '.approval-gap-row[data-approval-status="pending"]:not([data-approval-resolved="true"])';
  const ACTIONS = ['settings', 'chat', 'file', 'terminal', 'activity', 'chat_panel', 'close', 'split', 'sidebar'];
  const LAYOUT_ACTIONS = ['close', 'split', 'sidebar'];
  const ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
  function noop() {}

  function text(value, max) {
    return typeof value === 'string' ? value.slice(0, max || 200) : '';
  }

  // The push, reduced to its closed fields; null for anything malformed.
  function normalizeRequest(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const requestId = text(p.request_id, 160);
    if (!ID_RE.test(requestId) || ACTIONS.indexOf(p.action) < 0) return null;
    return {
      requestId,
      action: p.action,
      sessionId: text(p.session_id, 160),
      section: text(p.section, 64),
      path: text(p.path, 1024),
      line: Number.isSafeInteger(p.line) && p.line > 0 ? p.line : null,
      pane: text(p.pane, 32),
      surface: text(p.surface, 32),
      collapsed: p.collapsed === true,
    };
  }

  function createAppViewController(deps) {
    const d = deps || {};
    const windowRef = d.windowRef || globalThis;
    const documentRef = d.documentRef || windowRef.document || null;
    const o = d.openers || {};
    const call = (name, ...args) => (typeof o[name] === 'function' ? o[name](...args) : false);
    const getBridge = typeof d.getBridge === 'function' ? d.getBridge : () => windowRef.jennyShell?.appView || null;
    const getChipHost = typeof d.getChipHost === 'function' ? d.getChipHost : () => null;
    const getActiveView = typeof d.getActiveView === 'function' ? d.getActiveView : () => '';
    const getCurrentSessionId = typeof d.getCurrentSessionId === 'function' ? d.getCurrentSessionId : () => '';
    const getPrimarySessionId = typeof d.getPrimarySessionId === 'function' ? d.getPrimarySessionId : () => '';
    const sessionTitle = typeof d.sessionTitle === 'function' ? d.sessionTitle : () => '';
    const sectionLabel = typeof d.sectionLabel === 'function' ? d.sectionLabel : (id) => id;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : (v) => String(v == null ? '' : v);
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const now = typeof d.now === 'function' ? d.now : () => Date.now();
    const setIntervalFn = typeof d.setInterval === 'function' ? d.setInterval : (fn, ms) => setInterval(fn, ms);
    const clearIntervalFn = typeof d.clearInterval === 'function' ? d.clearInterval : (handle) => clearInterval(handle);
    const isApprovalPending = typeof d.isApprovalPending === 'function'
      ? d.isApprovalPending : () => Boolean(documentRef?.querySelector?.(PENDING_APPROVAL_SELECTOR));
    const actionButton = d.actionButton || globalThis.inventoryActionButton || null;

    let disposed = false;
    let lastTypingAt = 0;
    let applied = [];
    let chipEl = null;
    let chipRequest = null;
    let lastLayout = '';

    function report(request, decision) {
      const bridge = getBridge();
      if (!request || typeof bridge?.reportOutcome !== 'function') return;
      try { Promise.resolve(bridge.reportOutcome({ request_id: request.requestId, decision })).catch(noop); } catch (_error) { /* bridge gone */ }
    }

    function onPrimaryChat() {
      const primary = String(getPrimarySessionId() || '');
      return Boolean(primary) && getActiveView() === 'chat' && String(getCurrentSessionId() || '') === primary;
    }

    // A focused field holding text is a sentence in progress, however long the pause.
    function draftInProgress() {
      const el = documentRef?.activeElement;
      if (!el) return false;
      if (el.isContentEditable) return String(el.textContent || '').trim() !== '';
      return /^(INPUT|TEXTAREA)$/.test(String(el.tagName || '')) && String(el.value || '').trim() !== '';
    }

    function isSafe() {
      if (!onPrimaryChat() || now() - lastTypingAt < TYPING_GUARD_MS || isApprovalPending() === true || draftInProgress()) return false;
      applied = applied.filter((at) => at > now() - OSCILLATION_WINDOW_MS);
      return applied.length < OSCILLATION_MAX;
    }

    // The opener for one request; a falsy answer (or a throw) is `rejected`.
    function run(request) {
      switch (request.action) {
        case 'settings': return call('openSettings', request.section);
        case 'chat': return call('openChat', request.sessionId);
        case 'file': return call('openFile', request.path, request.line);
        case 'terminal': return call('openTerminal');
        case 'activity': return call('openActivity', request.pane === 'permissions' ? 'permissions' : 'activity');
        case 'chat_panel': return call('openChatPanel', request.sessionId, request.surface);
        case 'close': return call('close', request.pane);
        case 'split': return call('split', request.sessionId);
        case 'sidebar': return call('setSidebarCollapsed', request.collapsed);
        default: return false;
      }
    }

    function apply(request, userInitiated) {
      if (!userInitiated) applied.push(now());
      let outcome;
      try { outcome = run(request); } catch (_error) { outcome = false; }
      Promise.resolve(outcome).then((value) => {
        report(request, value === false || value == null ? 'rejected' : userInitiated ? 'shown_by_user' : 'shown');
        checkLayout();
      }, () => report(request, 'rejected'));
    }

    function removeChip() {
      if (chipEl) chipEl.remove();
      chipEl = null;
      chipRequest = null;
    }

    function chipWhat(request) {
      switch (request.action) {
        case 'settings': return jt('appView.target.settings', 'the {section} settings', { section: sectionLabel(request.section) || request.section });
        case 'chat': {
          const title = sessionTitle(request.sessionId);
          return title ? jt('appView.target.chat', 'the chat {title}', { title }) : jt('appView.target.chatFallback', 'another chat');
        }
        case 'file': return request.line
          ? jt('appView.target.fileLine', 'line {line} of {path}', { line: request.line, path: request.path })
          : jt('appView.target.file', '{path}', { path: request.path });
        case 'terminal': return jt('appView.target.terminal', 'the terminal');
        case 'activity': return request.pane === 'permissions' ? jt('appView.target.permissions', 'Permissions') : jt('appView.target.activity', 'Activity');
        case 'chat_panel': return jt('appView.target.chatPanel', 'a chat panel');
        case 'close': return jt('appView.layout.close', 'close a panel');
        case 'split': return jt('appView.layout.split', 'a chat side by side');
        default: return request.collapsed ? jt('appView.layout.collapse', 'collapse the sidebar') : jt('appView.layout.expand', 'expand the sidebar');
      }
    }

    function handleChipClick(event) {
      const request = chipRequest;
      if (event.target?.closest?.('[data-app-view-open]')) {
        removeChip();
        apply(request, true);
      } else if (event.target?.closest?.('[data-app-view-dismiss]')) {
        report(request, 'dismissed');
        removeChip();
      }
    }

    function showChip(request) {
      const host = getChipHost();
      if (!host?.ownerDocument || typeof actionButton !== 'function') {
        appendClientLog('WARN', 'app_view.chip_unavailable', { action: request.action });
        report(request, 'rejected');
        return;
      }
      if (chipRequest) report(chipRequest, 'superseded');
      removeChip();
      chipRequest = request;
      const layout = LAYOUT_ACTIONS.indexOf(request.action) >= 0;
      const what = chipWhat(request);
      chipEl = host.ownerDocument.createElement('div');
      chipEl.className = 'ide-presentation-chip app-view-chip';
      chipEl.setAttribute('role', 'status');
      chipEl.setAttribute('aria-live', 'polite');
      const copy = layout ? jt('appView.chip.layout', 'Jenny wants to change the layout: {what}', { what }) : jt('appView.chip.open', 'Jenny wants to open {what}', { what });
      chipEl.innerHTML = `<span class="ide-presentation-chip-copy">${escapeHtml(copy)}</span>`
        + actionButton({
          plain: true,
          className: 'ide-presentation-chip-show',
          label: layout ? jt('appView.chip.apply', 'Apply') : jt('appView.chip.openButton', 'Open'),
          dataset: { 'app-view-open': '1' },
        })
        + actionButton({
          plain: true,
          className: 'ide-presentation-chip-dismiss',
          ariaLabel: jt('common.dismiss', 'Dismiss'),
          title: jt('common.dismiss', 'Dismiss'),
          dataset: { 'app-view-dismiss': '1' },
          trustedHtml: '<span aria-hidden="true">&#x2715;</span>',
        });
      chipEl.addEventListener('click', handleChipClick);
      host.appendChild(chipEl);
      report(request, 'prompted');
    }

    function handleRequest(payload) {
      if (disposed) return;
      const request = normalizeRequest(payload);
      if (!request) {
        appendClientLog('WARN', 'app_view.request_invalid', {});
        return;
      }
      if (isSafe()) {
        if (chipRequest) { report(chipRequest, 'superseded'); removeChip(); }
        apply(request, false);
      } else {
        showChip(request);
      }
    }

    // Layout for `state`, sent only when it changed; a chip whose chat the user left is dropped here too.
    function checkLayout() {
      if (disposed) return;
      if (chipRequest && !onPrimaryChat()) {
        report(chipRequest, 'dropped');
        removeChip();
      }
      let layout;
      try { layout = call('readLayout'); } catch (_error) { layout = null; }
      if (!layout || typeof layout !== 'object') return;
      const serialized = JSON.stringify(layout);
      if (serialized === lastLayout) return;
      lastLayout = serialized;
      const bridge = getBridge();
      if (typeof bridge?.reportLayout !== 'function') return;
      try { Promise.resolve(bridge.reportLayout(layout)).catch(noop); } catch (_error) { /* bridge gone */ }
    }

    function noteTyping(event) {
      const target = event?.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(String(target.tagName || '')))) lastTypingAt = now();
    }

    const bridge = getBridge();
    const unsubscribe = typeof bridge?.onRequest === 'function' ? bridge.onRequest(handleRequest) : null;
    // A hidden window skips the poll and re-reads once on return; the first read waits for the first tick, off boot.
    function pollLayout() { if (!documentRef?.hidden) checkLayout(); }
    documentRef?.addEventListener?.('input', noteTyping, true);
    documentRef?.addEventListener?.('visibilitychange', pollLayout);
    const poll = setIntervalFn(pollLayout, LAYOUT_POLL_MS);

    function dispose() {
      if (disposed) return;
      if (chipRequest) report(chipRequest, 'dropped');
      removeChip();
      disposed = true;
      clearIntervalFn(poll);
      documentRef?.removeEventListener?.('input', noteTyping, true);
      documentRef?.removeEventListener?.('visibilitychange', pollLayout);
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
    }

    return { dispose, handleRequest, checkLayout };
  }

  const RUN_REASONS = ['no_free_terminal', 'start_failed', 'send_failed', 'no_ide'];
  const RUN_COMMAND_MAX = 2000;

  function createTerminalRunHandler(deps) {
    const d = deps || {};
    const getBridge = typeof d.getBridge === 'function' ? d.getBridge : function () { return null; };
    const runInTerminal = typeof d.runInTerminal === 'function' ? d.runInTerminal : null;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;

    function report(requestId, answer) {
      const bridge = getBridge();
      if (typeof bridge?.reportRun !== 'function') return;
      try { Promise.resolve(bridge.reportRun({ request_id: requestId, ...answer })).catch(noop); } catch (_error) { /* bridge gone */ }
    }

    async function handleRunRequest(payload) {
      const p = payload && typeof payload === 'object' ? payload : {};
      const requestId = typeof p.request_id === 'string' ? p.request_id : ''; // ID_RE bounds it: never truncated
      const command = typeof p.command === 'string' && p.command.length <= RUN_COMMAND_MAX ? p.command : '';
      if (!ID_RE.test(requestId) || !command.trim()) return;
      let answer;
      try {
        answer = runInTerminal ? await runInTerminal(command) : false;
      } catch (_error) {
        answer = false;
      }
      if (answer && answer.ok === true && ID_RE.test(text(answer.session_id, 160))) {
        report(requestId, { ok: true, session_id: answer.session_id });
      } else {
        const reason = answer && RUN_REASONS.indexOf(answer.reason) >= 0 ? answer.reason : 'no_ide';
        appendClientLog('WARN', 'terminal_run.refused', { reason });
        report(requestId, { ok: false, reason });
      }
    }

    const bridge = getBridge();
    const unsubscribe = typeof bridge?.onRunRequest === 'function' ? bridge.onRunRequest(handleRunRequest) : null;
    function dispose() {
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
    }
    return { dispose, handleRunRequest };
  }

  return { ACTIONS, createAppViewController, createTerminalRunHandler, normalizeRequest };
});
