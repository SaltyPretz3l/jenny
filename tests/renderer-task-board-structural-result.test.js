'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function createTaskSessionStartStream(sessionId) {
  return async function startStream(payload, { state }) {
    state.sessions = [{
      id: sessionId,
      title: 'Task board structural result',
      conversation_mode: payload.conversationMode || 'chat',
      preferred_model: payload.preferredModel || 'gpt-test',
      reasoning_effort: payload.reasoningEffort || 'default',
      interactive_round_count: 0,
      interactive_sequence_state: 'idle',
      pending_question_batch: null,
      updated_at: new Date().toISOString(),
    }];
    state.messagesBySession.set(sessionId, []);
    return { sessionId, streamId: `stream-${sessionId}` };
  };
}

async function submitPrompt(window) {
  const input = window.document.getElementById('chatInput');
  input.value = 'Update the task board';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 20);
}

async function emitTaskCall(window, shell, sessionId, streamId, callId) {
  await shell.__emitChat({
    type: 'tool_use', sessionId, streamId, callId,
    toolName: 'task_board', summary: 'task_board', input: { action: 'list' }, status: 'running',
  });
  await waitForUi(window, 40);
}

test('task_board results take a structural render and notify successful mutations', async (t) => {
  const sessionId = 'session-task-board-structural';
  const streamId = `stream-${sessionId}`;
  const app = await loadRendererApp({
    shell: { chat: { startStream: createTaskSessionStartStream(sessionId) } },
  });
  t.after(() => app.dispose());
  const { window, shell } = app;
  let mutationCalls = 0;
  window.rendererTaskBoard = { notifyMutation: () => { mutationCalls += 1; } };

  await submitPrompt(window);
  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await emitTaskCall(window, shell, sessionId, streamId, 'task-success');
  const runningRow = window.document.querySelector('[data-tool-call-id="task-success"]');
  assert.ok(runningRow);
  runningRow.setAttribute('data-structural-sentinel', 'present');

  await shell.__emitChat({
    type: 'tool_result', sessionId, streamId, callId: 'task-success',
    toolName: 'task_board', summary: 'task_board', content: '{"tasks":[]}', isError: false,
    metadata: { result_kind: 'task_board' },
  });
  await waitForUi(window, 40);
  const settledRow = window.document.querySelector('[data-tool-call-id="task-success"]');
  assert.ok(settledRow);
  assert.equal(settledRow.hasAttribute('data-structural-sentinel'), false);
  assert.equal(mutationCalls, 1);

  await emitTaskCall(window, shell, sessionId, streamId, 'task-error');
  await shell.__emitChat({
    type: 'tool_result', sessionId, streamId, callId: 'task-error',
    toolName: 'task_board', summary: 'task_board', content: 'failed', isError: true,
    metadata: { result_kind: 'task_board' },
  });
  await waitForUi(window, 40);
  assert.equal(mutationCalls, 1, 'error results do not notify mutations');
});

test('project_notes results take the structural render too, so the Open/Undo row appears at once', async (t) => {
  const sessionId = 'session-project-notes-structural';
  const streamId = `stream-${sessionId}`;
  const app = await loadRendererApp({
    shell: { chat: { startStream: createTaskSessionStartStream(sessionId) } },
  });
  t.after(() => app.dispose());
  const { window, shell } = app;
  await submitPrompt(window);
  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'tool_use', sessionId, streamId, callId: 'notes-1',
    toolName: 'project_notes', summary: 'project_notes', input: { action: 'append', text: 'x' }, status: 'running',
  });
  await waitForUi(window, 40);
  const runningRow = window.document.querySelector('[data-tool-call-id="notes-1"]');
  assert.ok(runningRow);
  runningRow.setAttribute('data-structural-sentinel', 'present');
  await shell.__emitChat({
    type: 'tool_result', sessionId, streamId, callId: 'notes-1',
    toolName: 'project_notes', summary: 'project_notes', content: 'Added 1 line to the project notes.', isError: false,
    metadata: { result_kind: 'project_notes', action: 'append', status: 'ok', project_id: 'project_general', revision: 1, journal_entry_id: 'pnj_1', summary: 'x', lines: { added: 1, removed: 0, changed: 0 }, headings: [] },
  });
  await waitForUi(window, 40);
  const settledRow = window.document.querySelector('[data-tool-call-id="notes-1"]');
  assert.ok(settledRow);
  assert.equal(settledRow.hasAttribute('data-structural-sentinel'), false, 'the row was re-rendered, not live-patched');
  assert.ok(settledRow.querySelector('.notes-chat__row [data-notes-open]'), 'the Open/Undo row is in the settled markup');
});
