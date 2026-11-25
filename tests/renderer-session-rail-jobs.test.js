'use strict';

/* Running jobs in the session rail (owner pick 2026-11-01, moved to Running now by row 195; renderer-session-rail-jobs.js
   with the model and render rows): live command and server rows with Stop, rows that open the run, the ticking clock,
   the browser page's Close, and the shared output path menu. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../renderer/chat/renderer-session-rail-model.js');
const render = require('../renderer/chat/renderer-session-rail-render.js');
const { createRailJobs, showOutputPathMenu } = require('../renderer/chat/renderer-session-rail-jobs.js');
const actionButton = require('../renderer/inventory/action-button.js');
const { flush, wrapper, summaryFor, createBridge, docked } = require('./helpers/session-rail-fixture.js');

const NOW = Date.now();
const jt = (key, fallback, params) => (params ? fallback.replace(/\{(\w+)\}/g, (m, n) => params[n]) : fallback);

function jobItem(jobId, state, extra = {}) {
  return {
    source_kind: 'background_job', operation_id: `job:${jobId}`, job_id: jobId, command: `cmd ${jobId}`, state,
    started_at_ms: NOW - 72_000, ended_at_ms: state === 'running' ? 0 : NOW - 1000, exit_code: state === 'failed' ? 1 : 0,
    stop_requested: false, ...extra,
  };
}

function tasks(items) {
  return wrapper({ scope: 'session_and_direct_children', counts: { active: 1, waiting: 0, failed: 1, completed: 1 },
    coverage: 'complete', unsupported_sources: [], items });
}

const ITEMS = [
  jobItem('aaaaaaaaaaaa', 'running'),
  jobItem('bbbbbbbbbbbb', 'completed', { started_at_ms: NOW - 84_000 }),
  jobItem('cccccccccccc', 'failed'),
  jobItem('dddddddddddd', 'failed', { stop_requested: true, exit_code: 15 }),
];

test('model: running commands and servers become rows, a stopped or finished job none', () => {
  const vm = model.buildRailViewModel({ summary: summaryFor('s1', { background_tasks: tasks([...ITEMS, jobItem('eeeeeeeeeeee', 'running', SERVING)]) }), sessionId: 's1', jt });
  const rows = vm.sections.find((section) => section.key === 'running_now').rows.filter((row) => row.key !== 'all');
  assert.deepEqual(rows.map((row) => [row.kind, row.jobId]), [['server', 'eeeeeeeeeeee'], ['job', 'aaaaaaaaaaaa']], 'a server first, then the commands');
  assert.equal(rows[1].dot.tone, 'active');
  assert.match(rows[1].meta, /^01:1[23]$/);
  assert.equal(rows[1].stopAria, 'Stop background job: cmd aaaaaaaaaaaa');
  assert.equal(rows[0].stopAria, 'Stop server: localhost:5173');
  assert.equal(JSON.stringify(vm).includes('bbbbbbbbbbbb'), false, 'finished work belongs to the Runs tab');
});

test('render: job markup carries the controls and never turns a command into markup', () => {
  const html = render.bodyHtml({ rows: [
    { kind: 'job', key: 'run:job:aaaaaaaaaaaa', runId: 'job:aaaaaaaaaaaa', jobId: 'aaaaaaaaaaaa', dot: { tone: 'active', pulse: true }, text: '<img src=x>', title: '<b>', meta: '00:01', startedAtMs: 5, stopLabel: 'Stop', stopAria: 'Stop it', stopTitle: 'Stop', canStop: true, surface: 'background_tasks', resourceRef: 'job:aaaaaaaaaaaa' },
  ] });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  assert.equal(doc.querySelector('img'), null);
  assert.equal(doc.querySelector('[data-rail-job-stop]').getAttribute('data-rail-job-stop'), 'aaaaaaaaaaaa');
  assert.equal(doc.querySelector('[data-rail-job-stop]').disabled, false);
  assert.equal(doc.querySelector('[data-rail-started-at]').getAttribute('data-rail-started-at'), '5');
  assert.equal(doc.querySelector('[data-rail-started-at]').textContent, '', 'elapsed text stays out of the markup, so a repaint keeps the row');
  const live = doc.querySelector('button.session-rail-fact');
  assert.equal(live.getAttribute('data-rail-surface'), 'background_tasks', 'a live job row is a button into the panel');
  assert.equal(live.getAttribute('data-rail-resource'), 'job:aaaaaaaaaaaa');
  assert.equal(live.getAttribute('data-rail-run'), 'job:aaaaaaaaaaaa');
  assert.equal(doc.querySelector('.session-rail-divider'), null, 'no finished fold in the rail');
});

test('rail: Stop kills, a job row opens the run on that job, no inline output', async (t) => {
  const bridge = createBridge({ respond: ({ session_id }, b) => ({ ok: true,
    summary: summaryFor(session_id, { background_tasks: tasks(ITEMS), revision: b.revision }), workspace_view: b.view, coordination_revision: b.revision }) });
  const f = await docked({ bridge });
  t.after(() => { f.api.dispose(); f.window.close(); });
  const calls = { kill: [], read: [] };
  f.window.jennyShell = { backgroundJobs: {
    kill: async (jobId) => { calls.kill.push(jobId); return { ok: true }; },
    readOutput: async (jobId) => { calls.read.push(jobId); return { ok: true, text: '15947 passed', fullOutputPath: 'G:/w/.jenny/tool-results/x/output.txt' }; },
  } };
  const stop = f.section('running_now').querySelector('[data-rail-job-stop]');
  stop.click();
  await flush();
  assert.deepEqual(calls.kill, ['aaaaaaaaaaaa']);
  assert.equal(stop.disabled, true);
  assert.equal(f.detail.calls.length, 0, 'Stop never opens a detail surface');

  const live = f.section('running_now').querySelector('[data-rail-resource="job:aaaaaaaaaaaa"]');
  live.click();
  assert.equal(f.detail.calls.at(-1).surface, 'background_tasks');
  assert.equal(f.detail.calls.at(-1).opener, live);
  assert.equal(f.detail.calls.at(-1).resourceRef, 'job:aaaaaaaaaaaa');
  assert.equal(f.section('running_now').querySelector('.session-rail-job-output'), null, 'the rail never unfolds output');
  assert.deepEqual(calls.read, [], 'a click reads no output in the rail');
  assert.equal(f.section('running_now').querySelectorAll('[data-rail-job-path]').length, 0, 'finished jobs are not listed');
});

test('jobs helper: a live row\'s elapsed time fills at once, ticks in sight only, and stops once no live job shows', async () => {
  const { window } = new JSDOM('<body><div id="tray"></div></body>', { pretendToBeVisual: true });
  const tray = window.document.getElementById('tray');
  const intervals = [];
  window.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  window.clearInterval = (id) => { intervals[id - 1] = null; };
  let shown = false;
  const jobs = createRailJobs({ tray, win: window, jt, trayShown: () => shown, getBackgroundJobs: () => null });
  tray.innerHTML = `<span class="session-rail-meta" data-rail-started-at="${Date.now() - 61_000}"></span>`;
  await flush();
  assert.equal(intervals.filter(Boolean).length, 0, 'a hidden tray does not tick');
  shown = true;
  jobs.sync();
  assert.match(tray.textContent, /^01:0[12]$/, 'the elapsed text fills without waiting a tick');
  assert.equal(intervals.filter(Boolean).length, 1);
  intervals[0]();
  assert.match(tray.textContent, /^01:0[12]$/);
  tray.innerHTML = '';
  await flush();
  assert.equal(intervals.filter(Boolean).length, 0);
  jobs.dispose();
  window.close();
});

test('output path menu: opens only for a job captured under the current workspace root and a real job id', () => {
  const { window } = new JSDOM('<body><button id="row">row</button></body>');
  const control = window.document.getElementById('row');
  const job = 'abcdef012345';
  const shown = [];
  const pathMenu = { showPathMenu: (options) => { shown.push(options.path); return true; } };
  const full = (id) => `G:\\w\\.jenny\\tool-results\\${id}\\output.txt`;
  const fire = (jobId, workspaceRoot) => {
    const event = { clientX: 1, clientY: 2, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    showOutputPathMenu({ jobId, fullOutputPath: full(jobId), event, control, rootEl: control, win: window, pathMenu, workspaceRoot });
    return event.defaultPrevented;
  };
  assert.equal(fire(job, 'G:\\w'), true, 'same workspace: the menu opens');
  assert.deepEqual(shown, [`.jenny/tool-results/${job}/output.txt`]);
  assert.equal(fire(job, 'g:/W/'), true, 'drive case and slash style do not matter');
  assert.equal(fire(job, 'G:\\other'), false, 'a job from another workspace would resolve to the wrong file');
  assert.equal(fire(job, ''), false, 'no workspace root: browser default');
  assert.equal(fire('job_-12345678', 'G:\\w'), false, 'a job id that is not the 12 hex digits of the tracker never gets a path menu');
  assert.equal(shown.length, 2);
  window.close();
});

test('model: a running job carries its test progress; a job without it gets null and no marks', () => {
  const items = [
    jobItem('aaaaaaaaaaaa', 'running', { progress_percent: 54.5, progress_failed: 2, progress_marks: [0.2, 0.7, 'x'] }),
    jobItem('eeeeeeeeeeee', 'running'),
    jobItem('ffffffffffff', 'running', { progress_percent: null, progress_marks: [] }),
    jobItem('cccccccccccc', 'failed', { progress_percent: 90 }),
  ];
  const vm = model.buildRailViewModel({ summary: summaryFor('s1', { background_tasks: tasks(items) }), sessionId: 's1', jt });
  const rows = vm.sections.find((section) => section.key === 'running_now').rows;
  const byJob = Object.fromEntries(rows.filter((row) => row.jobId).map((row) => [row.jobId, row]));
  assert.deepEqual([byJob.aaaaaaaaaaaa.progressPercent, byJob.aaaaaaaaaaaa.progressMarks], [54.5, [0.2, 0.7]]);
  assert.deepEqual([byJob.eeeeeeeeeeee.progressPercent, byJob.eeeeeeeeeeee.progressMarks], [null, []]);
  assert.deepEqual([byJob.ffffffffffff.progressPercent, byJob.ffffffffffff.progressMarks], [null, []]);
  assert.equal(byJob.cccccccccccc, undefined, 'a failed job is not running');
});


test('row 96: a running test job shows its % and a bar with a tick per failure; others keep elapsed time', () => {
  const html = render.bodyHtml({ rows: [
    { kind: 'job', key: 'job:a', jobId: 'a', text: 'pytest', title: 'pytest', startedAtMs: 5, progressPercent: 54.6, progressMarks: [0.2, 0.5], stopLabel: 'Stop', stopAria: 'Stop', stopTitle: 'Stop' },
    { kind: 'job', key: 'job:b', jobId: 'b', text: 'npm run dev', title: 'npm run dev', startedAtMs: 6, progressPercent: null, progressMarks: [], stopLabel: 'Stop', stopAria: 'Stop', stopTitle: 'Stop' },
  ] });
  const { window } = new JSDOM(`<body>${html}</body>`);
  const [testJob, devJob] = window.document.querySelectorAll('.session-rail-job');
  assert.equal(testJob.querySelector('.session-rail-meta').textContent, '54%');
  assert.equal(testJob.querySelector('[data-rail-started-at]'), null, 'the ticker leaves a % alone');
  assert.equal(testJob.hasAttribute('data-job-progress'), true);
  assert.equal(testJob.querySelector('.inv-progress-fill').style.getPropertyValue('--progress'), '54.60%');
  assert.equal(testJob.querySelectorAll('.session-rail-job-tick').length, 2);
  assert.equal(devJob.querySelector('.inv-progress'), null);
  assert.ok(devJob.querySelector('[data-rail-started-at="6"]'));
  window.close();
});

test('row 100 P2: a live job other chats wait on reads "N waiting", names them on hover and in the Stop tooltip', async () => {
  const { window } = new JSDOM('<body><div id="tray"></div></body>', { pretendToBeVisual: true });
  const tray = window.document.getElementById('tray');
  window.setInterval = () => 1;
  window.clearInterval = () => {};
  const waiters = { aaaaaaaaaaaa: ['Fix login bug', ''] };
  window.inventoryActionButton = actionButton;
  const jobs = createRailJobs({ tray, win: window, jt, trayShown: () => true, getBackgroundJobs: () => null,
    getJobWaiters: (jobId) => waiters[jobId] || [] });
  const vm = model.buildRailViewModel({ summary: summaryFor('s1', { background_tasks: tasks(ITEMS) }), sessionId: 's1', jt });
  const section = vm.sections.find((entry) => entry.key === 'running_now');
  tray.innerHTML = render.bodyHtml(section);
  await flush();
  jobs.sync();
  const slot = tray.querySelector('[data-rail-job-waiting="aaaaaaaaaaaa"]');
  assert.equal(slot.textContent, '2 waiting · ');
  assert.match(slot.parentElement.textContent, /^2 waiting · 01:1[23]$/, 'the elapsed time stays beside it');
  assert.equal(slot.closest('.session-rail-fact').title, 'cmd aaaaaaaaaaaa\nWaiting for it: Fix login bug');
  assert.equal(tray.querySelector('[data-rail-job-stop]').title, 'Stop this background job. 2 waiting for it.');
  delete waiters.aaaaaaaaaaaa;
  jobs.sync();
  assert.equal(slot.textContent, '');
  assert.equal(slot.closest('.session-rail-fact').title, 'cmd aaaaaaaaaaaa');
  assert.equal(tray.querySelector('[data-rail-job-stop]').title, 'Stop this background job');
  jobs.dispose();
  window.close();
});

/* Row 176: server rows (Stop / Close). */
const SERVING = { serving_url: 'http://localhost:5173', serving_port: 5173, serving_since_ms: NOW - 5000 };
const PAGE = { ok: true, open: true, url: 'https://example.com/docs', title: 'Example docs' };

test('jobs helper: Stop on a serving job kills it, Close on the browser closes this chat\'s page; a refusal re-enables each', async () => {
  const { window } = new JSDOM('<body><div id="tray"></div></body>', { pretendToBeVisual: true });
  window.inventoryActionButton = actionButton;
  const tray = window.document.getElementById('tray');
  const calls = [];
  let refuse = false;
  const jobs = createRailJobs({
    tray, win: window, jt, getSessionId: () => 's1', trayShown: () => true,
    getBackgroundJobs: () => ({ kill: async (id) => { calls.push(['kill', id]); return { ok: !refuse }; } }),
    getBrowserUse: () => ({ getState: async () => PAGE, close: async (payload) => { calls.push(['close', payload]); return { ok: !refuse }; } }),
  });
  jobs.syncBrowser();
  await flush();
  const vm = model.buildRailViewModel({ summary: summaryFor('s1', { background_tasks: tasks([jobItem('aaaaaaaaaaaa', 'running', SERVING)]) }), sessionId: 's1', jt, browser: jobs.getBrowser() });
  tray.innerHTML = render.bodyHtml(vm.sections.find((section) => section.key === 'running_now'));
  tray.addEventListener('click', (event) => jobs.handleClick(event));
  const [close, stop] = tray.querySelectorAll('[data-rail-server-stop]');
  assert.deepEqual([close.getAttribute('data-rail-server-stop'), stop.getAttribute('data-rail-server-stop')], ['browser', 'job:aaaaaaaaaaaa']);
  stop.click();
  close.click();
  assert.deepEqual([stop.disabled, close.disabled], [true, true]);
  await flush();
  assert.deepEqual(calls, [['kill', 'aaaaaaaaaaaa'], ['close', { session_id: 's1' }]]);
  assert.deepEqual([stop.disabled, close.disabled], [true, true], 'accepted: they stay disabled until the next paint');
  refuse = true;
  stop.disabled = false;
  close.disabled = false;
  stop.click();
  close.click();
  await flush();
  assert.deepEqual([stop.disabled, close.disabled], [false, false]);
  assert.equal(stop.title, 'Could not stop the background job.');
  assert.equal(close.title, 'Could not close the browser.');
  jobs.dispose();
  window.close();
});

test('jobs helper: a missing browser bridge, or a state that is not ok, reads as no page and never throws', async () => {
  const { window } = new JSDOM('<body><div id="tray"></div></body>', { pretendToBeVisual: true });
  const seen = [];
  const make = (getBrowserUse) => createRailJobs({ tray: window.document.getElementById('tray'), win: window, jt, getSessionId: () => 's1', getBackgroundJobs: () => null, getBrowserUse, onBrowserChange: (page) => seen.push(page) });
  for (const bridge of [null, {}, { getState: async () => ({ ok: false, reason: 'no_page' }) }, { getState: async () => { throw new Error('gone'); } }]) {
    const jobs = make(() => bridge);
    jobs.syncBrowser();
    await flush();
    assert.equal(jobs.getBrowser(), null);
    jobs.dispose();
  }
  assert.deepEqual(seen, []);
  window.close();
});
