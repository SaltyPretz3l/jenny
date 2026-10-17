'use strict';

/* ChatProposalService (row 59 checkpoint 3): publish idempotency and caps, the
 * get/list/decide bridge, the D6 mode gate, D7 binding drift, expiry, command Run
 * unavailability, the checkpoint-5 methods and durable-write failure handling. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const R = require('../services/backend/chat-proposal-records');
const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { createFixture } = require('./helpers/chat-proposal-service-fixture');

const envelope = (code, reason, extra = {}) => ({
  schema_version: 1, ok: false, error_code: code, reason, retryable: false, current_revision: null, ...extra,
});

test('publish creates once, replays identical input and conflicts on different input', async (t) => {
  const fx = createFixture(t);
  const first = await fx.publishGit(1);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.proposal.decision_state, 'pending');
  assert.equal(first.proposal.revision, 1);
  assert.equal(first.proposal.display.path_count, 2);
  assert.deepEqual(fx.rail, [fx.sessionId], 'the session rail is told');
  assert.deepEqual(fx.events.map((event) => [event.session_id, event.revision]), [[fx.sessionId, 1]]);

  const again = await fx.publishGit(1);
  assert.equal(again.created, false);
  assert.equal(again.proposal.proposal_id, first.proposal.proposal_id);
  assert.equal(fx.rail.length, 1, 'a replay is not a mutation');

  const changed = await fx.publishGit(1, { summary: 'Something else entirely.' });
  assert.deepEqual([changed.ok, changed.reason, changed.error_code], [false, 'idempotency_conflict', CODES.IDEMPOTENCY_CONFLICT]);
  assert.equal(JSON.stringify(first).includes('binding'), false, 'the projection never carries the binding');
});

test('publish refuses a bad identity, an unknown session and a bad record without writing', async (t) => {
  const fx = createFixture(t);
  const input = R.normalizeGitProposalInput({ summary: 's', question: 'q', paths: ['a.js'] }).value;
  const base = { kind: 'git', sessionId: fx.sessionId, sessionIncarnation: 'inc', turnId: 't', toolCallId: 'c', input };
  assert.equal((await fx.service.publish({ ...base, sessionId: 'sess_missing', binding: {} })).reason, 'not_found');
  assert.equal((await fx.service.publish({ ...base, toolCallId: '', binding: {} })).reason, 'invalid_request');
  assert.equal((await fx.service.publish({ ...base, kind: 'session', binding: {} })).reason, 'invalid_request');
  assert.equal((await fx.service.publish({ ...base, binding: { nonsense: true } })).reason, 'invalid_request');
  assert.equal((await fx.service.publish(undefined)).ok, false);
  assert.equal(fx.proposalStore.read(fx.sessionId).records.length, 0);
  assert.equal(fx.rail.length, 0);
});

test('publish caps unresolved proposals per source session and per profile without pruning', async (t) => {
  const fx = createFixture(t);
  for (let n = 1; n <= R.PROPOSAL_LIMITS.unresolved_per_source; n += 1) {
    assert.equal((await fx.publishGit(n)).ok, true, `proposal ${n}`);
  }
  const over = await fx.publishGit(99);
  assert.deepEqual([over.ok, over.reason, over.error_code], [false, 'capacity', CODES.CAPACITY]);
  assert.equal(fx.proposalStore.read(fx.sessionId).records.length, 20, 'nothing was pruned to make room');

  const profile = createFixture(t, { profileUnresolved: R.PROPOSAL_LIMITS.unresolved_per_profile });
  assert.equal((await profile.publishGit(1)).reason, 'capacity');
});

test('get returns the projection, not_found otherwise, and rejects unknown keys and bad ids', async (t) => {
  const fx = createFixture(t);
  const { proposal } = await fx.publishCommand(1);
  const got = await fx.service.get(fx.request({ proposal_id: proposal.proposal_id }));
  assert.equal(got.ok, true);
  assert.equal(got.proposal.display.command, 'npm test');
  assert.equal(got.proposal.actions.run.available, false);
  assert.equal(got.proposal.actions.run.reason, 'unsupported_capability');
  assert.equal(got.proposal.actions.dismiss.available, true);

  const missing = await fx.service.get(fx.request({ proposal_id: `proposal_${'0'.repeat(64)}` }));
  assert.deepEqual(missing, envelope(CODES.UNAVAILABLE, 'not_found'));
  const unknownSession = await fx.service.get({ schema_version: 1, session_id: 'sess_nope', proposal_id: proposal.proposal_id });
  assert.equal(unknownSession.reason, 'not_found');

  for (const bad of [
    fx.request({ proposal_id: proposal.proposal_id, extra: 1 }),
    fx.request({ proposal_id: 'nope' }),
    { schema_version: 2, session_id: fx.sessionId, proposal_id: proposal.proposal_id },
    { session_id: fx.sessionId, proposal_id: proposal.proposal_id },
    null,
    'x',
  ]) {
    const result = await fx.service.get(bad);
    assert.deepEqual([result.ok, result.reason, result.error_code], [false, 'invalid_request', CODES.INVALID_REQUEST]);
  }
});

test('list pages by created_at then id with a cursor bound to session and revision', async (t) => {
  const fx = createFixture(t);
  const ids = [];
  for (let n = 1; n <= 3; n += 1) {
    ids.push((await fx.publishGit(n)).proposal.proposal_id);
    fx.clock.ms += 1000;
  }
  const page1 = await fx.service.list(fx.request({ limit: 2 }));
  assert.equal(page1.ok, true);
  assert.deepEqual(page1.items.map((item) => item.proposal_id), ids.slice(0, 2));
  assert.equal(typeof page1.next_cursor, 'string');
  assert.equal(page1.revision, 3);
  const page2 = await fx.service.list(fx.request({ limit: 2, cursor: page1.next_cursor }));
  assert.deepEqual(page2.items.map((item) => item.proposal_id), ids.slice(2));
  assert.equal(page2.next_cursor, null);
  const all = await fx.service.list(fx.request());
  assert.equal(all.items.length, 3);
  assert.equal(all.next_cursor, null);

  await fx.decide(page1.items[0], 'dismiss');
  const stale = await fx.service.list(fx.request({ limit: 2, cursor: page1.next_cursor }));
  assert.deepEqual([stale.reason, stale.error_code, stale.retryable], ['stale_cursor', CODES.STALE_REVISION, true]);
  assert.equal(stale.current_revision, 4);

  for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: 'not a cursor!' }, { cursor: 'bm9wZQ' }, { extra: 1 }]) {
    assert.equal((await fx.service.list(fx.request(bad))).ok, false, JSON.stringify(bad));
  }
});

test('dismiss persists, replays by decision id and conflicts on a different payload', async (t) => {
  const fx = createFixture(t);
  const { proposal } = await fx.publishGit(1);
  const decisionId = randomUUID();
  const request = fx.request({ proposal_id: proposal.proposal_id, expected_revision: 1, decision_id: decisionId, choice: 'dismiss' });
  const done = await fx.service.decide(request);
  assert.equal(done.ok, true);
  assert.equal(done.created, true);
  assert.deepEqual([done.proposal.decision_state, done.proposal.action_state, done.proposal.revision], ['dismissed', 'none', 2]);
  assert.equal(done.proposal.decision.choice, 'dismiss');

  const replay = await fx.service.decide(request);
  assert.equal(replay.created, false);
  assert.equal(replay.proposal.revision, 2, 'replay answers before any revision check');
  const conflict = await fx.service.decide({ ...request, choice: 'commit' });
  assert.deepEqual([conflict.reason, conflict.error_code], ['idempotency_conflict', CODES.IDEMPOTENCY_CONFLICT]);

  const stale = await fx.service.decide({ ...request, decision_id: randomUUID() });
  assert.deepEqual([stale.reason, stale.error_code, stale.current_revision], ['stale_revision', CODES.STALE_REVISION, 2]);
  const closed = await fx.service.decide({ ...request, decision_id: randomUUID(), expected_revision: 2, choice: 'dismiss' });
  assert.equal(closed.reason, 'not_pending');
  assert.equal(fx.runtime.submits.length, 0, 'dismiss causes no work');
});

test('decide validates the closed request and the kind-specific choice', async (t) => {
  const fx = createFixture(t);
  const git = (await fx.publishGit(1)).proposal;
  const command = (await fx.publishCommand(2)).proposal;
  const good = { proposal_id: git.proposal_id, expected_revision: 1, decision_id: randomUUID(), choice: 'commit' };
  for (const bad of [
    { ...good, choice: 'merge' }, { ...good, decision_id: 'not-a-uuid' }, { ...good, expected_revision: 0 },
    { ...good, expected_revision: 1.5 }, { ...good, extra: true }, { ...good, confirmed_preconditions: [0, 0] },
    { ...good, confirmed_preconditions: [9] }, { ...good, confirmed_preconditions: 'x' },
    { proposal_id: good.proposal_id, expected_revision: 1, choice: 'commit' },
  ]) {
    assert.equal((await fx.service.decide(fx.request(bad))).reason, 'invalid_request', JSON.stringify(bad));
  }
  const wrongKind = await fx.service.decide(fx.request({ ...good, choice: 'run' }));
  assert.equal(wrongKind.reason, 'invalid_request');
  const commandCommit = await fx.service.decide(fx.request({ ...good, proposal_id: command.proposal_id, choice: 'commit' }));
  assert.equal(commandCommit.reason, 'invalid_request');
  assert.equal(fx.runtime.submits.length, 0);
});

test('the D6 mode gate refuses commit, test_first and run in Plan mode and a read-only session; dismiss stays', async (t) => {
  const fx = createFixture(t);
  const git = (await fx.publishGit(1)).proposal;
  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'plan' });
  const planned = await fx.decide(git, 'commit');
  assert.deepEqual([planned.ok, planned.reason, planned.error_code], [false, 'plan_mode', CODES.UNAVAILABLE]);
  const projected = await fx.get(git.proposal_id);
  assert.equal(projected.actions.commit.reason, 'plan_mode');
  assert.equal(projected.actions.dismiss.available, true);

  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'propose' });
  const readOnly = await fx.decide(git, 'test_first');
  assert.equal(readOnly.reason, 'read_only');

  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'ask' });
  const dismissedInPlan = await (async () => {
    fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'plan' });
    return fx.decide(git, 'dismiss');
  })();
  assert.equal(dismissedInPlan.ok, true, 'dismiss stays available in Plan mode');
  assert.equal(fx.runtime.submits.length, 0);
});

test('a pending proposal past seven days is expired: refused, then persisted on read', async (t) => {
  const fx = createFixture(t);
  const git = (await fx.publishGit(1)).proposal;
  const other = (await fx.publishGit(2)).proposal;
  fx.advanceDays(8);
  const refused = await fx.decide(git, 'commit');
  assert.deepEqual([refused.ok, refused.reason, refused.error_code], [false, 'expired', CODES.EXPIRED]);
  assert.equal(fx.record(git.proposal_id).decision_state, 'expired');
  assert.equal(fx.runtime.submits.length, 0);
  const swept = await fx.get(other.proposal_id);
  assert.equal(swept.decision_state, 'expired');
  assert.equal(fx.record(other.proposal_id).decision_state, 'expired', 'the read persisted the expiry');
  const later = await fx.decide(swept, 'dismiss');
  assert.equal(later.reason, 'expired');
});

test('D7 binding drift marks the record stale with authority_changed and refuses further choices', async (t) => {
  const fx = createFixture(t, { recheck: async () => ({ ok: false, cause_code: 'head_changed' }) });
  const git = (await fx.publishGit(1)).proposal;
  const result = await fx.decide(git, 'commit');
  assert.deepEqual([result.ok, result.reason, result.error_code, result.retryable], [false, 'authority_changed', CODES.AUTHORITY_CHANGED, false]);
  const record = fx.record(git.proposal_id);
  assert.equal(record.decision_state, 'stale');
  assert.equal(record.action_state, 'none');
  assert.deepEqual(record.last_error, {
    code: CODES.AUTHORITY_CHANGED, reason: 'authority_changed', retryable: false, cause_code: 'head_changed',
  });
  const next = await fx.service.decide(fx.request({
    proposal_id: git.proposal_id, expected_revision: record.revision, decision_id: randomUUID(), choice: 'test_first',
  }));
  assert.equal(next.reason, 'authority_changed');
  assert.equal(fx.runtime.submits.length, 0);
  assert.equal((await fx.get(git.proposal_id)).actions.commit.available, false);
});

test('a recapture that could not finish is retryable and leaves the proposal pending', async (t) => {
  for (const [cause, reason] of [['unavailable', 'unavailable'], ['binding_budget', 'capacity']]) {
    const fx = createFixture(t, { recheck: async () => ({ ok: false, cause_code: cause }) });
    const git = (await fx.publishGit(1)).proposal;
    const result = await fx.decide(git, 'commit');
    assert.deepEqual([result.ok, result.reason, result.retryable], [false, reason, true], cause);
    assert.equal(fx.record(git.proposal_id).decision_state, 'pending');
  }
  const throwing = createFixture(t, { recheck: async () => { throw new Error('C:\\secret\\path'); } });
  const git = (await throwing.publishGit(1)).proposal;
  const result = await throwing.decide(git, 'commit');
  assert.equal(result.reason, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /secret/u);
});

test('command Run is unsupported_capability without a command adapter and changes nothing; Copy needs no call', async (t) => {
  const fx = createFixture(t);
  const command = (await fx.publishCommand(1)).proposal;
  const revision = fx.proposalStore.read(fx.sessionId).coordination_revision;
  const result = await fx.decide(command, 'run');
  assert.deepEqual([result.ok, result.reason, result.error_code], [false, 'unsupported_capability', CODES.UNSUPPORTED_CAPABILITY]);
  assert.equal(fx.proposalStore.read(fx.sessionId).coordination_revision, revision);
  assert.equal(fx.record(command.proposal_id).decision_state, 'pending');
  const dismissed = await fx.decide(command, 'dismiss');
  assert.equal(dismissed.ok, true);
});

test('an injected command adapter enables Run and receives the durable submission', async (t) => {
  const submits = [];
  const adapter = {
    isSupported: () => true,
    recheck: async () => ({ ok: true }),
    submit: async (args) => { submits.push(args); return { ok: true, created: true, work_id: 'work_a', turn_id: 'turn_a' }; },
  };
  const fx = createFixture(t, { commandAdapter: adapter });
  const command = (await fx.publishCommand(1)).proposal;
  assert.equal(command.actions.run.available, true);
  const result = await fx.decide(command, 'run');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.proposal.action_state, 'queued');
  assert.equal(submits.length, 1);
  assert.equal(submits[0].commandProposal.proposal_id, command.proposal_id);
  assert.equal(fx.runtime.submits.length, 0);
});

test('the session methods and confirmRestored validate their own closed requests', async (t) => {
  const fx = createFixture(t);
  const result = await fx.service.confirmRestored(fx.request({ whatever: [1, 2] }));
  assert.deepEqual(result, envelope(CODES.INVALID_REQUEST, 'invalid_request'));
  for (const method of ['getCapabilities', 'setOptions', 'startAll', 'confirmRestored', 'authorizeLaunch']) {
    assert.equal((await fx.service[method]({ session_id: 'x' })).reason, 'invalid_request', method);
  }
  for (const method of ['getCapabilities', 'setOptions', 'startAll', 'authorizeLaunch']) {
    const bad = await fx.service[method](fx.request({ whatever: [1, 2] }));
    assert.equal(bad.ok, false, method);
    assert.equal(bad.reason, 'invalid_request', `${method} rejects unknown fields instead of ignoring them`);
  }
});

test('a failed durable write is reported, nothing is acknowledged and memory is unchanged', async (t) => {
  const fx = createFixture(t);
  const git = (await fx.publishGit(1)).proposal;
  const railBefore = fx.rail.length;
  const flush = fx.store.flushSession;
  fx.store.flushSession = () => false;
  const failed = await fx.decide(git, 'dismiss');
  fx.store.flushSession = flush;
  assert.deepEqual([failed.ok, failed.reason, failed.error_code, failed.retryable], [false, 'io_failed', CODES.UNAVAILABLE, true]);
  assert.equal(fx.record(git.proposal_id).decision_state, 'pending');
  assert.equal(fx.rail.length, railBefore);
  const retried = await fx.decide(git, 'dismiss');
  assert.equal(retried.ok, true);
});

test('diagnostics never carry summaries, paths or commands', async (t) => {
  const fx = createFixture(t);
  await fx.publishGit(1, { summary: 'TOPSECRET-SUMMARY', paths: ['secret/PATH.txt'] });
  await fx.publishCommand(2, 'echo TOPSECRET-COMMAND');
  fx.runtime = null;
  const git = (await fx.service.list(fx.request())).items[0];
  await fx.decide(git, 'commit');
  assert.doesNotMatch(JSON.stringify(fx.logs), /TOPSECRET|PATH\.txt/u);
});

test('review #6: a mode flip during the Git binding recheck still refuses Commit (D6 re-read after the await)', async (t) => {
  let fx;
  fx = createFixture(t, { recheck: async () => {
    fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'plan' });
    return { ok: true };
  } });
  const proposal = (await fx.publishGit(1)).proposal;
  const refused = await fx.decide(proposal, 'commit');
  assert.deepEqual([refused.ok, refused.reason], [false, 'plan_mode']);
  assert.equal(fx.runtime.submits?.length ?? 0, 0);
  assert.equal(R.normalizeProposalRecord(fx.proposalStore.read(fx.sessionId).records[0]).decision_state, 'pending');
});

// ---------- cp5b-2: coordination receipts (durable gesture replay) ----------

const receiptsOf = (fx) => fx.store.getSession(fx.sessionId).coordination_receipts;

test('decide writes its gesture receipt in the same mutation as the decision and rolls it back on a failed write', async (t) => {
  const fx = createFixture(t);
  const git = (await fx.publishGit(1)).proposal;
  const flush = fx.store.flushSession;
  fx.store.flushSession = () => false;
  const failed = await fx.decide(git, 'dismiss');
  fx.store.flushSession = flush;
  assert.equal(failed.ok, false);
  assert.deepEqual(receiptsOf(fx), [], 'a failed write keeps no receipt');
  const decisionId = randomUUID();
  const done = await fx.decide(git, 'dismiss', { decision_id: decisionId });
  assert.equal(done.ok, true);
  const [receipt] = receiptsOf(fx);
  assert.equal(receipt.mutation_id, decisionId);
  assert.equal(receipt.method, 'sessionProposals.decide');
  assert.equal(receipt.resource_kind, 'proposal');
  assert.equal(receipt.resource_id, git.proposal_id);
  assert.equal(receipt.accepted_revision, fx.store.getSession(fx.sessionId).coordination_revision);
  assert.notEqual(receipt.settled_at, null);
  assert.equal(receipt.args_sha256, R.sha256Hex(R.canonicalJson({ proposal_id: git.proposal_id, choice: 'dismiss', expected_revision: git.revision })));
  assert.equal(receiptsOf(fx).length, 1);
  assert.equal((await fx.service.decide(fx.request({
    proposal_id: git.proposal_id, expected_revision: git.revision, decision_id: decisionId, choice: 'dismiss',
  }))).created, false, 'replay is unchanged');
  assert.equal(receiptsOf(fx).length, 1, 'a replay adds no receipt');
});

test('a retry gesture replays from its durable receipt after the in-memory cache is gone', async (t) => {
  const fx = createFixture(t);
  fx.runtime.mode = 'lost';
  const { proposal } = await fx.publishGit(1);
  const failed = (await fx.decide(proposal, 'commit')).proposal;
  assert.equal(failed.last_error.reason, 'dispatch_failed');
  fx.runtime.mode = 'ok';
  const request = fx.request({
    proposal_id: failed.proposal_id, expected_revision: failed.revision, decision_id: '55555555-5555-4555-8555-555555555555',
  });
  assert.equal((await fx.service.retry(request)).created, true);
  const submits = fx.runtime.submits.length;
  const stored = receiptsOf(fx).find((receipt) => receipt.mutation_id === request.decision_id);
  assert.equal(stored.method, 'sessionProposals.retry');
  assert.equal(stored.resource_id, failed.proposal_id);
  fx.service._gestures.clear(); // as after a restart
  const replay = await fx.service.retry(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(fx.runtime.submits.length, submits, 'a replay submits nothing');
  const conflict = await fx.service.retry({ ...request, expected_revision: failed.revision + 5 });
  assert.equal(conflict.reason, 'idempotency_conflict');
  const crossed = await fx.service.cancel(request);
  assert.equal(crossed.reason, 'idempotency_conflict', 'the same gesture id cannot be reused for another method');
});

test('a Git retry rechecks the binding: drift withdraws Retry, an unfinished recapture stays retryable', async (t) => {
  const fx = createFixture(t);
  fx.runtime.mode = 'lost';
  const { proposal } = await fx.publishGit(1);
  const failed = (await fx.decide(proposal, 'commit')).proposal;
  assert.equal(failed.actions.retry.available, true);
  fx.runtime.mode = 'ok';
  const submits = fx.runtime.submits.length;
  const retry = (expected) => fx.service.retry(fx.request({
    proposal_id: failed.proposal_id, expected_revision: expected, decision_id: randomUUID(),
  }));

  fx.recheck = async () => ({ ok: false, cause_code: 'binding_budget' });
  const busy = await retry(failed.revision);
  assert.deepEqual([busy.ok, busy.reason, busy.retryable], [false, 'capacity', true]);
  assert.equal(fx.record(failed.proposal_id).revision, failed.revision, 'an unfinished recapture changes nothing');

  fx.recheck = async () => ({ ok: false, cause_code: 'head_changed' });
  const drifted = await retry(failed.revision);
  assert.deepEqual([drifted.ok, drifted.reason, drifted.error_code], [false, 'authority_changed', CODES.AUTHORITY_CHANGED]);
  const record = fx.record(failed.proposal_id);
  assert.deepEqual([record.decision_state, record.action_state], ['accepted', 'needs_attention']);
  assert.deepEqual(record.last_error, {
    code: CODES.AUTHORITY_CHANGED, reason: 'authority_changed', retryable: false, cause_code: 'head_changed',
  });
  assert.equal(fx.runtime.submits.length, submits, 'a drifted retry submits nothing');
  const after = await fx.get(failed.proposal_id);
  assert.equal(after.actions.retry.available, false);
  fx.recheck = async () => ({ ok: true });
  assert.equal((await retry(record.revision)).ok, false, 'Retry stays withdrawn');
  assert.equal(fx.runtime.submits.length, submits);
});

test('a Git retry re-reads the record after the recheck await', async (t) => {
  const fx = createFixture(t);
  fx.runtime.mode = 'lost';
  const { proposal } = await fx.publishGit(1);
  const failed = (await fx.decide(proposal, 'commit')).proposal;
  fx.runtime.mode = 'ok';
  const submits = fx.runtime.submits.length;
  const request = fx.request({ proposal_id: failed.proposal_id, expected_revision: failed.revision, decision_id: randomUUID() });
  let concurrent = null;
  let started = false;
  fx.recheck = async () => {
    if (started) return { ok: true };
    started = true;
    // A concurrent gesture lands while the outer binding is recaptured.
    concurrent = await fx.service.retry(fx.request({ proposal_id: failed.proposal_id, expected_revision: failed.revision, decision_id: randomUUID() }));
    return { ok: true };
  };
  const raced = await fx.service.retry(request);
  assert.equal(concurrent.ok, true);
  assert.deepEqual([raced.ok, raced.reason], [false, 'stale_revision']);
  assert.equal(fx.runtime.submits.length, submits + 1, 'only the winning gesture submitted');
});

test('a cancel gesture replays from its durable receipt after the in-memory cache is gone', async (t) => {
  const fx = createFixture(t);
  const { proposal } = await fx.publishGit(1);
  const accepted = (await fx.decide(proposal, 'commit')).proposal;
  const current = await fx.get(accepted.proposal_id);
  const request = fx.request({
    proposal_id: current.proposal_id, expected_revision: current.revision, decision_id: '66666666-6666-4666-8666-666666666666',
  });
  assert.equal((await fx.service.cancel(request)).created, true);
  const stored = receiptsOf(fx).find((receipt) => receipt.mutation_id === request.decision_id);
  assert.equal(stored.method, 'sessionProposals.cancel');
  fx.service._gestures.clear();
  const replay = await fx.service.cancel(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(fx.runtime.cancels.length, 1, 'the runtime is not asked again');
});
