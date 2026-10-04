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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

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
  // Main truncates one write() at this many UTF-8 bytes (MAX_WRITE_BYTES in
  // services/workspace-pty-service.js). A longer command would reach the shell
  // cut off and without its newline, so it is refused before anything is typed.
  const SEND_COMMAND_MAX_BYTES = 16 * 1024;
  // Code role size: follows Text size (or the explicit editor font size) via
  // the shared Monaco-utils resolver, like every other code surface.
  const TERMINAL_FALLBACK_FONT_SIZE = 13;
  const CODE_FONT_SIZE_EVENT = 'jenny:code-font-size';
  // WCAG AA text contrast; xterm lifts any ANSI foreground below it.
  const TERMINAL_MIN_CONTRAST_RATIO = 4.5;
  // Root attributes whose change can swap the terminal's colour/font tokens;
  // observed the same way renderer-ide-theme-bridge.js re-themes Monaco.
  const APPEARANCE_ATTRIBUTES = ['data-palette', 'data-typography', 'data-font-scale'];
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

  function createIdePtyTerminalPanel(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const escapeHtml = typeof deps?.escapeHtml === 'function' ? deps.escapeHtml : (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    // A best-effort host/xterm/bridge call failed: keep the panel alive, but leave a trace.
    function logIgnoredError(site, error) {
      appendClientLog('DEBUG', 'ide.pty_ignored_error', { site, error: String(error?.message || error || '') });
    }
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
      : (name, details) => { try { globalRef.__jennyStartupAudit?.mark?.(name, details); } catch (error) { logIgnoredError('startup_audit_mark', error); } };
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
    // Size tracking so a render only re-fits when the host actually changed and
    // a PTY resize IPC goes out only when cols/rows actually changed.
    let lastHostSize = '';
    let lastSentCols = 0;
    let lastSentRows = 0;
    let appearanceObserver = null;
    let lastAppearanceSignature = '';

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
          ? jt('ide.ptyTerminal.outputDropped', '{status} · output dropped ({bytes}B)', { status: base, bytes: writeDroppedBytes })
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
        return '<div class="ide-rail-placeholder">' + escapeHtml(jt('ide.ptyTerminal.unavailable', 'Terminal is unavailable in this shell mode.')) + '</div>';
      }
      return '<div class="ide-terminal-panel">'
        + '<div class="ide-terminal-toolbar">'
        + '<span class="ide-terminal-title">Terminal</span>'
        + '<span class="ide-terminal-status" data-ide-terminal-status></span>'
        + '<span class="ide-terminal-toolbar-actions">'
        + buildToolbarButton('start', 'Start', jt('ide.ptyTerminal.startSession', 'Start a terminal session'))
        + buildToolbarButton('signal', '^C', jt('ide.ptyTerminal.sendInterrupt', 'Send an interrupt (Ctrl+C) to the running command'))
        + buildToolbarButton('clear', 'Clear', jt('ide.ptyTerminal.clear', 'Clear the terminal'))
        + buildToolbarButton('restart', 'Restart', jt('ide.ptyTerminal.restartSession', 'Restart the terminal session'))
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
          try { term.open(mount); } catch (error) { logIgnoredError('term_open', error); }
          mountedEl = mount;
          lastHostSize = '';
          observeResize(mount);
        }
        // Renders run on every IDE pass; only a real host size change re-fits.
        const hostSize = measureHost(mount);
        if (hostSize !== lastHostSize) {
          lastHostSize = hostSize;
          applyFitAndResize();
        }
      }
      syncStatus();
    }

    function measureHost(mount) {
      return (Number(mount?.clientWidth) || 0) + 'x' + (Number(mount?.clientHeight) || 0);
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

    function readMonoFontFamily() {
      const host = mountedEl || getMount();
      if (!windowRef || typeof windowRef.getComputedStyle !== 'function' || !host) {
        return '';
      }
      try {
        return String(windowRef.getComputedStyle(host).getPropertyValue('--font-family-mono') || '').trim();
      } catch (_error) {
        return '';
      }
    }

    // Colours + app mono font onto the live xterm. Runs at Start and again on
    // every palette/typography switch; a same-token pass is a no-op. A font
    // change alters the cell size, so it re-fits (the resize IPC is deduped).
    function applyAppearance() {
      if (!term || !term.options || typeof term.options !== 'object') {
        return;
      }
      const theme = buildTheme();
      const fontFamily = readMonoFontFamily();
      const monacoUtils = globalRef.rendererMonacoEditorUtils;
      const fontSize = typeof monacoUtils?.resolveCodeFontPx === 'function'
        ? monacoUtils.resolveCodeFontPx(getMount()?.ownerDocument)
        : TERMINAL_FALLBACK_FONT_SIZE;
      const signature = JSON.stringify({ theme, fontFamily, fontSize });
      if (signature === lastAppearanceSignature) {
        return;
      }
      const refit = Boolean(lastAppearanceSignature);
      lastAppearanceSignature = signature;
      try {
        if (theme) { term.options.theme = theme; }
        if (fontFamily) { term.options.fontFamily = fontFamily; }
        term.options.fontSize = fontSize;
      } catch (error) { logIgnoredError('theme', error); } // readonly options
      if (!refit) return;
      // A palette change while the Workspace is hidden measures a 0x0 host and
      // would fit xterm to two columns; the next visible render re-fits instead.
      const host = mountedEl || getMount();
      if (!host || measureHost(host) === '0x0') {
        lastHostSize = '';
        return;
      }
      applyFitAndResize();
    }

    function startAppearanceObserver() {
      const rootEl = windowRef?.document?.documentElement || null;
      if (appearanceObserver || !rootEl) {
        return;
      }
      const ObserverCtor = deps?.mutationObserverCtor || windowRef.MutationObserver || globalRef.MutationObserver || null;
      if (typeof ObserverCtor !== 'function') {
        return;
      }
      try {
        appearanceObserver = new ObserverCtor(() => applyAppearance());
        appearanceObserver.observe(rootEl, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES });
        // The editor font-size preference is not a root attribute; it arrives
        // as an event from renderer-monaco-editor-utils.
        windowRef.document.addEventListener?.(CODE_FONT_SIZE_EVENT, applyAppearance);
      } catch (error) {
        appearanceObserver = null;
        logIgnoredError('appearance_observer', error);
      }
    }

    function applyFit() {
      if (fitAddon && typeof fitAddon.fit === 'function') {
        try { fitAddon.fit(); } catch (error) { logIgnoredError('fit', error); } // host not measurable yet
      }
    }

    function applyFitAndResize() {
      applyFit();
      const api = getApi();
      if (isRunning() && api && typeof api.resize === 'function' && term) {
        if (term.cols === lastSentCols && term.rows === lastSentRows) {
          return; // the PTY already has this size
        }
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        // A refused/failed resize leaves the PTY at its old size: forget the
        // cached size so the next resize notification retries it.
        const sentFor = sessionId;
        const forgetSentSize = () => {
          if (sessionId === sentFor) { lastSentCols = 0; lastSentRows = 0; }
        };
        try {
          Promise.resolve(api.resize({ sessionId, cols: term.cols, rows: term.rows }))
            .then((result) => { if (result && result.ok === false) forgetSentSize(); }, forgetSentSize);
        } catch (error) { forgetSentSize(); logIgnoredError('resize', error); } // a resize call must never derail render
      }
    }

    function scheduleResize() {
      if (resizeTimer) {
        return;
      }
      const set = (windowRef && windowRef.setTimeout) || setTimeout;
      resizeTimer = set(() => {
        resizeTimer = null;
        lastHostSize = measureHost(mountedEl);
        applyFitAndResize();
      }, RESIZE_DEBOUNCE_MS);
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
        resizeObserver.disconnect();
      } else {
        try {
          resizeObserver = new RO(() => scheduleResize());
        } catch (_error) {
          resizeObserver = null;
          return;
        }
      }
      resizeObserver.observe(mount);
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
        cancelFrame(writeFrame);
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
        cancelFrame(writeFrame);
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
      const code = payload?.exitCode == null ? '' : jt('ide.ptyTerminal.exitCode', ' (code {code})', { code: payload.exitCode });
      if (term) {
        try { term.writeln('\r\n' + jt('ide.ptyTerminal.sessionEnded', '[terminal] session ended{code}', { code })); } catch (error) { logIgnoredError('exit_banner', error); }
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
      // buildTheme maps no ANSI palette, so shells' ANSI colours are xterm's
      // dark-background defaults (yellow #e5e510 is 1.0:1 on Day's --bg-base).
      // The WCAG AA floor makes xterm adjust any such foreground against the
      // live background on every palette (VS Code's terminal default).
      term = createTerminal({ convertEol: false, cursorBlink: true, scrollback: 1000, minimumContrastRatio: TERMINAL_MIN_CONTRAST_RATIO });
      fitAddon = createFitAddon();
      if (fitAddon && typeof term.loadAddon === 'function') {
        try { term.loadAddon(fitAddon); } catch (error) { logIgnoredError('load_fit_addon', error); } // addon optional
      }
      if (typeof term.onData === 'function') {
        // USER KEYSTROKES and sendCommand() are the only sanctioned api.write callers.
        term.onData((data) => {
          const api = getApi();
          if (sessionId && api && typeof api.write === 'function') {
            try { Promise.resolve(api.write({ sessionId, data })).catch(() => {}); } catch (error) { logIgnoredError('write', error); }
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
      showError(message, { title: jt('ide.terminal.title', 'Terminal'), dedupeKey: 'ide:pty:start' });
      return false;
    }

    async function startSession() {
      if (disposed || isRunning() || starting) {
        return false;
      }
      const api = getApi();
      if (!api || typeof api.spawn !== 'function') {
        return failStart('unavailable', 'ide.pty_start_unavailable',
          jt('ide.ptyTerminal.ptyUnavailable', 'The PTY terminal is not available in this shell mode.'));
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
            jt('ide.ptyTerminal.runtimeLoadFailed', 'The terminal runtime could not be loaded. Check your connection and try again.'));
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
          try { term.open(mount); } catch (error) { logIgnoredError('term_open', error); }
          mountedEl = mount;
          observeResize(mount);
        }
        // Theme + mono font apply via term.options now that the host exists,
        // then track palette/typography switches for the terminal's lifetime.
        applyAppearance();
        startAppearanceObserver();
        applyFit(); // fit-then-spawn: measure before we ask the pty for a size
        const spawnCols = term.cols;
        const spawnRows = term.rows;
        const result = await api.spawn({ cols: spawnCols, rows: spawnRows });
        if (disposed || epoch !== lifecycleEpoch) {
          const lateSessionId = String(result?.sessionId || '');
          if (lateSessionId && typeof api.kill === 'function') {
            try { await api.kill({ sessionId: lateSessionId }); } catch (error) { logIgnoredError('kill_late', error); } // main owns refusal logging
          }
          return false;
        }
        if (!result || result.ok === false) {
          const message = toErrorMessage(result?.message, result?.code || jt('ide.ptyTerminal.startFailed', 'The terminal could not be started.'));
          return failStart('failed', 'ide.pty_start_failed', message, { code: String(result?.code || ''), message });
        }
        sessionId = String(result.sessionId || '');
        if (!sessionId) {
          return failStart('failed', 'ide.pty_start_no_session',
            jt('ide.ptyTerminal.noSessionId', 'The terminal session could not be started (no session id).'));
        }
        sessionShell = String(result.shell || '');
        sessionCwd = String(result.cwd || '');
        // A fresh spawn used this size; an attach to an already-running PTY did
        // not resize it, so leave the cache empty and let the resize below correct it.
        const spawnedAtSize = result.alreadyRunning !== true;
        lastSentCols = spawnedAtSize ? spawnCols : 0;
        lastSentRows = spawnedAtSize ? spawnRows : 0;
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
          toErrorMessage(error, jt('ide.ptyTerminal.startError', 'Could not start the terminal.')),
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
        const data = `${String(command || '')}\r\n`;
        const dataBytes = new TextEncoder().encode(data).length;
        if (dataBytes > SEND_COMMAND_MAX_BYTES) {
          appendClientLog('WARN', 'ide.pty_send_command_refused', { code: 'too_long' });
          return false;
        }
        const result = await api.write({ sessionId, data });
        // main answers { ok, written } or { ok: false, code }; only a complete,
        // accepted write counts as sent.
        const accepted = Boolean(result) && typeof result === 'object' && result.ok === true
          && !(Number.isFinite(result.written) && result.written < dataBytes);
        if (!accepted) {
          appendClientLog('WARN', 'ide.pty_send_command_refused', { code: String(result?.code || '') });
        }
        return accepted;
      } catch (_error) {
        return false;
      }
    }

    function sendInterrupt() {
      const api = getApi();
      if (!isRunning() || !api || typeof api.write !== 'function') {
        return;
      }
      try { Promise.resolve(api.write({ sessionId, data: INTERRUPT_BYTE })).catch(() => {}); } catch (error) { logIgnoredError('interrupt', error); }
    }

    function clearTerminal() {
      // Discard any not-yet-flushed queued bytes so a Clear/Restart can never
      // be followed by stale pre-clear (or, on Restart, prior-session) output
      // reappearing on the next animation frame.
      discardWriteQueue();
      resetWriteDropCounters();
      if (term && typeof term.clear === 'function') {
        try { term.clear(); } catch (error) { logIgnoredError('clear', error); }
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
          try { await api.kill({ sessionId: dyingId }); } catch (error) { logIgnoredError('kill_restart', error); } // exit event settles state
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
        sendInterrupt();
      } else if (kind === 'clear') {
        clearTerminal();
      } else if (kind === 'restart') {
        restartSession().then(focusWhenStarted, noop);
      }
    }

    // Focus the live xterm, else (no session yet) the Start button. Returns
    // true when focus landed; the bottom panel calls this on Ctrl+` / tab click.
    function focusTerminal() {
      if (term && mountedEl && typeof term.focus === 'function') {
        try { term.focus(); return true; } catch (error) { logIgnoredError('focus', error); }
      }
      const start = getPanelEl()?.querySelector?.('[data-ide-terminal-action="start"]') || null;
      if (!start || typeof start.focus !== 'function') {
        return false;
      }
      start.focus();
      return start.ownerDocument?.activeElement === start;
    }

    // Main kills the PTY on a workspace-root switch; drop the old workspace's
    // scrollback and return to the pre-Start state so the new root starts clean.
    function resetForRoot() {
      if (disposed) {
        return;
      }
      lifecycleEpoch += 1; // an in-flight spawn from the old root is killed on arrival
      const dyingId = sessionId;
      sessionId = '';
      lastSentCols = 0;
      lastSentRows = 0;
      discardPreReadyBuffer();
      const api = getApi();
      if (dyingId && typeof api?.kill === 'function') {
        // Main normally killed it already (then this is a no-op there).
        try { Promise.resolve(api.kill({ sessionId: dyingId })).catch(() => {}); } catch (error) { logIgnoredError('kill_root_switch', error); }
      }
      discardWriteQueue();
      resetWriteDropCounters();
      if (term) {
        try {
          if (typeof term.reset === 'function') { term.reset(); } else { term.clear(); }
        } catch (error) { logIgnoredError('reset_root_switch', error); }
      }
      setStatusMessage('');
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
      appearanceObserver?.disconnect?.();
      appearanceObserver = null;
      windowRef?.document?.removeEventListener?.(CODE_FONT_SIZE_EVENT, applyAppearance);
      discardPreReadyBuffer();
      discardWriteQueue();
      if (boundPanel) {
        boundPanel.removeEventListener('click', handleClick);
        boundPanel = null;
      }
      try { unsubscribeData?.(); } catch (error) { logIgnoredError('unsubscribe_data', error); }
      unsubscribeData = null;
      try { unsubscribeExit?.(); } catch (error) { logIgnoredError('unsubscribe_exit', error); }
      unsubscribeExit = null;
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (resizeTimer) {
        ((windowRef && windowRef.clearTimeout) || clearTimeout)(resizeTimer);
        resizeTimer = null;
      }
      if (term) {
        try { term.dispose(); } catch (error) { logIgnoredError('dispose', error); }
      }
      term = null;
      fitAddon = null;
      mountedEl = null;
      const dyingId = sessionId;
      sessionId = '';
      const api = getApi();
      if (dyingId && typeof api?.kill === 'function') {
        try { Promise.resolve(api.kill({ sessionId: dyingId })).catch(() => {}); } catch (error) { logIgnoredError('kill_dispose', error); } // main owns refusal logging
      }
    }

    return {
      bindEvents,
      dispose,
      focusTerminal,
      isRunning,
      renderTerminalPanel,
      resetForRoot,
      sendCommand,
      startSession,
    };
  }

  return {
    SEND_COMMAND_MAX_BYTES,
    createIdePtyTerminalPanel,
  };
});
