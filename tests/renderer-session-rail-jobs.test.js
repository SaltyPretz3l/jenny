'use strict';

/* Background jobs in the session rail (owner pick 2026-11-01; renderer-session-rail-jobs.js with the model
   and render rows): live job rows with Stop, finished jobs under a folding "N finished" divider whose state
   persists as the background_tasks_finished disclosure, inline output, and the Session toggle's readout. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../renderer/chat/renderer-session-rail-model.js');
const render = require('../renderer/chat/renderer-session-rail-render.js');
const { createRailJobs } = require('../renderer/chat/renderer-session-rail-jobs.js');
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
    coverage: 'partial', unsupported_sources: ['session_runtime'], items });
}

const ITEMS = [
  jobItem('aaaaaaaaaaaa', 'running'),
  jobItem('bbbbbbbbbbbb', 'completed', { started_at_ms: NOW - 84_000 }),
  jobItem('cccccccccccc', 'failed'),
  jobItem('dddddddddddd', 'failed', { stop_requested: true, exit_code: 15 }),
];

test('model: live jobs first, then a finished divider over the finished ones, with their words', () => {
  const vm = model.buildRailViewModel({ summary: summaryFor('s1', { background_tasks: tasks(ITEMS) }), sessionId: 's1', jt });
  const rows = vm.sections.find((section) => section.key === 'background_tasks').rows.filter((row) => row.kind !== 'note');
  assert.deepEqual(rows.map((row) => row.kind), ['job', 'divider', 'job_done', 'job_done', 'job_done']);
  assert.equal(rows[0].dot.tone, 'active');
  assert.match(rows[0].meta, /^01:1[23]$/);
  assert.equal(rows[0].stopAria, 'Stop background job: cmd aaaaaaaaaaaa');
  assert.equal(rows[1].text, '3 finished');
  assert.equal(rows[1].open, true, 'the finished group is open by default');
  assert.equal(rows[2].meta, '01:23');
  assert.equal(rows[2].dot, null);
  assert.equal(rows[3].meta, 'Exit 1');
  assert.equal(rows[3].dot.tone, 'error');
  assert.equal(rows[4].meta, 'Stopped');
  assert.equal(rows[4].dot, null, 'a job the person stopped is not an error');
});

test('model: the finished disclosure folds the group (persisted or optimistic) and reads back', () => {
  const summary = summaryFor('s1', { background_tasks: tasks(ITEMS) });
  const closed = model.buildRailViewModel({ summary, sessionId: 's1', jt, workspaceView: { disclosures: { background_tasks_finished: false } } });
  const rows = closed.sections.find((section) => section.key === 'background_tasks').rows.filter((row) => row.kind !== 'note');
  assert.deepEqual(rows.map((row) => row.kind), ['job', 'divider']);
  assert.equal(model.isDisclosureOpen(closed, model.FINISHED_DISCLOSURE), false);
  const reopened = model.buildRailViewModel({ summary, sessionId: 's1', jt, workspaceView: { disclosures: { background_tasks_finished: false } },
    overrides: { background_tasks_finished: true } });
  assert.equal(model.isDisclosureOpen(reopened, model.FINISHED_DISCLOSURE), true);
  assert.ok(model.DISCLOSURE_KEYS.includes('background_tasks_finished'));
});

test('render: job markup carries the controls and never turns a command into markup', () => {
  const html = render.bodyHtml({ rows: [
    { kind: 'job', key: 'job:aaaaaaaaaaaa', jobId: 'aaaaaaaaaaaa', dot: { tone: 'active', pulse: true }, text: '<img src=x>', title: '<b>', meta: '00:01', startedAtMs: 5, stopLabel: 'Stop', stopAria: 'Stop it', stopTitle: 'Stop' },
    { kind: 'divider', key: 'finished', text: '1 finished', open: false },
    { kind: 'job_done', key: 'job:bbbbbbbbbbbb', jobId: 'bbbbbbbbbbbb', dot: null, text: 'npm test', meta: '00:09', title: 'npm test (Finished)' },
  ] });
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  assert.equal(doc.querySelector('img'), null);
  assert.equal(doc.querySelector('[data-rail-job-stop]').getAttribute('data-rail-job-stop'), 'aaaaaaaaaaaa');
  assert.equal(doc.querySelector('[data-rail-started-at]').getAttribute('data-rail-started-at'), '5');
  assert.equal(doc.querySelector('[data-rail-started-at]').textContent, '', 'elapsed text stays out of the markup, so a repaint keeps the row');
  assert.equal(doc.querySelector('.session-rail-divider').getAttribute('data-rail-section'), 'background_tasks_finished');
  assert.equal(doc.querySelector('.session-rail-divider').getAttribute('aria-expanded'), 'false');
  assert.equal(doc.querySelector('[data-rail-job-output]').getAttribute('data-rail-job-output'), 'bbbbbbbbbbbb');
});

test('rail: Stop kills, a finished row opens and closes its output, the divider persists its fold', async (t) => {
  const bridge = createBridge({ respond: ({ session_id }, b) => ({ ok: true,
    summary: summaryFor(session_id, { background_tasks: tasks(ITEMS), revision: b.revision }), workspace_view: b.view, coordination_revision: b.revision }) });
  const f = await docked({ bridge });
  t.after(() => { f.api.dispose(); f.window.close(); });
  const calls = { kill: [], read: [] };
  f.window.jennyShell = { backgroundJobs: {
    kill: async (jobId) => { calls.kill.push(jobId); return { ok: true }; },
    readOutput: async (jobId) => { calls.read.push(jobId); return { ok: true, text: '15947 passed', fullOutputPath: 'G:/w/.jenny/tool-results/x/output.txt' }; },
  } };
  if (f.head('background_tasks').getAttribute('aria-expanded') !== 'true') f.head('background_tasks').click();

  const stop = f.section('background_tasks').querySelector('[data-rail-job-stop]');
  stop.click();
  await flush();
  assert.deepEqual(calls.kill, ['aaaaaaaaaaaa']);
  assert.equal(stop.disabled, true);

  const row = f.section('background_tasks').querySelector('[data-rail-job-output="bbbbbbbbbbbb"]');
  row.click();
  await flush();
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(f.section('background_tasks').querySelector('.session-rail-job-output pre').textContent, '15947 passed');
  const opened = [];
  f.window.addEventListener('ide:open-file-at-line', (event) => opened.push(event.detail.path));
  f.section('background_tasks').querySelector('[data-rail-job-open]').click();
  assert.deepEqual(opened, ['G:/w/.jenny/tool-results/x/output.txt']);
  assert.equal(f.detail.calls.length, 0, 'job controls never open a detail surface');
  row.click();
  assert.equal(f.section('background_tasks').querySelector('.session-rail-job-output'), null);
  row.click();
  await flush();
  assert.deepEqual(calls.read, ['bbbbbbbbbbbb'], 'a finished output is read once');

  f.head('background_tasks_finished').click();
  await flush();
  assert.deepEqual(bridge.setViewCalls.at(-1).patch, { disclosures: { background_tasks_finished: false } });
  assert.equal(f.section('background_tasks').querySelectorAll('[data-rail-job-output]').length, 0);
  assert.equal(f.head('background_tasks_finished').getAttribute('aria-expanded'), 'false');
});

test('jobs helper: the toggle readout counts this chat\'s live jobs only while the tray is out of sight', async () => {
  const { window } = new JSDOM('<body><div id="tray"></div><button id="toggle"></button></body>', { pretendToBeVisual: true });
  window.inventoryActionButton = actionButton;
  const toggle = window.document.getElementById('toggle');
  toggle.innerHTML = render.toggleContent('Session');
  let push = null;
  let shown = false;
  const jobs = createRailJobs({
    tray: window.document.getElementById('tray'), toggle, win: window, jt, getSessionId: () => 's1', trayShown: () => shown,
    getBackgroundJobs: () => ({ onChanged: (fn) => { push = fn; return () => { push = null; }; }, getState: async () => ({ jobs: [] }) }),
  });
  const slot = toggle.querySelector('[data-session-rail-jobs-readout]');
  push({ jobs: [{ sessionId: 's1', state: 'running' }, { sessionId: 's1', state: 'killing' }, { sessionId: 's2', state: 'running' }, { sessionId: 's1', state: 'completed' }] });
  assert.equal(slot.hidden, false);
  assert.equal(slot.textContent, '2 running');
  shown = true;
  toggle.setAttribute('aria-pressed', 'true');
  await flush();
  assert.equal(slot.hidden, true, 'a visible tray shows the rows instead');
  shown = false;
  push({ jobs: [] });
  assert.equal(slot.hidden, true);
  jobs.dispose();
  assert.equal(push, null, 'dispose unsubscribes');
  window.close();
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

test('rail: a finished job row offers Reveal and Copy for its workspace-relative output file once it is known', async (t) => {
  const bridge = createBridge({ respond: ({ session_id }, b) => ({ ok: true,
    summary: summaryFor(session_id, { background_tasks: tasks(ITEMS), revision: b.revision }), workspace_view: b.view, coordination_revision: b.revision }) });
  const f = await docked({ bridge });
  t.after(() => { f.api.dispose(); f.window.close(); });
  const menus = [];
  const revealed = [];
  const opened = [];
  f.window.inventoryContextMenu = { show: (options) => menus.push(options) };
  f.window.rendererIdePathMenu = require('../renderer/features/renderer-ide-path-menu.js');
  f.window.jennyWorkspacePathResolve = { getWorkspaceRoot: () => 'g:/W/' }; // same root as the job's, case and slashes aside
  f.window.jennyShell = {
    workspaceFs: { revealInFolder: async (payload) => { revealed.push(payload.path); }, openInDefaultApp: async (payload) => { opened.push(payload.path); } },
    backgroundJobs: {
      kill: async () => ({ ok: true }),
      readOutput: async () => ({ ok: true, text: 'done', fullOutputPath: 'G:\\w\\.jenny\\tool-results\\bbbbbbbbbbbb\\output.txt' }),
    },
  };
  if (f.head('background_tasks').getAttribute('aria-expanded') !== 'true') f.head('background_tasks').click();
  const row = f.section('background_tasks').querySelector('[data-rail-job-output="bbbbbbbbbbbb"]');
  const fire = (target) => {
    const event = new f.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
    target.dispatchEvent(event);
    return event;
  };

  assert.equal(fire(row).defaultPrevented, false, 'before the output is known there is no path to offer');
  assert.equal(menus.length, 0);

  row.click();
  await flush();
  const event = fire(row);
  assert.equal(event.defaultPrevented, true);
  assert.equal(menus.length, 1);
  assert.deepEqual(menus[0].items.filter((item) => !item.separator).map((item) => item.label),
    ['Reveal in File Explorer', 'Open in Default App', 'Copy Path', 'Copy Relative Path', 'Copy Name']);
  assert.equal(menus[0].anchorX, 12);
  await menus[0].items.find((item) => item.label === 'Reveal in File Explorer').action();
  await menus[0].items.find((item) => item.label === 'Open in Default App').action();
  assert.deepEqual(revealed, ['.jenny/tool-results/bbbbbbbbbbbb/output.txt']);
  assert.deepEqual(opened, ['.jenny/tool-results/bbbbbbbbbbbb/output.txt']);

  fire(f.section('background_tasks').querySelector('[data-rail-job-open]'));
  assert.equal(menus.length, 2, 'the Open full output button carries the same menu');
  assert.equal(fire(f.section('background_tasks').querySelector('[data-rail-job-stop]')).defaultPrevented, false, 'Stop keeps the default behavior');
});

test('jobs helper: the path menu only opens for a job captured under the current workspace root and a real job id', async () => {
  const { window } = new JSDOM('<body><div id="tray"></div></body>', { pretendToBeVisual: true });
  window.inventoryActionButton = actionButton;
  const tray = window.document.getElementById('tray');
  const job = 'abcdef012345';
  const shown = [];
  let root = 'G:\\w';
  const output = { text: 'x', fullOutputPath: `G:\\w\\.jenny\\tool-results\\${job}\\output.txt` };
  const jobs = createRailJobs({
    tray, win: window, jt, getWorkspaceRoot: () => root,
    pathMenu: { showPathMenu: (options) => { shown.push(options.path); return true; } },
    getBackgroundJobs: () => ({ readOutput: async () => ({ ok: true, ...output }), getState: async () => ({ jobs: [] }) }),
  });
  tray.innerHTML = `<button data-rail-job-output="${job}" aria-expanded="false">row</button>`;
  const row = tray.querySelector('button');
  jobs.handleClick({ target: row, preventDefault() {} });
  await flush();
  const fire = () => {
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    row.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(fire(), true, 'same workspace: the menu opens');
  assert.deepEqual(shown, [`.jenny/tool-results/${job}/output.txt`]);
  root = 'g:/W/';
  assert.equal(fire(), true, 'drive case and slash style do not matter');
  root = 'G:\\other';
  assert.equal(fire(), false, 'a job from another workspace would resolve to the wrong file');
  root = '';
  assert.equal(fire(), false, 'no workspace root: browser default');
  assert.equal(shown.length, 2);
  jobs.dispose();
  window.close();
});

test('jobs helper: a job id that is not the tracker\'s 12 hex digits never gets a path menu', async () => {
  const { window } = new JSDOM('<body><div id="tray"></div></body>', { pretendToBeVisual: true });
  window.inventoryActionButton = actionButton;
  const tray = window.document.getElementById('tray');
  const odd = 'job_-12345678';
  const shown = [];
  const jobs = createRailJobs({
    tray, win: window, jt, getWorkspaceRoot: () => 'G:\\w',
    pathMenu: { showPathMenu: (options) => { shown.push(options.path); return true; } },
    getBackgroundJobs: () => ({ readOutput: async () => ({ ok: true, text: 'x', fullOutputPath: `G:\\w\\.jenny\\tool-results\\${odd}\\output.txt` }), getState: async () => ({ jobs: [] }) }),
  });
  tray.innerHTML = `<button data-rail-job-output="${odd}" aria-expanded="false">row</button>`;
  const row = tray.querySelector('button');
  jobs.handleClick({ target: row, preventDefault() {} });
  await flush();
  const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  row.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(shown, []);
  jobs.dispose();
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
  const rows = vm.sections.find((section) => section.key === 'background_tasks').rows;
  const byJob = Object.fromEntries(rows.filter((row) => row.jobId).map((row) => [row.jobId, row]));
  assert.deepEqual([byJob.aaaaaaaaaaaa.progressPercent, byJob.aaaaaaaaaaaa.progressMarks], [54.5, [0.2, 0.7]]);
  assert.deepEqual([byJob.eeeeeeeeeeee.progressPercent, byJob.eeeeeeeeeeee.progressMarks], [null, []]);
  assert.deepEqual([byJob.ffffffffffff.progressPercent, byJob.ffffffffffff.progressMarks], [null, []]);
  assert.equal('progressPercent' in byJob.cccccccccccc, false, 'finished rows carry no progress');
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

test('row 96: one running test job adds its % to the hidden-panel readout', () => {
  const { window } = new JSDOM('<body><div id="tray"></div><button id="toggle"></button></body>', { pretendToBeVisual: true });
  window.inventoryActionButton = actionButton;
  const toggle = window.document.getElementById('toggle');
  toggle.innerHTML = render.toggleContent('Session');
  let push = null;
  const jobs = createRailJobs({
    tray: window.document.getElementById('tray'), toggle, win: window, jt, getSessionId: () => 's1', trayShown: () => false,
    getBackgroundJobs: () => ({ onChanged: (fn) => { push = fn; return () => { push = null; }; }, getState: async () => ({ jobs: [] }) }),
  });
  const slot = toggle.querySelector('[data-session-rail-jobs-readout]');
  push({ jobs: [{ sessionId: 's1', state: 'running', progress: { percent: 54.9 } }] });
  assert.equal(slot.textContent, '1 running · 54%');
  push({ jobs: [{ sessionId: 's1', state: 'running', progress: { percent: 54.9 } }, { sessionId: 's1', state: 'running', progress: null }] });
  assert.equal(slot.textContent, '2 running', 'two live jobs show the count only');
  jobs.dispose();
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
  const section = vm.sections.find((entry) => entry.key === 'background_tasks');
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
