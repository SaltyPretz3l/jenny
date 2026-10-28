'use strict';

/* Run scripts (renderer-ide-run-scripts): kill-outcome races. A Stop racing a
 * natural exit, the late-start orphan kill (fenced to the run that still owns
 * the row), and the workspace-root reset. Split from
 * renderer-ide-run-scripts.test.js at its file-size ceiling; same fake
 * workspaceRunTask bridge shape (taskId-stamped events, invoke-shaped kill). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeRunScripts } = require('../renderer/features/renderer-ide-run-scripts');

function flush(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeRunTask(overrides = {}) {
  const data = [];
  const exit = [];
  let counter = 0;
  return {
    calls: { start: 0, kill: [] },
    onData(fn) { data.push(fn); return () => { const i = data.indexOf(fn); if (i >= 0) data.splice(i, 1); }; },
    onExit(fn) { exit.push(fn); return () => { const i = exit.indexOf(fn); if (i >= 0) exit.splice(i, 1); }; },
    async start() {
      this.calls.start += 1;
      counter += 1;
      return { ok: true, taskId: `run-${counter}`, cwd: 'C:/ws' };
    },
    async kill(payload) {
      this.calls.kill.push(payload);
      return overrides.killImpl ? overrides.killImpl(payload) : { killed: true, terminationConfirmed: true };
    },
    emitData(chunk, taskId, stream = 'stdout') { for (const fn of data.slice()) fn({ taskId, stream, chunk }); },
    emitExit(taskId, extra = {}) { for (const fn of exit.slice()) fn({ taskId, code: 0, status: 'exited', ...extra }); },
  };
}

function panelHarness(opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const runTask = opts.runTask || fakeRunTask();
  const engine = createIdeRunScripts({
    getDom: () => ({}),
    getMountEl: () => host,
    isActivePanel: () => true,
    editorHost: {
      addEditorAction() { return { dispose() {} }; },
      getActivePath: () => 'src/app.js',
      getActiveLanguageId: () => 'javascript',
      focus() {},
      isDirty: () => false,
    },
    getWorkspaceFsApi: () => ({ async readFile() { return { content: '' }; } }),
    getWorkspaceRunTaskApi: () => runTask,
    isDiffTabId: () => false,
    saveFile: async () => true,
    openRunPanel: () => {},
    onRunStateChange: () => {},
    appendClientLog: () => {},
    showToastMessage: () => {},
    runStartTimeoutMs: opts.runStartTimeoutMs,
  });
  engine.bindEvents();
  return { engine, runTask, host };
}

function runPanelStatus(host) {
  return host.querySelector('[data-ide-run-status]');
}

test('Stop racing a natural exit ({ killed:false } with no confirmation field) is not "stop unconfirmed"', async () => {
  const h = panelHarness({ runTask: fakeRunTask({ killImpl: () => ({ killed: false }) }) });
  await h.engine.runActiveFile();
  h.engine.kill();
  await flush();
  const status = runPanelStatus(h.host);
  assert.equal(status.textContent, 'idle', 'the task was already gone');
  assert.equal(status.classList.contains('ide-terminal-status--warn'), false);
});

test('an unconfirmed kill of a late-started orphan surfaces on the row it still owns', async () => {
  const runTask = fakeRunTask({ killImpl: () => ({ killed: false, terminationConfirmed: false }) });
  let resolveLate;
  runTask.start = async function start() {
    this.calls.start += 1;
    return new Promise((resolve) => { resolveLate = resolve; });
  };
  const h = panelHarness({ runTask, runStartTimeoutMs: 10 });
  const pending = h.engine.runActiveFile();
  await flush(30);
  resolveLate({ ok: true, taskId: 'run-late' });
  await pending;
  await flush();
  assert.equal(runTask.calls.kill.length, 1);
  assert.equal(runPanelStatus(h.host).textContent, 'stop unconfirmed', 'the orphan may still be alive');
});

test('a late-start kill answer never stamps a newer run\'s row', async () => {
  const runTask = fakeRunTask({ killImpl: () => ({ killed: false, terminationConfirmed: false }) });
  let resolveLate;
  let starts = 0;
  runTask.start = async function start() {
    this.calls.start += 1;
    starts += 1;
    if (starts === 1) return new Promise((resolve) => { resolveLate = resolve; });
    return { ok: true, taskId: 'run-2' };
  };
  const h = panelHarness({ runTask, runStartTimeoutMs: 10 });
  const pending = h.engine.runActiveFile();
  await flush(30);
  await h.engine.runActiveFile(); // run-2 now owns the row
  runTask.emitExit('run-2', { code: 0 });
  resolveLate({ ok: true, taskId: 'run-late' });
  await pending;
  await flush();
  assert.equal(runPanelStatus(h.host).textContent, 'idle');
});

test('resetForRoot clears the old root\'s output, running state and unconfirmed warning', async () => {
  const h = panelHarness({ runTask: fakeRunTask({ killImpl: () => ({ killed: false, terminationConfirmed: false }) }) });
  await h.engine.runActiveFile();
  h.runTask.emitData('OLD ROOT OUTPUT\n', 'run-1');
  h.engine.kill();
  await flush();
  assert.equal(runPanelStatus(h.host).textContent, 'stop unconfirmed');
  await h.engine.runActiveFile(); // run-2 is live when the root switches
  h.runTask.emitData('RUN TWO\n', 'run-2');
  h.engine.resetForRoot();
  await flush();
  assert.equal(h.engine.isRunning(), false);
  assert.equal(runPanelStatus(h.host).textContent, 'idle');
  assert.equal(h.host.querySelector('[data-ide-run-scrollback]').textContent, '');
  h.runTask.emitData('LATE OLD-ROOT CHUNK\n', 'run-2');
  h.runTask.emitExit('run-2', { code: 0 });
  await flush();
  assert.equal(h.host.querySelector('[data-ide-run-scrollback]').textContent, '', 'old-root events stay inert');
});
