'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionDirectoryService } = require('../services/session-directory-service');
const { visibleChatPredicate } = require('../services/backend/memory-reflection-eligibility');
const { CHILD_WORK_PURPOSE } = require('../services/backend/runtime-child-publication');

const T0 = '2026-10-20T10:00:00.000Z';

function chat(id, extra = {}) {
  return {
    id, project_id: 'project_a', title: `Chat ${id}`, session_type: 'chat', created_at: T0, updated_at: T0,
    message_count: 2, unread_message_count: 0, pinned: false, archived_at: null, lockdown: false,
    spawned_from: null, linked_session_ids: [], run_mode: 'auto', plan_mode: false, last_model_used: 'model',
    context_usage: null, compaction_context: null, pending_question_batch: null, pending_plan_proposal: null,
    ...extra,
  };
}

function workRow(sessionId, status, extra = {}) {
  return { work_id: `w_${sessionId}_${status}`, session_id: sessionId, project_id: 'project_a', status, revision: 3,
    updated_at: '2026-10-20T11:00:00.000Z', admission_wait: null, resumable: null, ...extra };
}

function fixture({ sessions, activeTurns = {}, work = {}, approvals = [], details = {}, messages = {},
  childIds = [], followUps = [], notes = {}, workspace = null, cancelStream = () => true, primaryChatEnabled = true,
  cancelWork = null } = {}) {
  const calls = { cancelStream: [], cancel: [], getSummary: [], snapshots: [], peeks: [] };
  const runtimeStore = {
    getStatus: () => ({ revision: 1 }),
    listSummaries: () => ({ items: childIds.map((id) => ({ work_id: `child_${id}`, session_id: id,
      purpose: CHILD_WORK_PURPOSE })), next_cursor: null }),
    get: () => ({ input: { kind: 'child_chat' } }),
  };
  const backend = { sessionRuntime: { store: runtimeStore }, featureFlags: {} };
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  const sessionStore = {
    listSessions: () => sessions.map((entry) => ({ ...entry })),
    listSessionRecords: () => sessions.map((entry) => ({ ...entry, active_turn: activeTurns[entry.id] || null })),
    getSessionSummary: (id) => (byId.has(id) ? { ...byId.get(id) } : null),
    getActiveTurn: (id) => activeTurns[id] || null,
    peekActiveTurn: (id) => activeTurns[id] || null,
    peekSession: (id) => (byId.has(id) ? { ...byId.get(id), ...(details[id] || {}) } : null),
    peekSessionMessages: (id) => { calls.peeks.push(id); return messages[id] || []; },
  };
  const runtime = {
    getSnapshot: (request) => {
      calls.snapshots.push(request);
      if (request.session_id) return { ok: true, work: work[request.session_id] || [] };
      return { ok: true, work: Object.values(work).flat(), next_cursor: null };
    },
    cancel: (payload) => {
      calls.cancel.push(payload);
      return cancelWork ? cancelWork(payload) : { ok: true, cleanup_confirmed: true };
    },
  };
  const pending = new Map(approvals.map((sessionId, index) => [`approval_${index}`, { sessionId, streamId: 's' }]));
  const directory = createSessionDirectoryService({
    sessionStore: () => sessionStore,
    projectService: () => ({ get: (id) => ({ id, name: `Project ${id}` }) }),
    runtime: () => runtime,
    configService: () => ({ getState: () => ({ followUps }) }),
    projectNotesService: () => ({ get: (id) => (notes[id] ? { ok: true, note: notes[id] } : { ok: false }) }),
    chatWorkspaceService: () => workspace && { getSummary: async (raw) => { calls.getSummary.push(raw); return workspace; } },
    pendingApprovals: () => pending,
    primaryChatEnabled: () => primaryChatEnabled,
    visibleChat: () => visibleChatPredicate(backend),
    cancelChatStream: (streamId, reason) => { calls.cancelStream.push([streamId, reason]); return cancelStream(streamId); },
    stopSettleMs: 80,
  });
  return { directory, calls };
}

// The caller's scope as the tools see it: every chat `list` returns plus the caller itself.
function scopeOf(directory, callerSessionId) {
  const answer = directory.list({ callerSessionId, scope: 'all', include_archived: true, limit: 50 });
  if (!answer.ok) return answer;
  return { ok: true, kind: answer.scope_kind,
    session_ids: new Set([callerSessionId, ...answer.rows.map((row) => row.session_id)]) };
}

// P primary (General); A1 the ordinary caller in project_a, child of B3 and parent of B2; L linked to A1.
function scopeSessions() {
  return [
    chat('P', { project_id: 'project_general', session_role: 'primary' }),
    chat('A1', { spawned_from: { parent_session_id: 'B3', proposal_id: 'p', created_at: T0 }, linked_session_ids: ['L'] }),
    chat('A2'),
    chat('B1', { project_id: 'project_b' }),
    chat('B2', { project_id: 'project_b', spawned_from: { parent_session_id: 'A1', proposal_id: 'q', created_at: T0 } }),
    chat('B3', { project_id: 'project_b' }),
    chat('L', { project_id: 'project_c' }),
    chat('LK', { lockdown: true }),
    chat('PL', { session_type: 'plugin' }),
    chat('DG', { diagnostic_mode: true }),
    chat('RC'),
    chat('G', { project_id: 'project_general' }),
    chat('PC', { project_id: 'project_b', spawned_from: { parent_session_id: 'P', proposal_id: 'r', created_at: T0 } }),
  ];
}

test('no ordinary caller sees the primary chat: not a General chat, not a chat the primary spawned', () => {
  const { directory } = fixture({ sessions: scopeSessions() });
  assert.deepEqual([...scopeOf(directory, 'G').session_ids].sort(), ['G']);
  assert.deepEqual([...scopeOf(directory, 'PC').session_ids].sort(), ['B1', 'B2', 'B3', 'PC']);
  assert.deepEqual(directory.list({ callerSessionId: 'G', scope: 'all' }).rows, []);
  const off = fixture({ sessions: scopeSessions(), primaryChatEnabled: false }).directory;
  const demoted = scopeOf(off, 'P');
  assert.equal(demoted.kind, 'project', 'with primary_chat off the primary is an ordinary General chat');
  assert.deepEqual([...demoted.session_ids].sort(), ['G', 'P', 'PC'], 'General plus the chat it spawned, like any parent');
  assert.deepEqual([...scopeOf(off, 'G').session_ids].sort(), ['G'],
    'an ordinary caller never sees the primary, kill switch on or off');
});

test('the primary caller sees the profile; an ordinary caller its project plus linked relatives', async () => {
  const { directory } = fixture({ sessions: scopeSessions(), childIds: ['RC'] });
  const profile = scopeOf(directory, 'P');
  assert.equal(profile.ok, true);
  assert.equal(profile.kind, 'profile');
  assert.deepEqual([...profile.session_ids].sort(), ['A1', 'A2', 'B1', 'B2', 'B3', 'G', 'L', 'P', 'PC']);
  const project = scopeOf(directory, 'A1');
  assert.equal(project.kind, 'project');
  assert.deepEqual([...project.session_ids].sort(), ['A1', 'A2', 'B2', 'B3', 'L']);
  const other = scopeOf(directory, 'B1');
  assert.deepEqual([...other.session_ids].sort(), ['B1', 'B2', 'B3', 'PC'], 'a spawned sibling never pulls the primary in');
  const rows = directory.list({ callerSessionId: 'A1', scope: 'all' });
  assert.equal(rows.ok, true);
  assert.equal(rows.scope_kind, 'project');
  // The caller is not its own row; lockdown, plugin, diagnostic and runtime-child chats never appear.
  assert.deepEqual(rows.rows.map((row) => row.session_id).sort(), ['A2', 'B2', 'B3', 'L']);
  const relative = await directory.digest({ callerSessionId: 'A1', sessionId: 'L' });
  assert.deepEqual(relative.project, { id: 'project_c', name: 'Project project_c', open_tasks: [], note: null },
    "a linked relative's digest names its project but keeps that project's tasks and note");
});

test('a caller in lockdown is refused and an unknown caller is unavailable', () => {
  const { directory } = fixture({ sessions: scopeSessions() });
  assert.deepEqual(directory.list({ callerSessionId: 'LK', scope: 'all' }), { ok: false, reason: 'lockdown' });
  assert.deepEqual(scopeOf(directory, 'LK'), { ok: false, reason: 'lockdown' });
  assert.deepEqual(directory.list({ callerSessionId: 'missing' }), { ok: false, reason: 'unavailable' });
});

test('every D7 status is derived from facts, and active lists only non-idle chats', () => {
  const sessions = [chat('P', { session_role: 'primary' }), chat('run'), chat('queued'), chat('approval'),
    chat('question', { pending_question_batch: { batch_id: 'b' } }), chat('plan', { pending_plan_proposal: { proposal_id: 'x' } }),
    chat('attention'), chat('failed'), chat('idle'), chat('done'), chat('paused'), chat('held')];
  const { directory } = fixture({
    sessions,
    activeTurns: { run: { stream_id: 'stream_run', status: 'streaming' }, approval: { stream_id: 'sa', status: 'streaming' } },
    approvals: ['approval'],
    work: {
      queued: [workRow('queued', 'pending', { admission_wait: { reason: 'session_busy', since: T0, blocking_session_id: null } })],
      attention: [workRow('attention', 'needs_attention')],
      failed: [workRow('failed', 'failed')],
      done: [workRow('done', 'completed'), workRow('done', 'failed', { updated_at: T0 })],
      // What session_stop cancels never reads idle: paused (resumable) work and pending work with no wait.
      paused: [workRow('paused', 'paused', { resumable: true })],
      held: [workRow('held', 'pending')],
    },
  });
  const listed = directory.list({ callerSessionId: 'P', scope: 'all' });
  const status = Object.fromEntries(listed.rows.map((row) => [row.session_id, row.status]));
  assert.deepEqual(status, { run: 'running', queued: 'queued', approval: 'waiting_approval', question: 'waiting_question',
    plan: 'waiting_plan', attention: 'needs_attention', failed: 'failed', idle: 'idle', done: 'idle',
    paused: 'queued', held: 'queued' });
  const done = listed.rows.find((row) => row.session_id === 'done');
  assert.deepEqual(done.last_outcome, { status: 'completed', updated_at: '2026-10-20T11:00:00.000Z', resumable: null });
  assert.equal(listed.rows.find((row) => row.session_id === 'question').waiting_on_user, true);
  assert.equal(listed.rows.find((row) => row.session_id === 'run').waiting_on_user, false);
  const active = directory.list({ callerSessionId: 'P', scope: 'active' });
  assert.deepEqual(active.rows.map((row) => row.session_id).sort(),
    ['approval', 'attention', 'failed', 'held', 'paused', 'plan', 'question', 'queued', 'run']);
});

test('a denied newest turn reads denied and stopped, a real failure still reads failed', () => {
  const sessions = [chat('P', { session_role: 'primary' }), chat('denied'), chat('broke'), chat('other'), chat('done')];
  const assistant = (turnId, status) => ({ id: `m_${turnId}`, role: 'assistant', turn_id: turnId, status });
  const { directory, calls } = fixture({
    sessions,
    work: {
      denied: [workRow('denied', 'failed', { turn_id: 't2' }), workRow('denied', 'completed', { turn_id: 't1' })],
      broke: [workRow('broke', 'failed', { turn_id: 't3' })],
      other: [workRow('other', 'failed', { turn_id: 't5' })],
      done: [workRow('done', 'completed', { turn_id: 't4' })],
    },
    messages: {
      denied: [assistant('t1', 'complete'), assistant('t2', 'denied')],
      broke: [assistant('t3', 'error')],
      other: [assistant('t4', 'denied')],
      done: [assistant('t4', 'denied')],
    },
  });
  const rows = Object.fromEntries(directory.list({ callerSessionId: 'P', scope: 'all' }).rows
    .map((entry) => [entry.session_id, entry]));
  assert.equal(rows.denied.status, 'idle');
  assert.deepEqual(rows.denied.last_outcome, { status: 'denied', updated_at: '2026-10-20T11:00:00.000Z', resumable: null });
  assert.equal(rows.broke.status, 'failed');
  assert.equal(rows.broke.last_outcome.status, 'failed');
  assert.equal(rows.other.status, 'failed', 'a denied message of another turn does not rewrite this failure');
  assert.equal(rows.done.last_outcome.status, 'completed');
  assert.deepEqual([...calls.peeks].sort(), ['broke', 'denied', 'other'], 'messages are read only for failed newest rows');
});

test('the live denied shape: the call carries approval_state denied, the reply text keeps an empty status', async () => {
  // As the store held it in the 2026-10-20 live run (Beta parser, run_command denied).
  const turn = (turnId, approvalState) => [
    { role: 'user', turn_id: turnId },
    { role: 'assistant', turn_id: turnId, status: '' },
    { role: 'assistant', kind: 'tool_use', turn_id: turnId, tool_call: { tool_name: 'run_command', status: approvalState, approval_state: approvalState } },
    { role: 'tool', kind: 'tool_result', turn_id: turnId, tool_result: { tool_name: 'run_command', approval_state: approvalState } },
  ];
  const sessions = [chat('P', { session_role: 'primary' }), chat('denied'), chat('noturn'), chat('older')];
  const { directory } = fixture({ sessions,
    work: { denied: [workRow('denied', 'failed', { turn_id: 't9' })], noturn: [workRow('noturn', 'failed')],
      older: [workRow('older', 'failed')] },
    messages: { denied: [...turn('t8', 'approved'), ...turn('t9', 'denied')], noturn: [...turn('t1', 'approved'), ...turn('t2', 'denied')],
      older: [...turn('t1', 'denied'), ...turn('t2', 'approved')] } });
  const digest = await directory.digest({ callerSessionId: 'P', sessionId: 'denied' });
  assert.equal(digest.session.status, 'idle');
  assert.equal(digest.session.last_outcome.status, 'denied');
  // Without a turn id on the work row, only the newest turn counts.
  const rows = Object.fromEntries(directory.list({ callerSessionId: 'P', scope: 'all' }).rows.map((entry) => [entry.session_id, entry]));
  assert.equal(rows.noturn.last_outcome.status, 'denied');
  assert.equal(rows.older.last_outcome.status, 'failed', 'a denial in an older turn does not rewrite this failure');
});

test('a turn that went on past a denial and then failed reads failed; answers are kept per work revision', () => {
  const call = (turnId, approvalState) => [
    { role: 'assistant', kind: 'tool_use', turn_id: turnId, tool_call: { tool_name: 'run_command', approval_state: approvalState } },
    { role: 'tool', kind: 'tool_result', turn_id: turnId, tool_result: { tool_name: 'run_command', approval_state: approvalState } },
  ];
  const sessions = [chat('P', { session_role: 'primary' }), chat('replanned'), chat('denied')];
  const { directory, calls } = fixture({ sessions,
    work: { replanned: [workRow('replanned', 'failed', { turn_id: 't1' })], denied: [workRow('denied', 'failed', { turn_id: 't1' })] },
    messages: {
      replanned: [...call('t1', 'denied'), ...call('t1', 'approved'), { role: 'assistant', turn_id: 't1', status: 'error' }],
      denied: [...call('t1', 'approved'), ...call('t1', 'denied'), { role: 'assistant', turn_id: 't1', status: '' }],
    } });
  const rows = () => Object.fromEntries(directory.list({ callerSessionId: 'P', scope: 'all' }).rows
    .map((entry) => [entry.session_id, entry.last_outcome.status]));
  assert.deepEqual(rows(), { replanned: 'failed', denied: 'denied' });
  assert.deepEqual(rows(), { replanned: 'failed', denied: 'denied' });
  assert.equal(calls.peeks.length, 2, 'a terminal failed row is read once, not per call');
});

test('work states come from one bounded runtime scan per call, not one snapshot per chat', () => {
  const sessions = [chat('P', { session_role: 'primary' })];
  const work = {};
  for (let index = 0; index < 40; index += 1) {
    sessions.push(chat(`c${index}`));
    work[`c${index}`] = [workRow(`c${index}`, index % 2 ? 'running' : 'completed')];
  }
  const { directory, calls } = fixture({ sessions, work });
  const active = directory.list({ callerSessionId: 'P', scope: 'active', limit: 50 });
  assert.equal(active.rows.length, 20);
  assert.ok(active.rows.every((row) => row.status === 'running'));
  assert.ok(calls.snapshots.length <= 3, `bounded scan, got ${calls.snapshots.length} snapshots`);
  assert.ok(calls.snapshots.every((request) => !request.session_id && request.limit === 100));
});

test('recent says when more chats exist than it lists', () => {
  const sessions = [chat('P', { session_role: 'primary' })];
  for (let index = 0; index < 25; index += 1) sessions.push(chat(`c${index}`));
  const { directory } = fixture({ sessions });
  const recent = directory.list({ callerSessionId: 'P' });
  assert.equal(recent.rows.length, 20);
  assert.equal(recent.truncated, true);
  const wide = directory.list({ callerSessionId: 'P', scope: 'recent', limit: 50 });
  assert.equal(wide.rows.length, 20, 'recent is at most 20 chats, whatever the limit');
  assert.equal(wide.truncated, true);
  assert.equal(directory.list({ callerSessionId: 'P', scope: 'all', limit: 50 }).truncated, false);
});

test('rows are closed, archived chats need include_archived, and limit truncates', () => {
  const sessions = [chat('P', { session_role: 'primary' }), chat('old', { archived_at: T0 }),
    chat('x', { title: 't'.repeat(500), pinned: true, unread_message_count: 2 }), chat('y'), chat('z')];
  const { directory } = fixture({ sessions });
  const listed = directory.list({ callerSessionId: 'P', scope: 'all', limit: 2 });
  assert.equal(listed.truncated, true);
  assert.equal(listed.rows.length, 2);
  const row = listed.rows.find((entry) => entry.session_id === 'x');
  assert.deepEqual(Object.keys(row).sort(), ['archived', 'last_outcome', 'linked', 'message_count', 'pinned', 'preferred_model', 'project',
    'role', 'session_id', 'status', 'title', 'unread_message_count', 'updated_at', 'waiting_on_user']);
  assert.equal(row.title.length, 200);
  assert.deepEqual(row.project, { id: 'project_a', name: 'Project project_a' });
  assert.deepEqual(row.linked, { parent_session_id: null, children_count: 0 });
  assert.equal(directory.list({ callerSessionId: 'P', scope: 'all' }).rows.some((entry) => entry.session_id === 'old'), false);
  const archived = directory.list({ callerSessionId: 'P', scope: 'all', include_archived: true });
  assert.equal(archived.rows.find((entry) => entry.session_id === 'old').archived, true);
  assert.deepEqual(directory.list({ callerSessionId: 'P', scope: 'all', project_id: 'project_none' }).rows, []);
});

test('an id outside the scope reads as not_found for status and stop', async () => {
  const { directory, calls } = fixture({ sessions: scopeSessions(), childIds: ['RC'],
    activeTurns: { B1: { stream_id: 'sb', status: 'streaming' } } });
  for (const sessionId of ['B1', 'LK', 'PL', 'DG', 'RC', 'nope']) {
    assert.deepEqual(await directory.digest({ callerSessionId: 'A1', sessionId }), { ok: false, reason: 'not_found' });
    assert.deepEqual(await directory.stop({ callerSessionId: 'A1', sessionId }), { ok: false, reason: 'not_found' });
  }
  assert.deepEqual(calls.cancelStream, []);
});

test('the digest carries the closed status shape from existing facts', async () => {
  const transcript = [
    ...Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user',
      content: `row ${index} ${'x'.repeat(600)}`, timestamp: T0 })),
    { id: 'tool', kind: 'tool_result', role: 'tool', turn_id: 'turn_9', content: 'todo',
      tool_result: { tool_name: 'todo_write', output_text: JSON.stringify({ count: 2,
        todos: [{ content: 'write tests', status: 'completed' }, { content: 'ship', status: 'in_progress' }] }),
      generated_artifacts: [{ artifact_id: 'art_1', title: 'Report', artifact_kind: 'document', file_name: 'report.md',
        display_path: 'report.md', absolute_path: '/tmp/report.md' }] } },
  ];
  const { directory, calls } = fixture({
    sessions: [chat('P', { session_role: 'primary' }), chat('A1', { linked_session_ids: [], unread_message_count: 1,
      spawned_from: { parent_session_id: 'A0', proposal_id: 'p', created_at: T0 } }), chat('A0'),
    chat('C1', { spawned_from: { parent_session_id: 'A1', proposal_id: 'q', created_at: T0 } })],
    messages: { A1: transcript },
    work: { C1: [workRow('C1', 'completed')] },
    details: { A1: {
      chat_proposals: { records: [
        { proposal_id: 'prop_1', kind: 'session', decision_state: 'pending', action_state: 'none',
          normalized_input: { title: 'Split the work' } },
        { proposal_id: 'prop_2', kind: 'git', decision_state: 'accepted', action_state: 'succeeded',
          normalized_input: { summary: 'done' } },
      ] },
      session_mail: { inbox: [{ read_at: null, context: { state: 'queued' } }, { read_at: T0, context: { state: 'included' } }] },
    } },
    followUps: [
      { id: 't1', sourceKind: 'agent_task', projectId: 'project_a', status: 'active', label: 'Open task' },
      { id: 't2', sourceKind: 'agent_task', projectId: 'project_a', status: 'resolved', label: 'Done task' },
      { id: 't3', sourceKind: 'agent_task', projectId: 'project_b', status: 'active', label: 'Other project' },
      { id: 't4', sourceKind: 'user', projectId: 'project_a', status: 'active', label: 'User follow-up' },
    ],
    notes: { project_a: { text: 'n'.repeat(1000), revision: 4, updatedAt: T0 } },
    workspace: { ok: true, summary: { changes: { state: 'available', data: { file_count: 3, additions: 10, deletions: 2,
      ref: 'main', head: 'abc', workspace_id: 'w' } } } },
  });
  const digest = await directory.digest({ callerSessionId: 'P', sessionId: 'A1' });
  assert.equal(digest.ok, true);
  assert.deepEqual(Object.keys(digest).sort(), ['children', 'inbox', 'ok', 'outputs_count', 'parent', 'project', 'proposals',
    'session', 'todo', 'transcript_tail']);
  assert.equal(digest.session.session_id, 'A1');
  for (const key of ['run_mode', 'plan_mode', 'lockdown', 'last_model_used', 'context_usage', 'compaction_context']) {
    assert.ok(Object.hasOwn(digest.session, key), key);
  }
  assert.deepEqual(digest.todo, { items: [{ content: 'write tests', status: 'completed' },
    { content: 'ship', status: 'in_progress' }], source_turn: 'turn_9' });
  assert.deepEqual(digest.proposals, [{ proposal_id: 'prop_1', kind: 'session', decision_state: 'pending',
    action_state: 'none', title: 'Split the work' }]);
  assert.deepEqual(digest.inbox, { unread: 1, queued: 1 });
  assert.deepEqual(digest.children, [{ session_id: 'C1', title: 'Chat C1', status: 'idle',
    last_outcome: { status: 'completed', updated_at: '2026-10-20T11:00:00.000Z', resumable: null } }]);
  assert.deepEqual(digest.parent, { session_id: 'A0', title: 'Chat A0' });
  assert.deepEqual(digest.project.open_tasks, [{ id: 't1', label: 'Open task', status: 'active' }]);
  assert.deepEqual({ ...digest.project.note, excerpt: digest.project.note.excerpt.length },
    { revision: 4, updated_at: T0, excerpt: 280 });
  assert.equal(digest.outputs_count, 1);
  assert.ok(digest.transcript_tail.length <= 12);
  assert.ok(digest.transcript_tail.reduce((sum, row) => sum + row.text.length, 0) <= 4000);
  assert.equal(digest.transcript_tail.at(-1).text.startsWith('row 19'), true);
  assert.deepEqual(Object.keys(digest.transcript_tail[0]).sort(), ['id', 'role', 'text', 'timestamp']);
  assert.deepEqual(calls.getSummary, [], 'changes are read only when asked');
  const withChanges = await directory.digest({ callerSessionId: 'P', sessionId: 'A1', includeChanges: true,
    includeTranscriptTail: false });
  assert.deepEqual(withChanges.changes, { file_count: 3, additions: 10, deletions: 2, ref: 'main' });
  assert.equal(Object.hasOwn(withChanges, 'transcript_tail'), false);
  assert.deepEqual(calls.getSummary, [{ schema_version: 1, session_id: 'A1' }]);
});

test('stop refuses the caller itself, stops a stream and queued work, and reports nothing running', async () => {
  const sessions = [chat('P', { session_role: 'primary' }), chat('busy'), chat('quiet'), chat('stale'), chat('resumed'),
    chat('lingering'), chat('refused')];
  // The accepted cancel clears busy's turn (the sidecar drained); lingering's turn stays past the budget.
  const activeTurns = { P: { stream_id: 'sp', status: 'streaming' }, busy: { stream_id: 'stream_busy', status: 'streaming' },
    stale: { stream_id: 'stream_stale', status: 'streaming' }, lingering: { stream_id: 'stream_linger', status: 'streaming' } };
  const { directory, calls } = fixture({
    sessions,
    activeTurns,
    cancelWork: (payload) => (payload.work_id === 'w_refused' ? { ok: false, reason: 'revision_conflict' } : { ok: true, cleanup_confirmed: true }),
    work: { busy: [workRow('busy', 'running'), workRow('busy', 'pending', { work_id: 'w_q', revision: 5 }),
      workRow('busy', 'paused', { work_id: 'w_p', revision: 7 }), workRow('busy', 'completed', { work_id: 'w_c' })],
      resumed: [workRow('resumed', 'running', { work_id: 'w_r', revision: 2 })],
      refused: [workRow('refused', 'pending', { work_id: 'w_refused', revision: 3 })] },
    cancelStream: (streamId) => { if (streamId === 'stream_busy') delete activeTurns.busy; return streamId !== 'stream_stale'; },
  });
  assert.deepEqual(await directory.stop({ callerSessionId: 'P', sessionId: 'P' }), { ok: false, reason: 'self' });
  assert.deepEqual(await directory.stop({ callerSessionId: 'P', sessionId: 'busy' }),
    { ok: true, session_id: 'busy', stopped: { stream: true, queued_work: 2 }, cleanup: 'confirmed' });
  assert.deepEqual(calls.cancelStream[0], ['stream_busy', 'user_cancel']);
  assert.deepEqual(calls.cancel, [{ work_id: 'w_q', expected_revision: 5 }, { work_id: 'w_p', expected_revision: 7 }]);
  assert.deepEqual(await directory.stop({ callerSessionId: 'P', sessionId: 'quiet' }),
    { ok: true, session_id: 'quiet', stopped: { stream: false, queued_work: 0 }, cleanup: 'nothing_running' });
  assert.deepEqual(await directory.stop({ callerSessionId: 'P', sessionId: 'stale' }),
    { ok: true, session_id: 'stale', stopped: { stream: false, queued_work: 0 }, cleanup: 'uncertain' });
  assert.deepEqual(await directory.stop({ callerSessionId: 'P', sessionId: 'resumed' }),
    { ok: true, session_id: 'resumed', stopped: { stream: false, queued_work: 1 }, cleanup: 'confirmed' },
    'work running without a live stream (a resumed run) is cancelled too');
  assert.deepEqual(await directory.stop({ callerSessionId: 'P', sessionId: 'lingering' }),
    { ok: true, session_id: 'lingering', stopped: { stream: false, queued_work: 0 }, cleanup: 'uncertain' },
    'an accepted abort whose turn never clears is not confirmed');
  assert.deepEqual(await directory.stop({ callerSessionId: 'P', sessionId: 'refused' }),
    { ok: true, session_id: 'refused', stopped: { stream: false, queued_work: 0 }, cleanup: 'uncertain' },
    'a refused work cancel reads uncertain');
});

test('missing getters degrade to unknown facts instead of throwing', async () => {
  const empty = createSessionDirectoryService({});
  assert.deepEqual(empty.list({ callerSessionId: 'P' }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await empty.digest({ callerSessionId: 'P', sessionId: 'A' }), { ok: false, reason: 'unavailable' });
  const sessions = [chat('P', { session_role: 'primary' }), chat('A')];
  const store = { listSessionRecords: () => sessions.map((entry) => ({ ...entry, active_turn: null })),
    getSessionSummary: (id) => sessions.find((entry) => entry.id === id) || null };
  // No visibility predicate wired: fail closed, nothing but the caller is in scope.
  const blind = createSessionDirectoryService({ sessionStore: () => store });
  assert.deepEqual(blind.list({ callerSessionId: 'P', scope: 'all' }).rows, []);
  const open = createSessionDirectoryService({ sessionStore: () => store, visibleChat: () => () => true });
  const digest = await open.digest({ callerSessionId: 'P', sessionId: 'A' });
  assert.equal(digest.ok, true);
  assert.equal(digest.session.status, 'idle');
  assert.equal(digest.session.last_outcome, null);
  assert.equal(digest.todo, null);
  assert.deepEqual(digest.transcript_tail, []);
  assert.equal(digest.project.note, null);
});

test('rows and the digest carry the chat\'s preferred model, empty meaning the Settings default', async () => {
  const sessions = [chat('P', { session_role: 'primary' }), chat('pinned', { preferred_model: 'ornith15:9b-q6-256k' }),
    chat('plain'), chat('blank', { preferred_model: '' })];
  const { directory } = fixture({ sessions });
  const rows = Object.fromEntries(directory.list({ callerSessionId: 'P', scope: 'all' }).rows.map((entry) => [entry.session_id, entry]));
  assert.equal(rows.pinned.preferred_model, 'ornith15:9b-q6-256k');
  assert.equal(rows.plain.preferred_model, '');
  assert.equal(rows.blank.preferred_model, '');
  const digest = await directory.digest({ callerSessionId: 'P', sessionId: 'pinned' });
  assert.equal(digest.session.preferred_model, 'ornith15:9b-q6-256k');
  assert.equal(digest.session.last_model_used, 'model');
  assert.equal((await directory.digest({ callerSessionId: 'P', sessionId: 'plain' })).session.preferred_model, '');
});

test('a failed chat\'s digest says why its last turn failed, bounded and only for a failed outcome', async () => {
  const failure = { id: 'm2', role: 'assistant', turn_id: 't9', status: 'failed', content: '',
    stream_error: `Model "ornith15:9b" is not loaded.\n${'x'.repeat(400)}`, error_code: 'CMP-ENGINE-0042' };
  const sessions = [chat('P', { session_role: 'primary' }), chat('broke'), chat('ok'), chat('stale')];
  const { directory } = fixture({ sessions,
    work: { broke: [workRow('broke', 'failed', { turn_id: 't9' })], ok: [workRow('ok', 'completed')],
      stale: [workRow('stale', 'failed', { turn_id: 't9' })] },
    messages: { broke: [{ id: 'm1', role: 'user', turn_id: 't9', content: 'go' }, failure],
      ok: [failure], stale: [{ ...failure, turn_id: 't1' }, { id: 'm3', role: 'user', turn_id: 't9', content: 'again' }] } });
  const broke = (await directory.digest({ callerSessionId: 'P', sessionId: 'broke' })).session;
  assert.equal(broke.last_error_code, 'CMP-ENGINE-0042');
  assert.equal(broke.last_error.length <= 200, true);
  assert.equal(broke.last_error.startsWith('Model "ornith15:9b" is not loaded.'), true);
  assert.equal(broke.last_error.includes('\n'), false);
  const ok = (await directory.digest({ callerSessionId: 'P', sessionId: 'ok' })).session;
  assert.equal(Object.hasOwn(ok, 'last_error'), false, 'a completed turn carries no failure summary');
  assert.equal(Object.hasOwn(ok, 'last_error_code'), false);
  const stale = (await directory.digest({ callerSessionId: 'P', sessionId: 'stale' })).session;
  assert.equal(Object.hasOwn(stale, 'last_error'), false, 'an older turn\'s error is not this failure');
});
