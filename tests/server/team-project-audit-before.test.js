'use strict';

// new-test-file: tests/server/team-approvals.test.js (600 of 600) and team-project-audit.test.js (594 of 600) are at their
// line cap. Team review fixes (row 201, OD-10): `team.project.audit.read` pages backwards with `before_seq`, so the
// Activity panel loads the newest entries in one call. The unit lane (ProjectAudit.read) and the real router lane
// (schema, identity, the page the client gets).

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const { PROJECT_AUDIT_FILE, ProjectAudit } = require('../../server/team/project-audit');
const { BOUNDED, reasonOf, setup } = require('./helpers/team-approvals-fixture');

const P = 'project_p';
const Q = 'project_q';
const SESSION = 'sess_1800000000000_aaaaaaaaaaaa';
const ACTOR = 'member_actorXXXXXXXXXXXXXX';

const decided = (projectId) => ({ kind: 'approval_decided', project_id: projectId, session_id: SESSION,
  actor_member_id: ACTOR, prompter_member_id: ACTOR, tool_name: 'write_file', decision: 'approved', detail: null });

// seq 1..30: P has the odd ones, Q the even ones.
function filled(t) {
  const fx = createFixture(t);
  const audit = new ProjectAudit({ filePath: path.join(fx.dir, PROJECT_AUDIT_FILE), clock: fx.clock, logger: fx.logger });
  for (let seq = 1; seq <= 30; seq += 1) assert.equal(audit.append(decided(seq % 2 ? P : Q)).ok, true);
  return audit;
}
const seqs = (page) => page.entries.map((entry) => entry.seq);

test('before_seq reads the newest page of one project below it, oldest first, and pages down to the start', (t) => {
  const audit = filled(t);
  const tail = audit.read({ projectId: P, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 4 });
  assert.deepEqual([seqs(tail), tail.next], [[23, 25, 27, 29], 23], 'the newest four, ascending; next is the page\'s oldest');
  const older = audit.read({ projectId: P, beforeSeq: tail.next, limit: 4 });
  assert.deepEqual([seqs(older), older.next], [[15, 17, 19, 21], 15]);
  const rest = audit.read({ projectId: P, beforeSeq: 15, limit: 100 });
  assert.deepEqual([seqs(rest), rest.next], [[1, 3, 5, 7, 9, 11, 13], null], 'nothing older is left');
  assert.deepEqual(seqs(audit.read({ projectId: Q, beforeSeq: 6 })), [2, 4], 'another project reads its own entries only');
  assert.deepEqual(seqs(audit.read({ projectId: P, beforeSeq: 1 })), [], 'nothing below the first');
  assert.equal(tail.floor_seq, 1);
  // A full page that exactly reaches the start has nothing older.
  assert.equal(audit.read({ projectId: P, beforeSeq: 15, limit: 7 }).next, null);
});

test('before_seq alone: a forward read is unchanged, and the cursors are checked', (t) => {
  const audit = filled(t);
  const forward = audit.read({ projectId: P, afterSeq: 25, limit: 2 });
  assert.deepEqual([seqs(forward), forward.next], [[27, 29], null]);
  assert.deepEqual(seqs(audit.read({ projectId: P, afterSeq: 0, beforeSeq: 4 })), [1, 3], 'after_seq 0 is no cursor');
  for (const bad of [{ beforeSeq: 0 }, { beforeSeq: -1 }, { beforeSeq: 1.5 }, { beforeSeq: '5' }, { beforeSeq: null },
    { beforeSeq: 5, afterSeq: 2 }]) {
    assert.equal(reasonOf(audit.read({ projectId: P, ...bad })), 'team_cursor_invalid', JSON.stringify(bad));
  }
});

test('through the router: a project admin pages backwards, the schema holds, everyone else is refused as before', BOUNDED, async (t) => {
  const s = await setup(t);
  for (let index = 1; index <= 5; index += 1) {
    const approval = s.openApproval(s.sP, { call: `c${index}`, starter: s.member('alice') });
    await s.look('carl', s.sP);
    assert.equal((await s.resolve('carl', approval)).ok, true);
  }
  const tail = await s.send('alice', 'team.project.audit.read', { project_id: s.P, before_seq: Number.MAX_SAFE_INTEGER, limit: 2 });
  assert.deepEqual([seqs(tail), tail.next_cursor], [[4, 5], 4]);
  const older = await s.send('alice', 'team.project.audit.read', { project_id: s.P, before_seq: tail.next_cursor, limit: 2 });
  assert.deepEqual([seqs(older), older.next_cursor], [[2, 3], 2]);
  const last = await s.send('alice', 'team.project.audit.read', { project_id: s.P, before_seq: 2 });
  assert.deepEqual([seqs(last), last.next_cursor], [[1], null]);
  for (const [params, reason] of [[{ before_seq: 0 }, 'invalid_command_parameters'], [{ before_seq: 1.5 }, 'invalid_command_parameters'],
    [{ before_seq: '3' }, 'invalid_command_parameters'], [{ before_seq: 3, after_seq: 1 }, 'team_cursor_invalid']]) {
    assert.equal(reasonOf(await s.send('alice', 'team.project.audit.read', { project_id: s.P, ...params })), reason, JSON.stringify(params));
  }
  for (const [who, expected] of [['carl', 'role_forbidden'], ['rae', 'role_forbidden'], ['owner', 'team_not_found'],
    ['bob', 'team_not_found']]) {
    assert.equal(reasonOf(await s.send(who, 'team.project.audit.read', { project_id: s.P, before_seq: 9 })), expected, who);
  }
});
