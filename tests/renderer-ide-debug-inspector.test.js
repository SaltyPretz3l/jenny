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
  };
}

// Single-session terminal bridge fake mirroring workspace-terminal-service:
// onData registers an independent listener + returns an unsubscribe; start() is
// idempotent; emitData fans a { sessionId, stream, chunk } event to listeners.
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
    async start() {
      this.calls.start.push(true);
      if (typeof overrides.start === 'function') {
        return overrides.start();
      }
      if (overrides.startThrows) {
        throw new Error('No workspace root is configured.');
      }
      return { sessionId: 'term-1', shell: overrides.shell || 'powershell.exe', cwd: 'C:/ws', alreadyRunning: false };
    },
    async write(payload) {
      this.calls.writeSeq = (seq += 1);
      this.calls.write.push(payload);
    },
    emitData(chunk, stream = 'stderr', sessionId = 'term-1') {
      for (const fn of listeners.slice()) {
        fn({ sessionId, stream, chunk });
      }
    },
  };
}

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
  const calls = { startTerminalSession: 0, openTerminalPanel: 0 };
  const inspector = createIdeDebugInspector({
    editorHost: opts.editorHost || fakeEditorHost(opts.hostOverrides),
    isDiffTabId: opts.isDiffTabId || (() => false),
    getWorkspaceTerminalApi: () => (opts.noTerminal ? null : terminal),
    getClipboardApi: () => clipboard,
    openTerminalPanel: () => { calls.openTerminalPanel += 1; },
    startTerminalSession: () => { calls.startTerminalSession += 1; return Promise.resolve(true); },
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

  assert.equal(h.terminal.calls.start.length, 1, 'started the session once');
  const data = h.terminal.calls.write.map((w) => w.data).join('');
  assert.match(data, /node\s+--inspect-brk\s+'src\/app\.js'/);
  assert.match(data, /\r\n$/, 'command is submitted with a trailing newline');
  assert.equal(h.terminal.calls.write[0].sessionId, 'term-1', 'writes to the started session');
  assert.equal(h.calls.startTerminalSession, 1, 'panel adopts the session (terminal echo)');
  assert.equal(h.calls.openTerminalPanel, 1, 'opens the bottom panel on the terminal tab');
});

test('scrapes the ws:// banner and copies the raw devtools attach URL', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9229/0f2c936f-b1cd-4ac9-aab3-f63b0f33d55e\n');
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

test('scrapes the banner from stderr (the stream Node prints it to)', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9229/abc-123\n', 'stderr');
  await flush();
  assert.equal(h.clipboard.written.length, 1);
  assert.match(h.clipboard.written[0], /ws=127\.0\.0\.1:9229\/abc-123$/);
});

test('reassembles a banner split across two onData chunks (no truncated URL)', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:92');
  // No newline yet -> must NOT match the truncated "ws://127.0.0.1:92".
  await flush();
  assert.equal(h.clipboard.written.length, 0, 'partial line is not matched');
  h.terminal.emitData('29/split-uuid\nFor help, see: https://nodejs.org\n');
  await flush();
  assert.equal(h.clipboard.written.length, 1);
  assert.match(h.clipboard.written[0], /ws=127\.0\.0\.1:9229\/split-uuid$/);
});

test('ignores a banner from a different session and scrapes only its own', async (t) => {
  const h = harness({ inspectTimeoutMs: 5000 });
  t.after(() => h.inspector.dispose());
  await h.inspector.debugActiveFile(); // launch owns session 'term-1'
  // A banner from a stray/restarted session must NOT be scraped.
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9229/other-session\n', 'stderr', 'term-2');
  await flush();
  assert.equal(h.clipboard.written.length, 0, 'cross-session banner ignored');
  // The launch's own session settles it.
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9229/own-session\n', 'stderr', 'term-1');
  await flush();
  assert.equal(h.clipboard.written.length, 1, 'own-session banner scraped');
  assert.match(h.clipboard.written[0], /ws=127\.0\.0\.1:9229\/own-session$/);
});

test('does not launch for non-JavaScript files', async () => {
  const h = harness({ hostOverrides: { path: 'README.md', language: 'markdown' } });
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.start.length, 0, 'no session started');
  assert.equal(h.calls.startTerminalSession, 0);
  assert.match(toastText(h.toasts), /javascript/i);
});

test('treats .mjs / .cjs by extension even without a language id', async () => {
  const h = harness({ hostOverrides: { path: 'scripts/tool.mjs', language: '' } });
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.start.length, 1);
  assert.match(h.terminal.calls.write.map((w) => w.data).join(''), /'scripts\/tool\.mjs'/);
});

test('single-quotes the path so a crafted file name cannot inject shell commands', async () => {
  // "$(calc).js" and backtick names are LEGAL on Windows and would be expanded
  // inside double quotes by PowerShell/bash; single quotes keep them literal.
  const h = harness({ hostOverrides: { path: 'src/$(calc).js', language: 'javascript' } });
  await h.inspector.debugActiveFile();
  const data = h.terminal.calls.write.map((w) => w.data).join('');
  assert.match(data, /node --inspect-brk 'src\/\$\(calc\)\.js'/, 'metachars stay inside single quotes');
  assert.ok(!data.includes('"'), 'no double quotes that would allow expansion');
});

test('escapes apostrophes for the terminal shell on PowerShell and POSIX', async () => {
  const path = "src/o'neil.js";
  const powershell = harness({ terminal: fakeTerminal({ shell: 'powershell.exe' }), hostOverrides: { path } });
  await powershell.inspector.debugActiveFile();
  assert.equal(powershell.terminal.calls.write[0].data, "node --inspect-brk 'src/o''neil.js'\r\n");

  const bash = harness({ terminal: fakeTerminal({ shell: 'bash' }), hostOverrides: { path } });
  await bash.inspector.debugActiveFile();
  assert.equal(bash.terminal.calls.write[0].data, "node --inspect-brk 'src/o'\\''neil.js'\r\n");
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
  resolveStart({ sessionId: 'term-late', shell: 'powershell.exe' });
  await launch;

  assert.equal(terminal.calls.write.length, 0, 'a timed-out launch never writes a late command');
  assert.equal(h.calls.openTerminalPanel, 0, 'a timed-out launch never reveals the terminal late');
});

test('disposing during a delayed terminal start prevents every late launch side effect', async () => {
  let resolveStart;
  const terminal = fakeTerminal({ start: () => new Promise((resolve) => { resolveStart = resolve; }) });
  const h = harness({ terminal, inspectTimeoutMs: 5000 });
  const launch = h.inspector.debugActiveFile();
  await Promise.resolve();
  h.inspector.dispose();
  resolveStart({ sessionId: 'term-late', shell: 'powershell.exe' });
  await launch;

  assert.equal(terminal.calls.write.length, 0, 'dispose prevents a late command write');
  assert.equal(h.calls.openTerminalPanel, 0, 'dispose prevents a late terminal reveal');
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
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9229/no-clip\n');
  await flush();
  assert.match(toastText(h.toasts), /devtools:\/\/.*ws=127\.0\.0\.1:9229\/no-clip/);
});

test('falls back to an inline toast when the clipboard write rejects', async () => {
  const rejecting = { written: [], async writeText() { throw new Error('clipboard blocked'); } };
  const h = harness({ clipboard: rejecting });
  await h.inspector.debugActiveFile();
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9229/reject-uuid\n');
  await flush();
  assert.match(toastText(h.toasts), /devtools:\/\/.*ws=127\.0\.0\.1:9229\/reject-uuid/);
  // busy must clear so a later launch still works.
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.calls.start.length, 2);
});

test('settles cleanly across two back-to-back successful launches', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9229/first\n');
  await flush();
  assert.equal(h.clipboard.written.length, 1);
  assert.match(h.clipboard.written[0], /\/first$/);

  await h.inspector.debugActiveFile();
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9230/second\n');
  await flush();
  assert.equal(h.clipboard.written.length, 2, 'second launch settles too (settled reset)');
  assert.match(h.clipboard.written[1], /ws=127\.0\.0\.1:9230\/second$/);
  assert.equal(h.terminal.listeners.length, 0, 'no listener leak across launches');
});

test('unsubscribes the onData listener after a successful settle (no leak)', async () => {
  const h = harness();
  await h.inspector.debugActiveFile();
  assert.equal(h.terminal.listeners.length, 1, 'subscribed during the launch');
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9229/leak-check\n');
  await flush();
  assert.equal(h.terminal.listeners.length, 0, 'listener removed after the banner settles');
});

test('a launch error settles cleanly and toasts', async () => {
  const h = harness({ terminal: fakeTerminal({ startThrows: true }) });
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
  h.terminal.emitData('Debugger listening on ws://127.0.0.1:9229/after-dispose\n');
  await flush();
  assert.equal(h.clipboard.written.length, 0);
});
