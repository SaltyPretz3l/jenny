'use strict';

/* Row 59 checkpoint 5a: the New session path across slices, through the real desktop composition
 * (createChatProposalService wiring), the real session store and the real linked-child creation:
 * accept New session -> preparation turn on the source -> complete_session_handoff -> a strict linked
 * child -> its first turn with the Background row request. Only the session runtime is faked. */

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
const R = require('../services/backend/chat-proposal-records');
const {
  beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization,
} = require('../services/session-runtime/inference-protocol');
const { validId } = require('../services/session-runtime/contracts');

function negotiatedClient() {
  const client = { process: { pid: 4343 } };
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

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-new-session-e2e-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const backend = new EventEmitter();
  const submits = [];
  Object.assign(backend, {
    sessionStore: store,
    sidecarClient: negotiatedClient(),
    projectService: { list: () => [{ id: 'project_one', name: 'One' }] },
    projectAuthority: { captureProject: (projectId) => ({ project_id: projectId ?? null }) },
    listModels: async () => ({ data: [{ id: 'm1', display_name: 'M one' }] }),
    sessionRuntime: {
      async submitApplicationTurn(request, { idempotencyKey }) {
        // The real runtime refuses a key its id contract rejects (application-submissions.js).
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
  return { store, backend, proposals, submits };
}

async function publishSuggestion(env, sessionId) {
  const incarnation = env.store.getSession(sessionId).session_incarnation;
  const input = normalizeSessionProposalInput({ initiation: 'own_initiative', title: 'Split the parser' }).value;
  const binding = {
    source_project_id: 'project_one', workspace_id: null, root_identity: null, authority_revision: 1, run_mode: 'agent',
    restrictions: { read_only: false, plan_mode: false }, model: null, effort: null, git: null, command: null,
    session: { source_run_mode: 'ask', lockdown: false },
  };
  const published = await env.proposals.publish({
    kind: 'session', sessionId, sessionIncarnation: incarnation, turnId: 'turn_src', toolCallId: 'call_1', input, binding,
  });
  assert.equal(published.ok, true, JSON.stringify(published));
  return { proposalId: published.proposal.proposal_id, incarnation };
}

const recordOf = (store, sessionId) => store.getSession(sessionId).chat_proposals.records[0];

test('New session: preparation turn, handoff, a strict linked child and its first turn, end to end', async (t) => {
  const env = setup(t);
  const sourceId = env.store.createSession({ title: 'source' }).id;
  const { proposalId, incarnation } = await publishSuggestion(env, sourceId);

  const decided = await env.proposals.decide({
    schema_version: 1, session_id: sourceId, proposal_id: proposalId, expected_revision: 1,
    decision_id: '11111111-1111-4111-8111-111111111111', choice: 'new_session',
  });
  assert.equal(decided.ok, true, JSON.stringify(decided));
  assert.equal(env.submits.length, 1, 'one preparation turn');
  const prep = env.submits[0];
  assert.equal(prep.request.sessionId, sourceId);
  assert.equal(prep.request.sessionHandoffPreparation.proposal_id, proposalId);
  const attemptId = recordOf(env.store, sourceId).attempt_id;
  assert.equal(prep.request.sessionHandoffPreparation.attempt_id, attemptId);
  assert.equal(Object.hasOwn(prep.request, 'sessionHandoff'), false);

  const args = {
    sessionId: sourceId, sessionIncarnation: incarnation, turnId: 'turn_1', toolCallId: 'call_h',
    proposalId, attemptId, task: 'Split parser.js into lexer and parser modules.', background: 'parser.js is 900 lines.',
  };
  const done = await env.proposals.completeHandoff(args);
  assert.equal(done.ok, true, JSON.stringify(done));
  const childId = done.child_session_id;
  const child = env.store.getSession(childId);
  assert.ok(child, 'the child exists in the canonical store');
  assert.equal(child.title, 'Split the parser');
  assert.equal(child.spawned_from.parent_session_id, sourceId);
  assert.equal(child.spawned_from.proposal_id, proposalId);
  assert.equal(child.session_mail.reporting_enabled, true);
  assert.equal(env.store.getSessionSummary(childId).reporting_enabled, true, 'the sidebar row menu reads the switch');
  assert.equal(env.store.getSessionSummary(sourceId).reporting_enabled, null, 'an unlinked chat has no switch');

  assert.equal(env.submits.length, 2, 'one first turn on the child');
  const first = env.submits[1];
  assert.equal(first.request.sessionId, childId);
  assert.equal(first.idempotencyKey, R.runtimeIdempotencyKey(R.sha256Hex(`proposal:${proposalId}:first_turn`)));
  assert.equal(first.request.prompt, args.task);
  assert.equal(first.request.sessionHandoff.body, args.background);
  assert.equal(first.request.sessionHandoff.source_session_id, sourceId);

  const record = recordOf(env.store, sourceId);
  assert.equal(record.action_state, 'succeeded');
  assert.equal(record.child_session_id, childId);

  const replay = await env.proposals.completeHandoff(args);
  assert.deepEqual(replay, done, 'the same handoff replays the same result');
  assert.equal(env.submits.length, 2, 'no second first turn');
  const conflict = await env.proposals.completeHandoff({ ...args, task: 'Something else.' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'idempotency_conflict');
  assert.equal(env.store.listSessions().filter((s) => s.spawned_from).length, 1, 'still exactly one linked child');
});

test('the sweep of empty chats keeps a linked child that has no messages yet', async (t) => {
  const env = setup(t);
  const sourceId = env.store.createSession({ title: 'source' }).id;
  const { proposalId, incarnation } = await publishSuggestion(env, sourceId);
  await env.proposals.decide({
    schema_version: 1, session_id: sourceId, proposal_id: proposalId, expected_revision: 1,
    decision_id: '22222222-2222-4222-8222-222222222222', choice: 'new_session',
  });
  const attemptId = recordOf(env.store, sourceId).attempt_id;
  const done = await env.proposals.completeHandoff({
    sessionId: sourceId, sessionIncarnation: incarnation, turnId: 'turn_1', toolCallId: 'call_h',
    proposalId, attemptId, task: 'Do the thing.', background: '',
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(Object.hasOwn(env.submits[1].request, 'sessionHandoff'), false, 'an empty Background sends no row');
  env.store.sweepEmptySessions({ currentSessionId: sourceId });
  assert.ok(env.store.getSession(done.child_session_id), 'the linked child survives the sweep');
});

test('a new linked child expands a collapsed parent', async (t) => {
  const env = setup(t);
  const sourceId = env.store.createSession({ title: 'source' }).id;
  const { createWorkspaceViewStore } = require('../services/backend/session-coordination-records');
  const view = createWorkspaceViewStore(env.store);
  const collapsed = view.write(sourceId, { expected_revision: view.read(sourceId).coordination_revision, patch: { children_expanded: false } });
  assert.equal(collapsed.ok, true, JSON.stringify(collapsed));
  const { proposalId, incarnation } = await publishSuggestion(env, sourceId);
  await env.proposals.decide({
    schema_version: 1, session_id: sourceId, proposal_id: proposalId, expected_revision: 1,
    decision_id: '33333333-3333-4333-8333-333333333333', choice: 'new_session',
  });
  const done = await env.proposals.completeHandoff({
    sessionId: sourceId, sessionIncarnation: incarnation, turnId: 'turn_1', toolCallId: 'call_h',
    proposalId, attemptId: recordOf(env.store, sourceId).attempt_id, task: 'Do the thing.', background: 'x',
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(view.read(sourceId).workspace_view.children_expanded, true);
});

test('the child never gets more authority than its source has when it is created (D10)', async (t) => {
  const env = setup(t);
  const sourceId = env.store.createSession({ title: 'source' }).id;
  const { proposalId, incarnation } = await publishSuggestion(env, sourceId);
  await env.proposals.decide({
    schema_version: 1, session_id: sourceId, proposal_id: proposalId, expected_revision: 1,
    decision_id: '44444444-4444-4444-8444-444444444444', choice: 'new_session',
  });
  // After the offer was published as an `ask`, unlocked source, the user switched it to Plan and locked it down.
  env.store.updateSession(sourceId, { run_mode: 'plan', lockdown: true });
  const done = await env.proposals.completeHandoff({
    sessionId: sourceId, sessionIncarnation: incarnation, turnId: 'turn_1', toolCallId: 'call_h',
    proposalId, attemptId: recordOf(env.store, sourceId).attempt_id, task: 'Do the thing.', background: 'x',
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  const child = env.store.getSessionSummary(done.child_session_id);
  assert.equal(child.run_mode, 'plan');
  assert.equal(child.lockdown, true);
  assert.equal(env.submits[1].request.planMode, true);
  assert.equal(env.submits[1].request.approvalMode, 'prompt');
});
