'use strict';

// Slice 3-4a (docs/plans/TEAM_PROJECTS_SPEC.md "3-4a as built"): the team.project.*
// commands through the real router, store, directory and authorizer; the
// `team_project_changed` event and its audience; the generic project operations on a
// team host; sessions.create in a shared project; the project-filtered audit read.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { LIMITS } = require('../../server/team/member-schema');
const { dataFrames } = require('./helpers/session-scope-fixture');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const changed = (projectId, reason) => ({ project_id: projectId, reason });

test('a full member creates a project: a record, a team row with them as admin, a channel, one event', async (t) => {
  const h = await createTeamProjectFixture(t);
  const streams = Object.fromEntries(['alice', 'owner', 'bob'].map((who) => [who, h.attach(who)]));
  const created = await h.ok(h.send('alice', 'team.project.create', { name: 'Apollo' }));
  const id = created.project_id;
  assert.deepEqual(Object.keys(created).sort(), ['channel', 'folder', 'name', 'ok', 'project_id']);
  assert.deepEqual([created.name, created.channel, created.folder], ['Apollo', true, false], 'no projects root: no folder');
  assert.equal(h.state.app.records.get(id).root_path, null);
  assert.equal(h.state.app.records.get(id).name, 'Apollo');
  assert.deepEqual(h.store.getProject(id).members.map((entry) => [entry.member_id, entry.role]),
    [[h.seats.alice.member_id, 'admin']]);
  assert.equal(h.state.chat.channels.has(`chan_${id}`), true);
  assert.deepEqual(h.projectFrames(streams.alice), [changed(id, 'created')]);
  assert.deepEqual(h.projectFrames(streams.owner), [changed(id, 'created')], 'the owner keeps the names-only list right');
  assert.deepEqual(h.projectFrames(streams.bob), []);
  assert.equal((await h.listed('bob')).includes(id), false, 'a member sees nothing until added');
  await h.ok(h.send('alice', 'team.project.members.add', { project_id: id, member_id: h.seats.bob.member_id, role: 'writer' }));
  assert.equal((await h.listed('bob')).includes(id), true);
  assert.doesNotMatch(h.logText(), /Apollo/u, 'a project name never reaches a log line');
});

test('3-4b: on a host with a projects root, create makes the folder and binds exactly it, once', async (t) => {
  const h = await createTeamProjectFixture(t, { projectsRoot: true });
  const created = await h.ok(h.send('alice', 'team.project.create', { name: 'Rooted' }));
  const id = created.project_id;
  const folder = path.join(h.roots.projectsRoot, id);
  assert.equal(created.folder, true);
  assert.equal(fs.statSync(folder).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(folder), []);
  assert.deepEqual([h.state.app.records.get(id).root_path, h.state.app.records.get(id).root_revision],
    [fs.realpathSync.native(folder), 1]);
  assert.deepEqual(h.state.app.calls.filter((call) => call === 'bind').length, 1);
  assert.equal(JSON.stringify(created).includes(h.roots.projectsRoot), false, 'the answer carries no path');
  const again = h.state.app.bindProjectRoot({ project_id: id, root_path: h.roots.projectsRoot, expected_root_revision: 0 });
  assert.equal(again.error.reason, 'stale_root_revision', 'nothing else can be bound at revision 0');
  assert.equal(await h.reason(h.send('owner', 'projects.bindRoot', { project_id: id, root_path: '/srv/x',
    expected_root_revision: 1 })), 'unsupported_operation');
  assert.equal(h.logText().includes(h.roots.projectsRoot), false);
});

test('a refused create leaves no record; a store refusal after the record leaves it, logged without the name', async (t) => {
  const h = await createTeamProjectFixture(t);
  assert.equal(await h.reason(h.send('rae', 'team.project.create', { name: 'Ro' })), 'role_forbidden');
  assert.equal(await h.reason(h.send('alice', 'team.project.create', { name: 'bad name' })), 'team_project_name_invalid');
  assert.equal(h.state.app.records.size, 0);
  // The store decides after the record exists: the creator is set read-only in between.
  h.state.app.onCreate = () => {
    h.state.app.onCreate = null;
    h.store.setRole({ actorMemberId: h.seats.owner.member_id, memberId: h.seats.carl.member_id, role: 'read_only' });
  };
  assert.equal(await h.reason(h.send('carl', 'team.project.create', { name: 'Orphan name' })), 'team_project_read_only');
  assert.equal(h.state.app.records.size, 1, 'the record stays (owner only); 3-4b reconcile repays it');
  assert.equal(h.store.snapshot().projects.length, 0);
  assert.equal(h.fx.logs.filter((entry) => entry.event === 'team_project.create_unbound').length, 1);
  assert.doesNotMatch(h.logText(), /Orphan name/u);
  for (let i = h.store.snapshot().projects.length; i < LIMITS.MAX_PROJECTS; i += 1) {
    assert.equal((await h.store.createProject({ actorMemberId: h.seats.owner.member_id })).ok, true);
  }
  const before = h.state.app.records.size;
  assert.equal(await h.reason(h.send('alice', 'team.project.create', { name: 'Sixty-five' })), 'team_project_limit');
  assert.equal(h.state.app.records.size, before, 'the 65th leaves no record');
});

test('a channel that cannot be made leaves a usable project and answers channel: false', async (t) => {
  const h = await createTeamProjectFixture(t);
  h.state.chat.fail = true;
  const created = await h.ok(h.send('alice', 'team.project.create', { name: 'No room' }));
  assert.equal(created.channel, false);
  assert.deepEqual((await h.ok(h.send('alice', 'team.project.members.list', { project_id: created.project_id }))).members,
    [{ member_id: h.seats.alice.member_id, role: 'admin' }]);
  assert.equal(h.fx.logs.filter((entry) => entry.event === 'team_project.channel_failed').length, 1);
  h.state.chat = null;
  assert.equal((await h.ok(h.send('alice', 'team.project.create', { name: 'No chat' }))).channel, false);
});

// Owner report (team overview B3): the channel is announced as a direct conversation's is, to its audience only.
test('create announces the project channel to its audience only; a failed channel announces nothing', async (t) => {
  const h = await createTeamProjectFixture(t);
  const streams = Object.fromEntries(['alice', 'owner', 'bob'].map((who) => [who, h.attach(who)]));
  const channelFrames = (who) => dataFrames(streams[who].frames).filter((frame) => frame.event_type === 'team_chat_channel')
    .map((frame) => [frame.channel_id, frame.reason, frame.floor_seq, frame.channel_rev, frame.pin_count]);
  const id = (await h.ok(h.send('alice', 'team.project.create', { name: 'Apollo' }))).project_id;
  assert.deepEqual(channelFrames('alice'), [[`chan_${id}`, 'created', 1, 0, 0]]);
  assert.deepEqual(channelFrames('owner'), [], 'the team owner outside the project hears nothing');
  assert.deepEqual(channelFrames('bob'), []);
  h.state.chat.fail = true;
  assert.equal((await h.ok(h.send('alice', 'team.project.create', { name: 'No room' }))).channel, false);
  assert.equal(channelFrames('alice').length, 1, 'a failed channel publishes no channel event');
});

test('rename: an admin renames and publishes renamed; nobody else may', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  const carl = h.attach('carl');
  const bob = h.attach('bob');
  await h.ok(h.send('alice', 'team.project.rename', { project_id: id, name: 'Artemis' }));
  assert.equal(h.state.app.records.get(id).name, 'Artemis');
  assert.deepEqual(h.projectFrames(carl), [changed(id, 'renamed')]);
  assert.deepEqual(h.projectFrames(bob), []);
  for (const [who, want] of [['carl', 'role_forbidden'], ['rae', 'role_forbidden'], ['bob', 'team_not_found'],
    ['owner', 'team_not_found']]) {
    assert.equal(await h.reason(h.send(who, 'team.project.rename', { project_id: id, name: 'X' })), want, who);
  }
  assert.equal(h.state.app.records.get(id).name, 'Artemis');
});

test('a rename queued behind a create is checked again: its admin removed meanwhile is refused, nothing published', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  await h.ok(h.send('alice', 'team.project.members.setRole', { project_id: id, member_id: h.seats.carl.member_id, role: 'admin' }));
  const turns = async (count) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  let release;
  h.state.chat.hold = new Promise((resolve) => { release = resolve; });
  const entered = h.state.chat.entered;
  const create = h.send('alice', 'team.project.create', { name: 'Second' });
  for (let i = 0; i < 50 && h.state.chat.entered === entered; i += 1) await turns(1);
  assert.equal(h.state.chat.entered, entered + 1, 'the create holds in its channel step');
  const stream = h.attach('alice');
  const rename = h.send('carl', 'team.project.rename', { project_id: id, name: 'Late' });
  await turns(20);
  assert.equal((await h.store.removeProjectMember({ actorMemberId: h.seats.alice.member_id, projectId: id,
    memberId: h.seats.carl.member_id })).ok, true);
  h.state.chat.hold = null;
  release();
  await h.ok(create, 'create');
  assert.equal(await h.reason(rename), 'team_not_found');
  assert.equal(h.state.app.records.get(id).name, 'Apollo');
  assert.deepEqual(h.projectFrames(stream).filter((frame) => frame.reason === 'renamed'), []);
});

test('H3: a rename queued behind a create is checked against its live device: the device revoked meanwhile renames nothing', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  await h.ok(h.send('alice', 'team.project.members.setRole', { project_id: id, member_id: h.seats.carl.member_id, role: 'admin' }));
  const turns = async (count) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  let release;
  h.state.chat.hold = new Promise((resolve) => { release = resolve; });
  const entered = h.state.chat.entered;
  const create = h.send('alice', 'team.project.create', { name: 'Second' });
  for (let i = 0; i < 50 && h.state.chat.entered === entered; i += 1) await turns(1);
  assert.equal(h.state.chat.entered, entered + 1, 'the create holds in its channel step');
  const stream = h.attach('alice');
  const rename = h.send('carl', 'team.project.rename', { project_id: id, name: 'Late' });
  await turns(20);
  assert.equal((await h.store.revokeDevice({ actorMemberId: h.seats.owner.member_id, deviceId: h.seats.carl.device_id })).ok, true);
  assert.equal(h.store.directory.projectRole(h.seats.carl.member_id, id), 'admin', 'Carl keeps his row: only the device is gone');
  h.state.chat.hold = null;
  release();
  await h.ok(create, 'create');
  assert.equal(await h.reason(rename), 'role_forbidden');
  assert.equal(h.state.app.records.get(id).name, 'Apollo');
  assert.deepEqual(h.projectFrames(stream).filter((frame) => frame.reason === 'renamed'), []);
});

test('role cascade: a read-only demotion, a revoke and a leave tell the clients of its projects to read the member list again', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  await h.ok(h.send('alice', 'team.project.members.add', { project_id: id, member_id: h.seats.bob.member_id, role: 'writer' }));
  const members = (stream) => h.projectFrames(stream).filter((frame) => frame.project_id === id && frame.reason === 'members');
  const alice = h.attach('alice');
  const owner = h.attach('owner');
  await h.ok(h.send('owner', 'team.member.setRole', { member_id: h.seats.carl.member_id, role: 'read_only' }));
  assert.equal(h.store.directory.projectRole(h.seats.carl.member_id, id), 'reader', 'the cascade made Carl a reader');
  assert.equal(members(alice).length, 1, 'a demotion to read-only');
  await h.ok(h.send('owner', 'team.member.revoke', { member_id: h.seats.rae.member_id }));
  assert.equal(members(alice).length, 2, 'a revoke');
  assert.equal((await h.store.leave({ memberId: h.seats.bob.member_id })).ok, true);
  assert.equal(members(alice).length, 3, 'a leave');
  assert.equal(members(owner).length, 3, 'the owner keeps the names-only list right');
  assert.equal(members(h.attach('bob', { cursor: 0 })).length, 0, 'a member who left hears nothing after (replay is re-checked)');
});

test('members.list answers only an active project the caller holds a row in', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  assert.equal((await h.store.markProjectDeleting({ actorMemberId: h.seats.alice.member_id, projectId: id })).ok, true);
  assert.equal(await h.reason(h.send('owner', 'team.project.members.list', { project_id: id })), 'team_not_found');
});

test('replay: a stored change goes to its audience only, re-checked at delivery', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  const cursor = h.core.events.cursor;
  await h.ok(h.send('alice', 'team.project.rename', { project_id: id, name: 'Replayed' }));
  await h.ok(h.send('owner', 'team.member.revoke', { member_id: h.seats.rae.member_id }));
  assert.deepEqual(h.projectFrames(h.attach('carl', { cursor })), [{ project_id: id, reason: 'renamed' }, { project_id: id, reason: 'members' }],
    'in the audience: the rename, then the member-list change of the revoke');
  assert.deepEqual(h.projectFrames(h.attach('bob', { cursor })), [], 'never in the audience');
  assert.deepEqual(h.projectFrames(h.attach('rae', { cursor })), [], 'revoked after the publish');
});

test('members: an admin adds, re-roles and removes; the store rules stand', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  const { bob, carl, rae, pia, alice } = h.seats;
  const params = (who, role) => ({ project_id: id, member_id: who.member_id, ...(role ? { role } : {}) });
  assert.equal(await h.reason(h.send('carl', 'team.project.members.add', params(bob, 'reader'))), 'role_forbidden');
  assert.equal(await h.reason(h.send('carl', 'team.project.members.setRole', params(rae, 'reader'))), 'role_forbidden');
  assert.equal(await h.reason(h.send('carl', 'team.project.members.remove', params(rae))), 'role_forbidden');
  assert.equal(await h.reason(h.send('alice', 'team.project.members.add', params(pia, 'reader'))), 'team_member_state_invalid');
  assert.equal(await h.reason(h.send('alice', 'team.project.members.setRole', params(rae, 'writer'))), 'team_project_role_capped');
  assert.equal(await h.reason(h.send('alice', 'team.project.members.setRole', params(alice, 'writer'))), 'team_project_last_admin');
  const recheck = h.state.recheckCalls;
  await h.ok(h.send('alice', 'team.project.members.setRole', params(carl, 'admin')));
  await h.ok(h.send('alice', 'team.project.members.remove', params(rae)));
  assert.equal(h.state.recheckCalls, recheck + 2, 'each member change asks the pool once');
  const listed = await h.ok(h.send('carl', 'team.project.members.list', { project_id: id }));
  // A member an admin removed hears that change and nothing later from the project.
  await h.ok(h.send('alice', 'team.project.members.add', params(bob, 'reader')));
  const bobStream = h.attach('bob');
  await h.ok(h.send('alice', 'team.project.members.remove', params(bob)));
  await h.ok(h.send('alice', 'team.project.rename', { project_id: id, name: 'After Bob' }));
  assert.deepEqual(h.projectFrames(bobStream), [{ project_id: id, reason: 'members' }]);
  assert.deepEqual(listed.members, [{ member_id: alice.member_id, role: 'admin' }, { member_id: carl.member_id, role: 'admin' }]);
  assert.equal(await h.reason(h.send('bob', 'team.project.members.list', { project_id: id })), 'team_not_found');
});

test('leave: a writer and a reader leave; the last admin cannot; a non-member reads team_not_found', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  for (const who of ['carl', 'rae']) {
    const stream = h.attach(who);
    const recheck = h.state.recheckCalls;
    await h.ok(h.send(who, 'team.project.leave', { project_id: id }), `${who} leaves`);
    assert.equal(h.store.directory.projectRole(h.seats[who].member_id, id), null);
    const [entry] = h.store.audit.read({ order: 'newest', limit: 1 }).entries;
    assert.deepEqual([entry.kind, entry.actor_member_id, entry.subject_member_id],
      ['project_member_removed', h.seats[who].member_id, h.seats[who].member_id]);
    assert.deepEqual(h.projectFrames(stream), [changed(id, 'members')], `${who} is told`);
    assert.equal(h.state.recheckCalls, recheck + 1);
    await h.ok(h.send('alice', 'team.project.rename', { project_id: id, name: `After ${who}` }));
    assert.deepEqual(h.projectFrames(stream), [changed(id, 'members')], `${who} hears nothing later`);
  }
  assert.equal(await h.reason(h.send('alice', 'team.project.leave', { project_id: id })), 'team_project_last_admin');
  assert.equal(await h.reason(h.send('bob', 'team.project.leave', { project_id: id })), 'team_not_found');
});

test('the owner who has not joined sees a name only, joins with an audit entry, then sees the project', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject('Hidden');
  assert.equal((await h.listed('owner')).includes(id), false);
  const unjoined = await h.ok(h.send('owner', 'team.project.unjoined'));
  assert.deepEqual(unjoined.projects, [{ project_id: id, name: 'Hidden' }]);
  for (const [operation, params] of [['team.project.members.list', {}], ['team.project.rename', { name: 'X' }],
    ['team.project.members.add', { member_id: h.seats.bob.member_id, role: 'reader' }]]) {
    assert.equal(await h.reason(h.send('owner', operation, { project_id: id, ...params })), 'team_not_found', operation);
  }
  for (const who of ['alice', 'rae']) {
    assert.equal(await h.reason(h.send(who, 'team.project.unjoined')), 'role_forbidden', who);
    assert.equal(await h.reason(h.send(who, 'team.project.join', { project_id: id, role: 'reader' })), 'role_forbidden', who);
  }
  assert.equal(await h.reason(h.send('owner', 'team.project.join', { project_id: 'project_nowhere', role: 'reader' })),
    'team_not_found');
  await h.ok(h.send('owner', 'team.project.join', { project_id: id, role: 'reader' }));
  assert.equal(h.store.audit.read({ order: 'newest', limit: 1 }).entries[0].kind, 'project_owner_self_added');
  assert.equal((await h.listed('owner')).includes(id), true);
  assert.deepEqual((await h.ok(h.send('owner', 'team.project.unjoined'))).projects, []);
  // An adminless project the owner holds a row in: join asks for admin.
  await h.ok(h.send('owner', 'team.member.setRole', { member_id: h.seats.alice.member_id, role: 'read_only' }));
  await h.ok(h.send('owner', 'team.project.join', { project_id: id, role: 'reader' }));
  assert.equal(h.store.directory.projectRole(h.seats.owner.member_id, id), 'admin');
});

test('the audit read returns a project\'s entries only to an owner who holds a row in it now', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  const read = async (params = {}) => h.ok(h.send('owner', 'team.audit.read', { limit: 100, ...params }));
  const projectEntries = (page) => page.entries.filter((entry) => entry.project_id === id);
  assert.deepEqual(projectEntries(await read()), []);
  const total = (await read()).entries.length;
  const firstProjectSeq = h.store.audit.read({}).entries.find((entry) => entry.project_id === id).seq;
  const filtered = await read({ cursor: firstProjectSeq - 1, limit: 1 });
  assert.deepEqual(filtered.entries, []);
  assert.equal(filtered.next_cursor, firstProjectSeq, 'an all-filtered page still moves the cursor');
  await h.ok(h.send('owner', 'team.project.join', { project_id: id, role: 'reader' }));
  assert.equal(projectEntries(await read()).length, 4, 'created, two adds and the self-add');
  assert.equal((await read()).entries.length, total + 4);
});

test('events: an unlisted type is dropped and a bucketless type other than these two is denied', async (t) => {
  const h = await createTeamProjectFixture(t);
  const alice = h.attach('alice');
  const audience = new Set([h.seats.alice.member_id]);
  h.core.events.publish('team_unlisted_kind', { x: 1 }, { audience });
  h.core.events.publish('team_chat_read', { channel_id: 'chan_team' }, { audience });
  assert.deepEqual(alice.frames.filter((frame) => /team_unlisted_kind|team_chat_read/u.test(frame)), []);
});

test('the generic project operations answer unsupported_operation on a team host, with no receipt', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  const backendCalls = h.backend.projectCalls.length;
  for (const who of ['owner', 'alice']) {
    for (const [operation, params] of [['projects.create', { name: 'Generic' }], ['projects.rename', { project_id: id, name: 'G' }],
      ['projects.bindRoot', { project_id: id, root_path: '/srv/x', expected_root_revision: 0 }]]) {
      const command = { request_id: `request_generic_${who}_${operation.replace('.', '_')}` };
      assert.equal(await h.reason(h.send(who, operation, params, command)), 'unsupported_operation', `${operation} ${who}`);
      const status = await h.ok(h.send(who, 'requests.status', { request_id: command.request_id }));
      assert.equal(status.state, 'unknown', 'no receipt was written');
    }
  }
  assert.equal(h.backend.projectCalls.length, backendCalls);
  assert.equal(h.state.app.calls.filter((call) => call === 'create').length, 1, 'only the shared project');
});

test('sessions.create takes project_id: a writer creates in the project and only its members hear it', async (t) => {
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  const streams = Object.fromEntries(['alice', 'carl', 'rae', 'bob', 'owner'].map((who) => [who, h.attach(who)]));
  const created = await h.ok(h.send('carl', 'sessions.create', { title: 'In P', project_id: id }));
  assert.equal(h.backend.sessionStore.getSessionSummary(created.session.session_id).project_id, id);
  const heard = (who) => streams[who].frames.some((frame) => frame.includes(created.session.session_id));
  assert.deepEqual(['alice', 'carl', 'rae', 'bob', 'owner'].map(heard), [true, true, true, false, false]);
  assert.equal(await h.reason(h.send('rae', 'sessions.create', { title: 'R', project_id: id })), 'role_forbidden');
  assert.equal(await h.reason(h.send('bob', 'sessions.create', { title: 'B', project_id: id })), 'team_not_found');
  assert.equal(await h.reason(h.send('carl', 'sessions.create', { title: 'G' })), 'team_project_required');
  // A project id with no team row and no record: the owner is refused, and no conversation is made.
  const count = h.backend.sessionStore.listSessions().length;
  const missing = await h.send('owner', 'sessions.create', { title: 'Nowhere', project_id: 'project_missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.reason, 'backend_unavailable');
  assert.equal(h.backend.sessionStore.listSessions().length, count);
});

test('every command answers team_unavailable until the application project service exists', async (t) => {
  const h = await createTeamProjectFixture(t);
  h.state.app = null;
  assert.equal(await h.reason(h.send('alice', 'team.project.create', { name: 'Early' })), 'team_unavailable');
  assert.equal(await h.reason(h.send('owner', 'team.project.unjoined')), 'team_unavailable');
});

test('a publisher or a pool that throws never reaches the store', async (t) => {
  const { createProjectAnnouncer, subscribeProjectChanges } = require('../../server/team/team-project-commands');
  const h = await createTeamProjectFixture(t);
  const id = await h.sharedProject();
  const announce = createProjectAnnouncer({ directory: h.store.directory, logger: h.fx.logger,
    publish: () => { throw new Error('publisher down'); } });
  const off = subscribeProjectChanges({ store: h.store, announce, logger: h.fx.logger,
    pool: () => ({ recheckLeases: () => { throw new Error('pool down'); } }) });
  t.after(off);
  await h.ok(h.send('alice', 'team.project.members.add', { project_id: id, member_id: h.seats.bob.member_id, role: 'reader' }));
  assert.equal(h.store.directory.isDegraded(), false);
  assert.equal(h.store.directory.projectRole(h.seats.bob.member_id, id), 'reader');
  for (const event of ['team_project.announce_failed', 'team_project.pool_recheck_failed']) {
    assert.equal(h.fx.logs.filter((entry) => entry.event === event).length, 1, event);
  }
});
