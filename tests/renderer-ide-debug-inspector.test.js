'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeDebugInspector,
} = require('../renderer/features/renderer-ide-debug-inspector');

// Flush pending microtasks + the 0ms macrotask queue (clipboard .then chains,
// timers armed with a tiny inspectTimeoutMs).
function flush(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeEditorHost(overrides = {}) {
  return {
    actions: [],
    addEditorAction(descriptor) {
      this.actions.push(descriptor);
      return { dispose() {} };
    },
    getActivePath() { return overrides.path !== undefined ? overrides.path : 'src/app.js'; },
    getActiveLanguageId() { return overrides.language !== undefined ? overrides.language : 'javascript'; },
    isDirty() { return overrides.dirty === true; },
  };
}

// Fake of the two terminal seams the inspector uses: the workspacePty bridge's
// onData stream ({ sessionId, data } events; independent listeners, each with
// an unsubscribe) and the PTY panel's sendCommand(builder), which starts the
// single session when needed, builds the command for the live shell and writes
// one CRLF line, resolving false (nothing written) when the start fails or the
// builder throws - exactly the renderer-ide-pty-terminal-panel contract.
function fakeTerminal(overrides = {}) {
  let seq = 0;
  const listeners = [];
  return {
    listeners,
    calls: { start: [], write: [], onDataSeq: -1, writeSeq: -1 },
    onData(fn) {
      this.calls.onDataSeq = (seq += 1);
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async sendCommand(builder) {
      this.calls.start.push(true);
      if (typeof overrides.start === 'function') {
        await overrides.start();
      }
      if (overrides.startFails) {
        return false;
      }
      let command;
      try {
        command = builder(overrides.shell || 'powershell.exe', 'C:/ws');
      } catch (_error) {
        return false;
      }
      this.calls.writeSeq = (seq += 1);
      this.calls.write.push({ sessionId: 'pty-1', data: `${command}\r\n` });
      return true;
    },
    emitData(data, sessionId = 'pty-1') {
      for (const fn of listeners.slice()) {
        fn({ sessionId, data });
      }
    },
  };
}

// node prints a v4 UUID target; the scrape requires the full UUID.
const UUID_A = '0f2c936f-b1cd-4ac9-aab3-f63b0f33d55e';
const UUID_B = '7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6';
const banner = (hostPort, uuid = UUID_A) => `Debugger listening on ws://${hostPort}/${uuid}\n`;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function fakeClipboard() {
  return { written: [], async writeText(text) { this.written.push(text); } };
}

// Every inspector built by harness() is disposed after its test. debugActiveFile()
// arms production's inspect timeout (DEFAULT_TIMEOUT_MS) as a REFERENCED timer,
// and the launch cases that never emit a banner returned with it still armed:
// measured, this file held the event loop ~10s past its last assertion.
const liveInspectors = [];
test.afterEach(() => {
  while (liveInspectors.length) {
    const inspector = liveInspectors.pop();
    try { inspector.dispose(); } catch { /* already disposed by the test itself */ }
  }
});

function harness(opts = {}) {
  const terminal = opts.terminal || fakeTerminal();
  const clipboard = opts.clipboard === null ? null : (opts.clipboard || fakeClipboard());
  const toasts = [];
  const calls = { openTerminalPanel: 0, saveFile: [] };
  const rootContext = opts.rootContext !== undefined ? opts.rootContext : { rootPath: '/home/u/ws', phase: 'ready' };
  const inspector = createIdeDebugInspector({
    editorHost: opts.editorHost || fakeEditorHost(opts.hostOverrides),
    isDiffTabId: opts.isDiffTabId || (() => false),
    getWorkspacePtyApi: () => (opts.noTerminal ? null : terminal),
    getClipboardApi: () => clipboard,
    openTerminalPanel: () => { calls.openTerminalPanel += 1; },
    sendTerminalCommand: (builder) => terminal.sendCommand(builder),
    getWorkspaceRootApi: () => (opts.noRootApi ? null : { captureContext: async () => rootContext }),
    saveFile: async (path) => {
      calls.saveFile.push({ path, sentSoFar: terminal.calls.write.length });
      return opts.saveResult === undefined ? true : opts.saveResult;
    },
    showToastMessage: (message, meta) => toasts.push({ message, meta }),
    appendClientLog: () => {},
    inspectTimeoutMs: opts.inspectTimeoutMs,
  });
  liveInspectors.push(inspector);
  return { inspector, terminal, clipboard, toasts, calls };
}

function toastText(toasts) {
  return toasts.map((t) => t.message).join(' | ');
}

test('registers a single Node-inspector editor action in the jenny group', () => {
  const host = fakeEditorHost();
  const inspector = createIdeDebugInspector({ editorHost: host });
  inspector.registerActions();

  assert.equal(host.actions.length, 1);
  const action = host.actions[0];
  assert.equal(action.id, 'jenny.debug.inspect-node');
  assert.match(action.label, /Debug this file/i);
  assert.equal(action.contextMenuGroupId, 'jenny');
  assert.equal(action.contextMenuOrder, 8);
  assert.equal(typeof action.run, 'function');
});

test('registerActions is a no-op when Monaco is not ready', () => {
  const inspector = createIdeDebugInspector({ editorHost: { /* no addEditorAction */ } });
  assert.doesNotThrow(() => inspector.registerActions());
  assert.equal(inspector.registerActions(), undefined, 'returns nothing (pure no-op)');
});

test('subscribes to onData before writing the launch command', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  assert.ok(h.terminal.calls.onDataSeq > 0, 'onData was subscribed');
  assert.ok(h.terminal.calls.writeSeq > 0, 'write happened');
  assert.ok(
    h.terminal.calls.onDataSeq < h.terminal.calls.writeSeq,
    'onData subscription precedes the command write'
  );
});

test('writes node --inspect-brk with the quoted active path and reveals the terminal', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();

  assert.equal(h.terminal.calls.start.length, 1, 'sent through the panel once (it owns the session)');
  const data = h.terminal.calls.write.map((w) => w.data).join('');
  assert.match(data, /node\s+--inspect-brk\s+'\/home\/u\/ws\/src\/app\.js'/);
  assert.match(data, /\r\n$/, 'command is submitted with a trailing newline');
  assert.equal(h.calls.openTerminalPanel, 1, 'opens the bottom panel on the terminal tab (terminal echo)');
});

test('scrapes the ws:// banner and copies the raw devtools attach URL', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  h.terminal.emitData(banner('127.0.0.1:9229'));
  await flush();

  assert.equal(h.clipboard.written.length, 1, 'one URL copied');
  const url = h.clipboard.written[0];
  assert.ok(url.startsWith('devtools://devtools/bundled/js_app.html'), 'devtools front-end URL');
  assert.match(url, /experiments=true/);
  assert.match(url, /v8only=true/);
  // RAW ws target (NOT percent-encoded) - encoding ':' breaks DevTools attach.
  assert.match(url, /ws=127\.0\.0\.1:9229\/0f2c936f-b1cd-4ac9-aab3-f63b0f33d55e$/);
  assert.ok(!url.includes('%3A'), 'colon must not be percent-encoded');
  assert.match(toastText(h.toasts), /copied/i, 'a success toast fired');
});

test('scrapes the banner through ConPTY VT sequences (colors, cursor moves, titles), even split across chunks', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  const ESC = '\u001b';
  h.terminal.emitData(`${ESC}]0;node\u0007${ESC}[?25l${ESC}[31mDebugger listening on ws://127.0.0.1:9229/${UUID_B.slice(0, 10)}${ESC}[`);
  h.terminal.emitData(`0m${UUID_B.slice(10)}${ESC}[K\r\n`);
  await flush();
  assert.equal(h.clipboard.written.length, 1);
  assert.ok(h.clipboard.written[0].endsWith(`ws=127.0.0.1:9229/${UUID_B}`), h.clipboard.written[0]);
});

test('a hard-wrapped (truncated) banner is never copied as if it were the real target', async () => {
  const h = harness({ inspectTimeoutMs: 20 });
  await h.inspector.debugActiveFile();
  h.terminal.emitData(`Debugger listening on ws://127.0.0.1:9229/${UUID_A.slice(0, 20)}\r\n${UUID_A.slice(20)}\r\n`);
  await flush(60);
  assert.equal(h.clipboard.written.length, 0, 'no truncated URL on the clipboard');
  assert.match(toastText(h.toasts), /timed out.*terminal panel/i, 'the user is pointed at the visible banner');
});

test('reassembles a banner split across two onData chunks (no truncated URL)', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:92');
  // No newline yet -> must NOT match the truncated "ws://127.0.0.1:92".
  await flush();
  assert.equal(h.clipboard.written.length, 0, 'partial line is not matched');
  h.terminal.emitData(`29/${UUID_A}\nFor help, see: https://nodejs.org\n`);
  await flush();
  assert.equal(h.clipboard.written.length, 1);
  assert.ok(h.clipboard.written[0].endsWith(`ws=127.0.0.1:9229/${UUID_A}`));
});

test('does not launch for non-JavaScript files', async () => {
  const h = harness({ hostOverrides: { path: 'README.md', language: 'markdown' } });
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.start.length, 0, 'no session started');
  assert.equal(h.calls.openTerminalPanel, 0);
  assert.match(toastText(h.toasts), /javascript/i);
});

test('treats .mjs / .cjs by extension even without a language id', async () => {
  const h = harness({ hostOverrides: { path: 'scripts/tool.mjs', language: '' } });
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.start.length, 1);
  assert.match(h.terminal.calls.write.map((w) => w.data).join(''), /'\/home\/u\/ws\/scripts\/tool\.mjs'/);
});

test('single-quotes the path so a crafted file name cannot inject shell commands', async () => {
  // "$(calc).js" and backtick names are LEGAL on Windows and would be expanded
  // inside double quotes by PowerShell/bash; single quotes keep them literal.
  const h = harness({ hostOverrides: { path: 'src/$(calc).js', language: 'javascript' } });
  await h.inspector.debugActiveFile();
  const data = h.terminal.calls.write.map((w) => w.data).join('');
  assert.match(data, /node --inspect-brk '\/home\/u\/ws\/src\/\$\(calc\)\.js'/, 'metachars stay inside single quotes');
  assert.ok(!data.includes('"'), 'no double quotes that would allow expansion');
});

test('escapes apostrophes for the terminal shell on PowerShell and POSIX', async () => {
  const path = "src/o'neil.js";
  const powershell = harness({ terminal: fakeTerminal({ shell: 'powershell.exe' }), hostOverrides: { path } });
  await powershell.inspector.debugActiveFile();
  assert.equal(powershell.terminal.calls.write[0].data, "node --inspect-brk '/home/u/ws/src/o''neil.js'\r\n");

  const bash = harness({ terminal: fakeTerminal({ shell: 'bash' }), hostOverrides: { path } });
  await bash.inspector.debugActiveFile();
  assert.equal(bash.terminal.calls.write[0].data, "node --inspect-brk '/home/u/ws/src/o'\\''neil.js'\r\n");
});

test('does not launch for diff / preview tabs', async () => {
  const h = harness({
    hostOverrides: { path: 'diff://snapshot/src/app.js', language: 'javascript' },
    isDiffTabId: (p) => String(p).startsWith('diff://'),
  });
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.start.length, 0);
  assert.match(toastText(h.toasts), /diff or preview/i);
});

test('surfaces a timeout when the banner never arrives, and clears busy', async () => {
  const h = harness({ inspectTimeoutMs: 10 });
  await h.inspector.debugActiveFile();
  await flush(40);
  assert.equal(h.clipboard.written.length, 0, 'nothing copied');
  assert.match(toastText(h.toasts), /timed out/i);
  // busy must be cleared: a fresh launch starts a second session.
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.start.length, 2, 'not stuck busy after a timeout');
});

test('a delayed terminal start cannot write after the inspector launch times out', async () => {
  let resolveStart;
  const terminal = fakeTerminal({ start: () => new Promise((resolve) => { resolveStart = resolve; }) });
  const h = harness({ terminal, inspectTimeoutMs: 5 });
  const launch = h.inspector.debugActiveFile();
  await flush(20);
  resolveStart();
  await launch;

  assert.equal(terminal.calls.write.length, 0, 'a timed-out launch never writes a late command');
  assert.equal(h.toasts.filter((entry) => /could not launch/i.test(entry.message)).length, 0,
    'the stale refusal settles silently (the timeout already spoke)');
});

test('disposing during a delayed terminal start prevents every late launch side effect', async () => {
  let resolveStart;
  const terminal = fakeTerminal({ start: () => new Promise((resolve) => { resolveStart = resolve; }) });
  const h = harness({ terminal, inspectTimeoutMs: 5000 });
  const launch = h.inspector.debugActiveFile();
  await Promise.resolve();
  h.inspector.dispose();
  resolveStart();
  await launch;

  assert.equal(terminal.calls.write.length, 0, 'dispose prevents a late command write');
  assert.equal(h.toasts.length, 0, 'a disposed launch surfaces nothing');
});

test('guards against a concurrent launch while one is in flight', async () => {
  const h = harness();
  const first = h.inspector.debugActiveFile();
  await h.inspector.debugActiveFile(); // synchronously sees busy === true
  await first;
  assert.equal(h.terminal.calls.start.length, 1, 'only one session started');
  assert.match(toastText(h.toasts), /already starting/i);
});

test('reports a missing terminal bridge without throwing', async () => {
  const h = harness({ noTerminal: true });
  await assert.doesNotReject(() => h.inspector.debugActiveFile());
  assert.match(toastText(h.toasts), /terminal is unavailable/i);
});

test('surfaces the URL inline when the clipboard is unavailable', async () => {
  const h = harness({ clipboard: null });
  await h.inspector.debugActiveFile();
  h.terminal.emitData(banner('127.0.0.1:9229'));
  await flush();
  assert.match(toastText(h.toasts), new RegExp(`devtools://.*${escapeRe(`ws=127.0.0.1:9229/${UUID_A}`)}`));
});

test('falls back to an inline toast when the clipboard write rejects', async () => {
  const rejecting = { written: [], async writeText() { throw new Error('clipboard blocked'); } };
  const h = harness({ clipboard: rejecting });
  await h.inspector.debugActiveFile();
  h.terminal.emitData(banner('127.0.0.1:9229'));
  await flush();
  assert.match(toastText(h.toasts), new RegExp(`devtools://.*${escapeRe(`ws=127.0.0.1:9229/${UUID_A}`)}`));
  // busy must clear so a later launch still works.
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.start.length, 2);
});

test('settles cleanly across two back-to-back successful launches', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  h.terminal.emitData(banner('127.0.0.1:9229', UUID_A));
  await flush();
  assert.equal(h.clipboard.written.length, 1);
  assert.ok(h.clipboard.written[0].endsWith(`/${UUID_A}`));

  await h.inspector.debugActiveFile();
  h.terminal.emitData(banner('127.0.0.1:9230', UUID_B));
  await flush();
  assert.equal(h.clipboard.written.length, 2, 'second launch settles too (settled reset)');
  assert.ok(h.clipboard.written[1].endsWith(`ws=127.0.0.1:9230/${UUID_B}`));
  assert.equal(h.terminal.listeners.length, 0, 'no listener leak across launches');
});

test('unsubscribes the onData listener after a successful settle (no leak)', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.listeners.length, 1, 'subscribed during the launch');
  h.terminal.emitData(banner('127.0.0.1:9229'));
  await flush();
  assert.equal(h.terminal.listeners.length, 0, 'listener removed after the banner settles');
});

test('a launch error settles cleanly and toasts', async () => {
  const h = harness({ terminal: fakeTerminal({ startFails: true }) });
  await h.inspector.debugActiveFile();
  await flush();
  assert.match(toastText(h.toasts), /could not launch/i);
  assert.equal(h.terminal.listeners.length, 0, 'listener cleaned up on error');
});

test('dispose cancels an in-flight launch and removes the listener', async () => {
  const h = harness({ inspectTimeoutMs: 5000 });
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.listeners.length, 1);
  h.inspector.dispose();
  assert.equal(h.terminal.listeners.length, 0, 'dispose unsubscribed the in-flight listener');
  // A banner arriving after dispose is ignored (no copy).
  h.terminal.emitData(banner('127.0.0.1:9229'));
  await flush();
  assert.equal(h.clipboard.written.length, 0);
});

// IDE-017: the shared interactive shell's cwd may have moved, so the launch
// targets an ABSOLUTE path built from the LIVE workspace root.
test('IDE-017: builds an absolute target from a POSIX root and from a Windows root', async () => {
  const posix = harness({ rootContext: { rootPath: '/home/u/ws', phase: 'ready' }, terminal: fakeTerminal({ shell: 'bash' }) });
  await posix.inspector.debugActiveFile();
  assert.equal(posix.terminal.calls.write[0].data, "node --inspect-brk '/home/u/ws/src/app.js'\r\n");

  const win = harness({ rootContext: { root_path: 'C:\\ws', phase: 'ready' } });
  await win.inspector.debugActiveFile();
  assert.equal(win.terminal.calls.write[0].data, "node --inspect-brk 'C:\\ws\\src\\app.js'\r\n",
    'a backslash root joins with backslashes and converts the relative separators');
});

test('IDE-017: a missing, unavailable or not-ready live root writes nothing and toasts launch-failed', async () => {
  for (const options of [
    { noRootApi: true },
    { rootContext: null },
    { rootContext: { rootPath: '', phase: 'ready' } },
    { rootContext: { rootPath: '/home/u/ws', phase: 'switching' } },
  ]) {
    const h = harness(options);
    await h.inspector.debugActiveFile();
    assert.equal(h.terminal.calls.write.length, 0, `nothing written for ${JSON.stringify(options)}`);
    assert.match(toastText(h.toasts), /could not launch the debug session/i);
    assert.equal(h.terminal.listeners.length, 0, 'listener cleaned up');
    // busy cleared: a fresh launch is not stuck behind "already starting".
    await h.inspector.debugActiveFile();
    assert.doesNotMatch(toastText(h.toasts), /already starting/i);
  }
});

// IDE-008: the launched process reads the file from disk, so a dirty buffer is
// saved first (save-then-run, no dialog).
test('IDE-008: a dirty buffer is saved before the debug command is sent', async () => {
  const h = harness({ hostOverrides: { dirty: true } });
  await h.inspector.debugActiveFile();
  assert.deepEqual(h.calls.saveFile, [{ path: 'src/app.js', sentSoFar: 0 }], 'saved first, before any write');
  assert.equal(h.terminal.calls.write.length, 1, 'the command was sent after the save');
});

test('IDE-008: a failed save sends nothing, toasts, and leaves the inspector reusable', async () => {
  const h = harness({ hostOverrides: { dirty: true }, saveResult: false });
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.start.length, 0, 'no terminal session started');
  assert.equal(h.terminal.calls.write.length, 0);
  assert.match(toastText(h.toasts), /Could not save src\/app\.js, so the debug session was not started\./);
  await h.inspector.debugActiveFile();
  assert.doesNotMatch(toastText(h.toasts), /already starting/i, 'busy was released after the failed save');
});

test('IDE-008: a clean buffer never calls saveFile', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  assert.equal(h.calls.saveFile.length, 0);
  assert.equal(h.terminal.calls.write.length, 1);
});

// --- Multi-terminal (row 40 W4): the launch opens its OWN terminal. ---

// A task-terminal handle like terminal-set.openTaskTerminal resolves: the
// session-filtered onData plus its own sendCommand. `userTerminal` stands for
// the user's slot-1 shell and must never be written.
function taskHarness(opts = {}) {
  const userTerminal = fakeTerminal();
  const task = fakeTerminal();
  const opened = [];
  const h = harness({
    ...opts,
    terminal: userTerminal,
  });
  const inspector = createIdeDebugInspector({
    editorHost: fakeEditorHost(),
    getWorkspacePtyApi: () => userTerminal,
    getClipboardApi: () => h.clipboard,
    openTerminalPanel: () => { h.calls.openTerminalPanel += 1; },
    sendTerminalCommand: (builder) => userTerminal.sendCommand(builder),
    captureTaskTarget: opts.captureTaskTarget,
    openTaskTerminal: async (near) => {
      opened.push(near === undefined ? true : near);
      if (opts.noFree) return null;
      if (opts.startFails) return false;
      return {
        viewId: 'terminal-2',
        sendCommand: (builder) => task.sendCommand(builder),
        // Filtered like the real handle: only this terminal's session.
        onData: (fn) => task.onData((payload) => { if (payload.sessionId === 'pty-1') fn(payload); }),
      };
    },
    getWorkspaceRootApi: () => ({ captureContext: async () => ({ rootPath: '/home/u/ws', phase: 'ready' }) }),
    showToastMessage: (message, meta) => h.toasts.push({ message, meta }),
    appendClientLog: () => {},
    inspectTimeoutMs: opts.inspectTimeoutMs,
  });
  liveInspectors.push(inspector);
  return { ...h, inspector, userTerminal, task, opened };
}

test('task terminal: launches in its own terminal and never writes the user terminal', async () => {
  const h = taskHarness();
  await h.inspector.debugActiveFile();
  assert.equal(h.opened.length, 1);
  assert.ok(h.task.calls.onDataSeq > 0 && h.task.calls.onDataSeq < h.task.calls.writeSeq, 'subscribes to its terminal before the write');
  assert.match(h.task.calls.write.map((w) => w.data).join(''), /node\s+--inspect-brk\s+'\/home\/u\/ws\/src\/app\.js'/);
  assert.deepEqual(h.userTerminal.calls.write, [], 'the user terminal is never written');
  assert.equal(h.userTerminal.calls.onDataSeq, -1, 'and never subscribed to');
  assert.equal(h.calls.openTerminalPanel, 0, 'the task terminal reveals itself');

  h.task.emitData('shell noise\n', 'pty-9');
  h.task.emitData(banner('127.0.0.1:9229'));
  await flush();
  assert.equal(h.clipboard.written.length, 1, 'the banner of its own session is scraped');
  h.userTerminal.emitData(banner('127.0.0.1:9230', UUID_B));
  assert.equal(h.clipboard.written.length, 1, 'banners from the user terminal are not heard');
});

test('task terminal: the bound terminal is read when Debug starts, not after the save (W7c)', async () => {
  let target = 'terminal-3';
  const h = taskHarness({ captureTaskTarget: () => target });
  const run = h.inspector.debugActiveFile();
  target = 'terminal-4'; // focus moves to another group while the root is captured
  await run;
  assert.deepEqual(h.opened, ['terminal-3']);
});

test('task terminal: no free terminal toasts and launches nothing', async () => {
  const h = taskHarness({ noFree: true });
  await h.inspector.debugActiveFile();
  assert.match(toastText(h.toasts), /Close a terminal to start the debugger \(four are open\)\./);
  assert.deepEqual(h.task.calls.write, []);
  assert.deepEqual(h.userTerminal.calls.write, []);
  assert.equal(h.task.listeners.length, 0, 'nothing is left subscribed');
  // The guard is released: a later launch can still run.
  await h.inspector.debugActiveFile();
  assert.equal(h.opened.length, 2);
});

test('task terminal: works with no global workspacePty bridge (the handle supplies its stream)', async () => {
  const h = taskHarness({ noTerminal: true });
  await h.inspector.debugActiveFile();
  assert.equal(h.task.calls.write.length, 1);
});

test('legacy path (no openTaskTerminal) still types into the shared terminal', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.write.length, 1);
  assert.equal(h.calls.openTerminalPanel, 1);
});

test('task terminal: a terminal that could not start adds no second, wrong toast', async () => {
  const h = taskHarness({ startFails: true });
  await h.inspector.debugActiveFile();
  assert.doesNotMatch(toastText(h.toasts), /four are open/, 'the panel already said why it could not start');
  assert.deepEqual(h.task.calls.write, []);
  assert.deepEqual(h.userTerminal.calls.write, []);
  await h.inspector.debugActiveFile();
  assert.equal(h.opened.length, 2, 'the guard is released');
});
