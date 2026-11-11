'use strict';

// Slice 3-1 of shared projects (docs/plans/TEAM_PROJECTS_SPEC.md): project
// membership in the team member store, schema 2, its directory reads, the
// cascades from team changes, and the audit entries.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');

const P1 = 'project_p1';

function reasonOf(result) {
  assert.equal(result.ok, false, 'expected a failure');
  return result.error.reason;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function lastAudit(store, count = 1) {
  return store.audit.read({ order: 'newest', limit: count }).entries.reverse();
}

// A store with the whole team and project_p1: A admin, T writer.
async function teamWithProject(t, overrides = {}) {
  const fx = createFixture(t);
  const store = fx.openStore(overrides);
  const ids = await fx.buildTeam(store);
  const created = await store.createProject({ actorMemberId: ids.A, projectId: P1 });
  assert.equal(created.ok, true);
  assert.equal((await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.T, role: 'writer' })).ok, true);
  return { fx, store, ids };
}

// ---------------------------------------------------------------- migration

test('a schema 1 members file loads, behaves, and is written as schema 2 by its first commit', async (t) => {
  const fx = createFixture(t);
  const ids = await fx.buildTeam(fx.openStore());
  const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  delete doc.projects;
  doc.schema_version = 1;
  fs.writeFileSync(fx.memberFile, JSON.stringify(doc));
  const before = fs.readFileSync(fx.memberFile);

  const store = fx.openStore();
  assert.equal(store.rev(), doc.rev);
  assert.equal(store.getMember(ids.M).state, 'active');
  assert.deepEqual(store.directory.projectsOf(ids.M), []);
  assert.deepEqual(fs.readFileSync(fx.memberFile), before, 'opening never writes');
  assert.ok(fx.logs.some((entry) => entry.event === 'team_store.upgraded'));

  assert.equal((await store.createProject({ actorMemberId: ids.M, projectId: P1 })).ok, true);
  const written = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  assert.equal(written.schema_version, 2);
  assert.equal(written.rev, doc.rev + 1);
  assert.deepEqual(written.projects.map((project) => project.project_id), [P1]);
  assert.deepEqual(written.members, doc.members, 'user state is kept as it was');
});

test('a schema 1 members file with a projects key, or broken by the schema 1 rules, fails closed', async (t) => {
  for (const mutate of [(doc) => { doc.projects = []; }, (doc) => { doc.members[0].role = 'admin'; }]) {
    const fx = createFixture(t);
    await fx.buildTeam(fx.openStore());
    const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
    delete doc.projects;
    doc.schema_version = 1;
    mutate(doc);
    fs.writeFileSync(fx.memberFile, JSON.stringify(doc));
    const before = fs.readFileSync(fx.memberFile);
    assert.equal(reasonOf(fx.newStore().open()), 'team_unavailable');
    assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  }
});

test('a schema 3 members file fails closed and is left byte for byte', async (t) => {
  const fx = createFixture(t);
  await fx.buildTeam(fx.openStore());
  const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  doc.schema_version = 3;
  fs.writeFileSync(fx.memberFile, JSON.stringify(doc));
  const before = fs.readFileSync(fx.memberFile);
  const store = fx.newStore();
  assert.equal(reasonOf(store.open()), 'team_store_schema_unsupported');
  assert.equal(reasonOf(await store.createProject({ actorMemberId: 'member_x', projectId: P1 })),
    'team_store_schema_unsupported');
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
});

test('a corrupt projects value fails closed and rewrites nothing', async (t) => {
  const row = (ids, members) => ({
    project_id: P1, created_by: ids.A, created_at: 1, state: 'active', members,
  });
  const entry = (memberId, role = 'admin') => ({
    member_id: memberId, role, added_by: memberId, added_at: 1,
  });
  const cases = [
    () => 'not an array',
    (ids) => [{ ...row(ids, [entry(ids.A)]), name: 'Secret plan' }],
    (ids) => [row(ids, [entry(ids.A)]), row(ids, [entry(ids.T)])],
    (ids) => [row(ids, [entry(ids.A), entry(ids.A, 'writer')])],
    (ids) => [row(ids, [entry('member_nobodyAAAAAAAAAAAAA')])],
    (ids) => [row(ids, [entry(ids.V)])],
    (ids) => [row(ids, [entry(ids.P)])],
    (ids) => [row(ids, [entry(ids.R, 'writer')])],
    (ids) => [row(ids, [entry(ids.A, 'owner')])],
    (ids) => [{ ...row(ids, [entry(ids.A)]), project_id: 'project_general' }],
    (ids) => [{ ...row(ids, [entry(ids.A)]), state: 'archived' }],
    (ids) => Array.from({ length: 65 }, (_, index) => ({ ...row(ids, []), project_id: `project_${index}` })),
  ];
  for (const projects of cases) {
    const fx = createFixture(t);
    const ids = await fx.buildTeam(fx.openStore());
    const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
    doc.projects = projects(ids);
    fs.writeFileSync(fx.memberFile, JSON.stringify(doc));
    const before = fs.readFileSync(fx.memberFile);
    const store = fx.newStore();
    assert.equal(reasonOf(store.open()), 'team_unavailable', JSON.stringify(doc.projects).slice(0, 80));
    assert.equal(store.directory.projectRole(ids.A, P1), null);
    assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  }
});

// ---------------------------------------------------------------- authority

// Every transition, every actor state, every project role: one table. Each cell
// runs the pure transition on a copy of one team; `ok` cells must also leave a
// document the store would load.
const OK = 'ok';
const RF = 'role_forbidden';
const NF = 'team_not_found';
const OPS = ['create', 'add', 'setRole', 'remove', 'markDeleting', 'delete'];
const AUTHORITY = [
  // actor, project role, create, add, setRole, remove, markDeleting, delete
  ['O', 'admin', OK, OK, OK, OK, OK, OK],
  ['O', 'writer', OK, RF, RF, RF, OK, OK],
  ['O', 'reader', OK, RF, RF, RF, OK, OK],
  ['O', null, OK, RF, RF, RF, OK, OK],
  ['M', 'admin', OK, OK, OK, OK, OK, OK],
  ['M', 'writer', OK, RF, RF, RF, RF, NF],
  ['M', 'reader', OK, RF, RF, RF, RF, NF],
  ['M', null, OK, NF, NF, NF, NF, NF],
  ['R', 'reader', 'team_project_read_only', RF, RF, RF, RF, NF],
  ['R', null, 'team_project_read_only', NF, NF, NF, NF, NF],
  ['P', null, ...Array(6).fill('member_pending')],
  ['V', null, ...Array(6).fill('member_revoked')],
  ['unknown', null, ...Array(6).fill(NF)],
  ['missing', null, ...Array(6).fill(NF)],
];

test('authority: every project transition times every actor state and project role', async (t) => {
  const transitions = require('../../server/team/project-transitions');
  const { validateDocument } = require('../../server/team/member-schema');
  const fx = createFixture(t);
  const store = fx.openStore();
  const ids = await fx.buildTeam(store);
  const base = store.snapshot();
  const actorId = (label) => {
    if (label === 'unknown') return 'member_unknownAAAAAAAAAAAAA';
    return label === 'missing' ? undefined : ids[label];
  };
  const run = {
    create: (doc, actor) => transitions.createProject(doc, { actorMemberId: actor }, ctx()),
    add: (doc, actor) => transitions.addProjectMember(doc, { actorMemberId: actor, projectId: P1, memberId: ids.X, role: 'writer' }, ctx()),
    setRole: (doc, actor) => transitions.setProjectRole(doc, { actorMemberId: actor, projectId: P1, memberId: ids.T, role: 'reader' }, ctx()),
    remove: (doc, actor) => transitions.removeProjectMember(doc, { actorMemberId: actor, projectId: P1, memberId: ids.T }, ctx()),
    markDeleting: (doc, actor) => transitions.markProjectDeleting(doc, { actorMemberId: actor, projectId: P1 }, ctx()),
    delete: (doc, actor) => transitions.deleteProject(doc, { actorMemberId: actor, projectId: P1 }, ctx()),
  };
  function ctx() { return { now: fx.clock(), newProjectId: () => 'project_new' }; }
  let cells = 0;
  for (const [label, role, ...expected] of AUTHORITY) {
    OPS.forEach((op, index) => {
      const doc = clone(base);
      const members = [{ member_id: ids.A, role: 'admin', added_by: ids.A, added_at: 1 },
        { member_id: ids.T, role: 'writer', added_by: ids.A, added_at: 1 }];
      if (role) members.push({ member_id: ids[label], role, added_by: ids.A, added_at: 1 });
      doc.projects.push({
        project_id: P1, created_by: ids.A, created_at: 1, state: op === 'delete' ? 'deleting' : 'active', members,
      });
      const untouched = clone(doc);
      const outcome = run[op](doc, actorId(label));
      const cell = `${label}/${role}/${op}`;
      if (expected[index] === OK) {
        assert.equal(outcome.ok, true, cell);
        assert.equal(outcome.audit.length, 1, cell);
        assert.equal(validateDocument(doc).ok, true, cell);
      } else {
        assert.equal(outcome.ok, false, cell);
        assert.equal(outcome.failure.error.reason, expected[index], cell);
        assert.deepEqual(doc, untouched, `${cell}: a refusal changes nothing`);
      }
      cells += 1;
    });
  }
  assert.equal(cells, AUTHORITY.length * OPS.length);
});

test('a missing or unknown actor is refused by every store method, never read as the owner', async (t) => {
  const { store, ids } = await teamWithProject(t);
  const rev = store.rev();
  for (const actorMemberId of [undefined, null, '', 'member_unknownAAAAAAAAAAAAA', 42]) {
    const calls = [
      store.createProject({ actorMemberId }),
      store.addProjectMember({ actorMemberId, projectId: P1, memberId: ids.X, role: 'reader' }),
      store.setProjectRole({ actorMemberId, projectId: P1, memberId: ids.T, role: 'reader' }),
      store.removeProjectMember({ actorMemberId, projectId: P1, memberId: ids.T }),
      store.markProjectDeleting({ actorMemberId, projectId: P1 }),
      store.deleteProject({ actorMemberId, projectId: P1 }),
    ];
    for (const result of await Promise.all(calls)) assert.equal(reasonOf(result), 'team_not_found');
  }
  assert.equal(store.rev(), rev);
});

// ------------------------------------------------------------------- rules

test('the last admin of an active project cannot be removed or demoted', async (t) => {
  const { store, ids } = await teamWithProject(t);
  const rev = store.rev();
  assert.equal(reasonOf(await store.removeProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.A })),
    'team_project_last_admin');
  assert.equal(reasonOf(await store.setProjectRole({ actorMemberId: ids.A, projectId: P1, memberId: ids.A, role: 'writer' })),
    'team_project_last_admin');
  assert.equal(store.rev(), rev);
  assert.equal((await store.setProjectRole({ actorMemberId: ids.A, projectId: P1, memberId: ids.T, role: 'admin' })).ok, true);
  assert.equal((await store.removeProjectMember({ actorMemberId: ids.T, projectId: P1, memberId: ids.A })).ok, true);
  assert.equal(store.directory.projectRole(ids.T, P1), 'admin');
  assert.equal(store.directory.projectRole(ids.A, P1), null);
});

test('the owner adds themself to any project, with its own audit kind; not anyone else', async (t) => {
  const { store, ids } = await teamWithProject(t);
  assert.equal(reasonOf(await store.addProjectMember({ actorMemberId: ids.O, projectId: P1, memberId: ids.X, role: 'reader' })),
    'role_forbidden');
  const added = await store.addProjectMember({ actorMemberId: ids.O, projectId: P1, memberId: ids.O, role: 'admin' });
  assert.equal(added.ok, true);
  const [entry] = lastAudit(store);
  assert.deepEqual([entry.kind, entry.actor_member_id, entry.subject_member_id, entry.project_id, entry.detail, entry.name],
    ['project_owner_self_added', ids.O, ids.O, P1, 'role=admin', null]);
  assert.equal(store.directory.projectRole(ids.O, P1), 'admin');
  assert.equal(reasonOf(await store.addProjectMember({ actorMemberId: ids.O, projectId: P1, memberId: ids.O, role: 'admin' })),
    'team_project_member_exists');
  // A member who is not the owner cannot add themself.
  assert.equal(reasonOf(await store.addProjectMember({ actorMemberId: ids.M, projectId: P1, memberId: ids.M, role: 'reader' })),
    'team_not_found');
});

// The owner holds a row in P1 when its only admin, A, goes: the owner promotes
// themself, and only while P1 has no admin.
async function ownerPromotes(store, ownerId, others, from) {
  const self = (role) => store.setProjectRole({ actorMemberId: ownerId, projectId: P1, memberId: ownerId, role });
  assert.equal(reasonOf(await self('reader')), 'role_forbidden', 'the path names admin only');
  assert.equal(reasonOf(await store.setProjectRole({ actorMemberId: ownerId, projectId: P1, memberId: others.T, role: 'admin' })),
    'role_forbidden', 'the owner still promotes nobody else');
  assert.equal(reasonOf(await store.setProjectRole({ actorMemberId: others.T, projectId: P1, memberId: others.T, role: 'admin' })),
    'role_forbidden', 'a non-owner cannot use the path');
  assert.equal((await self('admin')).ok, true);
  const [entry] = lastAudit(store);
  assert.deepEqual([entry.kind, entry.actor_member_id, entry.subject_member_id, entry.detail],
    ['project_owner_self_added', ownerId, ownerId, `from=${from},to=admin`]);
  assert.equal(store.directory.projectRole(ownerId, P1), 'admin');
  assert.equal((await store.addProjectMember({ actorMemberId: ownerId, projectId: P1, memberId: others.X, role: 'reader' })).ok, true);
}

test('an owner with a row in a project its cascade left adminless promotes themself', async (t) => {
  const orphan = {
    revoke: (store, ids) => store.revokeMember({ actorMemberId: ids.O, memberId: ids.A }),
    leave: (store, ids) => store.leave({ memberId: ids.A }),
    read_only: (store, ids) => store.setRole({ actorMemberId: ids.O, memberId: ids.A, role: 'read_only' }),
  };
  for (const [label, act] of Object.entries(orphan)) {
    const { store, ids } = await teamWithProject(t);
    assert.equal((await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.O, role: 'writer' })).ok, true);
    assert.equal(reasonOf(await store.setProjectRole({ actorMemberId: ids.O, projectId: P1, memberId: ids.O, role: 'admin' })),
      'role_forbidden', `${label}: no self-promotion while an admin exists`);
    assert.equal((await act(store, ids)).ok, true, label);
    assert.match(lastAudit(store)[0].detail, /adminless=1$/u, label);
    await ownerPromotes(store, ids.O, ids, 'writer');
  }
});

test('a new owner holding a non-admin row recovers an adminless project after a transfer', async (t) => {
  const { store, ids } = await teamWithProject(t);
  assert.equal((await store.transferOwner({ actorMemberId: ids.O, memberId: ids.M })).ok, true);
  assert.equal((await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.M, role: 'reader' })).ok, true);
  assert.equal((await store.revokeMember({ actorMemberId: ids.M, memberId: ids.A })).ok, true);
  await ownerPromotes(store, ids.M, ids, 'reader');
});

test('an owner who self-adds below admin into an adminless project is not stuck there', async (t) => {
  const { store, ids } = await teamWithProject(t);
  assert.equal((await store.revokeMember({ actorMemberId: ids.O, memberId: ids.A })).ok, true);
  assert.equal((await store.addProjectMember({ actorMemberId: ids.O, projectId: P1, memberId: ids.O, role: 'writer' })).ok, true);
  await ownerPromotes(store, ids.O, ids, 'writer');
});

test('a read-only member is only ever a reader; only an active member is added', async (t) => {
  const { store, ids } = await teamWithProject(t);
  const rev = store.rev();
  for (const role of ['writer', 'admin']) {
    assert.equal(reasonOf(await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.R, role })),
      'team_project_role_capped');
  }
  assert.equal(reasonOf(await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.P, role: 'reader' })),
    'team_member_state_invalid');
  assert.equal(reasonOf(await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.V, role: 'reader' })),
    'team_member_state_invalid');
  assert.equal(reasonOf(await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.X, role: 'owner' })),
    'team_project_role_invalid');
  assert.equal(store.rev(), rev);
  assert.equal((await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.R, role: 'reader' })).ok, true);
  assert.equal(reasonOf(await store.setProjectRole({ actorMemberId: ids.A, projectId: P1, memberId: ids.R, role: 'writer' })),
    'team_project_role_capped');
});

test('duplicate adds, unknown projects and bad ids are refused with nothing changed', async (t) => {
  const { fx, store, ids } = await teamWithProject(t);
  const before = fs.readFileSync(fx.memberFile);
  const auditBefore = fs.readFileSync(fx.auditFile);
  const refusals = [
    [store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.T, role: 'reader' }), 'team_project_member_exists'],
    [store.addProjectMember({ actorMemberId: ids.A, projectId: 'project_nope', memberId: ids.X, role: 'reader' }), 'team_not_found'],
    [store.setProjectRole({ actorMemberId: ids.A, projectId: P1, memberId: ids.X, role: 'reader' }), 'team_not_found'],
    [store.removeProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: 'member_nopeAAAAAAAAAAAAAAA' }), 'team_not_found'],
    [store.createProject({ actorMemberId: ids.M, projectId: P1 }), 'team_project_exists'],
    [store.createProject({ actorMemberId: ids.M, projectId: 'project_general' }), 'team_project_id_invalid'],
    [store.createProject({ actorMemberId: ids.M, projectId: '../etc' }), 'team_project_id_invalid'],
    [store.deleteProject({ actorMemberId: ids.A, projectId: P1 }), 'team_project_state_invalid'],
    [store.markProjectDeleting({ actorMemberId: ids.A, projectId: P1, counts: { conversations: -1, files: 0 } }),
      'team_project_counts_invalid'],
  ];
  for (const [call, reason] of refusals) assert.equal(reasonOf(await call), reason);
  const same = await store.setProjectRole({ actorMemberId: ids.A, projectId: P1, memberId: ids.T, role: 'writer' });
  assert.deepEqual([same.ok, same.changed], [true, false]);
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  assert.deepEqual(fs.readFileSync(fx.auditFile), auditBefore);
});

test('create generates an application-shaped id; delete goes through deleting and refuses member changes there', async (t) => {
  const { store, ids } = await teamWithProject(t);
  const created = await store.createProject({ actorMemberId: ids.M });
  assert.match(created.project_id, /^project_[0-9a-f]{32}$/u);
  assert.deepEqual(store.directory.projectsOf(ids.M), [{ project_id: created.project_id, role: 'admin' }]);

  const marked = await store.markProjectDeleting({ actorMemberId: ids.A, projectId: P1, counts: { conversations: 3, files: 12 } });
  assert.equal(marked.ok, true);
  assert.equal(lastAudit(store)[0].detail, 'conversations=3,files=12');
  assert.equal(reasonOf(await store.markProjectDeleting({ actorMemberId: ids.A, projectId: P1 })), 'team_project_deleting');
  assert.equal(reasonOf(await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.X, role: 'reader' })),
    'team_project_deleting');
  assert.equal(reasonOf(await store.removeProjectMember({ actorMemberId: ids.T, projectId: P1, memberId: ids.T })),
    'team_not_found', 'a writer no longer sees a deleting project');
  assert.equal((await store.deleteProject({ actorMemberId: ids.O, projectId: P1 })).ok, true);
  assert.equal(store.getProject(P1), null);
  assert.deepEqual(lastAudit(store, 2).map((entry) => entry.kind), ['project_deleting', 'project_deleted']);
});

// ---------------------------------------------------------------- cascades

async function inTwoProjects(t, overrides) {
  const setup = await teamWithProject(t, overrides);
  const { store, ids } = setup;
  assert.equal((await store.createProject({ actorMemberId: ids.T, projectId: 'project_p2' })).ok, true);
  assert.equal((await store.addProjectMember({ actorMemberId: ids.T, projectId: 'project_p2', memberId: ids.A, role: 'admin' })).ok, true);
  return setup;
}

test('revoke, leave and set read-only change the member and the project rows in one commit', async (t) => {
  const cases = [
    ['revoke', (store, ids) => store.revokeMember({ actorMemberId: ids.O, memberId: ids.T }), 'member_revoked', 'was=active,projects=2'],
    ['leave', (store, ids) => store.leave({ memberId: ids.T }), 'member_left', 'was=active,projects=2'],
    ['read_only', (store, ids) => store.setRole({ actorMemberId: ids.O, memberId: ids.T, role: 'read_only' }),
      'role_changed', 'from=member,to=read_only,projects=2'],
  ];
  for (const [label, act, kind, detail] of cases) {
    const { fx, store, ids } = await inTwoProjects(t);
    const rev = store.rev();
    const seqBefore = store.audit.read({ order: 'newest', limit: 1 }).entries[0].seq;
    assert.equal((await act(store, ids)).ok, true, label);
    assert.equal(store.rev(), rev + 1, `${label}: one revision step`);
    const added = store.audit.read({ cursor: seqBefore }).entries;
    assert.deepEqual(added.map((entry) => [entry.kind, entry.detail, entry.store_rev]), [[kind, detail, rev + 1]], label);
    const onDisk = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
    const roles = onDisk.projects.map((project) => project.members.find((entry) => entry.member_id === ids.T)?.role ?? null);
    assert.deepEqual(roles, label === 'read_only' ? ['reader', 'reader'] : [null, null], label);
    assert.deepEqual(store.directory.projectsOf(ids.T).map((row) => row.role), label === 'read_only' ? ['reader', 'reader'] : []);
  }
});

test('an owner transfer changes nothing in projects', async (t) => {
  const { store, ids } = await inTwoProjects(t);
  const before = store.snapshot().projects;
  assert.equal((await store.transferOwner({ actorMemberId: ids.O, memberId: ids.T })).ok, true);
  assert.deepEqual(store.snapshot().projects, before);
});

test('a cascade whose write fails leaves the member and the project rows as they were', async (t) => {
  const { fx, ids } = await inTwoProjects(t);
  const before = fs.readFileSync(fx.memberFile);
  const failing = fx.openStore({ writeJson() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  assert.equal(reasonOf(await failing.revokeMember({ actorMemberId: ids.O, memberId: ids.T })), 'team_store_failed');
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  const reopened = fx.openStore();
  assert.equal(reopened.getMember(ids.T).state, 'active');
  assert.deepEqual(reopened.directory.projectsOf(ids.T).map((row) => row.project_id), [P1, 'project_p2']);
  assert.equal(reopened.audit.read({ order: 'newest', limit: 1 }).entries[0].applied, false);
});

test('a member in 64 projects is revoked with one audit entry inside the batch bound', async (t) => {
  const { AUDIT_LIMITS } = require('../../server/team/audit-log');
  const fx = createFixture(t);
  const store = fx.openStore();
  const ids = await fx.buildTeam(store);
  for (let index = 0; index < 64; index += 1) {
    assert.equal((await store.createProject({ actorMemberId: ids.A, projectId: `project_${index}` })).ok, true);
    assert.equal((await store.addProjectMember({ actorMemberId: ids.A, projectId: `project_${index}`, memberId: ids.T, role: 'writer' })).ok, true);
  }
  assert.equal(reasonOf(await store.createProject({ actorMemberId: ids.M })), 'team_project_limit');
  const appended = [];
  const realAppend = store.audit.append.bind(store.audit);
  store.audit.append = (entries) => { appended.push(entries.length); return realAppend(entries); };
  assert.equal((await store.revokeMember({ actorMemberId: ids.O, memberId: ids.T })).ok, true);
  assert.deepEqual(appended, [1]);
  assert.ok(appended[0] <= AUDIT_LIMITS.MAX_BATCH);
  assert.equal(lastAudit(store)[0].detail, 'was=active,projects=64');
  assert.ok(store.snapshot().projects.every((project) => project.members.every((entry) => entry.member_id !== ids.T)));
});

// --------------------------------------------------------------- directory

test('projectRole and projectsOf follow each commit and hand out fresh values', async (t) => {
  const { store, ids } = await teamWithProject(t);
  assert.equal(store.directory.projectRole(ids.T, P1), 'writer');
  assert.equal(store.directory.projectState(P1), 'active');
  assert.equal(store.directory.projectState('project_nope'), null);
  assert.equal(store.directory.projectState(undefined), null);
  assert.equal((await store.setProjectRole({ actorMemberId: ids.A, projectId: P1, memberId: ids.T, role: 'reader' })).ok, true);
  assert.equal(store.directory.projectRole(ids.T, P1), 'reader');
  const rows = store.directory.projectsOf(ids.T);
  rows[0].role = 'admin';
  rows.push({ project_id: 'project_forged', role: 'admin' });
  assert.deepEqual(store.directory.projectsOf(ids.T), [{ project_id: P1, role: 'reader' }]);
  assert.notEqual(store.directory.projectsOf(ids.T), store.directory.projectsOf(ids.T));

  assert.equal((await store.removeProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.T })).ok, true);
  assert.equal(store.directory.projectRole(ids.T, P1), null);
  assert.deepEqual(store.directory.projectsOf(ids.T), []);
  for (const [memberId, projectId] of [[ids.A, 'project_nope'], ['member_nopeAAAAAAAAAAAAAAA', P1], [undefined, P1], [ids.A, null]]) {
    assert.equal(store.directory.projectRole(memberId, projectId), null);
  }
  assert.deepEqual(store.directory.projectsOf(undefined), []);
  assert.equal((await store.markProjectDeleting({ actorMemberId: ids.A, projectId: P1 })).ok, true);
  assert.equal(store.directory.projectRole(ids.A, P1), null, 'a deleting project gives no role');
  assert.deepEqual(store.directory.projectsOf(ids.A), []);
  assert.equal(store.directory.projectState(P1), 'deleting');
  assert.equal((await store.deleteProject({ actorMemberId: ids.A, projectId: P1 })).ok, true);
  assert.equal(store.directory.projectState(P1), null);
});

// ------------------------------------------------------------------ bounds

test('64 projects of eight members with a full team fit the 256 KiB store cap', async (t) => {
  const { LIMITS, validateDocument } = require('../../server/team/member-schema');
  const fx = createFixture(t);
  const ids = await fx.buildTeam(fx.openStore());
  const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  // Worst case the store can hold: generated id lengths, the longest project id
  // a caller may pass, and 40-character names of 4-byte characters.
  const id = (prefix, index) => `${prefix}_${String(index).padStart(22, 'x')}`;
  const name = (index) => `${'\u{1F600}'.repeat(36)}${String(index).padStart(4, '0')}`;
  const member = (index, fields) => ({
    member_id: id('member', index), display_name: name(index), role: 'member', state: 'active', created_at: 1,
    admitted_at: 1, admitted_by: ids.O, revoked_at: null, revoked_by: null, ...fields,
  });
  const owner = doc.members.find((entry) => entry.role === 'owner');
  const live = [owner, ...Array.from({ length: 7 }, (_, index) => member(index))];
  const revoked = Array.from({ length: 56 }, (_, index) => member(100 + index, {
    state: 'revoked', revoked_at: 2, revoked_by: owner.member_id,
  }));
  let deviceIndex = 0;
  const device = (memberId, state) => ({
    device_id: id('device', deviceIndex), member_id: memberId, public_key: fx.key(`size-device-${deviceIndex++}`),
    label: name(deviceIndex), state, created_at: 1, last_seen_at: 1,
  });
  const devices = [
    ...live.flatMap((entry) => [0, 1, 2].map(() => device(entry.member_id, 'active'))),
    ...Array.from({ length: 56 }, (_, index) => device(live[1 + (index % 7)].member_id, 'revoked')),
    ...revoked.flatMap((entry) => [0, 1, 2].map(() => device(entry.member_id, 'revoked'))),
  ].slice(0, LIMITS.MAX_DEVICE_RECORDS);
  const invites = Array.from({ length: LIMITS.MAX_INVITE_RECORDS }, (_, index) => ({
    invite_id: id('invite', index), invite_public_key: fx.key(`size-invite-${index}`), role: 'member',
    member_id: null, created_by: owner.member_id, created_at: 1, expires_at: 9e15,
    used_at: index < LIMITS.MAX_OUTSTANDING_INVITES ? null : 2, revoked_at: null,
  }));
  const projects = Array.from({ length: LIMITS.MAX_PROJECTS }, (_, index) => ({
    project_id: `project_${String(index).padStart(128, 'p')}`, created_by: owner.member_id, created_at: 1_800_000_000_000,
    state: 'active',
    members: live.map((entry, slot) => ({
      member_id: entry.member_id, role: slot === 0 ? 'admin' : 'writer', added_by: owner.member_id, added_at: 1_800_000_000_000,
    })),
  }));
  const full = { ...doc, members: [...live, ...revoked], devices, invites, projects };
  assert.equal(validateDocument(full).ok, true, JSON.stringify(validateDocument(full)));
  const bytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
  t.diagnostic(`full store with 64 projects of 8 members: ${bytes} bytes of ${LIMITS.MAX_STORE_BYTES}`);
  assert.ok(bytes <= LIMITS.MAX_STORE_BYTES, `${bytes} bytes`);
  fs.writeFileSync(fx.memberFile, JSON.stringify(full));
  assert.equal(fx.newStore().open().ok, true, 'the store loads it');
});

// ------------------------------------------------------- audit and events

test('a crash between the audit entry and the store write reconciles on load', async (t) => {
  const { fx, store, ids } = await teamWithProject(t);
  const before = fs.readFileSync(fx.memberFile);
  const crashing = fx.openStore({ writeJson() { /* the commit never lands */ } });
  assert.equal((await crashing.createProject({ actorMemberId: ids.M, projectId: 'project_lost' })).ok, true);
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  const reopened = fx.openStore();
  assert.equal(reopened.getProject('project_lost'), null);
  assert.equal(reopened.rev(), store.rev());
  const [entry] = lastAudit(reopened);
  assert.deepEqual([entry.kind, entry.project_id, entry.applied], ['project_created', 'project_lost', false]);
});

test('project changes reach project subscribers only; membership subscribers never see them', async (t) => {
  const { store, ids } = await teamWithProject(t);
  const projectEvents = [];
  const memberEvents = [];
  store.onProjectChange((event) => projectEvents.push(event));
  store.onMembershipChange((event) => memberEvents.push(event.kind));
  await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.X, role: 'reader' });
  await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.T, role: 'reader' });
  await store.revokeMember({ actorMemberId: ids.O, memberId: ids.X });
  assert.deepEqual(projectEvents.map((event) => [event.reason, event.project_id, [...event.member_ids]]),
    [['members', P1, [ids.X]]], 'refusals and cascades emit no project event');
  assert.ok(Object.isFrozen(projectEvents[0]));
  assert.deepEqual(memberEvents, ['member_revoked']);
});

test('redaction: no display name in a log, a failure or a project audit entry', async (t) => {
  const { fx, store, ids } = await inTwoProjects(t);
  const failures = [
    await store.addProjectMember({ actorMemberId: ids.A, projectId: P1, memberId: ids.R, role: 'admin' }),
    await store.removeProjectMember({ actorMemberId: ids.A, projectId: 'project_p2', memberId: ids.A }),
  ];
  await store.setRole({ actorMemberId: ids.O, memberId: ids.A, role: 'read_only' });
  await store.revokeMember({ actorMemberId: ids.O, memberId: ids.T });
  const names = store.snapshot().members.map((member) => member.display_name);
  const logged = JSON.stringify(fx.logs) + JSON.stringify(failures);
  for (const name of names) assert.equal(logged.includes(name), false, `${name} leaked`);
  const entries = store.audit.read({ cursor: 0 }).entries.filter((entry) => entry.project_id !== null);
  assert.ok(entries.length >= 4);
  for (const entry of entries) {
    assert.equal(entry.name, null);
    assert.match(entry.detail, /^[a-z_]+=[a-z0-9_]+(,[a-z_]+=[a-z0-9_]+)*$/u);
  }
  assert.ok(fs.readFileSync(fx.auditFile, 'utf8').includes('adminless='), 'the adminless count is recorded');
});
