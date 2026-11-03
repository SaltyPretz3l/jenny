'use strict';

// propose_session fork_of_session_id (row 94 P2, owner pick F1): the records carry the fork source in the
// normalized input and the options only when set, so inputs and options stored before it stay valid.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const { identity, causeOf } = require('./helpers/chat-proposal-records-fixture');

const FORK = 'sess_1730000000000_abcdef012345';
const input = (args = {}) => S.normalizeSessionProposalInput({ initiation: 'offer', title: 'Try another approach', ...args });

function binding() {
  return {
    source_project_id: 'proj_primary', workspace_id: null, root_identity: null, authority_revision: 3, run_mode: 'agent',
    restrictions: { read_only: false, plan_mode: false }, model: 'src-model', effort: 'low', git: null, command: null,
    session: {
      effective_initiation: 'offer', authorization_required: false, launch_grant_ref: null, source_run_mode: 'ask', lockdown: false,
    },
  };
}

function make(args, options) {
  const checked = input(args);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return R.createProposalRecord({ kind: 'session', ...identity(1), input: checked.value, options, binding: binding() });
}

test('fork_of_session_id is carried in the normalized input only when set; stored inputs normalize to themselves', () => {
  const checked = input({ fork_of_session_id: FORK });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.value.fork_of_session_id, FORK);
  assert.deepEqual(S.normalizeSessionProposalInput(checked.value), checked);
  const plain = input();
  assert.equal(Object.hasOwn(plain.value, 'fork_of_session_id'), false);
  assert.deepEqual(input({ fork_of_session_id: null }), plain, 'null reads as absent');
  assert.deepEqual(S.normalizeSessionProposalInput(plain.value), plain, 'an input stored before the field still normalizes to itself');
});

test('an invalid fork_of_session_id is refused with its own cause', () => {
  for (const bad of ['', 'x'.repeat(257), 'sess\n1', 'sess​1', 5, {}]) {
    assert.equal(causeOf(input({ fork_of_session_id: bad })), 'field_fork_of_session_id', JSON.stringify(bad));
  }
  assert.equal(input({ fork_of_session_id: 'x'.repeat(256) }).ok, true);
});

test('options carry fork_of_session_id only when set; four-key options from older builds stay valid', () => {
  const plain = S.defaultOptions({ sourceProjectId: 'proj_1', model: 'm', effort: 'low' });
  assert.deepEqual(Object.keys(plain).sort(), ['destination_project_id', 'preferred_model', 'reasoning_effort', 'run_mode']);
  assert.equal(S.validOptions(plain), true);
  const fork = S.defaultOptions({ sourceProjectId: 'proj_src', model: 'm', effort: null, forkOfSessionId: FORK });
  assert.deepEqual(fork, {
    destination_project_id: 'proj_src', preferred_model: 'm', reasoning_effort: null, run_mode: 'agent', fork_of_session_id: FORK,
  });
  assert.equal(S.validOptions(fork), true);
  assert.equal(S.validOptions({ ...plain, fork_of_session_id: null }), false, 'absent is the only empty form');
  assert.equal(S.validOptions({ ...plain, fork_of_session_id: '' }), false);
  assert.equal(S.validOptions({ ...plain, fork_of_session_id: 'x'.repeat(257) }), false);
  assert.equal(S.validOptions({ ...plain, other: 1 }), false, 'still a closed key set');
});

test('a fork record is stored-valid only when its options name the same fork as its input', () => {
  const forkOptions = S.defaultOptions({ sourceProjectId: 'proj_src', model: 'm', forkOfSessionId: FORK });
  const made = make({ fork_of_session_id: FORK }, forkOptions);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.record.options.fork_of_session_id, FORK);
  assert.equal(made.record.options.destination_project_id, 'proj_src');
  assert.deepEqual(R.normalizeProposalRecord(made.record), made.record);

  assert.equal(make({ fork_of_session_id: FORK }, S.defaultOptions({ sourceProjectId: 'proj_src' })).ok, false, 'input without options fork');
  assert.equal(make({}, forkOptions).ok, false, 'options fork without the input');
  const other = S.defaultOptions({ sourceProjectId: 'proj_src', forkOfSessionId: 'sess_other' });
  assert.equal(make({ fork_of_session_id: FORK }, other).ok, false, 'a different fork');
});

test('accepting a fork snapshots its fork into the decision and the child proof covers it', () => {
  const made = make({ fork_of_session_id: FORK }, S.defaultOptions({ sourceProjectId: 'proj_src', forkOfSessionId: FORK }));
  const accepted = S.acceptSessionDecision(made.record, {
    decisionId: '11111111-1111-4111-8111-111111111111', choice: 'new_session', now: identity(1).now,
    attemptId: '22222222-2222-4222-8222-222222222222',
  });
  assert.ok(accepted);
  assert.equal(accepted.decision.options.fork_of_session_id, FORK);
  assert.deepEqual(R.normalizeProposalRecord(accepted), accepted);
});

test('setSessionOptions keeps a fork a fork with its project fixed', () => {
  const forkOptions = S.defaultOptions({ sourceProjectId: 'proj_src', model: 'm', forkOfSessionId: FORK });
  const record = make({ fork_of_session_id: FORK }, forkOptions).record;
  const edited = S.setSessionOptions(record, { ...forkOptions, preferred_model: 'm2', run_mode: 'plan' });
  assert.ok(edited);
  assert.equal(edited.options.preferred_model, 'm2');
  const { fork_of_session_id: _dropped, ...unforked } = forkOptions;
  assert.equal(S.setSessionOptions(record, unforked), null, 'the fork cannot be removed');
  assert.equal(S.setSessionOptions(record, { ...forkOptions, fork_of_session_id: 'sess_other' }), null, 'nor changed');
  assert.equal(S.setSessionOptions(record, { ...forkOptions, destination_project_id: 'proj_other' }), null, 'nor moved');
  const plainRecord = make({}, S.defaultOptions({ sourceProjectId: 'proj_1' })).record;
  assert.equal(S.setSessionOptions(plainRecord, { ...plainRecord.options, fork_of_session_id: FORK }), null, 'a plain chat cannot become a fork');
});
