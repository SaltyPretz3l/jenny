'use strict';
// new-test-file: the Runs list (row 195) is one new surface over three sources, and renderer-background-tasks-panel.test.js is at its 600-line ceiling

/* Row 195 (C7, C8, C9 list half): Runs is one list of a chat's servers, background commands, helpers and linked chats
   with a filter; a helper opens through the monitor and comes back to its row. jsdom, fake bridges, fake timers. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const rr = require('../renderer/features/renderer-background-tasks-panel-render.js');
const owner = require('../renderer/features/renderer-background-tasks-panel.js');

const NOW = 1_800_000_000_000;
const flush = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const job = (jobId, state, extra = {}) => ({ jobId, sessionId: 's1', command: `cmd ${jobId}`, state, exitCode: null, stopRequested: false,
  startedAtMs: NOW - 72_000, endedAtMs: 0, progress: null, ...extra });
const server = (jobId, extra = {}) => job(jobId, 'running', { serving: { url: 'http://localhost:5173', host: 'localhost', port: 5173, sinceMs: NOW - 5_000 }, startedAtMs: NOW - 5_000, ...extra });
const chatItem = (sessionId, state, extra = {}) => ({ source_kind: 'linked_chat_turn', operation_id: `op_${sessionId}`, session_id: sessionId, state,
  title: `Chat ${sessionId}`, started_at: new Date(NOW - 60_000).toISOString(), finished_at: null, ...extra });
const testItem = (id, state, extra = {}) => ({ source_kind: 'workspace_test', operation_id: id, session_id: 's1', state,
  started_at: new Date(NOW - 50_000).toISOString(), finished_at: null, ...extra });
/* One delegation (tool call "call-1") with one running helper, as the chat's live steps hold it. */
const helperStep = (extra = {}) => ({ toolCallId: 'call-1', childTaskId: 'task-1', childLabel: 'Scan the docs', status: 'running', source: 'delegate',
  startedAt: NOW - 40_000, updatedAt: NOW - 1_000, ...extra });
const withHelpers = (...steps) => [{ role: 'assistant', content: '', agent_status_steps: steps }];

function harness({ jobs = [], items = [], messages = [], openHelper = async () => true, signals = [] } = {}) {
  const dom = new JSDOM('<body><div id="artifactReviewPanel" class="artifact-review-panel"><div id="host"></div></div></body>', { pretendToBeVisual: true });
  const win = dom.window;
  const panelEl = win.document.getElementById('artifactReviewPanel');
  const state = { currentSessionId: 's1', ui: { artifactReview: { mode: 'artifact', enabled: false } } };
  const calls = { openHelper: [], clear: [] };
  let jobsPush = null;
  let current = { jobs, items, messages };
  win.jennyShell = {
    backgroundJobs: {
      getState: async () => ({ jobs: current.jobs }),
      onChanged: (fn) => { jobsPush = fn; return () => {}; },
      clearFinished: async (sessionId) => { calls.clear.push(sessionId); return { ok: true, cleared: 1, jobIds: ['dddddddddddd'] }; },
      restoreFinished: async () => ({ ok: true, restored: 1 }),
    },
    chatWorkspace: { getSummary: async (request) => ({ ok: true, summary: { session_id: request.session_id, background_tasks: { state: 'available', data: { items: current.items } } } }) },
  };
  const surface = { previewContent: win.document.getElementById('host') };
  let panel = null;
  panel = owner.createBackgroundTasksPanel({
    state, windowRef: win, dom: { artifactReviewPanel: panelEl },
    openArtifactRail: (mode) => Object.assign(state.ui.artifactReview, { mode, enabled: true }),
    renderArtifactReviewPanel: () => { if (state.ui.artifactReview.mode === 'background_tasks' && state.ui.artifactReview.enabled) panel.renderRailContent(surface); },
    toggleArtifactReview: () => { state.ui.artifactReview.enabled = false; },
    claimOwner: () => {}, getPanelSessionId: () => state.currentSessionId, openSession: () => {},
    getMessages: () => current.messages,
    openHelper: (request) => { calls.openHelper.push(request); return openHelper(request); },
    onSignalsChanged: () => signals.push([panel.runningCount(), panel.runningRows().map((row) => row.id)]),
    setTimeoutImpl: () => 0, clearTimeoutImpl: () => {}, setIntervalImpl: () => 0, clearIntervalImpl: () => {}, now: () => NOW,
  });
  panel.bind();
  const $ = (selector) => panelEl.querySelector(selector);
  const ids = () => [...panelEl.querySelectorAll('[data-bgt-open]')].map((node) => node.getAttribute('data-bgt-open'));
  return { win, doc: win.document, panelEl, state, calls, panel, surface, $, ids,
    set: (next) => { current = { ...current, ...next }; },
    push: (nextJobs) => { current.jobs = nextJobs; jobsPush?.({ jobs: nextJobs }); },
    close: () => { panel.dispose(); win.close(); } };
}

const FEED = { jobs: [server('aaaaaaaaaaaa'), job('bbbbbbbbbbbb', 'running', { startedAtMs: NOW - 20_000 })], messages: withHelpers(helperStep()) };

test('Runs: a server, a command and a helper are one list, in that order, and Helpers leaves only the helper', async () => {
  const h = harness(FEED);
  await h.panel.open({ sessionId: 's1' });
  assert.deepEqual(h.ids().map((id) => id.split(':')[0]), ['job', 'job', 'helper']);
  assert.deepEqual(h.ids().slice(0, 2), ['job:aaaaaaaaaaaa', 'job:bbbbbbbbbbbb']);
  const row = h.$('[data-bgt-open^="helper:"]');
  assert.equal(row.querySelector('.session-rail-ellip').textContent, 'Helper: Scan the docs');
  assert.match(row.querySelector('.status-dot').className, /status-dot--active session-rail-dot-pulse/, 'running dot while it runs');
  assert.equal(row.querySelector('.session-rail-meta').textContent, 'Running', 'its short status is the second signal');
  h.$('[data-value="helpers"]').click();
  assert.deepEqual(h.ids().map((id) => id.split(':')[0]), ['helper']);
  h.close();
});

test('Runs: the filter options, Tests only with a test run, linked chats under All only, and what an empty filter says', async () => {
  const none = harness({ jobs: [], items: [chatItem('kid', 'running')] });
  await none.panel.open({ sessionId: 's1' });
  const options = () => [...none.panelEl.querySelectorAll('[data-action="bgt-filter"] [data-value]')].map((node) => node.getAttribute('data-value'));
  assert.deepEqual(options(), ['all', 'servers', 'commands', 'helpers'], 'no Tests option without a test run');
  assert.deepEqual(none.ids(), ['chat:kid']);
  none.$('[data-value="helpers"]').click();
  assert.equal(none.$('.background-tasks-empty').textContent, 'No helpers yet. Jenny starts one when a job is big enough to split.');
  none.$('[data-value="commands"]').click();
  assert.deepEqual(none.ids(), [], 'a linked chat is not a command');
  none.close();

  const tests = harness({ items: [testItem('t1', 'running')] });
  await tests.panel.open({ sessionId: 's1' });
  assert.deepEqual([...tests.panelEl.querySelectorAll('[data-action="bgt-filter"] [data-value]')].map((node) => node.getAttribute('data-value')), ['all', 'servers', 'commands', 'helpers', 'tests']);
  tests.$('[data-value="tests"]').click();
  assert.deepEqual(tests.ids(), ['test:t1']);
  assert.equal(tests.$('[data-bgt-open="test:t1"] .session-rail-ellip').textContent, 'Test run');
  tests.close();
});

test('Runs: runningCount() and runningRows() cover every kind, are readable while closed, and tell the module that listens', async () => {
  const signals = [];
  const h = harness({ ...FEED, items: [chatItem('kid', 'running')], signals });
  await flush();
  assert.equal(h.panel.isOpen(), false);
  assert.deepEqual(h.panel.runningRows().map((row) => [row.kind, row.canStop]), [['server', true], ['command', true], ['helper', false]], 'jobs and helpers are held without opening');
  assert.equal(h.panel.runningCount(), 3);
  assert.deepEqual(Object.keys(h.panel.runningRows()[0]).sort(), ['canStop', 'detail', 'id', 'kind', 'label', 'startedAt']);
  const helper = h.panel.runningRows()[2];
  assert.equal(helper.label, 'Helper: Scan the docs');
  assert.equal(helper.startedAt, NOW - 40_000);
  signals.length = 0;
  h.push([FEED.jobs[0]]);
  assert.deepEqual(signals.at(-1), [2, ['job:aaaaaaaaaaaa', 'helper:call-1:task-1']], 'a push while closed is announced');
  h.set({ messages: withHelpers(helperStep({ status: 'completed', childTerminal: true })) });
  h.panel.refreshHelpers();
  assert.equal(h.panel.runningCount(), 1);
  assert.deepEqual(signals.at(-1), [1, ['job:aaaaaaaaaaaa']]);
  const before = signals.length;
  h.panel.refreshHelpers();
  assert.equal(signals.length, before, 'no change, no signal');
  await h.panel.open({ sessionId: 's1' });
  assert.equal(h.panel.runningCount(), 2, 'the linked chat counts once its summary is read');
  assert.deepEqual(h.panel.runningRows().map((row) => row.kind), ['server', 'linked']);
  h.state.currentSessionId = '';
  assert.equal(h.panel.runningCount(), 0, 'unbound: nothing');
  assert.deepEqual(h.panel.runningRows(), []);
  h.close();
});

test('Runs: a helper row opens that helper through the monitor; an unreachable one stays on the list', async () => {
  const h = harness(FEED);
  await h.panel.open({ sessionId: 's1' });
  h.$('[data-bgt-open="helper:call-1:task-1"]').click();
  await flush();
  assert.deepEqual(h.calls.openHelper.map(({ sessionId, key, childKey }) => [sessionId, key, childKey]), [['s1', 'call-1', 'task-1']]);
  h.close();
  const refused = harness({ ...FEED, openHelper: async () => false });
  await refused.panel.open({ sessionId: 's1' });
  refused.$('[data-bgt-open="helper:call-1:task-1"]').click();
  await flush();
  assert.ok(refused.$('.background-tasks-list'), 'still on the list');
  refused.close();
});

test('Runs: openRun(id) opens the tab on that run, and open() with focusTaskId lands on its row whatever the filter was', async () => {
  const h = harness(FEED);
  assert.equal(await h.panel.openRun('job:bbbbbbbbbbbb', { sessionId: 's1' }), true);
  assert.ok(h.$('[data-bgt-detail="job:bbbbbbbbbbbb"]'), 'a command opens its page');
  assert.match(h.panel.titleHtml(), /<span>Runs<\/span>/, 'its one header row holds the back control, relabelled Runs');
  assert.match(h.panel.titleHtml(), /aria-label="Back to Runs"/);
  await h.panel.open({ sessionId: 's1' });
  h.$('[data-value="servers"]').click();
  await h.panel.open({ sessionId: 's1', focusTaskId: 'helper:call-1:task-1' });
  assert.equal(h.$('[aria-checked="true"]').textContent, 'All', 'the filter that hides the row is dropped');
  assert.equal(h.doc.activeElement, h.$('[data-bgt-open="helper:call-1:task-1"]'));
  h.close();
});

test('Runs: a finished helper sits in the fold with its status, is not cleared by Clear, and a failed one has the error dot', async () => {
  const h = harness({ jobs: [job('dddddddddddd', 'completed', { exitCode: 0, endedAtMs: NOW - 60_000 })],
    messages: withHelpers(helperStep({ status: 'completed', childTerminal: true }), helperStep({ childTaskId: 'task-2', childLabel: 'Check links', status: 'failed', childTerminal: true })) });
  await h.panel.open({ sessionId: 's1' });
  assert.equal(h.$('.session-rail-divider-text').textContent, '3 finished');
  assert.equal(h.$('[data-bgt-open="helper:call-1:task-1"] .session-rail-meta').textContent, 'Completed');
  assert.match(h.$('[data-bgt-open="helper:call-1:task-2"] .status-dot').className, /status-dot--error/);
  assert.equal(h.$('[data-bgt-open="helper:call-1:task-1"] .status-dot'), null);
  assert.equal(h.panel.runningCount(), 0);
  h.close();
});

test('Runs: helper names are text, never markup', async () => {
  const h = harness({ messages: withHelpers(helperStep({ childLabel: '<img src=x onerror=alert(1)>' })) });
  await h.panel.open({ sessionId: 's1' });
  assert.equal(h.$('[data-bgt-open^="helper:"] img'), null);
  assert.ok(h.panelEl.textContent.includes('Helper: <img src=x onerror=alert(1)>'));
  h.close();
});

test('render: buildTasks puts helpers beside commands and leaves a message-less chat alone', () => {
  const tasks = rr.buildTasks({ jobs: [job('aaaaaaaaaaaa', 'running')], sessionId: 's1', helpers: [{ id: 'helper:c:k', delegationKey: 'c', childKey: 'k', label: 'x', live: true, failed: false, statusLabel: 'Running', startedAtMs: NOW - 1, endedAtMs: 0 }] });
  assert.deepEqual(tasks.map((task) => task.kind), ['helper', 'command']);
  assert.deepEqual(rr.buildTasks({ jobs: [], sessionId: 's1' }), []);
});

test('Runs: Clear says what it clears, and its Undo line goes when another run finishes', async () => {
  const done = job('dddddddddddd', 'completed', { exitCode: 0, endedAtMs: NOW - 60_000 });
  const h = harness({ jobs: [job('aaaaaaaaaaaa', 'running'), done] });
  await h.panel.open({ sessionId: 's1' });
  assert.equal(h.$('[data-bgt-clear]').title, 'Clear finished runs from this list. You can undo it.');
  h.$('[data-bgt-clear]').click();
  await flush();
  assert.equal(h.$('.background-tasks-undo span').textContent, '1 finished run cleared from this list.');
  h.push([job('aaaaaaaaaaaa', 'completed', { exitCode: 0, endedAtMs: NOW })]);
  assert.equal(h.$('.background-tasks-undo'), null, 'a run finished: the line goes');
  h.close();
});

/* Row 197 R3a: the Live tab's program is one more row, opened in the Live tab and never stopped from here. */
const liveItem = (state, runState, extra = {}) => ({ source_kind: 'live_run', operation_id: 'live:p1', session_id: 's1', project_id: 'p1', state, run_state: runState,
  title: 'game.exe', started_at: new Date(NOW - 30_000).toISOString(), finished_at: null, exit_code: null, output_ref: null, ...extra });

test('render: buildTasks makes a live task from a live_run item and ignores one without a project', () => {
  const [task] = rr.buildTasks({ items: [liveItem('running', 'minimized')], sessionId: 's1' });
  assert.deepEqual([task.id, task.kind, task.projectId, task.runState, task.text, task.live, task.running, task.phase],
    ['live:p1', 'live', 'p1', 'minimized', 'game.exe', true, true, 'running']);
  assert.equal(task.startedAtMs, NOW - 30_000);
  assert.equal(rr.buildTasks({ items: [liveItem('running', 'running', { project_id: ' ' })], sessionId: 's1' }).length, 0);
  assert.equal(rr.buildTasks({ items: [liveItem('running', 'running', { title: '' })], sessionId: 's1' })[0].text, 'Live tab program');
});

test('Runs: a live row says its state in words, has no Stop, shows under All only, and opens the Live tab', async () => {
  const h = harness({ items: [liveItem('running', 'building')] });
  const opened = [];
  h.win.rendererLiveRunView = { open: () => { opened.push('open'); return true; } };
  await h.panel.open({ sessionId: 's1' });
  const row = h.$('[data-bgt-open="live:p1"]');
  assert.equal(row.querySelector('.session-rail-ellip').textContent, 'game.exe');
  assert.equal(row.querySelector('.session-rail-meta').textContent, 'Building');
  assert.equal(row.title, 'Opens the Live tab.');
  assert.match(row.querySelector('.status-dot').className, /status-dot--active/);
  assert.equal(h.$('[data-bgt-stop]'), null, 'no Stop button for the live run');
  assert.equal(row.disabled, false);
  for (const value of ['servers', 'commands', 'helpers']) {
    h.$(`[data-value="${value}"]`).click();
    assert.equal(h.$('[data-bgt-open="live:p1"]'), null, `${value} does not list it`);
  }
  h.$('[data-value="all"]').click();
  h.$('[data-bgt-open="live:p1"]').click();
  await flush();
  assert.deepEqual(opened, ['open']);
  assert.ok(h.$('.background-tasks-list'), 'stays on the list');
  assert.equal(h.$('[data-bgt-detail]'), null, 'opens no detail page');
  h.close();
});

test('correctness review 6: the Session tab opens a live run straight in the Live tab, without the Runs list first', async () => {
  const h = harness({ items: [liveItem('running', 'running')] });
  const opened = [];
  h.win.rendererLiveRunView = { open: () => { opened.push('open'); return true; } };
  assert.equal(await h.panel.openRun('live:p1', { sessionId: 's1' }), true);
  assert.deepEqual(opened, ['open']);
  assert.equal(h.panel.isOpen(), false, 'the Runs tab was not opened on the way');
  h.close();
});

test('Runs: a live row has a word for every run state, and an early end carries its exit code', () => {
  const words = { building: 'Building', starting: 'Starting', no_window: 'No window yet', running: 'Running', minimized: 'Minimized', stopping: 'Stopping',
    close_refused: 'Waiting to close', build_failed: 'Build failed', ended_early: 'Ended early', closed: 'Closed' };
  for (const [state, word] of Object.entries(words)) {
    const phase = ['build_failed', 'ended_early'].includes(state) ? 'failed' : state === 'closed' ? 'completed' : 'running';
    const [task] = rr.buildTasks({ items: [liveItem(phase, state)], sessionId: 's1' });
    assert.equal(rr.factHtml ? rr.factHtml(task) : '', word, state);
  }
  const [early] = rr.buildTasks({ items: [liveItem('failed', 'ended_early', { exit_code: 3 })], sessionId: 's1' });
  assert.equal(rr.factHtml(early), 'Ended early · exit 3');
  assert.equal(early.live, false);
});

test('Runs: runningRows() lists the live run while it runs and not once it is closed', async () => {
  const h = harness({ items: [liveItem('running', 'running')] });
  await h.panel.open({ sessionId: 's1' });
  assert.deepEqual(h.panel.runningRows().map((row) => [row.id, row.kind, row.label, row.detail, row.canStop]), [['live:p1', 'live', 'game.exe', 'Running', false]]);
  assert.equal(h.panel.runningCount(), 1);
  h.set({ items: [liveItem('completed', 'closed', { finished_at: new Date(NOW).toISOString() })] });
  await h.panel.open({ sessionId: 's1' });
  assert.deepEqual(h.panel.runningRows(), []);
  assert.equal(h.panel.runningCount(), 0);
  assert.equal(h.$('[data-bgt-open="live:p1"] .session-rail-meta').textContent, 'Closed', 'it rests in the finished fold');
  h.close();
});
