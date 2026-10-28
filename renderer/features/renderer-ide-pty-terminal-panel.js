/* renderer/features/renderer-ide-pty-terminal-panel.js — flag-gated,
 * explicit-start ConPTY/xterm terminal for the Workspace IDE bottom panel.
 * Terminal and fit-addon constructors are injectable for tests. Disposal kills
 * the main-process session so late spawn completion cannot orphan it. The xterm
 * host lives in renderer-ide-pty-terminal-xterm.js and the bridge streams in
 * renderer-ide-pty-terminal-io.js; this file owns the session lifecycle, the
 * status line and the toolbar. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePtyTerminalPanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const PANEL_MARKUP_SENTINEL = '__jenny-ide-pty-terminal__';
  const ROOT_COMMITTED_EVENT = 'ide:workspace-root-committed';

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    // Node/test path only; the required paths are fixed in-repo modules, so a
    // load failure is a real defect and must surface.
    if (typeof require === 'function') {
      return require(requirePath);
    }
    return {};
  }

  const ptyIo = resolveModule('rendererIdePtyTerminalIo', './renderer-ide-pty-terminal-io');
  const ptyXterm = resolveModule('rendererIdePtyTerminalXterm', './renderer-ide-pty-terminal-xterm');

  function createIdePtyTerminalPanel(deps) {
    // Workspace terminal slot 1..4 (the main process keys sessions by slot);
    // sent in every spawn so a second terminal never attaches to the first.
    const slotDep = Math.floor(Number(deps?.slot));
    const slot = slotDep >= 1 && slotDep <= 4 ? slotDep : 1;
    const onSessionChange = typeof deps?.onSessionChange === 'function' ? deps.onSessionChange : null;
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const escapeHtml = typeof deps?.escapeHtml === 'function' ? deps.escapeHtml : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
    const getMountEl = typeof deps?.getMountEl === 'function' ? deps.getMountEl : () => null;
    const isActivePanel = typeof deps?.isActivePanel === 'function'
      ? deps.isActivePanel
      : () => getIde().bottomPanelActiveView === 'terminal';
    const getApi = typeof deps?.getWorkspacePtyApi === 'function' ? deps.getWorkspacePtyApi : () => null;
    const showError = typeof deps?.showError === 'function' ? deps.showError : noop;
    const toErrorMessage = typeof deps?.toErrorMessage === 'function'
      ? deps.toErrorMessage
      : (error, fallback) => String(error?.message || error || fallback || '');
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    // A best-effort host/xterm/bridge call failed: keep the panel alive, but leave a trace.
    function logIgnoredError(site, error) {
      appendClientLog('DEBUG', 'ide.pty_ignored_error', { site, error: String(error?.message || error || '') });
    }
    const windowRef = deps?.windowRef || globalRef.window || globalRef;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    // UIUX-024: xterm.js/addon-fit.js are no longer eager <script> tags — they
    // load on first real Start (never in tests, which inject createTerminal/
    // createFitAddon fakes and so never touch the vendor loader).
    const xtermLoader = resolveModule('rendererIdeXtermLoader', './renderer-ide-xterm-loader');
    const terminalStreamUtils = resolveModule('rendererTerminalStreamUtils', '../shared/terminal-stream-utils');
    // UIUX-035: frame scheduler for the coalesced write queue: injected fakes in
    // tests, the real rAF on windowRef, else a synchronous callback so output is
    // never silently held back forever.
    const { requestFrame, cancelFrame } = terminalStreamUtils.resolveFrameScheduler(deps, windowRef);
    const markStartupAudit = typeof deps?.markStartupAudit === 'function'
      ? deps.markStartupAudit
      : (name, details) => { try { globalRef.__jennyStartupAudit?.mark?.(name, details); } catch (error) { logIgnoredError('startup_audit_mark', error); } };

    let boundPanel = null;
    let sessionId = '';
    let sessionShell = '';
    let sessionCwd = '';
    let starting = false;
    let restartPromise = null;
    let statusMessage = '';
    let disposed = false;
    let lifecycleEpoch = 0;
    // Set when main could not confirm a Stop/Restart killed the shell (or the
    // kill request was rejected): its own status, never collapsed into
    // 'stopped'. Cleared by a new session or that session's late exit event.
    let unconfirmedSessionId = '';

    const getSessionId = () => sessionId;
    const io = ptyIo.createPtyTerminalIo({
      slot,
      getApi,
      getSessionId,
      getSessionShell: () => sessionShell,
      getSessionCwd: () => sessionCwd,
      isBuffering,
      ensureStarted: () => startSession(),
      onData: applyDataEvent,
      onExit: applyExitEvent,
      terminalStreamUtils,
      appendClientLog,
      logIgnoredError,
    });
    const xterm = ptyXterm.createPtyTerminalXterm({
      deps: deps || {},
      windowRef,
      getMount,
      getFindHost: () => getPanelEl()?.querySelector?.('[data-ide-terminal-find]') || null,
      getApi,
      getSessionId,
      // Links resolve against the workspace root; a sub-folder session prints paths
      // relative to its cwd (the root itself until T2's folder starts, or without a root).
      getRootPath: () => String(deps?.getWorkspaceRootPath?.() || sessionCwd),
      getCwdPath: () => sessionCwd,
      onUserInput: (data) => io.writeKeystrokes(data),
      onClear: () => clearTerminal(),
      onWriteDropped: () => syncStatus(),
      markStartupAudit,
      appendClientLog,
      logIgnoredError,
      requestFrame,
      cancelFrame,
      xtermLoader,
    });

    function isRunning() {
      return Boolean(sessionId);
    }

    // Fires deps.onSessionChange(sessionId) when this panel's session id changes
    // ('' = ended); deduped so every start/end path may call it freely.
    let notifiedSessionId = '';
    function notifySession() {
      if (!onSessionChange || notifiedSessionId === sessionId) {
        return;
      }
      notifiedSessionId = sessionId;
      try { onSessionChange(sessionId); } catch (error) { logIgnoredError('session_change', error); }
    }

    function getPanelEl() {
      const panel = getMountEl();
      if (!panel || !isActivePanel()) {
        return null;
      }
      return panel;
    }

    function syncStatus() {
      const panel = getPanelEl();
      const status = panel?.querySelector?.('[data-ide-terminal-status]') || null;
      if (status) {
        const unconfirmed = !isRunning() && Boolean(unconfirmedSessionId);
        const base = statusMessage || (isRunning()
          ? 'running'
          : (unconfirmed ? jt('ide.runScripts.statusStopUnconfirmed', 'stop unconfirmed') : 'stopped'));
        // UIUX-035: a counted, visible indicator once the write queue has had
        // to drop anything — never silent data loss (AGENTS.md section 9).
        const dropped = xterm.getDropStats();
        status.textContent = dropped.events > 0
          ? jt('ide.ptyTerminal.outputDropped', '{status} · output dropped ({bytes}B)', { status: base, bytes: dropped.bytes })
          : base;
        status.classList.toggle('ide-terminal-status--running', isRunning());
        status.classList.toggle('ide-terminal-status--warn', unconfirmed);
        status.dataset.ptyWriteDroppedEvents = String(dropped.events);
        status.dataset.ptyWriteDroppedBytes = String(dropped.bytes);
      }
    }

    function setStatusMessage(message) {
      statusMessage = String(message || '');
      syncStatus();
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
      if (typeof actionButton !== 'function') {
        return '<div class="ide-rail-placeholder">' + escapeHtml(jt('ide.ptyTerminal.unavailable', 'Terminal is unavailable in this shell mode.')) + '</div>';
      }
      return '<div class="ide-terminal-panel">'
        + '<div class="ide-terminal-toolbar">'
        + '<span class="ide-terminal-status" data-ide-terminal-status></span>'
        + '<span class="ide-terminal-toolbar-actions">'
        + buildToolbarButton('start', 'Start', jt('ide.ptyTerminal.startSession', 'Start a terminal session'))
        + buildToolbarButton('signal', '^C', jt('ide.ptyTerminal.sendInterrupt', 'Send an interrupt (Ctrl+C) to the running command'))
        + buildToolbarButton('clear', 'Clear', jt('ide.ptyTerminal.clear', 'Clear the terminal'))
        + buildToolbarButton('restart', 'Restart', jt('ide.ptyTerminal.restartSession', 'Restart the terminal session'))
        + '</span>'
        + '</div>'
        + '<div class="ide-terminal-find" data-ide-terminal-find hidden></div>'
        + '<div class="ide-terminal-xterm" data-ide-pty-mount></div>'
        + '</div>';
    }

    function getMount() {
      const panel = getPanelEl();
      return panel?.querySelector?.('[data-ide-pty-mount]') || null;
    }

    function renderTerminalPanel() {
      const panel = getMountEl();
      if (!panel || !isActivePanel()) {
        return;
      }
      // UIUX-011: a sibling's innerHTML swap can wipe the xterm host without
      // clearing this node-property sentinel, so re-check the live child too.
      const markupIntact = panel.__jennyIdePtyMarkup === PANEL_MARKUP_SENTINEL
        && Boolean(panel.querySelector?.('[data-ide-pty-mount]'));
      if (!markupIntact) {
        panel.innerHTML = buildPanelMarkup();
        panel.__jennyIdePtyMarkup = PANEL_MARKUP_SENTINEL;
        xterm.forgetMount(); // markup was (re)built; the xterm host must be re-attached
      }
      xterm.renderHost(getMount());
      syncStatus();
    }

    // Buffering while a spawn is in flight and our session id is still unknown;
    // replay re-matches each event by its own carried sessionId (defensive).
    function isBuffering() {
      return starting === true && !sessionId;
    }

    function applyDataEvent(payload) {
      if (payload && !io.isOtherSlot(payload) && String(payload.sessionId || '') === sessionId && xterm.hasTerminal()) {
        xterm.queueWrite(payload.data);
      }
    }

    function applyExitEvent(payload) {
      if (io.isOtherSlot(payload)) {
        return;
      }
      const exitedId = String(payload?.sessionId || '');
      if (exitedId && exitedId === unconfirmedSessionId) {
        // The shell an unconfirmed Stop left behind has now really exited.
        unconfirmedSessionId = '';
        syncStatus();
        return;
      }
      if (exitedId && exitedId !== sessionId) {
        return;
      }
      // Data queued this same frame must render BEFORE the exit banner, not
      // after it — flush the coalesced write queue synchronously first.
      xterm.flushPendingWrites();
      sessionId = '';
      notifySession();
      const code = payload?.exitCode == null ? '' : jt('ide.ptyTerminal.exitCode', ' (code {code})', { code: payload.exitCode });
      xterm.writeBanner('\r\n' + jt('ide.ptyTerminal.sessionEnded', '[terminal] session ended{code}', { code }));
      setStatusMessage('');
    }

    // An unconfirmed kill of `id` shows on this panel unless a newer lifecycle
    // (a start, a root switch, dispose) took the panel over meanwhile.
    function settleKill(id, site, epoch) {
      return io.killSession(id, site).then((confirmed) => {
        if (!confirmed) {
          appendClientLog('WARN', 'ide.pty_kill_unconfirmed', { site });
          if (!disposed && epoch === lifecycleEpoch && !sessionId) {
            unconfirmedSessionId = id;
            syncStatus();
          }
        }
        return confirmed;
      });
    }

    // Every start failure funnels here: paint a status word, log a WARN, and show
    // a deduped toast. Returns false so callers can `return failStart(...)`.
    function failStart(status, logCode, message, extra) {
      setStatusMessage(status);
      appendClientLog('WARN', logCode, extra || {});
      showError(message, { title: jt('ide.terminal.title', 'Terminal'), dedupeKey: 'ide:pty:start' });
      return false;
    }

    // startSession(opts?): opts.cwd (root-relative start folder) and opts.profileId
    // (shell id) are remembered for Restart; the default shell is the Settings pick.
    let startOptions = {};
    async function startSession(opts) {
      if (disposed || isRunning() || starting) {
        return false;
      }
      if (opts && typeof opts === 'object') {
        startOptions = { cwd: typeof opts.cwd === 'string' ? opts.cwd : '', profileId: typeof opts.profileId === 'string' ? opts.profileId : '' };
      }
      const api = getApi();
      if (!api || typeof api.spawn !== 'function') {
        return failStart('unavailable', 'ide.pty_start_unavailable',
          jt('ide.ptyTerminal.ptyUnavailable', 'The PTY terminal is not available in this shell mode.'));
      }
      starting = true;
      const epoch = lifecycleEpoch;
      // UIUX-024: xterm.js/addon-fit.js load lazily on the first real Start.
      if (xterm.needsRuntimeLoad()) {
        const xtermReady = await xterm.ensureRuntime();
        if (disposed || epoch !== lifecycleEpoch) {
          starting = false;
          return false;
        }
        if (!xtermReady) {
          starting = false;
          return failStart('unavailable', 'ide.pty_start_unavailable',
            jt('ide.ptyTerminal.runtimeLoadFailed', 'The terminal runtime could not be loaded. Check your connection and try again.'));
        }
      }
      // UIUX-011: subscribe BEFORE spawn (main wires forwarding inside spawn(),
      // before replying); early events land in the pre-ready buffer.
      io.subscribe(api);
      try {
        xterm.ensureTerminal();
        xterm.attach(getMount());
        // Theme + mono font apply via term.options now that the host exists,
        // then track palette/typography switches for the terminal's lifetime.
        xterm.applyAppearance();
        xterm.startAppearanceObserver();
        xterm.applyFit(); // fit-then-spawn: measure before we ask the pty for a size
        const { cols: spawnCols, rows: spawnRows } = xterm.getSize();
        const profileId = startOptions.profileId || String(getIde()?.terminalDefaultProfile || '');
        const result = await api.spawn(Object.assign({ cols: spawnCols, rows: spawnRows, slot },
          profileId ? { profileId } : null, startOptions.cwd ? { cwd: startOptions.cwd } : null));
        if (disposed || epoch !== lifecycleEpoch) {
          const lateSessionId = String(result?.sessionId || '');
          if (lateSessionId) {
            // A superseded lifecycle owns the row; an unconfirmed kill only logs.
            await settleKill(lateSessionId, 'kill_late', epoch);
          }
          return false;
        }
        if (!result || result.ok === false) {
          const message = toErrorMessage(result?.message, result?.code || jt('ide.ptyTerminal.startFailed', 'The terminal could not be started.'));
          startOptions = { profileId: startOptions.profileId || '' }; // a refused folder is not retried on the next Start
          return failStart('failed', 'ide.pty_start_failed', message, { code: String(result?.code || ''), message });
        }
        sessionId = String(result.sessionId || '');
        if (!sessionId) {
          return failStart('failed', 'ide.pty_start_no_session',
            jt('ide.ptyTerminal.noSessionId', 'The terminal session could not be started (no session id).'));
        }
        unconfirmedSessionId = '';
        sessionShell = String(result.shell || '');
        sessionCwd = String(result.cwd || '');
        // A fresh spawn used this size; an attach to an already-running PTY did
        // not resize it, so leave the cache empty and let the resize below correct it.
        const spawnedAtSize = result.alreadyRunning !== true;
        xterm.setSentSize(spawnedAtSize ? spawnCols : 0, spawnedAtSize ? spawnRows : 0);
        io.replayPreReady();
        if (!sessionId) {
          // A buffered exit for this session replayed above (it ended before we
          // finished subscribing) — settle as not-running rather than reporting
          // a start that is already over. applyExitEvent already wrote the
          // session-ended line and cleared status.
          return false;
        }
        notifySession();
        setStatusMessage('');
        xterm.applyFitAndResize();
        return true;
      } catch (error) {
        if (disposed || epoch !== lifecycleEpoch) return false;
        return failStart('failed', 'ide.pty_start_failed',
          toErrorMessage(error, jt('ide.ptyTerminal.startError', 'Could not start the terminal.')),
          { message: String(error?.message || error || '') });
      } finally {
        starting = false;
        if (!sessionId) {
          io.discardPreReady();
        }
      }
    }

    function clearTerminal() {
      // Discard any not-yet-flushed queued bytes so a Clear/Restart can never
      // be followed by stale pre-clear (or, on Restart, prior-session) output
      // reappearing on the next animation frame.
      xterm.discardWriteQueue();
      xterm.resetWriteDropCounters();
      xterm.clear();
      syncStatus();
    }

    function restartSession() {
      if (restartPromise) {
        return restartPromise;
      }
      restartPromise = (async () => {
        const api = getApi();
        if (isRunning() && api && typeof api.kill === 'function') {
          const dyingId = sessionId;
          sessionId = '';
          notifySession();
          // An unconfirmed kill leaves the shell possibly alive: a new spawn
          // would silently re-attach to it under a cleared terminal, so the
          // restart stops here and the status says so.
          if (!(await settleKill(dyingId, 'kill_restart', lifecycleEpoch))) {
            return false;
          }
        }
        clearTerminal();
        setStatusMessage('');
        return startSession();
      })();
      const release = () => { restartPromise = null; };
      restartPromise.then(release, release);
      return restartPromise;
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
      const focusWhenStarted = (started) => { if (started === true) focusTerminal(); };
      if (kind === 'start') {
        startSession().then(focusWhenStarted, noop);
      } else if (kind === 'signal') {
        io.sendInterrupt();
      } else if (kind === 'clear') {
        clearTerminal();
      } else if (kind === 'restart') {
        restartSession().then(focusWhenStarted, noop);
      }
    }

    // Focus the live xterm, else (no session yet) the Start button. Returns
    // true when focus landed; the bottom panel calls this on Ctrl+` / tab click.
    function focusTerminal() {
      if (xterm.focus()) {
        return true;
      }
      const start = getPanelEl()?.querySelector?.('[data-ide-terminal-action="start"]') || null;
      if (!start || typeof start.focus !== 'function') {
        return false;
      }
      start.focus();
      return start.ownerDocument?.activeElement === start;
    }

    // Kill this panel's own session and return to the pre-Start state (Stop /
    // Kill Terminal, and the workspace-root switch). Resolves whether the kill
    // was confirmed; an unconfirmed one shows as 'stop unconfirmed'.
    function stopSession(site = 'kill_stop') {
      if (disposed) {
        return Promise.resolve(true);
      }
      lifecycleEpoch += 1; // an in-flight spawn from before is killed on arrival
      const epoch = lifecycleEpoch;
      const dyingId = sessionId;
      sessionId = '';
      if (dyingId) unconfirmedSessionId = ''; // a bare Stop keeps an orphan warning
      notifySession();
      xterm.setSentSize(0, 0);
      io.discardPreReady();
      // On a root switch main normally killed it already (a no-op answer there).
      const settled = dyingId ? settleKill(dyingId, site, epoch) : Promise.resolve(true);
      xterm.discardWriteQueue();
      xterm.resetWriteDropCounters();
      xterm.reset();
      setStatusMessage('');
      return settled;
    }

    // Main kills the PTY on a workspace-root switch; drop the old workspace's
    // scrollback and return to the pre-Start state so the new root starts clean.
    function resetForRoot() {
      if (!disposed) unconfirmedSessionId = ''; // root-owned UI state clears synchronously
      startOptions = {}; // a remembered folder or profile belongs to the old root
      stopSession('kill_root_switch');
    }

    if (typeof windowRef?.addEventListener === 'function') {
      windowRef.addEventListener(ROOT_COMMITTED_EVENT, resetForRoot);
    }

    function bindEvents() {
      const panel = getMountEl();
      if (disposed || !panel || boundPanel) {
        return;
      }
      boundPanel = panel;
      panel.addEventListener('click', handleClick);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      lifecycleEpoch += 1;
      try { windowRef?.removeEventListener?.(ROOT_COMMITTED_EVENT, resetForRoot); } catch (error) { logIgnoredError('unbind_root_committed', error); }
      io.discardPreReady();
      if (boundPanel) {
        boundPanel.removeEventListener('click', handleClick);
        boundPanel = null;
      }
      io.unsubscribe();
      xterm.dispose();
      const dyingId = sessionId;
      sessionId = '';
      notifySession();
      // The panel is gone: an unconfirmed kill is logged (settleKill's WARN).
      if (dyingId) settleKill(dyingId, 'kill_dispose', lifecycleEpoch);
    }

    return {
      bindEvents,
      // Terminal: Clear / Terminal: Find palette rows (row 82 T1).
      clear: () => clearTerminal(),
      dispose,
      focusTerminal,
      getSessionId,
      getSlot: () => slot,
      isRunning,
      openFind: () => xterm.openFind(),
      renderTerminalPanel,
      resetForRoot,
      sendCommand: (commandOrBuilder) => io.sendCommand(commandOrBuilder),
      startSession,
      // Kill this panel's own session and return to the not-started state;
      // resolves whether main confirmed the kill.
      stopSession: () => stopSession(),
    };
  }

  return {
    SEND_COMMAND_MAX_BYTES: ptyIo.SEND_COMMAND_MAX_BYTES,
    createIdePtyTerminalPanel,
  };
});
