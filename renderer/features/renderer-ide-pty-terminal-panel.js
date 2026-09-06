/* renderer/features/renderer-ide-pty-terminal-panel.js — flag-gated,
 * explicit-start ConPTY/xterm terminal for the Workspace IDE bottom panel.
 * Terminal and fit-addon constructors are injectable for tests. Disposal kills
 * the main-process session so late spawn completion cannot orphan it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePtyTerminalPanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const PANEL_MARKUP_SENTINEL = '__jenny-ide-pty-terminal__';
  const INTERRUPT_BYTE = String.fromCharCode(3); // Ctrl+C
  const RESIZE_DEBOUNCE_MS = 50;
  // UIUX-011: main can emit output/exit the instant a session is wired (spawn()
  // wires listeners synchronously before its IPC reply is sent), so events that
  // land before the renderer knows its own session id are held here and replayed
  // in order the moment spawn resolves. Bounded per AGENTS.md section 9 (resource
  // bounds + retention): oldest-entry eviction with a visible dropped counter.
  const PRE_READY_BUFFER_MAX_EVENTS = 64;
  const PRE_READY_BUFFER_MAX_BYTES = 64 * 1024; // mirrors workspace-pty-service.js MAX_CHUNK_BYTES
  // UIUX-035: every PTY output event used to cross IPC and land as its own
  // `term.write()` call — a chatty producer (a build, a verbose test run)
  // means one xterm reflow/paint per IPC message with no aggregate backpressure.
  // Queue incoming bytes and flush them in one coalesced `term.write()` per
  // animation frame (~16ms), same rAF-coalescing shape as the legacy line
  // panel's paint scheduler. Bounded per AGENTS.md section 9: a hard byte cap
  // with oldest-entry eviction and a visible dropped-output counter — this
  // queue never grows unbounded even under a runaway producer.
  const WRITE_QUEUE_MAX_BYTES = 256 * 1024;

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

  function createIdePtyTerminalPanel(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getMountEl = typeof deps?.getMountEl === 'function'
      ? deps.getMountEl
      : () => getDom().ideBottomPanelContent || null;
    const isActivePanel = typeof deps?.isActivePanel === 'function'
      ? deps.isActivePanel
      : () => getIde().bottomPanelActiveView === 'terminal';
    const getApi = typeof deps?.getWorkspacePtyApi === 'function'
      ? deps.getWorkspacePtyApi
      : () => null;
    const showError = typeof deps?.showError === 'function' ? deps.showError : noop;
    const toErrorMessage = typeof deps?.toErrorMessage === 'function'
      ? deps.toErrorMessage
      : (error, fallback) => String(error?.message || error || fallback || '');
    const appendClientLog = typeof deps?.appendClientLog === 'function' ? deps.appendClientLog : noop;
    // xterm + fit-addon come from the vendored UMD globals in the real app; tests
    // inject fakes (jsdom cannot host xterm). The fit-addon UMD global is
    // `FitAddon` carrying a `FitAddon` class property — guard both shapes.
    const usesInjectedTerminalFactory = typeof deps?.createTerminal === 'function';
    const createTerminal = usesInjectedTerminalFactory
      ? deps.createTerminal
      : (opts) => new globalRef.Terminal(opts);
    const createFitAddon = typeof deps?.createFitAddon === 'function'
      ? deps.createFitAddon
      : () => new (globalRef.FitAddon?.FitAddon || globalRef.FitAddon)();
    const windowRef = deps?.windowRef || globalRef.window || globalRef;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    // UIUX-035: frame scheduler for the coalesced write queue. Tests inject
    // deterministic fakes (mirroring the legacy line panel's paint scheduler);
    // production falls back to the real rAF on windowRef, and — when no rAF
    // exists at all (very old/headless hosts) — a synchronous callback so
    // output is never silently held back forever.
    const requestFrame = typeof deps?.requestAnimationFrameImpl === 'function'
      ? deps.requestAnimationFrameImpl
      : (typeof windowRef?.requestAnimationFrame === 'function'
          ? windowRef.requestAnimationFrame.bind(windowRef)
          : (callback) => { callback(0); return null; });
    const cancelFrame = typeof deps?.cancelAnimationFrameImpl === 'function'
      ? deps.cancelAnimationFrameImpl
      : (typeof windowRef?.cancelAnimationFrame === 'function'
          ? windowRef.cancelAnimationFrame.bind(windowRef)
          : noop);
    // UIUX-024: xterm.js/addon-fit.js are no longer eager <script> tags — they
    // load on first real Start (never in tests, which inject createTerminal/
    // createFitAddon fakes above and so never touch the vendor loader).
    const xtermLoader = resolveModule('rendererIdeXtermLoader', './renderer-ide-xterm-loader');
    const terminalStreamUtils = resolveModule('rendererTerminalStreamUtils', '../shared/terminal-stream-utils');
    const markStartupAudit = typeof deps?.markStartupAudit === 'function'
      ? deps.markStartupAudit
      : (name, details) => { try { globalRef.__jennyStartupAudit?.mark?.(name, details); } catch (_error) { /* best effort */ } };
    let xtermFirstActivationMarked = false;
    // Synchronous fast-path check: true only when startSession() actually needs
    // to `await` a vendor-runtime load. Tests inject createTerminal/createFitAddon
    // fakes (usesInjectedTerminalFactory) and the second-and-later real Start in
    // a session both stay synchronous-until-spawn (no added microtask tick) —
    // matching the pre-existing "startSession runs synchronously up to its first
    // real await" contract several tests (wide-033, UIUX-011 pre-ready buffer
    // suite) rely on to capture the fake bridge's spawn resolve/reject inline.
    function needsXtermRuntimeLoad() {
      if (usesInjectedTerminalFactory) {
        return false;
      }
      if (xtermLoader && typeof xtermLoader.isXtermRuntimeReady === 'function') {
        return xtermLoader.isXtermRuntimeReady() !== true;
      }
      return false;
    }
    function ensureXtermReady() {
      if (!xtermFirstActivationMarked) {
        xtermFirstActivationMarked = true;
        markStartupAudit('ide-terminal-xterm-runtime-requested', {});
      }
      if (!xtermLoader || typeof xtermLoader.ensureXtermRuntime !== 'function') {
        // No loader module resolved (should not happen in production, where
        // renderer-ide-xterm-loader.js always precedes this file); fall
        // through so createTerminal()'s own `new globalRef.Terminal` throws
        // a clear error rather than silently hanging the Start action.
        return Promise.resolve(true);
      }
      return Promise.resolve(xtermLoader.ensureXtermRuntime()).then((ok) => {
        markStartupAudit('ide-terminal-xterm-runtime-ready', { ok: ok === true });
        return ok;
      });
    }

    let boundPanel = null;
    let term = null;
    let fitAddon = null;
    let mountedEl = null;
    let resizeObserver = null;
    let resizeTimer = null;
    let unsubscribeData = null;
    let unsubscribeExit = null;
    let sessionId = '';
    let sessionShell = '';
    let sessionCwd = '';
    let starting = false;
    let restartPromise = null;
    let statusMessage = '';
    let disposed = false;
    let lifecycleEpoch = 0;
    // Pre-ready buffering (UIUX-011) — see PRE_READY_BUFFER_MAX_* above.
    const preReadyEvents = terminalStreamUtils.createPreReadyEventBuffer({
      maxEvents: PRE_READY_BUFFER_MAX_EVENTS,
      maxBytes: PRE_READY_BUFFER_MAX_BYTES,
      sizeOf: (kind, payload) => (kind === 'data' ? String(payload?.data || '').length : 0),
      onDrop: (stats) => appendClientLog('WARN', 'ide.pty_prereadybuffer_dropped', stats),
    });
    // Coalesced write-queue state (UIUX-035) — see WRITE_QUEUE_MAX_BYTES above.
    let writeQueue = [];
    let writeQueueBytes = 0;
    let writeFrame = null;
    let writeDroppedEvents = 0;
    let writeDroppedBytes = 0;

    function isRunning() {
      return Boolean(sessionId);
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
        const base = statusMessage || (isRunning() ? 'running' : 'stopped');
        // UIUX-035: a counted, visible indicator once the write queue has had
        // to drop anything — never silent data loss (AGENTS.md section 9).
        status.textContent = writeDroppedEvents > 0
          ? `${base} · output dropped (${writeDroppedBytes}B)`
          : base;
        status.classList.toggle('ide-terminal-status--running', isRunning());
        status.dataset.ptyWriteDroppedEvents = String(writeDroppedEvents);
        status.dataset.ptyWriteDroppedBytes = String(writeDroppedBytes);
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
        return '<div class="ide-rail-placeholder">Terminal is unavailable in this shell mode.</div>';
      }
      return '<div class="ide-terminal-panel">'
        + '<div class="ide-terminal-toolbar">'
        + '<span class="ide-terminal-title">Terminal</span>'
        + '<span class="ide-terminal-status" data-ide-terminal-status></span>'
        + '<span class="ide-terminal-toolbar-actions">'
        + buildToolbarButton('start', 'Start', 'Start a terminal session')
        + buildToolbarButton('signal', '^C', 'Send an interrupt (Ctrl+C) to the running command')
        + buildToolbarButton('clear', 'Clear', 'Clear the terminal')
        + buildToolbarButton('restart', 'Restart', 'Restart the terminal session')
        + '</span>'
        + '</div>'
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
      // UIUX-011: assert the mount actually exists, not just that the sentinel
      // says it was built. On a shared/mutated host a sibling view's innerHTML
      // replacement wipes the xterm host child WITHOUT clearing this JS-property
      // sentinel (it lives on the node object, not the markup), so the sentinel
      // alone is not proof the host is intact — re-check the live child too.
      const markupIntact = panel.__jennyIdePtyMarkup === PANEL_MARKUP_SENTINEL
        && Boolean(panel.querySelector?.('[data-ide-pty-mount]'));
      if (!markupIntact) {
        panel.innerHTML = buildPanelMarkup();
        panel.__jennyIdePtyMarkup = PANEL_MARKUP_SENTINEL;
        mountedEl = null; // markup was (re)built; the xterm host must be re-attached
      }
      // Re-attach the live xterm to the (possibly new) host and re-measure on
      // re-activation. term.open is idempotent-guarded via mountedEl.
      const mount = getMount();
      if (term && mount) {
        if (mountedEl !== mount) {
          try { term.open(mount); } catch (_error) { /* jsdom/host quirk */ }
          mountedEl = mount;
          observeResize(mount);
        }
        applyFitAndResize();
      }
      syncStatus();
    }

    // Read the existing terminal CSS custom properties (bg/fg/cursor ONLY — v1
    // maps no palette) so the xterm matches the panel chrome. Returns null when
    // the tokens are unavailable so xterm keeps its own defaults.
    function buildTheme() {
      const host = mountedEl || getMount();
      if (!windowRef || typeof windowRef.getComputedStyle !== 'function' || !host) {
        return null;
      }
      let styles;
      try { styles = windowRef.getComputedStyle(host); } catch (_error) { return null; }
      const read = (name) => String(styles.getPropertyValue(name) || '').trim();
      const theme = {};
      const bg = read('--bg-base'); if (bg) { theme.background = bg; }
      const fg = read('--text-secondary'); if (fg) { theme.foreground = fg; }
      const cur = read('--accent'); if (cur) { theme.cursor = cur; }
      return Object.keys(theme).length ? theme : null;
    }

    function applyFit() {
      if (fitAddon && typeof fitAddon.fit === 'function') {
        try { fitAddon.fit(); } catch (_error) { /* host not measurable yet */ }
      }
    }

    function applyFitAndResize() {
      applyFit();
      const api = getApi();
      if (isRunning() && api && typeof api.resize === 'function' && term) {
        try {
          Promise.resolve(api.resize({ sessionId, cols: term.cols, rows: term.rows })).catch(() => {});
        } catch (_error) { /* a resize call must never derail render */ }
      }
    }

    function scheduleResize() {
      if (resizeTimer) {
        return;
      }
      const set = (windowRef && windowRef.setTimeout) || setTimeout;
      resizeTimer = set(() => { resizeTimer = null; applyFitAndResize(); }, RESIZE_DEBOUNCE_MS);
    }

    // UIUX-011: always follow the LIVE mount. The prior guard (`|| resizeObserver`)
    // created the observer once and never re-observed on reparent, so a rebuilt
    // host left the observer watching a detached (disconnected) element forever.
    // Disconnect any previous observation before observing the current mount so
    // there is always exactly one live target and no leaked entries.
    function observeResize(mount) {
      const RO = windowRef && windowRef.ResizeObserver;
      if (typeof RO !== 'function' || !mount) {
        return;
      }
      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch (_error) { /* already gone */ }
      } else {
        try {
          resizeObserver = new RO(() => scheduleResize());
        } catch (_error) {
          resizeObserver = null;
          return;
        }
      }
      try { resizeObserver.observe(mount); } catch (_error) { /* host not observable */ }
    }

    // Buffering while a spawn is in flight and we don't yet know our own session
    // id: `starting` is true from the top of startSession() until it settles
    // (success, failure, or a disposed/stale-epoch bail), and `sessionId` stays
    // '' until spawn resolves ok. Any onData/onExit heard in that window belongs
    // to the spawn currently in flight (the service is single-session), but is
    // matched again by its own carried sessionId at replay time (defensive).
    function isBuffering() {
      return starting === true && !sessionId;
    }

    function discardPreReadyBuffer() {
      preReadyEvents.discard();
    }

    function discardWriteQueue() {
      if (writeFrame !== null) {
        try { cancelFrame(writeFrame); } catch (_error) { /* already gone */ }
      }
      writeFrame = null;
      writeQueue = [];
      writeQueueBytes = 0;
    }

    function resetWriteDropCounters() {
      writeDroppedEvents = 0;
      writeDroppedBytes = 0;
    }

    function dropOldestWriteQueueEntry() {
      const dropped = writeQueue.shift();
      if (!dropped) {
        return;
      }
      writeQueueBytes -= dropped.length;
      writeDroppedBytes += dropped.length;
      writeDroppedEvents += 1;
    }

    function flushWriteQueue() {
      writeFrame = null;
      if (writeQueue.length === 0) {
        return;
      }
      const combined = writeQueue.join('');
      writeQueue = [];
      writeQueueBytes = 0;
      if (term) {
        term.write(combined);
      }
    }

    function scheduleWriteFlush() {
      if (writeFrame !== null) {
        return;
      }
      writeFrame = requestFrame(flushWriteQueue);
    }

    // Cancel any pending rAF-coalesced frame and flush the queue SYNCHRONOUSLY
    // right now (mirrors discardWriteQueue, but writes instead of dropping).
    // Used before the exit banner so already-queued output from the same
    // frame renders BEFORE "[terminal] session ended", never after it.
    function flushPendingWrites() {
      if (writeFrame !== null) {
        try { cancelFrame(writeFrame); } catch (_error) { /* already gone */ }
        writeFrame = null;
      }
      flushWriteQueue();
    }

    // UIUX-035: every output event used to call term.write() the instant it
    // crossed IPC — a chatty producer meant one xterm reflow per message with
    // no aggregate backpressure. Queue bytes here and flush them in one
    // coalesced write per animation frame instead, with a hard byte cap
    // (drop-oldest + a visible counter surfaced via syncStatus) so a runaway
    // producer can never grow this queue unbounded.
    function queueWrite(data) {
      const text = String(data == null ? '' : data);
      if (!text) {
        return;
      }
      let droppedNow = false;
      while (writeQueue.length > 0 && writeQueueBytes + text.length > WRITE_QUEUE_MAX_BYTES) {
        dropOldestWriteQueueEntry();
        droppedNow = true;
      }
      writeQueue.push(text);
      writeQueueBytes += text.length;
      if (droppedNow) {
        appendClientLog('WARN', 'ide.pty_writequeue_dropped', {
          droppedEvents: writeDroppedEvents,
          droppedBytes: writeDroppedBytes,
        });
        syncStatus();
      }
      scheduleWriteFlush();
    }

    function applyDataEvent(payload) {
      if (payload && String(payload.sessionId || '') === sessionId && term) {
        queueWrite(payload.data);
      }
    }

    function applyExitEvent(payload) {
      const exitedId = String(payload?.sessionId || '');
      if (exitedId && exitedId !== sessionId) {
        return;
      }
      // Data queued this same frame must render BEFORE the exit banner, not
      // after it — flush the coalesced write queue synchronously first.
      flushPendingWrites();
      sessionId = '';
      const code = payload?.exitCode == null ? '' : ` (code ${payload.exitCode})`;
      if (term) {
        try { term.writeln(`\r\n[terminal] session ended${code}`); } catch (_error) { /* term gone */ }
      }
      setStatusMessage('');
    }

    // Replay in arrival order once sessionId is known (called right after a
    // successful spawn). Reusing applyDataEvent/applyExitEvent means an exit
    // buffered ahead of trailing data naturally clears sessionId mid-replay, so
    // any data after it is correctly dropped (the session already ended) —
    // exactly the "exit-before-subscribe must settle, never false running" gate.
    function replayPreReadyBuffer() {
      for (const entry of preReadyEvents.drain()) {
        if (entry.kind === 'data') {
          applyDataEvent(entry.payload);
        } else if (entry.kind === 'exit') {
          applyExitEvent(entry.payload);
        }
      }
    }

    function subscribeBridge(api) {
      if (!unsubscribeData && typeof api.onData === 'function') {
        unsubscribeData = api.onData((payload) => {
          if (isBuffering()) {
            preReadyEvents.push('data', payload);
            return;
          }
          applyDataEvent(payload);
        }) || null;
      }
      if (!unsubscribeExit && typeof api.onExit === 'function') {
        unsubscribeExit = api.onExit((payload) => {
          if (isBuffering()) {
            preReadyEvents.push('exit', payload);
            return;
          }
          applyExitEvent(payload);
        }) || null;
      }
    }

    function ensureTerminal() {
      if (term) {
        return term;
      }
      // theme is applied after the host exists (buildTheme, in startSession).
      term = createTerminal({ convertEol: false, cursorBlink: true, scrollback: 1000 });
      fitAddon = createFitAddon();
      if (fitAddon && typeof term.loadAddon === 'function') {
        try { term.loadAddon(fitAddon); } catch (_error) { /* addon optional */ }
      }
      if (typeof term.onData === 'function') {
        // USER KEYSTROKES and sendCommand() are the only sanctioned api.write callers.
        term.onData((data) => {
          const api = getApi();
          if (sessionId && api && typeof api.write === 'function') {
            try { Promise.resolve(api.write({ sessionId, data })).catch(() => {}); } catch (_error) { /* noop */ }
          }
        });
      }
      return term;
    }

    // Every start failure funnels here: paint a status word, log a WARN, and show
    // a deduped toast. Returns false so callers can `return failStart(...)`.
    function failStart(status, logCode, message, extra) {
      setStatusMessage(status);
      appendClientLog('WARN', logCode, extra || {});
      showError(message, { title: 'Terminal', dedupeKey: 'ide:pty:start' });
      return false;
    }

    async function startSession() {
      if (disposed || isRunning() || starting) {
        return false;
      }
      const api = getApi();
      if (!api || typeof api.spawn !== 'function') {
        return failStart('unavailable', 'ide.pty_start_unavailable',
          'The PTY terminal is not available in this shell mode.');
      }
      starting = true;
      const epoch = lifecycleEpoch;
      // UIUX-024: xterm.js/addon-fit.js load lazily on first real Start (see
      // ensureXtermReady above); a Chat-only session never pays this cost, and
      // an already-loaded/test-injected terminal factory adds zero microtask
      // ticks (needsXtermRuntimeLoad() stays false), so this only awaits on
      // an actual cold-start vendor-script load.
      if (needsXtermRuntimeLoad()) {
        const xtermReady = await ensureXtermReady();
        if (disposed || epoch !== lifecycleEpoch) {
          starting = false;
          return false;
        }
        if (!xtermReady) {
          starting = false;
          return failStart('unavailable', 'ide.pty_start_unavailable',
            'The terminal runtime could not be loaded. Check your connection and try again.');
        }
      }
      // UIUX-011: subscribe BEFORE calling spawn, not after it resolves. Main
      // wires the pty's data/exit forwarding synchronously inside spawn(), before
      // its IPC reply is sent, so a subscribe-after-await renderer can miss
      // immediate output or an immediate exit. Events heard before we know our
      // own session id land in the bounded pre-ready buffer above and replay in
      // order the moment spawn resolves.
      subscribeBridge(api);
      try {
        ensureTerminal();
        const mount = getMount();
        if (mount && mountedEl !== mount) {
          try { term.open(mount); } catch (_error) { /* host quirk */ }
          mountedEl = mount;
          observeResize(mount);
        }
        // A theme built now (host exists) applies via term.options in xterm >=4;
        // guard the setter so a fake/older term never throws.
        const theme = buildTheme();
        if (theme && term && term.options && typeof term.options === 'object') {
          try { term.options.theme = theme; } catch (_error) { /* readonly options */ }
        }
        applyFit(); // fit-then-spawn: measure before we ask the pty for a size
        const result = await api.spawn({ cols: term.cols, rows: term.rows });
        if (disposed || epoch !== lifecycleEpoch) {
          const lateSessionId = String(result?.sessionId || '');
          if (lateSessionId && typeof api.kill === 'function') {
            try { await api.kill({ sessionId: lateSessionId }); } catch (_error) { /* main owns refusal logging */ }
          }
          return false;
        }
        if (result && result.available === false) {
          return failStart('not enabled', 'ide.pty_not_enabled',
            'The PTY terminal is not enabled. Enable workspace_pty_terminal to use it.');
        }
        if (!result || result.ok === false) {
          const message = toErrorMessage(result?.message, result?.code || 'The terminal could not be started.');
          return failStart('failed', 'ide.pty_start_failed', message, { code: String(result?.code || ''), message });
        }
        sessionId = String(result.sessionId || '');
        if (!sessionId) {
          return failStart('failed', 'ide.pty_start_no_session',
            'The terminal session could not be started (no session id).');
        }
        sessionShell = String(result.shell || '');
        sessionCwd = String(result.cwd || '');
        replayPreReadyBuffer();
        if (!sessionId) {
          // A buffered exit for this session replayed above (it ended before we
          // finished subscribing) — settle as not-running rather than reporting
          // a start that is already over. applyExitEvent already wrote the
          // session-ended line and cleared status.
          return false;
        }
        setStatusMessage('');
        applyFitAndResize();
        return true;
      } catch (error) {
        if (disposed || epoch !== lifecycleEpoch) return false;
        return failStart('failed', 'ide.pty_start_failed',
          toErrorMessage(error, 'Could not start the terminal.'),
          { message: String(error?.message || error || '') });
      } finally {
        starting = false;
        if (!sessionId) {
          discardPreReadyBuffer();
        }
      }
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

    function sendInterrupt() {
      const api = getApi();
      if (!isRunning() || !api || typeof api.write !== 'function') {
        return;
      }
      try { Promise.resolve(api.write({ sessionId, data: INTERRUPT_BYTE })).catch(() => {}); } catch (_error) { /* noop */ }
    }

    function clearTerminal() {
      // Discard any not-yet-flushed queued bytes so a Clear/Restart can never
      // be followed by stale pre-clear (or, on Restart, prior-session) output
      // reappearing on the next animation frame.
      discardWriteQueue();
      resetWriteDropCounters();
      if (term && typeof term.clear === 'function') {
        try { term.clear(); } catch (_error) { /* noop */ }
      }
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
          try { await api.kill({ sessionId: dyingId }); } catch (_error) { /* exit event settles state */ }
        }
        clearTerminal();
        setStatusMessage('');
        await startSession();
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
      if (kind === 'start') {
        startSession();
      } else if (kind === 'signal') {
        sendInterrupt();
      } else if (kind === 'clear') {
        clearTerminal();
      } else if (kind === 'restart') {
        restartSession();
      }
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
      discardPreReadyBuffer();
      discardWriteQueue();
      if (boundPanel) {
        boundPanel.removeEventListener('click', handleClick);
        boundPanel = null;
      }
      try { unsubscribeData?.(); } catch (_error) { /* already gone */ }
      unsubscribeData = null;
      try { unsubscribeExit?.(); } catch (_error) { /* already gone */ }
      unsubscribeExit = null;
      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch (_error) { /* already gone */ }
        resizeObserver = null;
      }
      if (resizeTimer) {
        try { ((windowRef && windowRef.clearTimeout) || clearTimeout)(resizeTimer); } catch (_error) { /* noop */ }
        resizeTimer = null;
      }
      if (term) {
        try { term.dispose(); } catch (_error) { /* already gone */ }
      }
      term = null;
      fitAddon = null;
      mountedEl = null;
      const dyingId = sessionId;
      sessionId = '';
      const api = getApi();
      if (dyingId && typeof api?.kill === 'function') {
        try { Promise.resolve(api.kill({ sessionId: dyingId })).catch(() => {}); } catch (_error) { /* main owns refusal logging */ }
      }
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
    createIdePtyTerminalPanel,
  };
});
