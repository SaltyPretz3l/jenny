'use strict';

// new-test-file: the member client's half of "Always allowed" (row 123 slice 3-10 part 1) with no host: the four rule
// methods' payload checks in main, their rebuilt answers, `always` on a decision and its `always_result`, the three
// rule events forwarded on team.onProject as closed kinds (a malformed one dropped), and the audit detail keeping
// rule_seq and request_seq. tests/team-project-ipc.test.js sends the same methods to the real host.

const assert = require('node:assert/strict');
const test = require('node:test');

const { METHODS, PROJECT_OPERATIONS, validatePayload } = require('../services/team/ipc-methods');
const { checkedRuleEvent, projectAnswer } = require('../services/team/project-answers');
const { createProjectConversations } = require('../services/team/project-conversations');
const { PROJECT_REASONS } = require('../services/team/project-reasons');
const { createTeamProjects } = require('../services/team/team-projects');
const { fakeTimers } = require('./helpers/team-project-client-host');

const TEAM = 'team_AAAAAAAAAAAAAAAAAAAAAA';
const P = 'project_aaaaaaaaaaaa';
const S = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const M = 'member_aaaaaaaaaaaaaaaaaaaaaa';
const turn = () => new Promise((resolve) => setImmediate(resolve));
const invalid = (answer) => answer.ok === false && answer.error.reason === 'team_answer_invalid';

const RULE = { rule_seq: 1, tool_name: 'edit_file', folder: 'posts', set_by: M, set_at: 10, from_request_seq: null,
  use_count: 0, last_used_at: null, last_used_by: null };
const REQUEST = { request_seq: 2, tool_name: 'write_file', asker_member_id: M, session_id: S, asked_at: 5, state: 'declined',
  answered_by: M, answered_at: 6, outcome_tool: null, outcome_folder: null, reason: 'Keep drafts reviewed <b>x</b>', rule_seq: null };

test('the four rule methods map to their host operations', () => {
  assert.deepEqual(['projectRules', 'projectRuleAdd', 'projectRuleRemove', 'projectRuleAnswer'].map((m) => PROJECT_OPERATIONS[m]),
    ['team.project.rules.list', 'team.project.rules.add', 'team.project.rules.remove', 'team.project.rules.answer']);
  for (const method of ['projectRules', 'projectRuleAdd', 'projectRuleRemove', 'projectRuleAnswer']) assert.ok(METHODS[method], method);
});

test('rule payloads: the host\'s fields and bounds, the outcome\'s own fields, nothing else', () => {
  const base = { team_id: TEAM, project_id: P };
  const good = [
    ['projectRules', base],
    ['projectRuleAdd', { ...base, tool_name: 'edit_file', folder: null }],
    ['projectRuleAdd', { ...base, tool_name: 'write_file', folder: 'posts/drafts' }],
    ['projectRuleAdd', { ...base, tool_name: 'write_file', folder: 'a'.repeat(255) }],
    ['projectRuleRemove', { ...base, rule_seq: 1 }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'allow' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'change', tool_name: 'edit_file' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'change', tool_name: 'edit_file', folder: 'posts' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'decline', reason: 'x'.repeat(200) }],
    ['conversationDecide', { team_id: TEAM, session_id: S, stream_id: 's', approval_id: 'a', decision_revision: 'r', approved: true, always: 'ask' }],
    ['conversationDecide', { team_id: TEAM, session_id: S, stream_id: 's', approval_id: 'a', decision_revision: 'r', approved: true, always: 'rule' }],
  ];
  for (const [method, payload] of good) assert.equal(validatePayload(method, payload).ok, true, `${method} ${JSON.stringify(payload)}`);
  const bad = [
    ['projectRules', { ...base, extra: 1 }], ['projectRules', { team_id: TEAM }],
    ['projectRuleAdd', { ...base, tool_name: 'run_command', folder: null }],
    ['projectRuleAdd', { ...base, tool_name: 'edit_file' }],
    ['projectRuleAdd', { ...base, tool_name: 'edit_file', folder: '' }],
    ['projectRuleAdd', { ...base, tool_name: 'edit_file', folder: 'a'.repeat(256) }],
    ['projectRuleAdd', { ...base, tool_name: 'edit_file', folder: '../up' }],
    ['projectRuleAdd', { ...base, tool_name: 'edit_file', folder: '.git' }],
    ['projectRuleAdd', { ...base, tool_name: 'edit_file', folder: 'po\u202ests' }],
    ['projectRuleRemove', { ...base, rule_seq: 0 }], ['projectRuleRemove', { ...base, rule_seq: '1' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'maybe' }],
    ['projectRuleAnswer', { ...base, request_seq: 0, outcome: 'allow' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'allow', tool_name: 'edit_file' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'allow', reason: 'no' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'change' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'change', tool_name: 'edit_file', reason: 'no' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'decline' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'decline', reason: 'x'.repeat(201) }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'decline', reason: ' padded ' }],
    ['projectRuleAnswer', { ...base, request_seq: 3, outcome: 'decline', reason: 'no', folder: null }],
    ['conversationDecide', { team_id: TEAM, session_id: S, stream_id: 's', approval_id: 'a', decision_revision: 'r', approved: false, always: 'ask' }],
    ['conversationDecide', { team_id: TEAM, session_id: S, stream_id: 's', approval_id: 'a', decision_revision: 'r', approved: true, always: 'forever' }],
  ];
  for (const [method, payload] of bad) assert.equal(validatePayload(method, payload).ok, false, `${method} ${JSON.stringify(payload)}`);
});

test('rule answers are rebuilt field by field: an extra field dropped, a missing key or wrong type refuses', () => {
  const cases = {
    'team.project.rules.list': [{ project_id: P, revision: 3, rules: [RULE], open_request_count: 1, requests: [REQUEST] }, 'rules', 'x'],
    'team.project.rules.add': [{ project_id: P, rule_seq: 4, revision: 3 }, 'rule_seq', 0],
    'team.project.rules.answer': [{ project_id: P, request_seq: 2, outcome: 'declined', rule_seq: null, revision: 3 }, 'outcome', 'decline'],
    'team.project.rules.remove': [{ project_id: P, rule_seq: 4, revision: 3 }, 'revision', '3'],
  };
  for (const [operation, [body, key, wrong]] of Object.entries(cases)) {
    const kept = projectAnswer(operation, { ok: true, ...body, extra_secret: 'root_path' });
    assert.equal(kept.ok, true, operation);
    assert.equal(JSON.stringify(kept).includes('extra_secret'), false, operation);
    const missing = { ok: true, ...body };
    delete missing[key];
    assert.ok(invalid(projectAnswer(operation, missing)), `${operation} without ${key}`);
    assert.ok(invalid(projectAnswer(operation, { ok: true, ...body, [key]: wrong })), `${operation} ${key} wrong`);
  }
  const list = projectAnswer('team.project.rules.list', { ok: true, ...cases['team.project.rules.list'][0] });
  assert.deepEqual(list.rules, [RULE]);
  assert.equal(list.requests[0].reason, REQUEST.reason, 'markup is plain text; the renderer escapes it');
  const extraRow = projectAnswer('team.project.rules.list', { ok: true, ...cases['team.project.rules.list'][0],
    rules: [{ ...RULE, path: 'C:\\host' }] });
  assert.equal(JSON.stringify(extraRow).includes('host'), false, 'a row is rebuilt too');
  // Row 123 (team host file tools, D5): the host says its rules are paused while project files are on.
  const paused = projectAnswer('team.project.rules.list', { ok: true, ...cases['team.project.rules.list'][0], paused: 'file_tools' });
  assert.equal(paused.paused, 'file_tools');
  assert.equal(Object.hasOwn(list, 'paused'), false, 'absent when not paused');
  for (const wrong of ['yes', true, 'run_command']) {
    assert.ok(invalid(projectAnswer('team.project.rules.list', { ok: true, ...cases['team.project.rules.list'][0], paused: wrong })),
      String(wrong));
  }
  assert.ok(invalid(projectAnswer('team.project.rules.list', { ok: true, ...cases['team.project.rules.list'][0],
    rules: Array(33).fill(RULE) })), 'more than 32 rules');
  assert.ok(invalid(projectAnswer('team.project.rules.list', { ok: true, ...cases['team.project.rules.list'][0],
    requests: [{ ...REQUEST, state: 'pending' }] })), 'a request state outside the closed list');
  assert.ok(invalid(projectAnswer('team.project.rules.list', { ok: true, ...cases['team.project.rules.list'][0],
    requests: [{ ...REQUEST, reason: 'x'.repeat(401) }] })), 'a reason past its bound');
});

test('approval.resolve keeps always_result, rebuilt; a bad one refuses the answer', () => {
  assert.deepEqual(projectAnswer('approval.resolve', { ok: true, revision: 'boot:2' }), { ok: true, revision: 'boot:2' });
  assert.deepEqual(projectAnswer('approval.resolve', { ok: true, revision: 'boot:2', always_result: { ok: true, request_seq: 4, x: 1 } }),
    { ok: true, revision: 'boot:2', always_result: { ok: true, request_seq: 4 } });
  assert.deepEqual(projectAnswer('approval.resolve', { ok: true, revision: 'boot:2', always_result: { ok: true, rule_seq: 2 } }).always_result,
    { ok: true, rule_seq: 2 });
  assert.deepEqual(projectAnswer('approval.resolve', { ok: true, revision: 'boot:2', always_result: { ok: false, reason: 'team_rule_request_limit' } })
    .always_result, { ok: false, reason: 'team_rule_request_limit' });
  for (const bad of [{ ok: true }, { ok: true, rule_seq: 0 }, { ok: false, reason: 'Not A Word' }, 'yes', { ok: 'true', rule_seq: 1 }]) {
    assert.ok(invalid(projectAnswer('approval.resolve', { ok: true, revision: 'boot:2', always_result: bad })), JSON.stringify(bad));
  }
});

test('a decision carries `always` to approval.resolve only when given', async () => {
  const sent = [];
  const manager = { command: async (operation, params) => { sent.push({ operation, params }); return { ok: true, revision: 'boot:3', always_result: { ok: true, request_seq: 1 } }; } };
  const conv = createProjectConversations({ manager, teamId: TEAM, online: () => true, timers: fakeTimers() });
  const decide = { team_id: TEAM, session_id: S, stream_id: 's1', approval_id: 'a1', decision_revision: 'r1', approved: true };
  const answer = await conv.call('conversationDecide', { ...decide, always: 'ask' });
  assert.deepEqual(answer, { ok: true, revision: 'boot:3', always_result: { ok: true, request_seq: 1 } });
  await conv.call('conversationDecide', decide);
  assert.deepEqual(sent.map((one) => one.params), [
    { stream_id: 's1', approval_id: 'a1', decision_revision: 'r1', approved: true, always: 'ask' },
    { stream_id: 's1', approval_id: 'a1', decision_revision: 'r1', approved: true },
  ]);
});

test('the rule events are closed kinds; a malformed one is null', () => {
  assert.deepEqual(checkedRuleEvent('team_project_rules_changed', { event_type: 'x', project_id: P, revision: 4, extra: 1 }),
    { kind: 'rules_changed', project_id: P, revision: 4 });
  assert.deepEqual(checkedRuleEvent('team_project_rule_requests', { project_id: P, open_count: 2 }),
    { kind: 'rule_requests', project_id: P, open_count: 2 });
  assert.deepEqual(checkedRuleEvent('team_rule_request_answered', { session_id: S, request_seq: 3, outcome: 'changed' }),
    { kind: 'rule_answered', session_id: S, request_seq: 3, outcome: 'changed' });
  assert.equal(checkedRuleEvent('team_project_rules_changed', { project_id: 'project_../x', revision: 4 }), null);
  assert.equal(checkedRuleEvent('team_project_rule_requests', { project_id: P, open_count: -1 }), null);
  assert.equal(checkedRuleEvent('team_rule_request_answered', { session_id: S, request_seq: 3, outcome: 'open' }), null);
  assert.equal(checkedRuleEvent('chat_stream', { session_id: S }), undefined, 'not a rule event');
});

function fakeTeam() {
  let handler = () => {};
  const manager = { snapshot: () => ({ state: 'online', member_state: 'active', role: 'member' }),
    onEvent: (fn) => { handler = fn; return () => {}; }, command: async () => ({ ok: true }) };
  const pushes = [];
  const logs = [];
  let held = false;
  const projects = createTeamProjects({ push: (p) => pushes.push(p), log: (level, event, fields) => logs.push({ level, event, fields }),
    isHeld: () => held, timers: fakeTimers() });
  projects.connectionChanged(TEAM, manager);
  return { projects, pushes, logs, fire: (event) => handler(event), hold: (value) => { held = value; } };
}

test('team.onProject forwards each rule event as its kind; a malformed one is dropped with a log line', async () => {
  const f = fakeTeam();
  f.fire({ event_type: 'team_project_rules_changed', project_id: P, revision: 2 });
  f.fire({ event_type: 'team_project_rule_requests', project_id: P, open_count: 1 });
  f.fire({ event_type: 'team_rule_request_answered', session_id: S, request_seq: 1, outcome: 'allowed' });
  f.fire({ event_type: 'team_project_rule_requests', project_id: P, open_count: 'many' });
  await turn();
  assert.deepEqual(f.pushes, [
    { team_id: TEAM, kind: 'rules_changed', project_id: P, revision: 2 },
    { team_id: TEAM, kind: 'rule_requests', project_id: P, open_count: 1 },
    { team_id: TEAM, kind: 'rule_answered', session_id: S, request_seq: 1, outcome: 'allowed' },
  ]);
  assert.ok(f.logs.some((line) => line.event === 'team.projects.event_refused'), 'the malformed one is logged by type only');
  f.hold(true);
  f.fire({ event_type: 'team_project_rules_changed', project_id: P, revision: 3 });
  assert.equal(f.pushes.length, 3, 'nothing is forwarded while Force local holds');
  await f.projects.stopAll();
});

test('the audit keeps rule_seq and request_seq in an entry\'s detail', () => {
  const entry = (kind, detail) => ({ seq: 1, at: 1, kind, project_id: P, session_id: null, actor_member_id: M, prompter_member_id: null,
    tool_name: 'edit_file', decision: null, detail });
  const answer = projectAnswer('team.project.audit.read', { ok: true, floor_seq: null, next_cursor: null, entries: [
    entry('rule_request_changed', { request_seq: 3, rule_seq: 2, path: 'x' }), entry('files_copied_in', { files: 4, bytes: 9 })] });
  assert.deepEqual(answer.entries.map((one) => one.detail), [{ request_seq: 3, rule_seq: 2 }, { files: 4, bytes: 9 }]);
});

test('a saved send, an approval and a finished turn read the snapshot once more and push it; one read in flight', async () => {
  const sent = [];
  const pending = [];
  const snap = (revision, approvals = []) => ({ ok: true, snapshot: { cursor: 1, session: { session_id: S, title: 'T', revision, plan_mode: false },
    messages: [], message_count: 0, has_more: false, active_turn: null, pending_approvals: approvals, pending_questions: [] } });
  let hold = false;
  const manager = { command: async (operation, params) => {
    sent.push({ operation, params });
    if (operation === 'sessions.snapshot' && hold) return new Promise((resolve) => pending.push(resolve));
    if (operation === 'sessions.snapshot') return snap('boot:1');
    return { ok: true, viewing: true, viewers: [] };
  } };
  const pushes = [];
  const conv = createProjectConversations({ manager, teamId: TEAM, online: () => true, timers: fakeTimers(), push: (p) => pushes.push(p) });
  await conv.call('conversationOpen', { team_id: TEAM, session_id: S });
  const reads = () => sent.filter((one) => one.operation === 'sessions.snapshot').length;
  assert.equal(reads(), 1);
  hold = true;
  conv.onEvent({ event_type: 'chat_stream', session_id: S, stream_id: 'st1', event: { type: 'tool_approval_needed', approval_id: 'a1' } });
  conv.onEvent({ event_type: 'session_changed', session_id: S, revision: 'boot:2', reason: 'chat_saved' });
  conv.onEvent({ event_type: 'chat_stream', session_id: S, stream_id: 'st1', event: { type: 'complete' } });
  conv.onEvent({ event_type: 'chat_stream', session_id: S, stream_id: 'st1', event: { type: 'delta', content: 'x' } });
  conv.onEvent({ event_type: 'session_changed', session_id: S, revision: 'boot:3', reason: 'renamed' });
  await turn();
  assert.equal(reads(), 2, 'one read in flight');
  pending.shift()(snap('boot:4', [{ approval_id: 'a1', decision_revision: 'dec_1', stream_id: 'st1', tool_name: 'edit_file', prompter_member_id: M }]));
  await turn();
  assert.equal(reads(), 3, 'one more read after it, for the triggers meanwhile');
  pending.shift()(snap('boot:5'));
  await turn();
  const snapshots = pushes.filter((p) => p.kind === 'snapshot');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].snapshot.pending_approvals[0].decision_revision, 'dec_1');
  assert.deepEqual(sent.filter((one) => one.operation === 'sessions.snapshot').map((one) => one.params), Array(3).fill({ max_messages: 20 }));
  conv.stop();
});

test('every team_rule reason the host can answer is on the client\'s closed list', () => {
  for (const reason of ['team_rules_unavailable', 'team_rules_full', 'team_rules_invalid', 'team_rule_limit', 'team_rule_exists',
    'team_rule_request_limit', 'team_rule_request_not_found', 'team_rule_not_found', 'team_rule_folder_invalid',
    'team_rule_reason_invalid', 'team_rule_answer_invalid', 'team_rule_always_invalid', 'team_rule_tool_invalid',
    'team_rule_no_project', 'team_audit_unavailable']) assert.ok(PROJECT_REASONS.includes(reason), reason);
});

// Fix list S5 (3-10): the renderer's checks before a send (renderer-team-project-column.js checkName, checkFolder,
// checkReason) give the same verdict as main's validatePayload on what the renderer would send, so the person reads
// the matching sentence and nothing is sent that main refuses.
test('the renderer\'s name, folder and reason checks match main\'s on every case', () => {
  const column = require('../renderer/team/renderer-team-project-column');
  const long = (n, ch = 'a') => ch.repeat(n);
  const verdict = (method, payload) => validatePayload(method, payload).ok;
  const cases = {
    name: ['docs', '  docs  ', '', '   ', long(80), long(81), 'tab\there', 'bell\u0007', 'é'.repeat(80), '日本語のプロジェクト', '\u202eevil', '<b>x</b>'],
    folder: ['posts', ' posts ', 'posts/drafts', 'a/b/c/d/e/f/g/h', 'a/b/c/d/e/f/g/h/i', '', '/abs', 'C:/x', 'C:x', '..', '.git', 'a/.hidden', 'a//b', 'a/', 'trail.',
      'trail ', 'con', 'CON.txt', 'lpt1', 'com\u00b9', 'a:b', 'a*b', 'a?b', 'a|b', 'a"b', 'a<b', 'a\\b', 'tab\tx', '\u0085x', '\u202ex', '\u200bx', '\ufeffx',
      long(255), long(256), 'é'.repeat(200), long(256, 'é'), '\ud800x', 'ok name/with space', 'emoji\u{1F600}'],
    reason: ['Keep drafts reviewed', '  padded  ', '', '   ', long(200), long(201), 'line\nbreak', 'tab\tx', 'sep\u2028x', '\u202eevil', 'zw\u200bx', '\u2060x',
      '\u200d', 'a\u200db', 'e\u0301', '\u{1F44D}\ufe0f ok', 'x\ufe0f', '\u6f22\ufe00', '\u3000', '\u2800', '\u00ad', 'x\u00ady', '<b>x</b>'],
  };
  for (const text of cases.name) {
    const mine = column.checkName(text);
    const sent = mine.ok ? mine.name : text.trim();
    assert.equal(mine.ok, verdict('projectCreate', { team_id: TEAM, name: sent }), 'name ' + JSON.stringify(text));
    if (!mine.ok) assert.equal(mine.reason, 'team_project_name_invalid');
  }
  for (const text of cases.folder) {
    const mine = column.checkFolder(text);
    const sent = mine.ok ? mine.folder : text.trim();
    for (const [method, extra] of [['projectRuleAdd', { tool_name: 'edit_file' }], ['projectRuleAnswer', { request_seq: 1, outcome: 'change', tool_name: 'edit_file' }]]) {
      assert.equal(mine.ok, verdict(method, { team_id: TEAM, project_id: P, ...extra, folder: sent }), method + ' folder ' + JSON.stringify(text));
    }
    if (!mine.ok) assert.equal(mine.reason, 'team_rule_folder_invalid');
  }
  for (const text of cases.reason) {
    const mine = column.checkReason(text);
    const sent = mine.ok ? mine.reason : text.trim().normalize('NFC');
    assert.equal(mine.ok, verdict('projectRuleAnswer', { team_id: TEAM, project_id: P, request_seq: 1, outcome: 'decline', reason: sent }), 'reason ' + JSON.stringify(text));
    if (!mine.ok) assert.equal(mine.reason, 'team_rule_reason_invalid');
  }
});
