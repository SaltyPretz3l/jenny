'use strict';

// new-test-file: slice 3-12's rules commands, audit order, events and cleanup on a composed team host
// (server/team/team-project-rules.js); team-approvals.test.js and team-project-audit.test.js are near the line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ProjectAudit } = require('../../server/team/project-audit');
const { PROJECT_RULES_FILE, ProjectRulesStore } = require('../../server/team/project-rules-store');
const { writeJson: durableWrite } = require('../../services/host/durable-json');
const { BOUNDED, NAMES, STREAM, assertNoNames, frames, reasonOf, setup, startTurn } = require('./helpers/team-approvals-fixture');

const SECRET_FOLDER = 'secret-folder-zq';
const SECRET_REASON = 'Secret reason text zq';
const RULE_KINDS = ['rule_added', 'rule_requested', 'rule_request_allowed', 'rule_request_changed', 'rule_request_declined',
  'rule_removed'];

// The fixture with rules wired; `faults.audit` makes appends fail (true: every append; a function: the entries it
// picks), `faults.write` makes rules-file writes throw.
async function rulesSetup(t, options = {}) {
  const faults = { audit: false, write: false };
  const s = await setup(t, {
    createAudit: (opts) => {
      const audit = new ProjectAudit(opts);
      const append = audit.append.bind(audit);
      const fails = (entry) => faults.audit === true || (typeof faults.audit === 'function' && faults.audit(entry));
      audit.append = (entry) => (fails(entry) ? { ok: false } : append(entry));
      return audit;
    },
    rules: { createStore: (opts) => new ProjectRulesStore({ ...opts,
      writeJson: (file, value) => { if (faults.write) throw new Error('disk gone'); return durableWrite(file, value); } }) },
    ...options,
  });
  const list = (who, projectId = s.P) => s.send(who, 'team.project.rules.list', { project_id: projectId });
  const add = (who, extra = {}, projectId = s.P) => s.send(who, 'team.project.rules.add',
    { project_id: projectId, tool_name: 'edit_file', folder: null, ...extra });
  const answer = (who, requestSeq, outcome, extra = {}, envelope = {}) => s.send(who, 'team.project.rules.answer',
    { project_id: s.P, request_seq: requestSeq, outcome, ...extra }, envelope);
  const remove = (who, ruleSeq, projectId = s.P) => s.send(who, 'team.project.rules.remove', { project_id: projectId, rule_seq: ruleSeq });
  // Carl (a writer) answers an approval in P with "Allow once, ask for always".
  let calls = 0;
  const ask = async (who = 'carl', tool = 'write_file', sessionId = s.sP) => {
    const approval = s.openApproval(sessionId, { call: `call_ask${calls += 1}`, tool });
    await s.look(who, sessionId);
    return s.send(who, 'approval.resolve', { stream_id: STREAM, approval_id: approval.approvalId,
      decision_revision: approval.revision, approved: true, always: 'ask' }, { session_id: sessionId });
  };
  const kinds = (projectId = s.P) => s.entries(projectId).map((entry) => entry.kind).filter((kind) => kind.startsWith('rule_'));
  const rulesFile = () => path.join(s.h.config.userDataPath, PROJECT_RULES_FILE);
  return { ...s, faults, list, add, answer, remove, ask, kinds, rulesFile };
}

test('every command against the role matrix, each with its reason', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  const added = await s.h.ok(s.add('alice'));
  assert.equal(added.rule_seq, 1);
  for (const folder of ['.git', 'src/.env', '.github/workflows']) assert.equal(reasonOf(await s.add('alice', { folder })), 'team_rule_folder_invalid');
  const asked = await s.ask('carl');
  assert.deepEqual(asked.always_result, { ok: true, request_seq: 1 });
  // Readers of the list: anyone with a row in P (the read-only team member Rae is P's reader).
  for (const who of ['alice', 'carl', 'rae']) assert.equal((await s.list(who)).ok, true, who);
  for (const [who, expected] of [['owner', 'team_not_found'], ['bob', 'team_not_found'], ['pia', 'member_pending']]) {
    assert.equal(reasonOf(await s.list(who)), expected, `${who} list`);
  }
  // Changes: P's admins only.
  for (const [who, expected] of [['carl', 'role_forbidden'], ['rae', 'role_forbidden'], ['owner', 'team_not_found'],
    ['bob', 'team_not_found'], ['pia', 'member_pending']]) {
    assert.equal(reasonOf(await s.add(who, { tool_name: 'write_file' })), expected, `${who} add`);
    assert.equal(reasonOf(await s.answer(who, 1, 'allow')), expected, `${who} answer`);
    assert.equal(reasonOf(await s.remove(who, 1)), expected, `${who} remove`);
  }
  // A full member who reads P only, and Bob's own project: ids of another project change nothing there.
  await s.h.ok(s.send('alice', 'team.project.members.add', { project_id: s.P, member_id: s.member('bob'), role: 'reader' }));
  assert.equal(reasonOf(await s.add('bob', { tool_name: 'write_file' })), 'role_forbidden');
  assert.equal(reasonOf(await s.add('alice', {}, s.Q)), 'team_not_found');
  assert.equal(reasonOf(await s.remove('alice', 1, s.Q)), 'team_not_found');
  assert.equal(reasonOf(await s.list('alice', s.Q)), 'team_not_found');
  assert.equal(reasonOf(await s.answer('alice', 999, 'allow')), 'team_rule_request_not_found');
  assert.equal(reasonOf(await s.remove('alice', 999)), 'team_rule_not_found');
  // The owner gets these powers with an admin row only.
  await s.h.ok(s.send('owner', 'team.project.join', { project_id: s.P, role: 'admin' }));
  assert.equal((await s.h.ok(s.add('owner', { tool_name: 'write_file' }))).rule_seq, 2);
  // A removed member is refused by the identity check before anything runs.
  await s.h.ok(s.send('owner', 'team.member.revoke', { member_id: s.member('carl') }));
  for (const call of [s.list('carl'), s.add('carl'), s.remove('carl', 1)]) assert.equal(reasonOf(await call), 'member_revoked');
  const listed = await s.h.ok(s.list('alice'));
  assert.deepEqual(listed.rules.map((rule) => [rule.rule_seq, rule.tool_name, rule.folder]), [[1, 'edit_file', null], [2, 'write_file', null]]);
  assert.deepEqual(s.kinds(), ['rule_added', 'rule_requested', 'rule_added']);
});

test('what each reader sees: admins the open requests, the asker their own answered ones, no one else any', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.ask('carl', 'write_file');
  await s.ask('alice', 'edit_file');
  const alice = await s.h.ok(s.list('alice'));
  assert.deepEqual(alice.requests.map((request) => request.request_seq), [1, 2]);
  assert.equal(alice.open_request_count, 2);
  assert.deepEqual((await s.h.ok(s.list('carl'))).requests.map((request) => request.request_seq), [1]);
  assert.deepEqual((await s.h.ok(s.list('rae'))).requests, []);
  await s.h.ok(s.answer('alice', 1, 'decline', { reason: SECRET_REASON }));
  const carl = (await s.h.ok(s.list('carl'))).requests[0];
  assert.deepEqual([carl.state, carl.reason, carl.answered_by, carl.session_id], ['declined', SECRET_REASON, s.member('alice'), s.sP]);
  assert.deepEqual((await s.h.ok(s.list('alice'))).requests.map((request) => request.request_seq), [2]);
});

test('answering: allow as asked, allow changed (tool and folder), decline with a reason; the closed answer shapes', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.ask('carl', 'write_file');
  await s.ask('carl', 'edit_file');
  await s.ask('alice', 'write_file');
  for (const [outcome, extra, reason] of [['allow', { reason: 'x' }, 'team_rule_answer_invalid'],
    ['change', {}, 'team_rule_answer_invalid'], ['change', { tool_name: 'edit_file', folder: '../x' }, 'team_rule_folder_invalid'],
    ['change', { tool_name: 'edit_file', folder: '.github/workflows' }, 'team_rule_folder_invalid'],
    ['decline', {}, 'team_rule_reason_invalid'], ['decline', { reason: 'line\nbreak' }, 'team_rule_reason_invalid'],
    ['decline', { reason: 'x'.repeat(201) }, 'team_rule_reason_invalid'], ['decline', { reason: 'ok', folder: null }, 'team_rule_answer_invalid']]) {
    assert.equal(reasonOf(await s.answer('alice', 1, outcome, extra)), reason, `${outcome} ${JSON.stringify(extra)}`);
  }
  assert.deepEqual(await s.h.ok(s.answer('alice', 1, 'allow')).then(({ outcome, rule_seq: seq }) => [outcome, seq]), ['allowed', 1]);
  const changed = await s.h.ok(s.answer('alice', 2, 'change', { tool_name: 'write_file', folder: 'posts' }));
  assert.deepEqual([changed.outcome, changed.rule_seq], ['changed', 2]);
  // Allowing as asked when the same rule already stands reuses it.
  assert.equal((await s.h.ok(s.answer('alice', 3, 'allow'))).rule_seq, 1);
  const listed = await s.h.ok(s.list('alice'));
  assert.deepEqual(listed.rules.map((rule) => [rule.rule_seq, rule.tool_name, rule.folder, rule.from_request_seq]),
    [[1, 'write_file', null, 1], [2, 'write_file', 'posts', 2]]);
  assert.equal(listed.open_request_count, 0);
  assert.deepEqual(s.kinds(), ['rule_requested', 'rule_requested', 'rule_requested', 'rule_request_allowed',
    'rule_request_changed', 'rule_request_allowed']);
  assert.deepEqual(s.entries(s.P).filter((e) => e.kind === 'rule_request_changed').map((e) => [e.tool_name, e.detail]),
    [['write_file', { request_seq: 2, rule_seq: 2 }]]);
});

test('two admins answer one request at once: one applied, one stale, one entry; an exact retry returns the first', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.h.ok(s.send('owner', 'team.project.join', { project_id: s.P, role: 'admin' }));
  await s.ask('carl');
  const [first, second] = await Promise.all([s.answer('alice', 1, 'allow'), s.answer('owner', 1, 'decline', { reason: 'No' })]);
  assert.deepEqual([first.ok, reasonOf(second)], [true, 'decision_stale']);
  assert.deepEqual(s.kinds(), ['rule_requested', 'rule_request_allowed']);
  const envelope = { request_id: 'request_retry_rule' };
  const once = await s.send('alice', 'team.project.rules.add', { project_id: s.P, tool_name: 'edit_file', folder: 'a' }, envelope);
  const again = await s.send('alice', 'team.project.rules.add', { project_id: s.P, tool_name: 'edit_file', folder: 'a' }, envelope);
  assert.deepEqual(again, once);
  assert.equal(s.kinds().filter((kind) => kind === 'rule_added').length, 1);
});

test('a role lost during an await on the project chain refuses there and changes nothing', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.h.ok(s.send('owner', 'team.project.join', { project_id: s.P, role: 'admin' }));
  let release;
  const held = s.h.projects.serialized(() => new Promise((resolve) => { release = resolve; }));
  const pending = s.add('alice');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await s.h.store.setProjectRole({ actorMemberId: s.member('owner'), projectId: s.P,
    memberId: s.member('alice'), role: 'writer' })).ok, true);
  release();
  await held;
  assert.equal(reasonOf(await pending), 'role_forbidden');
  assert.deepEqual((await s.h.ok(s.list('owner'))).rules, []);
  assert.deepEqual(s.kinds(), []);
});

test('audit first: a failing append refuses and changes nothing; a crash after the entry leaves the entry and no rule', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  s.faults.audit = true;
  assert.equal(reasonOf(await s.add('alice')), 'team_audit_unavailable');
  assert.equal(fs.existsSync(s.rulesFile()), false);
  s.faults.audit = false;
  s.faults.write = true;
  assert.equal(reasonOf(await s.add('alice')), 'team_rules_unavailable');
  s.faults.write = false;
  assert.deepEqual(s.kinds(), ['rule_added']);
  assert.deepEqual((await s.h.ok(s.list('alice'))).rules, []);
  // The next add writes rule 1 (the lost write left no number taken).
  assert.equal((await s.h.ok(s.add('alice'))).rule_seq, 1);
});

test('the six kinds carry no path, reason or name: answers, events, log lines and the audit file', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  const streams = Object.fromEntries(['alice', 'carl', 'rae', 'bob', 'owner'].map((who) => [who, s.h.attach(who)]));
  const answers = [];
  const keep = async (promise) => { const value = await promise; answers.push(value); return value; };
  await keep(s.add('alice', { folder: SECRET_FOLDER }));
  await keep(s.ask('carl', 'write_file'));
  await keep(s.ask('carl', 'edit_file'));
  await keep(s.ask('alice', 'write_file'));
  await keep(s.answer('alice', 1, 'allow'));
  await keep(s.answer('alice', 2, 'change', { tool_name: 'edit_file', folder: `${SECRET_FOLDER}/x` }));
  await keep(s.answer('alice', 3, 'decline', { reason: SECRET_REASON }));
  await keep(s.remove('alice', 1));
  assert.deepEqual(new Set(s.kinds()), new Set(RULE_KINDS));
  const auditText = fs.readFileSync(path.join(s.h.config.userDataPath, 'team-project-audit.json'), 'utf8');
  const eventText = JSON.stringify(Object.values(streams).map((response) => response.frames));
  for (const [where, text] of [['answers', JSON.stringify(answers)], ['events', eventText], ['logs', s.h.logText()],
    ['audit', auditText]]) {
    assert.equal(text.includes(SECRET_FOLDER), false, `${where} carries the folder`);
    assert.equal(text.includes(SECRET_REASON), false, `${where} carries the reason`);
    assertNoNames(text, where);
  }
  assert.ok(NAMES.length > 0);
});

test('events: the change reaches every row holder, the count the admins only, the answer the conversation', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  const streams = Object.fromEntries(['alice', 'carl', 'rae', 'bob', 'owner', 'pia'].map((who) => [who, s.h.attach(who)]));
  await s.h.ok(s.add('alice'));
  await s.ask('carl', 'write_file');
  await s.h.ok(s.answer('alice', 1, 'decline', { reason: SECRET_REASON }));
  const seen = (type) => Object.fromEntries(Object.entries(streams).map(([who, response]) => [who, frames(response, type).length]));
  assert.deepEqual(seen('team_project_rules_changed'), { alice: 3, carl: 3, rae: 3, bob: 0, owner: 0, pia: 0 });
  assert.deepEqual(seen('team_project_rule_requests'), { alice: 2, carl: 0, rae: 0, bob: 0, owner: 0, pia: 0 });
  assert.deepEqual(seen('team_rule_request_answered'), { alice: 1, carl: 1, rae: 1, bob: 0, owner: 0, pia: 0 });
  const [counted, cleared] = frames(streams.alice, 'team_project_rule_requests');
  assert.deepEqual([counted.open_count, cleared.open_count, counted.project_id], [1, 0, s.P]);
  const answered = frames(streams.carl, 'team_rule_request_answered')[0];
  assert.deepEqual([answered.session_id, answered.request_seq, answered.outcome], [s.sP, 1, 'declined']);
  const changed = frames(streams.rae, 'team_project_rules_changed').map((frame) => frame.revision);
  assert.deepEqual(changed, [1, 2, 3]);
  assert.equal(JSON.stringify(Object.values(streams).map((r) => r.frames)).includes(SECRET_REASON), false);
});

test('cleanup: delete and its reconcile drop the project; a removed member\'s requests go; a removed admin\'s rules stay', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.h.ok(s.send('owner', 'team.project.join', { project_id: s.P, role: 'admin' }));
  await s.h.ok(s.add('alice'));
  await s.ask('carl', 'write_file');
  await s.ask('carl', 'edit_file', s.sP2);
  // Carl leaves the project: both open requests go, with a count to the admins.
  await s.h.ok(s.send('alice', 'team.project.members.remove', { project_id: s.P, member_id: s.member('carl') }));
  assert.equal((await s.h.ok(s.list('alice'))).open_request_count, 0);
  // Alice (an admin) is removed: the rule she set stays, set_by naming her.
  await s.h.ok(s.send('owner', 'team.project.members.remove', { project_id: s.P, member_id: s.member('alice') }));
  assert.deepEqual((await s.h.ok(s.list('owner'))).rules.map((rule) => rule.set_by), [s.member('alice')]);
  // A member revoked from the team: their open request in any project goes.
  await s.h.ok(s.send('bob', 'team.project.members.add', { project_id: s.Q, member_id: s.member('carl'), role: 'writer' }));
  const approval = s.openApproval(s.sQ, { call: 'call_q1', starter: s.member('bob') });
  await s.look('carl', s.sQ);
  assert.equal((await s.send('carl', 'approval.resolve', { stream_id: STREAM, approval_id: approval.approvalId,
    decision_revision: approval.revision, approved: true, always: 'ask' }, { session_id: s.sQ })).always_result.ok, true);
  assert.equal((await s.h.ok(s.list('bob', s.Q))).open_request_count, 1);
  await s.h.ok(s.send('owner', 'team.member.revoke', { member_id: s.member('carl') }));
  assert.equal((await s.h.ok(s.list('bob', s.Q))).open_request_count, 0);
  // A crash after the mark: the start-up reconcile finishes the delete and drops the rules.
  assert.equal((await s.h.store.markProjectDeleting({ actorMemberId: s.member('owner'), projectId: s.P,
    counts: { conversations: 2, files: 0 } })).ok, true);
  assert.deepEqual(s.h.rules.store().projectIds().sort(), [s.P, s.Q].sort());
  for (const sessionId of [s.sP, s.sP2]) s.h.backend.sessionStore.clearActiveTurn(sessionId, { stream_id: STREAM });
  await s.h.reconcile();
  assert.deepEqual(s.h.rules.store().projectIds(), [s.Q]);
  // The command's own delete drops Q's entry too.
  for (const key of [...s.h.backend.pendingToolApprovals.keys()]) s.h.backend.pendingToolApprovals.delete(key);
  s.h.backend.sessionStore.clearActiveTurn(s.sQ, { stream_id: STREAM });
  await s.h.ok(s.send('bob', 'team.project.delete', { project_id: s.Q }));
  assert.deepEqual(s.h.rules.store().projectIds(), []);
});

test('caps: 32 rules, 16 open requests, one per asker and tool; a refused request never fails the allow it rode on', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  for (let i = 0; i < 32; i += 1) await s.h.ok(s.add('alice', { folder: `f${i}` }));
  assert.equal(reasonOf(await s.add('alice', { folder: 'one-more' })), 'team_rule_limit');
  assert.equal(reasonOf(await s.add('alice', { folder: 'f0' })), 'team_rule_exists');
  const first = await s.ask('carl', 'write_file');
  const again = await s.ask('carl', 'write_file');
  assert.deepEqual([first.always_result, again.always_result], [{ ok: true, request_seq: 1 }, { ok: true, request_seq: 1 }]);
  assert.equal((await s.h.ok(s.list('alice'))).open_request_count, 1);
  // Fill the open requests to 16 (each asker and tool once), then one more is refused but its allow applied.
  const store = s.h.rules.store();
  assert.equal(store.commit(s.P, (entry) => {
    for (let i = 0; i < 15; i += 1) {
      entry.requests.push({ request_seq: entry.next_request_seq, tool_name: 'edit_file', asker_member_id: `member_f${i}`,
        session_id: s.sP, asked_at: 1, state: 'open', answered_by: null, answered_at: null, outcome_tool: null,
        outcome_folder: null, reason: null, rule_seq: null });
      entry.next_request_seq += 1;
    }
    return {};
  }).ok, true);
  const decidedBefore = s.decided.length;
  const refused = await s.ask('carl', 'edit_file');
  assert.equal(refused.ok, true);
  assert.deepEqual(refused.always_result, { ok: false, reason: 'team_rule_request_limit' });
  assert.equal(s.decided.length, decidedBefore + 1);
});

// ---- Fix list 3-12: the full role matrix, audit-first on every change, and the behaviours with no test before ----

const OPS = ['list', 'add', 'answer', 'remove', 'rule', 'ask'];
// Each cell: the caller, the project the commands name, the conversation the `always` answers ride on (null: n/a).
// A command that passes the role check meets a later refusal that changes nothing (a hidden folder, request 999,
// rule 999), so every cell starts from the same state.
async function matrixCell(s, who, projectId, sessionId, starter) {
  const row = [
    reasonOf(await s.list(who, projectId)),
    reasonOf(await s.add(who, { folder: '.git' }, projectId)),
    reasonOf(await s.send(who, 'team.project.rules.answer', { project_id: projectId, request_seq: 999, outcome: 'allow' })),
    reasonOf(await s.remove(who, 999, projectId)),
  ];
  for (const always of ['rule', 'ask']) {
    if (!sessionId) { row.push('n/a'); continue; }
    const approval = s.openApproval(sessionId, { call: `call_${who}_${always}_${projectId}`, starter });
    await s.look(who, sessionId);
    const answer = await s.send(who, 'approval.resolve', { stream_id: STREAM, approval_id: approval.approvalId,
      decision_revision: approval.revision, approved: true, always }, { session_id: sessionId });
    // An applied answer also names what its `always` did ('done', or the refusal that left the allow standing).
    row.push(answer.ok ? `ok:${answer.always_result.ok ? 'done' : answer.always_result.reason}` : reasonOf(answer));
  }
  return Object.fromEntries(OPS.map((op, index) => [op, row[index]]));
}

test('the role matrix: every caller kind against list, add, answer, remove and always rule/ask, exact reason per cell', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  const alice = s.member('alice');
  const R = (await s.h.ok(s.send('alice', 'team.project.create', { name: 'Doomed' }))).project_id;
  const sR = (await s.h.ok(s.send('alice', 'sessions.create', { title: 'Doomed chat', project_id: R }))).session.session_id;
  const actual = {};
  actual.other_project_member = await matrixCell(s, 'bob', s.P, s.sP, alice);
  actual.owner_without_row = await matrixCell(s, 'owner', s.P, s.sP, alice);
  actual.read_only_without_row = await matrixCell(s, 'rae', s.Q, s.sQ, s.member('bob'));
  actual.pending = await matrixCell(s, 'pia', s.P, s.sP, alice);
  actual.unknown_project = await matrixCell(s, 'alice', 'project_zzzzzzzz', null, alice);
  actual.writer = await matrixCell(s, 'carl', s.P, s.sP, alice);
  actual.read_only_reader = await matrixCell(s, 'rae', s.P, s.sP, alice);
  await s.h.ok(s.send('alice', 'team.project.members.add', { project_id: s.P, member_id: s.member('bob'), role: 'reader' }));
  actual.reader = await matrixCell(s, 'bob', s.P, s.sP, alice);
  actual.project_admin = await matrixCell(s, 'alice', s.P, s.sP, alice);
  await s.h.ok(s.send('owner', 'team.project.join', { project_id: s.P, role: 'admin' }));
  actual.owner_with_admin_row = await matrixCell(s, 'owner', s.P, s.sP, alice);
  startTurn(s.h.backend.sessionStore, sR, alice);
  const doomed = s.openApproval(sR, { call: 'call_doomed', starter: alice });
  assert.equal((await s.h.store.markProjectDeleting({ actorMemberId: alice, projectId: R,
    counts: { conversations: 1, files: 0 } })).ok, true);
  actual.deleting_project = await matrixCell(s, 'alice', R, null, alice);
  await s.look('alice', sR);
  actual.deleting_project.rule = reasonOf(await s.send('alice', 'approval.resolve', { stream_id: STREAM,
    approval_id: doomed.approvalId, decision_revision: doomed.revision, approved: true, always: 'rule' }, { session_id: sR }));
  await s.h.ok(s.send('owner', 'team.member.revoke', { member_id: s.member('carl') }));
  actual.revoked = await matrixCell(s, 'carl', s.P, s.sP, alice);
  const all = (reason) => Object.fromEntries(OPS.map((op) => [op, reason]));
  const passes = { list: 'ok', add: 'team_rule_folder_invalid', answer: 'team_rule_request_not_found', remove: 'team_rule_not_found' };
  const forbidden = { add: 'role_forbidden', answer: 'role_forbidden', remove: 'role_forbidden' };
  const notFound = { list: 'team_not_found', add: 'team_not_found', answer: 'team_not_found', remove: 'team_not_found' };
  assert.deepEqual(actual, {
    other_project_member: all('team_not_found'),
    owner_without_row: all('team_not_found'),
    // A read-only team member is refused every change by the router's identity check before any row is read.
    read_only_without_row: { ...all('role_forbidden'), list: 'team_not_found' },
    pending: all('member_pending'),
    unknown_project: { ...notFound, rule: 'n/a', ask: 'n/a' },
    writer: { list: 'ok', ...forbidden, rule: 'role_forbidden', ask: 'ok:done' },
    read_only_reader: { list: 'ok', ...forbidden, rule: 'role_forbidden', ask: 'role_forbidden' },
    reader: { list: 'ok', ...forbidden, rule: 'team_project_read_only', ask: 'team_project_read_only' },
    project_admin: { ...passes, rule: 'ok:done', ask: 'ok:done' },
    // The same rule already stands (the admin's): the allow applies, the rule is not saved twice.
    owner_with_admin_row: { ...passes, rule: 'ok:team_rule_exists', ask: 'ok:done' },
    deleting_project: { ...notFound, rule: 'team_not_found', ask: 'n/a' },
    revoked: all('member_revoked'),
  });
});

test('a role lost during an await refuses answer and remove too, and changes nothing', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.h.ok(s.send('owner', 'team.project.join', { project_id: s.P, role: 'admin' }));
  await s.h.ok(s.add('alice'));
  await s.ask('carl');
  for (const call of [() => s.answer('alice', 1, 'allow'), () => s.remove('alice', 1)]) {
    await s.h.store.setProjectRole({ actorMemberId: s.member('owner'), projectId: s.P, memberId: s.member('alice'), role: 'admin' });
    let release;
    const held = s.h.projects.serialized(() => new Promise((resolve) => { release = resolve; }));
    const pending = call();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await s.h.store.setProjectRole({ actorMemberId: s.member('owner'), projectId: s.P,
      memberId: s.member('alice'), role: 'writer' })).ok, true);
    release();
    await held;
    assert.equal(reasonOf(await pending), 'role_forbidden');
  }
  const listed = await s.h.ok(s.list('owner'));
  assert.deepEqual([listed.rules.length, listed.open_request_count], [1, 1]);
  assert.deepEqual(s.kinds(), ['rule_added', 'rule_requested']);
});

test('audit first for answer, remove and ask: a failing append changes nothing; a failing write leaves an entry, no change', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.h.ok(s.add('alice'));
  await s.ask('carl');
  const state = async () => {
    const listed = await s.h.ok(s.list('alice'));
    return [listed.rules.map((rule) => rule.rule_seq), listed.requests.map((request) => request.state)];
  };
  const before = await state();
  s.faults.audit = true;
  assert.equal(reasonOf(await s.answer('alice', 1, 'allow')), 'team_audit_unavailable');
  assert.equal(reasonOf(await s.remove('alice', 1)), 'team_audit_unavailable');
  // The decision's own entry is written; only the request's fails.
  s.faults.audit = (entry) => entry.kind.startsWith('rule_');
  const decidedBefore = s.decided.length;
  const askedNoAudit = await s.ask('carl', 'edit_file');
  assert.deepEqual([askedNoAudit.ok, askedNoAudit.always_result], [true, { ok: false, reason: 'team_audit_unavailable' }]);
  assert.equal(s.decided.length, decidedBefore + 1, 'the allow it rode on applied');
  s.faults.audit = false;
  assert.deepEqual(await state(), before);
  assert.deepEqual(s.kinds(), ['rule_added', 'rule_requested']);
  s.faults.write = true;
  assert.equal(reasonOf(await s.answer('alice', 1, 'allow')), 'team_rules_unavailable');
  assert.equal(reasonOf(await s.remove('alice', 1)), 'team_rules_unavailable');
  const askedNoWrite = await s.ask('carl', 'edit_file');
  assert.deepEqual([askedNoWrite.ok, askedNoWrite.always_result], [true, { ok: false, reason: 'team_rules_unavailable' }]);
  s.faults.write = false;
  // Each refused write left its entry and no change ("an entry with no change, never a change with no entry").
  assert.deepEqual(await state(), before);
  assert.deepEqual(s.kinds(), ['rule_added', 'rule_requested', 'rule_request_allowed', 'rule_removed', 'rule_requested']);
});

test('past 32 answered, the oldest answers go; a long-open request answered now keeps its outcome', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.ask('carl');
  const store = s.h.rules.store();
  // 32 answered requests, all asked after request 1 and answered at 100..131.
  assert.equal(store.commit(s.P, (entry) => {
    for (let i = 0; i < 32; i += 1) {
      entry.requests.push({ request_seq: entry.next_request_seq, tool_name: 'edit_file', asker_member_id: `member_f${i}`,
        session_id: s.sP, asked_at: 50 + i, state: 'declined', answered_by: s.member('alice'), answered_at: 100 + i,
        outcome_tool: null, outcome_folder: null, reason: 'No', rule_seq: null });
      entry.next_request_seq += 1;
    }
    return {};
  }).ok, true);
  await s.h.ok(s.answer('alice', 1, 'decline', { reason: 'Not this one' }));
  const requests = store.project(s.P).requests;
  assert.equal(requests.length, 32);
  const mine = requests.find((request) => request.request_seq === 1);
  assert.deepEqual([mine.state, mine.reason], ['declined', 'Not this one']);
  assert.equal(requests.some((request) => request.answered_at === 100), false, 'the oldest answer went');
  assert.equal(requests.some((request) => request.answered_at === 101), true);
  assert.deepEqual((await s.h.ok(s.list('carl'))).requests.map((request) => [request.request_seq, request.reason]), [[1, 'Not this one']]);
});

test('events: the answered event on allow and change; the admin count after a member\'s requests are dropped', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  const streams = Object.fromEntries(['alice', 'carl', 'bob'].map((who) => [who, s.h.attach(who)]));
  await s.ask('carl', 'write_file');
  await s.ask('carl', 'edit_file');
  await s.h.ok(s.answer('alice', 1, 'allow'));
  await s.h.ok(s.answer('alice', 2, 'change', { tool_name: 'edit_file', folder: 'posts' }));
  assert.deepEqual(frames(streams.carl, 'team_rule_request_answered').map((f) => [f.request_seq, f.outcome]),
    [[1, 'allowed'], [2, 'changed']]);
  assert.equal(frames(streams.bob, 'team_rule_request_answered').length, 0);
  // A duplicate ask fires nothing.
  await s.ask('carl', 'write_file');
  const before = frames(streams.alice, 'team_project_rule_requests').length;
  const changedBefore = frames(streams.alice, 'team_project_rules_changed').length;
  await s.ask('carl', 'write_file');
  assert.equal(frames(streams.alice, 'team_project_rule_requests').length, before);
  assert.equal(frames(streams.alice, 'team_project_rules_changed').length, changedBefore);
  // Carl leaves the project: his open request goes and the admins get the new count.
  await s.h.ok(s.send('alice', 'team.project.members.remove', { project_id: s.P, member_id: s.member('carl') }));
  const counts = frames(streams.alice, 'team_project_rule_requests').map((frame) => frame.open_count);
  assert.equal(counts.at(-1), 0);
  assert.equal(counts.length, before + 1);
});

test('always edge cases: approved false with ask, no rules wiring, and a demoted asker\'s request stays decidable', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  const approval = s.openApproval(s.sP, { call: 'call_false_ask' });
  await s.look('carl', s.sP);
  assert.equal(reasonOf(await s.send('carl', 'approval.resolve', { stream_id: STREAM, approval_id: approval.approvalId,
    decision_revision: approval.revision, approved: false, always: 'ask' }, { session_id: s.sP })), 'team_rule_always_invalid');
  assert.deepEqual(s.decided, []);
  await s.ask('carl');
  await s.h.ok(s.send('alice', 'team.project.members.setRole', { project_id: s.P, member_id: s.member('carl'), role: 'reader' }));
  assert.equal((await s.h.ok(s.answer('alice', 1, 'allow'))).outcome, 'allowed');
  // A team host built without the rules wiring refuses `always` and applies nothing.
  const bare = await setup(t);
  const bareApproval = bare.openApproval(bare.sP, { call: 'call_bare' });
  await bare.look('alice', bare.sP);
  assert.equal(reasonOf(await bare.send('alice', 'approval.resolve', { stream_id: STREAM, approval_id: bareApproval.approvalId,
    decision_revision: bareApproval.revision, approved: true, always: 'rule' }, { session_id: bare.sP })), 'team_rules_unavailable');
  assert.deepEqual(bare.decided, []);
});

test('a decline reason with markup is stored and returned as the same plain text', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.ask('carl');
  const markup = '<b>No</b> & <script>alert(1)</script> "quoted"';
  await s.h.ok(s.answer('alice', 1, 'decline', { reason: markup }));
  assert.equal((await s.h.ok(s.list('carl'))).requests[0].reason, markup);
  assert.equal(JSON.parse(fs.readFileSync(s.rulesFile(), 'utf8')).projects[0].requests[0].reason, markup);
});

test('the team command limiter applies to the four rules commands', BOUNDED, async (t) => {
  const gate = { allow: true };
  const s = await rulesSetup(t, { commandLimiter: { take: () => gate.allow } });
  await s.h.ok(s.add('alice'));
  gate.allow = false;
  for (const answer of [await s.list('alice'), await s.add('alice', { folder: 'x' }), await s.answer('alice', 1, 'allow'),
    await s.remove('alice', 1)]) {
    assert.equal(reasonOf(answer), 'team_rate_limit');
  }
  gate.allow = true;
  assert.equal((await s.h.ok(s.list('alice'))).rules.length, 1);
});

test('the start-time prune through open(), and the teardown flush through attach\'s teardown', BOUNDED, async (t) => {
  const s = await rulesSetup(t);
  await s.h.ok(s.add('alice'));
  await s.h.ok(s.add('bob', {}, s.Q));
  // A use held in memory reaches the file through the teardown attach returned (not only the store's own flush).
  startTurn(s.h.backend.sessionStore, s.sP, s.member('carl'));
  s.h.rules.used({ sessionId: s.sP, ruleSeq: 1 });
  s.h.rules.used({ sessionId: s.sP, ruleSeq: 1 });
  const onDisk = () => JSON.parse(fs.readFileSync(s.rulesFile(), 'utf8')).projects.find((p) => p.project_id === s.P).rules[0];
  assert.equal(onDisk().use_count, 0, 'held, inside the minute');
  const teardown = s.h.rules.attach({ core: s.h.core, store: s.h.store });
  for (const off of teardown) off();
  assert.deepEqual([onDisk().use_count, onDisk().last_used_by], [2, s.member('carl')]);
  assert.equal(s.h.backend.teamProjectRules, undefined);
  // A second host start over the same profile, told that only P has a team row: Q's entry goes.
  const { createTeamProjectRules } = require('../../server/team/team-project-rules');
  const restarted = createTeamProjectRules({ userDataPath: s.h.config.userDataPath, directory: s.h.store.directory,
    approvals: s.h.approvals });
  restarted.open({ teamProjectIds: [s.P] });
  assert.deepEqual(restarted.store().projectIds(), [s.P]);
});

// Review round two, R15-F01: a loop of rule changes in one project cannot push another project's approval records
// out of the shared audit log. The log here is bounded at 24 entries (the constructor clamps the production 10,000;
// the same eviction code runs), with the production team command limiter (30 a minute, team-main.js).
test('R15-F01: rules add/remove in Q at the command limit leave P\'s approval_decided readable', BOUNDED, async (t) => {
  const SMALL = 24;
  const { createRateLimiter } = require('../../server/team/rate-limit');
  const s = await rulesSetup(t, { createAudit: (opts) => new ProjectAudit({ ...opts, maxEntries: SMALL }),
    commandLimiter: createRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 64 }) });
  const approval = s.openApproval(s.sP);
  await s.look('carl', s.sP);
  assert.equal((await s.resolve('carl', approval)).ok, true);
  // Bob has no row in P. In his own project Q he adds and removes one rule, over and over, inside one minute.
  for (let round = 0; round < SMALL / 2; round += 1) {
    const added = await s.h.ok(s.add('bob', {}, s.Q));
    await s.h.ok(s.remove('bob', added.rule_seq, s.Q));
  }
  const read = await s.h.ok(s.send('alice', 'team.project.audit.read', { project_id: s.P }));
  assert.deepEqual(read.entries.map((entry) => [entry.kind, entry.actor_member_id]), [['approval_decided', s.member('carl')]]);
  assert.equal(read.floor_seq, 1);
  // Q paid for its own churn: its oldest entry went, and Q's floor says so. The log stayed at its bound.
  const own = await s.h.ok(s.send('bob', 'team.project.audit.read', { project_id: s.Q }));
  assert.equal(own.entries.length, SMALL - 1);
  assert.equal(own.floor_seq, own.entries[0].seq);
  assert.ok(own.floor_seq > 2, 'Q\'s first entry (seq 2) was dropped');
  const onDisk = JSON.parse(fs.readFileSync(path.join(s.h.config.userDataPath, 'team-project-audit.json'), 'utf8'));
  assert.equal(onDisk.entries.length, SMALL);
});
