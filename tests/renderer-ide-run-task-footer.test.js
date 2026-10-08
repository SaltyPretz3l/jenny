'use strict';

/* Row 40 W4 (owner decision F5): the Run task footer. Unit-tests the footer
 * module (duration text, status line, Ask Jenny payload cap) and drives it through
 * the real run-scripts engine over a fake workspaceRunTask bridge: the footer only
 * appears for a finished run, completion comes from the real exit event, Run again
 * re-runs the same script, Ask Jenny only for a non-zero exit. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeRunScripts } = require('../renderer/features/renderer-ide-run-scripts');
const {
  createRunTaskFooter, formatDuration, buildAskJennyPayload, MAX_ASK_OUTPUT_CHARS,
} = require('../renderer/features/renderer-ide-run-task-footer');
const actionButton = require('../renderer/inventory/action-button');
const { buildSendToJennyText } = require('../renderer/features/renderer-ide-send-utils');

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRunTask() {
  const data = [];
  const exit = [];
  let counter = 0;
  return {
    data, exit, started: [], killed: [],
    onData(fn) { data.push(fn); return () => data.splice(data.indexOf(fn), 1); },
    onExit(fn) { exit.push(fn); return () => exit.splice(exit.indexOf(fn), 1); },
    async start(payload) { this.started.push(payload); counter += 1; return { ok: true, taskId: `run-${counter}` }; },
    async kill(payload) { this.killed.push(payload); return { killed: true, terminationConfirmed: true }; },
    emitData(chunk, taskId) { data.slice().forEach((fn) => fn({ taskId, stream: 'stdout', chunk })); },
    emitExit(taskId, extra = {}) { exit.slice().forEach((fn) => fn({ taskId, code: 0, status: 'exited', ...extra })); },
  };
}

function setup(opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const runTask = fakeRunTask();
  const asked = [];
  let clock = 1000;
  const engine = createIdeRunScripts({
    getMountEl: () => host,
    isActivePanel: () => true,
    editorHost: { getActivePath: () => 'src/app.js', getActiveLanguageId: () => 'javascript', isDirty: () => false, focus() {} },
    getWorkspaceRunTaskApi: () => runTask,
    getWorkspaceFsApi: () => ({ readFile: async () => ({ content: '{"scripts":{"build":"x"}}' }) }),
    onAskJenny: (payload) => asked.push(payload),
    now: () => clock,
    ...opts,
  });
  engine.bindEvents();
  const click = (selector) => {
    const el = host.querySelector(selector);
    el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  };
  return {
    engine, runTask, host, asked, click, advance: (ms) => { clock += ms; },
  };
}

const footerEl = (host) => host.querySelector('.ide-task-footer');
const statusText = (host) => footerEl(host)?.querySelector('.ide-task-footer-status')?.textContent || '';
const hasAction = (host, name) => Boolean(host.querySelector(`[data-ide-task-footer-action="${name}"]`));

test('formatDuration: compact human forms', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(850), '850ms');
  assert.equal(formatDuration(1200), '1.2s');
  assert.equal(formatDuration(42000), '42s');
  assert.equal(formatDuration(184000), '3m 4s');
  assert.equal(formatDuration(3900000), '1h 5m');
  assert.equal(formatDuration(-5), '0ms');
  assert.equal(formatDuration(NaN), '0ms');
});

test('buildAskJennyPayload: keeps the 8 KB tail and rides the send-to-Jenny code_selection shape', () => {
  const big = `HEAD${'x'.repeat(MAX_ASK_OUTPUT_CHARS)}TAIL`;
  const payload = buildAskJennyPayload('Run: npm run build', big);
  assert.equal(payload.title, 'Run: npm run build');
  assert.equal(payload.output.length, MAX_ASK_OUTPUT_CHARS);
  assert.ok(payload.output.endsWith('TAIL'), 'the tail is kept');
  assert.ok(!payload.output.includes('HEAD'), 'the head is dropped');
  assert.equal(payload.kind, 'code_selection');
  assert.equal(payload.code, payload.output);
  const text = buildSendToJennyText(payload);
  assert.match(text, /Run: npm run build/);
  assert.match(text, /TAIL/);
  assert.ok(buildSendToJennyText(buildAskJennyPayload('', '')), 'empty title/output still produce sendable text');
});

test('footer module: nothing before a finish, label/last run track begin and finish', () => {
  let t = 0;
  const footer = createRunTaskFooter({ now: () => t, actionButton, escapeHtml: String });
  assert.equal(footer.getRunLabel(), 'Run');
  assert.equal(footer.getLastRun(), null);
  footer.begin({ script: 'npm run build', command: "npm run 'build'" });
  assert.equal(footer.getRunLabel(), 'Run: npm run build');
  assert.equal(footer.getLastRun(), null, 'in flight: no finished run yet');
  t = 2500;
  footer.finish({ exitCode: 2 });
  assert.deepEqual(footer.getLastRun(), { script: 'npm run build', exitCode: 2, stopped: false, startFailed: false, durationMs: 2500 });
  footer.begin({ script: 'npm run lint', command: 'x' });
  assert.equal(footer.getLastRun(), null, 'a new run clears the old record');
});

test('run view: no footer while a run is in progress; the single Stop stays', async () => {
  const h = setup();
  await h.engine.runActiveFile();
  assert.equal(footerEl(h.host), null, 'nothing while running');
  assert.equal(h.host.querySelectorAll('[data-ide-run-action="kill"]').length, 1);
  assert.equal(h.engine.getLastRun(), null);
  assert.equal(h.engine.getRunLabel(), 'Run: node app.js');
});

test('run view: a clean exit shows "Exited with code 0 after ..." and Run again only', async () => {
  const h = setup();
  await h.engine.runActiveFile();
  h.advance(1200);
  h.runTask.emitExit('run-1', { code: 0 });
  assert.equal(statusText(h.host), 'Exited with code 0 after 1.2s');
  assert.ok(hasAction(h.host, 'rerun'));
  assert.ok(!hasAction(h.host, 'ask'), 'no Ask Jenny on success');
  assert.deepEqual(h.engine.getLastRun(), { script: 'node app.js', exitCode: 0, stopped: false, startFailed: false, durationMs: 1200 });
});

test('run view: a non-zero exit offers Ask Jenny with the run output tail', async () => {
  const h = setup();
  await h.engine.runActiveFile();
  h.runTask.emitData('boom: something broke\n', 'run-1');
  h.advance(184000);
  h.runTask.emitExit('run-1', { code: 3 });
  assert.equal(statusText(h.host), 'Exited with code 3 after 3m 4s');
  assert.ok(hasAction(h.host, 'ask'));
  h.click('[data-ide-task-footer-action="ask"]');
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].title, 'Run: node app.js');
  assert.match(h.asked[0].output, /boom: something broke/);
  assert.match(h.asked[0].output, /\[run\] exited with code 3/);
});

test('run view: Ask Jenny output is capped at 8 KB, keeping the tail', async () => {
  const h = setup();
  await h.engine.runActiveFile();
  h.runTask.emitData(`${'a'.repeat(20000)}LAST-LINE\n`, 'run-1');
  h.runTask.emitExit('run-1', { code: 1 });
  h.click('[data-ide-task-footer-action="ask"]');
  assert.equal(h.asked[0].output.length, MAX_ASK_OUTPUT_CHARS);
  assert.match(h.asked[0].output, /LAST-LINE/);
});

test('run view: the user Stop reads "Stopped after ..." with no Ask Jenny', async () => {
  const h = setup();
  await h.engine.runActiveFile();
  h.advance(4000);
  h.engine.kill();
  await flush();
  assert.equal(statusText(h.host), 'Stopped after 4s');
  assert.ok(hasAction(h.host, 'rerun'));
  assert.ok(!hasAction(h.host, 'ask'));
  assert.equal(h.engine.getLastRun().stopped, true);
});

test('run view: a main-reported killed exit is also "Stopped"', async () => {
  const h = setup();
  await h.engine.runActiveFile();
  h.runTask.emitExit('run-1', { code: null, status: 'killed' });
  assert.match(statusText(h.host), /^Stopped after /);
  assert.ok(!hasAction(h.host, 'ask'));
});

test('run view: Run again re-runs the same command and clears the footer while it runs', async () => {
  const h = setup();
  await h.engine.runActiveFile();
  h.runTask.emitExit('run-1', { code: 1 });
  h.click('[data-ide-task-footer-action="rerun"]');
  await flush();
  assert.equal(h.runTask.started.length, 2, 'started a second task');
  assert.equal(h.runTask.started[1].command, h.runTask.started[0].command, 'the same command');
  assert.equal(h.runTask.started[1].label, 'node app.js');
  assert.equal(footerEl(h.host), null, 'the footer hides while the re-run is in progress');
  h.runTask.emitExit('run-2', { code: 0 });
  assert.match(statusText(h.host), /^Exited with code 0/);
});

test('run view: Run again on a file run saves the edited buffer first (as the first run did)', async () => {
  let dirty = false;
  const saved = [];
  const h = setup({
    editorHost: { getActivePath: () => 'src/app.js', getActiveLanguageId: () => 'javascript', isDirty: () => dirty, focus() {} },
    saveFile: async (path) => { saved.push(path); dirty = false; return true; },
  });
  await h.engine.runActiveFile();
  h.runTask.emitExit('run-1', { code: 1 });
  dirty = true; // the user fixes the failing code
  h.click('[data-ide-task-footer-action="rerun"]');
  await flush();
  assert.deepEqual(saved, ['src/app.js'], 'the visible fix is what runs');
  assert.equal(h.runTask.started.length, 2);
});

test('run view: a root switch forgets the last run, so Run again cannot run it in the new folder', async () => {
  const h = setup();
  await h.engine.runScript('build');
  h.runTask.emitExit('run-1', { code: 1 });
  assert.ok(hasAction(h.host, 'rerun'));
  h.engine.resetForRoot();
  assert.equal(footerEl(h.host), null, 'no footer, no Run again');
  assert.equal(h.engine.getLastRun(), null);
  assert.equal(h.engine.getRunLabel(), 'Run');
});

test('run view: an npm script re-runs as that script; getRunLabel names it', async () => {
  const h = setup();
  await h.engine.runScript('build');
  assert.equal(h.engine.getRunLabel(), 'Run: npm run build');
  h.runTask.emitExit('run-1', { code: 1 });
  h.click('[data-ide-task-footer-action="rerun"]');
  await flush();
  assert.equal(h.runTask.started[1].command, "npm run 'build'");
});

test('run view: completion is the process exit, never output text', async () => {
  const h = setup();
  await h.engine.runActiveFile();
  h.runTask.emitData('[run] exited with code 0\nExited with code 0 after 1s\n', 'run-1');
  assert.equal(footerEl(h.host), null, 'spoofed output does not finish the run');
  assert.equal(h.engine.isRunning(), true);
});

test('run view: without an onAskJenny dep the Ask action is inert but harmless', async () => {
  const h = setup({ onAskJenny: undefined });
  await h.engine.runActiveFile();
  h.runTask.emitExit('run-1', { code: 1 });
  assert.doesNotThrow(() => h.click('[data-ide-task-footer-action="ask"]'));
  assert.deepEqual(h.asked, [], 'nothing was sent anywhere');
  assert.equal(statusText(h.host), 'Exited with code 1 after 0ms', 'the footer is still there');
});

test('run view: a task that cannot start says so and offers Run again and Ask Jenny', async () => {
  const h = setup();
  h.runTask.start = async () => ({ ok: false, message: 'npm is not installed' });
  await h.engine.runActiveFile();
  assert.equal(statusText(h.host), 'Could not start');
  assert.ok(hasAction(h.host, 'rerun'));
  assert.ok(hasAction(h.host, 'ask'));
  assert.equal(h.engine.getLastRun().startFailed, true);
});

test('run view: an exit that carries an error code reads as a failed start', async () => {
  const h = setup();
  await h.engine.runActiveFile();
  h.runTask.emitExit('run-1', { code: null, errorCode: 'ENOENT', status: 'error' });
  assert.equal(statusText(h.host), 'Could not start');
  assert.ok(hasAction(h.host, 'ask'));
});
test('the run-state change fires with the new "Run: <script>" label already set (the host repaints the tab then)', async () => {
  const labels = [];
  let engine = null;
  const h = setup({ onRunStateChange: () => labels.push(engine.getRunLabel()) });
  engine = h.engine;
  await h.engine.runActiveFile();
  assert.equal(labels[0], 'Run: node app.js', 'the first change already names the task');
});