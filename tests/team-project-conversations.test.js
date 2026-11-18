'use strict';

// new-test-file: the unit lane of the shared-project client (row 123 slice 3-9 fix list) — project-conversations.js
// and project-list.js against a fake manager and fake timers, with no host: the lease and view rules under a rate
// hold, the closed lists, a project removed or re-roled while open, the snapshot id check, the Force local gate, the
// count pushes and the truncated conversation list. tests/team-project-ipc.test.js runs the same modules against the
// real host.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRateLimiter } = require('../server/team/rate-limit');
const { VIEW_LIMIT } = require('../server/team/team-approvals');
const { LEASE_ENDING, VIEW_ENDING, createProjectConversations } = require('../services/team/project-conversations');
const { createProjectList } = require('../services/team/project-list');
const { fakeTimers } = require('./helpers/team-project-client-host');

const SESSION = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT = 'project_aaaaaaaaaaaa';
const turn = () => new Promise((resolve) => setImmediate(resolve));
const hostFailure = (reason, code = 'CMP-HOST-0003') => ({ ok: false, error: { code, reason } });
const snapshot = (sessionId = SESSION, revision = 'boot:1') => ({ ok: true, snapshot: { cursor: 1,
  session: { session_id: sessionId, title: 'T', revision, plan_mode: false }, messages: [], message_count: 0,
  has_more: false, active_turn: null, pending_approvals: [], pending_questions: [] } });
const lease = (clientId = 'client_me', generation = 1) => ({ ok: true,
  lease: { session_id: SESSION, client_id: clientId, generation, member_id: 'member_me', expires_at: 1 } });

// A fake manager: `answers[operation]` (a value or a function of params and envelope) answers each command.
function fakeManager(answers = {}) {
  const sent = [];
  const defaults = { 'sessions.snapshot': () => snapshot(), 'session.view': { ok: true, viewing: true, viewers: [] },
    'control.acquire': lease(), 'control.heartbeat': lease(), 'control.release': { ok: true } };
  return {
    sent,
    count: (operation) => sent.filter((one) => one.operation === operation).length,
    command: async (operation, params, { envelope = {} } = {}) => {
      sent.push({ operation, params, envelope });
      const answer = Object.hasOwn(answers, operation) ? answers[operation] : defaults[operation];
      return typeof answer === 'function' ? answer(params, envelope) : answer ?? { ok: true };
    },
  };
}

function conversations(manager, options = {}) {
  const timers = fakeTimers();
  const pushes = [];
  const conv = createProjectConversations({ manager, teamId: 'team_a', online: () => true, timers,
    push: (payload) => pushes.push(payload), ...options });
  return { conv, timers, pushes, last: (kind) => [...pushes].reverse().find((p) => p.kind === kind) };
}

test('the closed lists: rate limits and the manager hold end nothing; a lease refusal is named', () => {
  for (const reason of ['team_rate_limit', 'team_view_rate_limit', 'team_not_connected', 'team_unavailable']) {
    assert.equal(LEASE_ENDING.has(reason), false, reason);
    assert.equal(VIEW_ENDING.has(reason), false, reason);
  }
  assert.ok(LEASE_ENDING.has('control_lease_required'));
  assert.ok(VIEW_ENDING.has('session_not_found'));
});

test('a held manager answer during a heartbeat keeps the lease; a successful one keeps it; a takeover drops it', async () => {
  let heartbeat = hostFailure('team_rate_limit', 'CMP-HOST-0007'); // the manager's own hold keeps the host's code
  const manager = fakeManager({ 'control.heartbeat': () => heartbeat });
  const { conv, timers, last } = conversations(manager);
  await conv.call('conversationOpen', { session_id: SESSION });
  await conv.call('conversationControl', { session_id: SESSION, action: 'take' });
  timers.tick();
  await turn();
  assert.equal(last('lease').held, true, 'a rate hold keeps the lease');
  heartbeat = lease();
  timers.tick();
  await turn();
  assert.equal(last('lease').held, true, 'a successful heartbeat keeps it');
  // A real takeover: control_changed naming another client ends it, and no heartbeat goes after that (fix 20).
  conv.onEvent({ event_type: 'control_changed', session_id: SESSION, client_id: 'client_other', member_id: 'member_x', expires_at: 5 });
  assert.deepEqual([last('lease').held, last('lease').reason], [false, 'control_changed']);
  const beats = manager.count('control.heartbeat');
  for (let i = 0; i < 3; i += 1) { timers.tick(); await turn(); }
  assert.equal(manager.count('control.heartbeat'), beats, 'no heartbeat after a takeover');
  conv.stop();
});

test('a refused heartbeat ends the lease with a checked reason word (fix 3)', async () => {
  for (const [reason, shown] of [['control_lease_required', 'control_lease_required'],
    ['a long reason with spaces <marker> '.repeat(4), null]]) {
    const manager = fakeManager({ 'control.heartbeat': hostFailure(reason) });
    const { conv, timers, pushes, last } = conversations(manager);
    await conv.call('conversationOpen', { session_id: SESSION });
    await conv.call('conversationControl', { session_id: SESSION, action: 'take' });
    timers.tick();
    await turn();
    if (shown) assert.deepEqual([last('lease').held, last('lease').reason], [false, shown]);
    else assert.equal(last('lease').held, true, 'an unchecked reason is not a lease refusal, and it is never pushed');
    assert.equal(JSON.stringify(pushes).includes('<marker>'), false);
    conv.stop();
  }
});

test('a view refused as not readable forgets the conversation and pushes closed; a rate refusal changes nothing', async () => {
  let view = hostFailure('team_view_rate_limit', 'CMP-HOST-0007');
  const manager = fakeManager({ 'session.view': () => view });
  const { conv, timers, pushes, last } = conversations(manager);
  await conv.call('conversationOpen', { session_id: SESSION });
  await conv.call('conversationControl', { session_id: SESSION, action: 'take' });
  timers.tick();
  await turn();
  assert.equal(conv.isOpen(SESSION), true);
  assert.equal(pushes.some((p) => p.kind === 'closed'), false);
  view = hostFailure('team_not_found', 'CMP-HOST-0002');
  timers.tick();
  await turn();
  assert.deepEqual(last('closed'), { team_id: 'team_a', kind: 'closed', session_id: SESSION, reason: 'team_not_found' });
  assert.deepEqual([conv.isOpen(SESSION), timers.size()], [false, 0], 'both timers stopped');
  // No view after close (fix 20).
  const views = manager.count('session.view');
  for (let i = 0; i < 3; i += 1) { timers.tick(); await turn(); }
  assert.equal(manager.count('session.view'), views);
});

test('8 open conversations on 3 devices for two minutes at the host view limit: no refusal, leases held, decisions answer', async () => {
  let now = 0;
  const viewLimiter = createRateLimiter({ ...VIEW_LIMIT, clock: () => now });
  const decisionLimiter = createRateLimiter({ limit: 60, windowMs: 60_000, maxKeys: 64, clock: () => now });
  const refused = [];
  // One member, three devices: the host's two per-member counters are shared by all three.
  const devices = Array.from({ length: 3 }, (_, device) => {
    const manager = fakeManager({
      'session.view': () => (viewLimiter.take('member_me') ? { ok: true, viewing: true, viewers: ['member_me'] }
        : (refused.push('view'), hostFailure('team_view_rate_limit', 'CMP-HOST-0007'))),
      'control.acquire': lease(`client_${device}`), 'control.heartbeat': lease(`client_${device}`),
      'approval.resolve': () => (decisionLimiter.take('member_me') ? { ok: true, revision: 'boot:2' }
        : (refused.push('decision'), hostFailure('team_rate_limit', 'CMP-HOST-0007'))),
      'sessions.snapshot': (params, envelope) => snapshot(envelope.session_id),
    });
    return { manager, ...conversations(manager) };
  });
  const sessions = Array.from({ length: 8 }, (_, i) => `sess_${String(i).repeat(32)}`);
  for (const device of devices) {
    for (const sessionId of sessions) assert.equal((await device.conv.call('conversationOpen', { session_id: sessionId })).ok, true);
    await device.conv.call('conversationControl', { session_id: sessions[0], action: 'take' });
  }
  // Two minutes of 20 s ticks, one decision a minute on each device.
  for (let tick = 0; tick < 6; tick += 1) {
    now += 20_000;
    for (const device of devices) device.timers.tick();
    await turn();
    if (tick % 3 === 0) {
      for (const device of devices) {
        const decided = await device.conv.call('conversationDecide', { session_id: sessions[0], stream_id: 'stream_1',
          approval_id: 'approval_1', decision_revision: 'rev_1', approved: true });
        assert.equal(decided.ok, true, JSON.stringify(decided));
      }
    }
  }
  assert.deepEqual(refused, []);
  for (const device of devices) {
    assert.equal(device.last('lease').held, true, 'no lost lease');
    assert.equal(device.pushes.some((p) => p.kind === 'closed'), false);
    device.conv.stop();
  }
});

test('after a reconnect an open conversation is viewed and its lease proven at once (fix 20)', async () => {
  const manager = fakeManager();
  const { conv } = conversations(manager);
  await conv.call('conversationOpen', { session_id: SESSION });
  await conv.call('conversationControl', { session_id: SESSION, action: 'take' });
  await turn();
  const [views, beats] = [manager.count('session.view'), manager.count('control.heartbeat')];
  conv.reconnected();
  await turn();
  assert.deepEqual([manager.count('session.view') - views, manager.count('control.heartbeat') - beats], [1, 1]);
  conv.stop();
});

test('chat_stream events are forwarded in order for an open conversation, rebuilt', async () => {
  const { conv, pushes } = conversations(fakeManager());
  await conv.call('conversationOpen', { session_id: SESSION });
  for (const type of ['started', 'token', 'token', 'complete']) {
    conv.onEvent({ event_type: 'chat_stream', session_id: SESSION, stream_id: 'stream_1', event: { type, extra: 1 },
      client_id: 'never_forwarded' });
  }
  const forwarded = pushes.filter((p) => p.kind === 'conversation_event');
  assert.deepEqual(forwarded.map((p) => p.event.event.type), ['started', 'token', 'token', 'complete']);
  assert.equal(JSON.stringify(forwarded).includes('never_forwarded'), false);
  conv.stop();
});

// Owner's live drive, 2026-11-16: the prompt showed only at the turn's end, and a stopped turn's saved row never came.
test('a turn starting, a tool call and its result, a stream reset (row 175) and a turn stopped, read the snapshot again and push it', async () => {
  for (const type of ['started', 'tool_use', 'tool_result', 'stream_reset', 'cancelled']) {
    const manager = fakeManager();
    const { conv, pushes } = conversations(manager);
    await conv.call('conversationOpen', { session_id: SESSION });
    await turn();
    const before = manager.sent.length;
    conv.onEvent({ event_type: 'chat_stream', session_id: SESSION, stream_id: 'stream_1', event: { type } });
    await turn();
    await turn();
    assert.deepEqual(operations(manager, before), ['sessions.snapshot'], type);
    assert.equal(pushes.filter((p) => p.kind === 'snapshot').length, 1, type);
    conv.stop();
  }
});

test('a snapshot naming another conversation is refused (fix 27)', async () => {
  const manager = fakeManager({ 'sessions.snapshot': () => snapshot('sess_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') });
  const { conv, timers } = conversations(manager);
  const opened = await conv.call('conversationOpen', { session_id: SESSION });
  assert.deepEqual(opened.error.reason, 'team_answer_invalid');
  assert.deepEqual([conv.isOpen(SESSION), timers.size()], [false, 0]);
});

test('reconcile: a project gone closes its open conversation; a reader role drops a held lease (fix 5)', async () => {
  const manager = fakeManager();
  const { conv, timers, last } = conversations(manager, { projectOf: () => PROJECT });
  await conv.call('conversationOpen', { session_id: SESSION });
  await conv.call('conversationControl', { session_id: SESSION, action: 'take' });
  conv.reconcile([{ id: PROJECT, role: 'writer' }]);
  assert.equal(last('lease').held, true);
  conv.reconcile([{ id: PROJECT, role: 'reader' }]);
  assert.deepEqual([last('lease').held, last('lease').reason], [false, 'team_project_read_only']);
  assert.equal(timers.size(), 1, 'the viewing timer stays: a reader still reads');
  conv.reconcile([]);
  assert.deepEqual(last('closed'), { team_id: 'team_a', kind: 'closed', session_id: SESSION, reason: 'project_not_found' });
  assert.deepEqual([conv.isOpen(SESSION), timers.size()], [false, 0]);
});

// ---- project-list.js ----

function listOf(answers, options = {}) {
  const manager = fakeManager(answers);
  const pushes = [];
  const list = createProjectList({ manager, teamId: 'team_a', push: (payload) => pushes.push(payload), ...options });
  return { manager, list, pushes };
}
const PROJECTS = { ok: true, projects: [{ id: PROJECT, name: 'Atlas', root_revision: 1, role: 'writer' }], files_supported: true };
const row = (i, extra = {}) => ({ session_id: `sess_${String(i % 10).repeat(16)}${String(i).padStart(16, '0')}`, title: `T${i}`,
  project_id: PROJECT, ...extra });

test('while Force local holds, an event sends no list read (fix 6)', async () => {
  let held = false;
  const { manager, list } = listOf({ 'projects.list': PROJECTS, 'sessions.list': { ok: true, sessions: [] } },
    { isHeld: () => held });
  await list.refresh();
  const before = manager.sent.length;
  held = true;
  list.onEvent({ event_type: 'team_project_changed', project_id: PROJECT, reason: 'renamed' });
  list.onEvent({ event_type: 'resync_required' });
  list.onEvent({ event_type: 'session_changed', session_id: row(1).session_id, reason: 'created' });
  await turn();
  assert.equal(manager.sent.length, before, 'zero requests');
  assert.equal(await list.refresh(), null);
});

test('counts read only what they need, push the changed entry alone, and clear on a resync (fixes 13, 14, 16)', async () => {
  const { list, pushes } = listOf({ 'projects.list': PROJECTS, 'sessions.list': { ok: true, sessions: [row(1)] } });
  await list.refresh();
  const sessionId = row(1).session_id;
  const before = pushes.length;
  // A stream event of a kind no count needs is not copied: a body that cannot be serialised is never touched.
  const cyclic = { type: 'token' };
  cyclic.self = cyclic;
  list.onEvent({ event_type: 'chat_stream', session_id: sessionId, stream_id: 'stream_1', event: cyclic });
  assert.equal(pushes.length, before);
  list.onEvent({ event_type: 'chat_stream', session_id: sessionId, stream_id: 'stream_1', event: { type: 'started', big: cyclic } });
  assert.deepEqual(pushes.at(-1), { kind: 'activity', team_id: 'team_a', session_id: sessionId, approvals: 0, running: true });
  list.onEvent({ event_type: 'approval_unattended', session_id: sessionId, stream_id: 'stream_1', approval_id: 'approval_1',
    prompter_member_id: null });
  assert.equal(pushes.at(-1).approvals, 1);
  list.onEvent({ event_type: 'resync_required' });
  assert.deepEqual(list.view().activity, {}, 'cleared on a resync');
  list.onEvent({ event_type: 'chat_stream', session_id: sessionId, stream_id: 'stream_1', event: { type: 'started' } });
  list.clearActivity();
  assert.deepEqual(list.view().activity, {}, 'cleared on a reconnect');
  list.stop();
});

test('sessions.list keeps its first 2,000 rows that pass and marks the list truncated (fix 11)', async () => {
  const rows = Array.from({ length: 2_100 }, (_, i) => row(i));
  rows.splice(5, 0, { session_id: 'not a session', title: 'bad', project_id: PROJECT });
  const { list, pushes } = listOf({ 'projects.list': PROJECTS, 'sessions.list': { ok: true, sessions: rows } });
  assert.equal((await list.refresh()).ok, true);
  const view = pushes.at(-1);
  assert.deepEqual([view.conversations.length, view.conversations_truncated], [2_000, true]);
  assert.equal(view.conversations.some((one) => one.title === 'bad'), false);
  const small = listOf({ 'projects.list': PROJECTS, 'sessions.list': { ok: true, sessions: [row(1)] } });
  await small.list.refresh();
  assert.equal(small.pushes.at(-1).conversations_truncated, false);
});

test('F1: the owner\'s list with General pushes the other rows, never null, and keeps their conversations', async () => {
  const general = { id: 'project_general', name: 'General', root_revision: 0, role: 'owner' };
  const { list, pushes } = listOf({
    'projects.list': { ok: true, projects: [general, ...PROJECTS.projects], files_supported: true },
    'sessions.list': { ok: true, sessions: [row(1, { project_id: 'project_general' }), row(2), row(3, { project_id: undefined })] } });
  assert.equal((await list.refresh()).ok, true);
  const view = pushes.filter((p) => p.kind === 'projects').at(-1);
  assert.deepEqual(view.projects.map((p) => p.id), [PROJECT]);
  assert.equal(view.projects_truncated, false);
  assert.deepEqual([view.conversations.map((c) => c.title), view.conversations_truncated], [['T2'], false]);
  assert.deepEqual(list.conversationsOf(PROJECT).map((c) => c.title), ['T2']);
  const bad = listOf({ 'projects.list': { ok: true, projects: [{ id: 1 }, ...PROJECTS.projects], files_supported: true },
    'sessions.list': { ok: true, sessions: [] } });
  await bad.list.refresh();
  assert.deepEqual([bad.pushes.at(-1).projects.length, bad.pushes.at(-1).projects_truncated], [1, true]);
});

test('F1: a read an event overtook is read again before the caller is answered, never ok over an empty list', async () => {
  let overtake = 2;
  let list = null;
  const sessions = { ok: true, sessions: [row(1)] };
  const built = listOf({ 'projects.list': () => {
    if (overtake-- > 0) list.onEvent({ event_type: 'session_changed', session_id: row(1).session_id, reason: 'created' });
    return PROJECTS;
  }, 'sessions.list': sessions });
  list = built.list;
  const answer = await list.refresh();
  assert.equal(answer.ok, true);
  assert.deepEqual(list.view().projects.map((p) => p.id), [PROJECT], 'the rows were taken');
  assert.deepEqual(list.conversationsOf(PROJECT).map((c) => c.title), ['T1']);
  // Overtaken more times than a caller waits: a retryable refusal, not an ok with nothing; the re-read that follows
  // takes the rows once events stop.
  // (a conversation event: it overtakes the projects read without starting a projects read of its own)
  let stormy = null;
  let storming = 3; // exactly the reads a caller waits through
  const storm = listOf({ 'projects.list': () => {
    if (storming-- > 0) stormy.onEvent({ event_type: 'session_changed', session_id: row(1).session_id, reason: 'created' });
    return PROJECTS;
  }, 'sessions.list': sessions });
  stormy = storm.list;
  assert.equal((await stormy.refresh()).error.reason, 'team_not_connected');
  for (let i = 0; i < 50 && !stormy.knows(PROJECT); i += 1) await turn();
  assert.equal(stormy.knows(PROJECT), true, 'taken once events stopped');
  stormy.stop();
  list.stop();
});

test('the list is current only while events kept it so; a change this client made marks it stale', async () => {
  const { list } = listOf({ 'projects.list': PROJECTS, 'sessions.list': { ok: true, sessions: [] } });
  assert.equal(list.current(), false);
  await list.refresh();
  assert.equal(list.current(), true);
  list.markStale();
  assert.equal(list.current(), false);
  await list.refresh();
  assert.equal(list.current(), true);
});

// Row 169: the list's row menu renames and deletes without making the member the driver, open or not.
const operations = (manager, from = 0) => manager.sent.slice(from).map((one) => one.operation);

test('row 169: a rename of a conversation that is not open reads its revision, borrows the lease and hands it back', async () => {
  const manager = fakeManager({ 'sessions.snapshot': () => snapshot(SESSION, 'boot:7'), 'control.acquire': lease('client_me', 4),
    'sessions.rename': { ok: true, session_id: SESSION, title: 'Plan B', revision: 'boot:8' } });
  const { conv, pushes } = conversations(manager);
  const answer = await conv.call('conversationRename', { session_id: SESSION, title: 'Plan B' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(operations(manager), ['sessions.snapshot', 'control.acquire', 'sessions.rename', 'control.release']);
  assert.deepEqual(manager.sent[0].params, { max_messages: 1 });
  assert.deepEqual(manager.sent[2].params, { title: 'Plan B' });
  assert.deepEqual([manager.sent[2].envelope.control_generation, manager.sent[2].envelope.expected_revision], [4, 'boot:7']);
  assert.equal(manager.sent[3].envelope.control_generation, 4);
  assert.deepEqual(conv.resources(), { conversations: 0, timers: 0 }, 'nothing is opened: no viewing, no slot, no heartbeat');
  assert.deepEqual(pushes, [], 'no lease push: the member is not shown as the driver');
  conv.stop();
});

test('row 169: an open conversation without the lease borrows it for a rename; with the lease held nothing is borrowed', async () => {
  const manager = fakeManager({ 'sessions.rename': { ok: true, session_id: SESSION, title: 'B', revision: 'boot:2' } });
  const { conv, pushes } = conversations(manager);
  await conv.call('conversationOpen', { session_id: SESSION });
  await turn();
  let from = manager.sent.length;
  assert.equal((await conv.call('conversationRename', { session_id: SESSION, title: 'B' })).ok, true);
  assert.deepEqual(operations(manager, from), ['control.acquire', 'sessions.rename', 'control.release']);
  assert.equal(manager.sent[from + 1].envelope.expected_revision, 'boot:1', 'the open conversation\'s revision, no extra read');
  assert.equal(pushes.some((p) => p.kind === 'lease'), false);
  assert.deepEqual(conv.resources(), { conversations: 1, timers: 1 }, 'the view timer only: no heartbeat for a borrowed lease');
  await conv.call('conversationControl', { session_id: SESSION, action: 'take' });
  from = manager.sent.length;
  assert.equal((await conv.call('conversationRename', { session_id: SESSION, title: 'C' })).ok, true);
  assert.deepEqual(operations(manager, from), ['sessions.rename'], 'the driver renames under the lease it holds and keeps it');
  assert.equal(manager.sent[from].envelope.expected_revision, 'boot:2', 'the borrowed rename\'s revision was kept');
  assert.equal([...pushes].reverse().find((p) => p.kind === 'lease').held, true);
  conv.stop();
});

test('row 169: a refused borrow sends nothing more; a refused command still hands the lease back', async () => {
  const taken = fakeManager({ 'control.acquire': hostFailure('control_lease_unavailable') });
  const first = conversations(taken);
  const refused = await first.conv.call('conversationRename', { session_id: SESSION, title: 'B' });
  assert.equal(refused.error.reason, 'control_lease_unavailable');
  assert.deepEqual(operations(taken), ['sessions.snapshot', 'control.acquire']);
  const gone = fakeManager({ 'sessions.snapshot': hostFailure('session_not_found') });
  assert.equal((await conversations(gone).conv.call('conversationDelete', { session_id: SESSION })).error.reason, 'session_not_found');
  assert.deepEqual(operations(gone), ['sessions.snapshot']);
  const busy = fakeManager({ 'sessions.delete': hostFailure('session_active') });
  const second = conversations(busy);
  assert.equal((await second.conv.call('conversationDelete', { session_id: SESSION })).error.reason, 'session_active');
  assert.deepEqual(operations(busy), ['sessions.snapshot', 'control.acquire', 'sessions.delete', 'control.release']);
});

test('row 169: a delete from the list keeps no lease and forgets an open conversation', async () => {
  const manager = fakeManager({ 'sessions.delete': { ok: true, session_id: SESSION, deleted: true } });
  const closed = conversations(manager);
  assert.equal((await closed.conv.call('conversationDelete', { session_id: SESSION })).ok, true);
  assert.deepEqual(operations(manager), ['sessions.snapshot', 'control.acquire', 'sessions.delete'], 'a deleted conversation has no lease to hand back');
  const opened = conversations(manager);
  await opened.conv.call('conversationOpen', { session_id: SESSION });
  assert.equal((await opened.conv.call('conversationDelete', { session_id: SESSION })).ok, true);
  assert.equal(opened.conv.isOpen(SESSION), false);
  assert.deepEqual(opened.conv.resources(), { conversations: 0, timers: 0 });
});

test('row 169: the page before a message is read for an open conversation only, answered and not pushed', async () => {
  const older = { ...snapshot().snapshot, messages: [{ id: 'm1', role: 'user', content: 'first' }], message_count: 30, has_more: true,
    next_before_message_id: 'm1' };
  const manager = fakeManager({ 'sessions.snapshot': (params) => (params.before_message_id ? { ok: true, snapshot: older } : snapshot()) });
  const { conv, pushes } = conversations(manager);
  const early = await conv.call('conversationOpen', { session_id: SESSION, before_message_id: 'm21' });
  assert.equal(early.error.reason, 'team_conversation_not_open');
  assert.equal(manager.sent.length, 0, 'a page of a conversation that is not open opens nothing');
  await conv.call('conversationOpen', { session_id: SESSION });
  await turn();
  const from = manager.sent.length;
  const page = await conv.call('conversationOpen', { session_id: SESSION, before_message_id: 'm21' });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.deepEqual(manager.sent[from].params, { max_messages: 20, before_message_id: 'm21' });
  assert.deepEqual([page.snapshot.messages.length, page.snapshot.has_more, page.snapshot.next_before_message_id], [1, true, 'm1']);
  assert.equal(pushes.some((p) => p.kind === 'snapshot'), false);
  assert.deepEqual(conv.resources(), { conversations: 1, timers: 1 });
  // A rename by anybody reaches the open view: the event carries no title, so the snapshot is read again and pushed.
  const before = manager.sent.length;
  conv.onEvent({ event_type: 'session_changed', session_id: SESSION, revision: 'boot:9', reason: 'renamed' });
  await turn();
  await turn();
  assert.deepEqual(operations(manager, before), ['sessions.snapshot']);
  assert.equal(pushes.filter((p) => p.kind === 'snapshot').length, 1);
  conv.stop();
});

// Owner report (team overview B3): the host names a new conversation while it saves the first turn and sends no
// `renamed` for it. After a saved turn, or the end of a run, the conversations are read again while the row still
// carries the title it was first listed with (at most twice per conversation); a title that moved costs no more reads.
test('a title the host sets while saving a turn reaches the list; a long conversation is not read per turn', async () => {
  const titles = { 1: 'New Chat', 2: 'New Chat', 3: 'Kept name' };
  const { manager, list, pushes } = listOf({ 'projects.list': PROJECTS,
    'sessions.list': () => ({ ok: true, sessions: [1, 2, 3].map((i) => row(i, { title: titles[i] })) }) });
  await list.refresh();
  const titleOf = (i) => pushes.filter((p) => p.kind === 'projects').at(-1).conversations.find((c) => c.session_id === row(i).session_id).title;
  const saved = (i) => ({ event_type: 'session_changed', session_id: row(i).session_id, revision: 'boot:2', reason: 'chat_saved' });
  const ended = (i) => ({ event_type: 'chat_stream', session_id: row(i).session_id, stream_id: 'stream_1', event: { type: 'complete' } });
  const settle = async () => { for (let i = 0; i < 6; i += 1) await turn(); };
  titles[1] = 'Hello';
  list.onEvent(saved(1));
  await settle();
  assert.equal(titleOf(1), 'Hello', 'the first saved turn brings the host title');
  let reads = manager.count('sessions.list');
  for (let n = 0; n < 4; n += 1) { list.onEvent(saved(1)); list.onEvent(ended(1)); await settle(); }
  assert.equal(manager.count('sessions.list'), reads, 'a title that moved costs no read per turn');
  // Named only as the turn ends: the save reads the default, the end of the run reads the name.
  list.onEvent(saved(2));
  await settle();
  assert.equal(titleOf(2), 'New Chat');
  titles[2] = 'Late name';
  list.onEvent(ended(2));
  await settle();
  assert.equal(titleOf(2), 'Late name');
  // A conversation that keeps its first title: two reads at most, then none per turn.
  reads = manager.count('sessions.list');
  for (let n = 0; n < 5; n += 1) { list.onEvent(saved(3)); await settle(); }
  assert.equal(manager.count('sessions.list') - reads, 2, 'bounded for the life of the conversation');
  list.stop();
});

// Row 172: the conversation's model, effort and tool switches go as sessions.preferences under the lease, as a send.
test('row 172: conversationPreferences takes the lease, sends exactly the three keys and answers the revision', async () => {
  const manager = fakeManager({ 'sessions.preferences': { ok: true, revision: 'boot:2',
    session: { session_id: SESSION, title: 'T', root_path: '/host/secret' } } });
  const { conv, last } = conversations(manager);
  await conv.call('conversationOpen', { session_id: SESSION });
  const answer = await conv.call('conversationPreferences', { team_id: 'team_a', session_id: SESSION,
    preferred_model: null, reasoning_effort: 'high', team_tools: { write: false } });
  assert.deepEqual(answer, { ok: true, revision: 'boot:2' }, 'the session object never reaches the renderer');
  assert.equal(last('lease').held, true, 'the lease was taken first');
  const sent = manager.sent.find((one) => one.operation === 'sessions.preferences');
  assert.deepEqual(sent.params, { preferred_model: null, reasoning_effort: 'high', team_tools: { write: false } });
  assert.deepEqual([sent.envelope.control_generation, sent.envelope.expected_revision], [1, 'boot:1']);
  await conv.call('conversationPreferences', { session_id: SESSION, team_tools: { read: true } });
  assert.equal(manager.sent.filter((one) => one.operation === 'sessions.preferences').at(-1).envelope.expected_revision, 'boot:2',
    'the answer\'s revision is the next command\'s');
  conv.stop();
});

test('row 172: a preferences change re-reads the snapshot for every viewer', async () => {
  const manager = fakeManager();
  const { conv, pushes } = conversations(manager);
  await conv.call('conversationOpen', { session_id: SESSION });
  await turn();
  const before = manager.sent.length;
  conv.onEvent({ event_type: 'session_changed', session_id: SESSION, revision: 'boot:3', reason: 'preferences' });
  await turn();
  await turn();
  assert.deepEqual(operations(manager, before), ['sessions.snapshot']);
  assert.equal(pushes.filter((p) => p.kind === 'snapshot').length, 1);
  conv.stop();
});

// Row 175 (F2, D1, D2): project activity notices and the approvals that wait for this member.
const stream = (type, over = {}) => ({ event_type: 'chat_stream', session_id: row(1).session_id, stream_id: over.stream || 'stream_1',
  event: { type, ...over.event } });
async function noticeList(role = 'writer', viewing = () => false) {
  const projects = { ...PROJECTS, projects: [{ ...PROJECTS.projects[0], role }] };
  const f = listOf({ 'projects.list': projects, 'sessions.list': { ok: true, sessions: [row(1)] } }, { isViewing: viewing });
  await f.list.refresh();
  return { ...f, notices: () => f.pushes.filter((p) => p.kind === 'project_notice').map((p) => p.notice),
    waiting: () => f.pushes.filter((p) => p.kind === 'project_waiting').map((p) => p.count) };
}

test('row 175: this member\'s own turn tells when it waits, asks and ends; each once; a cancel and another turn tell nothing', async () => {
  const f = await noticeList();
  const sid = row(1).session_id;
  f.list.onEvent(stream('started', { stream: 'stream_other' }));
  f.list.onEvent(stream('complete', { stream: 'stream_other' }));
  assert.deepEqual(f.notices(), [], 'a turn this app did not send');
  f.list.sending(sid);
  f.list.sent(sid, 'turn_1');
  f.list.onEvent(stream('started', { event: { turn_id: 'turn_1' } }));
  f.list.onEvent(stream('tool_approval_needed', { event: { approval_id: 'approval_1' } }));
  f.list.onEvent({ event_type: 'approval_unattended', session_id: sid, stream_id: 'stream_1', approval_id: 'approval_1', prompter_member_id: null });
  f.list.onEvent(stream('question_batch', { event: { call_id: 'call_q' } }));
  f.list.onEvent(stream('question_batch', { event: { call_id: 'call_q' } }));
  f.list.onEvent({ event_type: 'decision_changed', session_id: sid, stream_id: 'stream_1', approval_id: 'approval_1' });
  f.list.onEvent(stream('complete'));
  f.list.onEvent(stream('complete'));
  assert.deepEqual(f.notices(), ['approval', 'question', 'finished'], 'the unattended one shares the approval id');
  assert.deepEqual(f.waiting(), [1, 0], 'counted while it waits, cleared by the decision');
  const told = f.pushes.find((p) => p.kind === 'project_notice');
  assert.deepEqual(Object.keys(told).sort(), ['kind', 'notice', 'notice_id', 'project_id', 'session_id', 'team_id', 'title']);
  assert.deepEqual([told.project_id, told.title], [PROJECT, 'T1'], 'the title as listed, never message text');
  f.list.sending(sid);
  f.list.onEvent(stream('started', { stream: 'stream_2' }));
  f.list.onEvent(stream('error', { stream: 'stream_2' }));
  f.list.sending(sid);
  f.list.onEvent(stream('started', { stream: 'stream_3' }));
  f.list.onEvent(stream('cancelled', { stream: 'stream_3' }));
  assert.deepEqual(f.notices().slice(3), ['failed'], 'a failure tells; a cancel does not');
  f.list.sending(sid);
  f.list.unsent(sid);
  f.list.onEvent(stream('started', { stream: 'stream_4' }));
  f.list.onEvent(stream('complete', { stream: 'stream_4' }));
  assert.equal(f.notices().length, 4, 'a refused send binds no turn');
  f.list.stop();
});

test('row 175: an unattended approval tells a writer, not a reader; never while viewing; a resync clears the count', async () => {
  const sid = row(1).session_id;
  const unattended = (id) => ({ event_type: 'approval_unattended', session_id: sid, stream_id: 'stream_1', approval_id: id, prompter_member_id: null });
  const reader = await noticeList('reader');
  reader.list.onEvent(unattended('approval_1'));
  assert.deepEqual([reader.notices(), reader.waiting()], [[], []], 'a reader gets nothing');
  let viewing = true;
  const admin = await noticeList('admin', () => viewing);
  admin.list.onEvent(unattended('approval_1'));
  assert.deepEqual([admin.notices(), admin.waiting()], [[], [1]], 'viewing: counted, not told');
  viewing = false;
  admin.list.onEvent(unattended('approval_1'));
  admin.list.onEvent(unattended('approval_2'));
  assert.deepEqual(admin.notices(), ['unattended', 'unattended'], 'reported again after the member left: told once per approval');
  admin.list.onEvent(stream('tool_use', { event: { approval_id: 'approval_2', status: 'timeout' } }));
  admin.list.onEvent({ event_type: 'resync_required' });
  assert.deepEqual(admin.waiting(), [1, 2, 1, 0], 'a timed-out approval goes; a resync clears the rest');
  admin.list.onEvent(unattended('approval_3')); reader.list.stop(); admin.list.stop();
  assert.deepEqual(admin.waiting().slice(-2), [1, 0], 'stopping the list sets the count back to zero');
});

test('row 175: team-projects reads the list at connect, and a send through it is this member\'s turn, told once it is closed', async () => {
  const { createTeamProjects } = require('../services/team/team-projects');
  let fire = () => {};
  const manager = Object.assign(fakeManager({ 'projects.list': PROJECTS, 'sessions.list': { ok: true, sessions: [{ session_id: SESSION, title: 'T', project_id: PROJECT }] },
    'chat.send': { ok: true, revision: 'boot:2', turn_id: 'turn_9' } }), { snapshot: () => ({ state: 'online', member_state: 'active', role: 'member' }),
    onEvent: (fn) => { fire = fn; return () => {}; } });
  const pushes = [];
  const projects = createTeamProjects({ push: (p) => pushes.push(p), timers: fakeTimers() });
  projects.connectionChanged('team_a', manager);
  for (let i = 0; i < 3; i += 1) await turn();
  assert.deepEqual([manager.count('projects.list'), manager.count('sessions.list')], [1, 1], 'read at connect with no project call');
  const s = { team_id: 'team_a', session_id: SESSION };
  const event = (type, over = {}) => fire({ event_type: 'chat_stream', session_id: SESSION, stream_id: 'stream_1', event: { type, ...over } });
  await projects.call('conversationOpen', s);
  assert.equal((await projects.call('conversationSend', { ...s, prompt: 'hi' })).ok, true);
  event('started', { turn_id: 'turn_9' });
  event('question_batch', { call_id: 'call_1' });
  await projects.call('conversationClose', s);
  event('complete');
  assert.deepEqual(pushes.filter((p) => p.kind === 'project_notice').map((p) => p.notice), ['question', 'finished'], 'told while open too');
  await projects.stopAll();
});
