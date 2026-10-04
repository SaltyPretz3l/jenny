/* renderer/features/renderer-ide-debug-inspector.js - lightweight "Debug this
 * file (Node Inspector)" editor action for the Workspace IDE (Tier-2,
 * launch-and-attach scope only; the embedded breakpoint/step/variables panel is
 * a separate Tier-4 item).
 *
 * Flow: a Monaco editor action gates to JavaScript files, reveals the Terminal
 * tab, and sends `node --inspect-brk '<path>'` through the PTY terminal panel's
 * sendCommand (which starts the single ConPTY session when needed and quotes for
 * its live shell), then scrapes the V8 banner ("Debugger listening on
 * ws://HOST:PORT/UUID") from the workspacePty onData stream after stripping VT
 * control sequences. On a hit it builds the canonical browser DevTools attach URL
 * (devtools://devtools/bundled/js_app.html?...&ws=HOST:PORT/UUID) and copies it
 * to the clipboard with a toast (paste into a Chromium-compatible DevTools window to attach). The raw
 * ws:// line stays visible in the Terminal panel - the "terminal echo".
 *
 * Why no IPC / no native module: CDP is just a websocket the EXTERNAL DevTools
 * front-end speaks; we only launch the process (via the terminal panel's
 * sanctioned command write) and surface the URL. There is no renderer-callable
 * bridge that can OS-open a ws:// / devtools:// URL
 * (workspaceFs.openInDefaultApp does path containment + an existence check +
 * shell.openPath, and those schemes are not OS-shell-openable), so v1 surfaces
 * the URL via the clipboard instead. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDebugInspector = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const asyncFence = globalRef.rendererAsyncFence
    || (typeof require === 'function' ? require('../shared/async-fence') : {});
  const ansiStreamUtils = globalRef.rendererAnsiStreamUtils
    || (typeof require === 'function' ? require('../shared/ansi-stream-utils') : {});

  const ACTION_ID = 'jenny.debug.inspect-node';
  const ACTION_LABEL = jt('ide.debug.actionLabel', 'Debug this file (Node Inspector)');
  const TOAST_KEY = 'ide:debug:inspect';
  // The DevTools front-end parses the ws target itself, so the value is the RAW
  // host:port/uuid (NOT percent-encoded - encoding the ':' breaks attach).
  const DEVTOOLS_URL_PREFIX = 'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=';
  // V8 prints the banner to stderr as ws://HOST:PORT/UUID. The full UUID is
  // required: a PTY can hard-wrap a long line, and a truncated target must
  // never be copied as if it were the real one (the timeout toast then points
  // the user at the banner in the Terminal panel instead).
  const WS_BANNER_RE = /Debugger listening on (ws:\/\/[^\s/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/i;
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

  // Joins the workspace-relative editor path onto the live root with the
  // separator the root itself uses. Only a drive-letter or UNC root is a Windows
  // path; a backslash elsewhere is a legal character in a POSIX folder name.
  function absoluteTarget(rootPath, relPath) {
    const sep = /^(?:[A-Za-z]:\\|\\\\)/.test(rootPath) ? '\\' : '/';
    const rel = sep === '/' ? relPath : relPath.replace(/\//g, sep);
    return rootPath.replace(/[\\/]+$/, '') + sep + rel;
  }

  function createIdeDebugInspector(deps) {
    const options = deps || {};
    const editorHost = options.editorHost || null;
    const isDiffTabId = typeof options.isDiffTabId === 'function' ? options.isDiffTabId : () => false;
    // workspacePty bridge: only its onData stream is read (the banner scrape).
    const getWorkspacePtyApi = typeof options.getWorkspacePtyApi === 'function'
      ? options.getWorkspacePtyApi
      : () => null;
    const getClipboardApi = typeof options.getClipboardApi === 'function' ? options.getClipboardApi : () => null;
    // Opens the bottom panel on the Terminal tab (the terminal moved off the rail)
    // so node's ws:// banner is visible there; the controller wires this.
    const openTerminalPanel = typeof options.openTerminalPanel === 'function' ? options.openTerminalPanel : () => {};
    // The PTY panel's sendCommand(builder): starts the session when needed,
    // calls builder(shell) and writes one CRLF line; resolves true on success
    // and false (nothing written) on failure or when the builder throws.
    const sendTerminalCommand = typeof options.sendTerminalCommand === 'function'
      ? options.sendTerminalCommand
      : () => Promise.resolve(false);
    // Live workspace root (captureContext) so the launch targets an ABSOLUTE
    // path: the shared interactive shell's cwd may have moved off the root.
    const getWorkspaceRootApi = typeof options.getWorkspaceRootApi === 'function' ? options.getWorkspaceRootApi : () => null;
    // Saves one open file; resolves true only on a successful save.
    const saveFile = typeof options.saveFile === 'function' ? options.saveFile : () => Promise.resolve(false);
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
          toast(jt('ide.debug.readyWithInspectorUrl', 'Debugger ready ({hostPort}). Inspector URL: {url}', { hostPort, url: devtoolsUrl }));
          return;
        }
        Promise.resolve(clipboard.writeText(devtoolsUrl))
          .then(() => toast(jt('ide.debug.inspectorUrlCopied', 'Inspector URL copied ({hostPort}) — paste it into a Chromium-compatible DevTools window to attach.', { hostPort })))
          .catch((error) => {
            appendClientLog('WARN', 'ide.debug.clipboard_failed', { message: messageOf(error) });
            toast(jt('ide.debug.readyWithInspectorUrl', 'Debugger ready ({hostPort}). Inspector URL: {url}', { hostPort, url: devtoolsUrl }));
          });
      });
    }

    async function debugActiveFile() {
      if (disposalFence.isDisposed()) {
        return;
      }
      if (busy) {
        toast(jt('ide.debug.alreadyStarting', 'A debug session is already starting…'));
        return;
      }
      const path = editorHost?.getActivePath?.() || '';
      if (!path) {
        return;
      }
      if (isDiffTabId(path)) {
        toast(jt('ide.debug.openFileToDebug', 'Open the file itself (not a diff or preview tab) to debug it.'));
        return;
      }
      if (!isJavaScriptTarget(path)) {
        toast(jt('ide.debug.javascriptOnly', 'Debugging is currently available for JavaScript files only.'));
        return;
      }
      const terminal = getWorkspacePtyApi();
      if (!terminal || typeof terminal.onData !== 'function') {
        toast(jt('ide.debug.terminalUnavailable', 'The workspace terminal is unavailable in this shell mode.'));
        return;
      }

      // The terminal runs the SAVED file: persist the visible buffer first (busy
      // holds the single-launch guard across the save).
      if (editorHost?.isDirty?.(path) === true) {
        busy = true;
        const saved = await Promise.resolve(saveFile(path)).then((ok) => ok === true, () => false);
        busy = false;
        if (disposalFence.isDisposed()) {
          return;
        }
        if (!saved) {
          toast(jt('ide.debug.saveBeforeDebugFailed', 'Could not save {path}, so the debug session was not started.', { path }));
          return;
        }
      }

      busy = true;
      settled = false;
      launchGate.bump();
      const launchToken = launchGate.capture();
      let buffer = '';
      // ConPTY output carries VT control sequences (colors, cursor moves, window
      // titles) that can split across chunks; the stateful stripper removes
      // them so the banner is matched on visible text. The PTY is single-session,
      // so every data event belongs to the terminal this launch writes into.
      const stripper = typeof ansiStreamUtils.createAnsiStreamStripper === 'function'
        ? ansiStreamUtils.createAnsiStreamStripper()
        : { push: (text) => text };
      // Subscribe BEFORE writing the command so the banner is never missed (the
      // child can emit before the write promise resolves).
      try {
        activeUnsub = terminal.onData((payload) => {
          if (settled) {
            return;
          }
          const chunk = payload && typeof payload.data === 'string' ? stripper.push(payload.data) : '';
          if (!chunk) {
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
        finishWith(() => toast(jt('ide.debug.attachFailed', 'Could not attach to the terminal output.')));
        return;
      }

      activeTimer = setTimeout(() => {
        finishWith(() => toast(jt('ide.debug.startTimeout', 'Timed out waiting for the debugger to start. Check the Terminal panel.')));
      }, inspectTimeoutMs);

      try {
        // Capture the live root first (same rule as Open in Terminal): a missing
        // or not-ready root launches nothing.
        const context = await getWorkspaceRootApi()?.captureContext?.();
        if (!launchIsCurrent(launchToken)) return;
        const rootPath = String(context?.rootPath ?? context?.root_path ?? '');
        if (!rootPath || (context?.phase && context.phase !== 'ready')) {
          appendClientLog('WARN', 'ide.debug.launch_failed', { message: 'workspace_root_unavailable' });
          finishWith(() => toast(jt('ide.debug.launchFailed', 'Could not launch the debug session.')));
          return;
        }
        // Reveal the Terminal tab first so the panel owns (spawns and sizes) the
        // PTY session and node's output - including the ws:// banner - is
        // visible there. The builder runs after the session is up and refuses
        // (throws, so nothing is written) once this launch is stale.
        openTerminalPanel();
        const sent = await sendTerminalCommand((shell) => {
          if (!launchIsCurrent(launchToken)) throw new Error('stale debug launch');
          return 'node --inspect-brk ' + quoteArg(absoluteTarget(rootPath, path), shell);
        });
        if (!launchIsCurrent(launchToken)) return;
        if (sent !== true) {
          appendClientLog('WARN', 'ide.debug.launch_failed', { message: 'terminal_command_not_sent' });
          finishWith(() => toast(jt('ide.debug.launchFailed', 'Could not launch the debug session.')));
          return;
        }
        appendClientLog('INFO', 'ide.debug.launched', {});
      } catch (error) {
        appendClientLog('WARN', 'ide.debug.launch_failed', { message: messageOf(error) });
        finishWith(() => toast(jt('ide.debug.launchFailed', 'Could not launch the debug session.')));
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
