'use strict';

// new-test-file: slice 3-12's `always` on approval.resolve and the rules port the backend consults
// (server/team/team-project-rules.js `decisions` and `match`, server/command-router-decisions.js); team-approvals.test.js
// is near the line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createDecisionHandlers } = require('../../server/command-router-decisions');
const { PROJECT_RULES_FILE, ProjectRulesStore } = require('../../server/team/project-rules-store');
const { writeJson: durableWrite } = require('../../services/host/durable-json');
const { waitForToolApproval } = require('../../services/backend/chat-stream-tool-handling');
const { BOUNDED, STREAM, frames, reasonOf, setup, startTurn } = require('./helpers/team-approvals-fixture');
const { trustedTurn } = require('../helpers/trusted-turn');

async function approveSetup(t, options = {}) {
  const faults = { write: false };
  const s = await setup(t, { rules: { createStore: (opts) => new ProjectRulesStore({ ...opts,
    writeJson: (file, value) => { if (faults.write) throw new Error('disk gone'); return durableWrite(file, value); } }) },
  ...options });
  let calls = 0;
  const open = (sessionId = s.sP, { tool = 'write_file', starter = s.member('alice') } = {}) => s.openApproval(sessionId,
    { call: `call_${calls += 1}`, tool, starter });
  const answer = async (who, approval, extra = {}) => {
    await s.look(who, approval.sessionId);
    return s.send(who, 'approval.resolve', { stream_id: STREAM, approval_id: approval.approvalId,
      decision_revision: approval.revision, approved: true, ...extra }, { session_id: approval.sessionId });
  };
  const listed = (who = 'alice', projectId = s.P) => s.h.ok(s.send(who, 'team.project.rules.list', { project_id: projectId }));
  const kinds = (projectId = s.P) => s.entries(projectId).map((entry) => entry.kind);
  return { ...s, faults, open, answer, listed, kinds };
}

test('always: rule by an admin applies the decision, then saves the rule; by a writer is refused and applies nothing', BOUNDED, async (t) => {
  const s = await approveSetup(t);
  const byWriter = s.open();
  assert.equal(reasonOf(await s.answer('carl', byWriter, { always: 'rule' })), 'role_forbidden');
  assert.deepEqual(s.decided, []);
  assert.deepEqual(s.kinds(), []);
  const byAdmin = s.open();
  const done = await s.answer('alice', byAdmin, { always: 'rule' });
  assert.equal(done.ok, true);
  assert.deepEqual(done.always_result, { ok: true, rule_seq: 1 });
  assert.deepEqual(s.decided.map(([, value]) => value), ['approved']);
  assert.deepEqual(s.kinds(), ['approval_decided', 'rule_added']);
  const rule = (await s.listed()).rules[0];
  assert.deepEqual([rule.tool_name, rule.folder, rule.set_by], ['write_file', null, s.member('alice')]);
  // The writer's answer without `always` still works (Allow once).
  assert.equal((await s.answer('carl', byWriter)).ok, true);
});

test('always: ask files one request after the apply; a second ask by the same member for the same tool is one request', BOUNDED, async (t) => {
  const s = await approveSetup(t);
  const first = await s.answer('carl', s.open(), { always: 'ask' });
  const second = await s.answer('carl', s.open(), { always: 'ask' });
  assert.deepEqual([first.always_result, second.always_result], [{ ok: true, request_seq: 1 }, { ok: true, request_seq: 1 }]);
  assert.equal(s.decided.length, 2);
  assert.deepEqual(s.kinds(), ['approval_decided', 'rule_requested', 'approval_decided']);
  const requests = (await s.listed()).requests;
  assert.deepEqual(requests.map((request) => [request.request_seq, request.asker_member_id, request.session_id, request.state]),
    [[1, s.member('carl'), s.sP, 'open']]);
  // Another tool is another request.
  assert.equal((await s.answer('carl', s.open(s.sP, { tool: 'edit_file' }), { always: 'ask' })).always_result.request_seq, 2);
});

test('a stale answer, a not-applied answer and approved: false with always write nothing', BOUNDED, async (t) => {
  const s = await approveSetup(t);
  const approval = s.open();
  assert.equal(reasonOf(await s.answer('alice', { ...approval, revision: 'dec_wrong' }, { always: 'rule' })), 'decision_stale');
  assert.equal(reasonOf(await s.answer('alice', approval, { always: 'rule', approved: false })), 'team_rule_always_invalid');
  assert.deepEqual([s.decided, s.kinds()], [[], []]);
  s.h.backend.approveToolCall = () => false;
  assert.equal(reasonOf(await s.answer('alice', approval, { always: 'rule' })), 'decision_stale');
  assert.deepEqual(s.kinds(), ['approval_decided', 'approval_not_applied']);
  assert.deepEqual((await s.listed()).rules, []);
  assert.equal(fs.existsSync(path.join(s.h.config.userDataPath, PROJECT_RULES_FILE)), false);
});

test('always needs a ruled tool and a team project: other tools and General refuse and apply nothing', BOUNDED, async (t) => {
  const s = await approveSetup(t);
  for (const tool of ['create_artifact', 'run_command']) {
    assert.equal(reasonOf(await s.answer('alice', s.open(s.sP, { tool }), { always: 'rule' })), 'team_rule_tool_invalid');
  }
  // Seeded in the store: on a team host sessions.create makes no General conversation (E70).
  const general = s.h.backend.sessionStore.createSession({ title: 'Mine' }).id;
  const approval = s.open(general, { starter: s.member('owner') });
  assert.equal(reasonOf(await s.answer('owner', approval, { always: 'rule' })), 'team_rule_no_project');
  assert.deepEqual([s.decided, s.kinds()], [[], []]);
});

test('a crash after the apply and before the rule is an allow with no rule', BOUNDED, async (t) => {
  const s = await approveSetup(t);
  s.faults.write = true;
  const done = await s.answer('alice', s.open(), { always: 'rule' });
  assert.equal(done.ok, true);
  assert.deepEqual(done.always_result, { ok: false, reason: 'team_rules_unavailable' });
  assert.deepEqual(s.decided.map(([, value]) => value), ['approved']);
  s.faults.write = false;
  assert.deepEqual((await s.listed()).rules, []);
});

test('the single-owner host refuses always exactly as its closed schema did, and applies nothing', async () => {
  let applied = 0;
  const handlers = createDecisionHandlers({ teamHost: false, decisionAdapter: { resolveApproval: () => { applied += 1; return { ok: true }; } },
    identity: () => null, trustedAuthor: () => null, mutationGuard: () => null, runReceipt: (_c, _x, fn) => fn(),
    assertMutationAuthority() {}, assertPostAwaitAuthority() {}, sessionExists: () => true, bumpRevision: () => 1, publish() {} });
  const command = { operation: 'approval.resolve', request_id: 'request_1', session_id: 'session_1',
    params: { stream_id: 's', approval_id: 'a', decision_revision: 'd', approved: true, always: 'rule' } };
  assert.deepEqual(await handlers.decision(command, {}), { ok: false, error: { code: 'CMP-HOST-0001', reason: 'invalid_command_parameters',
    retryable: false, request_id: 'request_1' } });
  assert.equal(applied, 0);
  const { always: _always, ...params } = command.params;
  assert.equal((await handlers.decision({ ...command, params }, {})).ok, true);
  assert.equal(applied, 1);
});

// ---- The port the backend consults ------------------------------------------------------------

async function portSetup(t) {
  const s = await approveSetup(t);
  await s.h.ok(s.send('alice', 'team.project.rules.add', { project_id: s.P, tool_name: 'write_file', folder: 'posts' }));
  await s.h.ok(s.send('alice', 'team.project.rules.add', { project_id: s.P, tool_name: 'edit_file', folder: null }));
  startTurn(s.h.backend.sessionStore, s.sP, s.member('carl'));
  const match = (input, { tool = 'write_file', sessionId = s.sP } = {}) => s.h.rules.match({ sessionId, toolName: tool, input });
  return { ...s, match };
}

test('the port: a matching rule answers; every no-rule case, other tool and other project asks a person', BOUNDED, async (t) => {
  const s = await portSetup(t);
  assert.deepEqual(s.match({ path: 'posts/a.md', content: 'x' }), { rule_seq: 1 });
  assert.deepEqual(s.match({ file_path: 'src/a.js', old_string: 'a', new_string: 'b' }, { tool: 'edit_file' }), { rule_seq: 2 });
  for (const [input, why] of [[{}, 'absent'], [{ path: '/etc/passwd' }, 'absolute outside'], [{ path: 'posts/../x.md' }, 'parent'],
    [{ path: 'posts//a.md' }, 'not normalized'], [{ path: 'posts-old/a.md' }, 'shared prefix'], [{ path: 'Posts/a.md' }, 'case'],
    [{ path: 'po\u0301sts/a.md' }, 'unicode'], [{ path: 'other/a.md' }, 'no rule'], [{ path: 'posts/a.md', file_path: 'x.md' }, 'two paths']]) {
    assert.equal(s.match(input), null, why);
  }
  for (const tool of ['create_artifact', 'run_command', 'read_file']) assert.equal(s.match({ path: 'posts/a.md' }, { tool }), null, tool);
  // A conversation of another project, and one in no project.
  startTurn(s.h.backend.sessionStore, s.sQ, s.member('bob'));
  assert.equal(s.match({ path: 'posts/a.md' }, { sessionId: s.sQ }), null);
  assert.equal(s.match({ path: 'posts/a.md' }, { sessionId: 'sess_unknown' }), null);
  // The project lookup fails.
  const peek = s.h.backend.sessionStore.peekSessionSummary;
  s.h.backend.sessionStore.peekSessionSummary = () => { throw new Error('index gone'); };
  assert.equal(s.match({ path: 'posts/a.md' }), null);
  s.h.backend.sessionStore.peekSessionSummary = peek;
  // The turn's starter may no longer write; a turn with no member author.
  await s.h.ok(s.send('alice', 'team.project.members.setRole', { project_id: s.P, member_id: s.member('carl'), role: 'reader' }));
  assert.equal(s.match({ path: 'posts/a.md' }), null);
  startTurn(s.h.backend.sessionStore, s.sP2, null);
  assert.equal(s.match({ path: 'posts/a.md' }, { sessionId: s.sP2 }), null);
  // match counts nothing: a use is counted only once the call settled (`used`), for a starter who may still write.
  assert.deepEqual((await s.listed()).rules.map((rule) => rule.use_count), [0, 0]);
  s.h.rules.used({ sessionId: s.sP, ruleSeq: 1 });
  await s.h.ok(s.send('alice', 'team.project.members.setRole', { project_id: s.P, member_id: s.member('carl'), role: 'writer' }));
  s.h.rules.used({ sessionId: s.sP, ruleSeq: 1 });
  s.h.rules.used({ sessionId: s.sP, ruleSeq: 0 });
  s.h.rules.used({ sessionId: 'sess_unknown', ruleSeq: 1 });
  assert.deepEqual((await s.listed()).rules.map((rule) => [rule.rule_seq, rule.use_count, rule.last_used_by]),
    [[1, 1, s.member('carl')], [2, 0, null]]);
});

test('the port: the most specific folder wins over a wider rule for the same tool', BOUNDED, async (t) => {
  const s = await portSetup(t);
  await s.h.ok(s.send('alice', 'team.project.rules.add', { project_id: s.P, tool_name: 'write_file', folder: 'posts/2026' }));
  await s.h.ok(s.send('alice', 'team.project.rules.add', { project_id: s.P, tool_name: 'write_file', folder: null }));
  assert.deepEqual(s.match({ path: 'posts/2026/a.md' }), { rule_seq: 3 });
  assert.deepEqual(s.match({ path: 'posts/a.md' }), { rule_seq: 1 });
  assert.deepEqual(s.match({ path: 'other/a.md' }), { rule_seq: 4 });
  // Hidden folders ask a person even under the "anywhere" rule.
  for (const value of ['.git/hooks/pre-commit', 'src/.env', '.github/workflows/x.yml']) assert.equal(s.match({ path: value }), null);
});

test('the port: an absolute path inside the project root matches; one beside it does not', BOUNDED, async (t) => {
  const s = await portSetup(t);
  const root = process.platform === 'win32' ? 'C:\\team\\projects\\p' : '/team/projects/p';
  s.h.backend.projectService = { get: (id) => (id === s.P ? { root_path: root } : null) };
  const sep = process.platform === 'win32' ? '\\' : '/';
  assert.deepEqual(s.match({ path: `${root}${sep}posts${sep}a.md` }), { rule_seq: 1 });
  assert.equal(s.match({ path: `${root}-old${sep}posts${sep}a.md` }), null);
});

test('a rules file that cannot be read at start: the host serves, a write asks a person, the commands are unavailable', BOUNDED, async (t) => {
  const newer = JSON.stringify({ schema_version: 2, projects: [{ project_id: 'project_x', rules: [{ tool_name: 'write_file' }] }] });
  for (const [why, plant] of [['newer schema', (file) => fs.writeFileSync(file, newer)],
    ['unreadable (a folder in its place)', (file) => fs.mkdirSync(file)]]) {
    const s = await setup(t, { rules: { createStore: (opts) => { plant(opts.filePath); return new ProjectRulesStore(opts); } } });
    assert.equal(s.h.rules.store().available(), false, why);
    // The host still serves: a conversation opens and the project list answers.
    assert.equal((await s.send('alice', 'sessions.create', { title: 'Still here', project_id: s.P })).ok, true, why);
    for (const [operation, params] of [['team.project.rules.list', { project_id: s.P }],
      ['team.project.rules.add', { project_id: s.P, tool_name: 'write_file', folder: null }],
      ['team.project.rules.remove', { project_id: s.P, rule_seq: 1 }]]) {
      assert.equal(reasonOf(await s.send('alice', operation, params)), 'team_rules_unavailable', `${why} ${operation}`);
    }
    startTurn(s.h.backend.sessionStore, s.sP, s.member('carl'));
    assert.equal(s.h.rules.match({ sessionId: s.sP, toolName: 'write_file', input: { path: 'posts/a.md' } }), null, why);
    const backend = s.h.backend;
    backend.hostMode = 'server';
    const emitted = [];
    const onStream = (event) => emitted.push(event);
    backend.on('chat-stream', onStream);
    const controller = new AbortController();
    const asked = waitForToolApproval(backend, STREAM, s.sP, 'req_x', { tool_name: 'write_file', tool_call_id: 'call_x',
      tool_input: { path: 'posts/a.md', content: 'x' } }, controller, null, trustedTurn(s.sP));
    assert.ok(emitted.some((event) => event.type === 'tool_approval_needed'), why);
    controller.abort();
    await asked;
    backend.off('chat-stream', onStream);
    if (why.startsWith('newer')) assert.equal(fs.readFileSync(path.join(s.h.config.userDataPath, PROJECT_RULES_FILE), 'utf8'), newer);
  }
});

test('end to end: a rule answers a real turn\'s write with no card, no unattended notice, and the rule on the event', BOUNDED, async (t) => {
  const s = await portSetup(t);
  const stream = s.h.attach('alice');
  const backend = s.h.backend;
  backend.hostMode = 'server';
  backend.currentModel = 'model';
  const emitted = [];
  const onStream = (event) => emitted.push(event);
  backend.on('chat-stream', onStream);
  t.after(() => backend.off('chat-stream', onStream));
  const turn = trustedTurn(s.sP);
  const result = await waitForToolApproval(backend, STREAM, s.sP, 'req_e2e',
    { tool_name: 'write_file', tool_call_id: 'call_e2e', tool_input: { path: 'posts/launch.md', content: 'x' } }, new AbortController(),
    null, turn);
  assert.equal(result.approved ?? result, true);
  assert.equal(emitted.some((event) => event.type === 'tool_approval_needed'), false);
  const settled = emitted.find((event) => event.type === 'tool_use' && event.status === 'approved');
  assert.deepEqual([settled.approvalScope, settled.teamRuleSeq], ['team_rule', 1]);
  assert.equal(frames(stream, 'approval_unattended').length, 0);
  assert.equal(backend.pendingToolApprovals.size, 0);
  // No audit entry per allowed call.
  assert.deepEqual(s.kinds(), ['rule_added', 'rule_added']);
  // The settled call counted one use for the turn's starter.
  assert.deepEqual((await s.listed()).rules.map((rule) => [rule.use_count, rule.last_used_by]), [[1, s.member('carl')], [0, null]]);
  // A path outside the rule still asks; a rule added while it waits leaves the waiting card a card.
  const controller = new AbortController();
  const asked = waitForToolApproval(backend, STREAM, s.sP, 'req_e2e2',
    { tool_name: 'write_file', tool_call_id: 'call_e2e2', tool_input: { path: 'drafts/a.md', content: 'x' } }, controller, null, turn);
  assert.ok(emitted.some((event) => event.type === 'tool_approval_needed'));
  await s.h.ok(s.send('alice', 'team.project.rules.add', { project_id: s.P, tool_name: 'write_file', folder: 'drafts' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.pendingToolApprovals.size, 1, 'still waiting for a person');
  assert.equal(emitted.filter((event) => event.type === 'tool_use' && event.status === 'approved').length, 1);
  controller.abort();
  await asked;
});
