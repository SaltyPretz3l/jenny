'use strict';

/* Row 87 slice S2 (plan docs/plans/PRIMARY_ACTION_RULES_2026-10-27.md D3-D6): the Jenny chat's
 * per-action rules on `session_message`. The tool's rule decision (deny / ask / allow / fallback to
 * the card), the `rule` authorization kind in the agent ops (live re-check, 60-per-day cap, persisted
 * as an ordinary agent_once with its body hash), the delivery-time re-check, and the card's
 * "Always for my linked chats" offer on the approval path. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const tool = require('../services/tools/builtin/session-message-tool');
const protocol = require('../services/session-runtime/inference-protocol');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { RULE_DENIED_MESSAGE } = require('../services/primary-action-rules');
const { argsSha256 } = require('../services/backend/coordination-receipts');
const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { approveToolCall, denyToolCall } = require('../services/backend/backend-chat-stream');
const { MESSAGE_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');

const RULE_ID = `ar_${'1'.repeat(32)}`;
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const DESTINATION = { session_id: 'dest', title: 'Recipient', project_label: null };
const V = { schema_version: 1 };
const DAY = 24 * 60 * 60 * 1000;

// ---------- the tool's rule decision ----------

function toolHarness({ rule = null, grant = null, sends = [], authorize } = {}) {
  const project = { project_id: 'project', root_path: os.tmpdir(), root_id: 'root', root_revision: 1, device_id: 'device', inode: 'inode' };
  const summary = { id: 'source', run_mode: 'auto', plan_mode: false };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (captured) => captured, _sessionStore: { getSessionSummary: () => summary } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('source', { requestId: 'stream', mode: 'assist', approvalMode: 'auto' });
  const client = { process: {} };
  protocol.completeRuntimeInferenceInitialization(client, protocol.beginRuntimeInferenceInitialization(client), {
    runtime_inference_admission_version: 1, chat_workspace_version: 1,
    chat_workspace_capabilities: { schema_version: 1, producer_tools: [], context_kinds: ['session_message'], session_messages: true },
  });
  const calls = { match: [], send: [], cancel: [], denied: [], asked: [] };
  const replies = [...sends];
  const service = {
    sidecarClient: client, sessionExecutionAuthority: authority,
    sessionStore: {
      getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }),
      getSessionSummary: (id) => (id === 'source' ? summary : null),
    },
    primaryActionRules: { match(args) { calls.match.push(args); return rule; } },
    primaryChatControls: { recordRuleDenied(id) { calls.denied.push(id); } },
    chatMessages: {
      async agentPrepare() { return { ok: true, operation_id: OPERATION_ID, envelope_sha256: 'a'.repeat(64), state: 'prepared', created: true, grant, destination: DESTINATION }; },
      async agentSend(args) { calls.send.push(args); return replies.shift() || { ok: true, operation: { state: 'delivered' } }; },
      async agentCancel(args) { calls.cancel.push(args); return { ok: true }; },
    },
  };
  const context = { sessionId: 'source', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation', callId: 'call',
    backendService: service, executionAuthority, mode: 'auto', abortSignal: new AbortController().signal,
    authorize: authorize || (async (request) => { calls.asked.push(request); return { approved: true, consent_event_id: 'approval_1' }; }) };
  return { context, calls };
}

const send = (context) => tool.execute({ action: 'send', destination_session_id: 'dest', body: 'hello' }, context).then((result) => JSON.parse(result.content));

test('a deny rule refuses with no card, cancels the prepared send and records the denial', async () => {
  const { context, calls } = toolHarness({ rule: { effect: 'deny', rule_id: RULE_ID }, grant: { grant_id: 'grant' } });
  assert.deepEqual(await send(context), { ok: false, reason: 'rule_denied', message: RULE_DENIED_MESSAGE });
  assert.deepEqual(calls.match, [{ action: 'message', sessionId: 'source', turnId: 'turn', target: { session_id: 'dest' }, runMode: 'auto' }]);
  assert.deepEqual(calls.asked, [], 'no card');
  assert.deepEqual(calls.send, [], 'nothing sent, not even under the live grant');
  assert.deepEqual(calls.cancel, [{ sourceSessionId: 'source', operationId: OPERATION_ID }]);
  assert.deepEqual(calls.denied, [RULE_ID]);
});

test('an ask rule shows the exact-content card even with a live grant', async () => {
  const { context, calls } = toolHarness({ rule: { effect: 'ask', rule_id: RULE_ID }, grant: { grant_id: 'grant' } });
  assert.equal((await send(context)).ok, true);
  assert.equal(calls.asked.length, 1);
  assert.equal(calls.asked[0].messageFields.session_message_approval.body, 'hello');
  assert.deepEqual(calls.send.map((args) => args.authorization), [{ kind: 'once', consent_event_id: 'approval_1' }]);
});

test('an allow rule sends with no card; a live grant still wins', async () => {
  const ruled = toolHarness({ rule: { effect: 'allow', rule_id: RULE_ID } });
  assert.equal((await send(ruled.context)).ok, true);
  assert.deepEqual(ruled.calls.asked, []);
  assert.deepEqual(ruled.calls.send.map((args) => args.authorization), [{ kind: 'rule', rule_id: RULE_ID }]);
  const granted = toolHarness({ rule: { effect: 'allow', rule_id: RULE_ID }, grant: { grant_id: 'grant' } });
  assert.equal((await send(granted.context)).ok, true);
  assert.deepEqual(granted.calls.send.map((args) => args.authorization), [{ kind: 'grant', grant_id: 'grant' }]);
});

for (const reason of ['rule_cap_reached', 'rule_not_live']) {
  test(`an allow rule refused at accept (${reason}) falls back to the card for the same operation`, async () => {
    const { context, calls } = toolHarness({ rule: { effect: 'allow', rule_id: RULE_ID }, sends: [{ ok: false, reason }] });
    assert.equal((await send(context)).ok, true);
    assert.equal(calls.asked.length, 1, 'the card asked once');
    assert.equal(calls.asked[0].messageFields.session_message_approval.operation_id, OPERATION_ID);
    assert.deepEqual(calls.send.map((args) => [args.operationId, args.authorization.kind]), [[OPERATION_ID, 'rule'], [OPERATION_ID, 'once']]);
    assert.deepEqual(calls.cancel, []);
  });
}

test('an allow rule refused for another reason reports it without asking', async () => {
  const { context, calls } = toolHarness({ rule: { effect: 'allow', rule_id: RULE_ID }, sends: [{ ok: false, reason: 'recipient_archived' }] });
  assert.equal((await send(context)).reason, 'recipient_archived');
  assert.deepEqual(calls.asked, []);
});

test('a throwing matcher or no matcher keeps the ordinary card', async () => {
  const { context, calls } = toolHarness();
  context.backendService.primaryActionRules = { match() { throw new Error('boom'); } };
  assert.equal((await send(context)).ok, true);
  assert.equal(calls.asked.length, 1);
  delete context.backendService.primaryActionRules;
  assert.equal((await send(context)).ok, true);
  assert.equal(calls.asked.length, 2);
});

// ---------- the `rule` authorization kind ----------

function agentSetup(t) {
  const f = createFixture(t);
  const live = new Set([RULE_ID]);
  f.backend.primaryActionRules = { isLive: (id) => live.has(id) };
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest', { projectId: 'project_a' });
  const inc = f.store.getSession(src).session_incarnation;
  let call = 0;
  const prepare = (turnId = 'turn_1') => f.service.agentPrepare({
    sourceSessionId: src, sourceIncarnation: inc, turnId, toolCallId: `call_${call += 1}`, destinationSessionId: dst, body: 'Status, please.',
  });
  const sendRule = (operationId, ruleId = RULE_ID) => f.service.agentSend({ sourceSessionId: src, operationId, authorization: { kind: 'rule', rule_id: ruleId } });
  return { f, live, src, dst, prepare, sendRule };
}

test('a rule send persists an ordinary agent_once with the rule consent id and the body hash', async (t) => {
  const { f, src, dst, prepare, sendRule } = agentSetup(t);
  const prepared = await prepare();
  const sent = await sendRule(prepared.operation_id);
  assert.equal(sent.ok, true);
  assert.equal(sent.operation.state, 'delivered');
  const [op] = f.mail(src).outbox;
  const [auth] = f.mail(src).authorizations;
  assert.equal(auth.kind, 'agent_once');
  assert.equal(auth.consent_event_id, `rule:${RULE_ID}`);
  assert.equal(auth.operation_id, op.operation_id);
  assert.equal(auth.body_sha256, op.envelope.body_sha256);
  assert.equal(op.authorization_id, auth.authorization_id);
  assert.equal(f.mail(dst).inbox[0].envelope.body, 'Status, please.', 'the exact content is delivered and kept');
  const receipt = f.store.getSession(src).coordination_receipts.at(-1);
  assert.equal(receipt.args_sha256, argsSha256({ operation_id: op.operation_id, authorization_kind: 'rule', authorization_id: auth.authorization_id }));
});

test('a rule that is not live at accept aborts rule_not_live and leaves the operation prepared', async (t) => {
  const { f, live, src, prepare, sendRule } = agentSetup(t);
  const prepared = await prepare();
  live.clear();
  const refused = await sendRule(prepared.operation_id);
  assert.equal(refused.reason, 'rule_not_live');
  assert.equal(refused.error_code, CODES.AUTHORIZATION_REQUIRED);
  assert.equal(f.mail(src).outbox[0].state, 'prepared');
  assert.equal(f.mail(src).authorizations.length, 0);
  delete f.backend.primaryActionRules;
  live.add(RULE_ID);
  assert.equal((await sendRule(prepared.operation_id)).reason, 'rule_not_live', 'no port fails closed');
});

test('a malformed rule authorization, or a one-off consent in the rule namespace, is invalid', async (t) => {
  const { f, src, prepare } = agentSetup(t);
  const prepared = await prepare();
  for (const authorization of [{ kind: 'rule', rule_id: 'ar_short' }, { kind: 'rule', rule_id: RULE_ID, extra: 1 },
    { kind: 'rule' }, { kind: 'once', consent_event_id: `rule:${RULE_ID}` }]) {
    const refused = await f.service.agentSend({ sourceSessionId: src, operationId: prepared.operation_id, authorization });
    assert.equal(refused.reason, 'invalid_request', JSON.stringify(authorization));
  }
});

test('the 61st rule send within 24 hours aborts rule_cap_reached; the window rolls', async (t) => {
  const { f, live, src, prepare, sendRule } = agentSetup(t);
  for (let n = 0; n < 60; n += 1) {
    const prepared = await prepare(`turn_${Math.floor(n / 8)}`);
    assert.equal((await sendRule(prepared.operation_id)).ok, true, `send ${n + 1}`);
  }
  const over = await prepare('turn_over');
  const capped = await sendRule(over.operation_id);
  assert.equal(capped.reason, 'rule_cap_reached');
  assert.equal(f.mail(src).outbox.find((op) => op.operation_id === over.operation_id).state, 'prepared');
  const otherRule = `ar_${'2'.repeat(32)}`;
  const other = await prepare('turn_other');
  // The cap is per rule: another live rule still sends.
  live.add(otherRule);
  assert.equal((await sendRule(other.operation_id, otherRule)).ok, true);
  assert.equal((await f.service.agentSend({ sourceSessionId: src, operationId: over.operation_id,
    authorization: { kind: 'once', consent_event_id: 'approval_x' } })).ok, true, 'the card path still sends');
  f.advance(DAY + 1);
  const later = await prepare('turn_later');
  assert.equal((await sendRule(later.operation_id)).ok, true, 'the rolling day reopened the rule');
});

test('a pending rule send fails authorization_revoked at delivery once the rule is no longer live', async (t) => {
  const { f, live, src, dst, prepare, sendRule } = agentSetup(t);
  const prepared = await prepare();
  f.failFlush(dst, 1);
  assert.equal((await sendRule(prepared.operation_id)).reason, 'persistence_failure');
  assert.equal(f.mail(src).outbox[0].state, 'pending');
  live.clear();
  assert.equal((await f.service.retry({ ...V, operation_id: prepared.operation_id })).ok, true);
  const [op] = f.mail(src).outbox;
  assert.equal(op.state, 'failed');
  assert.equal(op.last_error.reason, 'authorization_revoked');
  assert.equal(f.mail(dst).inbox.length, 0, 'nothing was delivered');
});

// ---------- the card's "Always for my linked chats" offer ----------

function approvalHarness({ enabled = true, primary = 'primary', parent = 'primary', addFails = false, covering = null } = {}) {
  const added = [];
  const events = [];
  const service = {
    sessionStore: {
      getSessionMessages: () => [], appendMessage() {}, updateMessage() {},
      getSessionSummary: (id) => (id === 'child' ? { id, spawned_from: parent ? { parent_session_id: parent } : null } : null),
    },
    primaryChatControls: {
      isPrimary: (id) => id === primary, actionRulesEnabled: () => enabled,
      addActionRule(rule) { added.push(rule); if (addFails) throw new Error('store'); return { ok: true }; },
    },
    primaryActionRules: { match: () => covering },
    emit: (_name, event) => events.push(event), _emitServiceLog() {}, pendingToolApprovals: new Map(), currentModel: 'model',
  };
  const start = (sessionId = 'primary', destination = 'child', callId = 'call_msg') => waitForToolApproval(service, 'stream', sessionId, 'req', {
    tool_name: 'session_message', tool_call_id: callId, tool_input: { action: 'send', destination_session_id: destination, body: 'hi' },
    messageFields: { session_message_approval: { schema_version: 1, operation_id: OPERATION_ID, envelope_sha256: 'b'.repeat(64), body: 'hi',
      destination: { session_id: destination, title: 'Child', project_label: null }, one_off_only: true } },
  }, new AbortController());
  const pending = () => [...service.pendingToolApprovals.values()][0];
  const needed = () => events.find((event) => event.type === 'tool_approval_needed');
  return { service, added, start, pending, needed };
}

const LINKED_RULE = { action: 'message', target: { kind: 'linked_children' }, effect: 'allow' };

test('the offer appears only for a primary-to-linked-child card with rules on', async () => {
  const offered = approvalHarness();
  const waiting = offered.start();
  assert.equal(offered.needed().rememberOffer, 'linked_children');
  assert.equal(offered.pending().rememberOffer, 'linked_children');
  denyToolCall(offered.service, offered.pending().approvalId);
  assert.equal((await waiting).approved, false);
  for (const [label, options, args] of [['rules off', { enabled: false }, []], ['not the primary', { primary: 'other' }, []],
    ['unlinked destination', { parent: 'someone' }, []], ['no parent', { parent: null }, []], ['another destination', {}, ['primary', 'stranger']],
    ['an ask rule already covers it', { covering: { effect: 'ask', rule_id: 'r' } }, []], ['a deny rule already covers it', { covering: { effect: 'deny', rule_id: 'r' } }, []]]) {
    const h = approvalHarness(options);
    const promise = h.start(...args);
    assert.equal(h.needed().rememberOffer, undefined, label);
    assert.equal(h.pending().rememberOffer, undefined, label);
    approveToolCall(h.service, h.pending().approvalId, { remember: 'linked_children' });
    assert.equal((await promise).approved, true, label);
    assert.deepEqual(h.added, [], `${label}: no rule without an offer`);
  }
});

test('approving with remember creates exactly one linked-children allow rule', async () => {
  const h = approvalHarness();
  const promise = h.start();
  assert.equal(approveToolCall(h.service, h.pending().approvalId, { remember: 'linked_children' }), true);
  assert.equal((await promise).approved, true);
  assert.deepEqual(h.added, [LINKED_RULE]);
});

test('deny, timeout, cancel, a plain approval or a malformed remember create no rule', async () => {
  for (const settle of [
    (h) => denyToolCall(h.service, h.pending().approvalId),
    (h) => h.pending().resolve(false, 'timeout', '', null, '', 'linked_children'),
    (h) => h.pending().resolve(false, 'cancelled', '', null, '', 'linked_children'),
    (h) => approveToolCall(h.service, h.pending().approvalId, {}),
    (h) => approveToolCall(h.service, h.pending().approvalId, { remember: 'linked_children ' }),
    (h) => approveToolCall(h.service, h.pending().approvalId, { remember: true }),
  ]) {
    const h = approvalHarness();
    const promise = h.start();
    settle(h);
    await promise;
    assert.deepEqual(h.added, []);
  }
});

test('a failing rule write never changes the approval', async () => {
  const h = approvalHarness({ addFails: true });
  const promise = h.start();
  approveToolCall(h.service, h.pending().approvalId, { remember: 'linked_children' });
  const decision = await promise;
  assert.equal(decision.approved, true);
  assert.equal(typeof decision.consent_event_id, 'string');
  assert.equal(h.added.length, 1);
});

test('a turn that admitted queued mail is remembered (newest 256) so the rules treat it as a wake', () => {
  const { ChatMessagingService } = require('../services/chat-messaging-service');
  const holder = {};
  const note = (id) => ChatMessagingService.prototype.noteMailTurn.call(holder, id);
  const seen = (id) => ChatMessagingService.prototype.mailTurn.call(holder, id);
  assert.equal(seen('t0'), false);
  note('t0');
  note('');
  note(null);
  assert.equal(seen('t0'), true);
  for (let index = 1; index <= 256; index += 1) note(`t${index}`);
  assert.equal(seen('t0'), false, 'the oldest falls out past 256');
  assert.equal(seen('t256'), true);
  assert.equal(holder._mailTurns.size, 256);
});
