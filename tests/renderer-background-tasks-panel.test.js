'use strict';
// new-test-file: the Background tasks panel is a new surface

/* Row 138: the Background tasks panel (renderer-background-tasks-panel.js and -render.js) and its global API
   (renderer-shell-artifact-rails.js), in jsdom with fake bridges and fake timers. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const rr = require('../renderer/features/renderer-background-tasks-panel-render.js');
const owner = require('../renderer/features/renderer-background-tasks-panel.js');
const { createShellArtifactRails } = require('../renderer/shell/renderer-shell-artifact-rails.js');

const NOW = 1_800_000_000_000;
const flush = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const job = (jobId, state, extra = {}) => ({ jobId, sessionId: 's1', command: `cmd ${jobId}`, state, exitCode: null, stopRequested: false,
  startedAtMs: NOW - 72_000, endedAtMs: 0, progress: null, ...extra });
const chat = (sessionId, state, extra = {}) => ({ source_kind: 'linked_chat_turn', operation_id: `op_${sessionId}`, session_id: sessionId, state,
  title: `Chat ${sessionId}`, started_at: new Date(NOW - 30_000).toISOString(), finished_at: null, ...extra });
const JOBS = [
  job('aaaaaaaaaaaa', 'running', { startedAtMs: NOW - 72_000 }),
  job('bbbbbbbbbbbb', 'killing', { startedAtMs: NOW - 10_000 }),
  job('cccccccccccc', 'running', { startedAtMs: NOW - 5_000, progress: { percent: 54.6 } }),
  job('dddddddddddd', 'completed', { exitCode: 0, startedAtMs: NOW - 64_000, endedAtMs: NOW - 60_000 }),
  job('eeeeeeeeeeee', 'failed', { exitCode: 1, startedAtMs: NOW - 39_000, endedAtMs: NOW - 30_000 }),
  job('ffffffffffff', 'failed', { exitCode: 15, stopRequested: true, startedAtMs: NOW - 99_000, endedAtMs: NOW - 90_000 }),
  job('999999999999', 'running', { sessionId: 'other' }),
];
const parse = (html) => new JSDOM(`<body>${html}</body>`).window.document;
const facts = (doc) => [...doc.querySelectorAll('[data-bgt-open]')].map((row) => [row.getAttribute('data-bgt-open'), row.querySelector('.session-rail-meta').textContent]);

test('render: running first, the fold, finished newest first, each fact and dot', () => {
  const tasks = rr.buildTasks({ jobs: JOBS, sessionId: 's1', items: [chat('kid1', 'running'), chat('kid2', 'completed', { finished_at: new Date(NOW - 1000).toISOString() })] });
  const doc = parse(rr.listHtml({ tasks, filter: 'all', foldOpen: true, clearable: true }));
  assert.deepEqual(facts(doc), [
    ['job:cccccccccccc', '54%'], ['job:bbbbbbbbbbbb', 'Stopping'], ['chat:kid1', 'Running'], ['job:aaaaaaaaaaaa', ''],
    ['chat:kid2', 'Finished'], ['job:eeeeeeeeeeee', 'Exit 1 · 0:09'], ['job:dddddddddddd', 'Exit 0 · 0:04'], ['job:ffffffffffff', 'Stopped'],
  ]);
  assert.equal(doc.querySelector('[data-bgt-open="job:aaaaaaaaaaaa"] [data-bgt-started-at]').getAttribute('data-bgt-started-at'), String(NOW - 72_000), 'elapsed is a span the tick fills');
  assert.equal(doc.querySelector('.session-rail-divider-text').textContent, '4 finished');
  const list = doc.querySelector('.background-tasks-list');
  assert.ok([...list.children].indexOf(doc.querySelector('.background-tasks-fold')) === 4, 'the fold sits between running and finished');
  const dot = (id) => doc.querySelector(`[data-bgt-open="${id}"] .status-dot`)?.className || '';
  assert.match(dot('job:aaaaaaaaaaaa'), /status-dot--active session-rail-dot-pulse/);
  assert.match(dot('job:bbbbbbbbbbbb'), /status-dot--active session-rail-dot-pulse/, 'stopping still breathes');
  assert.match(dot('job:eeeeeeeeeeee'), /status-dot--error/);
  assert.equal(dot('job:ffffffffffff'), '', 'a job the person stopped is not an error');
  assert.equal(dot('job:dddddddddddd'), '');
  assert.equal(doc.querySelectorAll('[data-bgt-stop]').length, 3, 'Stop on running commands only, never on a linked chat row');
  assert.equal(doc.querySelector('[data-bgt-stop="job:bbbbbbbbbbbb"]').disabled, true);
  assert.equal(doc.querySelector('[data-bgt-stop="job:bbbbbbbbbbbb"]').getAttribute('aria-label'), 'Stop background job: cmd bbbbbbbbbbbb', 'a disabled Stop keeps its name');
  assert.equal(doc.querySelector('[data-bgt-open="job:9999"]'), null);
  assert.equal(rr.formatClock(4000), '0:04');
  assert.equal(rr.formatClock(3_723_000), '1:02:03');
});

test('render: the three filters, their empty states, Clear only with a finished command and the method', () => {
  const tasks = rr.buildTasks({ jobs: JOBS, sessionId: 's1', items: [chat('kid1', 'running')] });
  const commands = parse(rr.listHtml({ tasks, filter: 'commands', foldOpen: true, clearable: true }));
  assert.equal(commands.querySelector('[data-bgt-open^="chat:"]'), null);
  assert.equal(commands.querySelector('[aria-checked="true"]').textContent, 'Commands');
  const chats = parse(rr.listHtml({ tasks, filter: 'chats', foldOpen: true, clearable: true }));
  assert.deepEqual(facts(chats).map(([id]) => id), ['chat:kid1']);
  assert.equal(chats.querySelector('[data-bgt-clear]'), null);
  assert.ok(commands.querySelector('[data-bgt-clear]'));
  assert.equal(parse(rr.listHtml({ tasks, filter: 'all', foldOpen: true, clearable: false })).querySelector('[data-bgt-clear]'), null, 'no method, no Clear');
  const folded = parse(rr.listHtml({ tasks, filter: 'all', foldOpen: false, clearable: true }));
  assert.equal(folded.querySelector('[data-bgt-fold]').getAttribute('aria-expanded'), 'false');
  assert.equal(folded.querySelector('[data-bgt-open="job:dddddddddddd"]'), null);
  for (const [filter, words] of [['all', 'Nothing has run in the background in this chat yet.'], ['commands', 'No background commands in this chat yet.'], ['chats', 'No linked chats yet.']]) {
    const doc = parse(`<div id="r">${rr.listHtml({ tasks: [], filter, foldOpen: true, clearable: true })}</div>`);
    const root = doc.getElementById('r');
    assert.equal(root.children.length, 2, `${filter}: the toolbar and one sentence`);
    assert.equal(root.querySelector('.background-tasks-empty').textContent, words);
  }
});

test('render: untrusted command and chat text stays text, in the list and the open task', () => {
  const tasks = rr.buildTasks({ sessionId: 's1', jobs: [job('aaaaaaaaaaaa', 'running', { command: '<img src=x onerror=alert(1)>' })], items: [chat('kid', 'running', { title: '<b>bold</b>' })] });
  const list = parse(rr.listHtml({ tasks, filter: 'all', foldOpen: true, clearable: true }));
  assert.equal(list.querySelector('img'), null);
  assert.equal(list.querySelector('b'), null);
  assert.ok(list.body.textContent.includes('<img src=x onerror=alert(1)>'));
  const byKind = (kind) => tasks.find((task) => task.kind === kind);
  const detail = parse(rr.detailHtml(byKind('command'), { text: '<script>x</script>', loaded: true }, true) + rr.detailHtml(byKind('chat'), null, true));
  assert.equal(detail.querySelector('img, b, script'), null);
  assert.equal(detail.querySelector('[data-bgt-output]').textContent, '<script>x</script>');
});

function harness(options = {}) {
  const dom = new JSDOM('<body><button id="opener">More</button><div id="artifactReviewPanel" class="artifact-review-panel"><div data-artifact-panel-title-slot></div><div id="host"></div></div></body>', { pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  const panelEl = doc.getElementById('artifactReviewPanel');
  const host = doc.getElementById('host');
  const state = { currentSessionId: 's1', ui: { artifactReview: { mode: 'artifact', enabled: false } } };
  let seq = 0;
  const timeouts = new Map();
  const intervals = new Map();
  const calls = { kill: [], read: [], clear: [], summary: [], stop: [], open: [], claim: [], renders: 0 };
  let jobsPush = null;
  let summaryPush = null;
  let jobsNow = (options.jobs || JOBS).slice();
  const reads = options.reads || (() => ({ ok: true, state: 'running', live: true, text: 'line 1', truncated: false, fullOutputPath: '' }));
  win.jennyShell = {
    backgroundJobs: {
      getState: async () => ({ jobs: jobsNow }),
      onChanged: (fn) => { jobsPush = fn; return () => { jobsPush = null; }; },
      kill: async (jobId) => { calls.kill.push(jobId); return options.kill ? options.kill(jobId) : { ok: true }; },
      readOutput: (jobId) => { calls.read.push(jobId); return Promise.resolve(reads(jobId, calls.read.length)); },
      ...(options.noClear ? {} : { clearFinished: async (sessionId) => { calls.clear.push(sessionId); jobsNow = jobsNow.filter((entry) => entry.state === 'running' || entry.state === 'killing'); return { ok: true, cleared: 3 }; } }),
    },
    chatWorkspace: {
      getSummary: async (request) => { calls.summary.push(request.session_id); return { ok: true, summary: { session_id: request.session_id, background_tasks: { state: 'available', data: { items: options.items || [] } } } }; },
      onChanged: (fn) => { summaryPush = fn; return () => { summaryPush = null; }; },
    },
    clipboard: { writeText: async (text) => { calls.copied = text; } },
  };
  const surface = { previewContent: host };
  let panel = null;
  const deps = {
    state, windowRef: win, dom: { artifactReviewPanel: panelEl },
    openArtifactRail: (mode) => Object.assign(state.ui.artifactReview, { mode, enabled: true }),
    renderArtifactReviewPanel: () => {
      calls.renders += 1;
      if (state.ui.artifactReview.mode !== 'background_tasks' || !state.ui.artifactReview.enabled) return;
      panel.renderRailContent(surface);
      panelEl.querySelector('[data-artifact-panel-title-slot]').innerHTML = panel.titleHtml() || 'Background tasks';
    },
    toggleArtifactReview: () => { state.ui.artifactReview.enabled = false; },
    claimOwner: (id) => calls.claim.push(id),
    getPanelSessionId: () => state.currentSessionId,
    openSession: (id) => calls.open.push(id),
    stopSession: options.stopSession || (async (id) => { calls.stop.push(id); return true; }),
    setTimeoutImpl: (fn, ms) => { seq += 1; timeouts.set(seq, { fn, ms }); return seq; },
    clearTimeoutImpl: (id) => timeouts.delete(id),
    setIntervalImpl: (fn, ms) => { seq += 1; intervals.set(seq, { fn, ms }); return seq; },
    clearIntervalImpl: (id) => intervals.delete(id),
    now: () => options.now?.() ?? NOW,
  };
  panel = owner.createBackgroundTasksPanel(deps);
  panel.bind();
  const $ = (selector) => panelEl.querySelector(selector);
  return {
    win, doc, panelEl, host, state, calls, panel, $,
    push: (jobs) => { jobsNow = jobs; jobsPush?.({ jobs }); },
    summaryPush: (event) => summaryPush?.(event),
    pendingPolls: () => [...timeouts.values()].filter((entry) => entry.ms === 1500).length,
    runPolls: () => { for (const [id, entry] of [...timeouts]) if (entry.ms === 1500) { timeouts.delete(id); entry.fn(); } },
    runTimeouts: (ms) => { for (const [id, entry] of [...timeouts]) if (entry.ms === ms) { timeouts.delete(id); entry.fn(); } },
    tick: () => { for (const entry of intervals.values()) entry.fn(); },
    intervals,
    close: () => { panel.dispose(); win.close(); },
  };
}

test('owner: opens on a task id; an unknown id lands on the list; Back and Escape return focus to the row', async () => {
  const h = harness();
  assert.equal(await h.panel.open({ sessionId: 's1', taskId: 'job:dddddddddddd', opener: h.doc.getElementById('opener') }), true);
  assert.deepEqual(h.calls.claim, ['s1']);
  assert.equal(h.state.ui.artifactReview.mode, 'background_tasks');
  assert.equal(h.$('[data-bgt-detail]').getAttribute('data-bgt-detail'), 'job:dddddddddddd');
  assert.equal(h.$('.background-tasks-command').textContent, 'cmd dddddddddddd');
  assert.equal(h.$('[data-bgt-back]').getAttribute('aria-label'), 'Back to background tasks');
  assert.equal(h.doc.activeElement, h.$('[data-bgt-back]'));
  h.$('[data-bgt-back]').click();
  assert.equal(h.$('[data-bgt-detail]'), null);
  assert.equal(h.$('[data-artifact-panel-title-slot]').textContent, 'Background tasks');
  assert.equal(h.doc.activeElement, h.$('[data-bgt-open="job:dddddddddddd"]'), 'Back focuses the row that was opened');

  h.$('[data-bgt-open="job:eeeeeeeeeeee"]').click();
  assert.ok(h.$('[data-bgt-detail="job:eeeeeeeeeeee"]'));
  h.$('[data-bgt-output]').focus();
  const escape = new h.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  h.$('[data-bgt-output]').dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(h.$('[data-bgt-detail]'), null);
  assert.equal(h.doc.activeElement, h.$('[data-bgt-open="job:eeeeeeeeeeee"]'));

  assert.equal(await h.panel.open({ sessionId: 's1', taskId: 'job:nope' }), true);
  assert.equal(h.$('[data-bgt-detail]'), null, 'an unknown task lands on the list');
  assert.ok(h.$('.background-tasks-list'));
  h.close();
});

test('owner: Stop kills and a refusal re-enables it with the title; Clear calls clearFinished with the session', async () => {
  const h = harness({ kill: () => ({ ok: false, reason: 'not_running' }) });
  await h.panel.open({ sessionId: 's1' });
  const stop = h.$('[data-bgt-stop="job:aaaaaaaaaaaa"]');
  stop.click();
  assert.equal(stop.disabled, true);
  await flush();
  assert.deepEqual(h.calls.kill, ['aaaaaaaaaaaa']);
  assert.equal(stop.disabled, false);
  assert.equal(stop.title, 'Could not stop the background job.');
  h.$('[data-bgt-clear]').click();
  await flush();
  assert.deepEqual(h.calls.clear, ['s1']);
  assert.equal(h.$('[data-bgt-open="job:dddddddddddd"]'), null, 'cleared rows leave');
  assert.equal(h.$('[data-bgt-clear]'), null);
  h.close();
  const old = harness({ noClear: true });
  await old.panel.open({ sessionId: 's1' });
  assert.equal(old.$('[data-bgt-clear]'), null, 'an older main process without clearFinished shows no Clear');
  old.close();
});

test('owner: a push re-renders the list and keeps focus on the same row; a vanished open task falls back to the list', async () => {
  const h = harness();
  await h.panel.open({ sessionId: 's1' });
  h.$('[data-bgt-open="job:dddddddddddd"]').focus();
  h.push(JOBS.concat(job('777777777777', 'running', { startedAtMs: NOW })));
  assert.ok(h.$('[data-bgt-open="job:777777777777"]'), 'the new job is listed');
  assert.equal(h.doc.activeElement, h.$('[data-bgt-open="job:dddddddddddd"]'), 'focus stays on the row');
  h.$('[data-bgt-fold]').click();
  assert.equal(h.$('[data-bgt-open="job:dddddddddddd"]'), null);
  h.push(JOBS.slice());
  assert.equal(h.$('[data-bgt-fold]').getAttribute('aria-expanded'), 'false', 'the fold survives a re-render');
  h.$('[data-bgt-fold]').click();
  h.$('[data-bgt-open="job:dddddddddddd"]').click();
  assert.ok(h.$('[data-bgt-detail]'));
  h.push(JOBS.filter((entry) => entry.jobId !== 'dddddddddddd'));
  assert.equal(h.$('[data-bgt-detail]'), null, 'cleared under the reader: back to the list');
  assert.equal(h.$('[data-artifact-panel-title-slot]').textContent, 'Background tasks');
  h.close();
});

test('live output: polls only while the open command runs and shows, one read at a time, stops on back, close, switch and dispose', async () => {
  let release = null;
  const h = harness({ reads: (jobId, n) => (n === 2 ? new Promise((resolve) => { release = () => resolve({ ok: true, text: 'two', live: true }); }) : { ok: true, text: `read ${n}`, live: true }) });
  await h.panel.open({ sessionId: 's1', taskId: 'job:aaaaaaaaaaaa', opener: h.doc.getElementById('opener') });
  await flush();
  assert.equal(h.calls.read.length, 1, 'one read on open');
  assert.equal(h.$('[data-bgt-output]').textContent, 'read 1');
  assert.equal(h.pendingPolls(), 1);
  h.runPolls();
  assert.equal(h.calls.read.length, 2);
  assert.equal(h.pendingPolls(), 0, 'no timer while a read is in flight');
  h.panel.refresh();
  assert.equal(h.pendingPolls(), 0, 'and no second read');
  release();
  await flush();
  assert.equal(h.pendingPolls(), 1);
  Object.defineProperty(h.doc, 'visibilityState', { value: 'hidden', configurable: true });
  h.doc.dispatchEvent(new h.win.Event('visibilitychange'));
  assert.equal(h.pendingPolls(), 0, 'a hidden document stops polling');
  Object.defineProperty(h.doc, 'visibilityState', { value: 'visible', configurable: true });
  h.doc.dispatchEvent(new h.win.Event('visibilitychange'));
  assert.equal(h.pendingPolls(), 1);
  h.$('[data-bgt-back]').click();
  assert.equal(h.pendingPolls(), 0, 'Back stops it');
  h.$('[data-bgt-open="job:aaaaaaaaaaaa"]').click();
  await flush();
  assert.equal(h.pendingPolls(), 1);
  h.panel.close();
  assert.equal(h.pendingPolls(), 0, 'close stops it');
  assert.equal(h.doc.activeElement, h.doc.getElementById('opener'), 'close returns focus to the opener');
  await h.panel.open({ sessionId: 's1', taskId: 'job:aaaaaaaaaaaa' });
  await flush();
  h.state.currentSessionId = 's2';
  h.panel.renderRailContent({ previewContent: h.host });
  assert.equal(h.pendingPolls(), 0, 'a session switch stops it');
  assert.equal(h.$('[data-bgt-detail]'), null, 'and goes back to the list');
  h.state.currentSessionId = 's1';
  h.panel.renderRailContent({ previewContent: h.host });
  h.$('[data-bgt-open="job:aaaaaaaaaaaa"]').click();
  await flush();
  const before = h.calls.read.length;
  h.panel.dispose();
  h.runPolls();
  await flush();
  assert.equal(h.calls.read.length, before, 'no read after dispose()');
  h.win.close();
});

test('live output: a finished command is read once; settling reads the final tail; text, follow, Jump to latest, truncated', async () => {
  let text = 'a';
  const h = harness({ reads: () => ({ ok: true, live: true, text, truncated: text.length > 2, fullOutputPath: 'G:/w/.jenny/tool-results/aaaaaaaaaaaa/output.txt' }) });
  await h.panel.open({ sessionId: 's1', taskId: 'job:dddddddddddd' });
  await flush();
  assert.equal(h.calls.read.length, 1);
  assert.equal(h.pendingPolls(), 0, 'a finished command is not polled');
  h.$('[data-bgt-back]').click();
  h.$('[data-bgt-open="job:aaaaaaaaaaaa"]').click();
  await flush();
  const pre = h.$('[data-bgt-output]');
  assert.equal(pre.textContent, 'a');
  assert.equal(h.$('.background-tasks-live').textContent, 'Following output');
  assert.ok(h.$('[data-bgt-open-full]'), 'Open full output once the read names the file');
  const node = pre.firstChild;
  h.runPolls();
  await flush();
  assert.equal(pre.firstChild, node, 'unchanged text keeps its text node');
  Object.defineProperties(pre, { scrollHeight: { value: 900, configurable: true }, clientHeight: { value: 100, configurable: true } });
  pre.scrollTop = 200;
  pre.dispatchEvent(new h.win.Event('scroll'));
  assert.equal(h.$('[data-bgt-jump]').textContent, 'Jump to latest', 'scrolled up: the reader keeps their place');
  text = 'abc';
  h.runPolls();
  await flush();
  assert.equal(pre.textContent, 'abc');
  assert.equal(pre.scrollTop, 200, 'not pulled to the bottom');
  assert.equal(h.$('[data-bgt-truncated]').hidden, false);
  assert.equal(h.$('[data-bgt-truncated]').textContent, 'Showing the last part of the output.');
  h.$('[data-bgt-jump]').click();
  assert.equal(pre.scrollTop, 900);
  assert.equal(h.$('.background-tasks-live').textContent, 'Following output');
  const reads = h.calls.read.length;
  h.push(JOBS.map((entry) => (entry.jobId === 'aaaaaaaaaaaa' ? { ...entry, state: 'completed', exitCode: 0, endedAtMs: NOW } : entry)));
  await flush();
  assert.equal(h.calls.read.length, reads + 1, 'the final read on settle');
  assert.equal(h.pendingPolls(), 0);
  assert.match(h.$('[data-bgt-status]').textContent, /^Exit 0 · took 1:12/);
  assert.equal(h.$('[data-bgt-announce]').textContent, h.$('[data-bgt-status] > span').textContent, 'the finish is announced once');
  assert.equal(h.$('.background-tasks-live'), null);
  assert.equal(pre.isConnected, true, 'the output node survives the status change');
  h.close();
});

test('live output: the empty and failed words', async () => {
  const empty = harness({ reads: () => ({ ok: true, live: true, text: '' }) });
  await empty.panel.open({ sessionId: 's1', taskId: 'job:aaaaaaaaaaaa' });
  await flush();
  assert.equal(empty.$('[data-bgt-output]').textContent, 'No output yet.');
  empty.$('[data-bgt-back]').click();
  empty.$('[data-bgt-open="job:dddddddddddd"]').click();
  await flush();
  assert.equal(empty.$('[data-bgt-output]').textContent, 'No output.');
  empty.close();
  const failed = harness({ reads: () => ({ ok: false, reason: 'gone' }) });
  await failed.panel.open({ sessionId: 's1', taskId: 'job:dddddddddddd' });
  await flush();
  assert.equal(failed.$('[data-bgt-output]').textContent, "That job's output isn't available any more.");
  failed.close();
});

test('live output: a stale or failed read keeps the tail on screen; a late answer for another task does not strand the open one', async () => {
  const answers = [{ ok: true, live: true, text: 'tail' }, { ok: true, live: true, text: '', stale: true }, { ok: false }];
  const h = harness({ reads: (jobId, n) => answers[n - 1] });
  await h.panel.open({ sessionId: 's1', taskId: 'job:aaaaaaaaaaaa' });
  await flush();
  h.runPolls();
  await flush();
  assert.equal(h.$('[data-bgt-output]').textContent, 'tail', 'no usable live file this time: the tail stays');
  h.runPolls();
  await flush();
  assert.equal(h.calls.read.length, 3);
  assert.equal(h.$('[data-bgt-output]').textContent, 'tail', 'a failed read does not replace a tail already shown');
  h.close();

  let release = null;
  const late = harness({ reads: (jobId, n) => (n === 1 ? new Promise((resolve) => { release = () => resolve({ ok: true, live: true, text: 'A' }); }) : { ok: true, live: true, text: `for ${jobId}` }) });
  await late.panel.open({ sessionId: 's1', taskId: 'job:aaaaaaaaaaaa' });
  late.$('[data-bgt-back]').click();
  late.$('[data-bgt-open="job:cccccccccccc"]').click();
  release();
  await flush();
  assert.deepEqual(late.calls.read, ['aaaaaaaaaaaa', 'cccccccccccc'], 'the task opened meanwhile gets its own read');
  assert.equal(late.$('[data-bgt-output]').textContent, 'for cccccccccccc');
  assert.equal(late.pendingPolls(), 1, 'and its polling');
  late.close();
});

test('linked chats: a live chat row is not a hover-Stop row; a chat switch during a summary read asks again for the new chat', async () => {
  const tasks = rr.buildTasks({ sessionId: 's1', jobs: [job('aaaaaaaaaaaa', 'running')], items: [chat('kid1', 'running')] });
  const doc = parse(rr.listHtml({ tasks, filter: 'all', foldOpen: true, clearable: true }));
  assert.equal(doc.querySelector('[data-bgt-task="chat:kid1"]').getAttribute('data-job-state'), 'done', 'its state word is never hidden for a Stop it does not have');
  assert.equal(doc.querySelector('[data-bgt-task="job:aaaaaaaaaaaa"]').getAttribute('data-job-state'), 'running');
  const h = harness();
  await h.panel.open({ sessionId: 's1' });
  h.summaryPush({ session_id: 's1' });
  h.runTimeouts(120); // the read for s1 is now in flight
  h.state.currentSessionId = 's2';
  h.panel.renderRailContent({ previewContent: h.host });
  await flush();
  assert.equal(h.calls.summary.at(-1), 's2', 'the answer for the old chat is dropped and the new chat is read');
  h.close();
});

test('tick: elapsed text updates in place and the list markup is not rebuilt', async () => {
  let now = NOW;
  const h = harness({ now: () => now });
  await h.panel.open({ sessionId: 's1' });
  const row = h.$('[data-bgt-open="job:aaaaaaaaaaaa"]');
  const clock = row.querySelector('[data-bgt-started-at]');
  assert.equal(clock.textContent, '1:12');
  row.focus();
  now += 2000;
  h.tick();
  assert.equal(clock.textContent, '1:14');
  assert.equal(h.$('[data-bgt-open="job:aaaaaaaaaaaa"]'), row, 'the same row element');
  assert.equal(h.doc.activeElement, row);
  h.panel.close();
  h.tick();
  assert.equal(h.intervals.size, 0, 'a closed panel stops ticking');
  h.close();
});

test('linked chat: Stop only while running, a failed stop re-enables with the title, Open chat opens the child', async () => {
  let ok = false;
  const stops = [];
  const items = [chat('kid1', 'running'), chat('kid2', 'completed', { finished_at: new Date(NOW).toISOString() })];
  const h = harness({ items, stopSession: async (id) => { stops.push(id); return ok; } });
  await h.panel.open({ sessionId: 's1', taskId: 'chat:kid1' });
  assert.equal(h.$('.background-tasks-command').textContent, 'Chat kid1');
  assert.match(h.$('[data-bgt-status]').textContent, /^Running · 0:30/);
  const stop = h.$('[data-bgt-stop="chat:kid1"]');
  stop.click();
  await flush();
  assert.deepEqual(stops, ['kid1']);
  assert.equal(stop.disabled, false);
  assert.equal(stop.title, 'Could not stop this chat.');
  h.$('[data-bgt-open-chat]').click();
  assert.deepEqual(h.calls.open, ['kid1']);
  h.$('[data-bgt-back]').click();
  h.$('[data-bgt-open="chat:kid2"]').click();
  assert.equal(h.$('[data-bgt-stop]'), null, 'no Stop once it finished');
  assert.match(h.$('[data-bgt-status]').textContent, /^Finished · 0:30/);
  assert.equal(h.$('[data-bgt-output]'), null, 'no output block and no step list');
  h.close();
});

test('stopSession: the renderer stop first, then the turn the main process knows; nothing found is false', async () => {
  const calls = [];
  const chatApi = (turn, cancel = { ok: true }) => ({ getActiveTurnState: async (id) => { calls.push(['turn', id]); return turn; }, cancelStream: async (id) => { calls.push(['cancel', id]); return cancel; } });
  const viaRenderer = owner.createStopSession({ stopSessionStream: async (id) => { calls.push(['renderer', id]); return { streamId: 'st1' }; }, getChat: () => chatApi(null) });
  assert.equal(await viaRenderer('kid'), true);
  assert.deepEqual(calls, [['renderer', 'kid']]);
  calls.length = 0;
  const viaTurn = owner.createStopSession({ stopSessionStream: async () => null, getChat: () => chatApi({ stream_id: 'st9', session_id: 'kid' }) });
  assert.equal(await viaTurn('kid'), true);
  assert.deepEqual(calls, [['turn', 'kid'], ['cancel', 'st9']]);
  calls.length = 0;
  assert.equal(await owner.createStopSession({ stopSessionStream: async () => null, getChat: () => chatApi(null) })('kid'), false);
  assert.equal(await owner.createStopSession({ getChat: () => chatApi({ stream_id: 'st9' }, { ok: false }) })('kid'), false, 'a refused cancel is not a stop');
});

test('global API: loads the panel lazily, open, toggle, close and isOpen per mode, removed on dispose', async () => {
  const h = harness();
  h.panel.dispose(); // the rails build their own
  const win = h.win;
  const state = h.state;
  const loaded = [];
  win.scriptLoaderUtils = { ensureScript: async ({ src }) => {
    loaded.push(src);
    if (src.endsWith('-render.js')) win.rendererBackgroundTasksPanelRender = rr; else win.rendererBackgroundTasksPanelOwner = owner;
    return true;
  } };
  const surface = { previewContent: h.host };
  let built = null;
  const controller = {
    openArtifactRail: (mode) => Object.assign(state.ui.artifactReview, { mode, enabled: true }),
    renderArtifactReviewPanel: () => { if (state.ui.artifactReview.mode === 'background_tasks') built.renderBackgroundTasksSurface(surface); },
    toggleArtifactReview: () => { state.ui.artifactReview.enabled = false; },
  };
  const cleanups = [];
  built = createShellArtifactRails({
    state, windowRef: win, escapeHtml: (value) => String(value), callbacks: {}, codeReviewRailDeps: {}, registerCleanup: (fn) => cleanups.push(fn),
    sidePanel: { claim: () => true, getSessionId: () => state.currentSessionId }, appendClientLog: () => {}, showToastMessage: () => {},
    renderAll: () => {}, setActiveView: () => {}, getSurface: () => controller, ensureArtifactSurface: () => controller,
    resolveArtifactReviewPanelEl: () => h.panelEl,
  });
  const api = win.rendererBackgroundTasksPanel;
  assert.equal(typeof api.open, 'function', 'published before the panel scripts load');
  assert.equal(api.isOpen(), false);
  const opener = win.document.getElementById('opener');
  assert.equal(await api.open({ sessionId: 's1', opener }), true);
  assert.deepEqual(loaded, ['renderer/features/renderer-background-tasks-panel-render.js', 'renderer/features/renderer-background-tasks-panel.js']);
  assert.equal(api.isOpen(), true);
  assert.ok(h.$('.background-tasks-list'));
  state.ui.artifactReview.mode = 'tasks';
  assert.equal(api.isOpen(), false, 'another mode is not this panel');
  assert.equal(await api.toggle({ sessionId: 's1', opener }), true, 'toggle opens from another mode');
  opener.blur();
  assert.equal(await api.toggle({ sessionId: 's1', opener }), false, 'toggle closes when showing');
  assert.equal(api.isOpen(), false);
  assert.equal(win.document.activeElement, opener, 'close hands focus back to the opener');
  assert.equal(api.close(), false, 'closing a closed panel does nothing');
  assert.equal(await api.open({ sessionId: 's1', taskId: 'job:aaaaaaaaaaaa' }), true);
  assert.ok(h.$('[data-bgt-detail="job:aaaaaaaaaaaa"]'));
  assert.ok(api.titleHtml().includes('data-bgt-back'));
  for (const fn of cleanups.reverse()) fn();
  assert.equal(win.rendererBackgroundTasksPanel, undefined, 'removed on dispose');
  win.close();
});
