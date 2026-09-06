/* renderer/features/renderer-ide-terminal-panel.js - Workspace IDE terminal
 * rail panel (W9). Renders a line-oriented console over the single piped
 * PowerShell session owned by workspace-terminal-service: scrollback <pre>
 * (textContent only - never innerHTML of shell output), inventory text-field
 * input (Enter sends a line; auto-starts a stopped session), and Ctrl+C /
 * Clear / Restart actions. ANSI escape sequences are stripped for v1 (no
 * PTY, no xterm). The session is NEVER auto-spawned on hydrate - only by an
 * explicit Start/Enter. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTerminalPanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const MAX_SCROLLBACK_CHARS = 400 * 1024;
  const PANEL_MARKUP_SENTINEL = '__jenny-ide-terminal__';

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  function createIdeTerminalPanel(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    // The panel was re-homed from the rail into the bottom panel: the controller
    // injects the mount host (#ideBottomPanelContent) + an active-view check.
    // The fallbacks keep the old rail behavior for any caller that omits them.
    const getMountEl = typeof deps?.getMountEl === 'function'
      ? deps.getMountEl
      : () => getDom().ideRailPanel || null;
    const isActivePanel = typeof deps?.isActivePanel === 'function'
      ? deps.isActivePanel
      : () => getIde().railPanel === 'terminal';
    const getApi = typeof deps?.getWorkspaceTerminalApi === 'function'
      ? deps.getWorkspaceTerminalApi
      : () => null;
    const showError = typeof deps?.showError === 'function' ? deps.showError : noop;
    const toErrorMessage = typeof deps?.toErrorMessage === 'function'
      ? deps.toErrorMessage
      : (error, fallback) => String(error?.message || error || fallback || '');
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const requestFrame = typeof deps?.requestAnimationFrameImpl === 'function'
      ? deps.requestAnimationFrameImpl
      : (typeof globalRef.requestAnimationFrame === 'function'
          ? globalRef.requestAnimationFrame.bind(globalRef)
          : (callback) => { callback(0); return null; });
    const cancelFrame = typeof deps?.cancelAnimationFrameImpl === 'function'
      ? deps.cancelAnimationFrameImpl
      : (typeof globalRef.cancelAnimationFrame === 'function'
          ? globalRef.cancelAnimationFrame.bind(globalRef)
          : noop);
    const textField = resolveModule('inventoryTextField', '../inventory/text-field');
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    // The shared incremental stripper preserves ANSI/OSC escape sequences split
    // across terminal chunks.
    const ansiStreamUtils = resolveModule('rendererAnsiStreamUtils', '../shared/ansi-stream-utils');
    const ansiStripper = typeof ansiStreamUtils?.createAnsiStreamStripper === 'function'
      ? ansiStreamUtils.createAnsiStreamStripper()
      : { push: (text) => String(text || ''), reset: noop };
    const terminalStreamUtils = resolveModule('rendererTerminalStreamUtils', '../shared/terminal-stream-utils');

    let boundPanel = null;
    let unsubscribeData = null;
    let unsubscribeExit = null;
    let sessionId = '';
    let sessionShell = '';
    let sessionCwd = '';
    // Service-side dropped-byte count (reported by the backend alongside each
    // chunk) — panel-specific, so it stays here and rides the marker callback.
    let droppedBytes = 0;
    let starting = false;
    let startPromise = null;
    // Scrollback is drop-oldest bounded and incrementally painted through the
    // shared rAF-coalesced painter.
    const painter = terminalStreamUtils.createBoundedScrollbackPainter({
      requestFrame,
      cancelFrame,
      maxChars: MAX_SCROLLBACK_CHARS,
      getScrollbackEl: () => getPanelEl()?.querySelector?.('[data-ide-terminal-scrollback]') || null,
      applyDroppedMarkers: (pre, dropped) => {
        pre.dataset.droppedChars = String(dropped);
        pre.dataset.droppedBytes = String(droppedBytes);
      },
    });

    function isRunning() {
      return Boolean(sessionId);
    }

    function appendOutput(text, serviceDroppedBytes = 0) {
      const cleaned = ansiStripper.push(text).replace(/\r(?!\n)/g, '');
      droppedBytes += Math.max(0, Math.trunc(Number(serviceDroppedBytes)) || 0);
      if (cleaned) painter.append(cleaned);
      // Even an all-escape (empty) chunk repaints when the service reported
      // drops, so the dataset.droppedBytes marker stays current.
      if (cleaned || serviceDroppedBytes) painter.schedule();
    }

    function getPanelEl() {
      const panel = getMountEl();
      if (!panel || !isActivePanel()) {
        return null;
      }
      return panel;
    }

    function clearScrollback() {
      droppedBytes = 0;
      // A new/cleared session must never inherit a mid-escape-sequence parser
      // state from whatever was in flight before (Restart especially: a live
      // process can be killed mid-CSI/OSC).
      ansiStripper.reset();
      painter.reset();
    }

    function syncStatus() {
      const panel = getPanelEl();
      const status = panel?.querySelector?.('[data-ide-terminal-status]') || null;
      if (status) {
        status.textContent = isRunning() ? 'running' : 'stopped';
        status.classList.toggle('ide-terminal-status--running', isRunning());
      }
    }

    function buildToolbarButton(action, label, title) {
      return actionButton({
        plain: true,
        className: 'ide-terminal-button',
        title,
        trustedHtml: label,
        dataset: { 'ide-terminal-action': action },
      });
    }

    function buildPanelMarkup() {
      if (typeof actionButton !== 'function' || typeof textField !== 'function') {
        return '<div class="ide-rail-placeholder">Terminal is unavailable in this shell mode.</div>';
      }
      return '<div class="ide-terminal-panel">'
        + '<div class="ide-terminal-toolbar">'
        + '<span class="ide-terminal-title">Terminal</span>'
        + '<span class="ide-terminal-status" data-ide-terminal-status></span>'
        + '<span class="ide-terminal-toolbar-actions">'
        + buildToolbarButton('signal', '^C', 'Stop the running command (kills and ends the session)')
        + buildToolbarButton('clear', 'Clear', 'Clear scrollback')
        + buildToolbarButton('restart', 'Restart', 'Restart the shell session')
        + '</span>'
        + '</div>'
        + '<pre class="ide-terminal-scrollback" data-ide-terminal-scrollback role="log" aria-live="polite" aria-relevant="additions text" tabindex="0"></pre>'
        + '<div class="ide-terminal-input">'
        + textField({
          className: 'ide-terminal-field',
          placeholder: 'Type a command and press Enter…',
          ariaLabel: 'Terminal command input',
          dataset: { 'ide-terminal-input': '1' },
        })
        + '</div>'
        + '</div>';
    }

    function renderTerminalPanel() {
      const panel = getMountEl();
      if (!panel || !isActivePanel()) {
        return;
      }
      if (panel.__jennyIdeRailMarkup !== PANEL_MARKUP_SENTINEL) {
        panel.innerHTML = buildPanelMarkup();
        panel.__jennyIdeRailMarkup = PANEL_MARKUP_SENTINEL;
      }
      painter.sync(); // collapse any pending frame so the DOM is current
      syncStatus();
    }

    async function startSessionOnce(api) {
      if (typeof api?.start !== 'function') {
        appendOutput('[terminal] Terminal access is unavailable in this shell mode.\n');
        return false;
      }
      try {
        const result = await api.start();
        const startedId = String(result?.sessionId || '');
        if (!startedId) {
          // A session with no id leaves isRunning() false while the service
          // believes it started: surface it as a failure so the next Enter
          // does not silently re-start onto an unknown session.
          showError('The terminal session could not be started (no session id).', {
            title: 'Terminal',
            dedupeKey: 'ide:terminal:start',
          });
          appendClientLog('WARN', 'ide.terminal_start_no_session', {});
          appendOutput('[terminal] Could not start the terminal (no session id).\n');
          return false;
        }
        sessionId = startedId;
        sessionShell = String(result?.shell || '');
        sessionCwd = String(result?.cwd || '');
        appendOutput(`[terminal] ${result?.shell || 'shell'} session started in ${result?.cwd || ''}\n`);
      } catch (error) {
        showError(toErrorMessage(error, 'Could not start the terminal.'), {
          title: 'Terminal',
          dedupeKey: 'ide:terminal:start',
        });
        appendClientLog('WARN', 'ide.terminal_start_failed', {
          message: String(error?.message || error || ''),
        });
        return false;
      } finally {
        starting = false;
        startPromise = null;
      }
      syncStatus();
      return true;
    }

    function startSession() {
      if (isRunning()) {
        return Promise.resolve(false);
      }
      if (startPromise) {
        return startPromise;
      }
      starting = true;
      startPromise = startSessionOnce(getApi());
      return startPromise;
    }

    async function sendCommand(commandOrBuilder) {
      try {
        if (!isRunning() && !(await startSession())) {
          return false;
        }
        const api = getApi();
        if (typeof api?.write !== 'function') {
          return false;
        }
        const command = typeof commandOrBuilder === 'function'
          ? commandOrBuilder(sessionShell, sessionCwd)
          : commandOrBuilder;
        await api.write({ sessionId, data: `${String(command || '')}\r\n` });
        return true;
      } catch (_error) {
        return false;
      }
    }

    async function submitCommand(inputEl) {
      const command = String(inputEl?.value || '');
      if (!command.trim()) {
        return;
      }
      if (!isRunning()) {
        const started = await startSession();
        if (!started) {
          return;
        }
      }
      const api = getApi();
      appendOutput(`> ${command}\n`);
      if (String(inputEl.value || '') === command) inputEl.value = '';
      try {
        await api.write({ sessionId, data: `${command}\r\n` });
      } catch (error) {
        appendOutput(`[terminal] ${toErrorMessage(error, 'Write failed.')}\n`);
      }
    }

    async function signalSession() {
      const api = getApi();
      if (!isRunning() || typeof api?.signal !== 'function') {
        return;
      }
      appendOutput('^C\n');
      try {
        await api.signal({ sessionId });
      } catch (error) {
        appendOutput(`[terminal] ${toErrorMessage(error, 'Signal failed.')}\n`);
      }
    }

    async function restartSession() {
      const api = getApi();
      if (isRunning() && typeof api?.kill === 'function') {
        try {
          await api.kill({ sessionId });
        } catch (_error) {
          /* exit event clears state regardless */
        }
        sessionId = '';
      }
      clearScrollback();
      await startSession();
    }

    function handleData(payload) {
      if (!payload || String(payload.sessionId || '') !== sessionId) {
        return;
      }
      appendOutput(payload.chunk, payload.droppedBytes);
    }

    function handleExit(payload) {
      const exitedId = String(payload?.sessionId || '');
      if (exitedId && exitedId !== sessionId) {
        return;
      }
      sessionId = '';
      // The dead process can never finish an escape sequence it left open —
      // reset before the exit banner so a dangling CSI/OSC never swallows it.
      ansiStripper.reset();
      const code = payload?.code === null || payload?.code === undefined ? '' : ` (code ${payload.code})`;
      appendOutput(`[terminal] session ended${code}\n`);
      syncStatus();
    }

    function handleClick(event) {
      if (!isActivePanel()) {
        return;
      }
      const action = event.target?.closest?.('[data-ide-terminal-action]');
      if (!action) {
        return;
      }
      const kind = action.dataset.ideTerminalAction;
      if (kind === 'clear') {
        clearScrollback();
      } else if (kind === 'signal') {
        signalSession();
      } else if (kind === 'restart') {
        restartSession();
      }
    }

    function handleKeydown(event) {
      if (!isActivePanel()) {
        return;
      }
      const input = event.target?.closest?.('[data-ide-terminal-input]');
      if (!input) {
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        submitCommand(input);
      } else if (event.key === 'c' && event.ctrlKey && !event.shiftKey && !event.altKey
        && !String(input.value || '')) {
        // Ctrl+C with an empty input = interrupt; with text it stays copy.
        event.preventDefault();
        signalSession();
      }
    }

    function bindEvents() {
      const panel = getMountEl();
      if (!panel || boundPanel) {
        return;
      }
      boundPanel = panel;
      panel.addEventListener('click', handleClick);
      panel.addEventListener('keydown', handleKeydown);
      const api = getApi();
      if (!unsubscribeData && typeof api?.onData === 'function') {
        unsubscribeData = api.onData(handleData) || null;
      }
      if (!unsubscribeExit && typeof api?.onExit === 'function') {
        unsubscribeExit = api.onExit(handleExit) || null;
      }
    }

    function dispose() {
      painter.cancel();
      if (boundPanel) {
        boundPanel.removeEventListener('click', handleClick);
        boundPanel.removeEventListener('keydown', handleKeydown);
        boundPanel = null;
      }
      try {
        unsubscribeData?.();
      } catch (_error) { /* already gone */ }
      unsubscribeData = null;
      try {
        unsubscribeExit?.();
      } catch (_error) { /* already gone */ }
      unsubscribeExit = null;
      // The session itself is main-process-owned; leaving the view does not
      // kill it (the awaited shutdown sequence and explicit Restart/^C do).
    }

    return {
      bindEvents,
      dispose,
      isRunning,
      renderTerminalPanel,
      sendCommand,
      startSession,
    };
  }

  return {
    createIdeTerminalPanel,
  };
});
