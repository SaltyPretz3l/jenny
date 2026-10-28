'use strict';

// Jenny CLI S4: the run-scoped permission ceiling and the two deciders. A run can only narrow the
// profile's stored policy, a desktop-only tool is reachable by exact name only, a non-interactive
// run settles every request closed the moment it exists, and a terminal approval is once-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const { CLI_ERROR_CODES } = require('../../services/backend/error-codes');
const { evaluatePolicy } = require('../../services/tools/tool-policy-evaluator');
const {
  DESKTOP_ONLY_TOOLS, MANIFEST_SELECTORS, createCeilingPermissionStore, createRunPermissionPolicy,
} = require('../../services/cli-host/run-permission-policy');
const manifest = require('../../services/tools/tool-manifest.json');
const { createHeadlessDecider } = require('../../services/cli-host/decisions-headless');
const { createTtyDecider } = require('../../services/cli-host/decisions-tty');
const { createCliHost, hostComposition } = require('../../services/cli-host/host');
const schema = require('../../services/cli-host/schemas/cli-v1.json');

const ROOT = path.resolve(__dirname, '../..');
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const KNOWN = ['read_file', 'write_file', 'edit_file', 'glob_files', 'grep_search', 'worktree_list', ...DESKTOP_ONLY_TOOLS];

const validateDecision = new Ajv({ allErrors: true, strict: false })
  .compile({ $ref: '#/definitions/payload_decision', definitions: schema.definitions });

function decide(snapshot, toolId) {
  return evaluatePolicy({ descriptor: { name: toolId }, snapshot }).decision;
}

function storedSnapshot(overrides = {}) {
  return {
    version: 3,
    legacy_policies: { read_file: 'auto', write_file: 'auto', run_command: 'auto', edit_file: 'deny' },
    rules: [
      { id: 'owner-auto-everything', decision: 'auto', reason: 'desktop convenience', match: {} },
      { id: 'owner-auto-write', decision: 'auto', reason: 'desktop', match: { tool_id: 'write_file' } },
      { id: 'owner-deny-grep', decision: 'deny', reason: 'owner', match: { tool_id: 'grep_search' } },
    ],
    ...overrides,
  };
}

test('selectors: exact ids, simple globs, never regex, never a desktop-only tool through a glob', () => {
  const policy = createRunPermissionPolicy({ allowedTools: ['read_file', 'work*', 'docs_search'], disallowedTools: ['glob_*'], knownTools: KNOWN });
  assert.deepEqual(policy.allowedTools, ['docs_search', 'read_file', 'worktree_list'], 'an exact id outside the manifest passes through as written');
  assert.deepEqual(policy.disallowedTools, ['glob_files']);
  assert.equal(policy.isAllowed('worktree_delete'), false, 'a glob never covers a desktop-only tool');
  assert.equal(createRunPermissionPolicy({ allowedTools: ['*'], knownTools: KNOWN }).allowedTools.some((name) => DESKTOP_ONLY_TOOLS.includes(name)), false);
  assert.equal(createRunPermissionPolicy({ allowedTools: ['run_command'], knownTools: KNOWN }).isAllowed('run_command'), true, 'exact name pre-allows');
  const disallowedWins = createRunPermissionPolicy({ allowedTools: ['read_file'], disallowedTools: ['read_*'], knownTools: KNOWN });
  assert.equal(disallowedWins.isAllowed('read_file'), false);
  for (const bad of [['read_(file|dir)'], ['[a-z]+'], ['a b'], ['x'.repeat(129)], 'read_file', [''], Array.from({ length: 65 }, () => 'read_file')]) {
    assert.throws(() => createRunPermissionPolicy({ allowedTools: bad }), (error) => error.code === CLI_ERROR_CODES.INVALID_POLICY);
  }
  assert.throws(() => createRunPermissionPolicy({ permissionMode: 'dangerously-skip' }), (error) => error.reason === 'invalid_permission_mode');
  assert.equal(createRunPermissionPolicy({ permissionMode: 'Plan' }).permissionMode, 'plan');
});

test('the ceiling only narrows: stored auto cannot widen, stored deny keeps its force, desktop-only needs the exact name', () => {
  const cases = [
    // [allowed, disallowed, tool, expected decision under the ceiling]
    [[], [], 'read_file', 'ask', 'a stored auto for a tool the run did not name is ask'],
    [[], [], 'write_file', 'ask', 'a stored auto rule scoped to the tool is still ask'],
    [['write_file'], [], 'write_file', 'auto', 'pre-allowed by exact name'],
    [['*'], [], 'write_file', 'auto', 'pre-allowed by glob'],
    [['*'], [], 'run_command', 'deny', 'a glob never reaches a desktop-only tool even with stored auto'],
    [['run_command'], [], 'run_command', 'auto', 'the exact name does'],
    [['*'], ['write_file'], 'write_file', 'deny', 'disallowed beats allowed'],
    [['edit_file'], [], 'edit_file', 'deny', 'a stored legacy deny survives a run allow'],
    [['grep_search'], [], 'grep_search', 'deny', 'a stored deny rule survives a run allow'],
    [[], [], 'edit_file', 'deny', 'stored legacy deny stays deny'],
  ];
  for (const [allowed, disallowed, tool, expected, why] of cases) {
    const policy = createRunPermissionPolicy({ allowedTools: allowed, disallowedTools: disallowed, knownTools: KNOWN });
    assert.equal(decide(policy.ceilingSnapshot(storedSnapshot()), tool), expected, why);
  }
  const bare = createRunPermissionPolicy({ knownTools: KNOWN }).ceilingSnapshot(storedSnapshot());
  assert.deepEqual(bare.legacy_policies, { read_file: 'ask', write_file: 'ask', run_command: 'deny', edit_file: 'deny' });
  // The only auto left is the decision surface itself (ask_user), which the decider settles.
  assert.deepEqual(bare.rules.filter((rule) => rule.decision === 'auto').map((rule) => rule.id), ['cli-ceiling-allow:ask_user'], JSON.stringify(bare.rules));
  assert.equal(bare.rules.at(-1).id, 'cli-ceiling-ask-all', 'the catch-all ask closes the snapshot');
  assert.equal(bare.version, 3);
  // The blanket stored auto (match: {}) became ask, so an unknown tool is ask, not auto.
  assert.equal(decide(bare, 'docs_search'), 'ask');
});

// Every tool and action the manifest declares, through the real evaluator: the built-in
// defaults (read-only tools and declared read actions are auto on the desktop) never run a
// tool the run did not name.
function manifestVerdicts(policy, stored = { version: 1, legacy_policies: {}, rules: [] }) {
  const snapshot = policy.ceilingSnapshot(stored);
  const verdicts = new Map();
  for (const tool of manifest.tools) {
    const descriptor = { name: tool.name, actions: tool.actions, read_only: tool.read_only, side_effecting: tool.side_effecting };
    const actions = tool.actions && typeof tool.actions === 'object' ? Object.keys(tool.actions) : [null];
    for (const action of actions) {
      const verdict = evaluatePolicy({ descriptor, args: action ? { action } : {}, snapshot });
      verdicts.set(action ? `${tool.name}:${action}` : tool.name, verdict.decision);
    }
  }
  return verdicts;
}

test('under an empty ceiling no manifest tool or action is auto except the decision surface; a run names what runs', () => {
  const empty = manifestVerdicts(createRunPermissionPolicy({}));
  assert.ok(empty.size > 60, `the manifest declares ${empty.size} tool/action pairs`);
  const autos = [...empty].filter(([, decision]) => decision === 'auto').map(([name]) => name);
  assert.deepEqual(autos, ['ask_user'], 'read_file, glob_files, grep_search and every read action used to be auto by default');
  for (const name of DESKTOP_ONLY_TOOLS) assert.equal(empty.get(name), 'deny', name);

  const memoryActions = Object.keys(manifest.tools.find((tool) => tool.name === 'memory').actions);
  assert.ok(memoryActions.includes('recall') && memoryActions.includes('forget'), memoryActions.join(','));
  const named = manifestVerdicts(createRunPermissionPolicy({ allowedTools: ['read_file', 'memory:recall', 'grep_*'], disallowedTools: ['memory:forget'] }));
  assert.equal(named.get('read_file'), 'auto');
  assert.equal(named.get('grep_search'), 'auto', 'a glob over tool ids');
  assert.equal(named.get('memory:recall'), 'auto', 'an action pair pre-allows that action only');
  assert.equal(named.get('memory:forget'), 'deny', 'an action pair disallows that action only');
  for (const action of memoryActions.filter((name) => !['recall', 'forget'].includes(name))) assert.equal(named.get(`memory:${action}`), 'ask', action);
  assert.equal(named.get('write_file'), 'ask');
  assert.equal(named.get('run_command'), 'deny');

  // A whole-tool allow covers its actions; a whole-tool disallow beats an action allow.
  const whole = manifestVerdicts(createRunPermissionPolicy({ allowedTools: ['memory'] }));
  for (const action of memoryActions) assert.equal(whole.get(`memory:${action}`), 'auto', action);
  const beaten = createRunPermissionPolicy({ allowedTools: ['memory:recall'], disallowedTools: ['memory'] });
  assert.deepEqual(beaten.allowedTools, []);
  assert.equal(manifestVerdicts(beaten).get('memory:recall'), 'deny');
  // Globs expand over the manifest's declared actions and never reach a desktop-only tool.
  const glob = createRunPermissionPolicy({ allowedTools: ['memory:*', '*'] });
  assert.ok(glob.allowedTools.includes('memory:recall') && glob.allowedTools.includes('memory'));
  for (const name of DESKTOP_ONLY_TOOLS) assert.equal(glob.allowedTools.includes(name), false, name);
  assert.ok(MANIFEST_SELECTORS.includes('memory:recall'));
  assert.equal(glob.isAllowed('memory', 'recall'), true);
  assert.equal(createRunPermissionPolicy({ allowedTools: ['memory:recall'] }).isAllowed('memory', 'remember'), false);
  assert.equal(createRunPermissionPolicy({ disallowedTools: ['memory:forget'] }).isDisallowed('memory', 'forget'), true);
  assert.equal(createRunPermissionPolicy({ disallowedTools: ['memory'] }).isDisallowed('memory', 'forget'), true);
  assert.throws(() => createRunPermissionPolicy({ allowedTools: ['memory:re(call)'] }), (error) => error.reason === 'invalid_tool_selector');
  assert.throws(() => createRunPermissionPolicy({ allowedTools: ['memory:recall:x'] }), (error) => error.reason === 'invalid_tool_selector');
  // A stored auto scoped to a tool action survives only when the run pre-allows that action.
  const storedAction = { version: 3, legacy_policies: { 'memory:recall': 'auto', 'memory:forget': 'deny' },
    rules: [{ id: 'owner-recall', decision: 'auto', reason: 'owner', match: { tool_id: 'memory', action: 'recall' } }] };
  assert.equal(manifestVerdicts(createRunPermissionPolicy({}), storedAction).get('memory:recall'), 'ask');
  const kept = manifestVerdicts(createRunPermissionPolicy({ allowedTools: ['memory:recall'] }), storedAction);
  assert.equal(kept.get('memory:recall'), 'auto');
  assert.equal(kept.get('memory:forget'), 'deny', 'the legacy action deny is materialized');
  const legacy = createRunPermissionPolicy({ allowedTools: ['memory:recall'] }).ceilingSnapshot(storedAction).legacy_policies;
  assert.deepEqual(legacy, { 'memory:recall': 'auto', 'memory:forget': 'deny' });
});

test('the ceiling store narrows every read path and leaves writes on the real store', () => {
  const calls = [];
  const target = {
    getSnapshot(...args) { calls.push(['getSnapshot', args.length]); return storedSnapshot(); },
    getAllPolicies() { return { read_file: 'auto', write_file: 'ask', run_command: 'auto', edit_file: 'deny' }; },
    getPolicy(name) { return name === 'read_file' ? 'auto' : undefined; },
    setPolicy(name, decision) { calls.push(['setPolicy', name, decision]); return this; },
    cache: 'value',
  };
  const policy = createRunPermissionPolicy({ allowedTools: ['read_file'], knownTools: KNOWN });
  const store = createCeilingPermissionStore(target, policy);
  assert.equal(decide(store.getSnapshot(), 'read_file'), 'auto');
  assert.equal(decide(store.getSnapshot({ root_path: 'C:/w' }), 'write_file'), 'ask');
  assert.deepEqual(calls, [['getSnapshot', 0], ['getSnapshot', 1]], 'arity is preserved: the real store treats an authority argument differently');
  assert.deepEqual(store.getAllPolicies(), { read_file: 'auto', write_file: 'ask', run_command: 'deny', edit_file: 'deny' });
  assert.equal(store.getPolicy('read_file'), 'auto');
  assert.equal(store.getPolicy('other'), undefined);
  assert.equal(store.runPermissionPolicy, policy);
  assert.equal(store.cache, 'value');
  assert.equal(store.setPolicy('read_file', 'deny'), target, 'methods stay bound to the real store');
  assert.throws(() => createCeilingPermissionStore({}, policy), (error) => error.reason === 'invalid_permission_store');
  assert.throws(() => createCeilingPermissionStore(target, {}), (error) => error.reason === 'invalid_run_policy');
});

// A backend stand-in with the real ordering: the approval event is emitted
// before the pending entry exists; questions are pending before their event.
function fakeService() {
  const service = new EventEmitter();
  service.pendingToolApprovals = new Map();
  service.pendingUserQuestions = new Map();
  service.log = [];
  service.approveToolCall = (ref, options) => {
    if (!service.pendingToolApprovals.has(ref)) return false;
    service.log.push(['approve', ref, options]);
    service.pendingToolApprovals.delete(ref);
    return true;
  };
  service.denyToolCall = (ref) => {
    if (!service.pendingToolApprovals.has(ref)) return false;
    service.log.push(['deny', ref]);
    service.pendingToolApprovals.delete(ref);
    return true;
  };
  service.answerUserQuestions = (ref, payload) => {
    if (!service.pendingUserQuestions.has(ref)) return false;
    service.log.push(['answer', ref, payload]);
    service.pendingUserQuestions.delete(ref);
    return true;
  };
  service.declineUserQuestions = (ref) => {
    if (!service.pendingUserQuestions.has(ref)) return false;
    service.log.push(['decline', ref]);
    service.pendingUserQuestions.delete(ref);
    return true;
  };
  service.raiseApproval = (approvalId, toolName, extra = {}) => {
    service.emit('chat-stream', { type: 'tool_approval_needed', approvalId, callId: `call_${approvalId}`, toolName, summary: `${toolName} summary`, input: {}, ...extra });
    service.pendingToolApprovals.set(approvalId, { approvalId, toolName });
  };
  service.raiseQuestions = (questionRef, questions) => {
    service.pendingUserQuestions.set(questionRef, { questionRef });
    service.emit('chat-stream', { type: 'user_questions_requested', questionRef, questionId: `q_${questionRef}`, callId: `call_${questionRef}`, questions });
  };
  return service;
}

const settled = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

test('headless: every request is settled closed once its pending entry exists, and each decision frame is cli.v1', async () => {
  const service = fakeService();
  const decisions = [];
  const logs = [];
  const policy = createRunPermissionPolicy({ disallowedTools: ['glob_files'], knownTools: KNOWN });
  const decider = createHeadlessDecider({ service, policy, onDecision: (payload) => decisions.push(payload), logger: (level, event, data) => logs.push({ level, event, data }) });
  service.raiseApproval('ap_1', 'write_file');
  assert.deepEqual(service.log, [], 'the denial waits for the pending entry');
  await settled();
  assert.deepEqual(service.log, [['deny', 'ap_1']]);
  service.raiseApproval('ap_2', 'glob_files');
  service.raiseApproval('ap_3', 'run_command');
  service.raiseApproval('ap_4', 'exit_plan_mode', { plan: { title: 'A plan' } });
  service.raiseQuestions('qr_1', [{ id: 'q1', text: 'Which?' }]);
  await settled();
  // Questions are pending before their event, so the decline is immediate; approvals wait a tick.
  assert.deepEqual(service.log.slice(1), [['decline', 'qr_1'], ['deny', 'ap_2'], ['deny', 'ap_3'], ['deny', 'ap_4']]);
  assert.deepEqual(decisions.map((d) => [d.ref, d.request, d.outcome, d.by, d.rule, d.tool_name]), [
    ['ap_1', 'tool_approval', 'deny', 'policy', 'not_pre_allowed', 'write_file'],
    ['qr_1', 'user_questions', 'decline', 'policy', 'non_interactive', 'ask_user'],
    ['ap_2', 'tool_approval', 'deny', 'policy', 'disallowed_tools', 'glob_files'],
    ['ap_3', 'tool_approval', 'deny', 'policy', 'desktop_only_tool', 'run_command'],
    ['ap_4', 'plan_proposal', 'deny', 'policy', 'plan_requires_human', 'exit_plan_mode'],
  ]);
  for (const payload of decisions) assert.ok(validateDecision(payload), JSON.stringify(validateDecision.errors));
  assert.equal(service.pendingToolApprovals.size + service.pendingUserQuestions.size, 0);

  // An approval withdrawn before it was ever recorded is dropped and logged, never denied twice.
  service.emit('chat-stream', { type: 'tool_approval_needed', approvalId: 'ap_gone', callId: 'c', toolName: 'write_file' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(logs.some((entry) => entry.event === 'cli.decision_never_pending' && entry.data.ref === 'ap_gone'), JSON.stringify(logs));
  assert.equal(decisions.length, 5);

  decider.dispose();
  service.raiseApproval('ap_after', 'write_file');
  await settled();
  assert.equal(service.pendingToolApprovals.has('ap_after'), true, 'a disposed decider decides nothing');
  assert.equal(service.listenerCount('chat-stream'), 0);
  assert.throws(() => createHeadlessDecider({ service: {} }), TypeError);
});

test('tty: prompts once per request, approves once without alwaysAllow, remembers "allow for this run" in memory only', async () => {
  const service = fakeService();
  const decisions = [];
  const prompts = [];
  const answers = [];
  const ask = async (request, { signal }) => {
    prompts.push(request);
    const next = answers.shift();
    if (typeof next === 'function') return next(signal);
    return next;
  };
  const decider = createTtyDecider({ service, ask, onDecision: (payload) => decisions.push(payload) });
  assert.throws(() => createTtyDecider({ service }), /ask port/u);

  answers.push('allow');
  service.raiseApproval('ap_1', 'write_file');
  await settled();
  assert.deepEqual(service.log, [['approve', 'ap_1', {}]], 'once only: no alwaysAllow, no decision option');
  assert.deepEqual(prompts.map((p) => [p.kind, p.toolName, p.ref]), [['tool_approval', 'write_file', 'ap_1']]);

  answers.push('allow_run');
  service.raiseApproval('ap_2', 'edit_file');
  await settled();
  service.raiseApproval('ap_3', 'edit_file');
  await settled();
  assert.deepEqual(service.log.slice(1), [['approve', 'ap_2', {}], ['approve', 'ap_3', {}]]);
  assert.equal(prompts.length, 2, 'the second edit_file did not prompt');
  assert.deepEqual(decider.allowedThisRun(), ['edit_file']);

  answers.push('deny', 'garbage', { q1: 'b' }, null);
  service.raiseApproval('ap_4', 'write_file');
  service.raiseApproval('ap_5', 'write_file');
  service.raiseQuestions('qr_1', [{ id: 'q1', text: 'Which?' }]);
  service.raiseQuestions('qr_2', [{ id: 'q1', text: 'Which?' }]);
  await settled();
  await settled();
  assert.deepEqual(service.log.slice(3), [['deny', 'ap_4'], ['deny', 'ap_5'], ['answer', 'qr_1', { q1: 'b' }], ['decline', 'qr_2']]);
  assert.deepEqual(decisions.map((d) => [d.ref, d.request, d.outcome, d.by, d.rule]), [
    ['ap_1', 'tool_approval', 'allow', 'user', 'user_allowed_once'],
    ['ap_2', 'tool_approval', 'allow', 'user', 'allowed_this_run'],
    ['ap_3', 'tool_approval', 'allow', 'user', 'allowed_this_run'],
    ['ap_4', 'tool_approval', 'deny', 'user', 'user_denied'],
    ['ap_5', 'tool_approval', 'deny', 'user', 'user_denied'],
    ['qr_1', 'user_questions', 'answer', 'user', undefined],
    ['qr_2', 'user_questions', 'decline', 'user', 'user_declined'],
  ]);
  for (const payload of decisions) assert.ok(validateDecision(payload), JSON.stringify(validateDecision.errors));

  // A plan never joins the run allow-list, and a withdrawn request aborts its prompt.
  answers.push('allow_run');
  service.raiseApproval('ap_6', 'exit_plan_mode', { plan: { title: 'P' } });
  await settled();
  assert.deepEqual(decider.allowedThisRun(), ['edit_file']);
  let aborted = false;
  answers.push((signal) => new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve('allow'); }); }));
  service.raiseApproval('ap_7', 'write_file');
  await settled();
  service.pendingToolApprovals.delete('ap_7');
  service.emit('chat-stream', { type: 'tool_approval_withdrawn', approvalId: 'ap_7', callId: 'call_ap_7', toolName: 'write_file' });
  await settled();
  assert.equal(aborted, true);
  assert.equal(service.log.some((row) => row[1] === 'ap_7'), false, 'a withdrawn approval is never approved');
  decider.dispose();
  assert.equal(service.listenerCount('chat-stream'), 0);
});

test('headless: the denial rule names the action the request carried', async () => {
  const service = fakeService();
  const decisions = [];
  const policy = createRunPermissionPolicy({ disallowedTools: ['memory:forget'], knownTools: KNOWN });
  const headless = createHeadlessDecider({ service, policy, onDecision: (payload) => decisions.push(payload) });
  service.raiseApproval('ap_f', 'memory', { input: { action: 'forget' } });
  service.raiseApproval('ap_r', 'memory', { input: { action: 'recall' } });
  await settled();
  assert.deepEqual(decisions.map((d) => [d.ref, d.rule]), [['ap_f', 'disallowed_tools'], ['ap_r', 'not_pre_allowed']]);
  headless.dispose();
});

test('tty: a one-off-only request is prompted even when the tool is allowed for the run, and never joins the list', async () => {
  const service = fakeService();
  const prompts = [];
  const decisions = [];
  const answers = ['allow_run', 'allow_run', 'allow'];
  const decider = createTtyDecider({ service, ask: async (request) => { prompts.push(request); return answers.shift(); },
    onDecision: (payload) => decisions.push(payload) });
  service.raiseApproval('ap_1', 'session_message');
  await settled();
  assert.deepEqual(decider.allowedThisRun(), ['session_message'], 'without the one-off mark the run allow-list learns the tool');
  service.raiseApproval('ap_2', 'session_message', { oneOffOnly: true });
  await settled();
  assert.equal(prompts.length, 2, 'the one-off request prompted despite the run allow');
  assert.equal(prompts[1].one_off_only, true);
  assert.deepEqual(decisions.map((d) => [d.ref, d.outcome, d.rule]), [['ap_1', 'allow', 'allowed_this_run'], ['ap_2', 'allow', 'user_allowed_once']]);
  assert.deepEqual(service.log, [['approve', 'ap_1', {}], ['approve', 'ap_2', {}]]);
  decider.dispose();
});

test('a real non-TTY run: write_file outside the ceiling is denied by policy and nothing is written', { timeout: 80_000 }, async (t) => {
  const artifacts = path.join(ROOT, 'artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, 'cli-policy-'));
  t.after(() => removeTreeSync(root));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const script = path.join(root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'out.txt', content: 'should not land' } }] },
    { text: 'Tried to write.' },
  ] }));
  const prior = process.env.JENNY_REPLAY_SCRIPT;
  process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (prior === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = prior; });

  const logs = [];
  t.after(() => { if (logs.length) t.diagnostic(JSON.stringify(logs.filter((entry) => /error|fail|deny|denied/iu.test(JSON.stringify(entry))).slice(-12))); });
  async function run(permissions, profile) {
    const host = createCliHost({ profilePath: profile, workspaceRoot: workspace, repoRoot: ROOT, pythonExecutable: PYTHON,
      engine: { type: 'replay', model: 'replay-model' }, permissions, logger: (level, event, data) => logs.push({ level, event, data }) });
    const { backend, runPolicy, permissionStore, storedPermissionStore } = hostComposition(host);
    const decisions = [];
    const events = [];
    const decider = createHeadlessDecider({ service: backend, policy: runPolicy, onDecision: (payload) => decisions.push(payload) });
    const pump = (async () => { for await (const event of host.events()) events.push(event); })();
    try {
      await host.start();
      const { session_id: sessionId } = await host.createSession({ title: 'ceiling' });
      const sent = await host.submit({ session_id: sessionId, prompt: 'Write out.txt', idempotency_key: `cli_policy_${decisions.length}` });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      const work = await host.waitForWork(sent.work_id, { timeoutMs: 45_000 });
      const results = backend.sessionStore.getSession(sessionId).turn_events.filter((row) => row.kind === 'tool_result');
      return { work, decisions, events, results, storedPermissionStore, permissionStore };
    } finally {
      decider.dispose();
      await host.close();
      await pump;
    }
  }

  const denied = await run({ allowedTools: ['read_file'] }, path.join(root, 'profile-denied'));
  // A policy denial ends the turn: the stream's terminal status is `denied`
  // (exit code 3 through the aggregator) and the work record is failed.
  assert.equal(denied.work.status, 'failed', JSON.stringify(denied.work));
  const terminal = denied.events.filter((event) => ['complete', 'error'].includes(event.type));
  assert.equal(terminal.length, 1, JSON.stringify(denied.events.map((e) => e.type)));
  assert.equal(terminal[0].status, 'denied', JSON.stringify(terminal[0]));
  assert.equal(fs.existsSync(path.join(workspace, 'out.txt')), false, 'the denied write never landed');
  assert.deepEqual(denied.decisions.map((d) => [d.request, d.outcome, d.by, d.rule, d.tool_name]),
    [['tool_approval', 'deny', 'policy', 'not_pre_allowed', 'write_file']]);
  assert.ok(denied.events.some((event) => event.type === 'tool_approval_needed'), JSON.stringify(denied.events.map((e) => e.type)));
  assert.deepEqual(denied.results.map((row) => [row.payload.tool_name, row.payload.is_error, row.payload.approval_state || row.payload.approvalState || row.payload.metadata?.terminal_state]),
    [['write_file', true, 'denied']], JSON.stringify(denied.results));
  const persisted = (store) => {
    const { policies, rules, scoped_grants: grants } = store.listStoredDecisions();
    return { policies, rules, grants };
  };
  assert.deepEqual(persisted(denied.storedPermissionStore), { policies: {}, rules: [], grants: [] }, 'nothing was persisted by the run');

  const allowed = await run({ allowedTools: ['write_file'] }, path.join(root, 'profile-allowed'));
  assert.equal(allowed.work.status, 'completed', JSON.stringify(allowed.work));
  assert.equal(fs.readFileSync(path.join(workspace, 'out.txt'), 'utf8'), 'should not land');
  assert.deepEqual(allowed.decisions, [], 'a pre-allowed tool never reaches the ask path');
  assert.deepEqual(allowed.results.map((row) => [row.payload.tool_name, row.payload.success]), [['write_file', true]]);
  assert.deepEqual(persisted(allowed.storedPermissionStore), { policies: {}, rules: [], grants: [] });
});
