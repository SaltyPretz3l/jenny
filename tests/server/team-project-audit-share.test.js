'use strict';

// new-test-file: team-project-audit.test.js is at its line cap (578 of 600). Review round two, R15-F01: the
// project audit's share (server/team/project-audit.js): a project's churn drops its own oldest entries first, a
// project with no live row goes before any live one, the per-project floor, schema 2 and the upgrade from schema 1.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const { PROJECT_AUDIT_FILE, PROJECT_AUDIT_LIMITS, ProjectAudit } = require('../../server/team/project-audit');

const P = 'project_p';
const Q = 'project_q';
const GONE = 'project_gone';
const SESSION = 'sess_1800000000000_aaaaaaaaaaaa';
const ACTOR = 'member_actorXXXXXXXXXXXXXX';

const decided = (projectId) => ({ kind: 'approval_decided', project_id: projectId, session_id: SESSION,
  actor_member_id: ACTOR, prompter_member_id: ACTOR, tool_name: 'write_file', decision: 'approved', detail: null });
const ruleAdded = (projectId) => ({ kind: 'rule_added', project_id: projectId, actor_member_id: ACTOR,
  tool_name: 'edit_file', detail: { rule_seq: 1 } });
const stored = (seq, projectId) => ({ seq, at: 1, prompter_member_id: null, session_id: null, decision: null,
  ...ruleAdded(projectId) });

const fileOf = (fx) => path.join(fx.dir, PROJECT_AUDIT_FILE);
const openAudit = (fx, options = {}) => new ProjectAudit({ filePath: fileOf(fx), clock: fx.clock, logger: fx.logger,
  ...options });
const disk = (fx) => JSON.parse(fs.readFileSync(fileOf(fx), 'utf8'));
const seqs = (audit, projectId) => audit.read({ projectId }).entries.map((entry) => entry.seq);

test('a loop in Q at the bound leaves P\'s entries; Q pays for itself and its floor says so, also after a reopen', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx, { maxEntries: 6 });
  audit.append(decided(P));
  audit.append(decided(P));
  for (let index = 0; index < 20; index += 1) assert.equal(audit.append(ruleAdded(Q)).ok, true);
  assert.deepEqual(seqs(audit, P), [1, 2]);
  assert.equal(audit.read({ projectId: P }).floor_seq, 1);
  assert.deepEqual(seqs(audit, Q), [19, 20, 21, 22]);
  assert.equal(audit.read({ projectId: Q }).floor_seq, 19);
  assert.deepEqual([disk(fx).schema_version, disk(fx).floor_seq, disk(fx).entries.length, disk(fx).project_floors],
    [4, 1, 6, { [Q]: 19 }]);
  const reopened = openAudit(fx, { maxEntries: 6 });
  assert.equal(reopened.read({ projectId: Q }).floor_seq, 19);
  assert.equal(reopened.append(decided(P)).ok, true);
  assert.equal(reopened.append(decided(P)).ok, true);
  // P holds 4 of 7 at the second: its own oldest goes, as the log's first entry, so the log's floor moves.
  assert.deepEqual([seqs(reopened, P), seqs(reopened, Q), reopened.floorSeq()], [[2, 23, 24], [20, 21, 22], 2]);
});

test('the largest holder pays even when it is not the appender; a tie drops the oldest entry', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx, { maxEntries: 4 });
  for (const projectId of [Q, P, P, P]) audit.append(decided(projectId));
  audit.append(decided(Q));
  assert.deepEqual([seqs(audit, P), seqs(audit, Q)], [[3, 4], [1, 5]]);
  assert.equal(audit.read({ projectId: P }).floor_seq, 3);
  assert.equal(audit.read({ projectId: Q }).floor_seq, 1);
  audit.append(decided(Q));
  // Q holds 3 of 5 now: Q's oldest (the log's first entry) goes, and P's floor is no longer above the log's.
  assert.deepEqual([seqs(audit, P), seqs(audit, Q), audit.floorSeq()], [[3, 4], [5, 6], 3]);
  assert.deepEqual(disk(fx).project_floors, {});
});

test('entries of a project with no live row go before any live one, and keep no floor; a liveness check that throws is live', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx, { maxEntries: 4, liveProject: (projectId) => projectId !== GONE });
  for (const projectId of [P, GONE, Q, Q]) audit.append(decided(projectId));
  audit.append(decided(Q));
  assert.deepEqual([seqs(audit, P), seqs(audit, GONE), seqs(audit, Q)], [[1], [], [3, 4, 5]]);
  assert.deepEqual(disk(fx).project_floors, {});
  const doubting = openAudit(fx, { maxEntries: 4, liveProject: () => { throw new Error('store closed'); } });
  doubting.append(decided(Q));
  assert.deepEqual([seqs(doubting, P), seqs(doubting, Q)], [[1], [4, 5, 6]]);
});

test('a schema 1 file is read and upgraded on the next append; the byte bound counts the floors', (t) => {
  const fx = createFixture(t);
  fs.writeFileSync(fileOf(fx), JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 3, entries: [stored(1, P),
    stored(2, Q)] }));
  const audit = openAudit(fx);
  assert.deepEqual([seqs(audit, P), audit.read({ projectId: P }).floor_seq], [[1], 1]);
  assert.equal(disk(fx).schema_version, 1, 'a read writes nothing');
  assert.deepEqual(audit.append(decided(Q)), { ok: true, seq: 3 });
  assert.deepEqual(Object.keys(disk(fx)), ['schema_version', 'floor_seq', 'next_seq', 'entries', 'project_floors']);
  assert.equal(disk(fx).schema_version, 4);
  const limit = fs.statSync(fileOf(fx)).size + 10;
  const tight = openAudit(fx, { maxBytes: limit });
  for (let index = 0; index < 5; index += 1) assert.equal(tight.append(ruleAdded(Q)).ok, true);
  assert.ok(fs.statSync(fileOf(fx)).size <= limit && Object.hasOwn(disk(fx).project_floors, Q));
  assert.deepEqual(seqs(tight, P), [1]);
});

test('a schema 2 file with a floor that breaks the rules is refused, unchanged, and the store unavailable', (t) => {
  const base = { schema_version: 2, floor_seq: 2, next_seq: 6, entries: [stored(2, P), stored(5, Q)] };
  const cases = {
    no_floors_key: base,
    floors_not_object: { ...base, project_floors: [] },
    floor_at_log_floor: { ...base, project_floors: { [Q]: 2 } },
    floor_past_next: { ...base, project_floors: { [Q]: 7 } },
    entry_below_its_floor: { ...base, project_floors: { [P]: 3 } },
    key_not_a_project: { ...base, project_floors: { member_x: 4 } },
    floor_not_integer: { ...base, project_floors: { [Q]: 4.5 } },
    unknown_document_key: { ...base, project_floors: {}, extra: 1 },
  };
  for (const [name, doc] of Object.entries(cases)) {
    const fx = createFixture(t);
    const text = JSON.stringify(doc);
    fs.writeFileSync(fileOf(fx), text);
    const audit = openAudit(fx);
    assert.equal(audit.append(decided(P)).error.reason, 'team_audit_unavailable', name);
    assert.equal(fs.readFileSync(fileOf(fx), 'utf8'), text, name);
  }
  const fx = createFixture(t);
  fs.writeFileSync(fileOf(fx), JSON.stringify({ ...base, project_floors: { [Q]: 4 } }));
  assert.equal(openAudit(fx).read({ projectId: Q }).floor_seq, 4);
});

test('past the floor cap the lowest floor is forgotten, and that project reads the log\'s own floor', (t) => {
  const fx = createFixture(t);
  const cap = PROJECT_AUDIT_LIMITS.MAX_PROJECT_FLOORS;
  const floors = Object.fromEntries(Array.from({ length: cap }, (_unused, index) => [`project_f${index}`, index + 2]));
  fs.writeFileSync(fileOf(fx), JSON.stringify({ schema_version: 2, floor_seq: 1, next_seq: 1000,
    entries: [stored(1, P), stored(500, Q), stored(501, Q)], project_floors: floors }));
  const audit = openAudit(fx, { maxEntries: 3 });
  assert.equal(audit.append(decided(GONE)).ok, true);
  assert.deepEqual([seqs(audit, P), seqs(audit, Q), audit.read({ projectId: Q }).floor_seq], [[1], [501], 501]);
  assert.equal(Object.keys(disk(fx).project_floors).length, cap);
  assert.equal(audit.read({ projectId: 'project_f0' }).floor_seq, 1);
  assert.equal(audit.read({ projectId: 'project_f1' }).floor_seq, 3);
});
