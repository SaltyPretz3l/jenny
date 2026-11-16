'use strict';

// Slice 3-2 (TEAM_PROJECTS_SPEC "One visibility rule"): forged ids, the four
// filters, removal between calls, the read-only cap, the owner outside a
// project, each fail-closed case by name, and the single-owner directory.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');
const {
  channelMembers, chatBucket, createAuthorizer, createSingleOwnerDirectory, getSingleOwnerAuthorizer, singleOwnerActor,
  streamIdentity,
} = require('../../server/team/authorize');
const { effectiveProjectRole } = require('../../server/team/project-visibility');
const { createProjectCommandDispatcher } = require('../../services/host/project-commands');
const { BOOT, BackendHarness, command, createFixture } = require('../helpers/command-router-fixture');
const { createTeamDirectoryFixture } = require('./helpers/team-directory-fixture');

// project_a: owner admin, member_a writer, member_ro reader. project_b: member_b
// writer only. project_c: member_a writer. project_r: member_a reader.
// project_del is deleting. General and project_unknown have no team row.
const PROJECTS = {
  project_a: { members: { member_owner: 'admin', member_a: 'writer', member_ro: 'reader' } },
  project_b: { members: { member_b: 'writer' } },
  project_c: { members: { member_a: 'writer' } },
  project_r: { members: { member_a: 'reader' } },
  project_del: { state: 'deleting', members: {} },
};
const PROJECT_ROWS = ['project_a', 'project_b', 'project_c', 'project_general', 'project_unknown', 'project_del']
  .map((id, index) => ({ id, name: `P${index}`, root_path: null, root_revision: 0, authority_key: '' }));

function reason(value) { return value.ok ? 'ok' : value.error.reason; }

function withoutRequestId(value) {
  return value.ok ? value : { ...value, error: { ...value.error, request_id: '' } };
}

async function teamRouter(t, { sessionProject } = {}) {
  const team = createTeamDirectoryFixture({ projects: PROJECTS });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-visibility-'));
  const backend = new BackendHarness(root);
  const resolve = sessionProject ?? ((id) => backend.sessionStore.getSession(id)?.project_id ?? null);
  const clients = new ClientRegistry();
  const leases = new ControlLeases();
  const receipts = new CommandReceipts({ filePath: path.join(root, 'receipts.json') });
  const router = createCommandRouter({ backend, clients, leases, receipts, bootEpoch: BOOT,
    eventStream: { publish() {} }, authorize: createAuthorizer({ directory: team.directory, sessionProject: resolve }).authorize });
  const seat = {};
  for (const [name, actor] of Object.entries(team.actors)) {
    const client = clients.register(actor.device_id);
    seat[name] = { client, context: { deviceId: actor.device_id, clientToken: client.client_token,
      isAuthenticated: () => true, actor } };
  }
  t.after(() => { router.dispose(); backend.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const send = (who, operation, params = {}, extra = {}) => router.dispatch(
    command(seat[who].client, operation, params, extra), seat[who].context);
  // Seeded in the store: on a team host sessions.create takes no conversation into General (E70).
  const sessionIn = async (projectId) => {
    const id = backend.sessionStore.createSession({ title: projectId }).id;
    if (projectId !== 'project_general') assert.ok(backend.sessionStore.updateSession(id, { project_id: projectId }));
    return id;
  };
  const ids = { a: await sessionIn('project_a'), b: await sessionIn('project_b'), c: await sessionIn('project_c'),
    r: await sessionIn('project_r'), general: await sessionIn('project_general') };
  backend.projectApplicationService.listProjects = () => ({ ok: true, projects: PROJECT_ROWS, storage: {} });
  return { team, backend, router, leases, seat, send, ids };
}

// A stand-in runtime with the real service's answers for missing work
// (services/session-runtime/application-service.js: getWork gives
// runtime_work_not_found, getResult of unknown work gives runtime_result_unavailable).
function installRuntime(f) {
  const work = new Map([['work_a', f.ids.a], ['work_b', f.ids.b]]);
  const row = (workId, sessionId, extra = {}) => ({ work_id: workId, project_id: 'project_runtime', session_id: sessionId,
    turn_id: `turn_${workId}`, purpose: 'chat', status: 'pending', revision: 1, submission_sequence: 1,
    created_at: '2026-11-11T00:00:00.000Z', updated_at: '2026-11-11T00:00:00.000Z', admission_wait: null,
    resumable: null, ...extra });
  const calls = [];
  Object.assign(f.backend.runtimeApplicationService, {
    getSnapshot(params) {
      calls.push(['getSnapshot', params]);
      if (params.view === 'runs') {
        return { ok: true, schema_version: 1, enabled: true, closing: false, read_only: false, revision: 7,
          lanes: { counts: { active_leases: 2 } }, resources: { counts: { lease_count: 2 } }, view: 'runs',
          work: [row('work_a', f.ids.a, { group: 'waiting', queue_position: 3 }),
            row('work_b', f.ids.b, { group: 'waiting', queue_position: 1 })],
          next_cursor: null, truncated: true };
      }
      return { ok: true, schema_version: 1, enabled: true, closing: false, read_only: false, revision: 7,
        lanes: { configured_limits: {}, effective_limits: {}, counts: { active_leases: 2, quarantined: 0, by_lane: [] } },
        resources: { configured_limits: {}, counts: { capacity: {}, lease_count: 2, waiter_count: 1, quarantined_count: 0 } },
        work: [row('work_a', f.ids.a, { admission_wait: { reason: 'lane_full', since: '2026-11-11T00:00:00.000Z',
          blocking_session_id: f.ids.b } }), row('work_b', f.ids.b)],
        next_cursor: 'cursor_next' };
    },
    getWork({ work_id: workId }) {
      calls.push(['getWork', workId]);
      return work.has(workId) ? { ok: true, work: row(workId, work.get(workId)) }
        : { ok: false, error: { code: 'CMP-RUNTIME-0002', reason: 'runtime_work_not_found' } };
    },
    getResult({ work_id: workId }) {
      calls.push(['getResult', workId]);
      return work.has(workId) ? { ok: true, work_id: workId, session_id: work.get(workId), status: 'completed' }
        : { ok: false, error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_result_unavailable' } };
    },
  });
  return calls;
}

test('T3: forged conversation and project ids answer team_not_found and change nothing', async (t) => {
  const f = await teamRouter(t);
  const before = JSON.stringify(f.backend.sessionStore.listSessions());
  const lease = { control_generation: 1, expected_revision: `${BOOT}:1` };
  for (const [operation, params] of [['sessions.snapshot', {}], ['sessions.rename', { title: 'Taken' }],
    ['sessions.preferences', { plan_mode: true }], ['sessions.delete', {}], ['chat.send', { prompt: 'hi' }],
    ['control.acquire', { takeover: true }], ['suggestedChanges.list', {}]]) {
    const extra = { session_id: f.ids.b, ...(operation === 'sessions.snapshot' || operation === 'control.acquire'
      || operation === 'suggestedChanges.list' ? {} : lease) };
    assert.equal(reason(await f.send('member', operation, params, extra)), 'team_not_found', operation);
  }
  assert.equal(f.backend.startCalls.length, 0);
  assert.equal(f.leases.get(f.ids.b), null);
  // A project id the caller cannot see.
  assert.equal(reason(await f.send('member', 'team.project.rename', { project_id: 'project_b', name: 'Mine' })), 'team_not_found');
  assert.equal(JSON.stringify(f.backend.sessionStore.listSessions()), before);
  // Hidden reads exactly like missing.
  const hidden = await f.send('member', 'sessions.snapshot', {}, { session_id: f.ids.b });
  const missing = await f.send('member', 'sessions.snapshot', {}, { session_id: 'session_missing' });
  assert.deepEqual(withoutRequestId(hidden), withoutRequestId(missing));
});

test('T3: project.assign checks the conversation and the target, before the change', async (t) => {
  const f = await teamRouter(t);
  const acquired = await f.send('member', 'control.acquire', { takeover: false }, { session_id: f.ids.a });
  assert.equal(acquired.ok, true);
  const assign = (projectId, sessionId = f.ids.a, generation = acquired.lease.generation) => f.send('member',
    'projects.assignSession', { project_id: projectId }, { session_id: sessionId, control_generation: generation,
      expected_revision: f.router.snapshot(sessionId).session.revision });
  for (const target of ['project_b', 'project_unknown', 'project_del']) {
    assert.equal(reason(await assign(target)), 'team_not_found', target);
  }
  assert.equal(reason(await assign('project_general')), 'team_project_required', 'General is never a target (E70)');
  assert.equal(reason(await assign('project_r')), 'team_project_read_only', 'a target the caller only reads');
  assert.deepEqual(f.backend.projectCalls, [], 'nothing reached the project service');
  assert.equal(f.backend.sessionStore.getSession(f.ids.a).project_id, 'project_a');
  // The conversation's own project is checked too: a reader there cannot move it.
  const readerLease = await f.send('member', 'control.acquire', { takeover: false }, { session_id: f.ids.r });
  assert.equal(readerLease.ok, false, 'a reader takes no lease');
  assert.equal(reason(readerLease), 'team_project_read_only');
  // A writer on both moves it.
  assert.equal(reason(await assign('project_c')), 'ok');
  assert.equal(f.backend.sessionStore.getSession(f.ids.a).project_id, 'project_c');
});

test('T3: a removal between the check and the change stops project.assign', async (t) => {
  const f = await teamRouter(t);
  const acquired = await f.send('member', 'control.acquire', { takeover: false }, { session_id: f.ids.a });
  const original = f.backend.projectApplicationService.assignSessionProject;
  let calls = 0;
  // The receipt queue runs the closure after an await: remove the member from the target then.
  f.backend.projectApplicationService.assignSessionProject = (params) => { calls += 1; return original(params); };
  const pending = f.send('member', 'projects.assignSession', { project_id: 'project_c' }, { session_id: f.ids.a,
    control_generation: acquired.lease.generation, expected_revision: f.router.snapshot(f.ids.a).session.revision });
  f.team.setProjectRole('member_a', 'project_c', null);
  assert.equal(reason(await pending), 'team_not_found');
  assert.equal(calls, 0);
  assert.equal(f.backend.sessionStore.getSession(f.ids.a).project_id, 'project_a');
});

test('T3: sessions.list shows only visible conversations and counts only them', async (t) => {
  const f = await teamRouter(t);
  const listed = async (who) => {
    const value = await f.send(who, 'sessions.list');
    assert.equal(value.ok, true, who);
    assert.equal(value.total, value.sessions.length, `${who} total is the visible count`);
    return value.sessions.map((row) => row.session_id).sort();
  };
  assert.deepEqual(await listed('member'), [f.ids.a, f.ids.c, f.ids.r].sort());
  assert.deepEqual(await listed('otherMember'), [f.ids.b]);
  assert.deepEqual(await listed('read_only'), [f.ids.a]);
  // The owner: project_a (admin) and General; not project_b, c or r, which they never joined.
  assert.deepEqual(await listed('owner'), [f.ids.a, f.ids.general].sort());
});

test('T3: a member revoked while sessions.list awaits its read gets the denial, not the list', async (t) => {
  const f = await teamRouter(t);
  const original = f.backend.listSessions.bind(f.backend);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.backend.listSessions = async () => { entered(); await gate; return original(); };
  const pending = f.send('member', 'sessions.list');
  await started;
  f.team.setState('device_a1', 'revoked');
  release();
  const answer = await pending;
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'member_revoked');
  assert.equal(Object.hasOwn(answer, 'sessions'), false);
});

test('T3: projects.list shows only visible projects', async (t) => {
  const f = await teamRouter(t);
  const listed = async (who) => (await f.send(who, 'projects.list')).projects.map((row) => row.id);
  assert.deepEqual(await listed('member'), ['project_a', 'project_c']);
  assert.deepEqual(await listed('otherMember'), ['project_b']);
  assert.deepEqual(await listed('read_only'), ['project_a']);
  assert.deepEqual(await listed('owner'), ['project_a', 'project_general', 'project_unknown', 'project_del']);
});

test('T3: the runtime snapshot carries nothing from a conversation the caller cannot see', async (t) => {
  const f = await teamRouter(t);
  installRuntime(f);
  const member = await f.send('member', 'sessionRuntime.getSnapshot', {});
  assert.equal(member.ok, true);
  assert.deepEqual(member.runtime.work.map((row) => row.work_id), ['work_a']);
  assert.equal(member.runtime.work[0].admission_wait.blocking_session_id, null, 'the blocking conversation is hidden');
  assert.equal(member.runtime.work[0].admission_wait.reason, 'lane_full');
  assert.equal(member.runtime.lanes.counts, null);
  assert.equal(member.runtime.resources.counts, null);
  assert.equal(member.runtime.next_cursor, null, 'an unscoped cursor would count hidden work');
  const other = await f.send('otherMember', 'sessionRuntime.getSnapshot', {});
  assert.deepEqual(other.runtime.work.map((row) => row.work_id), ['work_b']);
  const owner = await f.send('owner', 'sessionRuntime.getSnapshot', {});
  assert.deepEqual(owner.runtime.work.map((row) => row.work_id), ['work_a']);
  // Client-chosen scope ids are checked.
  assert.equal(reason(await f.send('member', 'sessionRuntime.getSnapshot', { session_id: f.ids.b })), 'team_not_found');
  assert.equal(reason(await f.send('member', 'sessionRuntime.getSnapshot', { project_id: 'project_b' })), 'team_not_found');
  assert.equal(reason(await f.send('member', 'sessionRuntime.getSnapshot', {}, { session_id: f.ids.b })), 'team_not_found');
  // Scoped to a visible conversation, the cursor stays.
  const scoped = await f.send('member', 'sessionRuntime.getSnapshot', { session_id: f.ids.a });
  assert.equal(scoped.runtime.next_cursor, 'cursor_next');
});

test('T3: the runs view keeps no queue position and passes truncated through', async (t) => {
  const f = await teamRouter(t);
  installRuntime(f);
  const member = await f.send('member', 'sessionRuntime.getSnapshot', { view: 'runs' });
  assert.equal(member.ok, true);
  assert.deepEqual(member.runtime.work.map((row) => row.work_id), ['work_a']);
  assert.equal(member.runtime.work[0].queue_position, null, 'a place among all pending work counts hidden turns');
  assert.equal(member.runtime.truncated, true, 'the runtime said the window was full; hidden rows used it');
  assert.equal(member.runtime.lanes.counts, null);
});

test('T3: getWork and getResult answer like missing work for a hidden conversation, with or without a session id', async (t) => {
  const f = await teamRouter(t);
  installRuntime(f);
  for (const operation of ['sessionRuntime.getWork', 'sessionRuntime.getResult']) {
    const missing = await f.send('member', operation, { work_id: 'work_none' });
    assert.equal(missing.ok, false);
    for (const extra of [{}, { session_id: f.ids.a }]) {
      const hidden = await f.send('member', operation, { work_id: 'work_b' }, extra);
      assert.deepEqual(withoutRequestId(hidden), withoutRequestId(missing), `${operation} ${JSON.stringify(extra)}`);
    }
    assert.equal((await f.send('member', operation, { work_id: 'work_a' })).ok, true, operation);
    assert.equal((await f.send('otherMember', operation, { work_id: 'work_b' })).ok, true, operation);
    // A visible work named under another visible conversation keeps its mismatch answer.
    assert.equal(reason(await f.send('member', operation, { work_id: 'work_a' }, { session_id: f.ids.c })),
      'runtime_work_session_mismatch');
  }
});

test('T3: a member removed from a project is denied on the next call and leaves the channel audience', async (t) => {
  const f = await teamRouter(t);
  const channel = 'chan_project_a';
  const identity = streamIdentity(f.team.directory, f.team.actors.member);
  assert.equal((await f.send('member', 'sessions.snapshot', {}, { session_id: f.ids.a })).ok, true);
  assert.equal(channelMembers(f.team.directory, channel).has('member_a'), true);
  assert.equal(identity.mayReceive('member_a', { bucket: chatBucket(channel) }), true);
  f.team.setProjectRole('member_a', 'project_a', null);
  assert.equal(reason(await f.send('member', 'sessions.snapshot', {}, { session_id: f.ids.a })), 'team_not_found');
  assert.equal(reason(await f.send('member', 'team.chat.history', { channel_id: channel, limit: 10 })), 'team_chat_not_found');
  assert.equal(channelMembers(f.team.directory, channel).has('member_a'), false);
  assert.equal(identity.mayReceive('member_a', { bucket: chatBucket(channel) }), false, 'live and replayed frames stop');
  assert.deepEqual([...channelMembers(f.team.directory, channel)].sort(), ['member_owner', 'member_ro']);
  // The team channel is still every active member.
  assert.equal(channelMembers(f.team.directory, 'chan_team').has('member_a'), true);
  assert.equal(channelMembers(f.team.directory, `chan_dm_${'a'.repeat(64)}`).size, 0);
});

test('T3: a read-only member is a reader, whatever role is stored', async (t) => {
  const f = await teamRouter(t);
  f.team.setProjectRole('member_ro', 'project_a', 'admin');
  const live = f.team.directory.liveActor('device_ro');
  assert.equal(effectiveProjectRole(f.team.directory, live, 'project_a'), 'reader');
  assert.equal(effectiveProjectRole(f.team.directory, live, 'project_b'), null);
  assert.equal((await f.send('read_only', 'sessions.snapshot', {}, { session_id: f.ids.a })).ok, true);
  assert.equal(reason(await f.send('read_only', 'team.project.rename', { project_id: 'project_a', name: 'x' })), 'role_forbidden');
  assert.equal(channelMembers(f.team.directory, 'chan_project_a').has('member_ro'), true);
  for (const who of ['pending', 'invite', 'revoked']) {
    assert.equal(effectiveProjectRole(f.team.directory, f.team.actors[who], 'project_a'), null, who);
  }
});

test('T3: the owner outside a project sees nothing of it', async (t) => {
  const f = await teamRouter(t);
  installRuntime(f);
  assert.equal(effectiveProjectRole(f.team.directory, f.team.directory.liveActor('device_owner'), 'project_b'), null);
  assert.equal(reason(await f.send('owner', 'sessions.snapshot', {}, { session_id: f.ids.b })), 'team_not_found');
  assert.equal(reason(await f.send('owner', 'team.project.rename', { project_id: 'project_b', name: 'x' })), 'team_not_found');
  assert.equal(reason(await f.send('owner', 'team.chat.history', { channel_id: 'chan_project_b', limit: 10 })), 'team_chat_not_found');
  assert.equal(channelMembers(f.team.directory, 'chan_project_b').has('member_owner'), false);
  assert.equal((await f.send('owner', 'sessions.list')).sessions.some((row) => row.session_id === f.ids.b), false);
  assert.equal((await f.send('owner', 'projects.list')).projects.some((row) => row.id === 'project_b'), false);
  const snapshot = await f.send('owner', 'sessionRuntime.getSnapshot', {});
  assert.equal(snapshot.runtime.work.some((row) => row.session_id === f.ids.b), false);
  // General is the owner's alone.
  assert.equal((await f.send('owner', 'sessions.snapshot', {}, { session_id: f.ids.general })).ok, true);
  assert.equal(reason(await f.send('member', 'sessions.snapshot', {}, { session_id: f.ids.general })), 'team_not_found');
});

test('E70: on a team host General takes no new or moved conversation, the owner\'s included', async (t) => {
  const f = await teamRouter(t);
  const before = JSON.stringify(f.backend.sessionStore.listSessions());
  for (const who of ['owner', 'member']) {
    assert.equal(reason(await f.send(who, 'sessions.create', { title: 'Mine' })), 'team_project_required', who);
    assert.equal(reason(await f.send(who, 'sessions.create', { title: 'Mine', project_id: 'project_general' })),
      'team_project_required', `${who} names General`);
  }
  // The owner, an admin in project_a, cannot move its conversation into General.
  const acquired = await f.send('owner', 'control.acquire', { takeover: false }, { session_id: f.ids.a });
  assert.equal(acquired.ok, true);
  const moved = await f.send('owner', 'projects.assignSession', { project_id: 'project_general' }, { session_id: f.ids.a,
    control_generation: acquired.lease.generation, expected_revision: f.router.snapshot(f.ids.a).session.revision });
  assert.equal(reason(moved), 'team_project_required');
  assert.equal(moved.error.code, 'CMP-HOST-0003');
  assert.deepEqual(f.backend.projectCalls, [], 'nothing reached the project service');
  assert.equal(JSON.stringify(f.backend.sessionStore.listSessions()), before);
  // A conversation in a project is still made there, and the owner still reads the General ones that exist.
  assert.equal((await f.send('owner', 'sessions.create', { title: 'In A', project_id: 'project_a' })).ok, true);
  assert.equal((await f.send('owner', 'sessions.snapshot', {}, { session_id: f.ids.general })).ok, true);
});

// ---- Fail closed, case by case -----------------------------------------------

function unit(overrides = {}, sessionProject = (id) => (id === 'session_a' ? 'project_a' : null)) {
  const fixture = createTeamDirectoryFixture({ projects: PROJECTS });
  const directory = { ...fixture.directory, ...overrides };
  const { authorize } = createAuthorizer({ directory, sessionProject });
  return { fixture, directory, check: (who, action, resource) => reason(authorize(fixture.actors[who], action, resource)) };
}

const SESSION_A = { kind: 'session', id: 'session_a' };

test('fail closed: a missing actor', () => {
  const { directory } = unit();
  const { authorize } = createAuthorizer({ directory, sessionProject: () => 'project_a' });
  for (const actor of [null, undefined, {}, { device_id: '' }]) {
    assert.equal(reason(authorize(actor, 'session.read', SESSION_A)), 'role_forbidden');
  }
});

test('fail closed: a missing resolver and one that answers garbage', () => {
  for (const [name, resolver] of [['missing', null],
    ['non-string', () => 42], ['empty', () => ''], ['object', () => ({ project_id: 'project_a' })]]) {
    const { check } = unit({}, resolver);
    assert.equal(check('member', 'session.read', SESSION_A), 'team_not_found', `${name}: member`);
    assert.equal(check('read_only', 'session.read', SESSION_A), 'team_not_found', `${name}: read-only`);
    assert.equal(check('owner', 'session.read', SESSION_A), 'ok', `${name}: an unknown conversation is the owner's`);
  }
});

// Slice 3-3 review: a throwing resolver denies everyone, the owner included, never reads as General.
test('fail closed: a throwing resolver is unavailable to everyone', () => {
  const { check } = unit({}, () => { throw new Error('boom'); });
  for (const who of ['owner', 'member', 'read_only']) {
    assert.equal(check(who, 'session.read', SESSION_A), 'team_unavailable', who);
  }
});

test('fail closed: a missing directory method', () => {
  // No projectState: the owner exception for unknown projects closes; General stays the owner's.
  const noState = unit({ projectState: undefined });
  assert.equal(noState.check('owner', 'project.read', { kind: 'project', id: 'project_unknown' }), 'team_not_found');
  assert.equal(noState.check('owner', 'project.read', { kind: 'project', id: 'project_general' }), 'ok');
  assert.equal(noState.check('member', 'project.read', { kind: 'project', id: 'project_a' }), 'ok');
  // No activeMemberIds: an empty audience, never everyone.
  const noRoster = unit({ activeMemberIds: undefined });
  assert.equal(channelMembers(noRoster.directory, 'chan_project_a').size, 0);
  assert.equal(channelMembers(noRoster.directory, 'chan_team').size, 0);
  // A projectRole that throws is an unavailable directory, not access.
  const broken = unit({ projectRole() { throw new Error('boom'); } });
  assert.equal(broken.check('member', 'session.read', SESSION_A), 'team_unavailable');
  assert.equal(broken.check('owner', 'session.read', SESSION_A), 'team_unavailable');
});

test('fail closed: a team directory with no projectRole shows no conversation, project or project channel', () => {
  const { directory, check } = unit({ projectRole: undefined });
  for (const who of ['owner', 'member', 'read_only']) {
    assert.equal(check(who, 'session.read', SESSION_A), 'team_not_found', `${who} conversation`);
    assert.equal(check(who, 'session.read', { kind: 'session', id: 'session_unknown' }), 'team_not_found', `${who} unknown`);
    assert.equal(check(who, 'project.read', { kind: 'project', id: 'project_a' }), 'team_not_found', `${who} project`);
    assert.equal(check(who, 'chat.read', { kind: 'channel', id: 'chan_project_a' }), 'team_chat_not_found', `${who} channel`);
  }
  assert.equal(channelMembers(directory, 'chan_project_a').size, 0);
  assert.equal(channelMembers(directory, 'chan_team').has('member_a'), true, 'the team channel is not a project');
  // A copy of the single-owner directory does not carry its marker: it is a team directory and closes too.
  const copied = createAuthorizer({ directory: { ...createSingleOwnerDirectory() } }).authorize;
  assert.equal(reason(copied(singleOwnerActor('device_x'), 'session.read', { kind: 'session', id: 's' })), 'team_not_found');
});

test('fail closed: a deleting or unknown-state project, even when the directory still answers a role', () => {
  const base = createTeamDirectoryFixture({ projects: PROJECTS }).directory;
  const resolver = (id) => ({ session_del: 'project_del', session_arch: 'project_arch' })[id] ?? null;
  for (const [name, overrides] of [['as stored', {}], ['answering a role', {
    projectRole: (memberId, projectId) => (['project_del', 'project_arch'].includes(projectId)
      && ['member_a', 'member_owner'].includes(memberId) ? 'writer' : base.projectRole(memberId, projectId)),
    projectState: (projectId) => (projectId === 'project_arch' ? 'archived' : base.projectState(projectId)),
  }], ['archived as stored', { projectState: (projectId) => (projectId === 'project_arch' ? 'archived'
    : base.projectState(projectId)) }]]) {
    const { directory, check } = unit(overrides, resolver);
    assert.equal(check('member', 'session.read', { kind: 'session', id: 'session_del' }), 'team_not_found', `${name}: deleting`);
    assert.equal(check('member', 'project.read', { kind: 'project', id: 'project_del' }), 'team_not_found', `${name}: deleting`);
    assert.equal(check('member', 'chat.read', { kind: 'channel', id: 'chan_project_del' }), 'team_chat_not_found', name);
    assert.equal(channelMembers(directory, 'chan_project_del').size, 0, `${name}: deleting audience`);
    assert.equal(check('owner', 'session.read', { kind: 'session', id: 'session_del' }), 'ok', `${name}: owner reads`);
    assert.equal(check('owner', 'session.write', { kind: 'session', id: 'session_del' }), 'team_project_deleting', name);
    if (name === 'as stored') continue;
    for (const who of ['owner', 'member']) {
      assert.equal(check(who, 'session.read', { kind: 'session', id: 'session_arch' }), 'team_not_found', `${name}: ${who}`);
      assert.equal(check(who, 'project.read', { kind: 'project', id: 'project_arch' }), 'team_not_found', `${name}: ${who}`);
    }
    assert.equal(channelMembers(directory, 'chan_project_arch').size, 0, `${name}: archived audience`);
  }
});

test('fail closed: an unknown kind and an unknown action', () => {
  const { check } = unit();
  assert.equal(check('owner', 'session.read', { kind: 'planted', id: 'x' }), 'team_not_found');
  assert.equal(check('owner', 'project.read', { kind: 'session', id: 'session_a' }), 'team_not_found');
  assert.equal(check('owner', 'planted.action', SESSION_A), 'role_forbidden');
  assert.equal(check('owner', '__proto__', SESSION_A), 'role_forbidden');
});

test('fail closed: a degraded directory', () => {
  const { fixture, check } = unit();
  fixture.setDegraded(true);
  assert.equal(check('member', 'session.read', SESSION_A), 'team_unavailable');
  assert.equal(check('owner', 'session.read', SESSION_A), 'ok');
});

test('fail closed: a project dispatcher built without the access check lists nothing', async () => {
  const dispatcher = createProjectCommandDispatcher({
    applicationService: { listProjects: () => ({ ok: true, projects: PROJECT_ROWS, storage: {} }) },
    authorization: { identity: () => null },
  });
  const listed = await dispatcher.dispatch({ operation: 'projects.list', params: {}, request_id: 'r' }, {});
  assert.deepEqual(listed.projects, []);
});

// ---- Single owner -------------------------------------------------------------

test('the single-owner directory answers every project and session as before', async () => {
  const { authorize } = getSingleOwnerAuthorizer();
  const actor = singleOwnerActor('device_owner');
  for (const [action, resource] of [['session.read', { kind: 'session', id: 'anything' }],
    ['session.delete', { kind: 'session', id: 'anything' }], ['session.create', { kind: 'project', id: '' }],
    ['project.write', { kind: 'project', id: 'project_nobody' }], ['project.assign', { kind: 'project', id: 'project_x' }],
    // E70 is a team host rule: the single owner still creates in, and moves into, General.
    ['session.create', { kind: 'project', id: 'project_general' }], ['project.assign', { kind: 'project', id: 'project_general' }],
    ['runtime.control', { kind: 'session', id: '' }], ['project.read', { kind: 'project', id: 'project_general' }]]) {
    assert.deepEqual(authorize(actor, action, resource), { ok: true }, action);
  }
  const f = createFixture();
  try {
    for (const params of [{ title: 'One' }, { title: 'Two', project_id: 'project_general' }]) {
      assert.equal((await f.router.dispatch(command(f.a, 'sessions.create', params), f.contextA)).ok, true);
    }
    const listed = await f.router.dispatch(command(f.a, 'sessions.list'), f.contextA);
    assert.equal(listed.sessions.length, 2);
    assert.equal(listed.total, 2);
    const projects = await f.router.dispatch(command(f.a, 'projects.list'), f.contextA);
    assert.deepEqual(projects.projects.map((row) => row.id), ['project_alpha']);
  } finally { await f.close(); }
});
