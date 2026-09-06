/* renderer/features/renderer-ide-run-scripts.js - "Run scripts" for the Workspace
 * IDE: a package.json npm-script picker + a language-keyed "Run this file"
 * (node/python/bash/…). Built PANEL-FREE - no new rail panel: the entry points
 * are two Monaco editor actions (jenny.run-file + jenny.run-script, both visible
 * in the F1 command palette + the right-click "jenny" group), a self-contained
 * script-picker overlay (cloning renderer-ide-quick-open's overlay pattern), and
 * a statusbar running indicator + one-click kill (wired by the controller). Run
 * OUTPUT lands in the bottom panel's existing "run" view slot (renderRunPanel()).
 *
 * UIUX-014: each run/script is its OWN isolated main-process child, spawned via
 * the workspaceRunTask bridge (services/workspace-run-task-service.js) - NOT the
 * shared interactive workspace-terminal session. Main assigns the task's identity
 * (taskId) at spawn and stamps every onData/onExit event with it; completion is
 * the real OS process-exit event, never inferred from output content - nothing
 * left for a project script to spoof by printing a marker itself.
 *
 * Injection safety: the active file path AND the script name are single-quoted
 * (single quotes are literal in both PowerShell and POSIX shells) so a crafted
 * name like "$(calc).js" or a script key with metacharacters cannot trigger
 * command substitution - mirrors the renderer-ide-debug-inspector quoting
 * lesson. quoteArg() is SHELL-AWARE: an embedded quote is PowerShell-doubled
 * ('') on win32 and POSIX-escaped ('\'') elsewhere, matching the shell
 * workspace-run-task-runner.js's shellFor() actually spawns per platform -
 * '' would silently DROP the quote under sh (`'a''b'` parses to `ab`). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeRunScripts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const TOAST_KEY = 'ide:run';
  const RUN_MARKUP_SENTINEL = '__jenny-ide-run__';
  const MAX_OUTPUT_CHARS = 256 * 1024;
  const MAX_PICKER_ROWS = 50;
  // Safety net for a hung bridge: if api.start() never resolves/rejects the run
  // would stay phantom-"running" forever (mirrors the debug inspector's
  // DEFAULT_TIMEOUT_MS). A LATE resolution after this fires is not ignored: if
  // main did spawn a real task, its taskId is killed immediately (dispatch()).
  const DEFAULT_START_TIMEOUT_MS = 10000;
  // UIUX-014 pre-ready buffer: main wires the child's output forwarding
  // synchronously inside start(), before its IPC reply is sent, so onData/
  // onExit can cross the bridge BEFORE the renderer learns its own taskId.
  // Events heard while a dispatch is in flight are held here and replayed
  // through the SAME exact-match apply paths once the taskId is known.
  // Bounded per the W1-D PTY precedent: oldest-entry eviction + a dropped counter.
  const PRE_READY_BUFFER_MAX_EVENTS = 64;
  const PRE_READY_BUFFER_MAX_BYTES = 64 * 1024; // mirrors the service's MAX_CHUNK_BYTES
  // UIUX-035 follow-up: ANSI/OSC stripping goes through the shared incremental
  // stateful parser (renderer/shared/ansi-stream-utils.js) - a stateless regex
  // has no BEL/ST terminator awareness and would swallow real output after it.

  // language id -> interpreter prefix (checked before the extension fallback so a
  // Monaco language override wins). Multi-token prefixes (npx tsx / go run) are
  // fine - the value is just prepended to the quoted path.
  const LANGUAGE_RUNNERS = {
    javascript: 'node',
    typescript: 'npx tsx',
    python: 'python',
    shellscript: 'bash',
    ruby: 'ruby',
    go: 'go run',
    php: 'php',
  };
  const EXTENSION_RUNNERS = {
    js: 'node', cjs: 'node', mjs: 'node',
    ts: 'npx tsx', mts: 'npx tsx', cts: 'npx tsx',
    py: 'python',
    sh: 'bash', bash: 'bash',
    rb: 'ruby',
    go: 'go run',
    php: 'php',
  };

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

  function messageOf(error) {
    return String((error && error.message) || error || '');
  }

  // Shell-aware quoting: PowerShell doubles an embedded quote ('') but POSIX
  // sh silently drops it that way ('a''b' -> ab) - see header comment.
  function quoteArg(value, isPosixShell) {
    const escaped = String(value).replace(/'/g, isPosixShell ? "'\\''" : "''");
    return "'" + escaped + "'";
  }

  function extensionOf(path) {
    const name = String(path || '').split('/').pop() || '';
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function baseNameOf(path) {
    return String(path || '').split('/').pop() || String(path || '');
  }

  function createIdeRunScripts(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const isActivePanel = typeof options.isActivePanel === 'function' ? options.isActivePanel : () => false;
    const escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const editorHost = options.editorHost || null;
    const getWorkspaceFsApi = typeof options.getWorkspaceFsApi === 'function' ? options.getWorkspaceFsApi : () => null;
    // Falls back to the real bridge namespace directly so the controller does not
    // need an extra wiring getter (renderer-ide-controller.js is at its file-size
    // ceiling); tests always inject an explicit fake.
    const getWorkspaceRunTaskApi = typeof options.getWorkspaceRunTaskApi === 'function'
      ? options.getWorkspaceRunTaskApi
      : () => (globalRef.window || globalRef).jennyShell?.workspaceRunTask || null;
    // Opens/reveals the bottom panel on the "run" view (controller wires it to
    // bottomPanel.open('run')) so run output is visible there.
    const openRunPanel = typeof options.openRunPanel === 'function' ? options.openRunPanel : noop;
    // Fired on every running-state change so the controller can re-render the
    // statusbar indicator (wired to statusBar.render()).
    const onRunStateChange = typeof options.onRunStateChange === 'function' ? options.onRunStateChange : noop;
    const isDiffTabId = typeof options.isDiffTabId === 'function' ? options.isDiffTabId : () => false;
    // Which shell main will spawn (workspace-run-task-runner.js shellFor):
    // win32 -> powershell.exe, else bash -c. quoteArg() needs this to escape
    // an embedded quote correctly for the ACTUAL target shell.
    const isPosixShell = !/^win/i.test(String(options.platform
      || (typeof navigator !== 'undefined' && navigator.platform)
      || (typeof process !== 'undefined' && process.platform) || ''));
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : noop;
    const showToastMessage = typeof options.showToastMessage === 'function' ? options.showToastMessage : noop;
    const startTimeoutMs = Number.isFinite(options.runStartTimeoutMs)
      ? options.runStartTimeoutMs
      : DEFAULT_START_TIMEOUT_MS;
    // Frame scheduling for the coalesced paint (mirrors the legacy terminal
    // panel): injectable for deterministic tests, real rAF in the app, and a
    // synchronous fallback where no rAF exists (jsdom/node test contexts).
    const requestFrame = typeof options.requestAnimationFrameImpl === 'function'
      ? options.requestAnimationFrameImpl
      : (typeof globalRef.requestAnimationFrame === 'function'
          ? globalRef.requestAnimationFrame.bind(globalRef)
          : (callback) => { callback(0); return null; });
    const cancelFrame = typeof options.cancelAnimationFrameImpl === 'function'
      ? options.cancelAnimationFrameImpl
      : (typeof globalRef.cancelAnimationFrame === 'function'
          ? globalRef.cancelAnimationFrame.bind(globalRef)
          : noop);
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const textField = resolveModule('inventoryTextField', '../inventory/text-field');
    const ansiStreamUtils = resolveModule('rendererAnsiStreamUtils', '../shared/ansi-stream-utils');
    const ansiStripper = typeof ansiStreamUtils?.createAnsiStreamStripper === 'function'
      ? ansiStreamUtils.createAnsiStreamStripper()
      : { push: (text) => String(text || ''), reset: noop };
    const terminalStreamUtils = resolveModule('rendererTerminalStreamUtils', '../shared/terminal-stream-utils');

    // The run output host is the bottom panel's shared content element (the same
    // one Terminal + Problems paint into); each guards isActivePanel().
    function getMountEl() {
      return getDom().ideBottomPanelContent || null;
    }

    let running = false;
    // The main-assigned identity of the in-flight run (UIUX-014). Every onData /
    // onExit event is stamped with a taskId; only an EXACT match may paint into
    // the current run's UI - a late or stale event for a superseded/killed task
    // is inert, never scanned for content.
    let activeTaskId = '';
    // Set when main could not confirm the process tree died. It is NOT cleared
    // by the Clear button -- clearing the console must not dismiss a warning
    // about a child that may still be alive -- only by starting a new run.
    let killUnconfirmed = false;
    // A LOCAL (never transmitted) generation counter so a start() that resolves
    // after the local timeout/dispose already gave up on it can still be told
    // apart from the current in-flight dispatch.
    let dispatchGeneration = 0;
    // UIUX-035 follow-up: output is stored CLEANED (ANSI stripped
    // incrementally per chunk via the shared stateful parser) as a bounded
    // chunk list — never a raw buffer regex-re-scanned in full every render.
    // The "> <label>" header echo and "[run] …" notes are ordinary chunks in
    // this stream (they only land at the start / after the end of a run, so
    // append order is always correct). Painting is rAF-coalesced incremental
    // text-node appends via the shared bounded painter (terminal-stream-utils,
    // the legacy terminal panel's wide-055 pattern), never a synchronous full
    // pre.textContent rewrite per chunk.
    const painter = terminalStreamUtils.createBoundedScrollbackPainter({
      requestFrame,
      cancelFrame,
      maxChars: MAX_OUTPUT_CHARS,
      getScrollbackEl: () => getScrollbackEl(),
      applyDroppedMarkers: (pre, dropped) => { pre.dataset.runDroppedChars = String(dropped); },
    });
    let unsubData = null;
    let unsubExit = null;
    let boundMount = null;
    let startTimer = null; // armed while api.start() is in flight (hung-bridge net)
    let disposed = false;
    // Pre-ready buffering (see PRE_READY_BUFFER_MAX_* above). `dispatching`
    // is true from just before api.start() is invoked until that dispatch
    // settles (success, failure, timeout, dispose, or supersession).
    let dispatching = false;
    const preReadyEvents = terminalStreamUtils.createPreReadyEventBuffer({
      maxEvents: PRE_READY_BUFFER_MAX_EVENTS,
      maxBytes: PRE_READY_BUFFER_MAX_BYTES,
      sizeOf: (kind, payload) => (kind === 'data' ? String(payload?.chunk || '').length : 0),
      onDrop: (stats) => appendClientLog('WARN', 'ide.run.preready_buffer_dropped', stats),
    });

    function clearStartTimer() {
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
    }

    function toast(message) {
      showToastMessage(message, { dedupeKey: TOAST_KEY });
    }

    function isRunning() {
      return running === true;
    }

    /* ---- output rendering (bottom panel "run" slot) ---------------------- */

    function buildPanelMarkup() {
      if (typeof actionButton !== 'function') {
        return '<div class="ide-rail-placeholder">Run output is unavailable in this shell mode.</div>';
      }
      // Reuses the terminal panel's visual classes so the run view needs no new
      // CSS (consistent console chrome); a distinct data-attr namespace keeps the
      // click handlers separate from the terminal panel sharing this host.
      return '<div class="ide-terminal-panel ide-run-panel">'
        + '<div class="ide-terminal-toolbar">'
        + '<span class="ide-terminal-title">Run</span>'
        + '<span class="ide-terminal-status" data-ide-run-status></span>'
        + '<span class="ide-terminal-toolbar-actions">'
        + actionButton({
          plain: true,
          className: 'ide-terminal-button',
          title: 'Stop the running task (kills the process tree)',
          trustedHtml: 'Stop',
          disabled: !running,
          dataset: { 'ide-run-action': 'kill' },
        })
        + actionButton({
          plain: true,
          className: 'ide-terminal-button',
          title: 'Clear run output',
          trustedHtml: 'Clear',
          dataset: { 'ide-run-action': 'clear' },
        })
        + '</span>'
        + '</div>'
        + '<pre class="ide-terminal-scrollback ide-run-scrollback" data-ide-run-scrollback tabindex="0"></pre>'
        + '</div>';
    }

    function getPanelEl() {
      const mount = getMountEl();
      if (!mount || !isActivePanel()) {
        return null;
      }
      return mount;
    }

    function getScrollbackEl() {
      return getPanelEl()?.querySelector?.('[data-ide-run-scrollback]') || null;
    }

    // Appends ALREADY-CLEAN text (stripped process output, header echo, or a
    // [run] note) to the shared bounded painter (drop-oldest past the cap,
    // running total surfaced as dataset.runDroppedChars — never silent).
    function appendCleanText(text) {
      const cleaned = String(text || '');
      if (!cleaned) {
        return;
      }
      painter.append(cleaned);
      painter.schedule();
    }

    function appendProcessOutput(chunk) {
      appendCleanText(ansiStripper.push(chunk).replace(/\r(?!\n)/g, ''));
    }

    // Full reset: a new dispatch REPLACES the previous run's output, and the
    // toolbar Clear empties the panel. The parser reset matters as much as the
    // text reset — a fresh run must never inherit a mid-escape-sequence state
    // from whatever the old process left dangling.
    function resetRunOutput() {
      ansiStripper.reset();
      painter.reset();
    }

    function syncStatus() {
      const panel = getPanelEl();
      const status = panel?.querySelector?.('[data-ide-run-status]') || null;
      if (status) {
        // Three states, not two. An unconfirmed kill is not 'idle': main told us
        // it could not confirm the process tree died, and collapsing that into
        // the same word as a clean exit is exactly the dishonesty this surface
        // exists to remove.
        const unconfirmed = !running && killUnconfirmed;
        status.textContent = running ? 'running' : (unconfirmed ? 'stop unconfirmed' : 'idle');
        status.classList.toggle('ide-terminal-status--running', running);
        status.classList.toggle('ide-terminal-status--warn', unconfirmed);
      }
      const stopButton = panel?.querySelector?.('[data-ide-run-action="kill"]') || null;
      if (stopButton) stopButton.disabled = !running;
    }

    // Called by the bottom panel's render pass (run branch) AND after each
    // state change so the toolbar/status track the run.
    function renderRunPanel() {
      const mount = getPanelEl();
      if (!mount) {
        return;
      }
      if (mount.__jennyIdeRailMarkup !== RUN_MARKUP_SENTINEL) {
        mount.innerHTML = buildPanelMarkup();
        mount.__jennyIdeRailMarkup = RUN_MARKUP_SENTINEL;
      }
      painter.sync(); // collapse any pending frame so the DOM is current
      syncStatus();
    }

    // A running-state change repaints the run panel (kill/clear toolbar state)
    // AND the statusbar indicator (the controller wires onRunStateChange).
    function emitRunStateChange() {
      renderRunPanel();
      onRunStateChange();
    }

    /* ---- run-task bridge (UIUX-014: main-owned identity/exit) ------------ */

    function friendlyExitNote(payload) {
      if (payload && payload.errorCode) {
        return '\n[run] ' + (payload.message || 'the task could not run');
      }
      const code = payload && payload.code != null ? String(payload.code) : '';
      if (payload && payload.status === 'killed') {
        return '\n[run] stopped';
      }
      return code && code !== '0' ? `\n[run] exited with code ${code}` : '\n[run] finished';
    }

    function finishRun(payload) {
      running = false;
      activeTaskId = '';
      // The dead process can never finish an escape sequence it left open.
      ansiStripper.reset();
      appendCleanText(friendlyExitNote(payload));
      emitRunStateChange();
    }

    function applyDataEvent(payload) {
      if (!payload || !activeTaskId || String(payload.taskId || '') !== activeTaskId) {
        // Not the current task's event: idle terminal chatter, or a late/stale
        // event for a superseded/killed task. Never scanned, never painted.
        return;
      }
      appendProcessOutput(String(payload.chunk || ''));
    }

    function applyExitEvent(payload) {
      if (!payload || !activeTaskId || String(payload.taskId || '') !== activeTaskId) {
        return;
      }
      finishRun(payload);
    }

    /* ---- pre-ready buffer (events racing the start() reply) -------------- */

    function isBuffering() {
      return dispatching === true && !activeTaskId;
    }

    function discardPreReadyBuffer() {
      preReadyEvents.discard();
    }

    // Replay in arrival order the moment activeTaskId is known. Reusing the
    // apply paths means exact-match filtering still governs: a buffered event
    // for a DIFFERENT taskId drops, and a buffered exit for the assigned
    // taskId settles the run mid-replay (clearing activeTaskId, so any data
    // buffered after it is correctly dropped - the task already ended).
    function replayPreReadyBuffer() {
      for (const entry of preReadyEvents.drain()) {
        if (entry.kind === 'data') {
          applyDataEvent(entry.payload);
        } else if (entry.kind === 'exit') {
          applyExitEvent(entry.payload);
        }
      }
    }

    function handleData(payload) {
      if (isBuffering()) {
        preReadyEvents.push('data', payload);
        return;
      }
      applyDataEvent(payload);
    }

    function handleExit(payload) {
      if (isBuffering()) {
        preReadyEvents.push('exit', payload);
        return;
      }
      applyExitEvent(payload);
    }

    function ensureSubscribed() {
      const api = getWorkspaceRunTaskApi();
      if (!api) {
        return;
      }
      if (!unsubData && typeof api.onData === 'function') {
        unsubData = api.onData(handleData) || null;
      }
      if (!unsubExit && typeof api.onExit === 'function') {
        unsubExit = api.onExit(handleExit) || null;
      }
    }

    async function dispatch(commandString, label) {
      if (disposed) {
        return;
      }
      if (running) {
        toast('A task is already running. Stop it first.');
        return;
      }
      const api = getWorkspaceRunTaskApi();
      if (!api || typeof api.start !== 'function' || typeof api.kill !== 'function') {
        toast('The workspace terminal is unavailable in this shell mode.');
        return;
      }
      ensureSubscribed();
      openRunPanel();
      dispatchGeneration += 1;
      const generation = dispatchGeneration;
      resetRunOutput();
      appendCleanText('> ' + label + '\n');
      running = true;
      killUnconfirmed = false; // a new run owns the row from here
      activeTaskId = '';
      discardPreReadyBuffer();
      dispatching = true; // events heard from here until settlement buffer, not drop
      emitRunStateChange();
      let timedOut = false;
      clearStartTimer();
      startTimer = setTimeout(() => {
        startTimer = null;
        if (generation !== dispatchGeneration) {
          return;
        }
        timedOut = true;
        running = false;
        dispatching = false;
        discardPreReadyBuffer(); // a dead dispatch's events must never replay later
        appendCleanText('\n[run] timed out waiting for the task to start');
        emitRunStateChange();
        toast('The task did not start in time. Try again.');
        appendClientLog('WARN', 'ide.run.start_timeout', {});
      }, startTimeoutMs);
      let result;
      try {
        result = await api.start({ command: commandString, label });
      } catch (error) {
        clearStartTimer();
        if (generation === dispatchGeneration) {
          dispatching = false;
          discardPreReadyBuffer();
        }
        if (disposed || timedOut || generation !== dispatchGeneration) {
          return;
        }
        running = false;
        appendCleanText('\n[run] ' + messageOf(error));
        emitRunStateChange();
        toast('Could not start the task. ' + messageOf(error));
        appendClientLog('WARN', 'ide.run.dispatch_failed', { message: messageOf(error) });
        return;
      }
      clearStartTimer();
      if (generation === dispatchGeneration) {
        // This dispatch is still the live one: stop buffering. On the success
        // path below the buffer replays after the taskId is assigned; on every
        // other path it is discarded.
        dispatching = false;
      }
      if (disposed || timedOut || generation !== dispatchGeneration) {
        // If main spawned a task after timeout, disposal, or supersession, kill it
        // by its returned taskId so it cannot continue invisibly.
        if (result && result.ok && result.taskId) {
          Promise.resolve(api.kill({ taskId: result.taskId })).catch(() => { /* main owns refusal logging */ });
        }
        return;
      }
      if (!result || result.ok === false) {
        running = false;
        discardPreReadyBuffer();
        const message = (result && result.message) || 'Could not start the task.';
        appendCleanText('\n[run] ' + message);
        emitRunStateChange();
        toast(message);
        appendClientLog('WARN', 'ide.run.dispatch_failed', { code: (result && result.code) || '' });
        return;
      }
      activeTaskId = String(result.taskId || '');
      if (!activeTaskId) {
        running = false;
        discardPreReadyBuffer();
        appendCleanText('\n[run] could not start the task (no task id)');
        emitRunStateChange();
        toast('Could not start the task (no task id).');
        appendClientLog('WARN', 'ide.run.no_session', {});
        return;
      }
      // Replay anything that raced the reply through the exact-match apply
      // paths. A buffered exit for THIS taskId settles the run right here
      // (never stuck "running" for a task main already settled).
      replayPreReadyBuffer();
      appendClientLog('INFO', 'ide.run.dispatched', {});
    }

    // One-click kill: main owns the taskId, so this always targets the actual
    // running child process tree regardless of what the renderer's `running`
    // flag shows - there is no text-derived state for a malicious script to
    // desync it from (see the header comment).
    function kill() {
      if (disposed) {
        return;
      }
      clearStartTimer();
      dispatchGeneration += 1; // a pending start() in flight is now stale too
      const killGeneration = dispatchGeneration;
      dispatching = false;
      discardPreReadyBuffer(); // a killed dispatch's buffered events never replay
      const api = getWorkspaceRunTaskApi();
      if (activeTaskId && api && typeof api.kill === 'function') {
        // main reports whether the process TREE was confirmed dead
        // (workspace-run-task-runner.js: terminationConfirmed). Throwing that
        // answer away is what made a failed kill look identical to a clean
        // stop. A rejected request is not a confirmed death either, so both
        // paths fold into the same boolean.
        Promise.resolve(api.kill({ taskId: activeTaskId }))
          .then((outcome) => outcome && outcome.terminationConfirmed === true)
          .catch(() => false)
          .then((confirmed) => {
            if (confirmed || disposed || dispatchGeneration !== killGeneration) {
              return; // confirmed dead, gone, or a newer run already owns the row
            }
            killUnconfirmed = true;
            appendCleanText('\n[run] stop unconfirmed \u2014 the process tree may still be running');
            emitRunStateChange();
            appendClientLog('WARN', 'ide.run.kill_unconfirmed', {});
          });
      }
      if (running || activeTaskId) {
        running = false;
        activeTaskId = '';
        ansiStripper.reset();
        appendCleanText('\n[run] stopped');
        emitRunStateChange();
      }
    }

    /* ---- run entry points ----------------------------------------------- */

    function runnerFor(path) {
      const language = editorHost?.getActiveLanguageId?.() || '';
      if (LANGUAGE_RUNNERS[language]) {
        return LANGUAGE_RUNNERS[language];
      }
      return EXTENSION_RUNNERS[extensionOf(path)] || null;
    }

    function runActiveFile() {
      const path = editorHost?.getActivePath?.() || '';
      if (!path) {
        return;
      }
      if (isDiffTabId(path)) {
        toast('Open the file itself (not a diff or preview tab) to run it.');
        return;
      }
      const runner = runnerFor(path);
      if (!runner) {
        const ext = extensionOf(path);
        toast(`Running ${ext ? `.${ext}` : 'this kind of'} files isn't supported yet.`);
        return undefined;
      }
      return dispatch(`${runner} ${quoteArg(path, isPosixShell)}`, `${runner} ${baseNameOf(path)}`);
    }

    function runScript(name) {
      const scriptName = String(name || '');
      if (!scriptName) {
        return undefined;
      }
      return dispatch(`npm run ${quoteArg(scriptName, isPosixShell)}`, `npm run ${scriptName}`);
    }

    // Reads package.json via workspaceFs.readFile and extracts the scripts map.
    // Degrades on every failure mode (no bridge / no file / malformed JSON /
    // no scripts) to a tagged empty result the caller turns into a friendly toast.
    async function detectScripts() {
      const api = getWorkspaceFsApi();
      if (!api || typeof api.readFile !== 'function') {
        return { scripts: [], error: 'unavailable' };
      }
      let content;
      try {
        const payload = await api.readFile({ path: 'package.json' });
        content = payload && typeof payload.content === 'string' ? payload.content : '';
      } catch (error) {
        appendClientLog('INFO', 'ide.run.no_package_json', { message: messageOf(error) });
        return { scripts: [], error: 'not-found' };
      }
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (_error) {
        return { scripts: [], error: 'parse' };
      }
      const scriptsObj = parsed && typeof parsed.scripts === 'object' && parsed.scripts ? parsed.scripts : null;
      if (!scriptsObj) {
        return { scripts: [], error: 'empty' };
      }
      const scripts = Object.keys(scriptsObj)
        .filter((name) => typeof scriptsObj[name] === 'string')
        .map((name) => ({ name, command: String(scriptsObj[name]) }));
      return { scripts, error: scripts.length ? '' : 'empty' };
    }

    function scriptUnavailableMessage(error) {
      switch (error) {
        case 'not-found':
          return 'No package.json found in this workspace.';
        case 'parse':
          return 'package.json could not be parsed.';
        case 'unavailable':
          return 'Workspace file access is unavailable in this shell mode.';
        default:
          return 'package.json has no "scripts" to run.';
      }
    }

    async function pickAndRunScript() {
      const { scripts, error } = await detectScripts();
      if (!scripts.length) {
        toast(scriptUnavailableMessage(error));
        return;
      }
      openScriptPicker(scripts);
    }

    /* ---- script picker overlay (clones the quick-open overlay pattern) --- */

    let pickerEl = null;
    let pickerInput = null;
    let pickerResults = null;
    let pickerScripts = [];
    let pickerRows = [];
    let pickerSelected = 0;

    function buildPickerRow(script, index) {
      const selected = index === pickerSelected;
      return `<div class="ide-picker-row ide-quick-open-row${selected ? ' ide-picker-row--selected ide-quick-open-row--selected' : ''}"`
        + ` role="option" aria-selected="${selected ? 'true' : 'false'}"`
        + ` data-ide-run-script="${escapeHtml(script.name)}" title="${escapeHtml(script.command)}">`
        + `<span class="ide-picker-name ide-quick-open-name">${escapeHtml(script.name)}</span>`
        + `<span class="ide-picker-path ide-quick-open-path">${escapeHtml(script.command)}</span>`
        + '</div>';
    }

    function refreshPicker() {
      if (!pickerResults) {
        return;
      }
      const query = String(pickerInput?.value || '').trim().toLowerCase();
      pickerRows = (query
        ? pickerScripts.filter((s) => s.name.toLowerCase().includes(query)
          || s.command.toLowerCase().includes(query))
        : pickerScripts.slice()
      ).slice(0, MAX_PICKER_ROWS);
      pickerSelected = Math.max(0, Math.min(pickerSelected, pickerRows.length - 1));
      pickerResults.innerHTML = pickerRows.length
        ? pickerRows.map((script, index) => buildPickerRow(script, index)).join('')
        : '<div class="ide-picker-status ide-quick-open-status">No matching scripts.</div>';
      const selected = pickerResults.querySelector('.ide-quick-open-row--selected');
      selected?.scrollIntoView?.({ block: 'nearest' });
    }

    function movePickerSelection(delta) {
      if (!pickerRows.length) {
        return;
      }
      pickerSelected = (pickerSelected + delta + pickerRows.length) % pickerRows.length;
      refreshPicker();
    }

    function runSelectedScript() {
      const script = pickerRows[pickerSelected] || pickerRows[0] || null;
      closePicker();
      if (script) {
        runScript(script.name);
      }
    }

    function handlePickerKeydown(event) {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          movePickerSelection(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          movePickerSelection(-1);
          break;
        case 'Enter':
          event.preventDefault();
          runSelectedScript();
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          closePicker();
          break;
        default:
          break;
      }
    }

    function handlePickerInput() {
      pickerSelected = 0;
      refreshPicker();
    }

    function handlePickerClick(event) {
      const row = event.target?.closest?.('[data-ide-run-script]');
      if (row) {
        const name = row.dataset.ideRunScript || '';
        closePicker();
        runScript(name);
        return;
      }
      if (!event.target?.closest?.('.ide-quick-open-panel')) {
        closePicker();
      }
    }

    function ensurePicker() {
      if (pickerEl) {
        return pickerEl;
      }
      const stage = getDom().ideEditorStage || getDom().ideView || null;
      const documentRef = stage?.ownerDocument || null;
      if (!stage || !documentRef || typeof textField !== 'function') {
        return null;
      }
      pickerEl = documentRef.createElement('div');
      pickerEl.className = 'ide-picker-overlay ide-quick-open hidden';
      pickerEl.innerHTML = '<div class="ide-picker-panel ide-quick-open-panel">'
        + textField({
          className: 'ide-picker-field ide-quick-open-field',
          placeholder: 'Run npm script…',
          ariaLabel: 'Run npm script',
          dataset: { 'ide-run-picker-input': '1' },
        })
        + '<div class="ide-picker-results ide-quick-open-results" role="listbox" aria-label="npm scripts"></div>'
        + '</div>';
      stage.appendChild(pickerEl);
      pickerInput = pickerEl.querySelector('[data-ide-run-picker-input]')
        || pickerEl.querySelector('.inv-text-field-control')
        || null;
      pickerResults = pickerEl.querySelector('.ide-quick-open-results');
      pickerEl.addEventListener('click', handlePickerClick);
      pickerInput?.addEventListener('keydown', handlePickerKeydown);
      pickerInput?.addEventListener('input', handlePickerInput);
      return pickerEl;
    }

    function openScriptPicker(scripts) {
      pickerScripts = Array.isArray(scripts) ? scripts.slice() : [];
      if (!ensurePicker()) {
        toast('The script picker is unavailable in this view.');
        return;
      }
      pickerEl.classList.remove('hidden');
      if (pickerInput) {
        pickerInput.value = '';
      }
      pickerSelected = 0;
      refreshPicker();
      pickerInput?.focus?.();
    }

    function closePicker() {
      pickerEl?.classList.add('hidden');
      editorHost?.focus?.();
    }

    /* ---- registration / lifecycle --------------------------------------- */

    function registerActions() {
      if (typeof editorHost?.addEditorAction !== 'function') {
        return;
      }
      // selection intents take 1-7, word-wrap 3, debug 8; run follows at 9/10.
      editorHost.addEditorAction({
        id: 'jenny.run-file',
        label: 'Run this file',
        contextMenuGroupId: 'jenny',
        contextMenuOrder: 9,
        run: () => runActiveFile(),
      });
      editorHost.addEditorAction({
        id: 'jenny.run-script',
        label: 'Run npm script…',
        contextMenuGroupId: 'jenny',
        contextMenuOrder: 10,
        run: () => pickAndRunScript(),
      });
    }

    function handleRunClick(event) {
      if (!isActivePanel()) {
        return;
      }
      const action = event.target?.closest?.('[data-ide-run-action]');
      if (!action) {
        return;
      }
      const kind = action.dataset.ideRunAction;
      if (kind === 'kill') {
        kill();
      } else if (kind === 'clear') {
        resetRunOutput();
      }
    }

    function bindEvents() {
      ensureSubscribed();
      const mount = getMountEl();
      // The run view shares #ideBottomPanelContent with Terminal/Problems; binding
      // on the persistent host (not its churned children) keeps the listener alive
      // across innerHTML repaints, and the isActivePanel guard scopes it.
      if (mount && mount !== boundMount) {
        boundMount = mount;
        mount.addEventListener('click', handleRunClick);
      }
    }

    function dispose() {
      disposed = true;
      dispatchGeneration += 1;
      clearStartTimer();
      painter.cancel();
      running = false;
      activeTaskId = '';
      dispatching = false;
      discardPreReadyBuffer();
      if (boundMount) {
        boundMount.removeEventListener('click', handleRunClick);
        boundMount = null;
      }
      try {
        unsubData?.();
      } catch (_error) { /* already gone */ }
      unsubData = null;
      try {
        unsubExit?.();
      } catch (_error) { /* already gone */ }
      unsubExit = null;
      if (pickerEl) {
        pickerInput?.removeEventListener('keydown', handlePickerKeydown);
        pickerInput?.removeEventListener('input', handlePickerInput);
        pickerEl.removeEventListener('click', handlePickerClick);
        pickerEl.remove?.();
        pickerEl = null;
        pickerInput = null;
        pickerResults = null;
      }
      // The task is main-process-owned; leaving the view does not kill it - main
      // also participates in root-switch/shutdown teardown (workspace-root-
      // runtime.js / runtime-shutdown.js), so a still-running task is never
      // orphaned even if the renderer never calls kill() explicitly.
    }

    return {
      bindEvents,
      detectScripts,
      dispose,
      isRunning,
      kill,
      openScriptPicker,
      pickAndRunScript,
      registerActions,
      renderRunPanel,
      runActiveFile,
      runScript,
    };
  }

  return {
    createIdeRunScripts,
  };
});
