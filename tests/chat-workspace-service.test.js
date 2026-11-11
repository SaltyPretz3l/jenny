'use strict';

/* ChatWorkspaceService (row 59 checkpoint 2): the closed request schemas, the
 * per-section summary facts and their honest states, setView revision handling,
 * the getChangeDiff request boundary. The persistence store and Git reads are
 * fakes here; invalidation sources and the real C1 store round trip live in
 * chat-workspace-invalidation.test.js and the real-git boundary in
 * workspace-git-change-summary.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  collectOutputs,
  buildBackgroundTasksSection,
} = require('../services/chat-workspace-summary-sections');
const { CHATWS_ERROR_CODES } = require('../services/backend/error-codes');
const { ChatWorkspaceService } = require('../services/chat-workspace-service');
const {
  OTHER,
  ROOT,
  SESSION,
  artifact,
  authorityOf,
  fakeChanges,
  fakeStore,
  fakeViewStore,
  makeClock,
  makeService,
  req,
} = require('./helpers/chat-workspace-fixtures');

test('request schemas are closed: unknown keys, wrong versions and malformed ids fail with the common envelope', async () => {
  const { service } = makeService();
  const bad = [
    null, 'x', [], {},
    { session_id: SESSION },
    { schema_version: 2, session_id: SESSION },
    { schema_version: '1', session_id: SESSION },
    { schema_version: 1, session_id: SESSION, extra: true },
    { schema_version: 1, session_id: '' },
    { schema_version: 1, session_id: '../etc' },
    { schema_version: 1, session_id: 'a'.repeat(200) },
    { schema_version: 1, session_id: 5 },
  ];
  for (const payload of bad) {
    for (const method of ['getSummary', 'listChanges']) {
      const result = await service[method](payload);
      assert.deepEqual(result, {
        schema_version: 1, ok: false, error_code: CHATWS_ERROR_CODES.INVALID_REQUEST, reason: 'invalid_request',
        retryable: false, current_revision: null,
      }, `${method} ${JSON.stringify(payload)}`);
    }
  }
  assert.equal((await service.getChangeDiff(req())).reason, 'invalid_request');
  assert.equal((await service.getChangeDiff(req({ path: '' }))).reason, 'invalid_request');
  assert.equal((await service.getChangeDiff(req({ path: 'x'.repeat(2000) }))).reason, 'invalid_request');
  assert.equal((await service.getChangeDiff(req({ path: 'a\0b' }))).reason, 'invalid_request');
  assert.equal((await service.getChangeDiff(req({ path: 'a', extra: 1 }))).reason, 'invalid_request');
  assert.equal((await service.setView(req({ expected_revision: -1, patch: {} }))).reason, 'invalid_request');
  assert.equal((await service.setView(req({ expected_revision: 1.5, patch: {} }))).reason, 'invalid_request');
  assert.equal((await service.setView(req({ expected_revision: Infinity, patch: {} }))).reason, 'invalid_request');
  assert.equal((await service.setView(req({ expected_revision: 0 }))).reason, 'invalid_request');
  assert.equal((await service.setView(req({ expected_revision: 0, patch: [] }))).reason, 'invalid_request');
});

test('an unknown session is not_found for every method', async () => {
  const { service } = makeService();
  const missing = { schema_version: 1, session_id: 'sess_missing' };
  for (const result of [
    await service.getSummary(missing),
    await service.listChanges(missing),
    await service.getChangeDiff({ ...missing, path: 'a.txt' }),
    await service.setView({ ...missing, expected_revision: 0, patch: { rail_visible: true } }),
  ]) {
    assert.deepEqual([result.ok, result.reason, result.error_code], [false, 'not_found', CHATWS_ERROR_CODES.NOT_FOUND]);
  }
});

test('getSummary carries the persisted view and revision and the five closed sections', async () => {
  const { service } = makeService({ getExecutionEnvironment: () => 'sandbox' });
  const result = await service.getSummary(req());
  assert.equal(result.ok, true);
  assert.equal(result.schema_version, 1);
  assert.equal(result.coordination_revision, 0);
  assert.deepEqual(result.workspace_view, { schema_version: 1, rail_visible: null, disclosures: {}, children_expanded: null });
  const { summary } = result;
  assert.deepEqual(Object.keys(summary).sort(), [
    'background_tasks', 'changes', 'context', 'environment', 'outputs', 'revision', 'session_id', 'session_incarnation',
  ]);
  assert.equal(summary.session_id, SESSION);
  assert.equal(summary.session_incarnation, `inc_${SESSION}`);
  assert.equal(summary.revision, 0);
  for (const name of ['environment', 'context', 'outputs', 'changes', 'background_tasks']) {
    assert.deepEqual(Object.keys(summary[name]).sort(), ['data', 'reason', 'sampled_at', 'state'], name);
  }
  assert.deepEqual(summary.environment.data, {
    project_id: 'project_a', project_name: 'Alpha', workspace_id: 'root_a', display_path: ROOT,
    branch: 'main', worktree_id: null, execution_environment: 'sandbox', run_mode: 'assist',
  });
  assert.deepEqual(summary.changes.data, {
    workspace_id: 'root_a', scope: 'working_tree', file_count: 1, additions: 2, deletions: 1, ref: 'main', head: 'abc1234',
  });
});

test('environment reports the worktree registry match, a null path for General and an unavailable project honestly', async () => {
  const worktree = path.join(os.tmpdir(), 'wt-a');
  const withWorktree = makeService({
    captureAuthority: () => authorityOf({ root_path: worktree }),
    getWorktreeEntries: () => [{ id: 'wt_1', worktree_path: worktree }, { id: 'wt_2', worktree_path: ROOT }],
  });
  assert.equal((await withWorktree.service.getSummary(req())).summary.environment.data.worktree_id, 'wt_1');

  const general = makeService({ captureAuthority: () => authorityOf({ project_id: 'project_general', root_id: null, root_path: null }) });
  const generalSummary = (await general.service.getSummary(req())).summary;
  assert.equal(generalSummary.environment.data.display_path, null);
  assert.equal(generalSummary.environment.data.workspace_id, null);
  assert.equal(generalSummary.environment.data.branch, null);
  assert.deepEqual([generalSummary.changes.state, generalSummary.changes.reason, generalSummary.changes.data], ['unavailable', 'no_workspace', null]);

  const broken = makeService({ captureAuthority: () => { const error = new Error('x'); error.reason = 'project_authority_stale'; throw error; } });
  const brokenSummary = (await broken.service.getSummary(req())).summary;
  assert.deepEqual([brokenSummary.environment.state, brokenSummary.environment.reason, brokenSummary.environment.data], ['unavailable', 'project_unavailable', null]);
  assert.equal(brokenSummary.changes.state, 'unavailable');
  assert.equal(brokenSummary.context.state, 'available'); // sections without a workspace source still report
});

test('context derives available only from comparable known counts and is unavailable without a record', async () => {
  const ok = (await makeService().service.getSummary(req())).summary.context;
  assert.equal(ok.state, 'available');
  assert.equal(ok.sampled_at, '2026-10-15T10:59:00.000Z');
  assert.deepEqual(ok.data, {
    turn_id: null, used_tokens: 4000, capacity_tokens: 8000, available_tokens: 4000, measurement: 'actual', scope: 'request',
  });
  const noWindow = makeService({ storeOptions: { summaries: { [SESSION]: { context_usage: {
    version: 1, used_tokens: 10, context_window: 0, compact_threshold_tokens: 50, usage_source: 'estimate', updated_at: 'bad',
  } } } } });
  const unknownCapacity = (await noWindow.service.getSummary(req())).summary.context;
  assert.deepEqual(unknownCapacity.data, {
    turn_id: null, used_tokens: 10, capacity_tokens: null, available_tokens: null, measurement: 'estimated', scope: 'request',
  });
  assert.equal(unknownCapacity.sampled_at, '2026-10-15T12:00:00.000Z');
  const over = makeService({ storeOptions: { summaries: { [SESSION]: { context_usage: {
    version: 1, used_tokens: 9000, context_window: 8000, usage_source: 'provider', updated_at: '',
  } } } } });
  assert.equal((await over.service.getSummary(req())).summary.context.data.available_tokens, 0);
  const none = makeService({ storeOptions: { summaries: { [SESSION]: { context_usage: null } } } });
  const absent = (await none.service.getSummary(req())).summary.context;
  assert.deepEqual([absent.state, absent.reason, absent.data], ['unavailable', 'no_usage_recorded', null]);
});

test('next-send preview is session scoped and keeps recorded usage separate', async () => {
  const calls = [];
  const preview = { status: 'estimated', used_tokens: 120, capacity_tokens: 8000,
    available_tokens: 7880, breakdown: { messages: 0, system_prompt: 120, tools: 0, instructions: 0, skills: 0, other: 0 } };
  const { service, store } = makeService({ getContextPreview: async (id) => { calls.push(id); return preview; } });
  const context = (await service.getSummary(req())).summary.context;
  assert.equal(context.state, 'available');
  assert.deepEqual(context.data, { ...preview, scope: 'next_send', measurement: 'estimated' });
  assert.equal(store.getSessionSummary(SESSION).context_usage.used_tokens, 4000);
  assert.deepEqual(calls, [SESSION]);
});

test('a slow preview never holds the summary: checking, then the last estimate stale, then a re-notify', async () => {
  const estimate = (used) => ({ status: 'estimated', used_tokens: used, capacity_tokens: 8000, available_tokens: 8000 - used,
    breakdown: { messages: 0, system_prompt: used, tools: 0, instructions: 0, skills: 0, other: 0 } });
  const releases = [];
  let fast = false;
  const { service, events } = makeService({
    previewBudgetMs: 20,
    getContextPreview: () => (fast ? estimate(100) : new Promise((resolve) => releases.push(resolve))),
  });
  const pending = (await service.getSummary(req())).summary.context;
  assert.equal(pending.state, 'checking', 'nothing estimated yet');
  assert.equal(pending.reason, 'preview_pending');
  assert.ok((await service.getSummary(req())).summary.environment, 'the other sections still answer');
  releases.splice(0).forEach((resolve) => resolve(estimate(120)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1, 'a changed late estimate re-notifies once');
  const stale = (await service.getSummary(req())).summary.context;
  assert.equal(stale.state, 'stale');
  assert.equal(stale.data.used_tokens, 120);
  assert.equal('stale' in stale.data, false);
  releases.splice(0).forEach((resolve) => resolve(estimate(120)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1, 'an unchanged late estimate stays quiet');
  fast = true;
  const live = (await service.getSummary(req())).summary.context;
  assert.deepEqual([live.state, live.data.used_tokens], ['available', 100]);
});

test('background task read failures stay distinct from successful empty sources', async () => {
  let failed = false;
  const testSource = { getActivityRuns: () => { if (failed) throw new Error('read failed'); return []; } };
  const { service } = makeService({ activityEnabled: true, testSource });
  const empty = (await service.getSummary(req())).summary.background_tasks;
  assert.equal(empty.state, 'available');
  assert.deepEqual(empty.data.items, []);
  assert.ok(!empty.data.unsupported_sources.includes('workspace_test'));
  failed = true;
  const unavailable = (await service.getSummary(req())).summary.background_tasks;
  assert.equal(unavailable.reason, 'source_read_failed');
  assert.deepEqual(unavailable.data.failed_sources, ['workspace_test']);
});

test('outputs list the ten newest distinct artifacts, count them all, and do not rescan for the same key', async () => {
  const messages = [];
  for (let i = 1; i <= 12; i += 1) {
    messages.push({ role: 'tool', tool_result: { generated_artifacts: [artifact(`a${i}`, `Doc ${i}`, i === 12 ? 'missing' : 'available')] } });
  }
  messages.push({ role: 'tool', tool_result: { generated_artifacts: [artifact('a1', 'Doc 1 again')] } }); // dedupe by id (newest wins)
  messages.push({ role: 'user', content: 'no artifacts here' });
  messages.push({ role: 'tool', tool_result: { generated_artifacts: [{ artifact_id: 'bad' }, null, 'x'] } });
  const { service, store } = makeService({ storeOptions: { messages } });
  const first = (await service.getSummary(req())).summary.outputs;
  assert.equal(first.state, 'available');
  assert.equal(first.data.total_count, 12);
  assert.equal(first.data.next_cursor, null);
  assert.equal(first.data.items.length, 10);
  assert.deepEqual(first.data.items[0], { artifact_id: 'a1', display_name: 'Doc 1 again', kind: 'document', availability: 'available' });
  assert.deepEqual(first.data.items[1], { artifact_id: 'a12', display_name: 'Doc 12', kind: 'document', availability: 'missing' });
  await service.getSummary(req());
  await service.getSummary(req());
  assert.equal(store.peeks.count, 1, 'same updated_at/message_count never rescans the transcript');
  assert.deepEqual(Object.keys(first.data.items[0]).sort(), ['artifact_id', 'availability', 'display_name', 'kind']);
});

test('collectOutputs strips unsafe labels and tolerates non-array input', () => {
  assert.deepEqual(collectOutputs(null), { items: [], total_count: 0 });
  const result = collectOutputs([{ tool_result: { generated_artifacts: [artifact('x', 'Name\u202e\u0007 ok')] } }]);
  assert.equal(result.items[0].display_name, 'Name ok');
});

test('changes states pass through: not applicable, unavailable, stale and the some-files-unmeasured note', async () => {
  const notRepo = makeService({ changes: fakeChanges({ list: () => ({ state: 'not_applicable', reason: 'not_a_git_repository', sampled_at: 'x', data: null }) }) });
  const nr = (await notRepo.service.getSummary(req())).summary;
  assert.deepEqual([nr.changes.state, nr.changes.reason, nr.changes.data], ['not_applicable', 'not_a_git_repository', null]);
  assert.equal(nr.environment.data.branch, null);

  const off = makeService({ changes: fakeChanges({ list: () => ({ state: 'unavailable', reason: 'feature_disabled', sampled_at: 'x', data: null }) }) });
  const o = (await off.service.getSummary(req())).summary.changes;
  assert.deepEqual([o.state, o.reason, o.data], ['unavailable', 'feature_disabled', null]);

  const partial = makeService({ changes: fakeChanges({ list: () => ({
    state: 'available', reason: 'some_files_unmeasured', sampled_at: '2026-10-15T12:00:00.000Z',
    data: { workspace_id: 'root_a', scope: 'working_tree', ref: 'main', head: null, branch: 'main', files: [], file_count: 3, additions: null, deletions: null, truncated: false },
  }) }) });
  const p = (await partial.service.getSummary(req())).summary.changes;
  assert.equal(p.state, 'available');
  assert.equal(p.reason, 'some_files_unmeasured');
  assert.equal(p.data.additions, null);
  assert.equal(p.data.file_count, 3);
});

test('a failed refresh after a good read reports stale data with its original timestamp; disabled never goes stale', async () => {
  let call = 0;
  const changes = fakeChanges({ list: () => {
    call += 1;
    if (call === 1) {
      return { state: 'available', reason: null, sampled_at: '2026-10-15T12:00:00.000Z', data: { workspace_id: 'root_a', scope: 'working_tree', ref: 'main', head: 'h', branch: 'main', files: [], file_count: 4, additions: 1, deletions: 0, truncated: false } };
    }
    return { state: 'unavailable', reason: call === 2 ? 'git_failed' : 'feature_disabled', sampled_at: 'later', data: null };
  } });
  const { service, clock } = makeService({ changes });
  assert.equal((await service.getSummary(req())).summary.changes.state, 'available');
  clock.advance(5000);
  const stale = (await service.getSummary(req())).summary.changes;
  assert.deepEqual([stale.state, stale.reason, stale.sampled_at, stale.data.file_count], ['stale', 'git_failed', '2026-10-15T12:00:00.000Z', 4]);
  clock.advance(5000);
  const disabled = (await service.getSummary(req())).summary.changes;
  assert.deepEqual([disabled.state, disabled.reason, disabled.data], ['unavailable', 'feature_disabled', null]);
});

test('a slow Git read reports checking, then invalidates the session when it lands', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const changes = fakeChanges({ list: async () => {
    await gate;
    return { state: 'available', reason: null, sampled_at: '2026-10-15T12:00:00.000Z', data: { workspace_id: 'root_a', scope: 'working_tree', ref: 'main', head: 'h', branch: 'main', files: [], file_count: 0, additions: 0, deletions: 0, truncated: false } };
  } });
  const { service, events } = makeService({ changes, changesBudgetMs: 10 });
  const summary = (await service.getSummary(req())).summary;
  assert.deepEqual([summary.changes.state, summary.changes.reason, summary.changes.data], ['checking', 'sampling', null]);
  assert.equal(summary.environment.data.branch, null);
  assert.equal(events.length, 0);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ schema_version: 1, session_id: SESSION, revision: 0 }]);
  const warm = (await service.getSummary(req())).summary.changes;
  assert.equal(warm.state, 'available');
  assert.equal(changes.calls.list, 1, 'the warm cache serves the refetch');
});

test('background tasks: unsupported sources keep counts unknown; supported rows count, dedupe and cap', async () => {
  const off = (await makeService().service.getSummary(req())).summary.background_tasks;
  assert.equal(off.state, 'available');
  assert.equal(off.reason, 'partial_coverage');
  assert.deepEqual(off.data, {
    scope: 'session_and_direct_children',
    counts: { active: null, waiting: null, failed: null, completed: null },
    coverage: 'partial',
    unsupported_sources: ['workspace_test', 'session_runtime', 'linked_chat_turn', 'background_job'],
    items: [],
  });

  const rows = [
    { runId: 'r1', state: 'running', startedAt: '2026-10-15T11:59:00.000Z', finishedAt: null, updatedAt: '2026-10-15T11:59:00.000Z', scope: { session_id: SESSION, project_id: 'project_a' }, outputAvailable: false },
    { runId: 'r1', state: 'running', startedAt: '2026-10-15T11:59:00.000Z', finishedAt: null, updatedAt: '2026-10-15T11:59:00.000Z', scope: { session_id: SESSION, project_id: 'project_a' } },
    { runId: 'r2', state: 'finished', result: { status: 'failed' }, startedAt: '2026-10-15T10:00:00.000Z', finishedAt: '2026-10-15T10:05:00.000Z', updatedAt: '2026-10-15T10:05:00.000Z', scope: { session_id: SESSION, project_id: 'project_a' }, outputAvailable: true },
    { runId: 'r3', state: 'finished', result: { status: 'passed' }, finishedAt: '2026-10-15T09:00:00.000Z', updatedAt: '2026-10-15T09:00:00.000Z', scope: { session_id: SESSION, project_id: 'project_a' } },
    { runId: 'r4', state: 'running', scope: { session_id: OTHER, project_id: 'project_a' } },
    { runId: 'r5', state: 'running', scope: { session_id: SESSION, project_id: 'project_other' } },
  ];
  const testSource = { getActivityRuns: () => rows, subscribeActivity: () => () => {} };
  const on = (await makeService({ activityEnabled: true, testSource }).service.getSummary(req())).summary.background_tasks;
  assert.equal(on.data.coverage, 'partial');
  assert.deepEqual(on.data.unsupported_sources, ['session_runtime', 'linked_chat_turn', 'background_job']);
  assert.deepEqual(on.data.counts, { active: 1, waiting: null, failed: 1, completed: 1 });
  assert.deepEqual(on.data.items.map((item) => item.operation_id), ['r1', 'r2', 'r3']);
  assert.deepEqual(on.data.items[1], {
    source_kind: 'workspace_test', operation_id: 'r2', session_id: SESSION, state: 'finished',
    started_at: '2026-10-15T10:00:00.000Z', finished_at: '2026-10-15T10:05:00.000Z', output_ref: 'test:r2',
  });
});

test('background task items are capped at thirty and complete coverage is possible only with every source', () => {
  const rows = Array.from({ length: 35 }, (_, i) => ({ runId: `r${i}`, state: 'running', updatedAt: '2026-10-15T00:00:00.000Z' }));
  const section = buildBackgroundTasksSection({ sampledAt: 's', sessionId: SESSION, rows, workspaceTestSupported: true });
  assert.equal(section.data.items.length, 30);
  assert.equal(section.data.counts.active, 35);
  const complete = buildBackgroundTasksSection({ sampledAt: 's', sessionId: SESSION, rows: [], workspaceTestSupported: true, sessionRuntimeSupported: true });
  assert.equal(complete.data.coverage, 'partial', 'linked_chat_turn has no source in checkpoint 2');
});

function jobSnapshot(jobId, state, extra = {}) {
  return {
    jobId, sessionId: SESSION, command: `cmd ${jobId}`, toolCallId: 'call', state, pid: 1, exitCode: null, error: '',
    startedAtMs: 1_000, endedAtMs: 0, outputTruncated: false, stopRequested: false, ...extra,
  };
}

test('background jobs become task items: live first, finished history newest first, unsupported without a tracker', () => {
  const jobRows = [
    jobSnapshot('aaaaaaaaaaa1', 'completed', { endedAtMs: 5_000, exitCode: 0 }),
    jobSnapshot('aaaaaaaaaaa2', 'running', { startedAtMs: 2_000 }),
    jobSnapshot('aaaaaaaaaaa3', 'failed', { endedAtMs: 9_000, exitCode: -1, stopRequested: true }),
    jobSnapshot('aaaaaaaaaaa4', 'killing', { startedAtMs: 3_000 }),
    jobSnapshot('aaaaaaaaaaa5', 'bogus'),
    jobSnapshot('aaaaaaaaaaa2', 'completed'),
    { state: 'running' },
  ];
  const section = buildBackgroundTasksSection({
    sampledAt: 's', sessionId: SESSION, rows: [], workspaceTestSupported: true, sessionRuntimeSupported: true, linkedRows: [], jobRows,
  });
  assert.equal(section.data.coverage, 'complete');
  assert.deepEqual(section.data.unsupported_sources, []);
  // The stopped job counts as finished, not failed: the header must not keep flagging a Stop red.
  assert.deepEqual(section.data.counts, { active: 2, waiting: 0, failed: 0, completed: 2 });
  assert.deepEqual(section.data.items.map((item) => item.job_id), ['aaaaaaaaaaa4', 'aaaaaaaaaaa2', 'aaaaaaaaaaa3', 'aaaaaaaaaaa1']);
  assert.deepEqual(section.data.items[2], {
    source_kind: 'background_job', operation_id: 'job:aaaaaaaaaaa3', session_id: SESSION, job_id: 'aaaaaaaaaaa3',
    command: 'cmd aaaaaaaaaaa3', state: 'failed', started_at_ms: 1_000, ended_at_ms: 9_000, exit_code: -1, stop_requested: true,
  });
  assert.deepEqual([section.data.items[1].ended_at_ms, section.data.items[1].exit_code, section.data.items[1].stop_requested], [null, null, false]);

  // Row 96: a running job's progress rides the item; a job without it keeps the exact original shape.
  const withProgress = buildBackgroundTasksSection({
    sampledAt: 's', sessionId: SESSION, rows: [], workspaceTestSupported: true, linkedRows: [],
    jobRows: [
      jobSnapshot('aaaaaaaaaaa7', 'running', { progress: { percent: 140, done: 5, total: 9, totalUnit: 'tests', failed: 2.7, failureMarks: [0.2, 9, 'x', -1] } }),
      jobSnapshot('aaaaaaaaaaa8', 'running', { progress: { percent: null, failed: 0, failureMarks: [] } }),
      jobSnapshot('aaaaaaaaaaa9', 'running', { progress: null }),
    ],
  });
  const byId = Object.fromEntries(withProgress.data.items.map((item) => [item.job_id, item]));
  assert.deepEqual([byId.aaaaaaaaaaa7.progress_percent, byId.aaaaaaaaaaa7.progress_failed, byId.aaaaaaaaaaa7.progress_marks], [100, 2, [0.2, 1, 0]]);
  assert.deepEqual([byId.aaaaaaaaaaa8.progress_percent, byId.aaaaaaaaaaa8.progress_marks], [null, []]);
  assert.equal('progress_percent' in byId.aaaaaaaaaaa9, false);

  const hostile = buildBackgroundTasksSection({
    sampledAt: 's', sessionId: SESSION, rows: [], workspaceTestSupported: true, linkedRows: [],
    jobRows: [jobSnapshot('aaaaaaaaaaa6', 'running', { command: 'rm\u202e -rf\u0007 x', exitCode: 1.5, startedAtMs: -4 })],
  });
  assert.deepEqual([hostile.data.items[0].command, hostile.data.items[0].started_at_ms], ['rm -rf x', null]);

  const off = buildBackgroundTasksSection({ sampledAt: 's', sessionId: SESSION, rows: [], workspaceTestSupported: true, linkedRows: [] });
  assert.deepEqual(off.data.unsupported_sources, ['session_runtime', 'background_job']);
});

test('the service reads the session jobs from the background-job tracker', async () => {
  const asked = [];
  const tracker = { getSessionJobs: (id) => { asked.push(id); return [jobSnapshot('bbbbbbbbbbb1', 'running')]; } };
  const tasks = (await makeService({ backgroundJobTracker: tracker }).service.getSummary(req())).summary.background_tasks;
  assert.deepEqual(asked, [SESSION]);
  assert.equal(tasks.data.unsupported_sources.includes('background_job'), false);
  assert.deepEqual(tasks.data.items.map((item) => item.operation_id), ['job:bbbbbbbbbbb1']);
  assert.equal(tasks.data.counts.active, 1);
});

test('summaries are per session: another session never receives this session values', async () => {
  const captured = [];
  const { service } = makeService({
    captureAuthority: (id) => { captured.push(id); return authorityOf({ root_id: id === SESSION ? 'root_a' : 'root_b' }); },
  });
  const one = (await service.getSummary(req())).summary;
  const two = (await service.getSummary({ schema_version: 1, session_id: OTHER })).summary;
  assert.equal(one.session_id, SESSION);
  assert.equal(two.session_id, OTHER);
  assert.equal(one.changes.data.workspace_id, 'root_a');
  assert.equal(two.changes.data.workspace_id, 'root_b');
  assert.equal(two.revision, 7);
  assert.deepEqual(captured, [SESSION, OTHER]);
});

test('setView writes through the store with the expected revision, returns the persisted view and emits an invalidation', async () => {
  const { service, events, viewStore } = makeService();
  const ok = await service.setView(req({ expected_revision: 0, patch: { rail_visible: true } }));
  assert.deepEqual(ok, {
    schema_version: 1, ok: true,
    workspace_view: { schema_version: 1, rail_visible: true, disclosures: {}, children_expanded: null },
    coordination_revision: 1,
  });
  assert.deepEqual(viewStore.calls[0], [SESSION, { expected_revision: 0, patch: { rail_visible: true } }]);
  assert.deepEqual(events, [{ schema_version: 1, session_id: SESSION, revision: 1 }]);

  const conflict = await service.setView(req({ expected_revision: 0, patch: { rail_visible: false } }));
  assert.deepEqual(conflict, {
    schema_version: 1, ok: false, error_code: CHATWS_ERROR_CODES.REVISION_CONFLICT, reason: 'revision_conflict', retryable: true, current_revision: 1,
  });
  const invalid = await service.setView(req({ expected_revision: 1, patch: { bad: true } }));
  assert.deepEqual([invalid.ok, invalid.reason, invalid.error_code, invalid.retryable], [false, 'invalid_patch', CHATWS_ERROR_CODES.INVALID_REQUEST, false]);
  const io = await service.setView(req({ expected_revision: 1, patch: { io: true } }));
  assert.deepEqual([io.reason, io.error_code, io.retryable, io.current_revision], ['io_failed', CHATWS_ERROR_CODES.IO_FAILED, true, 1]);
  assert.equal(events.length, 1, 'failed writes emit nothing');
});

test('setView maps a throwing store to a retryable io failure without leaking exception text', async () => {
  const viewStore = fakeViewStore();
  viewStore.write = () => { throw new Error('disk exploded at C:\\secret'); };
  const { service } = makeService({ viewStore });
  const result = await service.setView(req({ expected_revision: 0, patch: { rail_visible: true } }));
  assert.deepEqual([result.ok, result.reason, result.retryable], [false, 'io_failed', true]);
  assert.doesNotMatch(JSON.stringify(result), /secret|exploded/u);
});

test('listChanges returns the envelope, honest states and the no-workspace case', async () => {
  const { service, changes } = makeService();
  const list = await service.listChanges(req());
  assert.equal(list.ok, true);
  assert.deepEqual([list.state, list.reason, list.sampled_at], ['available', null, '2026-10-15T12:00:00.000Z']);
  assert.equal(list.data.file_count, 1);
  assert.equal(changes.calls.list, 1);

  const none = makeService({ captureAuthority: () => authorityOf({ root_path: null, root_id: null }) });
  assert.deepEqual(await none.service.listChanges(req()), {
    schema_version: 1, ok: true, state: 'unavailable', reason: 'no_workspace', sampled_at: null, data: null,
  });
  const gone = makeService({ changes: fakeChanges({ list: () => { throw new Error('boom'); } }) });
  const failed = await gone.service.listChanges(req());
  assert.deepEqual([failed.ok, failed.state, failed.reason, failed.data], [true, 'unavailable', 'git_failed', null]);
});

test('getChangeDiff forwards only the session workspace root and maps refusals without logging the path', async () => {
  const refused = makeService({ changes: fakeChanges({ diff: ({ path: p }) => (
    p === '../x' ? { ok: false, reason: 'path_not_changed' } : p === 'link' ? { ok: false, reason: 'path_outside_workspace' } : { ok: false, reason: 'git_failed' }
  ) }) });
  const notChanged = await refused.service.getChangeDiff(req({ path: '../x' }));
  assert.deepEqual([notChanged.ok, notChanged.reason, notChanged.error_code], [false, 'path_not_changed', CHATWS_ERROR_CODES.PATH_REFUSED]);
  const escape = await refused.service.getChangeDiff(req({ path: 'link' }));
  assert.deepEqual([escape.reason, escape.error_code], ['path_outside_workspace', CHATWS_ERROR_CODES.PATH_REFUSED]);
  const git = await refused.service.getChangeDiff(req({ path: 'other' }));
  assert.deepEqual([git.reason, git.retryable], ['git_failed', true]);
  assert.deepEqual(refused.changes.calls.diff.map((call) => call.root), [ROOT, ROOT, ROOT]);
  assert.equal(JSON.stringify(refused.logs).includes('../x'), false);
  assert.equal(JSON.stringify(refused.logs).includes('link'), false);
  assert.equal(refused.logs.length, 2);

  const ok = makeService();
  const diff = await ok.service.getChangeDiff(req({ path: 'a.txt' }));
  assert.deepEqual(diff, { schema_version: 1, ok: true, path: 'a.txt', change: 'modified', binary: false, truncated: false, diff: 'd' });

  const rootless = makeService({ captureAuthority: () => authorityOf({ root_path: null, root_id: null }) });
  assert.equal((await rootless.service.getChangeDiff(req({ path: 'a.txt' }))).reason, 'no_workspace');
});

// Whole-branch scope (chat session bar slice 5): routing, validation and a cache apart from the working tree.
function fakeBranchCompare(overrides = {}) {
  const calls = { list: [], diff: [] };
  return {
    calls,
    async listBranchChanges(args) {
      calls.list.push(args);
      return overrides.list ? overrides.list(args, calls.list.length) : {
        state: 'available', reason: null, sampled_at: '2026-10-15T12:00:00.000Z',
        data: { workspace_id: 'root_a', scope: 'branch', base_ref: 'main', merge_base: 'abc123456', commit_count: 2, files: [], file_count: 0 },
      };
    },
    async getBranchChangeDiff(args) {
      calls.diff.push(args);
      return overrides.diff ? overrides.diff(args) : { ok: true, path: args.path, change: 'added', binary: false, truncated: false, diff: 'b' };
    },
  };
}

function makeBranchService(branchCompare, options = {}) {
  const clock = makeClock();
  const changes = fakeChanges();
  const logs = [];
  const service = new ChatWorkspaceService({
    viewStore: fakeViewStore(),
    getStore: () => fakeStore(),
    captureAuthority: () => authorityOf(),
    resolveGitService: () => ({ marker: 'git' }),
    getWorktreeEntries: () => options.entries || [],
    changeSummary: changes,
    branchCompare,
    log: (level, event, details) => logs.push([level, event, details]),
    now: clock.now,
    notifierOptions: { intervalMs: 0 },
  });
  return { service, changes, logs, clock };
}

test('scope is optional and closed on listChanges and getChangeDiff, and getSummary still takes none', async () => {
  const { service, changes } = makeBranchService(fakeBranchCompare());
  for (const scope of ['everything', '', null, undefined, 1, 'Branch']) {
    assert.equal((await service.listChanges(req({ scope }))).reason, 'invalid_request', String(scope));
    assert.equal((await service.getChangeDiff(req({ path: 'a.txt', scope }))).reason, 'invalid_request', String(scope));
  }
  assert.equal((await service.getSummary(req({ scope: 'branch' }))).reason, 'invalid_request');
  assert.equal((await service.listChanges(req({ scope: 'working_tree' }))).data.scope, 'working_tree');
  assert.equal((await service.listChanges(req())).data.scope, 'working_tree');
  assert.equal(changes.calls.list, 1); // both working-tree asks shared one read
});

test('branch scope reads through the branch compare with its own cache; the scopes never serve each other', async () => {
  const entries = [{ id: 'wt_1', worktree_path: ROOT, base_ref: 'develop' }];
  const compare = fakeBranchCompare();
  const { service, changes, clock } = makeBranchService(compare, { entries });
  const branch = await service.listChanges(req({ scope: 'branch' }));
  assert.deepEqual([branch.ok, branch.state, branch.data.scope, branch.data.base_ref], [true, 'available', 'branch', 'main']);
  assert.equal(compare.calls.list.length, 1);
  const { registryBase, root, workspaceId } = compare.calls.list[0];
  assert.deepEqual([registryBase, root, workspaceId, changes.calls.list], ['develop', ROOT, 'root_a', 0]);

  assert.equal((await service.listChanges(req())).data.scope, 'working_tree');
  await service.listChanges(req({ scope: 'branch' }));
  await service.listChanges(req());
  assert.deepEqual([compare.calls.list.length, changes.calls.list], [1, 1]); // fresh window serves each from its own cache

  // An invalidation clears both scopes.
  service.handleWorkspaceChange({ context: { rootId: 'root_a' } });
  await service.listChanges(req({ scope: 'branch' }));
  await service.listChanges(req());
  assert.deepEqual([compare.calls.list.length, changes.calls.list], [2, 2]);
  clock.advance(5000);
  await service.listChanges(req({ scope: 'branch' }));
  assert.equal(compare.calls.list.length, 3);
});

test('branch scope is single-flight and reports not_applicable states with null data', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const compare = fakeBranchCompare({ list: async () => {
    await gate;
    return { state: 'not_applicable', reason: 'on_base_branch', sampled_at: '2026-10-15T12:00:00.000Z', data: null };
  } });
  const { service } = makeBranchService(compare);
  const first = service.listChanges(req({ scope: 'branch' }));
  const second = service.listChanges(req({ scope: 'branch' }));
  await Promise.resolve();
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(compare.calls.list.length, 1);
  assert.deepEqual([one, two].map((r) => [r.ok, r.state, r.reason, r.data]), Array(2).fill([true, 'not_applicable', 'on_base_branch', null]));
  const gone = makeBranchService(fakeBranchCompare({ list: () => { throw new Error('boom at C:\\secret'); } }));
  const failed = await gone.service.listChanges(req({ scope: 'branch' }));
  assert.deepEqual([failed.state, failed.reason, failed.data], ['unavailable', 'git_failed', null]);
});

test('branch getChangeDiff routes to the branch compare and logs refusals without the path', async () => {
  const compare = fakeBranchCompare({ diff: ({ path: p }) => (
    p === 'zzz-secret' ? { ok: false, reason: 'path_not_changed' } : { ok: true, path: p, change: 'added', binary: false, truncated: false, diff: 'b' }
  ) });
  const { service, changes, logs } = makeBranchService(compare, { entries: [{ worktree_path: ROOT, base_ref: 'develop' }] });
  const ok = await service.getChangeDiff(req({ path: 'f.txt', scope: 'branch' }));
  assert.deepEqual(ok, { schema_version: 1, ok: true, path: 'f.txt', change: 'added', binary: false, truncated: false, diff: 'b' });
  assert.deepEqual(compare.calls.diff[0], { gitService: { marker: 'git' }, root: ROOT, path: 'f.txt', registryBase: 'develop' });
  const refused = await service.getChangeDiff(req({ path: 'zzz-secret', scope: 'branch' }));
  assert.deepEqual([refused.ok, refused.reason, refused.error_code], [false, 'path_not_changed', CHATWS_ERROR_CODES.PATH_REFUSED]);
  assert.deepEqual([JSON.stringify(logs).includes('zzz-secret'), logs.length, changes.calls.diff.length], [false, 1, 0]);
  await service.getChangeDiff(req({ path: 'f.txt', scope: 'working_tree' }));
  assert.equal(changes.calls.diff.length, 1);
});
