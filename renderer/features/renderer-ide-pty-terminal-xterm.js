/* renderer/features/renderer-ide-pty-terminal-xterm.js — the xterm host of one
 * Workspace PTY terminal panel: the lazy vendor-runtime load, the Terminal and
 * addon instances (fit, search, web links), theme/font mapping, fit + PTY resize,
 * and the coalesced write queue. The ergonomics live in sibling modules this host
 * wires: file/URL links, the find bar and clipboard + context menu. The panel
 * (renderer-ide-pty-terminal-panel.js) owns the session lifecycle and reaches the
 * terminal only through this host. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePtyTerminalXterm = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    // Node/test path only; a fixed in-repo module, so a load failure is a real defect.
    return typeof require === 'function' ? require(requirePath) : {};
  }

  const terminalLinks = resolveModule('rendererIdeTerminalLinks', './renderer-ide-terminal-links');
  const terminalFind = resolveModule('rendererIdeTerminalFind', './renderer-ide-terminal-find');
  const terminalClipboard = resolveModule('rendererIdeTerminalClipboard', './renderer-ide-terminal-clipboard');

  const RESIZE_DEBOUNCE_MS = 50;
  // The scrollback bounds are the editor-pref normalizer's (renderer-ide-state, an eager script).
  const {
    TERMINAL_SCROLLBACK_DEFAULT: SCROLLBACK_DEFAULT,
    TERMINAL_SCROLLBACK_MIN: SCROLLBACK_MIN,
    TERMINAL_SCROLLBACK_MAX: SCROLLBACK_MAX,
  } = resolveModule('rendererIdeState', './renderer-ide-state');
  const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  // UIUX-035: output is queued and flushed in one coalesced `term.write()` per
  // animation frame, under a hard byte cap (drop-oldest + a visible counter).
  const WRITE_QUEUE_MAX_BYTES = 256 * 1024;
  // Code role size: follows Text size (or the explicit editor font size) via
  // the shared Monaco-utils resolver, like every other code surface.
  const TERMINAL_FALLBACK_FONT_SIZE = 13;
  const CODE_FONT_SIZE_EVENT = 'jenny:code-font-size';
  // WCAG AA text contrast; xterm lifts any ANSI foreground below it.
  const TERMINAL_MIN_CONTRAST_RATIO = 4.5;
  // Root attributes whose change can swap the terminal's colour/font tokens;
  // observed the same way renderer-ide-theme-bridge.js re-themes Monaco.
  const APPEARANCE_ATTRIBUTES = ['data-palette', 'data-typography', 'data-font-scale'];

  function clampScrollback(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.trunc(value)))
      : SCROLLBACK_DEFAULT;
  }

  function measureHost(mount) {
    return (Number(mount?.clientWidth) || 0) + 'x' + (Number(mount?.clientHeight) || 0);
  }

  // ctx: { deps, windowRef, getMount, getFindHost, getApi, getSessionId, getRootPath, getCwdPath,
  //        onUserInput, onClear, onWriteDropped, markStartupAudit, appendClientLog,
  //        logIgnoredError, requestFrame, cancelFrame, xtermLoader }
  function createPtyTerminalXterm(ctx) {
    const deps = ctx.deps || {};
    const windowRef = ctx.windowRef;
    const getMount = ctx.getMount;
    const getApi = ctx.getApi;
    const getSessionId = ctx.getSessionId;
    const appendClientLog = ctx.appendClientLog;
    const logIgnoredError = ctx.logIgnoredError;
    const requestFrame = ctx.requestFrame;
    const cancelFrame = ctx.cancelFrame;
    const xtermLoader = ctx.xtermLoader;
    // xterm + fit-addon come from the vendored UMD globals in the real app; tests
    // inject fakes (jsdom cannot host xterm). The fit-addon UMD global is
    // `FitAddon` carrying a `FitAddon` class property — guard both shapes.
    const usesInjectedTerminalFactory = typeof deps.createTerminal === 'function';
    const createTerminal = usesInjectedTerminalFactory
      ? deps.createTerminal
      : (opts) => new globalRef.Terminal(opts);
    const createFitAddon = typeof deps.createFitAddon === 'function'
      ? deps.createFitAddon
      : () => new (globalRef.FitAddon?.FitAddon || globalRef.FitAddon)();

    // Search + web-links addons: the vendored UMD globals (SearchAddon / WebLinksAddon, each
    // carrying a class of the same name); tests inject fakes. A missing global (no vendor
    // addon, as under jsdom) or a throwing constructor just disables its feature.
    const addonClass = (name) => {
      const candidate = globalRef[name]?.[name] || globalRef[name];
      return typeof candidate === 'function' ? candidate : null;
    };
    const createSearchAddon = typeof deps.createSearchAddon === 'function'
      ? deps.createSearchAddon
      : () => { const Addon = addonClass('SearchAddon'); return Addon ? new Addon() : null; };
    const createWebLinksAddon = typeof deps.createWebLinksAddon === 'function'
      ? deps.createWebLinksAddon
      : (handler) => { const Addon = addonClass('WebLinksAddon'); return Addon ? new Addon(handler) : null; };
    const getIde = typeof deps.getIde === 'function' ? deps.getIde : () => ({});
    const getRootPath = typeof ctx.getRootPath === 'function' ? ctx.getRootPath : () => '';

    let xtermFirstActivationMarked = false;
    let term = null;
    let fitAddon = null;
    let searchAddon = null;
    let find = null;
    let clipboard = null;
    let unbindContextMenu = null;
    let mountedEl = null;
    let resizeObserver = null;
    let resizeTimer = null;
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

    // True only when startSession() must `await` a vendor-runtime load; injected
    // factories and later real Starts stay synchronous up to spawn (tests rely
    // on capturing the fake bridge's spawn resolve/reject inline).
    function needsRuntimeLoad() {
      if (usesInjectedTerminalFactory) {
        return false;
      }
      if (xtermLoader && typeof xtermLoader.isXtermRuntimeReady === 'function') {
        return xtermLoader.isXtermRuntimeReady() !== true;
      }
      return false;
    }

    function ensureRuntime() {
      if (!xtermFirstActivationMarked) {
        xtermFirstActivationMarked = true;
        ctx.markStartupAudit('ide-terminal-xterm-runtime-requested', {});
      }
      if (!xtermLoader || typeof xtermLoader.ensureXtermRuntime !== 'function') {
        // No loader module resolved (should not happen in production, where
        // renderer-ide-xterm-loader.js always precedes this file); fall
        // through so createTerminal()'s own `new globalRef.Terminal` throws
        // a clear error rather than silently hanging the Start action.
        return Promise.resolve(true);
      }
      return Promise.resolve(xtermLoader.ensureXtermRuntime()).then((ok) => {
        ctx.markStartupAudit('ide-terminal-xterm-runtime-ready', { ok: ok === true });
        return ok;
      });
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
      // allowProposedApi: the search addon's match decorations use registerDecoration.
      term = createTerminal({ convertEol: false, cursorBlink: true, scrollback: readScrollbackPref(), allowProposedApi: true, minimumContrastRatio: TERMINAL_MIN_CONTRAST_RATIO });
      fitAddon = createFitAddon();
      loadAddon(fitAddon, 'fit');
      searchAddon = loadAddon(() => createSearchAddon(), 'search');
      loadAddon(() => createWebLinksAddon(terminalLinks.createUrlLinkHandler({ windowRef })), 'web_links');
      if (typeof term.registerLinkProvider === 'function') {
        try {
          term.registerLinkProvider(terminalLinks.createTerminalLinkProvider({ term, getRootPath, getCwdPath: ctx.getCwdPath, windowRef, appendClientLog, getHostEl: () => mountedEl }));
        } catch (error) { logIgnoredError('register_link_provider', error); }
      }
      find = terminalFind.createTerminalFind({
        windowRef,
        getFindHost: ctx.getFindHost,
        getThemeHost: () => mountedEl || getMount(),
        getSearchAddon: () => searchAddon,
        getTerminal: () => term,
        focusTerminal: focus,
        logIgnoredError,
      });
      clipboard = terminalClipboard.createTerminalClipboard({ windowRef, getTerminal: () => term, onClear: ctx.onClear, logIgnoredError });
      if (typeof term.attachCustomKeyEventHandler === 'function') {
        // Find chords first, then clipboard; every other key stays xterm's.
        term.attachCustomKeyEventHandler((event) => !(find.handleTerminalKey(event) || clipboard.handleTerminalKey(event)));
      }
      if (typeof term.onData === 'function') {
        // USER KEYSTROKES and sendCommand() are the only sanctioned api.write callers.
        term.onData((data) => ctx.onUserInput(data));
      }
      return term;
    }

    function readScrollbackPref() {
      return clampScrollback(getIde()?.terminalScrollback);
    }

    // Load one addon into the live term (`make` is an instance or a factory); returns
    // the instance, or null when it is absent or throws (its feature degrades).
    function loadAddon(make, site) {
      if (!make || typeof term.loadAddon !== 'function') {
        return null;
      }
      try {
        const addon = typeof make === 'function' ? make() : make;
        if (addon) { term.loadAddon(addon); }
        return addon || null;
      } catch (error) {
        logIgnoredError('load_' + site + '_addon', error); // addon optional
        return null;
      }
    }

    // Open the live xterm on `mount` when it is not already hosted there.
    // Returns true when it (re)attached.
    function attach(mount) {
      if (!term || !mount || mountedEl === mount) {
        return false;
      }
      try { term.open(mount); } catch (error) { logIgnoredError('term_open', error); }
      mountedEl = mount;
      observeResize(mount);
      unbindContextMenu?.();
      unbindContextMenu = clipboard ? clipboard.bindContextMenu(mount) : null;
      return true;
    }

    // The panel markup was (re)built: the xterm host must be re-attached.
    function forgetMount() {
      mountedEl = null;
    }

    // Re-attach the live xterm to the (possibly new) host and re-measure on
    // re-activation. Renders run on every IDE pass; only a real host size
    // change re-fits.
    function renderHost(mount) {
      if (!term || !mount) {
        return;
      }
      if (attach(mount)) {
        lastHostSize = '';
      }
      // A changed scrollback preference applies to the live terminal.
      const scrollback = readScrollbackPref();
      if (term.options && typeof term.options === 'object' && term.options.scrollback !== scrollback) {
        try { term.options.scrollback = scrollback; } catch (error) { logIgnoredError('scrollback', error); }
      }
      find?.syncHost();
      const hostSize = measureHost(mount);
      if (hostSize !== lastHostSize) {
        lastHostSize = hostSize;
        applyFitAndResize();
      }
    }

    // Read the terminal CSS custom properties so the xterm matches the panel chrome:
    // bg/fg/cursor, plus the per-palette selection and 16 ANSI colours when a stylesheet
    // defines them (each only when its token resolves). Returns null when the tokens are
    // unavailable so xterm keeps its own defaults.
    function buildTheme() {
      const styles = computedStyleOf();
      if (!styles) {
        return null;
      }
      const read = (name) => String(styles.getPropertyValue(name) || '').trim();
      const theme = {};
      const bg = read('--bg-base'); if (bg) { theme.background = bg; }
      const fg = read('--text-secondary'); if (fg) { theme.foreground = fg; }
      const cur = read('--accent'); if (cur) { theme.cursor = cur; }
      const selection = read('--ide-terminal-selection'); if (selection) { theme.selectionBackground = selection; }
      for (const name of ANSI_NAMES) {
        const normal = read('--ide-terminal-ansi-' + name); if (normal) { theme[name] = normal; }
        const bright = read('--ide-terminal-ansi-bright-' + name);
        if (bright) { theme['bright' + name[0].toUpperCase() + name.slice(1)] = bright; }
      }
      return Object.keys(theme).length ? theme : null;
    }

    function readMonoFontFamily() {
      const styles = computedStyleOf();
      return styles ? String(styles.getPropertyValue('--font-family-mono') || '').trim() : '';
    }

    // The terminal host's computed style, or null when unavailable.
    function computedStyleOf() {
      const host = mountedEl || getMount();
      if (!windowRef || typeof windowRef.getComputedStyle !== 'function' || !host) {
        return null;
      }
      try { return windowRef.getComputedStyle(host); } catch (_error) { return null; }
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
      const ObserverCtor = deps.mutationObserverCtor || windowRef.MutationObserver || globalRef.MutationObserver || null;
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
      const sessionId = getSessionId();
      if (sessionId && api && typeof api.resize === 'function' && term) {
        if (term.cols === lastSentCols && term.rows === lastSentRows) {
          return; // the PTY already has this size
        }
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        // A refused/failed resize leaves the PTY at its old size: forget the
        // cached size so the next resize notification retries it.
        const sentFor = sessionId;
        const forgetSentSize = () => {
          if (getSessionId() === sentFor) { lastSentCols = 0; lastSentRows = 0; }
        };
        try {
          Promise.resolve(api.resize({ sessionId, cols: term.cols, rows: term.rows }))
            .then((result) => { if (result && result.ok === false) forgetSentSize(); }, forgetSentSize);
        } catch (error) { forgetSentSize(); logIgnoredError('resize', error); } // a resize call must never derail render
      }
    }

    // The size the PTY was spawned at (0/0 = unknown, the next resize sends).
    function setSentSize(cols, rows) {
      lastSentCols = cols;
      lastSentRows = rows;
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

    // UIUX-011: always follow the LIVE mount: exactly one observed target, so a
    // rebuilt host never leaves the observer watching a detached element.
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

    // UIUX-035: see WRITE_QUEUE_MAX_BYTES (drop-oldest, counter via the
    // panel's status line).
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
        ctx.onWriteDropped();
      }
      scheduleWriteFlush();
    }

    function writeBanner(line) {
      if (term) {
        try { term.writeln(line); } catch (error) { logIgnoredError('exit_banner', error); }
      }
    }

    function clear() {
      if (term && typeof term.clear === 'function') {
        try { term.clear(); } catch (error) { logIgnoredError('clear', error); }
      }
    }

    function reset() {
      if (term) {
        try {
          if (typeof term.reset === 'function') { term.reset(); } else { term.clear(); }
        } catch (error) { logIgnoredError('reset_root_switch', error); }
      }
    }

    // Focus the live, hosted xterm; false when there is none.
    function focus() {
      if (term && mountedEl && typeof term.focus === 'function') {
        try { term.focus(); return true; } catch (error) { logIgnoredError('focus', error); }
      }
      return false;
    }

    function dispose() {
      appearanceObserver?.disconnect?.();
      appearanceObserver = null;
      windowRef?.document?.removeEventListener?.(CODE_FONT_SIZE_EVENT, applyAppearance);
      discardWriteQueue();
      unbindContextMenu?.();
      unbindContextMenu = null;
      find?.dispose();
      find = null;
      clipboard = null;
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
      searchAddon = null;
      mountedEl = null;
    }

    return {
      applyAppearance,
      applyFit,
      applyFitAndResize,
      attach,
      clear,
      discardWriteQueue,
      dispose,
      ensureRuntime,
      ensureTerminal,
      flushPendingWrites,
      focus,
      forgetMount,
      getDropStats: () => ({ events: writeDroppedEvents, bytes: writeDroppedBytes }),
      getSize: () => ({ cols: term ? term.cols : 0, rows: term ? term.rows : 0 }),
      getTerminal: () => term,
      hasTerminal: () => Boolean(term),
      needsRuntimeLoad,
      // Terminal: Find (palette): opens the find bar on a live terminal; false without one.
      openFind: () => Boolean(term && find && find.show() !== false),
      queueWrite,
      renderHost,
      reset,
      resetWriteDropCounters,
      setSentSize,
      startAppearanceObserver,
      writeBanner,
    };
  }

  return {
    WRITE_QUEUE_MAX_BYTES,
    createPtyTerminalXterm,
  };
});
