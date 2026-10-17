'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const { NOW, DECISION, ATTEMPT, HEX, identity, makeGit, causeOf } = require('./helpers/chat-proposal-records-fixture');

const GRANT = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_2 = '44444444-4444-4444-8444-444444444444';
const BIDI = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const OPTIONS = Object.freeze({
  destination_project_id: 'proj_2', preferred_model: 'm2', reasoning_effort: 'high', run_mode: 'plan',
});

function sessionBinding({ session, common } = {}) {
  return {
    source_project_id: 'proj_1', workspace_id: null, root_identity: null, authority_revision: 3, run_mode: 'agent',
    restrictions: { read_only: false, plan_mode: false }, model: 'm', effort: null, git: null, command: null,
    ...common,
    session: {
      effective_initiation: 'offer', authorization_required: false, launch_grant_ref: null, source_run_mode: 'ask', lockdown: false, ...session,
    },
  };
}

const sessionInput = (args = {}) => S.normalizeSessionProposalInput({ initiation: 'offer', title: 'Fix the build', ...args });

function makeSession(n = 1, args = {}, { binding, options } = {}) {
  const input = sessionInput(args);
  assert.equal(input.ok, true, JSON.stringify(input));
  const made = R.createProposalRecord({
    kind: 'session', ...identity(n), input: input.value, options: options || S.defaultOptions({ sourceProjectId: 'proj_1', model: 'm' }),
    binding: binding || sessionBinding({ session: { effective_initiation: input.value.initiation } }),
  });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.record;
}

// Every transition output must itself be a stored-valid record.
function valid(record) {
  assert.notEqual(record, null, 'transition refused');
  assert.deepEqual(R.normalizeProposalRecord(record), record, 'record must normalize unchanged');
  return record;
}

const accept = (record, choice, extra = {}) => valid(S.acceptSessionDecision(record, {
  decisionId: DECISION, choice, now: NOW, attemptId: ATTEMPT, ...extra,
}));

function throughHandoff(record = makeSession()) {
  let r = accept(record, 'new_session');
  r = valid(S.markPrepAcknowledged(r, { workId: 'work_p', turnId: 'turn_p' }));
  r = valid(S.markPreparing(r));
  return valid(S.recordHandoff(r, { task: 'Do the thing', background: 'Context', childSessionId: 'sess_child', childIncarnation: 'inc_child' }));
}

test('session input: defaults, closed keys and per-field causes', () => {
  assert.deepEqual(sessionInput(), {
    ok: true,
    value: {
      schema_version: 1, initiation: 'offer', title: 'Fix the build', description: null, group_key: null, authorization_ref: null,
    },
  });
  assert.deepEqual(sessionInput({ description: null, group_key: null, authorization_ref: null }).value.description, null);
  assert.equal(causeOf(sessionInput({ extra: 1 })), 'unknown_key');
  assert.equal(causeOf(sessionInput({ schema_version: 2 })), 'field_schema_version');
  assert.equal(causeOf(S.normalizeSessionProposalInput(null)), 'invalid_args');
  assert.equal(causeOf(sessionInput({ initiation: 'auto' })), 'field_initiation');
  assert.equal(causeOf(S.normalizeSessionProposalInput({ title: 'x' })), 'field_initiation');
  for (const title of ['', '   ', 5, 'a\nb', 'a\rb', `a${BIDI}b`, `a${ZERO_WIDTH}b`, 'x'.repeat(161)]) {
    assert.equal(causeOf(sessionInput({ title })), 'field_title', JSON.stringify(title));
  }
  assert.equal(sessionInput({ title: 'x'.repeat(160) }).ok, true);
  assert.equal(sessionInput({ title: 'é'.repeat(160) }).ok, true, 'limits count code points');
  assert.equal(sessionInput({ description: 'a\n\tb' }).ok, true, 'TAB and LF are allowed in a description');
  for (const description of ['', '  ', 5, `a${BIDI}`, 'x'.repeat(1025)]) {
    assert.equal(causeOf(sessionInput({ description })), 'field_description', JSON.stringify(description));
  }
  assert.equal(sessionInput({ description: 'x'.repeat(1024) }).ok, true);
});

test('session input: group_key only with own_initiative, authorization_ref only with user_asked', () => {
  assert.equal(sessionInput({ initiation: 'own_initiative', group_key: 'batch_1-A' }).value.group_key, 'batch_1-A');
  for (const group_key of ['', 'has space', 'x'.repeat(65), 5]) {
    assert.equal(causeOf(sessionInput({ initiation: 'own_initiative', group_key })), 'field_group_key');
  }
  assert.equal(causeOf(sessionInput({ initiation: 'offer', group_key: 'g' })), 'field_group_key');
  assert.equal(causeOf(sessionInput({ initiation: 'user_asked', group_key: 'g' })), 'field_group_key');
  assert.equal(sessionInput({ initiation: 'user_asked', authorization_ref: GRANT }).value.authorization_ref, GRANT);
  for (const authorization_ref of ['nope', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 5]) {
    assert.equal(causeOf(sessionInput({ initiation: 'user_asked', authorization_ref })), 'field_authorization_ref');
  }
  assert.equal(causeOf(sessionInput({ initiation: 'offer', authorization_ref: GRANT })), 'field_authorization_ref');
  assert.equal(causeOf(sessionInput({ initiation: 'own_initiative', authorization_ref: GRANT })), 'field_authorization_ref');
  const stored = sessionInput({ initiation: 'own_initiative', group_key: 'g' }).value;
  assert.deepEqual(S.normalizeSessionProposalInput(stored), { ok: true, value: stored }, 'a stored value normalizes to itself');
});

test('derived identities: UUID shape, group id, dispatch keys and the creation hash', () => {
  const a = S.derivedUuid('start_all', DECISION, 'proposal_x');
  assert.equal(R.isUuid(a), true);
  assert.equal(a[14], '5');
  assert.match(a[19], /[89ab]/);
  assert.equal(a, S.derivedUuid('start_all', DECISION, 'proposal_x'));
  assert.notEqual(a, S.derivedUuid('start_all', DECISION, 'proposal_y'));
  assert.notEqual(a, S.derivedUuid('launch_grant', DECISION, 'proposal_x'));
  assert.equal(S.computeGroupId('inc', 'turn', 'k'), `group_${R.sha256Hex('["inc","turn","k"]')}`);
  assert.match(S.computeGroupId('inc', 'turn', 'k'), S.GROUP_ID_RE);
  assert.equal(S.buildLocalDispatchKey('proposal_x', DECISION), R.buildGitDispatchKey('proposal_x', DECISION));
  assert.equal(S.buildPrepareDispatchKey('proposal_x', DECISION, 2), `proposal:proposal_x:${DECISION}:prepare:2`);
  assert.equal(S.FIRST_TURN_DISPATCH_KEY('proposal_x'), 'proposal:proposal_x:first_turn');
  const text = { task: 't', background: '' };
  assert.equal(S.handoffSha256(text), R.sha256Hex(R.canonicalJson(text)));
  const proof = {
    proposalId: 'proposal_x', childSessionId: 'sess_c', childIncarnation: 'inc_c', handoffSha256: HEX, options: OPTIONS,
  };
  assert.equal(S.childCreationHash(proof), R.sha256Hex(R.canonicalJson(['proposal_x', 'sess_c', 'inc_c', HEX, OPTIONS])));
  assert.notEqual(S.childCreationHash(proof), S.childCreationHash({ ...proof, options: { ...OPTIONS, run_mode: 'agent' } }));
});

test('options defaults and validation', () => {
  assert.deepEqual(S.defaultOptions({ sourceProjectId: 'p', model: 'm', effort: 'low', planMode: true }),
    { destination_project_id: 'p', preferred_model: 'm', reasoning_effort: 'low', run_mode: 'plan' });
  assert.deepEqual(S.defaultOptions({ sourceProjectId: '', model: '  ', effort: undefined }),
    { destination_project_id: null, preferred_model: null, reasoning_effort: null, run_mode: 'agent' });
  assert.deepEqual(S.defaultOptions(), { destination_project_id: null, preferred_model: null, reasoning_effort: null, run_mode: 'agent' });
  assert.equal(S.validOptions(OPTIONS), true);
  assert.equal(S.validOptions({ ...OPTIONS, run_mode: 'ask' }), false);
  assert.equal(S.validOptions({ ...OPTIONS, extra: 1 }), false);
  assert.equal(S.validOptions({ ...OPTIONS, preferred_model: '' }), false);
  assert.equal(S.validOptions({ ...OPTIONS, destination_project_id: 5 }), false);
  assert.equal(S.validOptions(null), false);
  const { run_mode: _runMode, ...partial } = OPTIONS;
  assert.equal(S.validOptions(partial), false);
});

test('handoff text: task 1..16 KiB, background 0..32 KiB, no invisible characters', () => {
  assert.equal(S.validHandoffText({ task: 't', background: '' }), true);
  assert.equal(S.validHandoffText({ task: 'a\n\tb', background: 'x\r\ny' }), true);
  assert.equal(S.validHandoffText({ task: 'x'.repeat(16 * 1024), background: 'y'.repeat(32 * 1024) }), true);
  assert.equal(S.validHandoffText({ task: 'x'.repeat(16 * 1024 + 1), background: '' }), false);
  assert.equal(S.validHandoffText({ task: 't', background: 'y'.repeat(32 * 1024 + 1) }), false);
  assert.equal(S.validHandoffText({ task: 'é'.repeat(8 * 1024 + 1), background: '' }), false, 'limits are UTF-8 bytes');
  assert.equal(S.handoffTextCause({ task: ' ', background: '' }), 'field_task');
  assert.equal(S.handoffTextCause({ task: '', background: '' }), 'field_task');
  assert.equal(S.handoffTextCause({ task: `a${BIDI}`, background: '' }), 'field_task');
  assert.equal(S.handoffTextCause({ task: 'a\0', background: '' }), 'field_task');
  assert.equal(S.handoffTextCause({ task: 't', background: `a${ZERO_WIDTH}` }), 'field_background');
  assert.equal(S.handoffTextCause({ task: 't', background: 5 }), 'field_background');
  assert.equal(S.handoffTextCause({ task: 't', background: '' }), null);
  assert.equal(S.validHandoffText(null), false);
  assert.equal(S.validHandoffText({ task: 5, background: '' }), false);
});

test('createProposalRecord builds a pending session record with options and the derived group id', () => {
  const record = makeSession();
  assert.equal(record.kind, 'session');
  assert.equal(record.decision_state, 'pending');
  assert.equal(record.action_state, 'none');
  assert.deepEqual(record.options, { destination_project_id: 'proj_1', preferred_model: 'm', reasoning_effort: null, run_mode: 'agent' });
  assert.equal(record.group_id, null);
  assert.equal(record.binding.workspace_id, null, 'a projectless chat may propose a session');
  assert.deepEqual(R.normalizeProposalRecord(record), record);
  const grouped = makeSession(2, { initiation: 'own_initiative', group_key: 'g' }, {
    binding: sessionBinding({ session: { effective_initiation: 'own_initiative' } }),
  });
  assert.equal(grouped.group_id, S.computeGroupId('inc_a', 'turn_2', 'g'));
  const copy = structuredClone(OPTIONS);
  const made = makeSession(3, {}, { options: copy });
  copy.run_mode = 'agent';
  assert.equal(made.options.run_mode, 'plan', 'options are copied into the record');
  const noOptions = R.createProposalRecord({
    kind: 'session', ...identity(4), input: sessionInput().value, binding: sessionBinding(),
  });
  assert.deepEqual(noOptions, { ok: false, reason: 'invalid_request', cause_code: 'record_invalid' });
});

test('session binding: nullable workspace, closed session block, consistent initiation fields', () => {
  assert.equal(S.validSessionBinding(sessionBinding()), true);
  assert.equal(S.validSessionBinding(sessionBinding({ common: { workspace_id: 'root_1', root_identity: { root_id: 'root_1' } } })), true);
  assert.equal(S.validSessionBinding(sessionBinding({ common: { workspace_id: '' } })), false);
  assert.equal(S.validSessionBinding(sessionBinding({ common: { root_identity: {} } })), false);
  assert.equal(S.validSessionBinding(sessionBinding({ common: { run_mode: 'ask' } })), false);
  assert.equal(S.validSessionBinding(sessionBinding({ common: { git: {} } })), false);
  assert.equal(S.validSessionBinding({ ...sessionBinding(), session: undefined }), false);
  assert.equal(S.validSessionBinding({ ...sessionBinding(), session: { ...sessionBinding().session, extra: 1 } }), false);
  assert.equal(S.validSessionBinding(null), false);
  for (const source_run_mode of ['ask', 'auto', 'plan', 'propose']) {
    assert.equal(S.validSessionBinding(sessionBinding({ session: { source_run_mode } })), true, source_run_mode);
  }
  assert.equal(S.validSessionBinding(sessionBinding({ session: { source_run_mode: 'agent' } })), false);
  assert.equal(S.validSessionBinding(sessionBinding({ session: { lockdown: 'no' } })), false);
  assert.equal(S.validSessionBinding(sessionBinding({ session: { effective_initiation: 'user_asked', launch_grant_ref: GRANT } })), true);
  assert.equal(S.validSessionBinding(sessionBinding({ session: { effective_initiation: 'user_asked' } })), false, 'user_asked needs the grant');
  assert.equal(S.validSessionBinding(sessionBinding({ session: { launch_grant_ref: GRANT } })), false, 'a grant only with user_asked');
  assert.equal(S.validSessionBinding(sessionBinding({ session: { authorization_required: true } })), true);
  assert.equal(S.validSessionBinding(sessionBinding({
    session: { effective_initiation: 'own_initiative', authorization_required: true },
  })), false);
  assert.equal(S.validSessionBinding(sessionBinding({
    session: { effective_initiation: 'user_asked', launch_grant_ref: GRANT, authorization_required: true },
  })), false);
  // git/command bindings carry no session block and stay valid
  assert.equal(R.normalizeProposalRecord(makeGit()) !== null, true);
});

test('createProposalRecord rejects a session binding that disagrees with the model input', () => {
  const make = (args, session) => R.createProposalRecord({
    kind: 'session', ...identity(), input: sessionInput(args).value, options: S.defaultOptions(), binding: sessionBinding({ session }),
  });
  assert.equal(make({ initiation: 'offer' }, { effective_initiation: 'offer' }).ok, true);
  assert.equal(make({ initiation: 'offer' }, { effective_initiation: 'own_initiative' }).ok, false);
  assert.equal(make({ initiation: 'own_initiative' }, { effective_initiation: 'offer' }).ok, false);
  assert.equal(make({ initiation: 'user_asked' }, { effective_initiation: 'offer', authorization_required: true }).ok, true,
    'no grant consumed: an offer that needs authorization');
  assert.equal(make({ initiation: 'user_asked' }, { effective_initiation: 'offer', authorization_required: false }).ok, false);
  assert.equal(make({ initiation: 'user_asked', authorization_ref: GRANT }, { effective_initiation: 'user_asked', launch_grant_ref: GRANT }).ok, true);
  assert.equal(make({ initiation: 'user_asked', authorization_ref: GRANT }, {
    effective_initiation: 'user_asked', launch_grant_ref: ATTEMPT,
  }).ok, false, 'the consumed grant is the one the model named');
  assert.equal(make({ initiation: 'user_asked' }, { effective_initiation: 'user_asked', launch_grant_ref: GRANT }).ok, true,
    'D7: an omitted ref consumed the calling turn\'s own grant');
});

test('a git or command input cannot become a session record, and a session input cannot be a git record', () => {
  const git = makeGit();
  const asSession = R.createProposalRecord({
    kind: 'session', ...identity(), input: git.normalized_input, options: S.defaultOptions(), binding: sessionBinding(),
  });
  assert.equal(causeOf(asSession), 'record_invalid');
  assert.equal(R.normalizeProposalRecord({ ...git, kind: 'session' }), null);
  const record = makeSession();
  assert.equal(R.normalizeProposalRecord({ ...record, kind: 'git' }), null);
  assert.equal(R.normalizeProposalRecord({ ...record, kind: 'command' }), null);
  assert.equal(causeOf(R.createProposalRecord({ kind: 'other', ...identity(), input: {}, binding: {} })), 'field_kind');
});

test('the session normalizer is strict about options, group id, proof and progress fields', () => {
  const record = makeSession();
  const bad = (patch) => R.normalizeProposalRecord({ ...record, ...patch });
  assert.notEqual(bad({}), null);
  assert.equal(bad({ options: null }), null);
  assert.equal(bad({ options: { ...record.options, run_mode: 'x' } }), null);
  assert.equal(bad({ group_id: S.computeGroupId('inc_a', 'turn_1', 'g') }), null, 'a group id needs an own_initiative group_key');
  assert.equal(bad({ group_id: 'group_x' }), null);
  assert.equal(bad({ child_session_id: 'sess_c' }), null, 'child ids need the whole proof');
  assert.equal(bad({ handoff: { task: 't', background: '', sha256: HEX } }), null);
  assert.equal(bad({ preparation_work_id: 'w' }), null, 'a pending record has no progress');
  assert.equal(bad({ attempt_number: 1 }), null);
  assert.equal(bad({ decision_state: 'accepted', action_state: 'queued' }), null);
  assert.notEqual(bad({ restore_requires_confirmation: true }), null, 'session records may carry the restore flag (checkpoint 5b)');
  assert.equal(bad({ execution: { status: 'x', exit_code: null, cleanup: null } }), null);
  const grouped = makeSession(2, { initiation: 'own_initiative', group_key: 'g' }, { binding: sessionBinding({ session: { effective_initiation: 'own_initiative' } }) });
  assert.equal(R.normalizeProposalRecord({ ...grouped, group_id: null }), null, 'a group_key requires its derived group id');
  assert.equal(R.normalizeProposalRecord({ ...grouped, group_id: S.computeGroupId('inc_a', 'turn_9', 'g') }), null);
  assert.notEqual(R.normalizeProposalRecord(grouped), null);
});

test('do_it_here: accept, acknowledge, admit and settle through the shared continuation helpers', () => {
  const pending = makeSession();
  const queued = accept(pending, 'do_it_here');
  assert.equal(queued.revision, pending.revision + 1);
  assert.equal(queued.decision_state, 'accepted');
  assert.equal(queued.action_state, 'queued');
  assert.equal(queued.attempt_number, 1);
  assert.equal(queued.attempt_id, ATTEMPT);
  assert.equal(queued.dispatch_key, R.buildGitDispatchKey(pending.proposal_id, DECISION));
  assert.equal(queued.dispatch_key_sha256, R.sha256Hex(queued.dispatch_key));
  assert.equal(queued.decision.options, null);
  assert.equal(queued.decision.accepted_revision, queued.revision);
  const acked = valid(R.markDispatchAcknowledged(queued, { workId: 'w', turnId: 't' }));
  assert.deepEqual([acked.continuation_work_id, acked.continuation_turn_id], ['w', 't']);
  const admitted = valid(R.markAdmitted(acked));
  assert.equal(admitted.action_state, 'admitted');
  assert.equal(valid(R.markContinuationOutcome(admitted, 'succeeded')).action_state, 'succeeded');
  assert.equal(valid(R.markContinuationOutcome(admitted, 'cancelled')).action_state, 'cancelled');
  assert.equal(valid(R.markOutcomeUnknown(admitted)).last_error.reason, 'outcome_unknown');
  assert.equal(R.canRetry(valid(R.markOutcomeUnknown(admitted))), false);
  const refused = valid(R.markDispatchRefused(queued, { runtimeUnavailable: true }));
  assert.equal(refused.last_error.reason, 'unavailable');
  assert.equal(S.canRetrySession(refused), true);
  const retried = valid(S.prepareSessionRetry(refused, { attemptId: ATTEMPT_2 }));
  assert.equal(retried.action_state, 'queued');
  assert.equal(retried.attempt_number, 2);
  assert.equal(retried.dispatch_key, queued.dispatch_key, 'the same continuation key');
  assert.deepEqual(valid(R.prepareRetry(refused)).action_state, 'queued', 'the Git helper agrees for Do it here');
  // the new-session-only transitions refuse a Do it here record
  assert.equal(S.markPreparing(queued), null);
  assert.equal(S.markPrepAcknowledged(queued, { workId: 'w', turnId: 't' }), null);
  assert.equal(S.markPreparationFailed(queued, { causeCode: 'x' }), null);
  assert.equal(S.recordHandoff(queued, { task: 't', background: '', childSessionId: 's', childIncarnation: 'i' }), null);
});

test('accept refuses non-pending, expired, bad ids and bad choices', () => {
  const pending = makeSession();
  const args = { decisionId: DECISION, choice: 'new_session', now: NOW, attemptId: ATTEMPT };
  assert.equal(S.acceptSessionDecision(null, args), null);
  assert.equal(S.acceptSessionDecision(makeGit(), { ...args, choice: 'commit' }), null);
  assert.equal(S.acceptSessionDecision(pending, { ...args, choice: 'dismiss' }), null);
  assert.equal(S.acceptSessionDecision(pending, { ...args, choice: 'run' }), null);
  assert.equal(S.acceptSessionDecision(pending, { ...args, decisionId: 'x' }), null);
  assert.equal(S.acceptSessionDecision(pending, { ...args, attemptId: 'x' }), null);
  assert.equal(S.acceptSessionDecision(pending, { ...args, now: new Date(NOW.getTime() + 8 * 24 * 3600 * 1000) }), null);
  const accepted = accept(pending, 'do_it_here');
  assert.equal(S.acceptSessionDecision(accepted, args), null);
  assert.equal(valid(S.acceptSessionDecision(pending, { ...args, attemptId: undefined })).attempt_id.length, 36, 'an attempt id is generated');
  assert.equal(R.dismissProposal(pending, { decisionId: DECISION, now: NOW }).decision.options, null);
  assert.notEqual(valid(R.dismissProposal(pending, { decisionId: DECISION, now: NOW })), null);
  assert.notEqual(valid(R.markStale(pending, { causeCode: 'authority' })), null);
  assert.notEqual(valid(R.expireIfDue(pending, new Date(NOW.getTime() + 8 * 24 * 3600 * 1000))), null);
});

test('new_session: accept snapshots the options and the prepare key', () => {
  const pending = makeSession(1, {}, { options: OPTIONS });
  const queued = accept(pending, 'new_session');
  assert.deepEqual(queued.decision.options, OPTIONS);
  assert.notEqual(queued.decision.options, pending.options, 'a snapshot, not the same object');
  assert.equal(queued.dispatch_key, `proposal:${pending.proposal_id}:${DECISION}:prepare:1`);
  assert.equal(queued.dispatch_key_sha256, R.sha256Hex(queued.dispatch_key));
  assert.equal(queued.continuation_work_id, null);
  assert.equal(R.isUnresolved(queued), true);
  assert.equal(R.markDispatchAcknowledged(queued, { workId: 'w', turnId: 't' }), null, 'the Git ack is for Do it here only');
  assert.equal(R.markContinuationOutcome(queued, 'succeeded'), null);
  assert.equal(R.canRetry(queued), false);
  const edited = S.setSessionOptions(pending, { ...OPTIONS, run_mode: 'agent' });
  assert.equal(accept(edited, 'new_session').decision.options.run_mode, 'agent', 'the edit before the choice is what is snapshotted');
});

test('waiting_for_source: release dispatches, cancel withdraws, user cancel works', () => {
  const pending = makeSession();
  for (const choice of ['do_it_here', 'new_session']) {
    const waiting = accept(pending, choice, { waitForSource: true });
    assert.equal(waiting.action_state, 'waiting_for_source');
    assert.equal(waiting.dispatch_key, accept(pending, choice).dispatch_key);
    assert.equal(R.isUnresolved(waiting), true);
    assert.equal(valid(S.releaseWaiting(waiting)).action_state, 'queued');
    assert.equal(valid(S.cancelWaiting(waiting)).action_state, 'cancelled');
    assert.equal(R.isUnresolved(S.cancelWaiting(waiting)), false);
    assert.equal(valid(S.markSessionCancelled(waiting)).action_state, 'cancelled');
    assert.equal(S.canCancelSession(waiting), true);
    assert.equal(S.releaseWaiting(S.releaseWaiting(waiting)), null);
    assert.equal(S.cancelWaiting(S.releaseWaiting(waiting)), null);
  }
  assert.equal(S.releaseWaiting(pending), null);
  assert.equal(S.cancelWaiting(null), null);
});

test('new_session happy path: prepare, handoff, child, first turn', () => {
  const pending = makeSession(1, {}, { options: OPTIONS });
  const queued = accept(pending, 'new_session');
  const acked = valid(S.markPrepAcknowledged(queued, { workId: 'work_p', turnId: 'turn_p' }));
  assert.deepEqual([acked.preparation_work_id, acked.preparation_turn_id], ['work_p', 'turn_p']);
  assert.equal(S.markPrepAcknowledged(acked, { workId: 'w2', turnId: 't2' }), null, 'adopted once');
  assert.equal(S.markPrepAcknowledged(queued, { workId: 1, turnId: 't' }), null);
  assert.equal(S.recordHandoff(queued, { task: 't', background: '', childSessionId: 's', childIncarnation: 'i' }), null, 'only while preparing');
  const preparing = valid(S.markPreparing(acked));
  assert.equal(preparing.action_state, 'preparing');
  assert.equal(S.markPreparing(preparing), null);
  const text = { task: 'Do the thing', background: 'Context' };
  assert.equal(S.recordHandoff(preparing, { ...text, task: '', childSessionId: 's', childIncarnation: 'i' }), null);
  assert.equal(S.recordHandoff(preparing, { ...text, childSessionId: '', childIncarnation: 'i' }), null);
  const reserved = valid(S.recordHandoff(preparing, { ...text, childSessionId: 'sess_child', childIncarnation: 'inc_child' }));
  assert.equal(reserved.action_state, 'preparing');
  assert.deepEqual(reserved.handoff, { ...text, sha256: S.handoffSha256(text) });
  assert.equal(reserved.child_session_id, 'sess_child');
  assert.equal(reserved.child_session_incarnation, 'inc_child');
  assert.equal(reserved.child_creation_hash, S.childCreationHash({
    proposalId: pending.proposal_id, childSessionId: 'sess_child', childIncarnation: 'inc_child',
    handoffSha256: S.handoffSha256(text), options: OPTIONS,
  }));
  assert.equal(reserved.dispatch_key, S.FIRST_TURN_DISPATCH_KEY(pending.proposal_id));
  assert.equal(reserved.dispatch_key_sha256, R.sha256Hex(reserved.dispatch_key));
  assert.equal(S.recordHandoff(reserved, { ...text, childSessionId: 'x', childIncarnation: 'y' }), null, 'one handoff per attempt');
  assert.equal(S.markPreparing(reserved), null);
  assert.equal(S.markSessionCancelled(reserved), null, 'no cancel once the child is reserved');
  assert.equal(S.canCancelSession(reserved), false);
  const created = valid(S.markChildCreated(reserved));
  assert.equal(created.action_state, 'child_created');
  assert.equal(S.markChildCreated(created), null);
  assert.equal(S.markFirstTurnAdmitted(reserved, { workId: 'w', turnId: 't' }), null, 'the child must exist first');
  assert.equal(S.markFirstTurnAdmitted(created, { workId: 'w' }), null);
  const done = valid(S.markFirstTurnAdmitted(created, { workId: 'work_f', turnId: 'turn_f' }));
  assert.equal(done.action_state, 'succeeded');
  assert.deepEqual([done.first_turn_work_id, done.first_turn_turn_id], ['work_f', 'turn_f']);
  assert.equal(R.isUnresolved(done), false);
  assert.equal(S.canCancelSession(done), false);
});

test('a succeeded or child_created new_session without the proof is not a stored record', () => {
  const done = (() => {
    let r = throughHandoff();
    r = valid(S.markChildCreated(r));
    return valid(S.markFirstTurnAdmitted(r, { workId: 'w', turnId: 't' }));
  })();
  const strip = (patch) => R.normalizeProposalRecord({ ...done, ...patch });
  assert.equal(strip({ handoff: null }), null);
  assert.equal(strip({ child_session_id: null }), null);
  assert.equal(strip({ child_creation_hash: null }), null);
  assert.equal(strip({ child_session_id: 'sess_other' }), null, 'the creation hash binds the child id');
  assert.equal(strip({ child_creation_hash: HEX }), null);
  assert.equal(strip({ handoff: { ...done.handoff, task: 'changed' } }), null, 'the handoff sha binds the text');
  assert.equal(strip({ dispatch_key: 'proposal:x', dispatch_key_sha256: R.sha256Hex('proposal:x') }), null);
  assert.equal(strip({ continuation_work_id: 'w' }), null, 'a new session has no continuation');
  const queued = accept(makeSession(), 'new_session');
  assert.equal(R.normalizeProposalRecord({ ...queued, action_state: 'child_created' }), null);
  assert.equal(R.normalizeProposalRecord({ ...queued, action_state: 'preparing', first_turn_work_id: 'w' }), null);
  const doIt = accept(makeSession(2), 'do_it_here');
  assert.equal(R.normalizeProposalRecord({ ...doIt, action_state: 'preparing' }), null, 'Do it here never prepares');
  assert.equal(R.normalizeProposalRecord({ ...doIt, action_state: 'child_created' }), null);
  assert.equal(R.normalizeProposalRecord({ ...doIt, preparation_work_id: 'w' }), null);
  assert.equal(R.normalizeProposalRecord({ ...queued, dispatch_key: R.buildGitDispatchKey(queued.proposal_id, DECISION), dispatch_key_sha256: R.sha256Hex(R.buildGitDispatchKey(queued.proposal_id, DECISION)) }), null,
    'a new session uses the prepare key');
});

test('preparation failures: refused submission, no handoff, deadline; retry starts a fresh attempt', () => {
  const queued = accept(makeSession(), 'new_session');
  const refused = valid(S.markPrepRefused(queued, { runtimeUnavailable: true }));
  assert.equal(refused.last_error.reason, 'unavailable');
  assert.equal(refused.last_error.retryable, true);
  assert.equal(valid(S.markPrepRefused(queued, { causeCode: 'busy' })).last_error.reason, 'dispatch_failed');
  assert.equal(S.markPrepRefused(S.markPreparing(queued)), null, 'only before the turn started');
  const preparing = valid(S.markPreparing(valid(S.markPrepAcknowledged(queued, { workId: 'w', turnId: 't' }))));
  for (const [from, cause] of [[queued, 'no_handoff'], [preparing, 'deadline']]) {
    const failed = valid(S.markPreparationFailed(from, { causeCode: cause }));
    assert.equal(failed.action_state, 'needs_attention');
    assert.deepEqual(failed.last_error, { code: 'CMP-PROPOSAL-0010', reason: 'preparation_failed', retryable: true, cause_code: cause });
    assert.equal(R.isUnresolved(failed), true, 'a retryable failure stays unresolved');
    assert.equal(S.canRetrySession(failed), true);
    const retry = valid(S.prepareSessionRetry(failed, { attemptId: ATTEMPT_2 }));
    assert.equal(retry.action_state, 'queued');
    assert.equal(retry.attempt_id, ATTEMPT_2);
    assert.equal(retry.attempt_number, 2);
    assert.equal(retry.handoff, null);
    assert.equal(retry.preparation_work_id, null);
    assert.equal(retry.preparation_turn_id, null);
    assert.equal(retry.last_error, null);
    assert.equal(retry.dispatch_key, `proposal:${retry.proposal_id}:${DECISION}:prepare:2`);
    assert.equal(retry.dispatch_key_sha256, R.sha256Hex(retry.dispatch_key));
    assert.equal(retry.decision.options, queued.decision.options, 'the original snapshot stays');
  }
  assert.equal(S.markPreparationFailed(throughHandoff(), { causeCode: 'late' }), null, 'a reserved child is not a preparation failure');
  assert.equal(S.canRetrySession(queued), false);
  assert.equal(S.prepareSessionRetry(queued), null);
});

test('a refused first turn keeps the child; retry returns to preparing with the same proof and key', () => {
  const reserved = throughHandoff();
  const created = valid(S.markChildCreated(reserved));
  const refused = valid(S.markFirstTurnRefused(created, { causeCode: 'busy' }));
  assert.equal(refused.action_state, 'needs_attention');
  assert.deepEqual(refused.last_error, { code: 'CMP-PROPOSAL-0011', reason: 'dispatch_failed', retryable: true, cause_code: 'busy' });
  assert.equal(refused.child_session_id, 'sess_child');
  assert.equal(valid(S.markFirstTurnRefused(created, { runtimeUnavailable: true })).last_error.reason, 'unavailable');
  assert.equal(valid(S.markFirstTurnRefused(reserved, { causeCode: 'create_failed' })).action_state, 'needs_attention', 'child creation failed');
  assert.equal(S.markFirstTurnRefused(accept(makeSession(2), 'new_session')), null);
  assert.equal(S.canRetrySession(refused), true);
  assert.equal(S.canCancelSession(refused), true, 'a first turn that never started can be cancelled');
  assert.equal(valid(S.markSessionCancelled(refused)).action_state, 'cancelled');
  assert.equal(S.markSessionCancelled(created), null, 'an in-flight first turn is not cancelled here');
  const retry = valid(S.prepareSessionRetry(refused, { attemptId: ATTEMPT_2 }));
  assert.equal(retry.action_state, 'preparing');
  assert.equal(retry.attempt_number, 2);
  assert.equal(retry.attempt_id, ATTEMPT_2);
  assert.equal(retry.dispatch_key, S.FIRST_TURN_DISPATCH_KEY(retry.proposal_id), 'the SAME first-turn key');
  assert.equal(retry.child_creation_hash, reserved.child_creation_hash);
  assert.deepEqual(retry.handoff, reserved.handoff);
  const again = valid(S.markChildCreated(retry));
  const admitted = valid(S.markFirstTurnAdmitted(again, { workId: 'w', turnId: 't' }));
  assert.equal(admitted.action_state, 'succeeded');
  assert.equal(S.markSessionCancelled(admitted), null, 'an admitted child cancels through its own controls');
  assert.equal(S.prepareSessionRetry(refused, { attemptId: 'bad' }), null);
});

test('pre-child cancel: queued and preparing; never for a settled record', () => {
  const queued = accept(makeSession(), 'new_session');
  assert.equal(valid(S.markSessionCancelled(queued)).action_state, 'cancelled');
  assert.equal(S.canCancelSession(queued), true);
  const preparing = valid(S.markPreparing(queued));
  assert.equal(valid(S.markSessionCancelled(preparing)).action_state, 'cancelled');
  assert.equal(S.markSessionCancelled(makeSession()), null, 'pending uses dismiss');
  const cancelled = S.markSessionCancelled(queued);
  assert.equal(S.markSessionCancelled(cancelled), null);
  assert.equal(R.isUnresolved(cancelled), false);
  const doIt = accept(makeSession(2), 'do_it_here');
  assert.equal(S.markSessionCancelled(doIt), null, 'a continuation is cancelled through the runtime');
  assert.equal(S.canCancelSession(doIt), true);
  assert.equal(S.canCancelSession(valid(R.markAdmitted(doIt))), true);
  assert.equal(S.canCancelSession(makeSession()), false);
  assert.equal(S.canCancelSession(makeGit()), false);
});

test('acceptFromGrant accepts a user_asked proposal as New session with a derived decision id', () => {
  const binding = sessionBinding({ session: { effective_initiation: 'user_asked', launch_grant_ref: GRANT } });
  const pending = makeSession(1, { initiation: 'user_asked', authorization_ref: GRANT }, { binding, options: OPTIONS });
  const queued = valid(S.acceptFromGrant(pending, { grantRef: GRANT, now: NOW, attemptId: ATTEMPT }));
  const decisionId = S.derivedUuid('launch_grant', GRANT, pending.proposal_id);
  assert.equal(queued.decision.decision_id, decisionId);
  assert.equal(queued.decision.choice, 'new_session');
  assert.deepEqual(queued.decision.options, OPTIONS, 'the defaults are the snapshot');
  assert.equal(queued.action_state, 'queued');
  assert.equal(queued.dispatch_key, S.buildPrepareDispatchKey(pending.proposal_id, decisionId, 1));
  assert.equal(S.acceptFromGrant(pending, { grantRef: ATTEMPT, now: NOW }), null, 'another grant');
  assert.equal(S.acceptFromGrant(pending, { grantRef: 'x', now: NOW }), null);
  assert.equal(S.acceptFromGrant(queued, { grantRef: GRANT, now: NOW }), null);
  assert.equal(S.acceptFromGrant(makeSession(2), { grantRef: GRANT, now: NOW }), null, 'an ordinary offer is not grant-backed');
  const offerWithoutGrant = makeSession(3, { initiation: 'user_asked' }, {
    binding: sessionBinding({ session: { effective_initiation: 'offer', authorization_required: true } }),
  });
  assert.equal(S.acceptFromGrant(offerWithoutGrant, { grantRef: GRANT, now: NOW }), null);
});

test('setSessionOptions: pending only, valid options, revision + 1', () => {
  const pending = makeSession();
  const edited = valid(S.setSessionOptions(pending, OPTIONS));
  assert.equal(edited.revision, pending.revision + 1);
  assert.deepEqual(edited.options, OPTIONS);
  assert.equal(S.setSessionOptions(pending, { ...OPTIONS, run_mode: 'bad' }), null);
  assert.equal(S.setSessionOptions(accept(pending, 'new_session'), OPTIONS), null);
  assert.equal(S.setSessionOptions(makeGit(), OPTIONS), null);
  assert.equal(S.setSessionOptions(valid(R.dismissProposal(pending, { decisionId: DECISION, now: NOW })), OPTIONS), null);
});

test('the projection: session display, options, group, links and ungated actions', () => {
  const grouped = makeSession(1, { initiation: 'own_initiative', group_key: 'g', description: 'About it' }, {
    options: OPTIONS, binding: sessionBinding({ session: { effective_initiation: 'own_initiative' } }),
  });
  const ctx = { now: NOW, sessionHandoffSupported: true };
  const p = R.projectProposal(grouped, ctx);
  assert.equal(p.kind, 'session');
  assert.deepEqual(p.display, { title: 'Fix the build', description: 'About it', initiation: 'own_initiative', authorization_required: false });
  assert.equal(p.group_id, grouped.group_id);
  assert.deepEqual(p.options, OPTIONS);
  assert.equal(p.options_editable, true);
  assert.deepEqual(p.links, {
    continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null, child_session_id: null,
    first_turn_turn_id: null, first_turn_work_id: null, preparation_turn_id: null,
  });
  assert.deepEqual(Object.keys(p.actions).sort(), ['cancel', 'dismiss', 'do_it_here', 'new_session', 'retry']);
  assert.deepEqual(p.actions.do_it_here, { available: true, reason: null });
  assert.deepEqual(p.actions.new_session, { available: true, reason: null });
  assert.deepEqual(p.actions.cancel, { available: false, reason: 'not_applicable' });
  assert.deepEqual(R.projectProposal(grouped, { now: NOW }).actions.new_session, { available: false, reason: 'unsupported_capability' });
  assert.deepEqual(R.projectProposal(grouped, { ...ctx, sessionRuntimeSupported: false }).actions.do_it_here,
    { available: false, reason: 'unsupported_capability' });
  for (const mode of [{ runMode: 'plan' }, { readOnly: true }, { lockdown: true }]) {
    const gated = R.projectProposal(grouped, { ...ctx, ...mode });
    assert.equal(gated.actions.do_it_here.available, true, JSON.stringify(mode));
    assert.equal(gated.actions.new_session.available, true, JSON.stringify(mode));
  }
  const dismissed = R.projectProposal(valid(R.dismissProposal(grouped, { decisionId: DECISION, now: NOW })), ctx);
  assert.deepEqual(dismissed.actions.do_it_here, { available: false, reason: 'dismissed' });
  assert.equal(dismissed.options_editable, false);
  const expired = R.projectProposal(grouped, { ...ctx, now: new Date(NOW.getTime() + 8 * 24 * 3600 * 1000) });
  assert.equal(expired.decision_state, 'expired');
  assert.equal(expired.options_editable, false);
  const serialized = JSON.stringify(R.projectProposal(throughHandoff(), ctx));
  for (const secret of ['Do the thing', 'Context', 'binding', 'dispatch', 'sha256', 'child_creation_hash', GRANT]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('the projection follows the session lifecycle for cancel, retry and child links', () => {
  const ctx = { now: NOW, sessionHandoffSupported: true };
  const queued = accept(makeSession(), 'new_session');
  assert.equal(R.projectProposal(queued, ctx).actions.cancel.available, true);
  assert.equal(R.projectProposal(S.releaseWaiting(accept(makeSession(2), 'new_session', { waitForSource: true })), ctx).actions.cancel.available, true);
  const reserved = throughHandoff();
  assert.equal(R.projectProposal(reserved, ctx).actions.cancel.available, false);
  assert.equal(R.projectProposal(reserved, ctx).links.child_session_id, 'sess_child');
  const done = valid(S.markFirstTurnAdmitted(valid(S.markChildCreated(reserved)), { workId: 'wf', turnId: 'tf' }));
  const links = R.projectProposal(done, ctx).links;
  assert.deepEqual([links.first_turn_work_id, links.first_turn_turn_id, links.preparation_turn_id], ['wf', 'tf', 'turn_p']);
  const failed = valid(S.markPreparationFailed(queued, { causeCode: 'deadline' }));
  const failedProjection = R.projectProposal(failed, { ...ctx, runMode: 'plan', readOnly: true });
  assert.deepEqual(failedProjection.actions.retry, { available: true, reason: null }, 'retry is not mode-gated for sessions');
  assert.equal(failedProjection.last_error.reason, 'preparation_failed');
  const doIt = R.projectProposal(accept(makeSession(3), 'do_it_here'), ctx);
  assert.equal(doIt.actions.cancel.available, true);
  assert.equal(doIt.decision.choice, 'do_it_here');
});

test('git and command projections are unchanged by the session additions', () => {
  const git = R.projectProposal(makeGit(), { now: NOW });
  for (const key of ['options', 'group_id', 'options_editable']) assert.equal(Object.hasOwn(git, key), false, key);
  assert.deepEqual(git.links, { continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null });
  assert.deepEqual(Object.keys(git.actions).sort(), ['cancel', 'commit', 'dismiss', 'retry', 'test_first']);
});

