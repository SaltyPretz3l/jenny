'use strict';

// new-test-file: slice 3-12's consult point (services/backend/team-rule-gate.js beside Full auto in
// chat-stream-tool-approval.js), a new surface; chat-stream-tool-approval.test.js is at 954 lines.

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { TEAM_RULE_SCOPE, teamRuleApproves } = require('../services/backend/team-rule-gate');
const { trustedTurn } = require('./helpers/trusted-turn');

const SESSION = 'session_1';
const TURN = trustedTurn(SESSION);

// A service as the approval code reads it; `port` is the team host's rules port (absent: no port). The session
// store keeps every row written, so a test reads what was persisted.
function service({ hostMode = 'server', port, ...extra } = {}) {
  const emitted = [];
  const rows = new Map();
  const svc = {
    hostMode,
    sessionStore: {
      appendMessage: (_sessionId, row) => { rows.set(row.id, structuredClone(row)); },
      updateMessage: (_sessionId, id, patch) => { rows.set(id, { ...rows.get(id), ...structuredClone(patch) }); },
    },
    emit: (_name, payload) => emitted.push(payload), pendingToolApprovals: new Map(), currentModel: 'model',
    ...(port === undefined ? {} : { teamProjectRules: port }),
    ...extra,
  };
  return { svc, emitted, rows };
}

// Starts one approval and answers what happened without a person: the result when settled at once, else 'asked'
// (the waiter is cancelled after the check so nothing is left open).
async function run(svc, { tool = 'write_file', input = { path: 'posts/a.md', content: 'x' }, binding = TURN, params = {} } = {}) {
  const collector = new CanonicalTurnEventCollector({ turnId: 'stream_1', sessionId: SESSION });
  const controller = new AbortController();
  const pending = waitForToolApproval(svc, 'stream_1', SESSION, 'req_1',
    { tool_name: tool, tool_call_id: 'call_1', tool_input: input, ...params }, controller, collector, binding);
  const raced = await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve('asked')))]);
  if (raced === 'asked') { controller.abort(); await pending; }
  return { outcome: raced, collector };
}

// A port that answers rule 7 for anything it is asked, and records each ask and each counted use.
function matchAll() {
  const seen = [];
  const uses = [];
  return { seen, uses, port: { match: (args) => { seen.push(args); return { rule_seq: 7 }; }, used: (args) => uses.push(args) } };
}
const canonical = (collector, type) => collector.capturedEvents.filter((event) => event.payload?.canonical_event_type === type);

test('a matching rule answers write_file and edit_file with no card: team_rule and the rule id, persisted and live', async () => {
  for (const tool of ['write_file', 'edit_file']) {
    const { seen, uses, port } = matchAll();
    const { svc, emitted, rows } = service({ port });
    const input = tool === 'write_file' ? { path: 'posts/a.md', content: 'x' } : { file_path: 'posts/a.md', old_string: 'a', new_string: 'b' };
    const { outcome, collector } = await run(svc, { tool, input });
    assert.notEqual(outcome, 'asked', tool);
    assert.equal(outcome.approved ?? outcome, true, tool);
    assert.equal(emitted.some((event) => event.type === 'tool_approval_needed'), false);
    assert.equal(emitted.some((event) => event.type === 'tool_use' && event.status === 'pending_approval'), false);
    const settled = emitted.find((event) => event.type === 'tool_use' && event.status === 'approved');
    assert.deepEqual([settled.approvalScope, settled.teamRuleSeq], [TEAM_RULE_SCOPE, 7]);
    // What is persisted: the tool row settled approved, and the canonical resolution with the scope and rule id.
    const [row] = [...rows.values()];
    assert.deepEqual([row.kind, row.tool_call.status, row.tool_call.approval_state], ['tool_use', 'approved', 'approved']);
    const [resolved] = canonical(collector, 'tool_approval_resolved');
    assert.deepEqual([resolved.payload.approval_scope, resolved.payload.team_rule_seq, resolved.payload.approved], ['team_rule', 7, true]);
    // The port read the same tool_input the exact-input check hashes, for this conversation and tool, and one use was
    // counted once the call settled.
    assert.deepEqual(seen, [{ sessionId: SESSION, toolName: tool, input }]);
    assert.deepEqual(uses, [{ sessionId: SESSION, ruleSeq: 7 }]);
    assert.equal(svc.pendingToolApprovals.size, 0);
  }
});

test('a one-off request, a Plan or read-only turn, or no trusted binding asks a person with a rule present, port unasked', async () => {
  const cases = [
    ['one_off_only', { params: { one_off_only: true } }],
    ['plan mode', { binding: trustedTurn(SESSION, { planMode: true }) }],
    ['plan run mode', { binding: trustedTurn(SESSION, { runMode: 'plan' }) }],
    ['propose (read-only)', { binding: trustedTurn(SESSION, { runMode: 'propose' }) }],
    ['read-only capture', { binding: trustedTurn(SESSION, { readOnly: true }) }],
    ['no binding', { binding: null }],
    ['an untrusted binding', { binding: Object.freeze({}) }],
  ];
  for (const [why, options] of cases) {
    const { seen, port } = matchAll();
    const { svc, emitted } = service({ port });
    assert.equal((await run(svc, options)).outcome, 'asked', why);
    assert.ok(emitted.some((event) => event.type === 'tool_approval_needed'), why);
    assert.equal(seen.length, 0, `${why}: the port is not asked`);
  }
});

test('a rule never overrides an earlier refusal: the deny rule, the port refusal, the duplicate check', async () => {
  // The deny rule (row 87) refuses a stop before any card.
  const denied = matchAll();
  const deny = service({ port: denied.port, primaryActionRules: { denial: () => ({ rule_id: 'r' }) } });
  const stop = await run(deny.svc, { tool: 'session_stop', input: { session_id: 'sess_x' } });
  assert.equal(stop.outcome.decision, 'app_refused');
  // A port refusal (project create with no placement port) ends before any card.
  const refusedPort = matchAll();
  const create = service({ port: refusedPort.port });
  assert.equal((await run(create.svc, { tool: 'project_create', input: { name: 'x' } })).outcome.decision, 'app_refused');
  // A second request for a live approval id is denied; the first waiter keeps its resolve.
  const seen = [];
  let rule = null;
  const dup = service({ port: { match: (args) => { seen.push(args); return rule; }, used() {} } });
  const ask = (controller) => waitForToolApproval(dup.svc, 'stream_1', SESSION, 'req_1',
    { tool_name: 'write_file', tool_call_id: 'call_1', tool_input: { path: 'a.md', content: 'x' } }, controller, null, TURN);
  const firstController = new AbortController();
  const first = ask(firstController);
  const [waiter] = dup.svc.pendingToolApprovals.values();
  rule = { rule_seq: 7 };
  assert.equal(await ask(new AbortController()), false);
  assert.equal(seen.length, 1, 'the duplicate never reached the gate');
  assert.equal([...dup.svc.pendingToolApprovals.values()][0], waiter);
  firstController.abort();
  await first;
  for (const refused of [denied, refusedPort]) assert.equal(refused.seen.length, 0);
});

test('run_command and other tools ask a person even when the port would answer a rule', async () => {
  for (const tool of ['run_command', 'create_artifact', 'read_file']) {
    const { seen, port } = matchAll();
    const { svc } = service({ port });
    assert.equal((await run(svc, { tool, input: { command: 'ls', path: 'a.md' } })).outcome, 'asked', tool);
    assert.equal(seen.length, 0);
  }
  assert.equal(teamRuleApproves({ hostMode: 'server', teamProjectRules: matchAll().port },
    { toolName: 'run_command', input: {}, executionAuthority: TURN }), null);
});

test('a rule-matched call then denied (aborted, or over the exact-input size) counts no use', async () => {
  const big = matchAll();
  const large = service({ port: big.port });
  const { outcome } = await run(large.svc, { input: { path: 'posts/a.md', content: 'x'.repeat(40 * 1024) } });
  assert.equal(outcome.approved ?? outcome, false);
  assert.equal(big.seen.length, 1);
  assert.deepEqual(big.uses, []);
  const early = matchAll();
  const aborted = service({ port: early.port });
  const controller = new AbortController();
  controller.abort();
  await waitForToolApproval(aborted.svc, 'stream_1', SESSION, 'req_1',
    { tool_name: 'write_file', tool_call_id: 'call_1', tool_input: { path: 'a.md', content: 'x' } }, controller, null, TURN);
  assert.deepEqual(early.uses, []);
});

test('no rule, an odd answer, a throw, a non-object input: a person is asked exactly as today', async () => {
  const ports = [{ match: () => null }, { match: () => ({ rule_seq: 0 }) }, { match: () => ({ rule_seq: '7' }) },
    { match: () => { throw new Error('boom'); } }, {}, { match: 'yes' }];
  for (const port of ports) {
    const { svc, emitted } = service({ port });
    assert.equal((await run(svc)).outcome, 'asked');
    assert.ok(emitted.some((event) => event.type === 'tool_approval_needed'));
  }
  const { seen, port } = matchAll();
  const { svc } = service({ port });
  for (const input of [null, 'posts/a.md', ['posts/a.md']]) assert.equal((await run(svc, { input })).outcome, 'asked');
  assert.equal(seen.length, 0);
});

test('a desktop or single-owner backend (no port, or not a server host) is unchanged; the gate never runs there', async () => {
  for (const options of [{ hostMode: 'server' }, { hostMode: 'desktop', port: matchAll().port }, { hostMode: null, port: matchAll().port }]) {
    const { svc, emitted } = service(options);
    assert.equal((await run(svc)).outcome, 'asked');
    const card = emitted.find((event) => event.type === 'tool_approval_needed');
    assert.ok(card);
    assert.equal(Object.hasOwn(card, 'teamRuleSeq'), false);
  }
  assert.equal(teamRuleApproves(null, {}), null);
  assert.equal(teamRuleApproves({ hostMode: 'server' }, { toolName: 'write_file', input: {}, executionAuthority: TURN }), null);
});

test('a person who answers still settles with their own scope, no rule id and no use counted', async () => {
  const uses = [];
  const { svc, emitted } = service({ port: { match: () => null, used: (args) => uses.push(args) } });
  const controller = new AbortController();
  const pending = waitForToolApproval(svc, 'stream_1', SESSION, 'req_1',
    { tool_name: 'write_file', tool_call_id: 'call_1', tool_input: { path: 'a.md', content: 'x' } }, controller, null, TURN);
  const [entry] = svc.pendingToolApprovals.values();
  entry.resolve(true, 'approved', '', null, 'once');
  await pending;
  const settled = emitted.find((event) => event.type === 'tool_use' && event.status === 'approved');
  assert.equal(settled.approvalScope, 'once');
  assert.equal(Object.hasOwn(settled, 'teamRuleSeq'), false);
  assert.deepEqual(uses, []);
});

// D5 (docs/plans/TEAM_HOST_FILE_TOOLS_2026-11-16.md): while the host's file tools are on, no rule answers; a person
// sees every write and edit.
test('with file tools on (a root boundary set) a matching rule answers nothing and a person is asked', async () => {
  const on = matchAll();
  const { svc, emitted } = service({ port: on.port, hostRootBoundary: '/srv/team/projects' });
  assert.equal((await run(svc)).outcome, 'asked');
  assert.equal(on.seen.length, 0, 'the port is never asked');
  assert.equal(Object.hasOwn(emitted.find((event) => event.type === 'tool_approval_needed'), 'teamRuleSeq'), false);
  assert.equal(teamRuleApproves({ hostMode: 'server', teamProjectRules: matchAll().port, hostRootBoundary: '/srv/p' },
    { toolName: 'write_file', input: { path: 'a.md', content: 'x' }, executionAuthority: TURN }), null);
  const off = matchAll();
  assert.equal(teamRuleApproves({ hostMode: 'server', teamProjectRules: off.port, hostRootBoundary: null },
    { toolName: 'write_file', input: { path: 'a.md', content: 'x' }, executionAuthority: TURN })?.rule_seq, 7,
  'off, the rule answers as before');
});
