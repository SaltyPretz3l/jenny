'use strict';
// new-test-file: the Live tab's run as a summary source (row 197 R3a); chat-workspace-service.test.js is at its 600-line ceiling

/* The Live tab's run (`live_run`) in the chat workspace summary's Background tasks: the run state to bucket
   mapping, the closed item shape, the project filter, a failed or missing holder, dedupe, sort and cap. The run
   holder is a fake with the one method the service reads (`runsForChat`). */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ChatWorkspaceService } = require('../services/chat-workspace-service');
const { MAX_TASK_ITEMS, buildBackgroundTasksSection } = require('../services/chat-workspace-summary-sections');
const {
  SESSION,
  authorityOf,
  fakeChanges,
  fakeStore,
  fakeViewStore,
  makeClock,
  req,
} = require('./helpers/chat-workspace-fixtures');

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
const T1 = Date.parse('2026-10-15T10:05:00.000Z');

const run = (projectId, state, extra = {}) => ({
  projectId, chatId: SESSION, state, generation: 1, exitCode: null, startedAtMs: T0, endedAtMs: 0, label: 'game.exe', ...extra,
});

function build({ runView, authority = authorityOf(), jobs = null } = {}) {
  const logs = [];
  const service = new ChatWorkspaceService({
    viewStore: fakeViewStore(),
    getStore: () => fakeStore(),
    captureAuthority: () => authority,
    resolveGitService: () => ({}),
    getRunView: () => runView,
    getBackgroundJobTracker: () => (jobs ? { getSessionJobs: () => jobs } : null),
    changeSummary: fakeChanges(),
    log: (level, event, details) => logs.push([level, event, details]),
    now: makeClock().now,
    notifierOptions: { intervalMs: 0 },
  });
  return { service, logs };
}

const tasksOf = async (service) => (await service.getSummary(req())).summary.background_tasks;

test('live runs: each run state maps to the token the Runs list reads, with the closed item shape', () => {
  const rows = [
    run('p_run', 'running'),
    run('p_fail', 'build_failed', { exitCode: 2, endedAtMs: T1, label: '' }),
    run('p_done', 'closed', { endedAtMs: T1 }),
    run('p_idle', 'idle', { startedAtMs: 0 }),
    run('p_early', 'ended_early', { exitCode: 3, endedAtMs: T1 }),
    run('p_unknown', 'something_new'),
  ];
  const section = buildBackgroundTasksSection({
    sampledAt: 's', sessionId: SESSION, rows: [], workspaceTestSupported: true, linkedRows: [], jobRows: [], liveRows: rows,
  });
  assert.equal(section.data.coverage, 'complete');
  assert.deepEqual(section.data.unsupported_sources, []);
  assert.deepEqual(section.data.counts, { active: 1, waiting: 0, failed: 2, completed: 1 });
  const byId = Object.fromEntries(section.data.items.map((item) => [item.operation_id, item]));
  assert.deepEqual(Object.keys(byId).sort(), ['live:p_done', 'live:p_early', 'live:p_fail', 'live:p_run'], 'idle and unknown states are skipped');
  assert.deepEqual(byId['live:p_run'], {
    source_kind: 'live_run', operation_id: 'live:p_run', session_id: SESSION, project_id: 'p_run', state: 'running', run_state: 'running',
    title: 'game.exe', started_at: '2026-10-15T10:00:00.000Z', finished_at: null, exit_code: null, output_ref: null,
  });
  assert.deepEqual(byId['live:p_fail'], {
    source_kind: 'live_run', operation_id: 'live:p_fail', session_id: SESSION, project_id: 'p_fail', state: 'failed', run_state: 'build_failed',
    title: '', started_at: '2026-10-15T10:00:00.000Z', finished_at: '2026-10-15T10:05:00.000Z', exit_code: 2, output_ref: null,
  });
  assert.deepEqual([byId['live:p_done'].state, byId['live:p_done'].run_state], ['completed', 'closed']);
  assert.deepEqual([byId['live:p_early'].state, byId['live:p_early'].exit_code], ['failed', 3]);
  assert.equal(section.data.items[0].operation_id, 'live:p_run', 'the live run sorts before the settled ones');
});

test('live runs: every live state is running, a title is bounded text, and a missing time is null', () => {
  const states = ['building', 'starting', 'no_window', 'running', 'minimized', 'stopping', 'close_refused'];
  const rows = states.map((state) => run(`p_${state}`, state, { startedAtMs: 0, label: 'a‮b\u0007c' }));
  const section = buildBackgroundTasksSection({
    sampledAt: 's', sessionId: SESSION, rows: [], workspaceTestSupported: true, linkedRows: [], jobRows: [], liveRows: rows,
  });
  assert.equal(section.data.items.length, states.length);
  assert.deepEqual([...new Set(section.data.items.map((item) => item.state))], ['running']);
  assert.deepEqual(section.data.items.map((item) => item.run_state).sort(), [...states].sort());
  assert.deepEqual([section.data.items[0].title, section.data.items[0].started_at], ['abc', null]);
});

test('live runs: a composition without the Live tab lists none and never reads as partial', async () => {
  for (const runView of [null, {}, { runsForChat: () => null }, { runsForChat: () => [] }]) {
    const tasks = await tasksOf(build({ runView }).service);
    assert.equal(tasks.data.unsupported_sources.includes('live_run'), false, JSON.stringify(runView));
    assert.deepEqual(tasks.data.items.filter((item) => item.source_kind === 'live_run'), []);
  }
});

test('live runs: the service asks for this chat, keeps only this project, and no authority means no rows', async () => {
  const asked = [];
  const runView = {
    runsForChat: (id) => { asked.push(id); return [run('project_other', 'running'), run('project_a', 'running'), run('project_a', 'closed', { endedAtMs: T1 })]; },
  };
  const tasks = await tasksOf(build({ runView }).service);
  assert.deepEqual(asked, [SESSION]);
  assert.deepEqual(tasks.data.items.filter((item) => item.source_kind === 'live_run').map((item) => [item.operation_id, item.run_state]),
    [['live:project_a', 'running']], 'a run of another project is dropped and the newest row of a project wins');
  const noAuthority = await tasksOf(build({ runView, authority: null }).service);
  assert.deepEqual(noAuthority.data.items.filter((item) => item.source_kind === 'live_run'), []);
  assert.equal(noAuthority.data.unsupported_sources.includes('live_run'), false);
});

test('live runs: a throwing read is a failed source and the other sources still list', async () => {
  const jobs = [{
    jobId: 'aaaaaaaaaaa1', sessionId: SESSION, command: 'npm run dev', state: 'running', exitCode: null, stopRequested: false, startedAtMs: 1_000, endedAtMs: 0,
  }];
  const failing = build({ runView: { runsForChat: () => { throw new Error('boom'); } }, jobs });
  const tasks = await tasksOf(failing.service);
  assert.equal(tasks.state, 'stale');
  assert.deepEqual(tasks.data.failed_sources, ['live_run']);
  assert.equal(tasks.data.unsupported_sources.includes('live_run'), false, 'a failed read is stale, not unsupported');
  assert.deepEqual(tasks.data.items.map((item) => item.operation_id), ['job:aaaaaaaaaaa1']);
  assert.equal(JSON.stringify(failing.logs).includes('boom'), false, 'logs carry no error text');
});

test('live runs: the run is deduplicated, capped with the other items and sorted live first', () => {
  const rows = Array.from({ length: 35 }, (_, i) => ({ runId: `r${i}`, state: 'finished', result: { status: 'passed' }, finishedAt: '2026-10-15T09:00:00.000Z', updatedAt: '2026-10-15T09:00:00.000Z' }));
  const section = buildBackgroundTasksSection({
    sampledAt: 's', sessionId: SESSION, rows, workspaceTestSupported: true, linkedRows: [], jobRows: [],
    liveRows: [run('p_a', 'running'), run('p_a', 'closed', { endedAtMs: T1 })],
  });
  assert.equal(MAX_TASK_ITEMS, 30);
  assert.equal(section.data.items.length, 30);
  assert.equal(section.data.items[0].operation_id, 'live:p_a');
  assert.equal(section.data.items[0].run_state, 'running', 'the first row of a project wins');
  assert.equal(section.data.counts.active, 1);
  assert.equal(section.data.counts.completed, 35);
});
