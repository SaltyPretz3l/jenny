'use strict';

/* Row 94 P2 (owner pick F1): a primary-chat proposal with fork_of_session_id, through the real desktop
 * composition (createChatProposalService wiring), the real session store and the real fork: publish ->
 * New session -> preparation turn on the primary -> complete_session_handoff -> the reserved child is a
 * fork of the other chat (its history, branch_origin, spawned_from proof) -> its first turn. Only the
 * session runtime is faked. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createChatProposalService } = require('../services/chat-proposal-wiring');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createLinkedChildSession } = require('../services/backend/backend-sessions');
const { normalizeSessionProposalInput } = require('../services/backend/chat-proposal-session-records');
const {
  beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization,
} = require('../services/session-runtime/inference-protocol');
const { validId } = require('../services/session-runtime/contracts');

function negotiatedClient() {
  const client = { process: { pid: 4344 } };
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, {
    runtime_inference_admission_version: 1,
    chat_workspace_version: 1,
    chat_workspace_capabilities: {
      schema_version: 1, producer_tools: ['propose_session', 'complete_session_handoff'],
      context_kinds: ['session_message', 'session_handoff'], session_messages: true,
    },
  });
  return client;
}

function setup(t, { featureFlags = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fork-session-e2e-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const backend = new EventEmitter();
  const submits = [];
  Object.assign(backend, {
    sessionStore: store,
    featureFlags,
    sidecarClient: negotiatedClient(),
    projectService: { list: () => [{ id: 'project_one', name: 'One' }, { id: 'project_two', name: 'Two' }], get: (id) => ({ id }) },
    projectAuthority: { captureProject: (projectId) => ({ project_id: projectId ?? null }) },
    listModels: async () => ({ data: [{ id: 'm1', display_name: 'M one' }] }),
    sessionRuntime: {
      async submitApplicationTurn(request, { idempotencyKey }) {
        if (!validId(idempotencyKey)) return { ok: false, reason: 'runtime_submission_request_invalid', acceptance: 'rejected' };
        submits.push({ request, idempotencyKey });
        const n = submits.length;
        return { ok: true, created: true, work_id: `work_${n}`, turn_id: `turn_${n}`, session_id: request.sessionId, status: 'pending' };
      },
      findApplicationSubmission: () => null,
      getApplicationWork: () => null,
    },
  });
  backend.createLinkedChildSession = (spec) => createLinkedChildSession(backend, spec);
  const proposals = createChatProposalService({ backendService: backend });
  t.after(() => proposals.dispose());
  const primaryId = store.createSession({ title: 'Jenny', sessionRole: 'primary' }).id;
  const targetId = store.createSession({
    title: 'Parser work', projectId: 'project_two', preferences: { preferred_model: 'm1', reasoning_effort: 'high' },
  }).id;
  store.appendMessage(targetId, { id: 'msg_u1', role: 'user', content: 'Split the parser.' });
  store.appendMessage(targetId, { id: 'msg_a1', role: 'assistant', content: 'Here is a plan.' });
  return { store, backend, proposals, submits, primaryId, targetId };
}

const BINDING = Object.freeze({
  source_project_id: 'general', workspace_id: null, root_identity: null, authority_revision: 1, run_mode: 'agent',
  restrictions: { read_only: false, plan_mode: false }, model: 'primary-model', effort: null, git: null, command: null,
  session: { source_run_mode: 'ask', lockdown: false },
});

async function publishFork(env, { sessionId = env.primaryId, args = {}, call = 'call_1' } = {}) {
  const checked = normalizeSessionProposalInput({ initiation: 'own_initiative', title: 'Try the lexer first', fork_of_session_id: env.targetId, ...args });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return env.proposals.publish({
    kind: 'session', sessionId, sessionIncarnation: env.store.getSession(sessionId).session_incarnation,
    turnId: 'turn_src', toolCallId: call, input: checked.value, binding: structuredClone(BINDING),
  });
}

const recordOf = (store, sessionId) => store.getSession(sessionId).chat_proposals.records[0];

async function acceptAndHandOff(env, proposalId, task = 'Write the lexer as its own module.') {
  const decided = await env.proposals.decide({
    schema_version: 1, session_id: env.primaryId, proposal_id: proposalId, expected_revision: 1,
    decision_id: '11111111-1111-4111-8111-111111111111', choice: 'new_session',
  });
  assert.equal(decided.ok, true, JSON.stringify(decided));
  const args = {
    sessionId: env.primaryId, sessionIncarnation: env.store.getSession(env.primaryId).session_incarnation, turnId: 'turn_1',
    toolCallId: 'call_h', proposalId, attemptId: recordOf(env.store, env.primaryId).attempt_id, task, background: 'Keep the API.',
  };
  return { args, done: await env.proposals.completeHandoff(args) };
}

test('fork: the accepted child is a fork of the other chat with its history, and the brief is its first new turn', async (t) => {
  const env = setup(t);
  const published = await publishFork(env);
  assert.equal(published.ok, true, JSON.stringify(published));
  const proposal = published.proposal;
  assert.deepEqual(proposal.options, {
    destination_project_id: 'project_two', preferred_model: 'm1', reasoning_effort: 'high', run_mode: 'agent',
    fork_of_session_id: env.targetId,
  }, 'the source chat\'s project, model and effort');

  const caps = await env.proposals.getCapabilities({ schema_version: 1, session_id: env.primaryId, proposal_id: proposal.proposal_id });
  assert.equal(caps.ok, true, JSON.stringify(caps));
  assert.deepEqual(caps.fork_source, { title: 'Parser work' });

  const { args, done } = await acceptAndHandOff(env, proposal.proposal_id);
  assert.match(env.submits[0].request.prompt, /fork of another chat and already has its history/u);
  assert.equal(done.ok, true, JSON.stringify(done));
  const record = recordOf(env.store, env.primaryId);
  const child = env.store.getSession(done.child_session_id);
  assert.ok(child, 'the reserved child id is the fork');
  assert.equal(child.title, 'Try the lexer first');
  assert.equal(child.project_id, 'project_two');
  assert.equal(child.preferred_model, 'm1');
  assert.equal(child.branch_origin.source_session_id, env.targetId);
  assert.equal(child.branch_origin.source_message_id, 'msg_a1');
  assert.deepEqual(child.messages.map((m) => [m.role, m.content]), [['user', 'Split the parser.'], ['assistant', 'Here is a plan.']]);
  assert.equal(child.spawned_from.parent_session_id, env.primaryId);
  assert.equal(child.spawned_from.child_creation_hash, record.child_creation_hash);
  assert.equal(child.session_incarnation, record.child_session_incarnation);
  assert.equal(child.session_mail.reporting_enabled, true);
  assert.ok(env.store.getSession(env.targetId).linked_session_ids.includes(child.id), 'the source links its fork');

  assert.equal(env.submits.length, 2);
  assert.equal(env.submits[1].request.sessionId, child.id);
  assert.equal(env.submits[1].request.prompt, args.task);
  assert.equal(env.submits[1].request.preferredModel, 'm1');
  assert.equal(record.action_state, 'succeeded');

  assert.deepEqual(await env.proposals.completeHandoff(args), done, 'a replay reuses the fork');
  assert.equal(env.store.listSessions().filter((s) => s.branch_origin?.source_session_id === env.targetId).length, 1);
});

test('fork: the project stays fixed, and a fork the store cannot make fails closed', async (t) => {
  const env = setup(t);
  const { proposal } = await publishFork(env);
  const moved = await env.proposals.setOptions({
    schema_version: 1, session_id: env.primaryId, proposal_id: proposal.proposal_id, expected_revision: 1,
    options: { ...proposal.options, destination_project_id: 'project_one' },
  });
  assert.equal(moved.ok, false);
  const model = await env.proposals.setOptions({
    schema_version: 1, session_id: env.primaryId, proposal_id: proposal.proposal_id, expected_revision: 1,
    options: { ...proposal.options, reasoning_effort: null },
  });
  assert.equal(model.ok, true, JSON.stringify(model));

  const ordinary = env.store.createSession({ title: 'other' }).id;
  assert.equal((await publishFork(env, { sessionId: ordinary })).ok, false, 'only the primary forks');
  assert.equal((await publishFork(env, { args: { fork_of_session_id: env.primaryId }, call: 'call_2' })).ok, false, 'never the primary');
  assert.equal((await publishFork(env, { args: { project_id: 'project_one' }, call: 'call_3' })).ok, false, 'never with project_id');
  const off = setup(t, { featureFlags: { primary_chat_placement: false } });
  assert.equal((await publishFork(off)).ok, false, 'off with the flag');
});

test('fork: a source deleted before the handoff leaves the proposal needing attention, nothing created', async (t) => {
  const env = setup(t);
  const { proposal } = await publishFork(env);
  const before = env.store.listSessions().length;
  const decided = await env.proposals.decide({
    schema_version: 1, session_id: env.primaryId, proposal_id: proposal.proposal_id, expected_revision: 1,
    decision_id: '22222222-2222-4222-8222-222222222222', choice: 'new_session',
  });
  assert.equal(decided.ok, true);
  env.store.deleteSession(env.targetId);
  const done = await env.proposals.completeHandoff({
    sessionId: env.primaryId, sessionIncarnation: env.store.getSession(env.primaryId).session_incarnation, turnId: 'turn_1',
    toolCallId: 'call_h', proposalId: proposal.proposal_id, attemptId: recordOf(env.store, env.primaryId).attempt_id,
    task: 'Do it.', background: '',
  });
  assert.equal(done.ok, false);
  const record = recordOf(env.store, env.primaryId);
  assert.equal(record.action_state, 'needs_attention');
  assert.equal(record.last_error.cause_code, 'fork_source_unavailable');
  assert.equal(env.store.getSession(record.child_session_id), null);
  assert.equal(env.store.listSessions().length, before - 1);
});
