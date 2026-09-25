'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuotaState, quotaEffects, assertQuotaCoverage, assertQuotaProgress } = require('../../services/session-runtime/quota-state');
const { quotaState } = require('../helpers/quota-state-fixture');
const fixture = require('../helpers/canonical-continuation-fixture');
const { strictHeader } = require('../../services/backend/runtime-continuation-records');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const calls = [{ call_id: 'web_ok', tool_id: 'web_search' }, { call_id: 'web_fail', tool_id: 'web_search' },
  { call_id: 'pending', tool_id: 'read_file' }];
const effects = [{ ...calls[0], success: true }, { ...calls[1], success: false }];

test('quota progress preserves original charges and permits exactly a demonstrated failed-web refund', () => {
  const before = quotaState(calls);
  const after = structuredClone(before);
  after.admissions[1].web_refunded = true;
  after.cooldowns.captured_at_ms += 5000;
  assert.doesNotThrow(() => assertQuotaProgress(before, after, calls.slice(2), effects));
  for (const mutate of [
    state => { state.session_baseline = 0; },
    state => { state.admissions.shift(); },
    state => { state.admissions.reverse(); },
    state => { state.admissions[0].web_refunded = true; },
    state => { state.admissions[2].arguments_sha256 = 'b'.repeat(64); },
    state => { state.policy.web_per_turn = 3; },
    state => { state.cooldowns.captured_at_ms = 99999; },
  ]) {
    const invalid = structuredClone(after); mutate(invalid);
    assert.throws(() => assertQuotaProgress(before, invalid, calls.slice(2), effects), /quota_state/);
  }
  assert.throws(() => assertQuotaProgress(after, before, calls.slice(2), effects), /quota_state/);
  assert.throws(() => assertQuotaProgress(before, null, calls, []), /quota_state/);
  assert.throws(() => assertQuotaCoverage(before, calls.slice(2), []), /quota_state/);
});

test('unexpired cooldowns cannot be shortened or lost except by the matching failed-web refund', () => {
  const before = quotaState(calls);
  before.cooldowns.entries = [{ name: 'web_search', expires_at_ms: 130000, reason: 'web_per_turn' }];
  const after = structuredClone(before); after.cooldowns.captured_at_ms = 110000;
  assert.doesNotThrow(() => assertQuotaProgress(before, after, calls, []));
  after.cooldowns.entries = [];
  assert.throws(() => assertQuotaProgress(before, after, calls, []), /quota_state/);
  after.admissions[1].web_refunded = true;
  assert.doesNotThrow(() => assertQuotaProgress(before, after, calls.slice(2), effects));
  before.cooldowns.entries[0].reason = 'session_tool_budget';
  assert.throws(() => assertQuotaProgress(before, after, calls.slice(2), effects), /quota_state/);
});

test('closed quota snapshots reject unknown state, duplicate identities, foreign timers and malformed counters', () => {
  for (const mutate of [
    state => { state.provider = 'secret'; },
    state => { state.session_baseline = -1; },
    state => { state.session_baseline = Number.MAX_SAFE_INTEGER; },
    state => { state.admissions.push(state.admissions[0]); },
    state => { state.admissions[0].web = 1; },
    state => { state.admissions[2].web_refunded = true; },
    state => { state.enabled = false; },
    state => { state.cooldowns.namespace = 'provider'; },
    state => { state.cooldowns.entries = [{ name: 'web_search', reason: 'web_per_turn', expires_at_ms: 100000 }]; },
  ]) {
    const state = quotaState(calls); mutate(state);
    assert.throws(() => normalizeQuotaState(state), /quota_state/);
  }
});

test('canonical artifact binds quota state across persistence and rejects mismatched or altered proof', t => {
  const state = fixture.setup(t, { includeSafePrefix: false });
  const proposal = fixture.proposal('quota_checkpoint', 0);
  proposal.quota_state = quotaState(proposal.tool_calls);
  const port = state.store.conversationStore;
  const candidate = port.preparePendingContinuation('session_1', proposal, fixture.work());
  port.publishPendingContinuation(candidate);
  const checkpoint = { ...fixture.continuation(candidate), quota_state: proposal.quota_state };
  assert.equal(port.resolvePendingContinuation(checkpoint, fixture.work()).valid, true);
  const entry = state.store.getSession('session_1').runtime_continuations.entries[0];
  assert.equal(entry.schema_version, 5); assert.equal(entry.base_schema_version, 1);
  const corrupt = structuredClone(entry); corrupt.body.quota_state.session_baseline = 0;
  assert.throws(() => strictHeader({ schema_version: 1, entries: [corrupt] }), /digest/);
  assert.equal(port.resolvePendingContinuation(fixture.continuation(candidate), fixture.work()).valid, false);
  state.store.flush();
  const reopened = new ElectronSessionStore(state.file);
  assert.equal(reopened.conversationStore.resolvePendingContinuation(checkpoint, fixture.work()).valid, true);
});


test('legacy lineage may acquire only explicit disabled zero-state proof', () => {
  const state = quotaState(); state.enabled = false; state.session_baseline = 0;
  assert.doesNotThrow(() => assertQuotaProgress(null, state, calls, effects));
  state.enabled = true;
  assert.throws(() => assertQuotaProgress(null, state, calls, effects), /quota_state/);
  state.enabled = false; state.session_baseline = 1;
  assert.throws(() => assertQuotaProgress(null, state, calls, effects), /quota_state/);
});

test('quota projection preserves accounting without replacing mutation effect proof', () => {
  const event = { kind: 'tool_result', tool_call_id: 'write_1', payload: {
    tool_name: 'write_file', success: true, tool_output_summary: 'written',
    metadata: { workspace_change_set: { change_set_id: 'change_1' } } } };
  assert.deepEqual(quotaEffects([event]), [{ call_id: 'write_1', tool_id: 'write_file', success: true }]);
  assert.throws(() => require('../../services/session-runtime/continuation-effect-refs').completedEffectRefs([event]), /effects_unproven/);
  assert.throws(() => quotaEffects([event, event]), /quota_state/);
  assert.throws(() => quotaEffects([{ ...event, payload: { ...event.payload, success: null } }]), /quota_state/);
});
