'use strict';

/* Row 59 checkpoint 5a-2 (R4): Background tasks rows for a chat's direct linked
 * children (`linked_chat_turn`). The runtime store, the session listing and the
 * parent's coordination view are fakes. Covers the status -> bucket mapping,
 * support and withheld-zero rules, cross-source dedupe, the item cap, the title
 * bound, and the child -> parent invalidation. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ChatWorkspaceService } = require('../services/chat-workspace-service');
const {
  MAX_TASK_ITEMS,
  boundedTitle,
  buildBackgroundTasksSection,
} = require('../services/chat-workspace-summary-sections');
const {
  SESSION,
  authorityOf,
  fakeChanges,
  fakeStore,
  fakeViewStore,
  makeClock,
  req,
} = require('./helpers/chat-workspace-fixtures');

const CHILD_A = 'sess_child_a';
const CHILD_B = 'sess_child_b';
const STRANGER = 'sess_stranger';

function work(workId, sessionId, status, extra = {}) {
  return {
    work_id: workId, turn_id: `turn_${workId}`, session_id: sessionId, status,
    created_at: '2026-10-15T10:00:00.000Z', updated_at: '2026-10-15T10:05:00.000Z', ...extra,
  };
}

function sessionEntry(id, parent, title = `Title of ${id}`) {
  return { id, title, spawned_from: parent ? { parent_session_id: parent, proposal_id: 'proposal_x', created_at: '2026-10-15T09:00:00.000Z' } : undefined };
}

// A session store with a listing, and a runtime store keyed by session id.
function build({ sessions, works = [], runtime = true, activityRows = null, throwOn = null } = {}) {
  const base = fakeStore();
  const summaries = new Map(sessions.map((entry) => [entry.id, entry]));
  const store = {
    ...base,
    getSessionSummary(id) {
      const known = base.getSessionSummary(id);
      return known ? { ...known, ...summaries.get(id) } : (summaries.get(id) ? { ...summaries.get(id) } : null);
    },
    listSessions: () => [...summaries.values()],
  };
  const listCalls = [];
  const runtimeStore = {
    listSummaries(request) {
      listCalls.push(request);
      if (throwOn === request.sessionId) throw new Error('boom');
      return { items: works.filter((item) => item.session_id === request.sessionId), next_cursor: null };
    },
  };
  const events = [];
  const logs = [];
  const service = new ChatWorkspaceService({
    viewStore: fakeViewStore(),
    getStore: () => store,
    captureAuthority: () => authorityOf(),
    resolveGitService: () => ({}),
    getWorkspaceTestSource: () => (activityRows ? { getActivityRuns: () => activityRows, subscribeActivity: () => () => {} } : null),
    isActivityEnabled: () => activityRows !== null,
    getRuntimeStore: () => (runtime ? runtimeStore : null),
    changeSummary: fakeChanges(),
    emit: (event) => events.push(event),
    log: (level, event, details) => logs.push([level, event, details]),
    now: makeClock().now,
    notifierOptions: { intervalMs: 0 },
  });
  return { service, events, logs, listCalls, summaries };
}

const tasksOf = async (service) => (await service.getSummary(req())).summary.background_tasks;

test('linked children: statuses map to the rail buckets and rows carry the closed linked shape', async () => {
  const { service, listCalls } = build({
    sessions: [sessionEntry(SESSION), sessionEntry(CHILD_A, SESSION, 'Fix the flaky test'), sessionEntry(STRANGER, 'sess_other')],
    works: [
      work('w_run', CHILD_A, 'running', { updated_at: '2026-10-15T10:09:00.000Z' }),
      work('w_pen', CHILD_A, 'pending'),
      work('w_pau', CHILD_A, 'paused'),
      work('w_att', CHILD_A, 'needs_attention'),
      work('w_fail', CHILD_A, 'failed'),
      work('w_done', CHILD_A, 'completed'),
      work('w_cancel', CHILD_A, 'cancelled'),
      work('w_stranger', STRANGER, 'running'),
    ],
  });
  const tasks = await tasksOf(service);
  assert.deepEqual(tasks.data.counts, { active: 1, waiting: 2, failed: 2, completed: 2 });
  assert.equal(tasks.data.coverage, 'partial');
  assert.deepEqual(tasks.data.unsupported_sources, ['workspace_test', 'session_runtime']);
  assert.deepEqual(listCalls.map((call) => call.sessionId), [CHILD_A], 'only direct children are read');
  assert.equal(tasks.data.items.some((item) => item.operation_id === 'w_stranger'), false);
  const running = tasks.data.items.find((item) => item.operation_id === 'w_run');
  assert.deepEqual(running, {
    source_kind: 'linked_chat_turn', operation_id: 'w_run', session_id: CHILD_A, state: 'running',
    started_at: '2026-10-15T10:00:00.000Z', finished_at: null, output_ref: null, title: 'Fix the flaky test',
  });
  const done = tasks.data.items.find((item) => item.operation_id === 'w_done');
  assert.equal(done.finished_at, '2026-10-15T10:05:00.000Z', 'a terminal work reports when it settled');
  assert.equal(tasks.data.items.find((item) => item.operation_id === 'w_att').finished_at, null, 'needs_attention is not settled');
  const states = tasks.data.items.map((item) => item.state);
  assert.deepEqual(states.slice(0, 4).sort(), ['needs_attention', 'paused', 'pending', 'running'], 'live work sorts before settled work');
  assert.deepEqual(states.slice(4).sort(), ['cancelled', 'completed', 'failed']);
});

test('linked children: zero buckets stay withheld while another source is unsupported; none is a lower bound only', async () => {
  const { service } = build({
    sessions: [sessionEntry(SESSION), sessionEntry(CHILD_A, SESSION)],
    works: [work('w_run', CHILD_A, 'running')],
  });
  const tasks = await tasksOf(service);
  assert.deepEqual(tasks.data.counts, { active: 1, waiting: null, failed: null, completed: null });
  assert.equal(tasks.reason, 'partial_coverage');
  const none = await tasksOf(build({ sessions: [sessionEntry(SESSION)] }).service);
  assert.equal(none.data.coverage, 'partial');
  assert.deepEqual(none.data.counts, { active: null, waiting: null, failed: null, completed: null }, 'no linked rows is not a claimed zero');
  assert.deepEqual(none.data.items, []);
  assert.equal(none.data.unsupported_sources.includes('linked_chat_turn'), false, 'a readable but empty linked source is supported');
});

test('linked chat turns stay unsupported without a runtime store, a listing or on a failed read', async () => {
  const sessions = [sessionEntry(SESSION), sessionEntry(CHILD_A, SESSION)];
  const works = [work('w_run', CHILD_A, 'running')];
  const noRuntime = await tasksOf(build({ sessions, works, runtime: false }).service);
  assert.deepEqual(noRuntime.data.unsupported_sources, ['workspace_test', 'session_runtime', 'linked_chat_turn']);
  assert.deepEqual(noRuntime.data.counts, { active: null, waiting: null, failed: null, completed: null });
  assert.deepEqual(noRuntime.data.items, []);

  const failing = build({ sessions, works, throwOn: CHILD_A });
  const failed = await tasksOf(failing.service);
  assert.equal(failed.data.unsupported_sources.includes('linked_chat_turn'), true);
  assert.deepEqual(failing.logs.map(([level, event]) => [level, event]), [['WARN', 'chat_workspace.linked_tasks_failed']]);
  assert.equal(JSON.stringify(failing.logs).includes('Title of'), false, 'logs carry no chat titles');

  const base = fakeStore();
  const bare = new ChatWorkspaceService({
    viewStore: fakeViewStore(), getStore: () => base, captureAuthority: () => authorityOf(), resolveGitService: () => ({}),
    getRuntimeStore: () => ({ listSummaries: () => ({ items: [], next_cursor: null }) }), changeSummary: fakeChanges(),
  });
  assert.equal((await tasksOf(bare)).data.unsupported_sources.includes('linked_chat_turn'), true, 'a store without a session listing is unsupported');
});

test('linked rows are deduplicated by operation id across sources and capped like every other source', () => {
  const testRows = [{ runId: 'dup', state: 'running', updatedAt: '2026-10-15T10:00:00.000Z' }];
  const linkedRows = [
    { work_id: 'dup', status: 'running', created_at: '2026-10-15T10:00:00.000Z', updated_at: '2026-10-15T10:00:00.000Z', child_session_id: CHILD_A, title: 'T' },
    { work_id: 'dup', status: 'failed', created_at: '2026-10-15T10:00:00.000Z', updated_at: '2026-10-15T10:00:00.000Z', child_session_id: CHILD_A, title: 'T' },
    { work_id: 'other', status: 'weird', created_at: null, updated_at: null, child_session_id: CHILD_A, title: 'T' },
    { work_id: '', status: 'running', child_session_id: CHILD_A },
    { work_id: 'orphan', status: 'running', child_session_id: '' },
  ];
  const section = buildBackgroundTasksSection({
    sampledAt: 's', sessionId: SESSION, rows: testRows, workspaceTestSupported: true, linkedRows,
  });
  assert.deepEqual(section.data.items.map((item) => [item.source_kind, item.operation_id]), [['workspace_test', 'dup']]);
  assert.equal(section.data.counts.active, 1);
  assert.equal(section.data.counts.failed, null);

  const many = Array.from({ length: 15 }, (_, index) => ({
    work_id: `w${index}`, status: 'running', created_at: '2026-10-15T10:00:00.000Z', updated_at: `2026-10-15T10:00:${String(index).padStart(2, '0')}.000Z`, child_session_id: CHILD_B, title: 'x',
  }));
  const capped = buildBackgroundTasksSection({ sampledAt: 's', sessionId: SESSION, rows: [], workspaceTestSupported: true, sessionRuntimeSupported: true, linkedRows: many });
  assert.equal(MAX_TASK_ITEMS, 10);
  assert.equal(capped.data.items.length, 10);
  assert.equal(capped.data.counts.active, 15);
  assert.equal(capped.data.coverage, 'complete');
  assert.deepEqual(capped.data.unsupported_sources, []);
  assert.equal(capped.data.items[0].operation_id, 'w14', 'most recently updated first');
});

test('the service dedupes a linked work that also appears as a workspace test run', async () => {
  const { service } = build({
    sessions: [sessionEntry(SESSION), sessionEntry(CHILD_A, SESSION)],
    works: [work('shared', CHILD_A, 'running'), work('w2', CHILD_A, 'completed')],
    activityRows: [{ runId: 'shared', state: 'running', scope: { session_id: SESSION, project_id: 'project_a' }, updatedAt: '2026-10-15T10:00:00.000Z' }],
  });
  const tasks = await tasksOf(service);
  assert.deepEqual(tasks.data.items.map((item) => [item.source_kind, item.operation_id]).sort(), [['linked_chat_turn', 'w2'], ['workspace_test', 'shared']]);
  assert.deepEqual(tasks.data.unsupported_sources, ['session_runtime']);
});

test('titles are bounded to 512 UTF-8 bytes on a code point boundary and stripped of control characters', () => {
  assert.equal(boundedTitle('  Plain title  '), 'Plain title');
  assert.equal(boundedTitle('a\u0000b‮c\nd'), 'abcd');
  assert.equal(boundedTitle(''), null);
  assert.equal(boundedTitle(undefined), null);
  const wide = boundedTitle('\u{1F600}'.repeat(200));
  assert.equal(Buffer.byteLength(wide, 'utf8'), 512);
  assert.equal(Array.from(wide).length, 128);
  const ascii = boundedTitle('x'.repeat(600));
  assert.equal(ascii.length, 512);
  const odd = boundedTitle(`${'x'.repeat(511)}é`);
  assert.equal(Buffer.byteLength(odd, 'utf8'), 511, 'a two-byte character that does not fit is dropped whole');
});

test('a child chat-stream start or terminal event invalidates its parent; deltas and roots do not', () => {
  const { service, events, summaries } = build({ sessions: [sessionEntry(SESSION), sessionEntry(CHILD_A, SESSION), sessionEntry(STRANGER, null)] });
  service.handleChatStreamEvent({ type: 'delta', sessionId: CHILD_A });
  assert.deepEqual(events, []);
  service.handleChatStreamEvent({ type: 'started', sessionId: CHILD_A });
  assert.deepEqual(events.map((event) => event.session_id), [SESSION], 'start moves the parent but not the child');
  service.handleChatStreamEvent({ type: 'complete', sessionId: CHILD_A });
  assert.deepEqual(events.map((event) => event.session_id), [SESSION, SESSION, CHILD_A], 'a terminal event moves the parent and the child');
  const before = events.length;
  service.handleChatStreamEvent({ type: 'started', sessionId: STRANGER });
  service.handleChatStreamEvent({ type: 'started', sessionId: 'sess_unknown' });
  assert.equal(events.length, before, 'a session with no parent invalidates nobody on start');
  summaries.delete(CHILD_A);
  service.handleChatStreamEvent({ type: 'error', sessionId: CHILD_A });
  assert.ok(events.length > before, 'the cached parent link survives; the child terminal event still invalidates');
});
