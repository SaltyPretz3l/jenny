'use strict';

// Stored-valid coordination records for the archive / restore-transform tests (row 59 cp5b-3, slice H1).

const assert = require('node:assert/strict');

const R = require('../../services/backend/chat-proposal-records');
const S = require('../../services/backend/chat-proposal-session-records');
const { normalizeLaunchGrant } = require('../../services/backend/session-coordination-records');
const P = require('./chat-proposal-records-fixture');
const F = require('./session-mail-fixtures');

// A pending send that already requested delivery under a one-off authorization.
function pendingOp(n, envelopeOptions = {}) {
  return F.makeOutbox(n, {
    state: 'pending', send_requested_at: F.iso(1000), authorization_id: F.uuid(5000 + n),
  }, envelopeOptions);
}

function sessionBinding() {
  return {
    source_project_id: 'proj_1', workspace_id: null, root_identity: null, authority_revision: 3, run_mode: 'agent',
    restrictions: { read_only: false, plan_mode: false }, model: 'm', effort: null, git: null, command: null,
    session: { effective_initiation: 'offer', authorization_required: false, launch_grant_ref: null, source_run_mode: 'ask', lockdown: false },
  };
}

function sessionProposal(n = 1, { sessionId, sessionIncarnation } = {}) {
  const input = S.normalizeSessionProposalInput({ initiation: 'offer', title: 'Fix the build' });
  const made = R.createProposalRecord({
    kind: 'session',
    ...P.identity(n),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionIncarnation ? { sessionIncarnation } : {}),
    input: input.value,
    options: S.defaultOptions({ sourceProjectId: 'proj_1', model: 'm' }),
    binding: sessionBinding(),
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.record;
}

function acceptedCommand(n, actionState) {
  const pending = P.makeCommand(n);
  const record = {
    ...pending,
    revision: pending.revision + 1,
    decision_state: 'accepted',
    action_state: actionState,
    decision: { ...R.decisionFor(pending, { decisionId: P.DECISION, choice: 'run', now: P.NOW }), confirmed_preconditions: [0] },
    attempt_id: P.ATTEMPT,
    attempt_number: 1,
    command_operation_id: F.uuid(8000 + n),
  };
  assert.deepEqual(R.normalizeProposalRecord(record), record, 'fixture must be a stored-valid record');
  return record;
}

function acceptedGit(n, actionState) {
  const accepted = R.acceptGitDecision(P.makeGit(n), { decisionId: P.DECISION, choice: 'commit', now: P.NOW, attemptId: P.ATTEMPT });
  const record = actionState === 'queued' ? accepted : { ...accepted, action_state: actionState };
  assert.deepEqual(R.normalizeProposalRecord(record), record, 'fixture must be a stored-valid record');
  return record;
}

function launchGrant(n, overrides = {}) {
  const createdAt = F.iso(0);
  const grant = {
    schema_version: 1,
    authorization_ref: F.uuid(9100 + n),
    source_session_incarnation: 'inc_src',
    source_user_message_id: 'msg_1',
    source_turn_id: 'turn_1',
    action_id: F.uuid(9200 + n),
    destination_project_ids: ['proj_1'],
    restrictions: { read_only: false, plan_mode: false, lockdown: false },
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + 60 * 60 * 1000).toISOString(),
    max_children: 3,
    remaining: 2,
    revoked_at: null,
    ...overrides,
  };
  assert.notEqual(normalizeLaunchGrant(grant), null, 'fixture must be a valid launch grant');
  return grant;
}

module.exports = { acceptedCommand, acceptedGit, launchGrant, pendingOp, sessionProposal };
