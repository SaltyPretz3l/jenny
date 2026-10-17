'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createChatProposalStore } = require('../services/backend/chat-proposal-store');
const { createLinkedChildSession } = require('../services/backend/backend-sessions');
const { normalizeSpawnedFrom } = require('../services/backend/session-coordination-records');
const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const H = require('../services/session-handoff-preparation');
const { NOW, DECISION, ATTEMPT } = require('./helpers/chat-proposal-records-fixture');

test('accepted new-session handoff persists a linked Plan child and its first-turn admission', async (t) => {
  const scratch = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'handoff-integration-'));
  const storePath = path.join(root, 'sessions.json');
  const sessionStore = new ElectronSessionStore(storePath, { logger() {} });
  t.after(() => { sessionStore.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const source = sessionStore.createSession({ preferences: {
    run_mode: 'plan', preferred_model: 'source_model', reasoning_effort: 'low', lockdown: true,
  } });
  const binding = {
    source_project_id: 'project_general', workspace_id: null, root_identity: null, authority_revision: 1,
    run_mode: 'plan', restrictions: { read_only: true, plan_mode: true }, model: 'source_model', effort: 'low',
    git: null, command: null, session: {
      effective_initiation: 'offer', authorization_required: false, launch_grant_ref: null,
      source_run_mode: 'plan', lockdown: true,
    },
  };
  const proposal = R.createProposalRecord({
    kind: 'session', sessionId: source.id, sessionIncarnation: source.session_incarnation,
    turnId: 'source_turn', toolCallId: 'offer_call', now: NOW, binding,
    input: S.normalizeSessionProposalInput({ initiation: 'offer', title: 'Implement linked task' }).value,
    options: S.defaultOptions({ sourceProjectId: 'project_destination', model: 'child_model', effort: 'high', planMode: true }),
  });
  assert.equal(proposal.ok, true);
  const accepted = S.acceptSessionDecision(proposal.record, {
    choice: 'new_session', decisionId: DECISION, attemptId: ATTEMPT, now: NOW,
  });
  const store = createChatProposalStore(sessionStore);
  assert.equal(store.mutate(source.id, () => ({ records: [accepted] })).ok, true);
  const prep = H.buildPreparationRequest(accepted, source);
  assert.equal(prep.planMode, true);
  assert.deepEqual(prep.sessionHandoffPreparation, { proposal_id: accepted.proposal_id, attempt_id: ATTEMPT });
  const requests = [];
  const capturedProjects = [];
  const service = { sessionStore, projectAuthority: { captureProject(id) {
    capturedProjects.push(id); return { project_id: id };
  } } };
  const ports = {
    store, records: R, now: () => NOW, createId: () => ATTEMPT, log() {}, notify() {},
    getSessionSummary: (id) => sessionStore.listSessions().find((s) => s.id === id),
    getRuntime: () => ({ async submitApplicationTurn(request, options) {
      requests.push({ request, options });
      return { ok: true, work_id: 'child_work', turn_id: 'child_turn' };
    } }),
    createLinkedChildSession: (spec) => createLinkedChildSession(service, spec),
    sessionExists: (id) => Boolean(sessionStore.getSession(id)),
    readSpawnedFrom: (id) => sessionStore.getSession(id)?.spawned_from,
    deadlines: new Map(), setTimer: () => 1, clearTimer() {},
  };
  const args = {
    sessionId: source.id, sessionIncarnation: source.session_incarnation, proposalId: accepted.proposal_id,
    attemptId: ATTEMPT, turnId: 'preparation_turn', toolCallId: 'handoff_call',
    task: 'Implement the accepted task', background: 'Earlier findings from the source chat',
  };
  const result = await H.completeSessionHandoff(ports, args);
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = sessionStore.getSession(result.child_session_id);
  assert.deepEqual(normalizeSpawnedFrom(child.spawned_from), child.spawned_from);
  assert.equal(child.spawned_from.parent_session_id, source.id);
  assert.equal(child.spawned_from.reporting_consent_id, DECISION);
  assert.equal(child.title, 'Implement linked task');
  assert.equal(child.project_id, 'project_destination');
  assert.equal(child.run_mode, 'plan');
  assert.equal(child.plan_mode, true);
  assert.equal(child.lockdown, true);
  assert.equal(child.session_mail.reporting_enabled, true);
  assert.deepEqual(capturedProjects, ['project_destination']);
  const request = requests[0].request;
  assert.equal(request.sessionId, child.id);
  assert.equal(request.prompt, args.task);
  assert.equal(request.visiblePrompt, args.task);
  assert.equal(request.planMode, true);
  assert.equal(request.preferredModel, 'child_model');
  assert.equal(request.reasoningEffort, 'high');
  assert.equal(request.approvalMode, 'prompt');
  assert.equal(request.sessionHandoff.body, args.background);
  assert.equal(request.sessionHandoff.source_session_incarnation, source.session_incarnation);
  assert.deepEqual(requests[0].options, { idempotencyKey: R.runtimeIdempotencyKey(R.sha256Hex(`proposal:${accepted.proposal_id}:first_turn`)) });
  const saved = store.read(source.id).records[0];
  assert.equal(saved.action_state, 'succeeded');
  assert.equal(saved.first_turn_work_id, 'child_work');
  assert.deepEqual(await H.completeSessionHandoff(ports, args), result);
  assert.equal(requests.length, 1);
  assert.equal(sessionStore.listSessions().length, 2);
  const reopened = new ElectronSessionStore(storePath, { logger() {} });
  assert.deepEqual(reopened.getSession(child.id).spawned_from, child.spawned_from);
  assert.equal(reopened.getSession(child.id).session_mail.reporting_enabled, true);
  assert.equal(createChatProposalStore(reopened).read(source.id).records[0].action_state, 'succeeded');
  reopened.dispose();
});
