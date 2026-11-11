'use strict';

/* Row 87 S3: where the Jenny chat's deny rules apply. The approval path refuses a stop, settings change or
 * scheduled-check change before any card; each tool refuses again at execute; a launch deny refuses
 * propose_session before any record, offer or grant. A missing or throwing matcher denies nothing. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { actionRuleDenial, sessionRunMode } = require('../services/backend/action-rule-gate');
const { RULE_DENIED_MESSAGE } = require('../services/primary-action-rules');
const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createSessionFixture } = require('./helpers/chat-proposal-session-fixture');
const { publishProposal } = require('../services/tools/builtin/propose-tool-support');
const stopTool = require('../services/tools/builtin/session-stop-tool');
const settingsTool = require('../services/tools/builtin/settings-change-tool');
const scheduleTool = require('../services/tools/builtin/schedule-change-tool');

const RULE = `ar_${'b'.repeat(32)}`;

function matcher(deny = true) {
  const calls = [];
  return { calls, denial: (args) => { calls.push(args); return deny ? { effect: 'deny', rule_id: RULE } : null; } };
}

test('gate: maps the three tools to their actions, reads the run mode and targets a stop at its chat', () => {
  const rules = matcher();
  const service = { primaryActionRules: rules, sessionStore: { getSessionSummary: () => ({ run_mode: 'Auto', plan_mode: false }) } };
  assert.deepEqual(actionRuleDenial(service, { toolName: 'session_stop', sessionId: 'p', turnId: 't', input: { session_id: ' c ' } }),
    { effect: 'deny', rule_id: RULE });
  assert.deepEqual(rules.calls[0], { action: 'stop', sessionId: 'p', turnId: 't', target: { session_id: 'c' }, runMode: 'auto' });
  actionRuleDenial(service, { toolName: 'settings_change', sessionId: 'p', input: { session_id: 'ignored' } });
  assert.deepEqual(rules.calls[1].target, {}, 'only a stop has a chat target');
  assert.equal(sessionRunMode({ sessionStore: { getSessionSummary: () => ({ run_mode: 'auto', plan_mode: true }) } }, 'p'), 'plan');
  assert.equal(sessionRunMode({}, 'p'), null);
  assert.equal(sessionRunMode({ sessionStore: { getSessionSummary: () => { throw new Error('x'); } } }, 'p'), null);
});

test('gate: other tools, a missing or throwing matcher and a missing caller deny nothing', () => {
  const rules = matcher();
  assert.equal(actionRuleDenial({ primaryActionRules: rules }, { toolName: 'session_message', sessionId: 'p' }), null);
  assert.equal(actionRuleDenial({ primaryActionRules: rules }, { toolName: 'run_command', sessionId: 'p' }), null);
  assert.equal(rules.calls.length, 0);
  assert.equal(actionRuleDenial({}, { toolName: 'session_stop', sessionId: 'p' }), null);
  assert.equal(actionRuleDenial({ primaryActionRules: rules }, { toolName: 'session_stop', sessionId: '' }), null);
  const throwing = { primaryActionRules: { denial: () => { throw new Error('boom'); } } };
  assert.equal(actionRuleDenial(throwing, { toolName: 'session_stop', sessionId: 'p' }), null);
  assert.equal(actionRuleDenial({ primaryActionRules: matcher(false) }, { toolName: 'session_stop', sessionId: 'p' }), null);
});

function approvalService(rules) {
  const emitted = [];
  const messages = [];
  const service = {
    primaryActionRules: rules,
    sessionStore: {
      appendMessage: (_sessionId, message) => messages.push(message), updateMessage() {},
      getSessionSummary: () => ({ run_mode: 'ask' }),
    },
    getSessionDirectory: () => ({ digest: async () => ({ ok: true, session: { title: 'Beta', status: 'idle' } }) }),
    emit: (_channel, payload) => emitted.push(payload), pendingToolApprovals: new Map(), currentModel: 'm',
  };
  return { service, emitted, messages };
}

for (const [toolName, input] of [
  ['session_stop', { session_id: 'sess_beta' }],
  ['settings_change', { changes: [{ key: 'time_format_24h', value: true }], purpose: 'x' }],
  ['schedule_change', { action: 'cancel', reminder_id: 'r1', purpose: 'x' }],
]) {
  test(`approval: a deny rule refuses ${toolName} before any card, with the plain reason in the transcript`, async () => {
    const { service, emitted, messages } = approvalService(matcher());
    const collector = new CanonicalTurnEventCollector({ turnId: 'turn-1', sessionId: 'sess_primary' });
    const approved = await waitForToolApproval(service, 'stream-1', 'sess_primary', 'req-1', {
      tool_name: toolName, tool_call_id: 'call-1', tool_input: input,
    }, new AbortController(), collector);
    assert.deepEqual(approved, { approved: false, decision: 'app_refused', feedback: RULE_DENIED_MESSAGE });
    assert.equal(service.pendingToolApprovals.size, 0);
    assert.equal(emitted.some((event) => event.type === 'tool_approval_needed'), false, 'no card');
    const result = emitted.find((event) => event.type === 'tool_result');
    assert.equal(result.content, RULE_DENIED_MESSAGE);
    assert.equal(result.approvalState, 'denied');
    assert.ok(messages.some((row) => row.kind === 'tool_result' && row.tool_result?.output_text === RULE_DENIED_MESSAGE
      && row.tool_result?.metadata?.rule_denied === true && row.tool_result?.approval_state === 'denied'));
  });
}

test('approval: without a deny match the card is shown as before', async () => {
  const { service, emitted } = approvalService(matcher(false));
  const controller = new AbortController();
  const done = waitForToolApproval(service, 'stream-2', 'sess_primary', 'req-2', {
    tool_name: 'session_stop', tool_call_id: 'call-2', tool_input: { session_id: 'sess_beta' },
  }, controller, new CanonicalTurnEventCollector({ turnId: 'turn-2', sessionId: 'sess_primary' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.some((event) => event.type === 'tool_approval_needed'), true);
  [...service.pendingToolApprovals.values()][0].resolve(false, 'denied');
  assert.equal(await done, false);
});

// ---------- execute-time refusals ----------

function liveContext(extra) {
  const project = { project_id: 'project_a', root_path: os.tmpdir(), root_id: 'root', root_revision: 1, device_id: 'device', inode: 'inode' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (captured) => captured,
      _sessionStore: { getSessionSummary: () => ({ id: 'caller', run_mode: 'ask', plan_mode: false }) } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('caller', { requestId: 'stream', mode: 'assist', approvalMode: 'ask' });
  const rules = matcher();
  const backendService = {
    sessionExecutionAuthority: authority, primaryActionRules: rules,
    sessionStore: {
      getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }),
      getSessionSummary: () => ({ run_mode: 'ask' }),
    },
  };
  const ported = { called: 0 };
  return {
    rules, ported,
    context: {
      sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation', callId: 'call-1',
      backendService, executionAuthority, mode: 'ask', abortSignal: new AbortController().signal,
      primarySettingsService: { change: async () => { ported.called += 1; return { ok: true }; } },
      primaryScheduleService: { change: async () => { ported.called += 1; return { ok: true }; } },
      sessionDirectoryService: { stop: async () => { ported.called += 1; return { ok: true }; } },
      ...extra,
    },
  };
}

for (const [name, tool, input] of [
  ['session_stop', stopTool, { session_id: 'sess_beta' }],
  ['settings_change', settingsTool, { changes: [{ key: 'time_format_24h', value: true }], purpose: 'Use 24 hours.' }],
  ['schedule_change', scheduleTool, { action: 'cancel', reminder_id: 'r1', purpose: 'Stop it.' }],
]) {
  test(`execute: ${name} refuses under a deny rule and never reaches its port`, async () => {
    const { context, rules, ported } = liveContext();
    const result = await tool.execute(input, context);
    const value = JSON.parse(result.content);
    assert.deepEqual([value.ok, value.reason, value.message], [false, 'rule_denied', RULE_DENIED_MESSAGE]);
    assert.equal(ported.called, 0);
    assert.equal(rules.calls[0].sessionId, 'caller');
    assert.equal(rules.calls[0].turnId, 'turn');
    context.backendService.primaryActionRules = matcher(false);
    await tool.execute(input, context);
    assert.equal(ported.called, 1, 'without a deny rule the port runs');
  });
}

// ---------- propose_session launch ----------

test('launch: a deny rule refuses before any record, offer or grant; the model reads the plain reason', async (t) => {
  const calls = [];
  const fx = createSessionFixture(t, { serviceOptions: {
    launchDenied: (args) => { calls.push(args); return true; },
    matchLaunchPermission: () => ({ permission_id: `lp_${'a'.repeat(32)}`, max_children_per_turn: 1 }),
  } });
  const done = await fx.publishSession(1, { initiation: 'user_asked' });
  assert.deepEqual([done.ok, done.reason], [false, 'rule_denied']);
  assert.deepEqual(calls, [{ sessionId: fx.sessionId, turnId: 'turn_1', destinationProjectId: 'proj_1', runMode: 'ask' }]);
  assert.equal(fx.grants().length, 0, 'the standing permission was not spent');
  const offer = await fx.publishSession(2, { initiation: 'offer' });
  assert.deepEqual([offer.ok, offer.reason], [false, 'rule_denied'], 'an offer is refused too');
  const projected = await publishProposal('propose_session', { kind: 'session', summary: 's' }, {}, {},
    { sessionId: 's', incarnation: 'i', turnId: 't' }, { callId: 'c', backendService: { chatProposals: { publish: async () => done } } });
  assert.equal(projected.isError, true);
  assert.match(projected.content, /did not record a proposal\. Refused by a standing rule/);
});

test('launch: no rule, or a throwing port, publishes as before', async (t) => {
  const fx = createSessionFixture(t, { serviceOptions: { launchDenied: () => false } });
  assert.equal((await fx.publishSession(1, { initiation: 'offer' })).ok, true);
  const throwing = createSessionFixture(t, { serviceOptions: { launchDenied: () => { throw new Error('boom'); } } });
  assert.equal((await throwing.publishSession(1, { initiation: 'offer' })).ok, true);
});
