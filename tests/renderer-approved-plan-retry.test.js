'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveApprovedPlanContext } = require('../services/backend/approved-plan-context');
const { createControllerHarness } = require('./helpers/send-controller-harness');

test('retry after Build it starts the approved revised plan in its approval mode', async (t) => {
  const originalPrompt = 'Plan how to add c1-notes.md with three fruits.';
  const messages = [
    { id: 'user_plan', role: 'user', content: originalPrompt },
    {
      id: 'plan_document_fruits', role: 'assistant', kind: 'plan_document', content: '',
      plan_document: {
        plan_id: 'plan_fruits', state: 'rejected', title: 'Add c1-notes.md',
        steps: ['Write apple, banana, and cherry'], feedback: 'Use vegetables instead',
      },
    },
    {
      id: 'plan_document_vegetables', role: 'assistant', kind: 'plan_document', content: '',
      plan_document: {
        plan_id: 'plan_vegetables', state: 'approved', title: 'Add c1-veggies.md',
        steps: ['Write carrot, broccoli, and spinach'],
      },
    },
    {
      id: 'todo_write', role: 'assistant', kind: 'tool_use',
      tool_call: { tool_name: 'todo_write', input: { todos: [{ status: 'in_progress' }] } },
    },
    {
      id: 'assistant_failed_build', role: 'assistant', status: 'runtime_error', content: '',
      stream_error: 'Approval timed out', error_code: 'CMP-APPROVAL-TIMEOUT',
    },
  ];
  const harness = createControllerHarness(messages, {
    // Prove the retry uses the mode selected by Build it, not the currently selected mode.
    runtimePreferences: { runMode: 'auto', planMode: false },
  });
  t.after(() => harness.restore());

  const result = await harness.controller.handleRegenerateMessage(
    'assistant_failed_build',
    { failureRetry: true }
  );

  assert.equal(result.streamId, 'stream-regen');
  assert.equal(harness.calls.editAndRegenerate.length, 0, 'does not rewind to the planning prompt');
  assert.equal(harness.calls.startStream.length, 1);
  const retryRequest = harness.calls.startStream[0];
  assert.equal(retryRequest.prompt, 'Build the accepted plan.');
  assert.equal(retryRequest.approvalMode, 'prompt');
  assert.equal(retryRequest.planMode, false);
  assert.equal('editedMessageId' in retryRequest, false);
  assert.doesNotMatch(retryRequest.prompt, /fruits|c1-notes\.md/i);
  assert.deepEqual(
    deriveApprovedPlanContext(harness.state.messagesBySession.get('session-1')),
    {
      plan_id: 'plan_vegetables', title: 'Add c1-veggies.md', summary: '',
      steps: ['Write carrot, broccoli, and spinach'], notes: '', verification: '',
    },
    'the normal send path carries the latest approved plan from canonical history'
  );
});

test('retry before a plan decision keeps the existing planning-turn behavior', async (t) => {
  const originalPrompt = 'Plan how to add c1-notes.md with three fruits.';
  const harness = createControllerHarness([
    { id: 'user_plan', role: 'user', content: originalPrompt },
    {
      id: 'plan_document_pending', role: 'assistant', kind: 'plan_document', content: '',
      plan_document: {
        plan_id: 'plan_pending', state: 'pending', title: 'Add c1-notes.md',
        steps: ['Write apple, banana, and cherry'],
      },
    },
    { id: 'assistant_failed_plan', role: 'assistant', status: 'runtime_error', content: '' },
  ]);
  t.after(() => harness.restore());

  await harness.controller.handleRegenerateMessage('assistant_failed_plan', { failureRetry: true });

  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.editAndRegenerate.length, 1);
  assert.equal(harness.calls.editAndRegenerate[0].prompt, originalPrompt);
  assert.equal(harness.calls.editAndRegenerate[0].editedMessageId, 'user_plan');
});


function approvedPlanHistory() {
  return [
    { id: 'user_plan', role: 'user', content: 'Plan how to add c1-notes.md with three fruits.' },
    {
      id: 'plan_document_vegetables', role: 'assistant', kind: 'plan_document', content: '',
      plan_document: { plan_id: 'plan_vegetables', state: 'approved', title: 'Add c1-veggies.md',
        steps: ['Write carrot, broccoli, and spinach'] },
    },
  ];
}

test('regenerating a successful build keeps the ordinary regenerate path', async (t) => {
  const harness = createControllerHarness([
    ...approvedPlanHistory(),
    { id: 'assistant_done', role: 'assistant', status: 'complete', content: 'Wrote c1-veggies.md.' },
  ], { runtimePreferences: { runMode: 'auto', planMode: false } });
  t.after(() => harness.restore());

  await harness.controller.handleRegenerateMessage('assistant_done');

  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.editAndRegenerate.length, 1);
  assert.equal(harness.calls.editAndRegenerate[0].editedMessageId, 'user_plan');
});

test('a second retry of a failed build keeps the mode Build it chose', async (t) => {
  const harness = createControllerHarness([
    ...approvedPlanHistory(),
    { id: 'assistant_failed_build', role: 'assistant', status: 'runtime_error', content: '',
      stream_error: 'Approval timed out' },
    { id: 'user_build_retry', role: 'user', content: 'Build the accepted plan.' },
    { id: 'assistant_failed_retry', role: 'assistant', status: 'runtime_error', content: '',
      stream_error: 'Approval timed out' },
  ], { runtimePreferences: { runMode: 'auto', planMode: false } });
  t.after(() => harness.restore());

  await harness.controller.handleRegenerateMessage('assistant_failed_retry', { failureRetry: true });

  assert.equal(harness.calls.editAndRegenerate.length, 1);
  assert.equal(harness.calls.editAndRegenerate[0].editedMessageId, 'user_build_retry');
  assert.equal(harness.calls.editAndRegenerate[0].approvalMode, 'prompt');
});
