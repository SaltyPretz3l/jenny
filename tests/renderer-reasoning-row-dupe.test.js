// DOM-level regression: one logical turn must render exactly ONE reasoning
// row mid-stream. Guards the dual-projection dupe where the hydrated turn
// (projected from session messages, turn id = local send id, phase id
// legacy_phase_think_*) and the live reducer turn (turn id = stream id,
// phase id phase_reasoning_*) both render a reasoning row until terminal
// reconciliation prunes the live turn.
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

test('streaming turn renders exactly one reasoning row (no live/hydrated dupe)', async (t) => {
  const sessionId = 'session-reasoning-dupe';
  const streamId = 'stream-reasoning-dupe';
  const app = await loadRendererApp({
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
  t.after(async () => {
    await app.dispose();
  });
  const { window, shell } = app;
  const doc = window.document;

  doc.getElementById('chatInput').value = 'Check the file';
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  // Ollama-style turn: thinking status + provider reasoning deltas, then a
  // tool call awaiting approval, no assistant text before the tool.
  await shell.__emitChat({
    type: 'thinking_status',
    sessionId,
    streamId,
    status: 'Thinking...',
  });
  await shell.__emitChat({
    type: 'phase_started',
    sessionId,
    streamId,
    phase: { phase_id: `phase_reasoning_${streamId}_iter1`, phase_kind: 'reasoning', iteration: 1 },
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: '',
    phase: { phase_id: `phase_reasoning_${streamId}_iter1`, phase_kind: 'reasoning', iteration: 1 },
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-1', text: 'I should inspect the file with a shell command.' }],
    },
  });
  await waitForUi(window, 30);
  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-dupe-1',
    toolName: 'run_command',
    summary: 'Bash ls -l',
    input: { command: 'ls -l' },
    status: 'pending_approval',
  });
  await shell.__emitChat({
    type: 'tool_approval_needed',
    sessionId,
    streamId,
    callId: 'call-dupe-1',
    approvalId: 'approval-dupe-1',
    toolName: 'run_command',
    input: { command: 'ls -l' },
  });
  await waitForUi(window, 80);

  const timeline = doc.getElementById('chatTimeline') || doc.body;
  const reasoningRows = [...timeline.querySelectorAll('[data-row-kind="reasoning"]')];
  const reasoningStacks = [...timeline.querySelectorAll('.reasoning-row-stack')];
  const detail = reasoningRows.map((row) => ({
    rowId: row.getAttribute('data-row-id'),
    renderMessageId: row.getAttribute('data-render-message-id'),
  }));
  assert.ok(
    reasoningRows.length <= 1,
    `expected at most one reasoning row mid-stream, found ${reasoningRows.length}: ${JSON.stringify(detail, null, 1)}`
  );
  assert.ok(
    reasoningStacks.length <= 1,
    `expected at most one .reasoning-row-stack mid-stream, found ${reasoningStacks.length}`
  );
});

test('late same-phase reasoning echo updates the captured reducer row before assistant text', async (t) => {
  const sessionId = 'session-reasoning-replay';
  const streamId = 'stream-reasoning-replay';
  const phaseId = `phase_reasoning_${streamId}_iter1`;
  const app = await loadRendererApp({
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
  t.after(async () => {
    await app.dispose();
  });
  const { window, shell } = app;

  window.document.getElementById('chatInput').value = 'Explain the result';
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 30);

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'phase_started',
    sessionId,
    streamId,
    phase: { phase_id: phaseId, phase_kind: 'reasoning', iteration: 1 },
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: '',
    phase: { phase_id: phaseId, phase_kind: 'reasoning', iteration: 1 },
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-1', text: 'Working through the answer.' }],
    },
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Here is the answer.',
    aggregate: 'Here is the answer.',
    phase: { phase_id: phaseId, phase_kind: 'text', iteration: 1 },
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: 'Here is the answer.',
    phase: { phase_id: phaseId, phase_kind: 'reasoning', iteration: 1 },
    reasoning: {
      source: 'provider',
      entriesDelta: [{
        id: 'reason-1',
        text: 'Working through the answer.',
        completed: true,
      }],
    },
  });
  await waitForUi(window, 50);

  const liveState = window.__rendererState.ui.chatTimelineLiveStateBySession.get(sessionId);
  const rows = liveState.turns_by_id[streamId].rows;
  const reasoningRows = rows.filter((row) => row.kind === 'reasoning');
  const reasoningIndex = rows.indexOf(reasoningRows[0]);
  const textIndex = rows.findIndex((row) => row.kind === 'assistant_text');

  assert.equal(reasoningRows.length, 1);
  assert.ok(reasoningIndex >= 0 && reasoningIndex < textIndex);
  assert.equal(reasoningRows[0].payload.entries[0].completed, true);
});
