'use strict';

// Slice 3-9 commit 1: what a team host's answers add for the member client, each re-checked by the one
// authorization function. A `projects.list` row carries the caller's stored role and no host folder path or
// authority key, and the answer says whether the host serves files; `session.view` names the members viewing
// a conversation to a caller who may read it; a resolved approval's `decision_changed` names the approver and
// the decision. The single-owner host and a router with no team commands answer `projects.list` as before.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixture, command } = require('../helpers/command-router-fixture');
const { createProjectCommandDispatcher } = require('../../services/host/project-commands');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');
const { BOUNDED, frames, reasonOf, setup } = require('./helpers/team-approvals-fixture');
const { createRateLimiter } = require('../../server/team/rate-limit');
const { createTeamCommands } = require('../../server/team/team-commands');
const { VIEW_LIMIT } = require('../../server/team/team-approvals');

const ROW_KEYS = ['id', 'name', 'role', 'root_revision'];

test('a member\'s projects.list row carries its stored role, no host path or authority key; non-members see none', BOUNDED,
  async (t) => {
    const h = await createTeamProjectFixture(t, { projectsRoot: true });
    const P = await h.sharedProject('Apollo');
    assert.equal(typeof h.state.app.records.get(P).root_path, 'string', 'the host holds a real folder path for it');
    for (const [who, role] of [['alice', 'admin'], ['carl', 'writer'], ['rae', 'reader']]) {
      const listed = await h.ok(h.send(who, 'projects.list'), `${who} list`);
      const row = listed.projects.find((project) => project.id === P);
      assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, `${who}: closed row`);
      assert.equal(row.role, role, who);
      assert.equal(listed.files_supported, false, 'no file transfer wired on this host');
      assert.equal(JSON.stringify(listed).includes(h.roots.projectsRoot), false, `${who} gets no host path`);
      assert.equal(JSON.stringify(listed).includes('authority_'), false, `${who} gets no authority key`);
    }
    for (const who of ['bob', 'owner']) {
      assert.deepEqual((await h.listed(who)).filter((id) => id === P), [], `${who} is not in the project`);
    }
    assert.equal(await h.reason(h.send('pia', 'projects.list')), 'member_pending');
  });

test('a role change reads at once; the owner with no row reads `owner`; files_supported comes from the host', BOUNDED,
  async (t) => {
    const h = await createTeamProjectFixture(t, { projectsRoot: true, files: {} });
    const P = await h.sharedProject('Apollo');
    const rowOf = async (who) => (await h.ok(h.send(who, 'projects.list'))).projects.find((project) => project.id === P);
    await h.ok(h.send('alice', 'team.project.members.setRole', { project_id: P, member_id: h.seats.carl.member_id,
      role: 'reader' }));
    assert.equal((await rowOf('carl')).role, 'reader');
    // A record the application service holds with no team row: visible to the active owner alone (its
    // projectAccess answers admin), and the stored row it lacks reads `owner`.
    const loose = h.state.app.createProject({ name: 'Loose' }).project.id;
    const ownerList = await h.ok(h.send('owner', 'projects.list'));
    assert.equal(ownerList.projects.find((project) => project.id === loose)?.role, 'owner');
    assert.equal(ownerList.files_supported, true, 'a host with a transfer core serves files');
    assert.deepEqual((await h.listed('alice')).filter((id) => id === loose), []);
    await h.ok(h.send('owner', 'team.project.join', { project_id: P, role: 'writer' }));
    assert.equal((await rowOf('owner')).role, 'writer', 'the owner\'s own row once joined');
  });

test('a read-only team member reads `reader` on its project rows, whatever its stored writer or admin row (fix 2)',
  BOUNDED, async (t) => {
    const h = await createTeamProjectFixture(t, { projectsRoot: true });
    const P = await h.sharedProject('Apollo');
    const roleOf = async (who) => (await h.ok(h.send(who, 'projects.list'))).projects.find((project) => project.id === P)?.role;
    assert.deepEqual([await roleOf('alice'), await roleOf('carl')], ['admin', 'writer'], 'the stored rows');
    for (const who of ['alice', 'carl']) {
      assert.equal((await h.store.setRole({ actorMemberId: h.seats.owner.member_id, memberId: h.seats[who].member_id,
        role: 'read_only' })).ok, true);
    }
    assert.deepEqual([await roleOf('alice'), await roleOf('carl')], ['reader', 'reader'], 'the effective role');
    // The store caps rows on that change, so a directory that still holds the stored rows shows the rule itself.
    const rows = { project_w: 'writer', project_a: 'admin' };
    const directory = { liveActor: () => ({ member_id: 'member_ro', role: 'read_only', state: 'active' }),
      projectRole: (memberId, projectId) => rows[projectId] ?? null };
    const commands = createTeamCommands({ store: { snapshot() {}, rename() {} }, invites: { create() {} }, directory });
    const { roleOf: effective } = commands.projectListExtras({ deviceId: 'device_ro' });
    assert.deepEqual([effective('project_w'), effective('project_a'), effective('project_none')], ['reader', 'reader', null]);
    directory.liveActor = () => ({ member_id: 'member_rw', role: 'member', state: 'active' });
    assert.deepEqual(['project_w', 'project_a'].map(commands.projectListExtras({ deviceId: 'd' }).roleOf), ['writer', 'admin']);
    // files_supported is the files module's own answer: unavailable, throwing or absent reads false.
    const supported = (files) => createTeamCommands({ store: { snapshot() {}, rename() {} }, invites: { create() {} }, directory,
      files }).projectListExtras({ deviceId: 'd' }).filesSupported;
    const module = (answer) => ({ handles: () => false, supported: answer });
    assert.deepEqual([supported(module(() => true)), supported(module(() => false)),
      supported(module(() => { throw new Error('x'); })), supported(null)], [true, false, false, false]);
  });

test('session.view at the member client ceiling for two minutes keeps its own limit and leaves decisions alone (fix 1a)',
  BOUNDED, async (t) => {
    let now = 5_000_000;
    const s = await setup(t, { approvalOptions: { viewLimiter: createRateLimiter({ ...VIEW_LIMIT, clock: () => now }) } });
    // 8 open conversations on 3 devices, one view each every 20 s: 72 a minute, all for one member.
    for (let minute = 0; minute < 2; minute += 1) {
      for (let view = 0; view < 8 * 3 * 3; view += 1) {
        const answer = await s.send('carl', 'session.view', {}, { session_id: s.sP });
        assert.equal(answer.ok, true, `minute ${minute} view ${view}: ${reasonOf(answer)}`);
      }
      const approval = s.openApproval(s.sP, { call: `call_${minute}` });
      assert.equal((await s.resolve('carl', approval, true)).ok, true, 'an approval still answers');
      now += 60_000;
    }
    assert.ok(VIEW_LIMIT.limit >= 2 * 8 * 3 * 3, 'twice the ceiling');
  });

test('the single-owner host and a router with no team commands keep projects.list as it was', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const listed = await fixture.router.dispatch(command(fixture.a, 'projects.list'), fixture.contextA);
  assert.equal(listed.ok, true);
  assert.equal(Object.hasOwn(listed, 'files_supported'), false);
  assert.deepEqual(Object.keys(listed.projects[0]).sort(), ['authority_key', 'id', 'name', 'root_path', 'root_revision']);
  assert.equal(listed.projects[0].authority_key, `authority_${'a'.repeat(64)}`);

  // The dispatcher alone, built as the desktop and the single-owner host build it (no `team` option).
  const applicationService = { listProjects: () => ({ ok: true, storage: { read_only: false, reason: null },
    projects: [{ id: 'project_one', name: 'One', root_path: '/srv/one', root_revision: 2,
      authority_key: `authority_${'b'.repeat(64)}` }] }) };
  const authorization = { identity: () => null, allows: () => true };
  const before = await createProjectCommandDispatcher({ applicationService, authorization })
    .dispatch({ operation: 'projects.list', params: {}, request_id: 'request_1' }, {});
  assert.deepEqual(before, { ok: true, storage: { read_only: false, reason: null }, projects: [{ id: 'project_one',
    name: 'One', root_path: '/srv/one', root_revision: 2, authority_key: `authority_${'b'.repeat(64)}` }] });
  // A team router with no team commands: no path, no role it cannot read, no file transfer.
  const team = await createProjectCommandDispatcher({ applicationService, authorization,
    team: { teamHost: true, listExtras: null } }).dispatch({ operation: 'projects.list', params: {}, request_id: 'r' }, {});
  assert.deepEqual(team.projects, [{ id: 'project_one', name: 'One', root_revision: 2, role: null }]);
  assert.equal(team.files_supported, false);
  // listExtras is read once per call, not per row.
  let reads = 0;
  const twoRows = { listProjects: () => ({ ok: true, storage: {}, projects: [
    { id: 'project_a', name: 'A', root_path: null, root_revision: 0 },
    { id: 'project_b', name: 'B', root_path: null, root_revision: 0 }] }) };
  const once = await createProjectCommandDispatcher({ applicationService: twoRows, authorization,
    team: { teamHost: true, listExtras: () => { reads += 1; return { filesSupported: true, roleOf: () => 'writer' }; } } })
    .dispatch({ operation: 'projects.list', params: {}, request_id: 'r' }, {});
  assert.equal(reads, 1);
  assert.deepEqual(once.projects.map((row) => row.role), ['writer', 'writer']);
  assert.equal(once.files_supported, true);
});

test('session.view names the members viewing it, only to a caller who may read it', BOUNDED, async (t) => {
  const s = await setup(t);
  await s.look('carl', s.sP);
  assert.deepEqual(await s.send('alice', 'session.view', {}, { session_id: s.sP }),
    { ok: true, viewing: true, viewers: [s.member('carl'), s.member('alice')] });
  assert.deepEqual((await s.send('rae', 'session.view', {}, { session_id: s.sP })).viewers,
    [s.member('carl'), s.member('alice'), s.member('rae')], 'a reader may read it too');
  const refused = await s.send('bob', 'session.view', {}, { session_id: s.sP });
  assert.equal(reasonOf(refused), 'team_not_found');
  assert.equal(Object.hasOwn(refused, 'viewers'), false);
  assert.equal(reasonOf(await s.send('owner', 'session.view', {}, { session_id: s.sP })), 'team_not_found');
  s.advance(46_000);
  assert.deepEqual((await s.send('alice', 'session.view', {}, { session_id: s.sP })).viewers, [s.member('alice')],
    'lapsed records name nobody');
});

test('a resolved approval\'s decision_changed names the approver and the decision, to the project only', BOUNDED,
  async (t) => {
    const s = await setup(t);
    const rae = s.h.attach('rae');
    const bob = s.h.attach('bob');
    await s.look('carl', s.sP);
    const first = s.openApproval(s.sP);
    assert.equal((await s.resolve('carl', first, true)).ok, true);
    const second = s.openApproval(s.sP, { call: 'call_2' });
    await s.look('alice', s.sP);
    assert.equal((await s.resolve('alice', second, false)).ok, true);
    const seen = frames(rae, 'decision_changed').map((frame) => [frame.approval_id, frame.approver_member_id, frame.approved,
      frame.prompter_member_id]);
    assert.deepEqual(seen, [[first.approvalId, s.member('carl'), true, s.member('alice')],
      [second.approvalId, s.member('alice'), false, s.member('alice')]]);
    assert.deepEqual(frames(bob, 'decision_changed'), []);
    // A question batch is not an approval: its event gains neither key.
    const ref = s.openQuestions(s.sP2);
    await s.look('carl', s.sP2);
    assert.equal((await s.answerQ('carl', s.sP2, ref)).ok, true);
    const question = frames(rae, 'decision_changed').find((frame) => frame.question_ref === ref);
    assert.equal(Object.hasOwn(question, 'approver_member_id'), false);
    assert.equal(Object.hasOwn(question, 'approved'), false);
  });
