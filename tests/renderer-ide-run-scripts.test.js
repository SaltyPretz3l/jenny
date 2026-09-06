'use strict';

/* Tier-2 "Run scripts": the run-scripts engine (renderer-ide-run-scripts).
 * UIUX-014: each run is its own main-owned task (workspaceRunTask bridge), not
 * text typed into the shared workspace-terminal session. Covers package.json
 * script detection + degrade paths, the composed shell string per language
 * (run-this-file) and per npm script, injection-safe path quoting, taskId-
 * gated running-state tracking (immune to marker-shaped stdout spoofing),
 * one-click kill by taskId, the start-timeout safety net (including killing a
 * late-resolving orphaned task), and the run-tab rendering. Fake run-task
 * bridge + fake fs; the picker overlay rides the real-app smoke. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createIdeRunScripts,
} = require('../renderer/features/renderer-ide-run-scripts');

function flush(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// UIUX-014 fake workspaceRunTask bridge: start()/kill() are invoke-shaped,
// onData/onExit register independent listeners + return an unsubscribe, and
// every emitted event is stamped with taskId (mirroring the real main-owned
// contract — never a session id, never text scanned out of stdout).
function fakeRunTask(overrides = {}) {
  const data = [];
  const exit = [];
  let counter = 0;
  return {
    data,
    exit,
    calls: { start: 0, kill: [] },
    onData(fn) {
      data.push(fn);
      return () => { const i = data.indexOf(fn); if (i >= 0) data.splice(i, 1); };
    },
    onExit(fn) {
      exit.push(fn);
      return () => { const i = exit.indexOf(fn); if (i >= 0) exit.splice(i, 1); };
    },
    async start(payload) {
      this.calls.start += 1;
      this.lastCommand = payload?.command;
      if (overrides.startImpl) {
        return overrides.startImpl(payload, this.calls.start);
      }
      if (overrides.startThrows) {
        throw new Error('No workspace root is configured.');
      }
      if (overrides.startHangs) {
        return new Promise(() => {}); // never settles (simulated bridge teardown)
      }
      if (overrides.startFails) {
        return { ok: false, code: overrides.failCode || 'CMP-RUNTASK-0001', message: overrides.failMessage || 'No workspace root is configured; choose a workspace folder first.' };
      }
      counter += 1;
      const taskId = overrides.taskId !== undefined ? overrides.taskId : `run-${counter}`;
      return { ok: true, taskId, cwd: 'C:/ws' };
    },
    async kill(payload) {
      this.calls.kill.push(payload);
      if (overrides.killThrows) {
        throw new Error('the run-task bridge is gone');
      }
      if (overrides.killImpl) {
        return overrides.killImpl(payload, this.calls.kill.length);
      }
      // Mirrors the real bridge: main always reports whether the process TREE
      // was confirmed dead, not just that a signal was sent.
      return { killed: true, terminationConfirmed: true };
    },
    emitData(chunk, taskId, stream = 'stdout') {
      for (const fn of data.slice()) fn({ taskId, stream, chunk });
    },
    emitExit(taskId, extra = {}) {
      for (const fn of exit.slice()) fn({ taskId, code: 0, status: 'exited', ...extra });
    },
  };
}

function fakeFs(overrides = {}) {
  return {
    calls: { readFile: [] },
    async readFile(payload) {
      this.calls.readFile.push(payload);
      if (overrides.readThrows) {
        throw new Error('ENOENT: no such file');
      }
      if (overrides.noReadFile) {
        return null;
      }
      return { content: overrides.content == null ? '' : overrides.content };
    },
  };
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
    focus() {},
  };
}

function harness(opts = {}) {
  const runTask = opts.noRunTask ? null : (opts.runTask || fakeRunTask(opts.runTaskOverrides));
  const fs = opts.noFs ? null : (opts.fs || fakeFs(opts.fsOverrides));
  const toasts = [];
  const calls = { openRunPanel: 0, runStateChange: 0 };
  const engine = createIdeRunScripts({
    getDom: opts.getDom || (() => ({})),
    isActivePanel: opts.isActivePanel || (() => false),
    editorHost: opts.editorHost || fakeEditorHost(opts.hostOverrides),
    getWorkspaceFsApi: () => fs,
    getWorkspaceRunTaskApi: () => runTask,
    isDiffTabId: opts.isDiffTabId || (() => false),
    openRunPanel: () => { calls.openRunPanel += 1; },
    onRunStateChange: () => { calls.runStateChange += 1; },
    appendClientLog: () => {},
    showToastMessage: (message) => toasts.push(message),
    runStartTimeoutMs: opts.runStartTimeoutMs,
    requestAnimationFrameImpl: opts.requestAnimationFrameImpl,
    cancelAnimationFrameImpl: opts.cancelAnimationFrameImpl,
    platform: opts.platform,
  });
  return { engine, runTask, fs, toasts, calls };
}

/* ---- editor action registration ------------------------------------------ */

test('registers Run this file (order 9) + Run npm script… (order 10) in the jenny group', () => {
  const host = fakeEditorHost();
  const engine = createIdeRunScripts({ editorHost: host });
  engine.registerActions();
  assert.equal(host.actions.length, 2);
  const file = host.actions.find((a) => a.id === 'jenny.run-file');
  const script = host.actions.find((a) => a.id === 'jenny.run-script');
  assert.ok(file && script, 'both actions registered');
  assert.match(file.label, /Run this file/i);
  assert.equal(file.contextMenuGroupId, 'jenny');
  assert.equal(file.contextMenuOrder, 9);
  assert.match(script.label, /Run npm script/i);
  assert.equal(script.contextMenuOrder, 10);
});

test('registerActions is a no-op when Monaco is not ready', () => {
  const engine = createIdeRunScripts({ editorHost: {} });
  let result;
  assert.doesNotThrow(() => { result = engine.registerActions(); });
  assert.equal(result, undefined, 'early return when addEditorAction is absent');
});

/* ---- run this file: composed command per language ------------------------ */

test('runActiveFile starts a task with the quoted path as ONE command string (no completion marker appended)', async () => {
  const h = harness();
  await h.engine.runActiveFile();
  assert.equal(h.runTask.calls.start, 1, 'started one task');
  assert.equal(h.runTask.lastCommand, "node 'src/app.js'", 'the command is exactly the composed shell string, nothing appended');
  assert.equal(h.calls.openRunPanel, 1, 'opens the bottom panel on the run view');
  assert.equal(h.engine.isRunning(), true, 'running indicator armed');
});

test('language id maps each interpreter (python / bash / npx tsx / go run / ruby / php)', async () => {
  const cases = [
    { language: 'python', path: 'tool.py', runner: 'python' },
    { language: 'shellscript', path: 'deploy.sh', runner: 'bash' },
    { language: 'typescript', path: 'main.ts', runner: 'npx tsx' },
    { language: 'go', path: 'main.go', runner: 'go run' },
    { language: 'ruby', path: 'task.rb', runner: 'ruby' },
    { language: 'php', path: 'index.php', runner: 'php' },
  ];
  for (const c of cases) {
    const h = harness({ hostOverrides: { language: c.language, path: c.path } });
    await h.engine.runActiveFile();
    assert.equal(h.runTask.lastCommand, `${c.runner} '${c.path}'`, `${c.language} -> ${c.runner}`);
  }
});

test('falls back to the extension when the language id is generic', async () => {
  const cases = [
    { path: 'scripts/tool.mjs', runner: 'node' },
    { path: 'scripts/tool.cjs', runner: 'node' },
    { path: 'types.ts', runner: 'npx tsx' },
    { path: 'run.py', runner: 'python' },
    { path: 'build.sh', runner: 'bash' },
  ];
  for (const c of cases) {
    const h = harness({ hostOverrides: { language: 'plaintext', path: c.path } });
    await h.engine.runActiveFile();
    assert.equal(h.runTask.lastCommand, `${c.runner} '${c.path}'`);
  }
});

test('unsupported file kinds toast instead of running', async () => {
  const h = harness({ hostOverrides: { language: 'markdown', path: 'README.md' } });
  await h.engine.runActiveFile();
  assert.equal(h.runTask.calls.start, 0, 'no task started');
  assert.match(h.toasts.join(' | '), /\.md.*isn't supported/i);
});

test('does not run diff / preview tabs', async () => {
  const h = harness({
    hostOverrides: { path: 'diff://snapshot/src/app.js', language: 'javascript' },
    isDiffTabId: (p) => String(p).startsWith('diff://'),
  });
  await h.engine.runActiveFile();
  assert.equal(h.runTask.calls.start, 0);
  assert.match(h.toasts.join(' | '), /diff or preview/i);
});

test('single-quotes the path so a crafted file name cannot inject shell commands', async () => {
  const h = harness({ hostOverrides: { path: 'src/$(calc).js', language: 'javascript' } });
  await h.engine.runActiveFile();
  assert.equal(h.runTask.lastCommand, "node 'src/$(calc).js'", 'metachars stay inside single quotes');
});

/* ---- run npm script ------------------------------------------------------ */

test('runScript runs `npm run <name>` with the name single-quoted', async () => {
  const h = harness();
  await h.engine.runScript('build:prod');
  assert.equal(h.runTask.lastCommand, "npm run 'build:prod'");
  assert.equal(h.engine.isRunning(), true);
});

test('runScript quotes a name containing a single quote (PowerShell-doubled) on win32', async () => {
  const h = harness({ platform: 'win32' });
  await h.engine.runScript("we're:fine");
  assert.equal(h.runTask.lastCommand, "npm run 'we''re:fine'");
});

test('runScript quotes a name containing a single quote POSIX-style (close+escaped-quote+reopen) off win32', async () => {
  // main spawns `bash -c` on non-win32 platforms (workspace-run-task-runner.js
  // shellFor); PowerShell-style '' doubling silently concatenates under sh
  // ('a''b' -> ab), dropping the quote instead of preserving it. sh parses
  // 'foo'\''bar' back to the single token foo'bar.
  const h = harness({ platform: 'linux' });
  await h.engine.runScript("foo'bar");
  assert.equal(h.runTask.lastCommand, "npm run 'foo'\\''bar'");
});

/* ---- package.json detection + degrade paths ------------------------------ */

test('detectScripts parses the scripts map from package.json', async () => {
  const pkg = JSON.stringify({ scripts: { build: 'tsc', test: 'node --test', empty: 5 } });
  const h = harness({ fsOverrides: { content: pkg } });
  const result = await h.engine.detectScripts();
  assert.equal(result.error, '');
  assert.deepEqual(result.scripts, [
    { name: 'build', command: 'tsc' },
    { name: 'test', command: 'node --test' },
  ]);
  assert.equal(h.fs.calls.readFile[0].path, 'package.json');
});

test('detectScripts degrades when there is no package.json', async () => {
  const h = harness({ fsOverrides: { readThrows: true } });
  const result = await h.engine.detectScripts();
  assert.deepEqual(result, { scripts: [], error: 'not-found' });
});

test('detectScripts degrades on malformed JSON', async () => {
  const h = harness({ fsOverrides: { content: '{ "scripts": { "build": ' } });
  const result = await h.engine.detectScripts();
  assert.deepEqual(result, { scripts: [], error: 'parse' });
});

test('detectScripts reports an empty scripts map', async () => {
  const h = harness({ fsOverrides: { content: JSON.stringify({ name: 'x' }) } });
  const result = await h.engine.detectScripts();
  assert.deepEqual(result, { scripts: [], error: 'empty' });
});

test('detectScripts degrades when the fs bridge is unavailable', async () => {
  const h = harness({ noFs: true });
  const result = await h.engine.detectScripts();
  assert.deepEqual(result, { scripts: [], error: 'unavailable' });
});

test('pickAndRunScript toasts the right message when there is nothing to run', async () => {
  const h = harness({ fsOverrides: { readThrows: true } });
  await h.engine.pickAndRunScript();
  assert.match(h.toasts.join(' | '), /no package\.json/i);
  assert.equal(h.runTask.calls.start, 0, 'nothing dispatched');
});

/* ---- running state, task identity, kill ----------------------------------- */

test('reports a missing run-task bridge without throwing', async () => {
  const h = harness({ noRunTask: true });
  await assert.doesNotReject(() => h.engine.runActiveFile());
  assert.match(h.toasts.join(' | '), /terminal is unavailable/i);
});

test('guards against a second run while one is in flight', async () => {
  const h = harness();
  await h.engine.runActiveFile();
  await h.engine.runScript('build');
  assert.equal(h.runTask.calls.start, 1, 'only one task started');
  assert.match(h.toasts.join(' | '), /already running/i);
});

test('UIUX-014 (A): a script printing marker-SHAPED stdout text is only ever displayed, never treated as completion', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const h = harness({ getDom: () => ({ ideBottomPanelContent: host }), isActivePanel: () => true });
  h.engine.bindEvents();
  await h.engine.runActiveFile();
  const taskId = h.runTask.lastTaskId || 'run-1';
  // A pathological/adversarial script prints text shaped exactly like the OLD
  // completion marker format, then keeps running (no exit event follows).
  h.runTask.emitData('__JENNY_RUN_DONE_1__ 0\nstill working...\n', 'run-1');
  await flush();
  let pre = host.querySelector('[data-ide-run-scrollback]');
  assert.match(pre.textContent, /__JENNY_RUN_DONE_1__ 0/, 'the text is displayed literally, like any other output');
  assert.equal(h.engine.isRunning(), true, 'marker-shaped stdout text never settles a run');
  // Stop still works: it targets the taskId, unaffected by output content.
  h.engine.kill();
  assert.equal(h.runTask.calls.kill.length, 1);
  assert.equal(h.runTask.calls.kill[0].taskId, taskId);
  assert.equal(h.engine.isRunning(), false);
});

/* ---- UIUX-014 pre-ready buffer (events racing the start() reply) ---------- */
// Main wires the child's output forwarding synchronously inside start(), before
// its IPC reply is sent, so onData/onExit can cross the bridge BEFORE the
// renderer learns its own taskId. Mirrors the W1-D PTY fix (3a5c524e):
// subscribe-before-start is already in place; these gate the bounded buffer.

test('UIUX-014 pre-ready: output arriving before the start() reply still paints after taskId assignment', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const runTask = fakeRunTask();
  runTask.start = async function start(payload) {
    this.calls.start += 1;
    this.lastCommand = payload?.command;
    // Emits BEFORE resolving: the renderer does not yet know its taskId.
    this.emitData('immediate output\n', 'run-1');
    this.emitData('for another task\n', 'run-999'); // must NOT paint (exact-match still governs replay)
    return { ok: true, taskId: 'run-1', cwd: 'C:/ws' };
  };
  const h = harness({ runTask, getDom: () => ({ ideBottomPanelContent: host }), isActivePanel: () => true });
  h.engine.bindEvents();
  await h.engine.runActiveFile();
  await flush();
  const pre = host.querySelector('[data-ide-run-scrollback]');
  assert.match(pre.textContent, /immediate output/, 'pre-reply output is buffered and replayed, never dropped');
  assert.ok(!pre.textContent.includes('for another task'), 'a buffered event for a DIFFERENT taskId is dropped on replay');
  assert.equal(h.engine.isRunning(), true, 'the run is still live after replaying data');
});

test('UIUX-014 pre-ready: an exit arriving before the start() reply settles the run - never stuck "running"', async () => {
  const runTask = fakeRunTask();
  runTask.start = async function start(payload) {
    this.calls.start += 1;
    this.lastCommand = payload?.command;
    // An instantly-exiting command: the exit event beats the IPC reply.
    this.emitData('hi\n', 'run-1');
    this.emitExit('run-1', { code: 0 });
    return { ok: true, taskId: 'run-1', cwd: 'C:/ws' };
  };
  const h = harness({ runTask });
  h.engine.bindEvents();
  await h.engine.runActiveFile();
  await flush();
  assert.equal(h.engine.isRunning(), false, 'a buffered exit for the assigned taskId settles the run on replay');
});

test('UIUX-014 pre-ready: the buffer is bounded (drop-oldest) and logs a WARN counter', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const warns = [];
  const runTask = fakeRunTask();
  runTask.start = async function start(payload) {
    this.calls.start += 1;
    this.lastCommand = payload?.command;
    for (let i = 0; i < 70; i += 1) {
      this.emitData(`line-${i}\n`, 'run-1'); // 70 > the 64-event cap
    }
    return { ok: true, taskId: 'run-1', cwd: 'C:/ws' };
  };
  const engine = createIdeRunScripts({
    getDom: () => ({ ideBottomPanelContent: host }),
    isActivePanel: () => true,
    editorHost: fakeEditorHost(),
    getWorkspaceRunTaskApi: () => runTask,
    appendClientLog: (level, event, details) => { if (level === 'WARN') warns.push({ event, details }); },
  });
  engine.bindEvents();
  await engine.runActiveFile();
  await flush();
  const pre = host.querySelector('[data-ide-run-scrollback]');
  assert.ok(!pre.textContent.includes('line-0\n'), 'the oldest overflow entries were dropped');
  assert.match(pre.textContent, /line-69/, 'the newest entries survived');
  const dropWarns = warns.filter((w) => /preready/i.test(w.event));
  assert.ok(dropWarns.length > 0, 'a WARN with a dropped counter was logged');
  const last = dropWarns[dropWarns.length - 1];
  assert.ok(last.details.droppedEvents >= 6, `the cumulative dropped counter reflects the overflow (got ${last.details.droppedEvents})`);
});

test('UIUX-014 pre-ready: a timed-out dispatch discards its buffer (no stale replay into a later run)', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const runTask = fakeRunTask();
  let resolveLate;
  let firstCall = true;
  runTask.start = async function start(payload) {
    this.calls.start += 1;
    this.lastCommand = payload?.command;
    if (firstCall) {
      firstCall = false;
      this.emitData('stale output from the hung dispatch\n', 'run-hung');
      return new Promise((resolve) => { resolveLate = resolve; });
    }
    return { ok: true, taskId: 'run-2', cwd: 'C:/ws' };
  };
  const h = harness({ runTask, runStartTimeoutMs: 10, getDom: () => ({ ideBottomPanelContent: host }), isActivePanel: () => true });
  h.engine.bindEvents();
  const pending = h.engine.runActiveFile();
  await flush(30); // start-timeout fires; the hung dispatch's buffer must be discarded
  await h.engine.runActiveFile(); // a fresh run (run-2) is now active
  resolveLate({ ok: true, taskId: 'run-hung', cwd: 'C:/ws' }); // late reply for the dead dispatch
  await pending;
  await flush();
  const pre = host.querySelector('[data-ide-run-scrollback]');
  assert.ok(!pre.textContent.includes('stale output from the hung dispatch'), 'the dead dispatch\'s buffered output never paints into the new run');
  assert.equal(h.engine.isRunning(), true, 'the fresh run is unaffected');
});

test('a real onExit event (matching the active taskId) settles the run and surfaces the exit code', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const h = harness({ getDom: () => ({ ideBottomPanelContent: host }), isActivePanel: () => true });
  h.engine.bindEvents();
  await h.engine.runActiveFile();
  assert.equal(host.querySelector('[data-ide-run-action="kill"]').disabled, false);
  h.runTask.emitData('compiling…\n', 'run-1');
  await flush();
  let pre = host.querySelector('[data-ide-run-scrollback]');
  assert.match(pre.textContent, /compiling…/);
  assert.equal(h.engine.isRunning(), true, 'still running before the real exit');
  h.runTask.emitExit('run-1', { code: 2 });
  await flush();
  assert.equal(h.engine.isRunning(), false, 'running cleared by the REAL exit event');
  assert.equal(host.querySelector('[data-ide-run-action="kill"]').disabled, true);
  pre = host.querySelector('[data-ide-run-scrollback]');
  assert.match(pre.textContent, /exited with code 2/);
});

test('a late/stale event for a superseded taskId never paints into the current task\'s UI', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const h = harness({ getDom: () => ({ ideBottomPanelContent: host }), isActivePanel: () => true });
  h.engine.bindEvents();
  await h.engine.runActiveFile(); // taskId run-1
  h.engine.kill(); // run-1 killed; engine is idle again
  await h.engine.runActiveFile(); // taskId run-2 now active
  h.runTask.emitData('output for the OLD task\n', 'run-1');
  await flush();
  const pre = host.querySelector('[data-ide-run-scrollback]');
  assert.ok(!pre.textContent.includes('output for the OLD task'), 'stale task-id event is dropped, not painted');
  h.runTask.emitExit('run-1', { code: 0 });
  assert.equal(h.engine.isRunning(), true, 'a stale exit for a superseded task must not clear the CURRENT run');
});

test('idle output (no active run) never pollutes the run tab', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const h = harness({ getDom: () => ({ ideBottomPanelContent: host }), isActivePanel: () => true });
  h.engine.bindEvents();
  h.engine.renderRunPanel();
  assert.equal(host.querySelector('[data-ide-run-action="kill"]').disabled, true);
  h.runTask.emitData('nothing running\n', 'run-1'); // no run in flight
  await flush();
  const pre = host.querySelector('[data-ide-run-scrollback]');
  assert.equal(pre.textContent, '', 'no capture without an active run');
});

test('one-click kill targets the active taskId and clears the running state', async () => {
  const h = harness();
  await h.engine.runActiveFile();
  assert.equal(h.engine.isRunning(), true);
  h.engine.kill();
  assert.equal(h.runTask.calls.kill.length, 1, 'killed the running task');
  assert.equal(h.runTask.calls.kill[0].taskId, 'run-1');
  assert.equal(h.engine.isRunning(), false, 'kill clears the running state');
});

test('a task-exit event clears an in-flight run', async () => {
  const h = harness();
  await h.engine.runActiveFile();
  assert.equal(h.engine.isRunning(), true);
  h.runTask.emitExit('run-1');
  assert.equal(h.engine.isRunning(), false, 'exit settles the run');
});

test('a launch error clears the running state and toasts', async () => {
  const h = harness({ runTask: fakeRunTask({ startThrows: true }) });
  await h.engine.runActiveFile();
  await flush();
  assert.equal(h.engine.isRunning(), false, 'not stuck running after a start failure');
  assert.match(h.toasts.join(' | '), /could not start the task/i);
});

test('a structured start failure (e.g. ROOT_MISSING) clears running and surfaces the message', async () => {
  const h = harness({ runTask: fakeRunTask({ startFails: true, failMessage: 'No workspace root is configured; choose a workspace folder first.' }) });
  await h.engine.runActiveFile();
  await flush();
  assert.equal(h.engine.isRunning(), false);
  assert.match(h.toasts.join(' | '), /no workspace root/i);
});

test('UIUX-014 (B): a hung start times out, resets the phantom running state, and recovers', async () => {
  const runTask = fakeRunTask();
  let hang = true;
  runTask.start = async function start(payload) {
    this.calls.start += 1;
    this.lastCommand = payload?.command;
    if (hang) {
      return new Promise(() => {}); // bridge teardown: never settles
    }
    return { ok: true, taskId: 'run-2', cwd: 'C:/ws' };
  };
  const h = harness({ runTask, runStartTimeoutMs: 10 });
  const first = h.engine.runActiveFile();
  assert.equal(h.engine.isRunning(), true, 'running while start is in flight');
  await flush(40); // let the start timeout fire
  assert.equal(h.engine.isRunning(), false, 'timeout reset the phantom running state');
  assert.match(h.toasts.join(' | '), /did not start in time/i);
  // Recovery: a fresh run on a now-responsive bridge starts a new task.
  hang = false;
  await h.engine.runActiveFile();
  assert.equal(h.engine.isRunning(), true, 'engine recovered and started a new run');
  assert.equal(runTask.calls.start, 2, 'a second start attempt fired');
  void first; // the original hung promise never settles; nothing awaits it
});

test('UIUX-014 (B): a start() that resolves AFTER the timeout kills the orphaned task main already spawned', async () => {
  const runTask = fakeRunTask();
  let resolveLate;
  runTask.start = async function start(payload) {
    this.calls.start += 1;
    this.lastCommand = payload?.command;
    return new Promise((resolve) => { resolveLate = resolve; });
  };
  const h = harness({ runTask, runStartTimeoutMs: 10 });
  const pending = h.engine.runActiveFile();
  await flush(30); // the start timeout fires; renderer gives up locally
  assert.equal(h.engine.isRunning(), false);
  assert.equal(runTask.calls.kill.length, 0, 'nothing to kill yet - main has not responded');
  // Main's start() now (late) resolves successfully: a REAL task exists.
  resolveLate({ ok: true, taskId: 'run-late', cwd: 'C:/ws' });
  await pending;
  await flush();
  assert.equal(runTask.calls.kill.length, 1, 'the orphaned late task is killed, never silently abandoned');
  assert.equal(runTask.calls.kill[0].taskId, 'run-late');
  assert.equal(h.engine.isRunning(), false, 'the local UI never resurrects for the late task');
});

test('dispose clears a pending start timeout (no post-teardown callback)', async () => {
  const runTask = fakeRunTask();
  runTask.start = async function start() {
    this.calls.start += 1;
    return new Promise(() => {}); // hangs: the start timer stays armed
  };
  const h = harness({ runTask, runStartTimeoutMs: 10 });
  const pending = h.engine.runActiveFile();
  assert.equal(h.calls.runStateChange, 1, 'one state change on dispatch');
  h.engine.dispose();
  await flush(40); // well past the 10ms timeout window
  assert.equal(h.calls.runStateChange, 1, 'the timeout never fired after dispose');
  assert.ok(
    !h.toasts.join(' | ').includes('did not start in time'),
    'no post-dispose timeout toast'
  );
  void pending; // the hung start promise never settles; nothing awaits it
});

test('dispose before start() resolves kills the late-arriving task and never resurrects local state', async () => {
  const runTask = fakeRunTask();
  let resolveStart;
  runTask.start = async function start(payload) {
    this.calls.start += 1;
    this.lastCommand = payload?.command;
    return new Promise((resolve) => { resolveStart = resolve; });
  };
  const h = harness({ runTask, runStartTimeoutMs: 1000 });
  const pending = h.engine.runActiveFile();
  assert.equal(h.engine.isRunning(), true, 'running while start is pending');

  h.engine.dispose();
  resolveStart({ ok: true, taskId: 'run-late', cwd: 'C:/ws' });
  await pending;
  await flush();

  assert.equal(runTask.calls.kill.length, 1, 'the disposed controller kills the late-arriving task');
  assert.equal(runTask.calls.kill[0].taskId, 'run-late');
  assert.equal(h.engine.isRunning(), false, 'dispose clears the visible running state');
});

test('a start that returns ok:false resets running and never records a task id', async () => {
  const h = harness({ runTaskOverrides: { startFails: true, failCode: 'CMP-RUNTASK-0030', failMessage: 'Could not start the task.' } });
  await h.engine.runActiveFile();
  await flush();
  assert.equal(h.engine.isRunning(), false, 'no phantom running with a failed start');
  assert.match(h.toasts.join(' | '), /could not start the task/i);
});

test('dispose unsubscribes the run-task listeners', async () => {
  const h = harness();
  h.engine.bindEvents();
  assert.equal(h.runTask.data.length, 1, 'subscribed to onData');
  assert.equal(h.runTask.exit.length, 1, 'subscribed to onExit');
  h.engine.dispose();
  assert.equal(h.runTask.data.length, 0, 'onData listener removed');
  assert.equal(h.runTask.exit.length, 0, 'onExit listener removed');
});

/* ---- default bridge lookup (no controller wiring needed) ------------------ */

test('with no getWorkspaceRunTaskApi injected, falls back to window.jennyShell.workspaceRunTask', async () => {
  const dom = new JSDOM('<!doctype html><body></body></html>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  try {
    const runTask = fakeRunTask();
    dom.window.jennyShell = { workspaceRunTask: runTask };
    const engine = createIdeRunScripts({ editorHost: fakeEditorHost() });
    await engine.runActiveFile();
    assert.equal(runTask.calls.start, 1, 'resolved the real bridge namespace without explicit injection');
  } finally {
    globalThis.window = prevWindow;
  }
});

/* ---- UIUX-035 follow-up: ANSI stripping + output backpressure ------------- */
// The run panel carried its own copy-pasted stateless ANSI_PATTERN regex (the
// exact defect class fixed in renderer-ide-terminal-panel by the shared
// incremental stripper) AND re-ran that regex over the FULL accumulated buffer
// plus a full pre.textContent DOM rewrite on EVERY incoming chunk (no frame
// coalescing at all — the audit's "repeatedly rewrites full scrollback").

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function panelHarness(opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const h = harness({
    getDom: () => ({ ideBottomPanelContent: host }),
    isActivePanel: () => true,
    ...opts,
  });
  h.engine.bindEvents();
  return { ...h, host };
}

test('UIUX-035 (run scripts): a BEL-terminated OSC does not swallow the real output that follows it', async () => {
  const h = panelHarness();
  await h.engine.runActiveFile();
  // One chunk: an OSC title sequence terminated by BEL, then real output with
  // NO later ESC byte. A stateless `ESC][^ESC]*` pattern greedily swallows
  // everything after `ESC]` up to the next ESC — i.e. the real output too.
  h.runTask.emitData(`${ESC}]0;my window title${BEL}REAL OUTPUT\n`, 'run-1');
  await flush();
  const pre = h.host.querySelector('[data-ide-run-scrollback]');
  assert.match(pre.textContent, /REAL OUTPUT/, 'output after the BEL terminator is displayed');
  assert.ok(!pre.textContent.includes('my window title'), 'the OSC payload itself is stripped');
  assert.ok(!pre.textContent.includes(BEL), 'no raw BEL byte leaks into the transcript');
});

test('UIUX-035 (run scripts): a CSI sequence split across two chunks strips cleanly (restructure regression guard)', async () => {
  // Green at HEAD (the old code re-scanned the full buffer every render, which
  // healed splits); pins that the incremental per-chunk stripper keeps state
  // across chunk boundaries after the restructure.
  const h = panelHarness();
  await h.engine.runActiveFile();
  h.runTask.emitData(`before ${ESC}[`, 'run-1');
  h.runTask.emitData('32mAFTER\n', 'run-1');
  await flush();
  const pre = h.host.querySelector('[data-ide-run-scrollback]');
  assert.match(pre.textContent, /before AFTER/, 'the split CSI is removed, both text halves survive');
  assert.ok(!pre.textContent.includes('32m'), 'no CSI parameter bytes leak as literal text');
  assert.ok(!pre.textContent.includes(ESC), 'no raw ESC byte leaks into the transcript');
});

test('UIUX-035 (run scripts): a burst of chunks coalesces into ONE painted frame, never a full DOM rewrite per chunk', async () => {
  const frames = [];
  const canceled = new Set();
  const h = panelHarness({
    requestAnimationFrameImpl: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrameImpl: (handle) => { canceled.add(handle); },
  });
  await h.engine.runActiveFile();
  const pre = h.host.querySelector('[data-ide-run-scrollback]');
  // Instrument the full-rewrite path: the defect wrote pre.textContent once
  // per incoming chunk (a full re-render of the whole buffer every time).
  const descriptor = Object.getOwnPropertyDescriptor(
    pre.ownerDocument.defaultView.Node.prototype, 'textContent'
  );
  let textContentWrites = 0;
  Object.defineProperty(pre, 'textContent', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) { textContentWrites += 1; descriptor.set.call(this, value); },
  });
  const scheduledBefore = frames.length;
  for (let i = 0; i < 50; i += 1) {
    h.runTask.emitData(`chunk-${i}\n`, 'run-1');
  }
  assert.equal(textContentWrites, 0, 'no full pre.textContent rewrite per chunk');
  assert.equal(frames.length - scheduledBefore, 1, 'the 50-chunk burst scheduled exactly one paint frame');
  assert.ok(!pre.textContent.includes('chunk-49'), 'painting is deferred to the coalesced frame');
  for (let i = scheduledBefore; i < frames.length; i += 1) {
    if (!canceled.has(i + 1)) frames[i](0);
  }
  assert.match(pre.textContent, /chunk-0\n[\s\S]*chunk-49\n/, 'one frame paints the whole burst in order');
  assert.equal(textContentWrites, 0, 'the coalesced paint appends text nodes, never a full rewrite');
});

test('UIUX-035 (run scripts): output past the cap drops oldest with a VISIBLE dropped counter, never silently', async () => {
  const h = panelHarness();
  await h.engine.runActiveFile();
  h.runTask.emitData('FIRST-MARKER\n', 'run-1');
  const filler = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 5; i += 1) {
    h.runTask.emitData(filler, 'run-1'); // 320KB > the 256KB MAX_OUTPUT_CHARS cap
  }
  h.runTask.emitData('\nLAST-MARKER\n', 'run-1');
  await flush();
  const pre = h.host.querySelector('[data-ide-run-scrollback]');
  assert.ok(!pre.textContent.includes('FIRST-MARKER'), 'the oldest output was dropped');
  assert.match(pre.textContent, /LAST-MARKER/, 'the newest output survived');
  const dropped = Number(pre.dataset.runDroppedChars);
  assert.ok(Number.isFinite(dropped) && dropped > 0,
    `the drop is visible on the panel, never silent (dataset.runDroppedChars=${pre.dataset.runDroppedChars})`);
});

test('UIUX-035 (run scripts): kill + a fresh run resets the parser (a dangling unterminated OSC never swallows the next run)', async () => {
  const h = panelHarness();
  await h.engine.runActiveFile(); // run-1
  h.runTask.emitData(`${ESC}]0;dangling never-terminated osc`, 'run-1'); // mid-OSC, no BEL/ST
  h.engine.kill();
  await h.engine.runActiveFile(); // run-2
  h.runTask.emitData('fresh output\n', 'run-2');
  await flush();
  const pre = h.host.querySelector('[data-ide-run-scrollback]');
  assert.match(pre.textContent, /fresh output/, 'the new run paints — no inherited mid-escape state');
  assert.ok(!pre.textContent.includes('dangling'), 'the old run\'s OSC payload never leaks');
});

test('a backgrounded run panel does not accumulate pendingChunks unboundedly - reactivation repaints from bounded outputChunks, never a raw backlog dump', async () => {
  // Regression: appendCleanText always pushed to pendingChunks, but
  // paintScrollback's `if (!pre) return;` (inactive panel) returned BEFORE
  // the pendingChunks/pendingEvictedChars reset. A chatty backgrounded task
  // would accumulate EVERY chunk forever (including ones already evicted
  // from the bounded outputChunks) with no reset, and paintedPre still
  // matched the live element on return, so the delta-append branch (not the
  // bounded full-repaint branch) fired and appendChild'd the ENTIRE unbounded
  // backlog as one text node — trimDomHead trims the *visible* result back
  // down after the fact, so the final text can coincidentally look bounded,
  // but the transient allocation itself is proportional to how long the task
  // ran backgrounded, not to the cap. That allocation is the actual defect:
  // assert on what gets appendChild'd, not just the post-trim result.
  let active = true;
  const h = panelHarness({ isActivePanel: () => active });
  await h.engine.runActiveFile();
  h.runTask.emitData('FIRST-MARKER\n', 'run-1');
  active = false; // background the panel: getScrollbackEl() -> null
  const filler = 'x'.repeat(100 * 1024);
  for (let i = 0; i < 6; i += 1) {
    h.runTask.emitData(filler, 'run-1'); // 600KB while backgrounded, far past the 256KB cap
  }
  h.runTask.emitData('LAST-MARKER\n', 'run-1');
  active = true; // user returns to the run view
  const pre = h.host.querySelector('[data-ide-run-scrollback]');
  const origAppendChild = pre.appendChild.bind(pre);
  let maxAppendedLength = 0;
  pre.appendChild = (node) => {
    const length = String(node?.data ?? node?.nodeValue ?? '').length;
    if (length > maxAppendedLength) maxAppendedLength = length;
    return origAppendChild(node);
  };
  h.engine.renderRunPanel();
  assert.ok(maxAppendedLength <= 256 * 1024,
    `reactivation must append at most the bounded outputChunks content in one shot, never the unbounded backgrounded backlog (appended ${maxAppendedLength} chars)`);
  assert.match(pre.textContent, /LAST-MARKER/, 'the newest output survived the bounded repaint');
  assert.ok(!pre.textContent.includes('FIRST-MARKER'), 'evicted-from-bound output never resurfaces from a stale pendingChunks backlog');
  const dropped = Number(pre.dataset.runDroppedChars);
  assert.ok(Number.isFinite(dropped) && dropped > 0, 'the drop is visible on the panel, never silent');
});

/* ---- run-tab rendering --------------------------------------------------- */

test('openScriptPicker renders a filterable list that runs the selected script', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  try {
    const stage = dom.window.document.getElementById('stage');
    const h = harness({ getDom: () => ({ ideEditorStage: stage }) });
    h.engine.openScriptPicker([
      { name: 'build', command: 'tsc' },
      { name: 'lint', command: 'eslint .' },
    ]);
    const rows = [...stage.querySelectorAll('[data-ide-run-script]')];
    assert.deepEqual(rows.map((r) => r.dataset.ideRunScript), ['build', 'lint']);
    rows[1].click();
    await flush();
    assert.equal(h.runTask.lastCommand, "npm run 'lint'");
  } finally {
    globalThis.window = prevWindow;
  }
});


/* ---- S-BUG5: an unconfirmed kill is its own terminal state ---------------- */

function runPanelStatus(host) {
  return host.querySelector('[data-ide-run-status]');
}

test('an unconfirmed kill is surfaced on the run row, not settled as a clean stop', async () => {
  const h = panelHarness({
    runTask: fakeRunTask({ killImpl: () => ({ killed: false, terminationConfirmed: false }) }),
  });
  await h.engine.runActiveFile();
  h.engine.kill();
  await flush();

  const status = runPanelStatus(h.host);
  assert.equal(status.textContent, 'stop unconfirmed');
  assert.equal(status.classList.contains('ide-terminal-status--warn'), true);
  assert.equal(status.classList.contains('ide-terminal-status--running'), false);
  assert.match(
    h.host.querySelector('[data-ide-run-scrollback]').textContent,
    /stop unconfirmed .* the process tree may still be running/
  );
});

test('a CONFIRMED kill stays plain idle and never raises the warning', async () => {
  const h = panelHarness();
  await h.engine.runActiveFile();
  h.engine.kill();
  await flush();

  const status = runPanelStatus(h.host);
  assert.equal(status.textContent, 'idle', 'a confirmed kill is an ordinary stop');
  assert.equal(status.classList.contains('ide-terminal-status--warn'), false);
  assert.doesNotMatch(h.host.querySelector('[data-ide-run-scrollback]').textContent, /stop unconfirmed/);
});

test('a kill request that REJECTS is unconfirmed too', async () => {
  const h = panelHarness({ runTask: fakeRunTask({ killThrows: true }) });
  await h.engine.runActiveFile();
  h.engine.kill();
  await flush();

  assert.equal(runPanelStatus(h.host).textContent, 'stop unconfirmed');
});

test('starting a new run clears a previous unconfirmed stop', async () => {
  const h = panelHarness({
    runTask: fakeRunTask({ killImpl: () => ({ killed: false, terminationConfirmed: false }) }),
  });
  await h.engine.runActiveFile();
  h.engine.kill();
  await flush();
  assert.equal(runPanelStatus(h.host).textContent, 'stop unconfirmed');

  await h.engine.runActiveFile();
  const status = runPanelStatus(h.host);
  assert.equal(status.textContent, 'running', 'the new run owns the row');
  assert.equal(status.classList.contains('ide-terminal-status--warn'), false);
});

test('Clear output does NOT dismiss an unconfirmed stop', async () => {
  // Deliberate: clearing the console must not erase a warning that a child
  // process may still be alive. Only a new run supersedes it.
  const h = panelHarness({
    runTask: fakeRunTask({ killImpl: () => ({ killed: false, terminationConfirmed: false }) }),
  });
  await h.engine.runActiveFile();
  h.engine.kill();
  await flush();

  h.host.querySelector('[data-ide-run-action="clear"]').click();
  await flush();

  assert.equal(runPanelStatus(h.host).textContent, 'stop unconfirmed');
});

test('a stale kill answer cannot stamp its warning onto a later, cleanly-exited run', async () => {
  // The newer run must be IDLE when the stale answer lands, otherwise `running`
  // masks the bug and this test proves nothing: syncStatus already suppresses
  // the warning while a run is live. run-2 therefore exits cleanly first, so
  // the row is showing plain 'idle' at the moment run-1's answer arrives.
  let resolveKill;
  const h = panelHarness({
    runTask: fakeRunTask({
      killImpl: () => new Promise((resolve) => { resolveKill = resolve; }),
    }),
  });
  await h.engine.runActiveFile();   // run-1
  h.engine.kill();                  // its kill answer is still in flight
  await h.engine.runActiveFile();   // run-2 now owns the row
  h.runTask.emitExit('run-2', { code: 0 });
  await flush();
  assert.equal(runPanelStatus(h.host).textContent, 'idle', 'run-2 exited cleanly');

  resolveKill({ killed: false, terminationConfirmed: false }); // late answer for run-1
  await flush();

  const status = runPanelStatus(h.host);
  assert.equal(status.textContent, 'idle', 'a superseded run cannot repaint the row of a later run');
  assert.equal(status.classList.contains('ide-terminal-status--warn'), false);
});
