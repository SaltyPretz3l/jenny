'use strict';

// propose_session can pre-fill the offer card's model and reasoning effort (primary spawn model fixes,
// 2026-10-27). The pre-fill only seeds the card's Options; the card stays the consent surface.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const { identity, causeOf } = require('./helpers/chat-proposal-records-fixture');

const input = (args = {}) => S.normalizeSessionProposalInput({ initiation: 'offer', title: 'Fix the build', ...args });

function binding() {
  return {
    source_project_id: 'proj_1', workspace_id: null, root_identity: null, authority_revision: 3, run_mode: 'agent',
    restrictions: { read_only: false, plan_mode: false }, model: 'src-model', effort: 'low', git: null, command: null,
    session: {
      effective_initiation: 'offer', authorization_required: false, launch_grant_ref: null, source_run_mode: 'ask', lockdown: false,
    },
  };
}

function optionsOf(args, seed = S.defaultOptions({ sourceProjectId: 'proj_1', model: 'src-model', effort: 'low' })) {
  const checked = input(args);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const made = R.createProposalRecord({ kind: 'session', ...identity(1), input: checked.value, options: seed, binding: binding() });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.deepEqual(R.normalizeProposalRecord(made.record), made.record, 'the record is stored-valid');
  return made.record.options;
}

test('preferred_model and reasoning_effort are accepted, trimmed and normalized', () => {
  const checked = input({ preferred_model: '  ornith15:9b-q6-256k  ', reasoning_effort: 'Extra High' });
  assert.equal(checked.ok, true);
  assert.equal(checked.value.preferred_model, 'ornith15:9b-q6-256k');
  assert.equal(checked.value.reasoning_effort, 'xhigh');
  assert.deepEqual(S.normalizeSessionProposalInput(checked.value), checked, 'a stored value normalizes to itself');
  assert.equal(input({ preferred_model: 'm'.repeat(200) }).ok, true);
});

test('empty, blank or invalid pre-fills are dropped; an over-long or non-string model is refused', () => {
  const plain = input();
  for (const args of [{ preferred_model: '' }, { preferred_model: '   ' }, { preferred_model: null }, { reasoning_effort: 'turbo' },
    { reasoning_effort: '' }, { reasoning_effort: 'default' }, { reasoning_effort: 5 }]) {
    assert.deepEqual(input(args), plain, JSON.stringify(args));
  }
  assert.equal(causeOf(input({ preferred_model: 'm'.repeat(201) })), 'field_preferred_model');
  assert.equal(causeOf(input({ preferred_model: 5 })), 'field_preferred_model');
  assert.equal(causeOf(input({ preferred_model: 'bad\nmodel' })), 'field_preferred_model');
  assert.equal(causeOf(input({ run_mode: 'agent' })), 'unknown_key', 'no field changes the run mode');
});

test('the pre-fill replaces the source seeding; without it the source seeding stays', () => {
  assert.deepEqual(optionsOf({ preferred_model: 'ornith15:9b-q6-256k', reasoning_effort: 'high' }), {
    destination_project_id: 'proj_1', preferred_model: 'ornith15:9b-q6-256k', reasoning_effort: 'high', run_mode: 'agent',
  });
  assert.deepEqual(optionsOf({ preferred_model: 'ornith15:9b-q6-256k' }), {
    destination_project_id: 'proj_1', preferred_model: 'ornith15:9b-q6-256k', reasoning_effort: 'low', run_mode: 'agent',
  });
  assert.deepEqual(optionsOf({}), {
    destination_project_id: 'proj_1', preferred_model: 'src-model', reasoning_effort: 'low', run_mode: 'agent',
  });
  const planSeed = S.defaultOptions({ sourceProjectId: 'proj_1', planMode: true });
  assert.equal(optionsOf({ preferred_model: 'm2' }, planSeed).run_mode, 'plan', 'the run mode still follows the source chat');
});
