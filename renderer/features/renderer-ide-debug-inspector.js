/* renderer/features/renderer-ide-debug-inspector.js - lightweight "Debug this
 * file (Node Inspector)" editor action for the Workspace IDE (Tier-2,
 * launch-and-attach scope only; the embedded breakpoint/step/variables panel is
 * a separate Tier-4 item).
 *
 * Flow: a Monaco editor action gates to JavaScript files, reveals + starts the
 * single piped workspace terminal (so the user sees the inspector output),
 * writes `node --inspect-brk "<path>"` to that session, and scrapes the V8
 * banner ("Debugger listening on ws://HOST:PORT/UUID") from the terminal
 * onData stream. On a hit it builds the canonical browser DevTools attach URL
 * (devtools://devtools/bundled/js_app.html?...&ws=HOST:PORT/UUID) and copies it
 * to the clipboard with a toast (paste into a Chromium-compatible DevTools window to attach). The raw
 * ws:// line stays visible in the Terminal panel - the "terminal echo".
 *
 * Why no IPC / no native module: CDP is just a websocket the EXTERNAL DevTools
 * front-end speaks; we only launch the process (via the existing terminal stdin
 * write) and surface the URL. There is no renderer-callable bridge that can OS-
 * open a ws:// / devtools:// URL (workspaceFs.openInDefaultApp does path
 * containment + an existence check + shell.openPath, and those schemes are not
 * OS-shell-openable), so v1 surfaces the URL via the clipboard instead. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDebugInspector = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const asyncFence = globalRef.rendererAsyncFence
    || (typeof require === 'function' ? require('../shared/async-fence') : {});

  const ACTION_ID = 'jenny.debug.inspect-node';
  const ACTION_LABEL = 'Debug this file (Node Inspector)';
  const TOAST_KEY = 'ide:debug:inspect';
  // The DevTools front-end parses the ws target itself, so the value is the RAW
  // host:port/uuid (NOT percent-encoded - encoding the ':' breaks attach).
  const DEVTOOLS_URL_PREFIX = 'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=';
  // V8 prints the banner to stderr; capture everything after "ws://".
  const WS_BANNER_RE = /Debugger listening on (ws:\/\/\S+)/;
  // node --inspect-brk only runs JavaScript; .ts needs a loader, so gate it out.
  const JS_LANGUAGE_IDS = new Set(['javascript']);
  const JS_EXTENSION_RE = /\.(c|m)?js$/i;
  // Rolling stderr window so a banner split across onData chunks still matches.
  const BUFFER_CAP = 4096;
  const DEFAULT_TIMEOUT_MS = 10000;

  function messageOf(error) {
    return String((error && error.message) || error || '');
  }

  // Single-quote the path so a crafted file name (e.g. "$(calc).js" or one with
  // backticks - both LEGAL filename chars on Windows) cannot trigger sub-
  // expression / command substitution in the shell. Embedded apostrophes use
  // the quoting sequence required by the terminal's actual shell.
  function quoteArg(value, shell) {
    const text = String(value);
    return "'" + (/powershell|pwsh/i.test(String(shell || ''))
      ? text.replace(/'/g, "''") : text.replace(/'/g, "'\\''")) + "'";
  }

  function createIdeDebugInspector(deps) {
    const options = deps || {};
    const editorHost = options.editorHost || null;
    const isDiffTabId = typeof options.isDiffTabId === 'function' ? options.isDiffTabId : () => false;
    const getWorkspaceTerminalApi = typeof options.getWorkspaceTerminalApi === 'function'
      ? options.getWorkspaceTerminalApi
      : () => null;
    const getClipboardApi = typeof options.getClipboardApi === 'function' ? options.getClipboardApi : () => null;
    // Opens the bottom panel on the Terminal tab (the terminal moved off the rail)
    // so node's ws:// banner is visible there; the controller wires this.
    const openTerminalPanel = typeof options.openTerminalPanel === 'function' ? options.openTerminalPanel : () => {};
    const startTerminalSession = typeof options.startTerminalSession === 'function'
      ? options.startTerminalSession
      : () => Promise.resolve(false);
    const showToastMessage = typeof options.showToastMessage === 'function' ? options.showToastMessage : () => {};
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : () => {};
    const inspectTimeoutMs = Number.isFinite(options.inspectTimeoutMs) ? options.inspectTimeoutMs : DEFAULT_TIMEOUT_MS;
    const disposalFence = asyncFence.createDisposalFence();
    const launchGate = asyncFence.createGenerationGate();

    // One launch at a time; `settled` makes the banner/timeout/error race settle
    // exactly once and unsubscribe the onData listener (no cross-launch leak).
    let busy = false;
    let settled = false;
    let activeUnsub = null;
    let activeTimer = null;

    function launchIsCurrent(token) {
      return !settled && !disposalFence.isDisposed() && launchGate.isCurrent(token);
    }

    function toast(message) {
      showToastMessage(message, { dedupeKey: TOAST_KEY });
    }

    function cleanup() {
      if (activeTimer) {
        clearTimeout(activeTimer);
        activeTimer = null;
      }
      if (typeof activeUnsub === 'function') {
        try {
          activeUnsub();
        } catch (_error) {
          /* listener already gone */
        }
      }
      activeUnsub = null;
      busy = false;
    }

    function finishWith(action) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        action();
      } catch (_error) {
        /* a toast must never break teardown */
      }
    }

    function isJavaScriptTarget(path) {
      const language = editorHost?.getActiveLanguageId?.() || '';
      return JS_LANGUAGE_IDS.has(language) || JS_EXTENSION_RE.test(path);
    }

    // Open the bottom panel on the Terminal tab and let the panel adopt the
    // (now-running) session so node's output - including the ws:// banner - is
    // visible there.
    async function revealTerminal() {
      openTerminalPanel();
      await startTerminalSession();
    }

    function copyInspectorUrl(wsUrl) {
      const wsTarget = wsUrl.replace(/^ws:\/\//i, '');
      const devtoolsUrl = DEVTOOLS_URL_PREFIX + wsTarget;
      // Surface host:port so the user can tell sessions apart - each launch
      // spawns a NEW paused process (V8 auto-increments the port if 9229 is
      // taken), and they accumulate until the terminal is Ctrl+C'd / restarted.
      const hostPort = wsTarget.split('/')[0];
      finishWith(() => {
        const clipboard = getClipboardApi();
        if (!clipboard || typeof clipboard.writeText !== 'function') {
          toast('Debugger ready (' + hostPort + '). Inspector URL: ' + devtoolsUrl);
          return;
        }
        Promise.resolve(clipboard.writeText(devtoolsUrl))
          .then(() => toast('Inspector URL copied (' + hostPort + ') — paste it into a Chromium-compatible DevTools window to attach.'))
          .catch((error) => {
            appendClientLog('WARN', 'ide.debug.clipboard_failed', { message: messageOf(error) });
            toast('Debugger ready (' + hostPort + '). Inspector URL: ' + devtoolsUrl);
          });
      });
    }

    async function debugActiveFile() {
      if (disposalFence.isDisposed()) {
        return;
      }
      if (busy) {
        toast('A debug session is already starting…');
        return;
      }
      const path = editorHost?.getActivePath?.() || '';
      if (!path) {
        return;
      }
      if (isDiffTabId(path)) {
        toast('Open the file itself (not a diff or preview tab) to debug it.');
        return;
      }
      if (!isJavaScriptTarget(path)) {
        toast('Debugging is currently available for JavaScript files only.');
        return;
      }
      const terminal = getWorkspaceTerminalApi();
      if (!terminal || typeof terminal.start !== 'function'
        || typeof terminal.write !== 'function' || typeof terminal.onData !== 'function') {
        toast('The workspace terminal is unavailable in this shell mode.');
        return;
      }

      busy = true;
      settled = false;
      launchGate.bump();
      const launchToken = launchGate.capture();
      let buffer = '';
      // Set once start() resolves; the onData filter ignores any other session's
      // output (a restart/another consumer reuses the shared piped terminal).
      let launchSessionId = '';
      // Subscribe BEFORE writing the command so the banner is never missed (the
      // child can emit before the write promise resolves).
      try {
        activeUnsub = terminal.onData((payload) => {
          if (settled) {
            return;
          }
          const chunk = payload && typeof payload.chunk === 'string' ? payload.chunk : '';
          if (!chunk) {
            return;
          }
          // Scrape only this launch's session. node prints the banner after the
          // command write (after start() resolves), so launchSessionId is always
          // known by then; an unknown id degrades to no-filter rather than over-
          // filtering. Mirrors run-scripts' handleData session guard.
          const eventId = payload && payload.sessionId != null ? String(payload.sessionId) : '';
          if (launchSessionId && eventId !== launchSessionId) {
            return;
          }
          // Match only COMPLETE lines so a banner split across chunks (e.g.
          // ".../127.0.0.1:92" then "29/uuid") never matches a truncated ws URL;
          // the partial tail is retained (capped) until its newline arrives.
          buffer += chunk;
          const lastNewline = buffer.lastIndexOf('\n');
          if (lastNewline === -1) {
            buffer = buffer.slice(-BUFFER_CAP);
            return;
          }
          const completeLines = buffer.slice(0, lastNewline);
          buffer = buffer.slice(lastNewline + 1).slice(-BUFFER_CAP);
          const match = WS_BANNER_RE.exec(completeLines);
          if (match) {
            copyInspectorUrl(match[1]);
          }
        }) || null;
      } catch (error) {
        appendClientLog('WARN', 'ide.debug.subscribe_failed', { message: messageOf(error) });
        finishWith(() => toast('Could not attach to the terminal output.'));
        return;
      }

      activeTimer = setTimeout(() => {
        finishWith(() => toast('Timed out waiting for the debugger to start. Check the Terminal panel.'));
      }, inspectTimeoutMs);

      try {
        // Start first (reliable session id even when the terminal was idle); a
        // missing workspace root throws here, before the panel is touched.
        const session = await terminal.start();
        if (!launchIsCurrent(launchToken)) return;
        const sessionId = session && session.sessionId ? String(session.sessionId) : '';
        launchSessionId = sessionId;
        await revealTerminal();
        if (!launchIsCurrent(launchToken)) return;
        await terminal.write({ sessionId, data: 'node --inspect-brk ' + quoteArg(path, session && session.shell) + '\r\n' });
        if (!launchIsCurrent(launchToken)) return;
        appendClientLog('INFO', 'ide.debug.launched', {});
      } catch (error) {
        appendClientLog('WARN', 'ide.debug.launch_failed', { message: messageOf(error) });
        finishWith(() => toast('Could not launch the debug session.'));
      }
    }

    function registerActions() {
      if (typeof editorHost?.addEditorAction !== 'function') {
        return;
      }
      editorHost.addEditorAction({
        id: ACTION_ID,
        label: ACTION_LABEL,
        contextMenuGroupId: 'jenny',
        // selection intents take 1-7 and word-wrap takes 3; debug follows at 8.
        contextMenuOrder: 8,
        run: () => debugActiveFile(),
      });
    }

    // Cancels an in-flight launch (view teardown) so the onData listener + timer
    // never outlive the controller.
    function dispose() {
      launchGate.bump();
      disposalFence.dispose();
      if (busy) {
        finishWith(() => {});
      }
    }

    return {
      registerActions,
      debugActiveFile,
      dispose,
    };
  }

  return { createIdeDebugInspector };
});
