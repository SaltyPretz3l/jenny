// DOM-level regression for a live exit_plan_mode approval plan card.
// On the pre-fix tree the row-model-off arm passes while row-model-on fails;
// that asymmetry is the bug, and explains the Aug-30 field report that saw the
// card render.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

function buildSession(sessionId, overrides = {}) {
  return {
    id: sessionId,
    title: `Session ${sessionId}`,
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    context_preferences: {
      history_scope: 'session',
      include_personality: true,
      include_memory: true,
    },
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

async function runPlanApprovalScenario(t, {
  sessionId, streamId, rowModelEnabled, omitToolUseEvent,
}) {
  const approvals = [];
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [buildSession(sessionId, {
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
          })];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId };
        },
      },
      tools: {
        async approve(approvalId, payload) {
          approvals.push([approvalId, { ...payload }]);
          return true;
        },
      },
    },
  });
  const doc = window.document;
  const rendererState = window.__rendererState;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  input.value = 'Plan the fix';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  if (rowModelEnabled === false) {
    if (!(rendererState.ui.chatTimelineRowModelBySession instanceof Map)) {
      rendererState.ui.chatTimelineRowModelBySession = new Map();
    }
    rendererState.ui.chatTimelineRowModelBySession.set(sessionId, false);
  }

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-plan-dom', text: 'I should propose a plan for the user.' }],
    },
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Here is the plan. ',
    aggregate: 'Here is the plan. ',
  });
  if (omitToolUseEvent !== true) {
    await shell.__emitChat({
      type: 'tool_use',
      sessionId,
      streamId,
      callId: 'call-plan-dom',
      toolName: 'exit_plan_mode',
      summary: 'Review implementation plan',
      input: {},
      status: 'pending_approval',
    });
  }
  await shell.__emitChat({
    type: 'tool_approval_needed',
    sessionId,
    streamId,
    callId: 'call-plan-dom',
    approvalId: 'approval-plan-dom',
    toolName: 'exit_plan_mode',
    input: {},
    policyScope: 'Plan execution',
    policyConsequence: 'May execute the approved plan.',
    planDocument: {
      plan_id: 'plan-dom-1',
      tool_call_id: 'call-plan-dom',
      approval_id: 'approval-plan-dom',
      state: 'pending',
      title: 'Ship the fix',
      steps: ['Read', 'Write', 'Test'],
      files_read: ['a.js'],
      parent_stream_id: streamId,
    },
  });
  await waitForUi(window, 80);

  assert.equal(rendererState.pendingToolApprovals.size, 1, 'approval should be pending in state');

  const timeline = doc.getElementById('chatTimeline');
  const planDocument = timeline.querySelector('section.plan-document[data-plan-state="pending"]');
  assert.ok(
    planDocument,
    `expected a pending plan document in the timeline DOM; timeline HTML was:\n${String(timeline.innerHTML || '').slice(0, 6000)}`
  );
  assert.equal(planDocument.querySelectorAll('[data-plan-decision]').length, 3);
  // Exactly one card: the live reducer row and the message-path twin must
  // dedup, never render side by side.
  assert.equal(timeline.querySelectorAll('[data-plan-document="true"]').length, 1);

  const approvalGap = timeline.querySelector('[data-approval-variant="plan"]');
  assert.ok(approvalGap, 'expected the buttonless plan approval gap');
  assert.equal(approvalGap.querySelector('.tool-approve-btn'), null);

  planDocument.querySelector('[data-plan-decision="approved"]').click();
  await waitForUi(window, 20);
  assert.deepEqual(approvals, [[
    'approval-plan-dom',
    { decision: 'approved', feedback: '<no feedback given>' },
  ]]);
}

test('live plan approval renders its plan card and decisions (row model on)', async (t) => {
  await runPlanApprovalScenario(t, {
    sessionId: 'session-plan-dom',
    streamId: 'stream-plan-dom',
    rowModelEnabled: true,
  });
});

test('live plan approval renders its plan card and decisions (legacy path, row model off)', async (t) => {
  await runPlanApprovalScenario(t, {
    sessionId: 'session-plan-legacy',
    streamId: 'stream-plan-legacy',
    rowModelEnabled: false,
  });
});

test('plan approval with no prior tool_use event still renders its plan card', async (t) => {
  await runPlanApprovalScenario(t, {
    sessionId: 'session-plan-race',
    streamId: 'stream-plan-race',
    rowModelEnabled: true,
    omitToolUseEvent: true,
  });
});
