'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tool = require('../services/tools/builtin/exit-plan-mode-tool');

function context(overrides = {}) {
  const storedSession = { plan_mode: true, run_mode: 'plan', pre_plan_run_mode: 'ask' };
  return {
    planMode: true,
    readOnly: true,
    planDecision: 'approved',
    sessionId: 'session_1',
    backendService: {
      async setSessionPreferences(_sessionId, patch) {
        Object.assign(storedSession, patch);
        if (patch.plan_mode === false && !patch.run_mode) storedSession.run_mode = 'ask';
        return { plan_mode: false };
      },
      sessionStore: { getSession: () => ({ ...storedSession }) },
    },
    ...overrides,
  };
}

test('validates malformed and boundary-sized plan payloads', async () => {
  assert.equal((await tool.execute({ title: '', steps: [] }, context())).isError, true);
  const result = await tool.execute({
    title: 't'.repeat(120), summary: 's'.repeat(800),
    steps: Array.from({ length: 20 }, () => 'x'.repeat(300)),
    notes: 'n'.repeat(4000), verification: 'v'.repeat(400),
  }, context());
  assert.equal(result.isError, false);
  assert.equal(result.metadata.plan_mode_cleared, true);
});

// Regression: a real qwen turn produced a verification string over the old
// 400-char cap. boundedString returned null, normalizePlan returned null, no
// pending plan document was recorded, and the user was shown a bare
// exit_plan_mode approval with no plan in it — then the turn died on schema
// validation AFTER they had approved. Over-long fields must clamp, not reject.
test('over-long fields clamp instead of failing the call', async () => {
  const result = await tool.execute({
    title: 'Wire plan approval into the tool loop',
    steps: ['Implement', 'Verify'],
    verification: 'v'.repeat(tool.LIMITS.verification + 500),
    summary: 's'.repeat(tool.LIMITS.summary + 500),
    notes: 'n'.repeat(tool.LIMITS.notes + 500),
  }, context());
  assert.equal(result.isError, false);
  assert.equal(result.metadata.plan_mode_cleared, true);
  const { plan } = result.metadata;
  assert.equal(plan.verification.length, tool.LIMITS.verification);
  assert.equal(plan.summary.length, tool.LIMITS.summary);
  assert.equal(plan.notes.length, tool.LIMITS.notes);
  assert.ok(plan.verification.endsWith('…'), 'clamped text is marked as truncated');
});

test('over-count steps clamp to the limit rather than failing', () => {
  const plan = tool.normalizePlan({
    title: 'Too many steps',
    steps: Array.from({ length: tool.LIMITS.steps + 7 }, (_, i) => `step ${i + 1}`),
  });
  assert.ok(plan, 'an over-long step list still produces a renderable plan');
  assert.equal(plan.steps.length, tool.LIMITS.steps);
  assert.equal(plan.steps[0], 'step 1');
});

test('structurally invalid payloads still fail, and only those', () => {
  assert.equal(tool.normalizePlan({ title: 'No steps', steps: [] }), null);
  assert.equal(tool.normalizePlan({ title: '', steps: ['a'] }), null);
  assert.equal(tool.normalizePlan({ title: 'Bad step type', steps: [42] }), null);
  assert.ok(tool.normalizePlan({ title: 'Minimal', steps: ['only step'] }));
});

test('edited plan replaces title and steps while preserving model-authored detail', async () => {
  const result = await tool.execute({
    title: 'Original', summary: 'Keep summary', steps: ['Old step'],
    notes: 'Keep notes', verification: 'Keep verification',
  }, context({ planEditedPlan: { title: 'Edited', steps: ['New step', 'Verify'] } }));

  assert.deepEqual(result.metadata.plan, {
    title: 'Edited', summary: 'Keep summary', steps: ['New step', 'Verify'],
    notes: 'Keep notes', verification: 'Keep verification',
  });
  assert.equal(result.metadata.plan_edited, true);
});

test('invalid edited plan falls back to the normalized original plan', async () => {
  const original = { title: 'Original', steps: ['Keep step'], notes: 'Keep notes' };
  const result = await tool.execute(original, context({
    planEditedPlan: { title: '', steps: [] },
  }));

  assert.deepEqual(result.metadata.plan, tool.normalizePlan(original));
  assert.equal(Object.hasOwn(result.metadata, 'plan_edited'), false);
});

test('edited approval restates the edited plan in model-visible content', async () => {
  for (const decision of ['approved', 'approved_auto']) {
    const result = await tool.execute(
      { title: 'Original title', steps: ['Original step'] },
      context({
        planDecision: decision,
        planEditedPlan: { title: 'Edited title', steps: ['Edited step'] },
      })
    );

    assert.match(result.content, /The user edited your proposed plan before deciding/);
    assert.match(result.content, /Title: Edited title/);
    assert.match(result.content, /1\. Edited step/);
    assert.deepEqual(result.metadata.plan, tool.normalizePlan({
      title: 'Edited title', steps: ['Edited step'],
    }));
  }
});

test('unedited approval content is unchanged', async () => {
  const approved = await tool.execute(
    { title: 'Original title', steps: ['Original step'] },
    context({ planDecision: 'approved' })
  );
  const approvedAuto = await tool.execute(
    { title: 'Original title', steps: ['Original step'] },
    context({ planDecision: 'approved_auto' })
  );

  assert.equal(
    approved.content,
    'Plan approved. Continue building now under the normal approval policy.'
  );
  assert.equal(
    approvedAuto.content,
    'Plan approved. Continue building without ordinary approval prompts for the remainder of this run.'
  );
});

test('rejected with edits carries the feedback and the edited plan', async () => {
  const result = await tool.execute(
    { title: 'Original title', steps: ['Original step'] },
    context({
      planDecision: 'rejected',
      planFeedback: 'Please revise the rollout.',
      planEditedPlan: { title: 'Edited rejection', steps: ['Use the safer rollout'] },
    })
  );

  assert.match(result.content, /\n\nUser feedback: Please revise the rollout\.\n\n/);
  assert.match(result.content, /The user edited your proposed plan before deciding/);
  assert.match(result.content, /Title: Edited rejection/);
  assert.match(result.content, /1\. Use the safer rollout/);
});

test('accepted with edits keeps its wording and carries the edited plan', async () => {
  const result = await tool.execute(
    { title: 'Original title', steps: ['Original step'] },
    context({
      planDecision: 'accepted',
      planEditedPlan: { title: 'Edited acceptance', steps: ['Keep this plan for later'] },
    })
  );

  assert.match(result.content, /does not want it built yet/);
  assert.match(result.content, /The user edited your proposed plan before deciding/);
  assert.match(result.content, /Title: Edited acceptance/);
  assert.match(result.content, /1\. Keep this plan for later/);
});

for (const decision of ['approved', 'approved_auto']) {
  test(`${decision} persists the Plan Mode transition before success`, async () => {
    const writes = [];
    const storedSession = { plan_mode: true, run_mode: 'plan', pre_plan_run_mode: 'ask' };
    const result = await tool.execute(
      { title: 'Build it', steps: ['Implement', 'Verify'] },
      context({
        planDecision: decision,
        backendService: {
          async setSessionPreferences(sessionId, patch) {
            writes.push([sessionId, patch]);
            Object.assign(storedSession, patch);
            if (patch.plan_mode === false && !patch.run_mode) storedSession.run_mode = 'ask';
            return {};
          },
          sessionStore: { getSession: () => ({ ...storedSession }) },
        },
      })
    );
    assert.deepEqual(writes, [[
      'session_1',
      decision === 'approved_auto' ? { plan_mode: false, run_mode: 'auto' } : { plan_mode: false },
    ]]);
    assert.equal(result.metadata.plan_decision, decision);
    assert.equal(result.metadata.plan_mode_cleared, true);
    assert.equal(result.metadata.run_mode_restored, decision === 'approved_auto' ? 'auto' : 'ask');
  });
}

test('approved_auto writes Auto and reports the store-restored run mode', async () => {
  const writes = [];
  const storedSession = { plan_mode: true, run_mode: 'plan', pre_plan_run_mode: 'ask' };
  const backendService = {
    async setSessionPreferences(sessionId, patch) {
      writes.push([sessionId, patch]);
      Object.assign(storedSession, patch);
      return {};
    },
    sessionStore: { getSession: () => ({ ...storedSession }) },
  };

  const result = await tool.execute(
    { title: 'Build it', steps: ['Implement', 'Verify'] },
    context({ planDecision: 'approved_auto', backendService })
  );

  assert.deepEqual(writes, [['session_1', { plan_mode: false, run_mode: 'auto' }]]);
  assert.equal(result.metadata.run_mode_restored, 'auto');
});

test('a read-back miss after a successful write degrades to ask instead of failing', async () => {
  const result = await tool.execute(
    { title: 'Build it', steps: ['Implement', 'Verify'] },
    context({
      planDecision: 'approved',
      backendService: {
        async setSessionPreferences() {
          return {};
        },
        sessionStore: {
          getSession() {
            throw new Error('store read unavailable');
          },
        },
      },
    })
  );
  assert.equal(result.isError, false);
  assert.equal(result.metadata.plan_mode_cleared, true);
  assert.equal(result.metadata.run_mode_restored, 'ask');
});

test('rejection retains Plan Mode and returns bounded feedback', async () => {
  let wrote = false;
  const result = await tool.execute(
    { title: 'Build it', steps: ['Implement'] },
    context({
      planDecision: 'rejected', planFeedback: '',
      backendService: { setSessionPreferences: async () => { wrote = true; } },
    })
  );
  assert.equal(wrote, false);
  assert.equal(result.metadata.plan_mode_cleared, false);
  assert.equal(result.metadata.plan_feedback, '<no feedback given>');
});

test('rejection says the user chose Keep planning and quotes the feedback as theirs', async () => {
  const result = await tool.execute(
    { title: 'Add kiwi', steps: ['Edit README'] },
    context({ planDecision: 'rejected', planFeedback: "instead of kiwi, plan to add 'strawberry'" })
  );
  assert.match(result.content, /^The user did not approve this plan and chose Keep planning\./);
  assert.match(result.content, /submit it again with exit_plan_mode/);
  assert.match(result.content, /\n\nUser feedback: instead of kiwi, plan to add 'strawberry'$/);
  assert.equal(result.metadata.plan_feedback, "instead of kiwi, plan to add 'strawberry'");
});

test('session write failure is structured and leaves Plan Mode active', async () => {
  const result = await tool.execute(
    { title: 'Build it', steps: ['Implement'] },
    context({ backendService: { setSessionPreferences: async () => { throw new Error('disk'); } } })
  );
  assert.equal(result.isError, true);
  assert.equal(result.metadata.plan_mode_cleared, false);
});

test('duplicate proposal is rejected while another proposal is pending', async () => {
  const backendService = {
    _planDocumentsByStream: new Map([['stream', { callId: 'first', state: 'pending' }]]),
    setSessionPreferences: async () => ({}),
  };
  const result = await tool.execute(
    { title: 'Duplicate', steps: ['Again'] },
    context({ backendService, streamId: 'stream', callId: 'second' })
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /already pending or approved/);
});

test('accepted keeps Plan Mode, writes nothing, and asks for one toolless reply', async () => {
  const writes = [];
  const prepared = [];
  const result = await tool.execute(
    { title: 'Hold it', steps: ['Inspect', 'Verify'] },
    context({
      planDecision: 'accepted',
      executionAuthority: { token: 'binding' },
      backendService: {
        async setSessionPreferences(...args) { writes.push(args); return {}; },
        sessionExecutionAuthority: { preparePlanExit: (...args) => { prepared.push(args); return () => {}; } },
        sessionStore: { getSession: () => ({ plan_mode: true, run_mode: 'plan' }) },
      },
    })
  );
  assert.equal(result.isError, false);
  assert.deepEqual(writes, []);
  assert.deepEqual(prepared, [], 'accepting is not execution authority');
  assert.equal(result.metadata.plan_decision, 'accepted');
  assert.equal(result.metadata.plan_mode_cleared, false);
  assert.equal(result.metadata.turn_disposition, 'final_reply');
  assert.deepEqual(result.metadata.plan, tool.normalizePlan({ title: 'Hold it', steps: ['Inspect', 'Verify'] }));
  assert.match(result.content, /does not want it built yet/);
  assert.deepEqual([...tool.PLAN_DECISIONS], ['approved', 'approved_auto', 'accepted', 'rejected']);
});
