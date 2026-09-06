// DOM-level regression: a pending tool approval must surface Allow/Deny
// controls in the chat timeline (not just state). Guards the full
// stream-event -> projection -> markup path that the state-only lifecycle
// tests do not cover.
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

async function runApprovalScenario(t, { sessionId, streamId, rowModelEnabled, omitToolUseEvent }) {
  const reason = 'This command can delete or overwrite files (rm). Approve to continue.';
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
    },
  });
  const doc = window.document;
  const rendererState = window.__rendererState;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  input.value = 'Write the notes file';
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
  // Realistic turn shape: reasoning + content stream BEFORE the tool call so
  // the live streaming article and surgical-patch machinery are engaged.
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-1', text: 'I should write the notes file for the user.' }],
    },
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Let me write that file. ',
    aggregate: 'Let me write that file. ',
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Starting now.',
    aggregate: 'Let me write that file. Starting now.',
  });
  if (omitToolUseEvent !== true) {
    await shell.__emitChat({
      type: 'tool_use',
      sessionId,
      streamId,
      callId: 'call-approval-dom',
      toolName: 'write_file',
      summary: 'Write notes.md',
      input: { path: 'notes.md' },
      reason,
      status: 'pending_approval',
    });
  }
  await shell.__emitChat({
    type: 'tool_approval_needed',
    sessionId,
    streamId,
    callId: 'call-approval-dom',
    approvalId: 'approval-dom-1',
    toolName: 'write_file',
    input: { path: 'notes.md' },
    policyScope: 'Workspace files',
    policyConsequence: 'May change data in this scope.',
    reason,
  });
  await waitForUi(window, 80);

  assert.equal(rendererState.pendingToolApprovals.size, 1, 'approval should be pending in state');
  assert.equal([...rendererState.pendingToolApprovals.values()][0].reason, reason);
  const toolUseMessage = rendererState.messagesBySession.get(sessionId)
    .find((message) => message.kind === 'tool_use');
  assert.equal(toolUseMessage.tool_call.reason, reason);

  const timeline = doc.getElementById('chatTimeline') || doc.body;
  const approveBtn = timeline.querySelector('.tool-approve-btn');
  const denyBtn = timeline.querySelector('.tool-deny-btn');
  assert.ok(
    approveBtn,
    `expected a visible .tool-approve-btn in the timeline DOM; timeline HTML was:\n${String(timeline.innerHTML || '').slice(0, 4000)}`
  );
  assert.ok(denyBtn, 'expected a .tool-deny-btn in the timeline DOM');
  assert.equal(
    timeline.querySelector('[data-approval-fact="scope"]')?.textContent,
    'Workspace files',
    `timeline should render policy scope; HTML ended with:\n${String(timeline.innerHTML || '').slice(-5000)}`
  );
  assert.equal(
    timeline.querySelector('.tool-approval-consequence')?.textContent,
    reason
  );
  assert.doesNotMatch(timeline.innerHTML, /May change data in this scope\./);
  if (rowModelEnabled !== false) {
    // The declared write target reaches the card even when the approval
    // beat its tool_use event (omitToolUseEvent): the approval event carries
    // the input and the gap row keeps it.
    assert.equal(
      timeline.querySelector('[data-approval-fact="write"]')?.textContent,
      'Writes notes.md',
      `the card must quote the declared write target; HTML ended with:\n${String(timeline.innerHTML || '').slice(-3000)}`
    );
    assert.ok(timeline.querySelector('.tool-approve-always-btn'), 'Always allow is its own button');
  }
  return { window, shell, timeline };
}

test('pending tool approval renders Allow/Deny mid-stream (row model on)', async (t) => {
  await runApprovalScenario(t, {
    sessionId: 'session-approval-dom',
    streamId: 'stream-approval-dom',
    rowModelEnabled: true,
  });
});

test('pending tool approval renders Allow/Deny mid-stream (legacy path, row model off)', async (t) => {
  await runApprovalScenario(t, {
    sessionId: 'session-approval-legacy',
    streamId: 'stream-approval-legacy',
    rowModelEnabled: false,
  });
});

test('approval event that beats the tool_use commit still surfaces Allow/Deny', async (t) => {
  // Race guard: tool_approval_needed arriving with no tool_use message in the
  // store must create one (pending_approval) so the render signature changes
  // and the approval block renders.
  await runApprovalScenario(t, {
    sessionId: 'session-approval-race',
    streamId: 'stream-approval-race',
    rowModelEnabled: true,
    omitToolUseEvent: true,
  });
});
