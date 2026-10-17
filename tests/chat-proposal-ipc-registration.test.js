'use strict';

/* sessionProposals.* IPC registration and desktop composition (row 59
 * checkpoint 3): the descriptor-backed channels, the trusted-sender gate,
 * raw-payload forwarding to the service-owned closed schema, the failure
 * envelope when the service is absent or throws, and the live wiring against a
 * backend-shaped object (rail invalidation, chat-stream outcome, startup
 * reconciliation). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require('../services/backend/chat-proposal-records');
const { registerChatProposalIpc, METHODS } = require('../services/main/chat-proposal-ipc-registration');
const { createChatProposalService } = require('../services/chat-proposal-wiring');
const { ChatWorkspaceService } = require('../services/chat-workspace-service');
const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { gitBinding } = require('./helpers/chat-proposal-service-fixture');

const CHANNELS = {
  get: 'session-proposals:get',
  list: 'session-proposals:list',
  decide: 'session-proposals:decide',
  cancel: 'session-proposals:cancel',
  retry: 'session-proposals:retry',
  getCapabilities: 'session-proposals:get-capabilities',
  setOptions: 'session-proposals:set-options',
  startAll: 'session-proposals:start-all',
  confirmRestored: 'session-proposals:confirm-restored',
  authorizeLaunch: 'session-proposals:authorize-launch',
};

function register({ allow = true, service } = {}) {
  const handlers = new Map();
  const backendService = { chatProposals: service };
  registerChatProposalIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService,
    authorization: { authorize: () => allow },
  });
  return { handlers, invoke: (channel, payload) => handlers.get(channel)({ sender: {} }, payload) };
}

test('exactly the ten descriptor-backed invoke channels are registered, and onChanged is a subscription', () => {
  const { handlers } = register({ service: {} });
  assert.deepEqual([...handlers.keys()].sort(), Object.values(CHANNELS).sort());
  assert.deepEqual(Object.keys(METHODS).length, 10);
  for (const [method, channel] of Object.entries(CHANNELS)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`sessionProposals.${method}`], { kind: 'invoke', channel });
  }
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['sessionProposals.onChanged'], { kind: 'subscribe', channel: 'session-proposals:changed' });
});

test('an untrusted sender reaches no service method', async () => {
  const calls = [];
  const service = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, args]); return { ok: true }; } });
  const denied = register({ allow: false, service });
  for (const channel of Object.values(CHANNELS)) {
    const result = await denied.invoke(channel, { schema_version: 1, session_id: 's' });
    assert.equal(result.ok, false);
    assert.notEqual(result.schema_version, 1);
  }
  assert.equal(calls.length, 0);
});

test('payloads reach the service raw and its envelope returns unchanged', async () => {
  const calls = [];
  const service = Object.fromEntries(Object.values(METHODS).map((name) => [name, async (raw) => {
    calls.push([name, raw]);
    return { schema_version: 1, ok: true };
  }]));
  const { invoke } = register({ service });
  const hostile = { schema_version: 1, session_id: 's', proposal_id: '../../x', extra: { deep: [1] } };
  assert.deepEqual(await invoke(CHANNELS.decide, hostile), { schema_version: 1, ok: true });
  await invoke(CHANNELS.startAll, undefined);
  assert.deepEqual(calls.map(([name]) => name), ['decide', 'startAll']);
  assert.equal(calls[0][1], hostile, 'no coercion or copying before the service validates');
});

test('a missing service and a throwing service answer the common failure envelope without exception text', async () => {
  const expected = {
    schema_version: 1, ok: false, error_code: CODES.UNAVAILABLE, reason: 'unavailable', retryable: false, current_revision: null,
  };
  assert.deepEqual(await register({ service: undefined }).invoke(CHANNELS.get, {}), expected);
  const throwing = { get: async () => { throw new Error('secret path C:\\Users\\x'); } };
  const result = await register({ service: throwing }).invoke(CHANNELS.get, {});
  assert.deepEqual(result, expected);
  assert.doesNotMatch(JSON.stringify(result), /secret|Users/u);
});

test('the service composes against a backend-shaped object: rail invalidation, stream outcome and startup reconciliation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-proposal-wiring-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const backend = new EventEmitter();
  const sessionId = store.createSession({ title: 'wired' }).id;
  const incarnation = store.getSession(sessionId).session_incarnation;
  const railEvents = [];
  const submits = [];
  const works = new Map();
  Object.assign(backend, {
    sessionStore: store,
    sessionRuntime: {
      async submitApplicationTurn(request, { idempotencyKey }) {
        submits.push([request.sessionId, idempotencyKey]);
        const work = { work_id: 'work_w1', turn_id: 'turn_w1', session_id: request.sessionId, status: 'pending' };
        works.set(work.work_id, work);
        return { ok: true, created: true, ...work };
      },
      findApplicationSubmission: () => null,
      getApplicationWork: (id) => works.get(id) || null,
    },
  });
  const bridge = [];
  const proposals = createChatProposalService({ backendService: backend, emit: (event) => bridge.push(event) });
  backend.chatProposals = proposals;
  // The real rail service is the sink for coordination changes.
  const rail = new ChatWorkspaceService({
    viewStore: { read: () => ({ ok: true, coordination_revision: 0 }), write: () => ({ ok: false }) },
    getStore: () => store,
    captureAuthority: () => ({}),
    resolveGitService: () => null,
    emit: (event) => railEvents.push(event),
    notifierOptions: { intervalMs: 0 },
  });
  backend.chatWorkspace = rail;
  t.after(() => { proposals.dispose(); rail.dispose(); });

  const input = R.normalizeGitProposalInput({ summary: 'S', question: 'Q', paths: ['a.js'] }).value;
  const published = await proposals.publish({
    kind: 'git', sessionId, sessionIncarnation: incarnation, turnId: 'turn_1', toolCallId: 'call_1', input, binding: gitBinding(input.paths),
  });
  assert.equal(published.ok, true);
  assert.deepEqual(bridge.map((event) => [event.session_id, event.revision]), [[sessionId, 1]]);
  assert.deepEqual(railEvents.map((event) => event.session_id), [sessionId], 'the rail is invalidated by the proposal mutation');

  const handlers = register({ service: proposals });
  const read = await handlers.invoke(CHANNELS.get, { schema_version: 1, session_id: sessionId, proposal_id: published.proposal.proposal_id });
  assert.equal(read.ok, true);
  assert.equal(read.proposal.kind, 'git');

  const dismissed = await handlers.invoke(CHANNELS.decide, {
    schema_version: 1,
    session_id: sessionId,
    proposal_id: published.proposal.proposal_id,
    expected_revision: 1,
    decision_id: '77777777-7777-4777-8777-777777777777',
    choice: 'dismiss',
  });
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.proposal.decision_state, 'dismissed');
  await new Promise((resolve) => setTimeout(resolve, 300)); // the trailing coalesced emit carries the latest revision
  assert.deepEqual(bridge.map((event) => event.revision), [1, 2]);
  assert.equal(railEvents.length, 2);

  // The composition rides the backend chat-stream bus and reconciles at startup without ever submitting.
  backend.emit('chat-stream', { type: 'complete', sessionId, turnId: 'turn_unrelated' });
  proposals.reconcileOnStartup();
  assert.equal(submits.length, 0);
  assert.equal(works.size, 0);
});

test('the session kind composes against a backend-shaped object: capabilities, options, a refused New session and Do it here', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-proposal-session-wiring-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const backend = new EventEmitter();
  const sessionId = store.createSession({ title: 'wired' }).id;
  const incarnation = store.getSession(sessionId).session_incarnation;
  const submits = [];
  Object.assign(backend, {
    sessionStore: store,
    projectService: { list: () => [{ id: 'proj_1', name: 'One' }] },
    listModels: async () => ({ data: [{ id: 'm1', display_name: 'M one' }] }),
    sessionRuntime: {
      async submitApplicationTurn(request, { idempotencyKey }) {
        submits.push([request, idempotencyKey]);
        return { ok: true, created: true, work_id: 'work_s1', turn_id: 'turn_s1', session_id: request.sessionId, status: 'pending' };
      },
      findApplicationSubmission: () => null,
      getApplicationWork: () => null,
    },
  });
  const proposals = createChatProposalService({ backendService: backend });
  t.after(() => proposals.dispose());
  const handlers = register({ service: proposals });

  const { normalizeSessionProposalInput } = require('../services/backend/chat-proposal-session-records');
  const input = normalizeSessionProposalInput({ initiation: 'own_initiative', title: 'Split the parser' }).value;
  const binding = {
    source_project_id: 'proj_1', workspace_id: null, root_identity: null, authority_revision: 1, run_mode: 'agent',
    restrictions: { read_only: false, plan_mode: false }, model: null, effort: null, git: null, command: null,
    session: { source_run_mode: 'ask', lockdown: false },
  };
  const published = await proposals.publish({
    kind: 'session', sessionId, sessionIncarnation: incarnation, turnId: 'turn_1', toolCallId: 'call_1', input, binding,
  });
  assert.equal(published.ok, true, JSON.stringify(published));
  const proposalId = published.proposal.proposal_id;
  const base = { schema_version: 1, session_id: sessionId, proposal_id: proposalId };

  const caps = await handlers.invoke(CHANNELS.getCapabilities, base);
  assert.equal(caps.ok, true, JSON.stringify(caps));
  assert.deepEqual(caps.destinations.map((entry) => entry.project_id), ['proj_1']);
  assert.deepEqual(caps.models.map((entry) => entry.id), ['m1']);
  assert.equal(caps.unavailable_reason, 'unsupported_capability', 'no negotiated sidecar client: the handoff is unavailable');

  const refused = await handlers.invoke(CHANNELS.decide, {
    ...base, expected_revision: 1, decision_id: '88888888-8888-4888-8888-888888888888', choice: 'new_session',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'unsupported_capability');
  assert.equal(submits.length, 0, 'nothing was dispatched for the refused choice');

  const here = await handlers.invoke(CHANNELS.decide, {
    ...base, expected_revision: 1, decision_id: '99999999-9999-4999-8999-999999999999', choice: 'do_it_here',
  });
  assert.equal(here.ok, true, JSON.stringify(here));
  assert.equal(here.proposal.decision_state, 'accepted');
  assert.equal(submits.length, 1);
  assert.equal(submits[0][0].proposalDecision.choice, 'do_it_here');
  assert.equal(submits[0][0].sessionId, sessionId);
});
