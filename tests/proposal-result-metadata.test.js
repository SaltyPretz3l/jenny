'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProposalResultMetadata } = require('../services/backend/proposal-result-metadata');
const {
  normalizePersistedToolResultMetadata,
  normalizeToolResultMetadataForStorage,
} = require('../services/backend/tool-result-diff-metadata');

const PROPOSAL_ID = `proposal_${'0123456789abcdef'.repeat(4)}`;
const VALID = Object.freeze({
  schema_version: 1,
  result_kind: 'git_proposal',
  proposal_id: PROPOSAL_ID,
  revision: 2,
  decision_state: 'pending',
  action_state: 'none',
});

test('keeps exactly the allowlisted keys and drops everything else', () => {
  const normalized = normalizeProposalResultMetadata({
    ...VALID,
    command: 'rm -rf /',
    paths: ['secret.js'],
    summary: 'private',
    dispatch_key: 'proposal:x',
  });
  assert.deepEqual(normalized, VALID);
  assert.deepEqual(normalizeProposalResultMetadata({ ...VALID, result_kind: 'command_proposal' }),
    { ...VALID, result_kind: 'command_proposal' });
});

test('accepts every decision and action state enum value', () => {
  for (const decision_state of ['pending', 'accepted', 'dismissed', 'expired', 'withdrawn', 'stale']) {
    assert.equal(normalizeProposalResultMetadata({ ...VALID, decision_state }).decision_state, decision_state);
  }
  for (const action_state of ['none', 'waiting_for_source', 'queued', 'preparing', 'child_created', 'admitted',
    'succeeded', 'failed', 'cancelled', 'needs_attention']) {
    assert.equal(normalizeProposalResultMetadata({ ...VALID, action_state }).action_state, action_state);
  }
});

test('returns null for malformed input', () => {
  const malformed = [
    null, undefined, 'x', [], 7,
    { ...VALID, result_kind: 'memory' },
    { ...VALID, schema_version: 2 },
    { ...VALID, schema_version: undefined },
    { ...VALID, proposal_id: 'proposal_abc' },
    { ...VALID, proposal_id: `proposal_${'A'.repeat(64)}` },
    { ...VALID, proposal_id: `${PROPOSAL_ID}0` },
    { ...VALID, proposal_id: undefined },
    { ...VALID, revision: 0 },
    { ...VALID, revision: 1.5 },
    { ...VALID, revision: '2' },
    { ...VALID, decision_state: 'done' },
    { ...VALID, action_state: 'running' },
    { ...VALID, action_state: undefined },
  ];
  for (const source of malformed) {
    assert.equal(normalizeProposalResultMetadata(source), null, JSON.stringify(source));
  }
});

const GROUP_ID = `group_${'ab'.repeat(32)}`;

test('session_proposal keeps the closed session keys and drops everything else', () => {
  const normalized = normalizeProposalResultMetadata({
    ...VALID,
    result_kind: 'session_proposal',
    effective_initiation: 'own_initiative',
    authorization_required: false,
    group_id: GROUP_ID,
    turn_boundary: 'awaiting_proposal',
    title: 'private title',
    description: 'private',
    group_key: 'k',
    session_token: 'x',
    child_session_path: '/x',
  });
  assert.deepEqual(normalized, {
    ...VALID,
    result_kind: 'session_proposal',
    effective_initiation: 'own_initiative',
    authorization_required: false,
    group_id: GROUP_ID,
    turn_boundary: 'awaiting_proposal',
  });
  const plain = normalizeProposalResultMetadata({ ...VALID, result_kind: 'session_proposal' });
  assert.deepEqual(plain, { ...VALID, result_kind: 'session_proposal' }, 'optional keys are never invented');
  assert.equal(normalizeProposalResultMetadata({ ...VALID, result_kind: 'session_proposal', group_id: null }).group_id, null);
  assert.equal(normalizeProposalResultMetadata({ ...VALID, result_kind: 'session_proposal', turn_boundary: 'session_handoff_completed' })
    .turn_boundary, 'session_handoff_completed');
  const dropped = normalizeProposalResultMetadata({
    ...VALID,
    result_kind: 'session_proposal',
    effective_initiation: 'bogus',
    authorization_required: 'yes',
    group_id: 'group_x',
    turn_boundary: 'nope',
    admission_state: 'running',
    child_session_id: '',
    first_turn_work_id: 5,
  });
  assert.deepEqual(dropped, { ...VALID, result_kind: 'session_proposal' });
  for (const effective_initiation of ['offer', 'own_initiative', 'user_asked']) {
    assert.equal(normalizeProposalResultMetadata({ ...VALID, result_kind: 'session_proposal', effective_initiation }).effective_initiation,
      effective_initiation);
  }
});

test('session_handoff reports the child and the first-turn admission without decision state', () => {
  const source = {
    schema_version: 1,
    result_kind: 'session_handoff',
    proposal_id: PROPOSAL_ID,
    revision: 4,
    child_session_id: 'sess_child',
    first_turn_work_id: 'work_1',
    first_turn_turn_id: 'turn_1',
    admission_state: 'queued',
    turn_boundary: 'session_handoff_completed',
    task: 'private',
    background: 'private',
  };
  const expected = { ...source };
  delete expected.task;
  delete expected.background;
  assert.deepEqual(normalizeProposalResultMetadata(source), expected);
  for (const admission_state of ['queued', 'admitted', 'needs_attention']) {
    assert.equal(normalizeProposalResultMetadata({ ...source, admission_state }).admission_state, admission_state);
  }
  assert.equal(normalizeProposalResultMetadata({ ...source, admission_state: 'succeeded' }).admission_state, undefined);
  const withState = normalizeProposalResultMetadata({ ...source, decision_state: 'accepted', action_state: 'succeeded' });
  assert.equal(withState.decision_state, 'accepted');
  assert.equal(withState.action_state, 'succeeded');
  assert.equal(normalizeProposalResultMetadata({ ...source, proposal_id: 'bad' }), null);
  assert.equal(normalizeProposalResultMetadata({ ...source, revision: 0 }), null);
  assert.equal(normalizeProposalResultMetadata({ ...source, schema_version: 2 }), null);
  // git and command results still require both states
  assert.equal(normalizeProposalResultMetadata({ ...source, result_kind: 'git_proposal' }), null);
});

test('is wired into the canonical tool-result metadata normalizer', () => {
  const persisted = normalizePersistedToolResultMetadata({ ...VALID, command: 'secret', paths: ['x'] });
  assert.deepEqual(persisted, VALID);
  assert.equal(normalizePersistedToolResultMetadata({ ...VALID, proposal_id: 'bad' }), null);
  const stored = normalizeToolResultMetadataForStorage({ ...VALID });
  assert.equal(stored.proposal_id, PROPOSAL_ID);
  assert.equal(stored.result_kind, 'git_proposal');
  const session = normalizePersistedToolResultMetadata({
    ...VALID, result_kind: 'session_proposal', effective_initiation: 'offer', authorization_required: true,
    group_id: null, turn_boundary: 'awaiting_proposal', title: 'private',
  });
  assert.deepEqual(session, {
    ...VALID, result_kind: 'session_proposal', effective_initiation: 'offer', authorization_required: true,
    group_id: null, turn_boundary: 'awaiting_proposal',
  });
});
