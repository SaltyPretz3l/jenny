'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const {
  normalizeChatProposals, normalizeLaunchGrant, normalizeLaunchGrantList, partitionLaunchGrants,
} = require('../services/backend/session-coordination-records');
const { NOW, DECISION, ATTEMPT, identity } = require('./helpers/chat-proposal-records-fixture');

const GRANT = {
  schema_version: 1,
  authorization_ref: '33333333-3333-4333-8333-333333333333',
  source_session_incarnation: 'inc_a',
  source_user_message_id: 'msg_1',
  source_turn_id: 'turn_1',
  action_id: '44444444-4444-4444-8444-444444444444',
  destination_project_ids: ['proj_1', null],
  restrictions: { read_only: false, plan_mode: true, lockdown: false },
  created_at: '2026-10-15T10:00:00.000Z',
  expires_at: '2026-10-15T11:00:00.000Z',
  max_children: 3,
  remaining: 2,
  revoked_at: null,
};
function sessionBinding(session) {
  return {
    source_project_id: 'proj_1', workspace_id: null, root_identity: null, authority_revision: 3, run_mode: 'agent',
    restrictions: { read_only: false, plan_mode: false }, model: 'm', effort: null, git: null, command: null,
    session: {
      effective_initiation: 'offer', authorization_required: false, launch_grant_ref: null, source_run_mode: 'ask', lockdown: false, ...session,
    },
  };
}

function makeSession(n, args, binding) {
  const input = S.normalizeSessionProposalInput({ initiation: 'offer', title: 'Fix the build', ...args });
  const made = R.createProposalRecord({
    kind: 'session', ...identity(n), input: input.value, options: S.defaultOptions({ sourceProjectId: 'proj_1' }), binding,
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.record;
}

test('LaunchGrant is a strict v1 record: closed keys, one-hour life, bounded counts', () => {
  assert.deepEqual(normalizeLaunchGrant(GRANT), GRANT);
  assert.notEqual(normalizeLaunchGrant(GRANT), GRANT, 'a copy');
  assert.deepEqual(normalizeLaunchGrant({ ...GRANT, revoked_at: '2026-10-15T10:30:00.000Z' }).revoked_at, '2026-10-15T10:30:00.000Z');
  assert.equal(normalizeLaunchGrant({ ...GRANT, remaining: 0 }).remaining, 0);
  assert.equal(normalizeLaunchGrant({ ...GRANT, max_children: 10, remaining: 10 }).max_children, 10);
  assert.equal(normalizeLaunchGrant({ ...GRANT, destination_project_ids: [null] }).destination_project_ids.length, 1);
  const ids = Array.from({ length: 8 }, (_, i) => `proj_${i}`);
  assert.equal(normalizeLaunchGrant({ ...GRANT, destination_project_ids: ids }).destination_project_ids.length, 8);
  const bad = [
    null, [], 'x', { ...GRANT, extra: 1 }, { ...GRANT, schema_version: 2 },
    { ...GRANT, authorization_ref: 'nope' }, { ...GRANT, action_id: 'nope' },
    { ...GRANT, source_session_incarnation: '' }, { ...GRANT, source_user_message_id: 5 }, { ...GRANT, source_turn_id: 'x'.repeat(257) },
    { ...GRANT, destination_project_ids: [] }, { ...GRANT, destination_project_ids: ['a', 'a'] },
    { ...GRANT, destination_project_ids: [...ids, 'proj_9'] }, { ...GRANT, destination_project_ids: [7] },
    { ...GRANT, destination_project_ids: 'proj_1' }, { ...GRANT, restrictions: { read_only: false, plan_mode: false } },
    { ...GRANT, restrictions: { ...GRANT.restrictions, lockdown: 'no' } }, { ...GRANT, restrictions: { ...GRANT.restrictions, extra: true } },
    { ...GRANT, created_at: '2026-10-15T10:00:00Z' }, { ...GRANT, expires_at: '2026-10-15T11:00:00.001Z' },
    { ...GRANT, max_children: 0, remaining: 0 }, { ...GRANT, max_children: 11, remaining: 1 },
    { ...GRANT, remaining: 4 }, { ...GRANT, remaining: -1 }, { ...GRANT, remaining: 1.5 },
    { ...GRANT, revoked_at: 'yesterday' }, { ...GRANT, revoked_at: undefined },
  ];
  for (const value of bad) assert.equal(normalizeLaunchGrant(value), null, JSON.stringify(value));
});

test('partitionLaunchGrants keeps valid grants and every other entry opaque; the list normalizer is all-or-nothing', () => {
  const other = { ...GRANT, authorization_ref: '55555555-5555-4555-8555-555555555555' };
  const bogus = { grant_id: 'g1' };
  const future = { ...other, authorization_ref: '66666666-6666-4666-8666-666666666666', schema_version: 2 };
  const duplicate = { ...GRANT, remaining: 0 };
  const { grants, opaque } = partitionLaunchGrants([bogus, GRANT, future, other, duplicate, null]);
  assert.deepEqual(grants, [GRANT, other]);
  assert.deepEqual(opaque, [bogus, future, duplicate, null]);
  assert.deepEqual(partitionLaunchGrants('x'), { grants: [], opaque: [] });
  assert.deepEqual(normalizeLaunchGrantList([GRANT, other]), [GRANT, other]);
  assert.deepEqual(normalizeLaunchGrantList([]), []);
  assert.equal(normalizeLaunchGrantList([GRANT, bogus]), null);
  assert.equal(normalizeLaunchGrantList([GRANT, GRANT]), null);
  assert.equal(normalizeLaunchGrantList('x'), null);
  assert.deepEqual(normalizeChatProposals({ schema_version: 1, records: [], launch_grants: [bogus] }).launch_grants, [bogus],
    'the container itself stays a pass-through; the store partitions');
});

test('pruneLaunchGrants drops long-expired grants unless an unresolved proposal names them', () => {
  const DAY = 24 * 3600 * 1000;
  const grant = (ref, expiresMs) => ({ authorization_ref: ref, expires_at: new Date(expiresMs).toISOString() });
  const fresh = grant('00000000-0000-4000-8000-000000000001', NOW.getTime() + 1000);
  const recent = grant('00000000-0000-4000-8000-000000000002', NOW.getTime() - 29 * DAY);
  const old = grant('00000000-0000-4000-8000-000000000003', NOW.getTime() - 31 * DAY);
  const named = grant('00000000-0000-4000-8000-000000000004', NOW.getTime() - 40 * DAY);
  const namedBinding = sessionBinding({ effective_initiation: 'user_asked', launch_grant_ref: named.authorization_ref });
  const pendingRecord = makeSession(1, { initiation: 'user_asked', authorization_ref: named.authorization_ref }, namedBinding);
  assert.deepEqual(S.pruneLaunchGrants([fresh, recent, old, named], [pendingRecord], NOW), [fresh, recent, named]);
  const accepted = S.acceptSessionDecision(pendingRecord, { decisionId: DECISION, choice: 'new_session', now: NOW, attemptId: ATTEMPT });
  const settled = S.markSessionCancelled(accepted);
  assert.deepEqual(S.pruneLaunchGrants([fresh, recent, old, named], [settled], NOW), [fresh, recent]);
  assert.deepEqual(S.pruneLaunchGrants([], [], NOW), []);
});

test('module load order does not matter (the records, session and projection modules are mutually dependent)', () => {
  const root = path.join(__dirname, '..', 'services', 'backend');
  for (const first of ['chat-proposal-records', 'chat-proposal-session-records', 'chat-proposal-projection']) {
    const script = `
      require(${JSON.stringify(path.join(root, first))});
      const R = require(${JSON.stringify(path.join(root, 'chat-proposal-records'))});
      const S = require(${JSON.stringify(path.join(root, 'chat-proposal-session-records'))});
      if (typeof R.projectProposal !== 'function' || typeof S.acceptSessionDecision !== 'function') process.exit(2);
      const input = S.normalizeSessionProposalInput({ initiation: 'offer', title: 't' });
      const made = R.createProposalRecord({ kind: 'session', sessionId: 's', sessionIncarnation: 'i', turnId: 't', toolCallId: 'c', input: input.value,
        options: S.defaultOptions(), binding: ${JSON.stringify(sessionBinding())} });
      if (!made.ok || R.projectProposal(made.record, {}).kind !== 'session') process.exit(3);
    `;
    execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' });
  }
});
