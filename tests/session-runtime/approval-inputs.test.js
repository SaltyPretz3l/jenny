'use strict';
const { createHash } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { hasDurableProof } = require('../../services/backend/conversation-store-port');
const { setup, proposal, frozenInput, frozenInputBytes, toolCalls, hash, stableJson, work, continuation } = require('../helpers/canonical-continuation-fixture');

function approvalBundleProposal() {
  const input = { ...proposal(), decision: { kind: 'approval', decision_id: 'decision_1',
    call_id: 'call_1', execution_started: false } };
  const later = { ...frozenInput(), call_id: 'call_2', visible_tool_arguments: toolCalls()[1].arguments,
    effective_tool_arguments: toolCalls()[1].arguments, injected_arg_keys: [],
    effective_args_fingerprint: hash(toolCalls()[1].arguments) };
  const leaves = [frozenInputBytes(), Buffer.from(stableJson(later)).toString('base64')];
  const bundle = { schema_version: 1, inputs: leaves.map(bytes => ({ frozen_input_bytes: bytes,
    frozen_input_sha256: createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex') })) };
  return { input, bundle };
}
function attachBundle(input, bundle) {
  const bytes = Buffer.from(stableJson(bundle));
  return { ...input, approval_inputs_bytes: bytes.toString('base64'),
    approval_inputs_sha256: createHash('sha256').update(bytes).digest('hex') };
}
test('approval bundle version retains every exact input across reload and opaque reference binding', t => {
  const { store, file } = setup(t);
  const { input, bundle } = approvalBundleProposal();
  const proposalWithBundle = attachBundle(input, bundle);
  const candidate = store.conversationStore.preparePendingContinuation('session_1', proposalWithBundle, work());
  assert.equal(candidate.entry.schema_version, 3);
  assert.equal(candidate.entry.body.approval_inputs_bytes, proposalWithBundle.approval_inputs_bytes);
  assert.equal(candidate.approvalInputsRef.sha256, proposalWithBundle.approval_inputs_sha256);
  assert.equal(hasDurableProof(store.conversationStore.publishPendingContinuation(candidate)), true);
  const checkpoint = { ...continuation(candidate), decision: input.decision, approval_inputs_ref: candidate.approvalInputsRef };
  const port = new ElectronSessionStore(file).conversationStore;
  const resolved = port.resolvePendingContinuation(checkpoint, work(), { includePayload: true });
  assert.equal(resolved.valid, true);
  assert.equal(resolved.approvalInputsBytes, proposalWithBundle.approval_inputs_bytes);
  assert.equal(resolved.frozenInputBytes, frozenInputBytes());
  assert.equal(port.resolvePendingContinuation({ ...checkpoint, approval_inputs_ref: null }, work()).valid, false);
  assert.equal(port.resolvePendingContinuation({ ...checkpoint, approval_inputs_ref: {
    ...candidate.approvalInputsRef, sha256: 'f'.repeat(64) } }, work()).valid, false);
});
for (const mutation of ['missing', 'reordered', 'first_bytes', 'later_digest', 'later_call', 'later_scope', 'later_mutation', 'extra', 'oversized']) {
  test(`approval bundle rejects ${mutation} before publication and on stored-entry validation`, t => {
    const { store } = setup(t);
    const { input, bundle } = approvalBundleProposal();
    const candidate = store.conversationStore.preparePendingContinuation('session_1', attachBundle(input, bundle), work());
    if (mutation === 'missing') bundle.inputs.pop();
    if (mutation === 'reordered') bundle.inputs.reverse();
    if (mutation === 'first_bytes') bundle.inputs[0] = bundle.inputs[1];
    if (mutation === 'later_digest') bundle.inputs[1].frozen_input_sha256 = 'f'.repeat(64);
    if (mutation === 'extra') bundle.extra = true;
    if (mutation === 'oversized') bundle.inputs[1].frozen_input_bytes = 'x'.repeat(2 * 1024 * 1024);
    if (['later_call', 'later_scope', 'later_mutation'].includes(mutation)) {
      const later = JSON.parse(Buffer.from(bundle.inputs[1].frozen_input_bytes, 'base64'));
      if (mutation === 'later_call') later.call_id = 'other';
      if (mutation === 'later_scope') later.execution_context_payload.root_revision++;
      if (mutation === 'later_mutation') later.execution_context_payload._jenny_change_set_id = 'change_1';
      const bytes = Buffer.from(stableJson(later));
      bundle.inputs[1] = { frozen_input_bytes: bytes.toString('base64'),
        frozen_input_sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const changed = attachBundle(input, bundle);
    assert.throws(() => store.conversationStore.preparePendingContinuation('session_1', changed, work()));
    const entry = structuredClone(candidate.entry);
    entry.body.approval_inputs_bytes = changed.approval_inputs_bytes;
    entry.sha256 = hash(entry.body);
    const { strictHeader } = require('../../services/backend/runtime-continuation-records');
    assert.throws(() => strictHeader({ schema_version: 1, entries: [entry] }));
    assert.equal(store.getSession('session_1').runtime_continuations.entries.length, 0);
  });
}
test('repeated approval pause keeps later effective inputs and permits only authority revision rebinding', () => {
  const { assertApprovalInputProgress } = require('../../services/backend/runtime-approval-inputs');
  const { input, bundle } = approvalBundleProposal();
  const before = { approvalInputsBytes: attachBundle(input, bundle).approval_inputs_bytes, frozenFirstInput: input.frozen_input };
  const next = structuredClone(bundle);
  for (const leaf of next.inputs) {
    const value = JSON.parse(Buffer.from(leaf.frozen_input_bytes, 'base64'));
    value.execution_context_payload.authority_revision = 'authority_new';
    const bytes = Buffer.from(stableJson(value));
    leaf.frozen_input_bytes = bytes.toString('base64');
    leaf.frozen_input_sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  const after = { approvalInputsBytes: attachBundle(input, next).approval_inputs_bytes, frozenFirstInput: input.frozen_input };
  assert.doesNotThrow(() => assertApprovalInputProgress(before, after, toolCalls()));
  assert.throws(() => assertApprovalInputProgress(before, { frozenFirstInput: input.frozen_input }, toolCalls()));
  const changed = JSON.parse(Buffer.from(next.inputs[1].frozen_input_bytes, 'base64'));
  changed.execution_context_payload.expected_read_snapshot = { revision: 2 };
  const bytes = Buffer.from(stableJson(changed));
  next.inputs[1] = { frozen_input_bytes: bytes.toString('base64'), frozen_input_sha256: createHash('sha256').update(bytes).digest('hex') };
  after.approvalInputsBytes = attachBundle(input, next).approval_inputs_bytes;
  assert.throws(() => assertApprovalInputProgress(before, after, toolCalls()));
});


test('repeated approval proof rejects a coordinated reorder of saved calls and matching frozen inputs', () => {
  const { assertDecisionProgress } = require('../../services/backend/runtime-decision-proof');
  const { input, bundle } = approvalBundleProposal();
  const previous = { decision: input.decision, completed_effect_refs: [], approval_inputs_ref: {},
    position: { tool_call_limit: 8, tool_calls_consumed: 2, current_iteration: 1,
      completed_iterations: 1, remaining_iterations: 4, active_budget_ms_remaining: 5000 } };
  const current = { ...structuredClone(previous), prior_effect_count: 0,
    decision: { ...input.decision, decision_id: 'decision_2' } };
  const before = { frozenFirstInput: input.frozen_input,
    approvalInputsBytes: attachBundle(input, bundle).approval_inputs_bytes };
  assert.doesNotThrow(() => assertDecisionProgress(previous, current, toolCalls(), toolCalls(), before, before));
  bundle.inputs.reverse();
  const after = { frozenFirstInput: JSON.parse(Buffer.from(bundle.inputs[0].frozen_input_bytes, 'base64')),
    approvalInputsBytes: attachBundle(input, bundle).approval_inputs_bytes };
  current.decision.call_id = 'call_2';
  assert.throws(() => assertDecisionProgress(previous, current, toolCalls(), toolCalls().reverse(), before, after),
    /runtime_decision_pending_order_changed/);
  const newCall = { ...toolCalls()[0], call_id: 'new' };
  current.position.tool_calls_consumed++;
  assert.throws(() => assertDecisionProgress(previous, current, toolCalls(), [newCall, ...toolCalls()], before, before),
    /runtime_decision_pending_order_changed/);
});
